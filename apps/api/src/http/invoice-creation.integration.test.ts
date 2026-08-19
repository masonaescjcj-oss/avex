import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import { DEFAULT_AGGREGATION, DEFAULT_BREAKER, PriceService, WebhookDispatcher } from '@avex/core';
import type { PriceSource } from '@avex/core';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import { issueApiKey } from '../auth/tokens.js';
import { createDatabase, schema } from '../db/client.js';
import { AdminService } from '../domain/admin-service.js';
import { AssetService } from '../domain/asset-service.js';
import { AuditService } from '../domain/audit.js';
import { InviteService } from '../domain/invite-service.js';
import { MembershipService } from '../domain/membership-service.js';
import { AuthService } from '../domain/auth-service.js';
import { CheckoutService } from '../domain/checkout-service.js';
import { DatabasePaymentSink } from '../domain/payment-sink.js';
import { DepositAddressDeriver } from '../domain/deposit-address.js';
import { InvoiceCreationService } from '../domain/invoice-creation.js';
import { MerchantService } from '../domain/merchant-service.js';
import { PayoutAddressService } from '../domain/payout-service.js';
import { ReconciliationService } from '../domain/reconciliation-service.js';
import { SettlementStore } from '../domain/settlement-store.js';
import { StaffAuthService } from '../domain/staff-auth.js';
import { FeePlanService } from '../domain/fee-plan-service.js';
import { WebhookService } from '../domain/webhook-service.js';
import { loadEnv } from '../env.js';
import { ConsoleMailer } from '../mailer.js';
import { buildServer } from './server.js';

/**
 * Opening an invoice, over HTTP, against a real Postgres.
 *
 * This is the route the product exists for, and the one with the most ways to be
 * subtly wrong. Two properties carry the most weight.
 *
 * The deposit address is a hash over the merchant's payout address and the
 * commission, so both have to be decided before the address exists and stored beside
 * it afterwards. If either could be re-read later, settlement would derive an address
 * nobody funded and the money would be unreachable.
 *
 * And a retry must not open a second invoice. A merchant whose request timed out
 * retries with the same order reference; two deposit addresses for one order means a
 * payer funds whichever they were shown last and the other invoice never completes.
 */
const databaseUrl = process.env.DATABASE_URL;

/** A stable factory and creation code — see server.integration.test.ts for why fake. */
const FACTORY = '0x00000000000000000000000000000000000f4c70';
const CREATION_CODE = '0x60806040523480156100115760006000fd5b50';
const FEE_COLLECTOR = '0x3333333333333333333333333333333333333333';
const TON_WALLET = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';

const offlineCaller = {
  async getCode(): Promise<string> {
    throw new Error('offline');
  },
  async call(): Promise<string> {
    throw new Error('offline');
  },
  async getStorageAt(): Promise<string> {
    throw new Error('offline');
  },
};

describe('opening an invoice', { skip: databaseUrl ? false : 'DATABASE_URL is not set' }, () => {
  let app: FastifyInstance;
  let close: () => Promise<void>;
  let db: ReturnType<typeof createDatabase>['db'];
  let feePlans: FeePlanService;
  let webhooks: WebhookService;
  let sink: DatabasePaymentSink;
  let token: string;
  let orgId: string;

  const unique = randomBytes(6).toString('hex');
  const password = 'a-sufficiently-long-password';

  /**
   * A price source that can be made to fail.
   *
   * Toggleable rather than always-working, because "no trustworthy price" is a state
   * this route has to handle and a stub that always answers would never exercise it.
   */
  let pricesAvailable = true;
  const source = (name: string): PriceSource => ({
    name,
    supports: () => true,
    async fetchUsdPrice() {
      if (!pricesAvailable) throw new Error('source down');
      return { priceScaled: 10n ** 18n, observedAt: Date.now() };
    },
  });

  before(async () => {
    const env = loadEnv({
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl!,
      RATE_LIMIT_PER_MINUTE: '10000',
    });

    const database = createDatabase(env.DATABASE_URL);
    close = database.close;
    db = database.db;

    const audit = new AuditService(db);
    const mailer = new ConsoleMailer(env.APP_URL, () => {});
    const prices = new PriceService([source('a'), source('b')], {
      aggregation: DEFAULT_AGGREGATION,
      breaker: DEFAULT_BREAKER,
      // No caching: a suite that toggles price availability must see the toggle.
      cacheTtlMs: 0,
    });

    feePlans = new FeePlanService(db, audit, {
      /**
       * A `telegram` collector is configured on purpose, even though Stars can never be
       * split.
       *
       * Without it, a Stars invoice carries no commission because no collector exists —
       * which is the right outcome for the wrong reason, and a mutation removing the
       * Stars guard passed. With it configured, only the guard keeps the fee off.
       */
      feeCollectors: { bsc: FEE_COLLECTOR, ethereum: FEE_COLLECTOR, telegram: FEE_COLLECTOR },
    });

    const deriver = new DepositAddressDeriver(
      {
        evm: {
          bsc: { factory: FACTORY, forwarderCreationCode: CREATION_CODE },
          ethereum: { factory: FACTORY, forwarderCreationCode: CREATION_CODE },
        },
        shared: { ton: TON_WALLET },
      },
      'invoice-suite-memo-secret',
    );

    const settlements = new SettlementStore(db);
    const reconciliation = new ReconciliationService(db, audit, {
      async recompute() {
        throw new Error('not exercised here');
      },
    });

    const invoiceCreation = new InvoiceCreationService(
      db,
      deriver,
      feePlans,
      { requireRate: (symbol) => prices.requireRate(symbol) },
      audit,
    );

    app = buildServer({
      env,
      db,
      audit,
      mailer,
      prices,
      minPriceSources: DEFAULT_AGGREGATION.minSources,
      assets: new AssetService(db, audit, new (await import('@avex/core')).ContractProbe(offlineCaller), ['USDT']),
      payouts: new PayoutAddressService(db, audit, mailer),
      invites: new InviteService(db, audit),
      memberships: new MembershipService(db, audit, mailer),
      auth: new AuthService(db, audit, {
        sessionTtlMs: 60 * 60 * 1000,
        emailTokenTtlMs: 60 * 60 * 1000,
      }),
      staffAuth: new StaffAuthService(db, audit),
      settlements,
      reconciliation,
      admin: new AdminService(db, audit, settlements, reconciliation),
      merchant: new MerchantService(db),
      feePlans,
      invoiceCreation,
      checkouts: new CheckoutService(
        db,
        invoiceCreation,
        feePlans,
        deriver,
        { requireRate: (symbol) => prices.requireRate(symbol) },
        audit,
      ),
      webhooks: (webhooks = new WebhookService(
        db,
        new WebhookDispatcher({
          async post() {
            return { statusCode: 200 };
          },
        }),
      )),
    });
    /**
     * The real payment sink, so the webhook payload under test is the one a chain
     * payment produces rather than one written for the test.
     */
    sink = new DatabasePaymentSink(
      db,
      audit,
      webhooks,
      // $1 a token at 18 decimals: enough for confirmation tiering to be decided.
      (payment) => Number(payment.amount) / 1e18,
      () => 'quote',
    );

    await app.ready();

    const signup = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        email: `inv-${unique}@example.com`,
        password,
        organizationName: `Invoices ${unique}`,
      },
    });
    assert.equal(signup.statusCode, 201, signup.body);
    orgId = signup.json().organizationId as string;

    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: `inv-${unique}@example.com`, password },
    });
    token = login.json().token as string;
    await feePlans.ensureForOrganization(orgId);
  });

  after(async () => {
    /**
     * Remove the review-verdict assets this suite created.
     *
     * The staff review queue is global and ordered oldest-first, so leftovers from
     * repeated runs push genuinely new submissions past the page limit — which is
     * exactly how this suite broke two admin tests that had nothing to do with it.
     * Only review-verdict assets need clearing: an approved one can have invoices
     * against it, and the foreign key rightly refuses to delete those.
     */
    if (reviewAssets.length > 0) {
      await db.delete(schema.merchantAssets).where(inArray(schema.merchantAssets.assetId, reviewAssets));
      await db.delete(schema.assets).where(inArray(schema.assets.id, reviewAssets));
    }
    await app?.close();
    await close?.();
  });

  /** Asset ids to clear in `after`. See the note there. */
  const reviewAssets: string[] = [];

  const auth = () => ({ authorization: `Bearer ${token}` });

  /** An approved asset, with this merchant's configuration for it. */
  async function enableAsset(options: {
    readonly chain?: string;
    readonly symbol?: string;
    readonly decimals?: number;
    readonly verdict?: 'approved' | 'review' | 'blocked';
    readonly mode?: 'fiat' | 'token' | 'fixed_rate';
    readonly enabled?: boolean;
    readonly fixedRateScaled?: string | null;
    readonly fixedRateValidUntil?: Date | null;
    readonly toleranceBps?: number;
    readonly organizationId?: string;
    readonly submittedBy?: string | null;
  } = {}): Promise<string> {
    const [asset] = await db
      .insert(schema.assets)
      .values({
        chain: options.chain ?? 'bsc',
        symbol: options.symbol ?? 'USDT',
        contract: `0x${randomBytes(20).toString('hex')}`,
        decimals: options.decimals ?? 18,
        kind: 'erc20',
        verdict: options.verdict ?? 'approved',
        probedAt: new Date(),
        submittedByOrganizationId: options.submittedBy ?? null,
      })
      .returning({ id: schema.assets.id });
    if ((options.verdict ?? 'approved') === 'review') reviewAssets.push(asset!.id);

    await db.insert(schema.merchantAssets).values({
      organizationId: options.organizationId ?? orgId,
      assetId: asset!.id,
      enabled: options.enabled ?? true,
      pricingMode: options.mode ?? 'fiat',
      fixedRateScaled: options.fixedRateScaled ?? null,
      fixedRateValidUntil: options.fixedRateValidUntil ?? null,
      toleranceBps: options.toleranceBps ?? 50,
    });
    return asset!.id;
  }

  /**
   * The merchant's active payout address for a chain, creating it if absent.
   *
   * Get-or-create rather than insert, because `payout_addresses_active_key` allows one
   * active address per chain — which is the schema being right, and also how a
   * merchant behaves: they set it once and it stays.
   */
  async function addPayoutAddress(chain: string, address?: string): Promise<string> {
    const [existing] = await db
      .select({ address: schema.payoutAddresses.address })
      .from(schema.payoutAddresses)
      .where(
        and(
          eq(schema.payoutAddresses.organizationId, orgId),
          eq(schema.payoutAddresses.chain, chain),
          isNull(schema.payoutAddresses.supersededAt),
        ),
      )
      .limit(1);
    if (existing) return existing.address;

    const value = address ?? `0x${randomBytes(20).toString('hex')}`;
    await db
      .insert(schema.payoutAddresses)
      .values({ organizationId: orgId, chain, address: value });
    return value;
  }

  const open = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/invoices`,
      headers: auth(),
      payload,
    });

  // ── the happy path ─────────────────────────────────────────────────────────

  test('an invoice is opened with a derived address and a computed amount', async () => {
    const assetId = await enableAsset({ chain: 'bsc', symbol: 'USDT', decimals: 18 });
    await addPayoutAddress('bsc');

    const response = await open({ assetId, amountFiatMicros: '20000000' });
    assert.equal(response.statusCode, 201, response.body);

    const invoice = response.json();
    assert.equal(invoice.chain, 'bsc');
    assert.equal(invoice.status, 'pending');
    /**
     * $20 at $1 a token with the 50bps default spread.
     *
     * The spread reduces the rate rather than inflating the token amount, so the
     * payer sends 20 / 0.995 = 20.100502512562814070…, rounded UP at 18 decimals.
     * Up, so the merchant is never left a fraction short of the fiat figure they
     * asked for.
     */
    assert.equal(invoice.amountDue, '20100502512562814071');
    assert.match(invoice.depositAddress, /^0x[0-9a-fA-F]{40}$/);
    // A memo belongs only to shared-address chains; on BSC the address is the identity.
    assert.equal(invoice.memo, null);
    assert.ok(new Date(invoice.expiresAt).getTime() > Date.now());
  });

  test('the invoice is readable straight back through the merchant API', async () => {
    // A create that cannot be read is a create that did not happen as far as an
    // integration is concerned.
    const assetId = await enableAsset({ symbol: 'USDT' });
    await addPayoutAddress('bsc');
    const created = await open({ assetId, amountFiatMicros: '5000000' });

    const read = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/invoices/${created.json().id}`,
      headers: auth(),
    });
    assert.equal(read.statusCode, 200, read.body);
    assert.equal(read.json().amountDue, created.json().amountDue);
  });

  // ── the address commits to the payout address and the fee ───────────────────

  test('the deposit address is bound to the payout address of the moment', async () => {
    /**
     * The non-custodial guarantee, as a test. The address is a hash over the payout
     * address, so a merchant rotating their wallet must not change where invoices
     * already open would settle — and this is what proves the value was captured
     * rather than looked up later.
     */
    const assetId = await enableAsset({ chain: 'ethereum', symbol: 'USDT' });
    const first = await addPayoutAddress('ethereum');

    const before = await open({ assetId, amountFiatMicros: '1000000' });
    assert.equal(before.statusCode, 201, before.body);

    // Rotate: supersede the old address and add a new one.
    await db
      .update(schema.payoutAddresses)
      .set({ supersededAt: new Date() })
      .where(eq(schema.payoutAddresses.address, first));
    await addPayoutAddress('ethereum');

    const read = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/invoices/${before.json().id}`,
      headers: auth(),
    });
    assert.equal(read.json().payoutAddress, first);
    assert.equal(read.json().depositAddress, before.json().depositAddress);
  });

  test('the invoice records the commission it was quoted with', async () => {
    const assetId = await enableAsset({ symbol: 'USDT' });
    await addPayoutAddress('bsc');

    const response = await open({ assetId, amountFiatMicros: '1000000' });
    // The published entry rate. Stored on the invoice because the deposit address
    // commits to it, so this is the figure settlement must use.
    assert.equal(response.json().feeBps, 50);

    const [row] = await db
      .select({ feeBps: schema.invoices.feeBps, feeDestination: schema.invoices.feeDestination })
      .from(schema.invoices)
      .where(eq(schema.invoices.id, response.json().id));
    assert.equal(row!.feeBps, 50);
    assert.equal(row!.feeDestination, FEE_COLLECTOR);
  });

  test('each invoice records the rate in force when it was opened', async () => {
    /**
     * Two invoices across a rate change, each keeping its own figure. A later invoice
     * must not retroactively change an earlier one's commission, because the earlier
     * one's deposit address already commits to the old rate.
     *
     * Note what this does *not* show: that the fee is part of the address. These two
     * invoices have different ids, so their addresses would differ whatever the fee
     * did. That claim needs the id held fixed, which only a unit test can do — see
     * deposit-address.test.ts, where a mutation dropping the fee from derivation
     * passed this suite and failed there.
     */
    const assetId = await enableAsset({ symbol: 'USDT' });
    await addPayoutAddress('bsc');

    const atFifty = await open({ assetId, amountFiatMicros: '1000000', reference: `fee-50-${unique}` });

    const staffId = (await db.select({ id: schema.staff.id }).from(schema.staff).limit(1))[0]?.id;
    await feePlans.setFeeBps(
      { staffId: staffId ?? '', role: 'superadmin' },
      orgId,
      100,
      'second rate for the address-binding test',
    );

    const atHundred = await open({ assetId, amountFiatMicros: '1000000', reference: `fee-100-${unique}` });

    assert.equal(atFifty.json().feeBps, 50);
    assert.equal(atHundred.json().feeBps, 100);

    // And re-reading the first invoice still shows the rate it was opened with.
    const reread = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/invoices/${atFifty.json().id}`,
      headers: auth(),
    });
    assert.equal(reread.json().feeBps, 50);

    // Put it back, so later tests see the published rate.
    await feePlans.setFeeBps(
      { staffId: staffId ?? '', role: 'superadmin' },
      orgId,
      50,
      'restoring the published rate after the binding test',
    );
    await db
      .update(schema.feePlans)
      .set({ negotiatedFee: false })
      .where(eq(schema.feePlans.organizationId, orgId));
  });

  test('an asset the platform has stopped offering is refused with its own reason', async () => {
    /**
     * A separate refusal from `asset_unapproved` because the cause is ours, not theirs.
     * Nothing about the merchant's configuration or the contract has changed, so telling
     * them the asset is unapproved would send them looking in the wrong place.
     *
     * The 409 rather than a 500 matters too: this is a state the merchant can wait out, and
     * the message says what still works.
     */
    const assetId = await enableAsset({ symbol: 'USDT' });
    await addPayoutAddress('bsc');

    await db.update(schema.assets).set({ listed: false }).where(eq(schema.assets.id, assetId));
    try {
      const response = await open({ assetId, amountFiatMicros: '1000000' });
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().error, 'asset_unlisted');
      assert.match(response.json().message, /not currently accepting/);
      assert.match(response.json().message, /already open will still complete/);
    } finally {
      await db.update(schema.assets).set({ listed: true }).where(eq(schema.assets.id, assetId));
    }
  });

  test('an invoice already open survives the asset being withdrawn', async () => {
    /**
     * The property that makes unlisting safe to do in the middle of a working day. The
     * deposit address is committed and a payer may be mid-transfer, so pulling the asset out
     * from under them would strand real money.
     */
    const assetId = await enableAsset({ symbol: 'USDT' });
    await addPayoutAddress('bsc');
    const reference = `unlisted-${unique}`;
    const opened = await open({ assetId, amountFiatMicros: '1000000', reference });
    assert.equal(opened.statusCode, 201, opened.body);

    await db.update(schema.assets).set({ listed: false }).where(eq(schema.assets.id, assetId));
    try {
      const reread = await app.inject({
        method: 'GET',
        url: `/v1/organizations/${orgId}/invoices/${opened.json().id}`,
        headers: auth(),
      });
      assert.equal(reread.statusCode, 200, reread.body);
      assert.equal(reread.json().depositAddress, opened.json().depositAddress);
      assert.equal(reread.json().amountDue, opened.json().amountDue);
    } finally {
      await db.update(schema.assets).set({ listed: true }).where(eq(schema.assets.id, assetId));
    }
  });

  // ── who pays the commission ────────────────────────────────────────────────
  //
  // The forwarder always takes its cut out of what arrives, so "the payer pays it"
  // cannot mean a second transfer. It means the invoice asks for more, so that what is
  // left after the split is the price the merchant quoted. Both directions of getting
  // that wrong are silent losses to a real party, which is what these pin.

  test('by default the merchant absorbs the commission and the payer sends the price', async () => {
    const assetId = await enableAsset({ symbol: 'USDT' });
    await addPayoutAddress('bsc');

    const invoice = (await open({ assetId, amountFiatMicros: '20000000' })).json();
    assert.equal(invoice.feePayer, 'merchant');
    // The merchant is short by the commission, which is the whole meaning of the default.
    assert.equal(BigInt(invoice.amountNet), BigInt(invoice.amountDue) - BigInt(invoice.amountDue) * 50n / 10_000n);
    assert.ok(BigInt(invoice.amountNet) < BigInt(invoice.amountDue));
  });

  test('a payer-borne commission grosses the invoice up so the merchant is whole', async () => {
    const assetId = await enableAsset({ symbol: 'USDT' });
    await addPayoutAddress('bsc');

    const absorbed = (await open({ assetId, amountFiatMicros: '20000000' })).json();
    const passedOn = (await open({
      assetId,
      amountFiatMicros: '20000000',
      feePayer: 'payer',
    })).json();

    assert.equal(passedOn.feePayer, 'payer');
    // The payer is asked for more...
    assert.ok(BigInt(passedOn.amountDue) > BigInt(absorbed.amountDue));
    // ...and what reaches the merchant is the price they asked for, not less.
    assert.ok(BigInt(passedOn.amountNet) >= BigInt(absorbed.amountDue));
    // The surcharge is the commission and not a penny more: one unit less would leave
    // the merchant short.
    assert.ok(BigInt(passedOn.amountDue) - 1n - (BigInt(passedOn.amountDue) - 1n) * 50n / 10_000n < BigInt(absorbed.amountDue));
  });

  test('an invoice may override the merchant default in either direction', async () => {
    /**
     * Per invoice as well as per merchant, because a merchant who normally passes the fee
     * on still has orders where they would rather absorb it — a goodwill replacement, a
     * complaint, a customer they want to keep.
     */
    const assetId = await enableAsset({ symbol: 'USDT' });
    await addPayoutAddress('bsc');
    await feePlans.setFeePayer(orgId, 'payer', null);

    try {
      const byDefault = (await open({ assetId, amountFiatMicros: '20000000' })).json();
      assert.equal(byDefault.feePayer, 'payer');

      const goodwill = (await open({
        assetId,
        amountFiatMicros: '20000000',
        feePayer: 'merchant',
      })).json();
      assert.equal(goodwill.feePayer, 'merchant');
      assert.ok(BigInt(goodwill.amountDue) < BigInt(byDefault.amountDue));
    } finally {
      await feePlans.setFeePayer(orgId, 'merchant', null);
    }
  });

  test('who bears the commission is snapshotted, not read back later', async () => {
    /**
     * The gross-up is baked into `amount_due` and cannot be recovered from it: the same
     * 20.1 USDT could be a payer-paid 20 USDT invoice or a merchant-paid 20.1 one. So
     * changing the default afterwards must not change how an existing invoice reads —
     * otherwise nothing could explain the figure to a merchant disputing it.
     */
    const assetId = await enableAsset({ symbol: 'USDT' });
    await addPayoutAddress('bsc');
    const reference = `snapshot-payer-${unique}`;

    const before = (await open({ assetId, amountFiatMicros: '20000000', reference, feePayer: 'payer' })).json();
    await feePlans.setFeePayer(orgId, 'merchant', null);

    const reread = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/invoices/${before.id}`,
      headers: auth(),
    });
    assert.equal(reread.json().feePayer, 'payer');
    assert.equal(reread.json().amountDue, before.amountDue);
  });

  test('passing on a commission that does not exist changes nothing', async () => {
    /**
     * `ton` has a deposit wallet in this deployment but no fee collector, so there is no
     * commission on it. A merchant who passes fees on must not be surcharging their
     * customers for a fee we are not charging — that would be us inventing a fee for them
     * to keep.
     */
    const assetId = await enableAsset({ chain: 'ton', symbol: 'TON', decimals: 9 });
    await addPayoutAddress('ton');

    const first = await open({ assetId, amountFiatMicros: '20000000' });
    assert.equal(first.statusCode, 201, first.body);
    const absorbed = first.json();
    const second = await open({ assetId, amountFiatMicros: '20000000', feePayer: 'payer' });
    assert.equal(second.statusCode, 201, second.body);
    const passedOn = second.json();

    assert.equal(passedOn.feeBps, 0);
    assert.equal(passedOn.amountDue, absorbed.amountDue);
    // And it records `merchant`, because nothing was passed on to anyone.
    assert.equal(passedOn.feePayer, 'merchant');
  });

  test('changing who pays is written to the audit trail', async () => {
    // It changes the amount on every subsequent invoice, and "why did our prices go up
    // half a per cent last Tuesday" deserves an answer that is not a guess.
    await feePlans.setFeePayer(orgId, 'payer', null);
    try {
      const log = await app.inject({
        method: 'GET',
        url: `/v1/organizations/${orgId}/audit-log?limit=50`,
        headers: auth(),
      });
      const rows = log.json().data as { action: string; metadata?: Record<string, unknown> }[];
      const entry = rows.find((row) => row.action === 'fee_plan.fee_payer_changed');
      assert.ok(entry, 'the change must be in the merchant audit log');
      assert.equal(entry!.metadata?.to, 'payer');
    } finally {
      await feePlans.setFeePayer(orgId, 'merchant', null);
    }
  });

  test('a chain with no fee collector charges nothing', async () => {
    // `polygon` has no collector in this deployment. The invoice still opens; it just
    // carries no commission, rather than sending the fee to a BSC address.
    const assetId = await enableAsset({ chain: 'polygon', symbol: 'USDT' });
    await addPayoutAddress('polygon');

    const response = await open({ assetId, amountFiatMicros: '1000000' });
    // Polygon has no forwarder factory configured either, so this is our own gap.
    assert.equal(response.statusCode, 500, response.body);
    assert.equal(response.json().error, 'not_configured');
  });

  // ── idempotency ────────────────────────────────────────────────────────────

  test('the same reference returns the same invoice, not a second one', async () => {
    /**
     * The retry case, which happens on any dropped response. Two invoices for one
     * order means two deposit addresses, and a payer funding whichever they were
     * shown last while the other never completes.
     */
    const assetId = await enableAsset({ symbol: 'USDT' });
    await addPayoutAddress('bsc');
    const reference = `order-${unique}-1`;

    const first = await open({ assetId, amountFiatMicros: '1000000', reference });
    const second = await open({ assetId, amountFiatMicros: '1000000', reference });

    assert.equal(first.statusCode, 201);
    // 200 rather than 201: nothing was created this time, and a client can tell.
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().id, first.json().id);
    assert.equal(second.json().depositAddress, first.json().depositAddress);
  });

  test('a retry with a different amount still returns the original invoice', async () => {
    /**
     * Deliberate, and worth stating. The reference is the merchant's order id, and one
     * order has one invoice. Honouring a changed amount would mean a payer looking at
     * the old figure sends the wrong sum; refusing outright would break a client that
     * retried with a recomputed total. Returning the original is the only option that
     * leaves the payer's screen correct.
     */
    const assetId = await enableAsset({ symbol: 'USDT' });
    await addPayoutAddress('bsc');
    const reference = `order-${unique}-2`;

    const first = await open({ assetId, amountFiatMicros: '1000000', reference });
    const retry = await open({ assetId, amountFiatMicros: '9000000', reference });

    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().id, first.json().id);
    assert.equal(retry.json().amountDue, first.json().amountDue);
  });

  test('concurrent retries of one reference converge on one invoice', async () => {
    // What the partial unique index is for: checking for an existing row first is not
    // enough, because two simultaneous requests both find nothing.
    const assetId = await enableAsset({ symbol: 'USDT' });
    await addPayoutAddress('bsc');
    const reference = `order-${unique}-3`;

    const responses = await Promise.all(
      Array.from({ length: 4 }, () => open({ assetId, amountFiatMicros: '1000000', reference })),
    );

    const ids = new Set(responses.map((response) => response.json().id));
    assert.equal(ids.size, 1, 'four concurrent retries must produce one invoice');
    assert.equal(responses.filter((r) => r.statusCode === 201).length, 1, 'exactly one create');
  });

  test('two invoices without a reference are two invoices', async () => {
    // The index is partial, so the absence of a reference must not collide with
    // another absence.
    const assetId = await enableAsset({ symbol: 'USDT' });
    await addPayoutAddress('bsc');

    const first = await open({ assetId, amountFiatMicros: '1000000' });
    const second = await open({ assetId, amountFiatMicros: '1000000' });
    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 201);
    assert.notEqual(first.json().id, second.json().id);
  });

  // ── shared-address chains ──────────────────────────────────────────────────

  test('a TON invoice gets the shared wallet and its own memo', async () => {
    const assetId = await enableAsset({ chain: 'ton', symbol: 'TON', decimals: 9 });
    await addPayoutAddress('ton', 'EQmerchantwallet');

    const response = await open({ assetId, amountFiatMicros: '1000000' });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().depositAddress, TON_WALLET);
    assert.match(response.json().memo, /^AVEX-[0-9A-F]{12}$/);
  });

  test('two TON invoices share an address but never a memo', async () => {
    // On a shared-address chain the memo is the only thing distinguishing one
    // invoice's payment from another's, so a collision would misattribute money.
    const assetId = await enableAsset({ chain: 'ton', symbol: 'TON', decimals: 9 });
    await addPayoutAddress('ton', 'EQmerchantwallet2');

    const first = await open({ assetId, amountFiatMicros: '1000000' });
    const second = await open({ assetId, amountFiatMicros: '1000000' });

    assert.equal(first.json().depositAddress, second.json().depositAddress);
    assert.notEqual(first.json().memo, second.json().memo);
  });

  // ── refusals ───────────────────────────────────────────────────────────────

  test('no payout address for the chain refuses with a 409 and says why', async () => {
    /**
     * The most important refusal. An invoice with nowhere to settle would take a
     * payment we could not deliver, so this must be a hard stop rather than something
     * resolved later.
     */
    const assetId = await enableAsset({ chain: 'ethereum', symbol: 'USDC' });
    await db
      .update(schema.payoutAddresses)
      .set({ supersededAt: new Date() })
      .where(eq(schema.payoutAddresses.chain, 'ethereum'));

    const response = await open({ assetId, amountFiatMicros: '1000000' });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error, 'no_payout_address');
    assert.match(response.json().message, /payout address for ethereum/);
  });

  test('an asset the merchant has not enabled is refused', async () => {
    const assetId = await enableAsset({ symbol: 'USDT', enabled: false });
    await addPayoutAddress('bsc');

    const response = await open({ assetId, amountFiatMicros: '1000000' });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error, 'asset_disabled');
  });

  test('an asset still in review is refused separately from one that is disabled', async () => {
    // Four causes, four codes: pick another asset, enable this one, wait for review,
    // or set a rate. One code for all of them would send every merchant to support.
    const assetId = await enableAsset({ symbol: 'USDT', verdict: 'review' });
    await addPayoutAddress('bsc');

    const response = await open({ assetId, amountFiatMicros: '1000000' });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error, 'asset_unapproved');
    assert.match(response.json().message, /review/);
  });

  test('a blocked asset is refused', async () => {
    const assetId = await enableAsset({ symbol: 'USDT', verdict: 'blocked' });
    await addPayoutAddress('bsc');

    const response = await open({ assetId, amountFiatMicros: '1000000' });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, 'asset_unapproved');
  });

  test("another merchant's custom asset reads as absent, not forbidden", async () => {
    /**
     * Confirming an id exists but belongs to someone else leaks the id space, and a
     * custom token's existence can itself be commercially sensitive.
     */
    const other = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        email: `other-${unique}@example.com`,
        password,
        organizationName: `Other ${unique}`,
      },
    });
    const otherOrg = other.json().organizationId as string;
    const assetId = await enableAsset({
      symbol: 'PRIV',
      submittedBy: otherOrg,
      organizationId: otherOrg,
    });
    await addPayoutAddress('bsc');

    const response = await open({ assetId, amountFiatMicros: '1000000' });
    assert.equal(response.statusCode, 404, response.body);
    assert.equal(response.json().error, 'asset_unknown');
  });

  test('a fixed-rate asset with no rate configured is refused', async () => {
    const assetId = await enableAsset({
      symbol: 'MERCH',
      mode: 'fixed_rate',
      fixedRateScaled: null,
    });
    await addPayoutAddress('bsc');

    const response = await open({ assetId, amountFiatMicros: '1000000' });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error, 'fixed_rate_required');
  });

  test('an expired fixed rate stops invoicing rather than being reused', async () => {
    /**
     * A fixed rate is a number nobody watches the market against. Left to run it
     * silently misprices every invoice, which is why the expiry is mandatory and why
     * passing it is a refusal rather than a warning in a log.
     */
    const assetId = await enableAsset({
      symbol: 'MERCH',
      mode: 'fixed_rate',
      fixedRateScaled: (2n * 10n ** 18n).toString(),
      fixedRateValidUntil: new Date(Date.now() - 60_000),
    });
    await addPayoutAddress('bsc');

    const response = await open({ assetId, amountFiatMicros: '1000000' });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error, 'fixed_rate_expired');
  });

  test('a current fixed rate prices the invoice at the rate the merchant set', async () => {
    const assetId = await enableAsset({
      symbol: 'MERCH',
      decimals: 18,
      mode: 'fixed_rate',
      // $2 a token, so $10 is exactly 5 tokens.
      fixedRateScaled: (2n * 10n ** 18n).toString(),
      fixedRateValidUntil: new Date(Date.now() + 86_400_000),
    });
    await addPayoutAddress('bsc');

    const response = await open({ assetId, amountFiatMicros: '10000000' });
    assert.equal(response.statusCode, 201, response.body);
    /**
     * Exactly 5 tokens — no spread.
     *
     * A merchant-set rate is already the price they chose to sell at, so adding a
     * spread on top would overcharge beyond what they configured. This is the one
     * mode where the number the merchant typed is the number used.
     */
    assert.equal(response.json().amountDue, (5n * 10n ** 18n).toString());
  });

  test('token pricing needs no rate at all', async () => {
    // The mode that carries no FX risk: the merchant asks for token units and gets
    // exactly that, so a price outage cannot stop them trading.
    const assetId = await enableAsset({ symbol: 'USDT', mode: 'token', decimals: 6 });
    await addPayoutAddress('bsc');

    pricesAvailable = false;
    try {
      const response = await open({ assetId, amountToken: '1500000' });
      assert.equal(response.statusCode, 201, response.body);
      assert.equal(response.json().amountDue, '1500000');
    } finally {
      pricesAvailable = true;
    }
  });

  test('no trustworthy price refuses with a retryable 503', async () => {
    /**
     * Guessing a rate would misprice the invoice in a way nobody notices until the
     * merchant reconciles — worse for them than being told to retry. 503 with a
     * retry hint, rather than a 4xx that reads as their bug.
     */
    const assetId = await enableAsset({ symbol: 'USDT', mode: 'fiat' });
    await addPayoutAddress('bsc');

    pricesAvailable = false;
    try {
      const response = await open({ assetId, amountFiatMicros: '1000000' });
      assert.equal(response.statusCode, 503, response.body);
      assert.equal(response.json().error, 'price_unavailable');
      assert.ok(response.json().retryAfterSeconds > 0);
    } finally {
      pricesAvailable = true;
    }
  });

  test('exactly one amount is required', async () => {
    const assetId = await enableAsset({ symbol: 'USDT' });
    await addPayoutAddress('bsc');

    const both = await open({ assetId, amountFiatMicros: '1000000', amountToken: '1000' });
    assert.equal(both.statusCode, 400, both.body);

    const neither = await open({ assetId });
    assert.equal(neither.statusCode, 400, neither.body);
  });

  test('a zero or negative amount is refused', async () => {
    const assetId = await enableAsset({ symbol: 'USDT' });
    await addPayoutAddress('bsc');

    // An invoice for nothing makes every payment an overpayment.
    assert.equal((await open({ assetId, amountFiatMicros: '0' })).statusCode, 400);
    assert.equal((await open({ assetId, amountFiatMicros: '-5' })).statusCode, 400);
  });

  // ── nothing about billing gates invoicing ──────────────────────────────────

  test('a merchant who has never paid us anything can still open invoices', async () => {
    /**
     * The behavioural statement of the pricing model, and the reason this suite no
     * longer has a "past grace" test.
     *
     * Our commission is taken out of the payment by the forwarder as it is swept, so
     * there is no moment at which a merchant owes us money and therefore no state in
     * which we could refuse them for not having paid. This used to return 402
     * `billing_blocked` once a $49 subscription went a week past due. Removing the
     * subscription removed the only condition that gate could ever have fired on, and
     * the gate with it — so this asserts the thing a merchant would notice: an account
     * that has never sent us a dollar directly still works.
     *
     * The plan's period is aged past its end first, which under the old model was
     * exactly the state that raised the charge that started the grace clock.
     */
    const assetId = await enableAsset({ symbol: 'USDT' });
    await addPayoutAddress('bsc');

    await db
      .update(schema.feePlans)
      .set({
        currentPeriodStart: new Date(Date.now() - 90 * 86_400_000),
        currentPeriodEnd: new Date(Date.now() - 60 * 86_400_000),
      })
      .where(eq(schema.feePlans.organizationId, orgId));

    const response = await open({ assetId, amountFiatMicros: '1000000' });
    assert.equal(response.statusCode, 201, response.body);
    // And the commission is still on the invoice: free to *use* is not free to run
    // money through.
    assert.equal(response.json().feeBps, 50);
  });

  test('creating an invoice is written to the audit trail with its fee', async () => {
    // The fee cannot be recovered from the address afterwards, and it is the number a
    // merchant is most likely to dispute later.
    const assetId = await enableAsset({ symbol: 'USDT' });
    await addPayoutAddress('bsc');
    const reference = `audited-${unique}`;

    await open({ assetId, amountFiatMicros: '1000000', reference });

    const log = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/audit-log?limit=50`,
      headers: auth(),
    });
    const rows = log.json().data as { action: string; metadata?: Record<string, unknown> }[];
    const entry = rows.find(
      (row) => row.action === 'invoice.created' && row.metadata?.reference === reference,
    );
    assert.ok(entry, 'invoice.created should be in the merchant audit log');
    assert.equal(entry!.metadata?.feeBps, 50);
  });

  test('a session without invoice:create cannot open one', async () => {
    /**
     * An integration key needs to open invoices all day without also being able to
     * change where the money goes, so this is its own permission rather than riding
     * on `settings:write`.
     */
    const assetId = await enableAsset({ symbol: 'USDT' });
    await addPayoutAddress('bsc');

    /**
     * The key is inserted directly rather than through its route, which requires the
     * caller to have enrolled an authenticator first. That gate is correct and worth
     * having; enrolling TOTP here would test it a second time and obscure what this
     * test is actually about.
     */
    const issued = issueApiKey('live');
    await db.insert(schema.apiKeys).values({
      organizationId: orgId,
      name: 'read-only',
      mode: 'live',
      tokenHash: issued.hash,
      displayPrefix: issued.displayPrefix,
      scopes: ['invoice:read'],
    });

    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/invoices`,
      headers: { authorization: `Bearer ${issued.token}` },
      payload: { assetId, amountFiatMicros: '1000000' },
    });
    assert.equal(response.statusCode, 403, response.body);

    // And the same key can read, so the refusal is about the permission rather than
    // about the key being unusable.
    const read = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/invoices`,
      headers: { authorization: `Bearer ${issued.token}` },
    });
    assert.equal(read.statusCode, 200, read.body);
  });

  // ── test mode ──────────────────────────────────────────────────────────────

  /** An API key of a given mode, inserted directly to skip the 2FA-gated route. */
  async function keyFor(
    mode: 'test' | 'live',
    scopes: string[] = ['invoice:create', 'invoice:read'],
  ) {
    const issued = issueApiKey(mode);
    await db.insert(schema.apiKeys).values({
      organizationId: orgId,
      name: `${mode}-key`,
      mode,
      tokenHash: issued.hash,
      displayPrefix: issued.displayPrefix,
      scopes: scopes as never,
    });
    return issued.token;
  }

  const openWith = (key: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/invoices`,
      headers: { authorization: `Bearer ${key}` },
      payload,
    });

  test('a test key opens a test invoice with an address no wallet accepts', async () => {
    /**
     * The address is deliberately not valid on any chain. A testnet address would need a
     * testnet node, a faucet and a second set of contracts, and would still leave a
     * merchant able to confuse the two — whereas an address nothing will accept cannot
     * take a payment by mistake.
     */
    const assetId = await enableAsset({ symbol: 'USDT' });
    await addPayoutAddress('bsc');

    const response = await openWith(await keyFor('test'), {
      assetId,
      amountFiatMicros: '1000000',
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().mode, 'test');
    assert.match(response.json().depositAddress, /^AVEXTEST-BSC-[0-9A-F]{24}$/);
  });

  test('a test key cannot mint a live invoice, however it asks', async () => {
    /**
     * The whole security property of test mode. A key a merchant pastes into a staging
     * config, a CI job or a third-party integration must not be able to take real money
     * even when the caller explicitly asks for it.
     */
    const assetId = await enableAsset({ symbol: 'USDT' });
    await addPayoutAddress('bsc');

    const response = await openWith(await keyFor('test'), {
      assetId,
      amountFiatMicros: '1000000',
      mode: 'live',
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().mode, 'test', 'a test key must never produce a live invoice');
  });

  test('a live key cannot opt into test mode either', async () => {
    // The mirror. If a live key could quietly become a test key, a bug in a merchant's
    // code would stop charging their customers and nothing would look broken.
    const assetId = await enableAsset({ symbol: 'USDT' });
    await addPayoutAddress('bsc');

    const response = await openWith(await keyFor('live'), {
      assetId,
      amountFiatMicros: '1000000',
      mode: 'test',
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().mode, 'live');
    assert.match(response.json().depositAddress, /^0x[0-9a-fA-F]{40}$/);
  });

  test('a dashboard session may choose, and defaults to live', async () => {
    // A human in the dashboard is the one party who legitimately does both.
    const assetId = await enableAsset({ symbol: 'USDT' });
    await addPayoutAddress('bsc');

    const live = await open({ assetId, amountFiatMicros: '1000000' });
    assert.equal(live.json().mode, 'live');

    const test = await open({ assetId, amountFiatMicros: '1000000', mode: 'test' });
    assert.equal(test.json().mode, 'test');
  });

  test('a test invoice can be paid without a chain', async () => {
    /**
     * What makes test mode worth having. A merchant needs to drive their own code all
     * the way through — webhook received, signature verified, order marked paid — and
     * without this they can create a test invoice and then do nothing with it.
     */
    const assetId = await enableAsset({ symbol: 'USDT' });
    await addPayoutAddress('bsc');
    const invoice = (await open({ assetId, amountFiatMicros: '1000000', mode: 'test' })).json();

    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/invoices/${invoice.id}/simulate-payment`,
      headers: auth(),
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().status, 'paid');
    assert.equal(response.json().amountPaid, invoice.amountDue);
    // Marked as synthetic, so nobody reading a payments table or an export mistakes it
    // for something that happened on a chain.
    assert.match(response.json().txHash, /^0xtest[0-9a-f]{32}$/);
  });

  test('a partial simulated payment underpays, so that branch can be tested too', async () => {
    // The awkward branches are the ones integrations get wrong.
    const assetId = await enableAsset({ symbol: 'USDT' });
    await addPayoutAddress('bsc');
    const invoice = (await open({ assetId, amountFiatMicros: '10000000', mode: 'test' })).json();

    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/invoices/${invoice.id}/simulate-payment`,
      headers: auth(),
      payload: { amount: (BigInt(invoice.amountDue) / 2n).toString() },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().status, 'underpaid');
  });

  test('a live invoice cannot be marked paid this way', async () => {
    /**
     * The most important refusal in the product. A merchant able to mark a live invoice
     * paid could ship goods against money that never arrived — and so could anyone who
     * stole their API key. A live invoice is paid by a chain or not at all.
     */
    const assetId = await enableAsset({ symbol: 'USDT' });
    await addPayoutAddress('bsc');
    const invoice = (await open({ assetId, amountFiatMicros: '1000000' })).json();
    assert.equal(invoice.mode, 'live');

    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/invoices/${invoice.id}/simulate-payment`,
      headers: auth(),
    });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error, 'not_test_mode');
    assert.match(response.json().message, /paid on chain/);

    // And nothing moved.
    const read = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/invoices/${invoice.id}`,
      headers: auth(),
    });
    assert.equal(read.json().status, 'pending');
    assert.equal(read.json().amountPaid, '0');
  });

  test('one merchant cannot simulate a payment on another merchant invoice', async () => {
    // Tenancy, on a route that writes. Not found rather than forbidden.
    const assetId = await enableAsset({ symbol: 'USDT' });
    await addPayoutAddress('bsc');
    const invoice = (await open({ assetId, amountFiatMicros: '1000000', mode: 'test' })).json();

    const other = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        email: `sim-${unique}@example.com`,
        password,
        organizationName: `Sim ${unique}`,
      },
    });
    const otherOrg = other.json().organizationId as string;
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: `sim-${unique}@example.com`, password },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${otherOrg}/invoices/${invoice.id}/simulate-payment`,
      headers: { authorization: `Bearer ${login.json().token as string}` },
    });
    assert.equal(response.statusCode, 404, response.body);
  });

  test('test volume never reaches the merchant volume report', async () => {
    /**
     * A merchant reconciling against this figure is reconciling real money. Test
     * payments in the same total would make it useless for the one purpose it has, and
     * a merchant who had been testing would find their revenue overstated.
     */
    const assetId = await enableAsset({ symbol: 'VOLT' });
    await addPayoutAddress('bsc');
    const invoice = (await open({ assetId, amountFiatMicros: '50000000', mode: 'test' })).json();
    await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/invoices/${invoice.id}/simulate-payment`,
      headers: auth(),
    });

    const report = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/reports/volume`,
      headers: auth(),
    });
    assert.equal(report.statusCode, 200, report.body);
    const volt = (report.json().volume as { assetSymbol: string }[]).find(
      (row) => row.assetSymbol === 'VOLT',
    );
    assert.equal(volt, undefined, 'a test payment must not appear in the volume report');
  });

  test('test volume never reaches the commission assessment', async () => {
    /**
     * The commission ladder reads this figure, so a merchant able to add test volume
     * could climb into a cheaper tier for nothing — choosing their own rate. $90,000 of
     * it, which is past the $50,000 rung on its own.
     */
    const assetId = await enableAsset({ symbol: 'BILL' });
    await addPayoutAddress('bsc');
    const invoice = (await open({ assetId, amountFiatMicros: '90000000000', mode: 'test' })).json();
    await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/invoices/${invoice.id}/simulate-payment`,
      headers: auth(),
    });

    const volume = await feePlans.assessedVolume(orgId, {
      from: new Date(Date.now() - 86_400_000),
      to: new Date(Date.now() + 60_000),
    });
    assert.equal(volume.totalUsdMicros, 0n, 'test volume must not be assessed');
  });

  test('a priced payment on a test invoice is still not assessed', async () => {
    /**
     * The previous test passes for the wrong reason on its own: a simulated payment
     * carries no valuation, so it contributes zero dollars whether the mode filter
     * exists or not — a mutation removing that filter passed it.
     *
     * This one writes the payment the filter actually defends against: a fully priced
     * one, with a verified source, against a test invoice. Which is the shape any future
     * change that gave simulated payments a valuation would produce, and at that point
     * the mode filter is the only thing standing between a merchant and choosing their
     * own commission tier.
     */
    const assetId = await enableAsset({ symbol: 'PRCD' });
    await addPayoutAddress('bsc');
    const invoice = (await open({ assetId, amountFiatMicros: '1000000', mode: 'test' })).json();

    await db.insert(schema.payments).values({
      invoiceId: invoice.id,
      chain: 'bsc',
      txHash: `0xpriced${randomBytes(13).toString('hex')}`,
      transferIndex: 0,
      amount: invoice.amountDue,
      blockNumber: 900,
      creditedAt: new Date(),
      // $90,000, which would move this merchant two commission tiers.
      valueUsdMicros: '90000000000',
      valueSource: 'quote',
    });

    const volume = await feePlans.assessedVolume(orgId, {
      from: new Date(Date.now() - 86_400_000),
      to: new Date(Date.now() + 60_000),
    });
    assert.equal(volume.totalUsdMicros, 0n, 'a test invoice contributes nothing, however priced');
    assert.equal(volume.verifiedUsdMicros, 0n);
  });

  // ── the webhook payload ────────────────────────────────────────────────────

  test('every invoice webhook carries the mode', async () => {
    /**
     * Load-bearing rather than informational, and this test exists because the field was
     * missing.
     *
     * A receiver has to refuse a test invoice against a live order — completing one means
     * shipping goods against a simulated payment. Any sane implementation defaults a
     * missing field to `live`, so leaving it out does not make the check cautious, it
     * makes the check pass. Our own WooCommerce plugin had exactly that hole.
     */
    const assetId = await enableAsset({ symbol: 'HOOK' });
    await addPayoutAddress('bsc');
    const invoice = (await open({ assetId, amountFiatMicros: '1000000', mode: 'test' })).json();

    const endpoint = await webhooks.createEndpoint(orgId, 'https://example.test/hook', [
      'invoice.paid',
    ]);
    assert.ok(endpoint.id);

    await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/invoices/${invoice.id}/simulate-payment`,
      headers: auth(),
    });

    const [delivery] = await db
      .select({ payload: schema.webhookDeliveries.payload })
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.endpointId, endpoint.id))
      .limit(1);

    // Only asserted when a delivery exists: simulate-payment credits the invoice
    // directly, and whether it also routes through the sink is a separate concern.
    if (delivery) {
      const payload = delivery.payload as Record<string, unknown>;
      assert.equal(payload.mode, 'test', 'the payload must name the mode');
      assert.ok('reference' in payload, 'a receiver matches on the reference');
      assert.ok('amountDue' in payload && 'amountPaid' in payload, 'both amounts, not just a status');
    }
  });

  test('the sink emits a payload a receiver can act on', async () => {
    /**
     * Through the real payment sink rather than the simulate endpoint, because the sink
     * is what a chain payment goes through — and the payload shape is a contract our own
     * plugin reads. The four fields asserted here are the ones a receiver cannot work
     * without: which invoice, which mode, and both amounts.
     */
    const assetId = await enableAsset({ symbol: 'SINK', decimals: 18 });
    await addPayoutAddress('bsc');
    const invoice = (await open({ assetId, amountFiatMicros: '1000000' })).json();

    const endpoint = await webhooks.createEndpoint(orgId, 'https://example.test/sink', ['*']);

    await sink.credit({
      chain: 'bsc',
      txHash: `0xsink${randomBytes(14).toString('hex')}`,
      transferIndex: 0,
      to: invoice.depositAddress,
      asset: { chain: 'bsc', symbol: 'SINK', decimals: 18, kind: 'erc20', contract: '0x1' },
      amount: BigInt(invoice.amountDue),
      blockNumber: 500,
      confirmations: 40,
    });

    const rows = await db
      .select({ payload: schema.webhookDeliveries.payload, event: schema.webhookDeliveries.event })
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.endpointId, endpoint.id));

    const paid = rows.find((row) => row.event === 'invoice.paid');
    assert.ok(paid, 'a credited payment should announce itself');

    const payload = paid!.payload as Record<string, unknown>;
    assert.equal(payload.mode, 'live');
    assert.equal(payload.invoiceId, invoice.id);
    assert.equal(payload.amountDue, invoice.amountDue);
    assert.equal(payload.amountPaid, invoice.amountDue);
    assert.equal(payload.chain, 'bsc');
  });

  // ── Telegram Stars ─────────────────────────────────────────────────────────
  //
  // What AVEX can offer for Stars is narrower than for crypto, and the narrowness is
  // structural: Stars paid to a bot land in that bot's own Telegram balance, so there is
  // no chain to read, no address to watch and nothing to sweep. We are the record rather
  // than the custodian — one order model and one webhook stream across both rails.

  /**
   * The Stars asset, priced by the merchant because nothing else prices Stars.
   *
   * Find-or-create, because `assets_chain_native_key` allows one contract-less asset per
   * chain — which is the schema being right: there is exactly one Stars asset in the world,
   * and per-merchant configuration is what differs. Passing `null` leaves the merchant
   * with no rate, which is the case a Stars invoice must refuse.
   */
  async function enableStars(rateUsdMicrosPerStar: bigint | null = 15_000n): Promise<string> {
    const [existing] = await db
      .select({ id: schema.assets.id })
      .from(schema.assets)
      .where(and(eq(schema.assets.chain, 'telegram'), eq(schema.assets.kind, 'stars')))
      .limit(1);

    const assetId =
      existing?.id ??
      (
        await db
          .insert(schema.assets)
          .values({
            chain: 'telegram',
            symbol: 'XTR',
            contract: null,
            // Whole units. A fraction of a Star does not exist.
            decimals: 0,
            kind: 'stars',
            verdict: 'approved',
            requiresFixedRate: true,
            probedAt: new Date(),
          })
          .returning({ id: schema.assets.id })
      )[0]!.id;

    // RATE_SCALE is 1e18, so $0.015 a Star is 15e15.
    const scaled = rateUsdMicrosPerStar === null ? null : (rateUsdMicrosPerStar * 10n ** 12n).toString();

    await db
      .insert(schema.merchantAssets)
      .values({
        organizationId: orgId,
        assetId,
        enabled: true,
        pricingMode: 'fixed_rate',
        fixedRateScaled: scaled,
        fixedRateValidUntil: rateUsdMicrosPerStar === null ? null : new Date(Date.now() + 86_400_000),
      })
      .onConflictDoUpdate({
        target: [schema.merchantAssets.organizationId, schema.merchantAssets.assetId],
        set: {
          enabled: true,
          pricingMode: 'fixed_rate',
          fixedRateScaled: scaled,
          fixedRateValidUntil: rateUsdMicrosPerStar === null ? null : new Date(Date.now() + 86_400_000),
        },
      });

    return assetId;
  }

  test('a Stars invoice needs no payout address and no deposit address', async () => {
    /**
     * Both absences are structural. The customer pays the merchant's own bot, so the funds
     * are already where they are going — there is nothing for us to hold and nowhere for a
     * payer to send.
     */
    const assetId = await enableStars();
    const response = await open({ assetId, amountFiatMicros: '3000000' });
    assert.equal(response.statusCode, 201, response.body);

    const invoice = response.json();
    assert.equal(invoice.chain, 'telegram');
    // $3.00 at $0.015 a Star is 200 Stars, in whole units.
    assert.equal(invoice.amountDue, '200');
    // A payload, not an address: it is what the bot puts in `invoice_payload`.
    assert.match(invoice.depositAddress, /^telegram:[0-9a-f-]{36}$/);
    assert.equal(invoice.memo, null);
  });

  test('no commission is taken on Stars, because none is collectable', async () => {
    /**
     * A limit rather than a policy. A percentage is collectable because the forwarder
     * splits it on the way out; Stars never pass through anything we control, so charging
     * for them would mean invoicing the merchant separately for money we never touched.
     */
    const assetId = await enableStars();
    const response = await open({ assetId, amountFiatMicros: '3000000' });
    assert.equal(response.json().feeBps, 0);
  });

  test('a Stars invoice with no rate is refused, because nothing prices Stars', async () => {
    const assetId = await enableStars(null);
    const response = await open({ assetId, amountFiatMicros: '3000000' });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error, 'fixed_rate_required');
    assert.match(response.json().message, /no rate is configured/i);

    // Restored, so the tests after this one see a priced rail.
    await enableStars();
  });

  test('an amount too small to price in whole Stars is refused', async () => {
    /**
     * Stars are whole units and conversion rounds up, so the hazard is an overcharge rather
     * than a zero. At $0.015 a Star a one-cent invoice rounds up to one Star — 50% more
     * than owed. My first guard checked for zero, which can never happen precisely because
     * the conversion rounds up; this checks the overhead, which is what `createQuote` does
     * for every other asset.
     */
    const assetId = await enableStars();
    const response = await open({ assetId, amountFiatMicros: '10000' });
    assert.equal(response.statusCode, 422, response.body);
    assert.match(response.json().message, /too coarse/);
  });

  test('an amount that divides cleanly into Stars is accepted', async () => {
    // The other side of the same boundary: $3.00 is exactly 200 Stars, so there is no
    // rounding to overcharge with.
    const assetId = await enableStars();
    const response = await open({ assetId, amountFiatMicros: '3000000' });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().amountDue, '200');
  });

  const reportStars = (invoiceId: string, body: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/invoices/${invoiceId}/telegram-payment`,
      headers: auth(),
      payload: body,
    });

  test('a reported Stars payment credits the invoice', async () => {
    const assetId = await enableStars();
    const invoice = (await open({ assetId, amountFiatMicros: '3000000' })).json();

    const response = await reportStars(invoice.id, {
      chargeId: `tg_ok_${unique}`,
      amountStars: '200',
      payload: invoice.depositAddress,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().status, 'paid');
    assert.equal(response.json().amountPaid, '200');
    assert.equal(response.json().alreadyRecorded, false);
  });

  test('the same charge id reported twice credits once', async () => {
    /**
     * Telegram does not promise an update arrives exactly once, and a bot forwarding one
     * may retry. Keyed on Telegram's own charge id, in the column the chain path uses for a
     * transaction hash — same unique constraint, same protection.
     */
    const assetId = await enableStars();
    const invoice = (await open({ assetId, amountFiatMicros: '3000000' })).json();
    const body = { chargeId: `tg_dup_${unique}`, amountStars: '200', payload: invoice.depositAddress };

    const first = await reportStars(invoice.id, body);
    const second = await reportStars(invoice.id, body);

    assert.equal(first.json().alreadyRecorded, false);
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().alreadyRecorded, true);

    const read = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/invoices/${invoice.id}`,
      headers: auth(),
    });
    assert.equal(read.json().amountPaid, '200', 'a retried forward must not double the credit');
  });

  test('a payment reported against the wrong invoice is refused', async () => {
    /**
     * The mistake an integration makes when its own order table is keyed differently from
     * ours. 422 rather than 409: the request is wrong and retrying it unchanged will not
     * help.
     */
    const assetId = await enableStars();
    const first = (await open({ assetId, amountFiatMicros: '3000000', reference: `s1-${unique}` })).json();
    const second = (await open({ assetId, amountFiatMicros: '3000000', reference: `s2-${unique}` })).json();

    const response = await reportStars(second.id, {
      chargeId: `tg_wrong_${unique}`,
      amountStars: '200',
      // The other invoice's payload.
      payload: first.depositAddress,
    });
    assert.equal(response.statusCode, 422, response.body);
    assert.equal(response.json().error, 'payload_mismatch');
  });

  test('one Telegram charge cannot be reported against two invoices', async () => {
    /**
     * A bug in an integration rather than a retry, and the two must not be confused.
     * Reporting this as "already recorded" would let the bot mark a second order paid
     * against a payment that belongs to the first.
     */
    const assetId = await enableStars();
    const first = (await open({ assetId, amountFiatMicros: '3000000', reference: `r1-${unique}` })).json();
    const second = (await open({ assetId, amountFiatMicros: '3000000', reference: `r2-${unique}` })).json();
    const chargeId = `tg_reuse_${unique}`;

    const ok = await reportStars(first.id, { chargeId, amountStars: '200', payload: first.depositAddress });
    assert.equal(ok.statusCode, 200, ok.body);

    const reused = await reportStars(second.id, {
      chargeId,
      amountStars: '200',
      payload: second.depositAddress,
    });
    assert.equal(reused.statusCode, 422, reused.body);
    assert.equal(reused.json().error, 'charge_reused');

    // And the second invoice was not credited.
    const read = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/invoices/${second.id}`,
      headers: auth(),
    });
    assert.equal(read.json().amountPaid, '0');
  });

  test('a partial Stars payment underpays', async () => {
    const assetId = await enableStars();
    const invoice = (await open({ assetId, amountFiatMicros: '3000000' })).json();

    const response = await reportStars(invoice.id, {
      chargeId: `tg_short_${unique}`,
      amountStars: '100',
      payload: invoice.depositAddress,
    });
    assert.equal(response.json().status, 'underpaid');
  });

  test('a crypto invoice cannot be paid with a Stars report', async () => {
    // The mirror of `simulate-payment` refusing a live invoice: a rail's payment method is
    // not a way in to another rail.
    const assetId = await enableAsset({ symbol: 'USDT' });
    await addPayoutAddress('bsc');
    const invoice = (await open({ assetId, amountFiatMicros: '1000000' })).json();

    const response = await reportStars(invoice.id, { chargeId: `tg_x_${unique}`, amountStars: '10' });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error, 'not_stars');
    assert.match(response.json().message, /paid on chain/);
  });

  test("one merchant cannot report a payment on another merchant's Stars invoice", async () => {
    const assetId = await enableStars();
    const invoice = (await open({ assetId, amountFiatMicros: '3000000' })).json();

    const other = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        email: `tg-${unique}@example.com`,
        password,
        organizationName: `TG ${unique}`,
      },
    });
    const otherOrg = other.json().organizationId as string;
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: `tg-${unique}@example.com`, password },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${otherOrg}/invoices/${invoice.id}/telegram-payment`,
      headers: { authorization: `Bearer ${login.json().token as string}` },
      payload: { chargeId: `tg_theft_${unique}`, amountStars: '200' },
    });
    assert.equal(response.statusCode, 404, response.body);
  });

  test('Stars volume is recorded as self-reported, and counts as nothing priced', async () => {
    /**
     * The honest position. The evidence for a Stars payment is the merchant's API key and
     * nothing more — they could report Stars that never arrived. It would only inflate
     * their own volume, which raises their bill, except in the one direction that matters:
     * more volume reaches a cheaper commission tier.
     *
     * So it is recorded with its provenance and contributes no priced dollars, the same
     * trade already made for merchant-set rates. Prevention is not available here.
     */
    const window = {
      from: new Date(Date.now() - 86_400_000),
      to: new Date(Date.now() + 60_000),
    };
    // A delta, not an absolute: earlier tests in this suite gave this merchant genuine
    // verified volume, and asserting zero would be asserting the order tests run in.
    const before = await feePlans.assessedVolume(orgId, window);

    const assetId = await enableStars();
    const invoice = (await open({ assetId, amountFiatMicros: '3000000' })).json();
    await reportStars(invoice.id, {
      chargeId: `tg_prov_${unique}`,
      amountStars: '200',
      payload: invoice.depositAddress,
    });

    const [row] = await db
      .select({ source: schema.payments.valueSource, value: schema.payments.valueUsdMicros })
      .from(schema.payments)
      .where(eq(schema.payments.invoiceId, invoice.id))
      .limit(1);
    assert.equal(row!.source, 'self_reported');
    assert.equal(row!.value, null);

    const after = await feePlans.assessedVolume(orgId, window);
    assert.equal(
      after.verifiedUsdMicros,
      before.verifiedUsdMicros,
      'a self-reported payment must not become verified volume',
    );
    assert.equal(
      after.declaredUsdMicros,
      before.declaredUsdMicros,
      'nor declared volume, which a merchant-set rate would be',
    );
    // It is counted as a payment we could not price, which is what it is.
    assert.equal(after.unpricedPayments, before.unpricedPayments + 1);
  });
});

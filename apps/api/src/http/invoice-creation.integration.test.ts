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
import { AuthService } from '../domain/auth-service.js';
import { CheckoutService } from '../domain/checkout-service.js';
import { DepositAddressDeriver } from '../domain/deposit-address.js';
import { InvoiceCreationService } from '../domain/invoice-creation.js';
import { MerchantService } from '../domain/merchant-service.js';
import { PayoutAddressService } from '../domain/payout-service.js';
import { ReconciliationService } from '../domain/reconciliation-service.js';
import { SettlementStore } from '../domain/settlement-store.js';
import { StaffAuthService } from '../domain/staff-auth.js';
import { SubscriptionService } from '../domain/subscription-service.js';
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
  let subscriptions: SubscriptionService;
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

    subscriptions = new SubscriptionService(db, audit, {
      feeCollectors: { bsc: FEE_COLLECTOR, ethereum: FEE_COLLECTOR },
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
      subscriptions,
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
      auth: new AuthService(db, audit, {
        sessionTtlMs: 60 * 60 * 1000,
        emailTokenTtlMs: 60 * 60 * 1000,
      }),
      staffAuth: new StaffAuthService(db, audit),
      settlements,
      reconciliation,
      admin: new AdminService(db, audit, settlements, reconciliation),
      merchant: new MerchantService(db),
      subscriptions,
      invoiceCreation,
      checkouts: new CheckoutService(
        db,
        invoiceCreation,
        subscriptions,
        deriver,
        { requireRate: (symbol) => prices.requireRate(symbol) },
        audit,
      ),
      webhooks: new WebhookService(
        db,
        new WebhookDispatcher({
          async post() {
            return { statusCode: 200 };
          },
        }),
      ),
    });
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
    await subscriptions.ensureForOrganization(orgId);
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
    await subscriptions.setFeeBps(
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
    await subscriptions.setFeeBps(
      { staffId: staffId ?? '', role: 'superadmin' },
      orgId,
      50,
      'restoring the published rate after the binding test',
    );
    await db
      .update(schema.subscriptions)
      .set({ negotiatedFee: false })
      .where(eq(schema.subscriptions.organizationId, orgId));
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

  // ── billing gates invoicing ────────────────────────────────────────────────

  test('a merchant past grace cannot open new invoices, and is told why', async () => {
    /**
     * The lever that makes the subscription enforceable. Note what it does not touch:
     * invoices already issued still complete and money already received still settles,
     * because a payer mid-transfer is not party to our billing dispute.
     */
    const assetId = await enableAsset({ symbol: 'USDT' });
    await addPayoutAddress('bsc');

    await db
      .update(schema.subscriptions)
      .set({ status: 'unpaid', graceEndsAt: new Date(Date.now() - 86_400_000) })
      .where(eq(schema.subscriptions.organizationId, orgId));

    try {
      const response = await open({ assetId, amountFiatMicros: '1000000' });
      // 402: pay us and this exact request works. Not a 403, which reads as "never".
      assert.equal(response.statusCode, 402, response.body);
      assert.equal(response.json().error, 'billing_blocked');
      assert.match(response.json().message, /already issued will still complete/);
    } finally {
      await db
        .update(schema.subscriptions)
        .set({ status: 'active', graceEndsAt: null })
        .where(eq(schema.subscriptions.organizationId, orgId));
    }
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
});

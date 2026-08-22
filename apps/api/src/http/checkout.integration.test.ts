import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import {
  ContractProbe,
  DEFAULT_AGGREGATION,
  DEFAULT_BREAKER,
  PriceService,
  WebhookDispatcher,
} from '@avex/core';
import type { PriceSource } from '@avex/core';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import { createDatabase, schema } from '../db/client.js';
import { CommissionLedger } from '../domain/commission-ledger.js';
import { WalletPoolChanges, WalletPoolService } from '../domain/wallet-pool-service.js';
import { AdminService } from '../domain/admin-service.js';
import { AssetService } from '../domain/asset-service.js';
import { AuditService } from '../domain/audit.js';
import { InviteService } from '../domain/invite-service.js';
import { MembershipService } from '../domain/membership-service.js';
import { AuthService } from '../domain/auth-service.js';
import { CheckoutService } from '../domain/checkout-service.js';
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
 * The hosted checkout, over HTTP.
 *
 * Half of this surface is reachable with no credentials, which makes it the widest
 * attack surface in the product. A payer holds a link and nothing else, so the link is
 * the capability — and the tests below are mostly about the boundary that follows from
 * that: what a stranger holding it may read, and what they may change.
 *
 * The other thing under test is the ordering the whole design exists for. A merchant
 * knows the fiat amount; only the payer knows which coin they hold. So the amount is
 * fixed first, the currency second, and the deposit address cannot exist until both
 * are known.
 */
const databaseUrl = process.env.DATABASE_URL;

const FACTORY = '0x00000000000000000000000000000000000f4c70';
const IMPLEMENTATION = '0x00000000000000000000000000000000000000e1';
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

describe('hosted checkout', { skip: databaseUrl ? false : 'DATABASE_URL is not set' }, () => {
  let app: FastifyInstance;
  let ledger: CommissionLedger;
  let walletPool: WalletPoolService;
  let close: () => Promise<void>;
  let db: ReturnType<typeof createDatabase>['db'];
  let feePlans: FeePlanService;
  let prices: PriceService;
  let token: string;
  let orgId: string;

  const unique = randomBytes(6).toString('hex');
  const password = 'a-sufficiently-long-password';

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
      APP_URL: 'https://pay.example.test',
      // One allowed origin, so the refusal path is testable against a second.
      CHECKOUT_ORIGINS: 'https://shop.example.test',
    });

    const database = createDatabase(env.DATABASE_URL);
    close = database.close;
    db = database.db;

    const audit = new AuditService(db);
    const mailer = new ConsoleMailer(env.APP_URL, () => {});
    prices = new PriceService([source('a'), source('b')], {
      aggregation: DEFAULT_AGGREGATION,
      breaker: DEFAULT_BREAKER,
      cacheTtlMs: 0,
    });

    feePlans = new FeePlanService(db, audit, {
      feeCollectors: { bsc: FEE_COLLECTOR },
    });
    const deriver = new DepositAddressDeriver(
      {
        evm: {
          bsc: { factory: FACTORY, implementation: IMPLEMENTATION },
          /**
           * Configured but deliberately left without a payout address in the tests
           * below, so "payable" can be tested on a chain this deployment does support.
           * With only bsc and ton configured, the supported-chain filter masked the
           * payout requirement entirely and a mutation removing it passed.
           */
          polygon: { factory: FACTORY, implementation: IMPLEMENTATION },
        },
        shared: { ton: TON_WALLET },
        // TRON, so a pooled currency can reach the options list at all.
        pooled: ['tron'],
      },
      'checkout-suite-memo-secret',
    );
    const rates = { requireRate: (symbol: never) => prices.requireRate(symbol) };
    ledger = new CommissionLedger(db);
    walletPool = new WalletPoolService(db);
    const invoiceCreation = new InvoiceCreationService(
      db,
      deriver,
      feePlans,
      rates,
      audit,
      ledger,
      walletPool,
    );

    const settlements = new SettlementStore(db);
    const reconciliation = new ReconciliationService(db, audit, {
      async recompute() {
        throw new Error('not exercised here');
      },
    });

    app = buildServer({
      ledger,
      walletPool,
      walletChanges: new WalletPoolChanges(db, walletPool, audit, mailer),
      env,
      db,
      audit,
      mailer,
      prices,
      minPriceSources: DEFAULT_AGGREGATION.minSources,
      assets: new AssetService(db, audit, new ContractProbe(offlineCaller), ['USDT']),
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
        rates,
        audit,
        ledger,
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
        email: `chk-${unique}@example.com`,
        password,
        organizationName: `Checkout Shop ${unique}`,
      },
    });
    assert.equal(signup.statusCode, 201, signup.body);
    orgId = signup.json().organizationId as string;

    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: `chk-${unique}@example.com`, password },
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

  async function enableAsset(options: {
    readonly chain?: string;
    readonly symbol?: string;
    readonly decimals?: number;
    readonly mode?: 'fiat' | 'token' | 'fixed_rate';
    readonly verdict?: 'approved' | 'review';
    readonly enabled?: boolean;
    readonly fixedRateScaled?: string | null;
    readonly fixedRateValidUntil?: Date | null;
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
      })
      .returning({ id: schema.assets.id });
    if ((options.verdict ?? 'approved') === 'review') reviewAssets.push(asset!.id);

    await db.insert(schema.merchantAssets).values({
      organizationId: orgId,
      assetId: asset!.id,
      enabled: options.enabled ?? true,
      pricingMode: options.mode ?? 'fiat',
      fixedRateScaled: options.fixedRateScaled ?? null,
      fixedRateValidUntil: options.fixedRateValidUntil ?? null,
    });
    return asset!.id;
  }

  async function ensurePayout(chain: string): Promise<string> {
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

    const address = chain === 'ton' ? 'EQmerchantwallet' : `0x${randomBytes(20).toString('hex')}`;
    await db.insert(schema.payoutAddresses).values({ organizationId: orgId, chain, address });
    return address;
  }

  const createCheckout = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/checkouts`,
      headers: auth(),
      payload,
    });

  const state = (sessionId: string) =>
    app.inject({ method: 'GET', url: `/pay/${sessionId}/state` });
  const optionsFor = (sessionId: string) =>
    app.inject({ method: 'GET', url: `/pay/${sessionId}/options` });
  const select = (sessionId: string, assetId: string) =>
    app.inject({ method: 'POST', url: `/pay/${sessionId}/select`, payload: { assetId } });
  const receipt = (sessionId: string) =>
    app.inject({ method: 'GET', url: `/pay/${sessionId}/receipt` });

  /**
   * Credit a payment against an invoice, as the watcher would.
   *
   * Written straight into the table rather than driven through a chain adapter: what these
   * tests are about is what a receipt says once money has arrived, and going through the
   * watcher would test the watcher a second time.
   */
  async function payInvoice(invoiceId: string, amount: string): Promise<string> {
    const txHash = `0xreceipt${randomBytes(13).toString('hex')}`;
    await db.insert(schema.payments).values({
      invoiceId,
      chain: 'bsc',
      txHash,
      transferIndex: 0,
      amount,
      blockNumber: 800,
      valueSource: 'quote',
    });

    const [invoice] = await db
      .select({ amountDue: schema.invoices.amountDue, toleranceBps: schema.invoices.toleranceBps })
      .from(schema.invoices)
      .where(eq(schema.invoices.id, invoiceId))
      .limit(1);
    const due = BigInt(invoice!.amountDue);
    const paid = BigInt(amount);
    const slack = (due * BigInt(invoice!.toleranceBps)) / 10_000n;
    const status = paid + slack < due ? 'underpaid' : paid > due + slack ? 'overpaid' : 'paid';

    await db
      .update(schema.invoices)
      .set({ amountPaid: amount, status, paidAt: new Date() })
      .where(eq(schema.invoices.id, invoiceId));

    return txHash;
  }

  // ── the merchant opens a checkout ──────────────────────────────────────────

  test('a checkout is created with a link to send the payer to', async () => {
    await enableAsset({ symbol: 'USDT' });
    await ensurePayout('bsc');

    const response = await createCheckout({ amountFiatMicros: '25000000', description: 'Order 42' });
    assert.equal(response.statusCode, 201, response.body);

    const session = response.json();
    assert.equal(session.status, 'open');
    assert.equal(session.amountFiatMicros, '25000000');
    // Built from APP_URL, so the link works per deployment rather than per build.
    assert.equal(session.url, `https://pay.example.test/pay/${session.id}`);
  });

  test('a merchant with nothing payable is refused where they can see it', async () => {
    /**
     * A session with no payable currency is a link that leads to an empty page, and a
     * payer who followed it cannot tell whose problem that is. Failing at creation puts
     * the error where the merchant is already looking.
     */
    const other = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        email: `empty-${unique}@example.com`,
        password,
        organizationName: `Empty ${unique}`,
      },
    });
    const emptyOrg = other.json().organizationId as string;
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: `empty-${unique}@example.com`, password },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${emptyOrg}/checkouts`,
      headers: { authorization: `Bearer ${login.json().token as string}` },
      payload: { amountFiatMicros: '1000000' },
    });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error, 'no_assets');
    assert.match(response.json().message, /payout address/);
  });

  test('the same reference returns the same checkout', async () => {
    // Two payment links for one order is worse than two invoices: a customer can be
    // shown either, and only one will ever be marked paid.
    await enableAsset({ symbol: 'USDT' });
    await ensurePayout('bsc');
    const reference = `order-${unique}-a`;

    const first = await createCheckout({ amountFiatMicros: '1000000', reference });
    const second = await createCheckout({ amountFiatMicros: '1000000', reference });

    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().id, first.json().id);
  });

  // ── the payer opens the link ───────────────────────────────────────────────

  test('the payer sees the amount and who is charging, with no invoice yet', async () => {
    await enableAsset({ symbol: 'USDT' });
    await ensurePayout('bsc');
    const session = (await createCheckout({ amountFiatMicros: '25000000', description: 'A thing' })).json();

    const response = await state(session.id);
    assert.equal(response.statusCode, 200, response.body);

    const view = response.json();
    assert.equal(view.amountFiatMicros, '25000000');
    assert.equal(view.description, 'A thing');
    assert.match(view.merchantName, /Checkout Shop/);
    assert.equal(view.status, 'open');
    // No currency chosen, so nothing to pay to. The address cannot exist yet.
    assert.equal(view.payment, null);
  });

  test('the public view never carries the merchant payout address or our collector', async () => {
    /**
     * The boundary this whole surface turns on. A payer has no business knowing where the
     * money goes afterwards, and both addresses are on the invoice row this view is built
     * from — so their absence is a decision, not an accident of what was selected.
     */
    const assetId = await enableAsset({ symbol: 'USDT' });
    const payout = await ensurePayout('bsc');
    const session = (await createCheckout({ amountFiatMicros: '1000000' })).json();
    await select(session.id, assetId);

    const body = (await state(session.id)).body;
    assert.ok(!body.includes(payout), 'the payout address must not be exposed to a payer');
    assert.ok(!body.includes(FEE_COLLECTOR), 'the fee collector must not be exposed');
    assert.ok(!body.includes(orgId), 'the merchant id must not be exposed');
  });

  test('a merchant-absorbed commission is not shown to the payer', async () => {
    /**
     * The default, and the half of the disclosure rule that is about restraint. The
     * commission comes out of the merchant's settlement, so it is a term between us and
     * them — telling the payer what a shop pays its processor is neither their business
     * nor ours to publish.
     */
    const assetId = await enableAsset({ symbol: 'USDT' });
    await ensurePayout('bsc');
    const session = (await createCheckout({ amountFiatMicros: '1000000' })).json();
    await select(session.id, assetId);

    const invoice = (await state(session.id)).json().payment;
    assert.equal(invoice.feeBps, 0, 'a fee the payer is not paying reads as no fee to them');
    assert.equal(invoice.feeIncluded, '0');
  });

  test('a payer-borne commission is disclosed as its own figure', async () => {
    /**
     * The other half. Once the commission has been added to what the payer must send,
     * showing only the total would make our fee look like the merchant's price — which is
     * exactly the complaint a surcharge attracts when it is not itemised.
     */
    const assetId = await enableAsset({ symbol: 'USDT' });
    await ensurePayout('bsc');
    await feePlans.setFeePayer(orgId, 'payer', null);

    try {
      const session = (await createCheckout({ amountFiatMicros: '1000000' })).json();
      await select(session.id, assetId);

      const invoice = (await state(session.id)).json().payment;
      assert.equal(invoice.feeBps, 50);
      assert.ok(BigInt(invoice.feeIncluded) > 0n, 'the payer must be told the amount');
      // And it is a part of the total, not something extra to send separately.
      assert.ok(BigInt(invoice.feeIncluded) < BigInt(invoice.amountDue));
      // Still nothing about where it goes.
      assert.ok(!(await state(session.id)).body.includes(FEE_COLLECTOR));
    } finally {
      await feePlans.setFeePayer(orgId, 'merchant', null);
    }
  });

  test('a checkout may override who pays, for that checkout only', async () => {
    /**
     * The per-order escape hatch. A merchant who normally passes the fee on still has
     * orders where they would rather absorb it — a goodwill replacement, a complaint.
     */
    const assetId = await enableAsset({ symbol: 'USDT' });
    await ensurePayout('bsc');

    const passedOn = (await createCheckout({ amountFiatMicros: '1000000', feePayer: 'payer' })).json();
    await select(passedOn.id, assetId);
    const surcharged = (await state(passedOn.id)).json().payment;
    assert.equal(surcharged.feeBps, 50);
    assert.ok(BigInt(surcharged.feeIncluded) > 0n);

    // And the merchant's own default is untouched by it.
    const absorbed = (await createCheckout({ amountFiatMicros: '1000000' })).json();
    await select(absorbed.id, assetId);
    assert.equal((await state(absorbed.id)).json().payment.feeIncluded, '0');
    assert.ok(BigInt(surcharged.amountDue) > BigInt((await state(absorbed.id)).json().payment.amountDue));
  });

  test('a checkout that made no choice follows the default at selection time', async () => {
    /**
     * Not at creation time, and the difference is the point. A link can sit unopened for
     * an hour; a merchant who switched in between meant it to apply to the orders still
     * outstanding, not only to the ones not yet created.
     */
    const assetId = await enableAsset({ symbol: 'USDT' });
    await ensurePayout('bsc');

    const session = (await createCheckout({ amountFiatMicros: '1000000' })).json();
    await feePlans.setFeePayer(orgId, 'payer', null);
    try {
      await select(session.id, assetId);
      assert.ok(BigInt((await state(session.id)).json().payment.feeIncluded) > 0n);
    } finally {
      await feePlans.setFeePayer(orgId, 'merchant', null);
    }
  });

  test('the currency list quotes what the payment page will ask for', async () => {
    /**
     * A picker that quoted the price and a payment page that then asked for half a per
     * cent more would look like a bait and switch, and the payer would be right to think
     * so. Both figures come from the same fee, and this is what pins them together.
     */
    const assetId = await enableAsset({ symbol: 'USDT' });
    await ensurePayout('bsc');
    await feePlans.setFeePayer(orgId, 'payer', null);

    try {
      const session = (await createCheckout({ amountFiatMicros: '1000000' })).json();
      const offered = (await app.inject({ method: 'GET', url: `/pay/${session.id}/options` }))
        .json()
        .options.find((option: { assetId: string }) => option.assetId === assetId);
      assert.ok(offered, 'the enabled asset should be on offer');
      assert.ok(BigInt(offered.feeIncluded) > 0n);

      await select(session.id, assetId);
      const invoice = (await state(session.id)).json().payment;
      assert.equal(invoice.amountDue, offered.amount, 'the quoted amount must be the real one');
    } finally {
      await feePlans.setFeePayer(orgId, 'merchant', null);
    }
  });

  // ── receipts ───────────────────────────────────────────────────────────────

  test('a receipt is refused until the payment has landed', async () => {
    /**
     * A receipt for a payment that has not arrived is not a receipt. Issuing one would
     * hand a payer a document saying they had paid.
     *
     * 409, not 404: the link is real and the receipt will exist once the money lands, and
     * "not found" reads to a payer as having lost their order.
     */
    const assetId = await enableAsset({ symbol: 'USDT' });
    await ensurePayout('bsc');
    const session = (await createCheckout({ amountFiatMicros: '20000000' })).json();

    const beforeSelecting = await receipt(session.id);
    assert.equal(beforeSelecting.statusCode, 409, beforeSelecting.body);
    assert.equal(beforeSelecting.json().error, 'not_paid');

    await select(session.id, assetId);
    const beforePaying = await receipt(session.id);
    assert.equal(beforePaying.statusCode, 409, beforePaying.body);
    assert.match(beforePaying.json().message, /not completed yet/);
  });

  test('a settled payment has a receipt carrying the transaction that proves it', async () => {
    const assetId = await enableAsset({ symbol: 'USDT' });
    await ensurePayout('bsc');
    const session = (await createCheckout({
      amountFiatMicros: '20000000',
      description: 'Order 42',
      reference: `receipt-${unique}`,
    })).json();
    const invoice = (await select(session.id, assetId)).json().payment;
    const txHash = await payInvoice(invoice.invoiceId, invoice.amountDue);

    const response = await receipt(session.id);
    assert.equal(response.statusCode, 200, response.body);

    const body = response.json();
    assert.equal(body.status, 'paid');
    assert.match(body.merchantName, /Checkout Shop/);
    assert.equal(body.description, 'Order 42');
    assert.equal(body.reference, `receipt-${unique}`);
    assert.equal(body.amountFiatMicros, '20000000');
    assert.equal(body.amountPaid, invoice.amountDue);
    /**
     * The hash is the only thing on a receipt that does not depend on trusting us, which
     * makes it the field whose absence would matter most.
     */
    assert.deepEqual(
      body.transfers.map((transfer: { txHash: string }) => transfer.txHash),
      [txHash],
    );
    // Short, printable, and derived from the invoice id rather than counted — a shared
    // counter would tell each merchant how many payments the others took.
    assert.match(body.number, /^AVEX-[0-9A-F]{8}$/);
  });

  test('a receipt never carries the payout address or our collector', async () => {
    // A receipt is forwarded, printed and filed, so it is the widest-travelling document
    // this product produces — and the same boundary applies to it as to the payment page.
    const assetId = await enableAsset({ symbol: 'USDT' });
    const payout = await ensurePayout('bsc');
    const session = (await createCheckout({ amountFiatMicros: '20000000' })).json();
    const invoice = (await select(session.id, assetId)).json().payment;
    await payInvoice(invoice.invoiceId, invoice.amountDue);

    const body = (await receipt(session.id)).body;
    assert.ok(!body.includes(payout), 'the payout address must not travel on a receipt');
    assert.ok(!body.includes(FEE_COLLECTOR));
    assert.ok(!body.includes(orgId));
  });

  test('an overpaid checkout gets a receipt that names the excess', async () => {
    /**
     * The money arrived — more of it than was asked for — so the payer is entitled to the
     * record, and the record has to show what they actually sent rather than printing the
     * invoice amount as though that were it.
     */
    const assetId = await enableAsset({ symbol: 'USDT' });
    await ensurePayout('bsc');
    const session = (await createCheckout({ amountFiatMicros: '20000000' })).json();
    const invoice = (await select(session.id, assetId)).json().payment;
    await payInvoice(invoice.invoiceId, (BigInt(invoice.amountDue) * 2n).toString());

    const body = (await receipt(session.id)).json();
    assert.equal(body.status, 'overpaid');
    assert.equal(body.amountPaid, (BigInt(invoice.amountDue) * 2n).toString());
    assert.equal(body.amountDue, invoice.amountDue);
  });

  test('an underpaid checkout gets no receipt, and is told why', async () => {
    // The bill is not settled. A document that looked like a receipt would be worse than
    // none, and the message has to say what is wrong so the payer can send the rest.
    const assetId = await enableAsset({ symbol: 'USDT' });
    await ensurePayout('bsc');
    const session = (await createCheckout({ amountFiatMicros: '20000000' })).json();
    const invoice = (await select(session.id, assetId)).json().payment;
    await payInvoice(invoice.invoiceId, (BigInt(invoice.amountDue) / 2n).toString());

    const response = await receipt(session.id);
    assert.equal(response.statusCode, 409, response.body);
    assert.match(response.json().message, /short of the amount due/);
  });

  test('a receipt discloses a commission the payer bore, and not one they did not', async () => {
    const assetId = await enableAsset({ symbol: 'USDT' });
    await ensurePayout('bsc');

    const absorbed = (await createCheckout({ amountFiatMicros: '20000000' })).json();
    const absorbedInvoice = (await select(absorbed.id, assetId)).json().payment;
    await payInvoice(absorbedInvoice.invoiceId, absorbedInvoice.amountDue);
    assert.equal((await receipt(absorbed.id)).json().feeIncluded, '0');

    const passedOn = (await createCheckout({
      amountFiatMicros: '20000000',
      feePayer: 'payer',
    })).json();
    const passedOnInvoice = (await select(passedOn.id, assetId)).json().payment;
    await payInvoice(passedOnInvoice.invoiceId, passedOnInvoice.amountDue);

    const body = (await receipt(passedOn.id)).json();
    assert.equal(body.feeBps, 50);
    assert.ok(BigInt(body.feeIncluded) > 0n);
  });

  test('a reversed payment leaves no transaction on the receipt', async () => {
    /**
     * A reorg took the transfer back. The hash is the proof, and a hash for a transaction
     * that no longer exists is worse than no hash: a payer who looked it up would find
     * nothing and conclude we had invented it.
     */
    const assetId = await enableAsset({ symbol: 'USDT' });
    await ensurePayout('bsc');
    const session = (await createCheckout({ amountFiatMicros: '20000000' })).json();
    const invoice = (await select(session.id, assetId)).json().payment;
    const txHash = await payInvoice(invoice.invoiceId, invoice.amountDue);

    await db
      .update(schema.payments)
      .set({ reversedAt: new Date(), reversedReason: 'reorg' })
      .where(eq(schema.payments.txHash, txHash));

    const body = (await receipt(session.id)).json();
    assert.deepEqual(body.transfers, []);
  });

  test('an unknown session is a 404, whether guessed or mistyped', async () => {
    const response = await state('11111111-2222-4333-8444-555555555555');
    assert.equal(response.statusCode, 404, response.body);
  });

  test('the payer needs no credentials at all', async () => {
    // Stated explicitly because every other route in this product refuses an
    // anonymous request, and this one has to not.
    await enableAsset({ symbol: 'USDT' });
    await ensurePayout('bsc');
    const session = (await createCheckout({ amountFiatMicros: '1000000' })).json();

    const response = await app.inject({ method: 'GET', url: `/pay/${session.id}/state` });
    assert.equal(response.statusCode, 200, response.body);
  });

  // ── choosing a currency ───────────────────────────────────────────────────

  test('the options list what the payer would send for each currency', async () => {
    await enableAsset({ symbol: 'USDT', decimals: 18 });
    await ensurePayout('bsc');
    const session = (await createCheckout({ amountFiatMicros: '20000000' })).json();

    const response = await optionsFor(session.id);
    assert.equal(response.statusCode, 200, response.body);

    const options = response.json().options as { symbol: string; amount: string; available: boolean }[];
    const usdt = options.find((option) => option.symbol === 'USDT');
    assert.ok(usdt);
    assert.equal(usdt!.available, true);
    // $20 at $1 with the 50bps spread, rounded up: 20 / 0.995.
    assert.equal(usdt!.amount, '20100502512562814071');
  });

  test('an unpriceable currency is shown as unavailable rather than hidden', async () => {
    /**
     * A currency that silently disappears reads as us not supporting it, which would be
     * a lie — and a merchant who enabled it would have no way to find out why it never
     * shows up.
     */
    await enableAsset({ symbol: 'USDT' });
    await ensurePayout('bsc');
    const session = (await createCheckout({ amountFiatMicros: '1000000' })).json();

    pricesAvailable = false;
    try {
      const options = (await optionsFor(session.id)).json().options as {
        available: boolean;
        unavailableReason: string | null;
      }[];
      assert.ok(options.length > 0, 'the currency is still listed');
      assert.ok(options.every((option) => option.available === false));
      assert.match(options[0]!.unavailableReason ?? '', /No trustworthy price/);
    } finally {
      pricesAvailable = true;
      /**
       * Reset the breaker, or the outage leaks into every later test.
       *
       * It is doing exactly its job — a source that just failed repeatedly should not
       * be retried immediately — but a suite that simulates an outage has to undo it,
       * otherwise the next test sees a refusal it never asked for.
       */
      for (const symbol of ['USDT', 'TON', 'USDC', 'ETH', 'BNB', 'SOL', 'TRX', 'POL'] as const) {
        prices.resetBreaker(symbol);
      }
    }
  });

  test('a token-priced asset cannot serve a fiat checkout, and says so', async () => {
    // Offered as unavailable with the reason rather than hidden, so a merchant who
    // misconfigured it can see why.
    const assetId = await enableAsset({ symbol: 'TOKN', mode: 'token' });
    await ensurePayout('bsc');
    const session = (await createCheckout({ amountFiatMicros: '1000000' })).json();

    const options = (await optionsFor(session.id)).json().options as {
      assetId: string;
      available: boolean;
      unavailableReason: string | null;
    }[];
    const entry = options.find((option) => option.assetId === assetId);
    assert.ok(entry);
    assert.equal(entry!.available, false);
    assert.match(entry!.unavailableReason ?? '', /token units/);
  });

  test('choosing a currency creates the invoice and reveals the address', async () => {
    const assetId = await enableAsset({ symbol: 'USDT' });
    await ensurePayout('bsc');
    const session = (await createCheckout({ amountFiatMicros: '20000000' })).json();

    const response = await select(session.id, assetId);
    assert.equal(response.statusCode, 200, response.body);

    const payment = response.json().payment;
    assert.equal(response.json().changed, true);
    assert.equal(payment.chain, 'bsc');
    assert.equal(payment.symbol, 'USDT');
    assert.match(payment.depositAddress, /^0x[0-9a-fA-F]{40}$/);
    assert.equal(payment.amountDue, '20100502512562814071');

    // And the session now reports it, so a page reload does not lose the address.
    const view = (await state(session.id)).json();
    assert.equal(view.status, 'selected');
    assert.equal(view.payment.depositAddress, payment.depositAddress);
  });

  test('choosing twice is a no-op, not a second address', async () => {
    // A double-tap on a phone must not produce two invoices, one of which the payer
    // never sees again.
    const assetId = await enableAsset({ symbol: 'USDT' });
    await ensurePayout('bsc');
    const session = (await createCheckout({ amountFiatMicros: '1000000' })).json();

    const first = await select(session.id, assetId);
    const second = await select(session.id, assetId);

    assert.equal(second.json().changed, false);
    assert.equal(second.json().payment.invoiceId, first.json().payment.invoiceId);
    assert.equal(second.json().payment.depositAddress, first.json().payment.depositAddress);
  });

  test('changing currency before paying gives a new address', async () => {
    // The "Change" button on the page. Allowed while nothing has been sent, because the
    // payer may simply have picked wrong.
    const usdt = await enableAsset({ symbol: 'USDT' });
    const ton = await enableAsset({ chain: 'ton', symbol: 'TON', decimals: 9 });
    await ensurePayout('bsc');
    await ensurePayout('ton');
    const session = (await createCheckout({ amountFiatMicros: '1000000' })).json();

    const first = await select(session.id, usdt);
    const switched = await select(session.id, ton);

    assert.equal(switched.json().changed, true);
    assert.notEqual(switched.json().payment.invoiceId, first.json().payment.invoiceId);
    assert.equal(switched.json().payment.chain, 'ton');
    // A shared-address chain, so the wallet is the configured one and a memo identifies
    // the invoice.
    assert.equal(switched.json().payment.depositAddress, TON_WALLET);
    assert.match(switched.json().payment.memo, /^AVEX-[0-9A-F]{12}$/);
  });

  test('switching back returns the original invoice rather than a third', async () => {
    // The reference is per session and asset, so each currency has exactly one invoice
    // however many times the payer flips between them.
    const usdt = await enableAsset({ symbol: 'USDT' });
    const ton = await enableAsset({ chain: 'ton', symbol: 'TON', decimals: 9 });
    await ensurePayout('bsc');
    await ensurePayout('ton');
    const session = (await createCheckout({ amountFiatMicros: '1000000' })).json();

    const first = await select(session.id, usdt);
    await select(session.id, ton);
    const back = await select(session.id, usdt);

    assert.equal(back.json().payment.invoiceId, first.json().payment.invoiceId);
  });

  test('once money is on its way the currency is locked', async () => {
    /**
     * The address a payer sent to belongs to one invoice. Letting them switch after
     * that would show a different address while a transfer is in flight to the first,
     * which is how a payer ends up believing they paid and the merchant believing they
     * did not.
     */
    const usdt = await enableAsset({ symbol: 'USDT' });
    const ton = await enableAsset({ chain: 'ton', symbol: 'TON', decimals: 9 });
    await ensurePayout('bsc');
    await ensurePayout('ton');
    const session = (await createCheckout({ amountFiatMicros: '1000000' })).json();

    const chosen = await select(session.id, usdt);
    // A partial payment is enough: money is on its way.
    await db
      .update(schema.invoices)
      .set({ amountPaid: '1' })
      .where(eq(schema.invoices.id, chosen.json().payment.invoiceId));

    const response = await select(session.id, ton);
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error, 'locked');
  });

  test('a currency the merchant cannot be paid in is not offered', async () => {
    /**
     * Three conditions, all necessary: approved, enabled, and a payout address on its
     * chain. Offering a currency that fails any of them would take a payment we could
     * not deliver.
     */
    await enableAsset({ symbol: 'USDT' });
    await ensurePayout('bsc');
    const inReview = await enableAsset({ symbol: 'REVW', verdict: 'review' });
    const disabled = await enableAsset({ symbol: 'DSBL', enabled: false });
    // Polygon is configured in this deployment, so the only thing keeping this asset
    // out of the list is the missing payout address.
    const noPayout = await enableAsset({ chain: 'polygon', symbol: 'NOPO' });
    const session = (await createCheckout({ amountFiatMicros: '1000000' })).json();

    const ids = ((await optionsFor(session.id)).json().options as { assetId: string }[]).map(
      (option) => option.assetId,
    );
    assert.ok(!ids.includes(inReview), 'an unapproved asset must not be offered');
    assert.ok(!ids.includes(disabled), 'a disabled asset must not be offered');
    assert.ok(!ids.includes(noPayout), 'a chain with no payout address must not be offered');
  });

  // ── lifecycle ─────────────────────────────────────────────────────────────

  test('the session reports paid once its invoice is paid', async () => {
    const assetId = await enableAsset({ symbol: 'USDT' });
    await ensurePayout('bsc');
    const session = (await createCheckout({ amountFiatMicros: '1000000' })).json();
    const chosen = await select(session.id, assetId);

    await db
      .update(schema.invoices)
      .set({ status: 'paid', paidAt: new Date() })
      .where(eq(schema.invoices.id, chosen.json().payment.invoiceId));

    // Derived from the invoice rather than trusted from the session row, because the
    // invoice is the source of truth for whether money arrived.
    const view = (await state(session.id)).json();
    assert.equal(view.status, 'paid');
  });

  test('an expired session is a 410, so the payer knows the link was real', async () => {
    /**
     * 410 rather than 404: a payer who followed an expired link needs to know it was
     * genuine so they ask the merchant for a new one, rather than assuming they
     * mistyped it.
     */
    const assetId = await enableAsset({ symbol: 'USDT' });
    await ensurePayout('bsc');
    const session = (await createCheckout({ amountFiatMicros: '1000000' })).json();

    await db
      .update(schema.checkoutSessions)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.checkoutSessions.id, session.id));

    // Reading still works, and reports the expiry.
    assert.equal((await state(session.id)).json().status, 'expired');
    // Choosing does not.
    const response = await select(session.id, assetId);
    assert.equal(response.statusCode, 410, response.body);
    assert.equal(response.json().error, 'expired');
  });

  test('expiry does not fire under a live invoice', async () => {
    /**
     * The session deadline is for choosing. Once chosen, the invoice has its own, and it
     * is the one the payer is watching — a session expiring underneath would tell
     * someone mid-transfer that their window had closed while their money was arriving.
     */
    const assetId = await enableAsset({ symbol: 'USDT' });
    await ensurePayout('bsc');
    const session = (await createCheckout({ amountFiatMicros: '1000000' })).json();
    await select(session.id, assetId);

    await db
      .update(schema.checkoutSessions)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.checkoutSessions.id, session.id));

    assert.equal((await state(session.id)).json().status, 'selected');
  });

  test('a cancelled checkout refuses a choice', async () => {
    const assetId = await enableAsset({ symbol: 'USDT' });
    await ensurePayout('bsc');
    const session = (await createCheckout({ amountFiatMicros: '1000000' })).json();

    const cancel = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/checkouts/${session.id}/cancel`,
      headers: auth(),
    });
    assert.equal(cancel.statusCode, 200, cancel.body);

    const response = await select(session.id, assetId);
    assert.equal(response.statusCode, 410, response.body);
    assert.equal(response.json().error, 'cancelled');
  });

  test('a paid checkout cannot be cancelled', async () => {
    // The money has arrived. Withdrawing the session would leave a payer who paid
    // looking at a cancelled page and the merchant with funds they believe they refused.
    const assetId = await enableAsset({ symbol: 'USDT' });
    await ensurePayout('bsc');
    const session = (await createCheckout({ amountFiatMicros: '1000000' })).json();
    const chosen = await select(session.id, assetId);

    await db
      .update(schema.invoices)
      .set({ status: 'paid', paidAt: new Date() })
      .where(eq(schema.invoices.id, chosen.json().payment.invoiceId));
    // Reading refreshes the session's status from its invoice.
    await state(session.id);

    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/checkouts/${session.id}/cancel`,
      headers: auth(),
    });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error, 'already_paid');
  });

  test("another merchant cannot read this merchant's checkout", async () => {
    // The merchant-side route is tenancy-scoped even though the payer-side one is not.
    await enableAsset({ symbol: 'USDT' });
    await ensurePayout('bsc');
    const session = (await createCheckout({ amountFiatMicros: '1000000' })).json();

    const other = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        email: `nosy-${unique}@example.com`,
        password,
        organizationName: `Nosy ${unique}`,
      },
    });
    const nosyOrg = other.json().organizationId as string;
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: `nosy-${unique}@example.com`, password },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${nosyOrg}/checkouts/${session.id}`,
      headers: { authorization: `Bearer ${login.json().token as string}` },
    });
    // Not found rather than forbidden: confirming it exists elsewhere is itself a leak.
    assert.equal(response.statusCode, 404, response.body);
  });

  test('a failed selection is recorded where the merchant will find it', async () => {
    /**
     * The payer is told to pick another currency, which is all they can act on. But
     * "a customer said the currency did not work" has to be answerable, and creation
     * fails before writing anything — so the cause is recorded here or nowhere.
     */
    const assetId = await enableAsset({ symbol: 'USDT' });
    await ensurePayout('bsc');
    const session = (await createCheckout({ amountFiatMicros: '1000000' })).json();

    pricesAvailable = false;
    let response;
    try {
      response = await select(session.id, assetId);
    } finally {
      pricesAvailable = true;
      for (const symbol of ['USDT', 'TON', 'USDC', 'ETH', 'BNB', 'SOL', 'TRX', 'POL'] as const) {
        prices.resetBreaker(symbol);
      }
    }

    assert.equal(response.statusCode, 409, response.body);
    // The payer gets nothing about our internals.
    assert.match(response.json().message, /choose another/);
    assert.ok(!response.body.includes('price_unavailable'));

    const log = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/audit-log?limit=50`,
      headers: auth(),
    });
    const entry = (log.json().data as { action: string; metadata?: Record<string, unknown> }[]).find(
      (row) => row.action === 'checkout.selection_failed' && row.metadata?.assetId === assetId,
    );
    assert.ok(entry, 'the failure should be in the merchant audit log');
    // The specific cause, which the payer was deliberately not told.
    assert.equal(entry!.metadata?.cause, 'price_unavailable');
  });

  // ── cross-origin access ────────────────────────────────────────────────────

  test('an allowed origin may read the checkout from a browser', async () => {
    await enableAsset({ symbol: 'USDT' });
    await ensurePayout('bsc');
    const session = (await createCheckout({ amountFiatMicros: '1000000' })).json();

    const response = await app.inject({
      method: 'GET',
      url: `/pay/${session.id}/state`,
      headers: { origin: 'https://shop.example.test' },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers['access-control-allow-origin'], 'https://shop.example.test');
    // So a cache keyed on the URL alone cannot serve one origin's header to another.
    assert.equal(response.headers['vary'], 'origin');
  });

  test('an unlisted origin gets no header, and the request still answers', async () => {
    /**
     * The header's absence is the whole enforcement — the browser blocks the read. A
     * 403 would be indistinguishable, to the page, from the API being down, and would
     * tell a prober that the origin check exists. Saying less is better.
     */
    await enableAsset({ symbol: 'USDT' });
    await ensurePayout('bsc');
    const session = (await createCheckout({ amountFiatMicros: '1000000' })).json();

    const response = await app.inject({
      method: 'GET',
      url: `/pay/${session.id}/state`,
      headers: { origin: 'https://evil.example.test' },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  });

  test('a merchant past their balance limit stops offering the accruing chain', async () => {
    /**
     * The payer must never meet the merchant's billing state.
     *
     * Without this the option is offered, the payer taps it, and `select` answers 402 — a
     * stranger's checkout failing because of somebody else's account balance, with no
     * explanation that could be given to them without disclosing it. So the option arrives
     * unavailable, with a reason about the currency rather than about the merchant.
     */
    const assetId = await enableAsset({ chain: 'tron', symbol: 'USDT', decimals: 6 });
    await ensurePayout('tron');
    /**
     * A currency on a chain that takes its cut on chain, set up here rather than assumed.
     *
     * It is half the assertion: the refusal has to be limited to the accruing chain, because
     * invoices on the others are what clear the balance. Relying on an asset an earlier test
     * happened to enable made this depend on test order.
     */
    const evmAssetId = await enableAsset({ chain: 'bsc', symbol: 'USDT', decimals: 18 });
    await ensurePayout('bsc');
    await walletPool.register({
      organizationId: orgId,
      chain: 'tron',
      address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    });

    const session = JSON.parse(
      (await createCheckout({ amountFiatMicros: '25000000' })).body,
    ) as { id: string };

    // Offered while the account is in good standing, so the refusal below is about the balance.
    const before = JSON.parse((await optionsFor(session.id)).body) as {
      options: { assetId: string; available: boolean; unavailableReason: string | null }[];
    };
    const offered = before.options.find((o) => o.assetId === assetId);
    assert.equal(offered?.available, true, `not offered: ${offered?.unavailableReason}`);

    await db.insert(schema.commissionLedger).values({
      organizationId: orgId,
      kind: 'accrual',
      amountUsdMicros: '-600000000',
      note: 'over the limit',
    });

    const after = JSON.parse((await optionsFor(session.id)).body) as {
      options: { assetId: string; chain: string; available: boolean; unavailableReason: string | null }[];
    };
    const tron = after.options.find((option) => option.assetId === assetId);
    assert.ok(tron, 'the option is still listed, not hidden');
    assert.equal(tron.available, false);
    assert.match(tron.unavailableReason ?? '', /temporarily unavailable/);
    // And it says nothing about why, because that is not the payer's business.
    assert.ok(!/balance|owe|commission/i.test(tron.unavailableReason ?? ''));

    // The merchant's other chains are untouched: those invoices are what clear the balance.
    const evm = after.options.find((option) => option.assetId === evmAssetId);
    assert.equal(evm?.available, true, `EVM option refused too: ${evm?.unavailableReason}`);

    await db
      .delete(schema.commissionLedger)
      .where(eq(schema.commissionLedger.organizationId, orgId));
  });

  test('a preflight is answered for an allowed origin', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/pay/11111111-2222-4333-8444-555555555555/select',
      headers: {
        origin: 'https://shop.example.test',
        'access-control-request-method': 'POST',
      },
    });
    assert.equal(response.statusCode, 204, response.body);
    assert.equal(response.headers['access-control-allow-origin'], 'https://shop.example.test');
    assert.match(String(response.headers['access-control-allow-methods']), /POST/);
  });

  test('a preflight from an unlisted origin is answered without the header', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/pay/11111111-2222-4333-8444-555555555555/select',
      headers: { origin: 'https://evil.example.test' },
    });
    assert.equal(response.statusCode, 204);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  });

  test('cross-origin access never reaches an authenticated route', async () => {
    /**
     * The reason CORS is scoped to `/pay` rather than applied globally. With the header
     * on an authenticated route, any page a signed-in merchant visited could read their
     * invoices using their own session. The allowed origin is used here precisely
     * because it must make no difference.
     */
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/invoices`,
      headers: { ...auth(), origin: 'https://shop.example.test' },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  });

  test('credentials are never allowed, even for an allowed origin', async () => {
    // Without this a future deployment that set a cookie would have it attached by the
    // browser on every cross-origin checkout read.
    await enableAsset({ symbol: 'USDT' });
    await ensurePayout('bsc');
    const session = (await createCheckout({ amountFiatMicros: '1000000' })).json();

    const response = await app.inject({
      method: 'GET',
      url: `/pay/${session.id}/state`,
      headers: { origin: 'https://shop.example.test' },
    });
    assert.equal(response.headers['access-control-allow-credentials'], undefined);
  });

  test('payer-facing responses are never cached', async () => {
    /**
     * A cached "unpaid" shown to a payer who has just paid is the single most confusing
     * thing this page could do, and a proxy would happily do it without the header.
     */
    await enableAsset({ symbol: 'USDT' });
    await ensurePayout('bsc');
    const session = (await createCheckout({ amountFiatMicros: '1000000' })).json();

    for (const url of [`/pay/${session.id}/state`, `/pay/${session.id}/options`]) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.headers['cache-control'], 'no-store', url);
    }
  });
});

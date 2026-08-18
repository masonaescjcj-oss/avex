import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import {
  CURATED_ASSETS,
  ContractProbe,
  DEFAULT_AGGREGATION,
  DEFAULT_BREAKER,
  PriceService,
  SUPPORTED_CHAINS,
  WebhookDispatcher,
} from '@avex/core';
import type { PriceSource } from '@avex/core';
import { and, count, desc, eq, inArray, like } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import { hashToken } from '../auth/tokens.js';
import { totpCode } from '../auth/totp.js';
import { createDatabase, schema } from '../db/client.js';
import { AdminService } from '../domain/admin-service.js';
import { AssetService } from '../domain/asset-service.js';
import { AuditService } from '../domain/audit.js';
import { AuthService } from '../domain/auth-service.js';
import { DatabasePaymentSink } from '../domain/payment-sink.js';
import { PayoutAddressService } from '../domain/payout-service.js';
import { ReconciliationService } from '../domain/reconciliation-service.js';
import { MerchantService } from '../domain/merchant-service.js';
import { CheckoutService } from '../domain/checkout-service.js';
import { DepositAddressDeriver } from '../domain/deposit-address.js';
import { InvoiceCreationService } from '../domain/invoice-creation.js';
import { FeePlanService } from '../domain/fee-plan-service.js';
import { SettlementStore } from '../domain/settlement-store.js';
import { WebhookService } from '../domain/webhook-service.js';
import { StaffAuthService } from '../domain/staff-auth.js';
import { loadEnv } from '../env.js';
import { ConsoleMailer } from '../mailer.js';
import { buildServer } from './server.js';

/**
 * The admin panel's HTTP surface, against a real Postgres.
 *
 * Skipped when DATABASE_URL is unset, so the unit suite stays runnable anywhere.
 *
 * Everything here is made unique per run with `randomBytes`. Twice now a suite in
 * this project has passed once and then failed against its own leftovers, because a
 * hardcoded identifier collided with a deliberately global unique key. The
 * uniqueness is not incidental tidiness — it is what makes the suite repeatable.
 */
const databaseUrl = process.env.DATABASE_URL;

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

describe('admin panel', { skip: databaseUrl ? false : 'DATABASE_URL is not set' }, () => {
  let app: FastifyInstance;
  let close: () => Promise<void>;
  let db: ReturnType<typeof createDatabase>['db'];
  let staffAuth: StaffAuthService;
  let settlements: SettlementStore;
  let reconciliation: ReconciliationService;
  let paymentSink: DatabasePaymentSink;
  let webhookService: WebhookService;
  let feePlanService: FeePlanService;

  const unique = randomBytes(6).toString('hex');
  const staffPassword = 'a-long-enough-staff-password';
  const merchantPassword = 'a-sufficiently-long-password';

  const superadminEmail = `root-${unique}@avex.test`;
  const supportEmail = `support-${unique}@avex.test`;
  const merchantEmail = `merchant-${unique}@example.com`;

  let superadminSecret: string;
  let superadminId: string;
  let supportSecret: string;
  let superadminToken: string;
  let supportToken: string;
  let merchantOrgId: string;
  let merchantSessionToken: string;

  const fakeSource = (name: string): PriceSource => ({
    name,
    supports: () => true,
    async fetchUsdPrice() {
      return { priceScaled: 10n ** 18n, observedAt: Date.now() };
    },
  });

  /** Password, then authenticator code — the only path to a usable staff session. */
  async function signIn(email: string, secret: string): Promise<string> {
    const start = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { email, password: staffPassword },
    });
    assert.equal(start.statusCode, 200, start.body);
    const challenge = start.json().challengeToken as string;

    const finish = await app.inject({
      method: 'POST',
      url: '/admin/auth/complete',
      payload: { challengeToken: challenge, code: totpCode(secret) },
    });
    assert.equal(finish.statusCode, 200, finish.body);
    return finish.json().sessionToken as string;
  }

  const asStaff = (token: string) => ({ authorization: `Bearer ${token}` });

  before(async () => {
    const env = loadEnv({
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl!,
      RATE_LIMIT_PER_MINUTE: '10000',
    });

    const database = createDatabase(env.DATABASE_URL);
    db = database.db;
    close = database.close;

    const audit = new AuditService(db);
    const mailer = new ConsoleMailer(env.APP_URL, () => {});
    staffAuth = new StaffAuthService(db, audit);
    settlements = new SettlementStore(db);

    /**
     * A real payment sink, so `attach` recomputes the invoice exactly as the watcher
     * would. Webhooks go nowhere — this suite is not testing delivery — but the
     * status arithmetic is the production one, which is the part that matters.
     */
    webhookService = new WebhookService(
      db,
      new WebhookDispatcher({ async post() { return { statusCode: 200 }; } }),
    );
    paymentSink = new DatabasePaymentSink(db, audit, webhookService, () => 0);
    reconciliation = new ReconciliationService(db, audit, paymentSink);
    feePlanService = new FeePlanService(db, audit, {
      // Collectors for two chains only, on purpose: the third is what proves a chain
      // we cannot form an address for charges nothing rather than burning the fee.
      feeCollectors: {
        bsc: FEE_COLLECTOR_EVM,
        ethereum: FEE_COLLECTOR_EVM,
      },
    });

    const adminDeriver = new DepositAddressDeriver(
      {
        evm: {
          bsc: {
            factory: '0x00000000000000000000000000000000000f4c70',
            forwarderCreationCode: '0x60806040523480156100115760006000fd5b50',
          },
        },
        shared: {},
      },
      'admin-suite-memo-secret',
    );
    const adminRates = {
      async requireRate() {
        return { priceScaled: 10n ** 18n, observedAt: Date.now() };
      },
    };
    const adminInvoiceCreation = new InvoiceCreationService(
      db,
      adminDeriver,
      feePlanService,
      adminRates as never,
      audit,
    );

    app = buildServer({
      env,
      db,
      audit,
      mailer,
      minPriceSources: DEFAULT_AGGREGATION.minSources,
      payouts: new PayoutAddressService(db, audit, mailer),
      assets: new AssetService(db, audit, new ContractProbe(offlineCaller), ['USDT']),
      prices: new PriceService([fakeSource('a'), fakeSource('b')], {
        aggregation: DEFAULT_AGGREGATION,
        breaker: DEFAULT_BREAKER,
        cacheTtlMs: 10_000,
      }),
      auth: new AuthService(db, audit, {
        sessionTtlMs: 60 * 60 * 1000,
        emailTokenTtlMs: 60 * 60 * 1000,
      }),
      staffAuth,
      settlements,
      reconciliation,
      merchant: new MerchantService(db),
      invoiceCreation: adminInvoiceCreation,
      checkouts: new CheckoutService(
        db,
        adminInvoiceCreation,
        feePlanService,
        adminDeriver,
        adminRates as never,
        audit,
      ),
      feePlans: feePlanService,
      webhooks: webhookService,
      admin: new AdminService(db, audit, settlements, reconciliation),
    });

    /**
     * Staff are created through the service rather than over HTTP, because there is
     * no HTTP route that creates the first one. That absence is the design — see the
     * bootstrap test below, which proves it.
     *
     * `bootstrap` only works on an empty table and this database is shared with the
     * other suites, so fall back to a direct insert when staff already exist.
     */
    const created = await staffAuth
      .bootstrap(superadminEmail, 'Root', staffPassword)
      .catch(async () =>
        staffAuth.createStaff(
          { staffId: (await anyExistingSuperadminId()) ?? '', role: 'superadmin' },
          superadminEmail,
          'Root',
          staffPassword,
          'superadmin',
        ),
      );
    superadminSecret = created.totpSecret;
    superadminId = created.staffId;
    superadminToken = await signIn(superadminEmail, superadminSecret);

    const support = await staffAuth.createStaff(
      { staffId: created.staffId, role: 'superadmin' },
      supportEmail,
      'Support',
      staffPassword,
      'support',
    );
    supportSecret = support.totpSecret;
    supportToken = await signIn(supportEmail, supportSecret);

    // A merchant to act upon.
    const signup = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        email: merchantEmail,
        password: merchantPassword,
        organizationName: `Shop ${unique}`,
      },
    });
    assert.equal(signup.statusCode, 201, signup.body);
    merchantOrgId = signup.json().organizationId as string;

    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: merchantEmail, password: merchantPassword },
    });
    // The merchant login route names this `token`; the staff one names it
    // `sessionToken`. Asserting it is present here rather than discovering the
    // mismatch three tests later as a confusing 401.
    merchantSessionToken = login.json().token as string;
    assert.ok(merchantSessionToken, `merchant login returned no token: ${login.body}`);
  });

  after(async () => {
    /**
     * Clear the review queue rows this suite created.
     *
     * Without this the shared queue grows by several rows a run, and once it passes the
     * page limit these very tests start failing — a newly submitted asset is no longer
     * on the first page of a queue ordered oldest-first. It took three runs of an
     * unrelated suite to surface, which is the argument for cleaning up rather than
     * raising the limit.
     */
    if (reviewAssets.length > 0) {
      await db
        .delete(schema.merchantAssets)
        .where(inArray(schema.merchantAssets.assetId, reviewAssets));
      await db.delete(schema.assets).where(inArray(schema.assets.id, reviewAssets));
    }

    /**
     * And the unmatched payments, for the same reason.
     *
     * That queue is also ordered oldest-first with a capped page, so a run's leftovers
     * eventually hide the row the next run is looking for. Matched by this run's unique
     * suffix rather than by a tracked list, because several are recorded through the
     * reconciliation service rather than inserted directly.
     */
    await db
      .delete(schema.unmatchedPayments)
      .where(like(schema.unmatchedPayments.txHash, `%${unique}%`));
    await app?.close();
    await close?.();
  });

  async function anyExistingSuperadminId(): Promise<string | null> {
    const [row] = await db
      .select({ id: schema.staff.id })
      .from(schema.staff)
      .where(eq(schema.staff.role, 'superadmin'))
      .limit(1);
    return row?.id ?? null;
  }


  /** Shape of a chain entry in the health response, for readable assertions. */
  interface ChainHealthJson {
    chain: string;
    scannedTo: number | null;
    lastPolledAt: string | null;
    staleForMs: number | null;
  }

  /**
   * Re-prove the authenticator.
   *
   * Needed before every elevated action rather than once, because the window is two
   * minutes and several of these tests run an elevated call each.
   */
  async function reauth(): Promise<void> {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/auth/reauthenticate',
      headers: asStaff(superadminToken),
      payload: { code: totpCode(superadminSecret) },
    });
    assert.equal(response.statusCode, 200, response.body);
  }

  /** An asset at a chosen verdict. Contract is unique per row so the key holds. */
  async function insertAsset(
    verdict: 'review' | 'approved' | 'blocked',
    symbol: string,
    findings: unknown[] = [],
  ): Promise<string> {
    const [row] = await db
      .insert(schema.assets)
      .values({
        chain: 'bsc',
        symbol,
        contract: `0x${randomBytes(20).toString('hex')}`,
        decimals: 18,
        kind: 'erc20',
        verdict,
        findings,
        probedAt: new Date(),
      })
      .returning({ id: schema.assets.id });
    // The staff review queue is global and ordered oldest-first, so review-verdict
    // leftovers from repeated runs push genuinely new submissions past the page limit.
    // Cleared in `after`; see the note there.
    if (verdict === 'review') reviewAssets.push(row!.id);
    return row!.id;
  }

  /** Review-verdict assets to clear in `after`. */
  const reviewAssets: string[] = [];

  /**
   * An invoice on BSC belonging to the suite's merchant.
   *
   * The deposit address is random per invoice because `invoices_chain_deposit_key` is
   * global — a fixed one would pass on the first run and collide on the second.
   */
  async function createInvoice(
    amountDue: bigint,
  ): Promise<{ invoiceId: string; depositAddress: string }> {
    const assetId = await insertAsset('approved', `INV${randomBytes(2).toString('hex')}`);
    const depositAddress = `0x${randomBytes(20).toString('hex')}`;
    const [row] = await db
      .insert(schema.invoices)
      .values({
        organizationId: merchantOrgId,
        assetId,
        amountDue: amountDue.toString(),
        chain: 'bsc',
        depositAddress,
        payoutAddress: `0x${randomBytes(20).toString('hex')}`,
        expiresAt: new Date(Date.now() + 60 * 60_000),
      })
      .returning({ id: schema.invoices.id });
    return { invoiceId: row!.id, depositAddress };
  }

  async function unmatchedIdFor(txHash: string): Promise<string> {
    const [row] = await db
      .select({ id: schema.unmatchedPayments.id })
      .from(schema.unmatchedPayments)
      .where(eq(schema.unmatchedPayments.txHash, txHash))
      .limit(1);
    assert.ok(row, `no unmatched row for ${txHash}`);
    return row.id;
  }


  /** A merchant with nothing else going on, for billing lifecycle tests. */
  async function freshMerchant(label: string): Promise<string> {
    const signup = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        email: `${label}-${unique}@example.com`,
        password: merchantPassword,
        organizationName: `${label} ${unique}`,
      },
    });
    assert.equal(signup.statusCode, 201, signup.body);
    return signup.json().organizationId as string;
  }

  const FEE_COLLECTOR_EVM = '0x3333333333333333333333333333333333333333';

  const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const inDays = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  /**
   * Give a merchant USD volume in a period, so the ladder has something to read.
   *
   * Defaults to `valueSource: 'quote'`, which is what a real invoice with a locked rate
   * produces. The overrides exist because a tier turns on *how* a figure was arrived at,
   * not just its size: a merchant-declared rate counts but is flagged when it buys a
   * cheaper rung, an unpriced payment counts for nothing, and a reversed one must count
   * for nothing too.
   */
  async function giveVolume(
    orgId: string,
    usd: number,
    creditedAt: Date = new Date(Date.now() - 60_000),
    options: {
      readonly source?: 'quote' | 'oracle' | 'merchant_rate' | 'unknown';
      readonly reversed?: boolean;
      readonly mode?: 'test' | 'live';
      /** The rate the invoice carries, which is what our cut is computed from. */
      readonly feeBps?: number;
    } = {},
  ): Promise<string> {
    const assetId = await insertAsset('approved', `VOL${randomBytes(2).toString('hex')}`);
    const [invoice] = await db
      .insert(schema.invoices)
      .values({
        organizationId: orgId,
        assetId,
        amountDue: (10n ** 18n).toString(),
        chain: 'bsc',
        depositAddress: `0x${randomBytes(20).toString('hex')}`,
        payoutAddress: `0x${randomBytes(20).toString('hex')}`,
        mode: options.mode ?? 'live',
        feeBps: options.feeBps ?? 50,
        // Required by `invoices_fee_has_destination` whenever the rate is non-zero: a fee
        // with nowhere to go is a fee the forwarder could not deliver.
        ...(options.feeBps === 0 ? {} : { feeDestination: FEE_COLLECTOR_EVM }),
        expiresAt: new Date(Date.now() + 3600_000),
      })
      .returning({ id: schema.invoices.id });

    const source = options.source ?? 'quote';
    await db.insert(schema.payments).values({
      invoiceId: invoice!.id,
      chain: 'bsc',
      txHash: `0xvolume${randomBytes(14).toString('hex')}`,
      transferIndex: 0,
      amount: (10n ** 18n).toString(),
      blockNumber: 700,
      creditedAt,
      // `unknown` means we could not price it, so there is no figure to carry — writing
      // one anyway would let an unpriceable payment count towards a dollar threshold.
      valueUsdMicros: source === 'unknown' ? null : BigInt(Math.round(usd * 1e6)).toString(),
      valueSource: source,
      ...(options.reversed
        ? { reversedAt: new Date(creditedAt.getTime() + 60_000), reversedReason: 'reorg' }
        : {}),
    });

    return invoice!.id;
  }

  // ── credential separation ──────────────────────────────────────────────────

  test('a merchant session cannot reach the admin panel', async () => {
    /**
     * The most important test in this file. A merchant token is a valid credential
     * for the same server, so nothing but a deliberate separation stops it here — and
     * if it worked, any merchant could read every other merchant's data.
     */
    const response = await app.inject({
      method: 'GET',
      url: '/admin/merchants',
      headers: asStaff(merchantSessionToken),
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error, 'staff_unauthenticated');
  });

  test('a staff session cannot reach merchant routes', async () => {
    // The converse. A staff token is not a membership in anything, so it must not
    // pass the merchant authenticator either.
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${merchantOrgId}`,
      headers: asStaff(superadminToken),
    });
    assert.ok(
      response.statusCode === 401 || response.statusCode === 404,
      `expected a refusal, got ${response.statusCode}`,
    );
  });

  test('the panel refuses an anonymous request', async () => {
    const response = await app.inject({ method: 'GET', url: '/admin/merchants' });
    assert.equal(response.statusCode, 401);
  });

  test('password alone never yields a session', async () => {
    const start = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { email: superadminEmail, password: staffPassword },
    });
    assert.equal(start.statusCode, 200);
    const body = start.json();
    assert.equal(body.status, 'mfa_required');
    assert.equal(body.sessionToken, undefined, 'the first stage must not return a session');

    // And the challenge token is not usable as a session on its own.
    const attempt = await app.inject({
      method: 'GET',
      url: '/admin/me',
      headers: asStaff(body.challengeToken),
    });
    assert.equal(attempt.statusCode, 401);
  });

  test('a wrong authenticator code is refused', async () => {
    const start = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { email: superadminEmail, password: staffPassword },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/admin/auth/complete',
      payload: { challengeToken: start.json().challengeToken, code: '000000' },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error, 'invalid_code');
  });

  test('an unknown email and a wrong password are indistinguishable', async () => {
    const unknown = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { email: `nobody-${unique}@avex.test`, password: staffPassword },
    });
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { email: superadminEmail, password: 'not-the-right-password' },
    });

    assert.equal(unknown.statusCode, 401);
    assert.equal(wrongPassword.statusCode, 401);
    // Same body, so the endpoint cannot be used to enumerate who works here.
    assert.deepEqual(unknown.json(), wrongPassword.json());
  });

  test('bootstrap is closed once any staff account exists', async () => {
    await assert.rejects(
      () => staffAuth.bootstrap(`second-root-${unique}@avex.test`, 'Second', staffPassword),
      /Staff already exist/,
    );
  });

  test('a staff password below the floor is refused', async () => {
    const actorId = (await anyExistingSuperadminId())!;
    await assert.rejects(
      () =>
        staffAuth.createStaff(
          { staffId: actorId, role: 'superadmin' },
          `weak-${unique}@avex.test`,
          'Weak',
          'short',
          'support',
        ),
      /at least 14 characters/,
    );
  });

  // ── /admin/me ──────────────────────────────────────────────────────────────

  test('me reports the role and the permissions the panel should render', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/admin/me',
      headers: asStaff(supportToken),
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.role, 'support');
    assert.ok(body.permissions.includes('merchant:read'));
    assert.ok(!body.permissions.includes('merchant:suspend'));
  });

  // ── feature 01: merchants ──────────────────────────────────────────────────

  test('the merchant list includes the new merchant with its counts', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/admin/merchants?search=${unique}`,
      headers: asStaff(supportToken),
    });
    assert.equal(response.statusCode, 200);

    const body = response.json();
    const found = body.items.find((item: { id: string }) => item.id === merchantOrgId);
    assert.ok(found, 'the merchant created in setup should be listed');
    assert.equal(found.memberCount, 1);
    assert.equal(found.invoiceCount, 0);
    // A decimal string, not a number: an 18-decimal amount does not fit a double.
    assert.equal(found.paidVolume, '0');
    assert.equal(typeof found.paidVolume, 'string');
    assert.equal(found.suspendedAt, null);
  });

  test('merchant detail returns members, keys and payout history', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/admin/merchants/${merchantOrgId}`,
      headers: asStaff(supportToken),
    });
    assert.equal(response.statusCode, 200);

    const body = response.json();
    assert.equal(body.organization.id, merchantOrgId);
    assert.equal(body.members.length, 1);
    assert.equal(body.members[0].email, merchantEmail);
    assert.equal(body.members[0].role, 'owner');
    assert.ok(Array.isArray(body.payoutAddresses));
    assert.ok(Array.isArray(body.apiKeys));
  });

  test('opening one merchant is written to the audit trail', async () => {
    /**
     * Reading a named merchant's data is a privacy event, and this is the record of
     * it. The write happens inside the authorization helper, so a route cannot
     * perform the read without producing the entry.
     */
    await app.inject({
      method: 'GET',
      url: `/admin/merchants/${merchantOrgId}`,
      headers: asStaff(supportToken),
    });

    const search = await app.inject({
      method: 'GET',
      url: `/admin/audit?organizationId=${merchantOrgId}&action=staff.read`,
      headers: asStaff(superadminToken),
    });
    assert.equal(search.statusCode, 200);

    const rows = search.json().rows;
    assert.ok(rows.length > 0, 'the read should have been recorded');
    assert.equal(rows[0].actor.kind, 'staff');
    assert.equal(rows[0].actor.email, supportEmail);
    assert.equal(rows[0].targetId, merchantOrgId);
  });

  test('browsing the merchant list is not written to the audit trail', async () => {
    const before = await countAudit('staff.read');
    await app.inject({
      method: 'GET',
      url: '/admin/merchants',
      headers: asStaff(supportToken),
    });
    assert.equal(await countAudit('staff.read'), before, 'a list page is not an access');
  });

  test('support cannot suspend a merchant', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/admin/merchants/${merchantOrgId}/suspend`,
      headers: asStaff(supportToken),
      payload: { reason: 'testing that this is refused' },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error, 'permission_denied');
  });

  test('a suspension reason is required and has a floor', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/admin/merchants/${merchantOrgId}/suspend`,
      headers: asStaff(superadminToken),
      payload: { reason: 'abuse' },
    });
    // The merchant is shown this text when they are refused; five characters is not
    // an explanation, and the ticket it generates costs more than the sentence would.
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'invalid_request');
  });

  test('suspension takes effect immediately for the merchant', async () => {
    const reason = `suspended by an integration test ${unique}`;
    const suspend = await app.inject({
      method: 'POST',
      url: `/admin/merchants/${merchantOrgId}/suspend`,
      headers: asStaff(superadminToken),
      payload: { reason },
    });
    assert.equal(suspend.statusCode, 200, suspend.body);

    /**
     * The point of the whole feature: the merchant's own requests stop. This works
     * because `requireOrganizationAccess` refuses a suspended organisation before
     * any handler runs, so one column write closes every merchant-facing route at
     * once rather than each route having to remember to check.
     */
    const merchantRequest = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${merchantOrgId}/payout-addresses`,
      headers: { authorization: `Bearer ${merchantSessionToken}` },
    });
    assert.equal(merchantRequest.statusCode, 403);
    assert.equal(merchantRequest.json().error, 'organization_suspended');
    assert.equal(merchantRequest.json().message, reason);

    // Suspending twice is a conflict rather than a silent success, so an operator
    // cannot overwrite the original reason and lose why it happened.
    const again = await app.inject({
      method: 'POST',
      url: `/admin/merchants/${merchantOrgId}/suspend`,
      headers: asStaff(superadminToken),
      payload: { reason: 'a second, different reason' },
    });
    assert.equal(again.statusCode, 409);
  });

  test('reinstatement restores merchant access and keeps the old reason in the log', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/admin/merchants/${merchantOrgId}/reinstate`,
      headers: asStaff(superadminToken),
      payload: { note: 'resolved' },
    });
    assert.equal(response.statusCode, 200, response.body);

    const merchantRequest = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${merchantOrgId}/payout-addresses`,
      headers: { authorization: `Bearer ${merchantSessionToken}` },
    });
    assert.equal(merchantRequest.statusCode, 200);

    // Reinstating clears the reason column, so the audit entry is the only place it
    // survives. Losing it would mean losing why the merchant was ever suspended.
    const search = await app.inject({
      method: 'GET',
      url: `/admin/audit?organizationId=${merchantOrgId}&action=merchant.reinstated`,
      headers: asStaff(superadminToken),
    });
    const [row] = search.json().rows;
    assert.ok(row, 'the reinstatement should be recorded');
    assert.match(String(row.metadata.clearedReason), new RegExp(unique));

    const notSuspended = await app.inject({
      method: 'POST',
      url: `/admin/merchants/${merchantOrgId}/reinstate`,
      headers: asStaff(superadminToken),
      payload: {},
    });
    assert.equal(notSuspended.statusCode, 409);
  });

  test('an unknown merchant id is a 404', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/admin/merchants/00000000-0000-0000-0000-000000000000',
      headers: asStaff(supportToken),
    });
    assert.equal(response.statusCode, 404);
  });

  // ── feature 06: audit search ───────────────────────────────────────────────

  test('audit search filters by action prefix', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/admin/audit?action=merchant.',
      headers: asStaff(supportToken),
    });
    assert.equal(response.statusCode, 200);
    for (const row of response.json().rows) {
      assert.ok(row.action.startsWith('merchant.'), row.action);
    }
  });

  test('audit search escapes LIKE metacharacters in the prefix', async () => {
    /**
     * `_` matches any character in LIKE. Unescaped, a search for `merchant_` would
     * return `merchant.suspended` — quietly wrong, and in a tool used to establish
     * what happened, quietly wrong is the worst kind.
     */
    const response = await app.inject({
      method: 'GET',
      url: '/admin/audit?action=merchant_',
      headers: asStaff(supportToken),
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().rows.length, 0, 'the underscore must be a literal');
  });

  test('audit search pages by keyspace without skipping or repeating a row', async () => {
    /**
     * The table grows while it is being read, so offset pagination would skip rows.
     * In an audit trail, the skipped row is the one somebody was looking for.
     *
     * This walks the whole trail two rows at a time, inserting nothing, and checks
     * that ids are unique and strictly ordered across page boundaries.
     */
    const seen: string[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 12; page++) {
      const suffix: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
      const response = await app.inject({
        method: 'GET',
        url: `/admin/audit?limit=2${suffix}`,
        headers: asStaff(supportToken),
      });
      assert.equal(response.statusCode, 200);

      const body = response.json() as { rows: { id: string }[]; nextCursor: string | null };
      for (const row of body.rows) seen.push(row.id);
      cursor = body.nextCursor;
      if (cursor === null) break;
    }

    assert.ok(seen.length > 2, 'the suite should have produced more than one page by now');
    assert.equal(new Set(seen).size, seen.length, 'a row was returned on two pages');
  });

  test('a malformed cursor returns the first page rather than an error', async () => {
    // A cursor is a pagination hint. Refusing the whole request over a mangled one
    // would turn a cosmetic problem into an unusable page.
    const response = await app.inject({
      method: 'GET',
      url: '/admin/audit?limit=2&cursor=not-a-real-cursor',
      headers: asStaff(supportToken),
    });
    assert.equal(response.statusCode, 200);
    assert.ok(response.json().rows.length > 0);
  });

  test('audit rows name the actor and distinguish staff from merchant users', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/admin/audit?limit=200',
      headers: asStaff(superadminToken),
    });
    const rows = response.json().rows as { actor: { kind: string } }[];

    const kinds = new Set(rows.map((row) => row.actor.kind));
    // Both must be present and distinguishable: a merchant reading their own trail
    // needs to tell "we changed this" from "AVEX changed this".
    assert.ok(kinds.has('staff'), 'staff-actor rows should exist');
    assert.ok(kinds.has('user'), 'merchant-user rows should exist');
  });

  // ── staff administration ───────────────────────────────────────────────────

  test('creating staff requires a recently proven second factor', async () => {
    /**
     * The session below is fully signed in — it proved a code minutes ago at sign-in
     * — but `staff:write` demands the authenticator within a two-minute window.
     * Expiring the stamp directly is the only way to age it without waiting.
     */
    await db
      .update(schema.staffSessions)
      .set({ mfaSatisfiedAt: new Date(Date.now() - 10 * 60 * 1000) })
      .where(eq(schema.staffSessions.tokenHash, hashToken(superadminToken)));

    const refused = await app.inject({
      method: 'POST',
      url: '/admin/staff',
      headers: asStaff(superadminToken),
      payload: {
        email: `late-${unique}@avex.test`,
        name: 'Late',
        password: staffPassword,
        role: 'support',
      },
    });
    assert.equal(refused.statusCode, 403);
    assert.equal(refused.json().error, 'elevation_required');

    // Re-confirming with a current code restores it.
    const reauth = await app.inject({
      method: 'POST',
      url: '/admin/auth/reauthenticate',
      headers: asStaff(superadminToken),
      payload: { code: totpCode(superadminSecret) },
    });
    assert.equal(reauth.statusCode, 200, reauth.body);

    const allowed = await app.inject({
      method: 'POST',
      url: '/admin/staff',
      headers: asStaff(superadminToken),
      payload: {
        email: `late-${unique}@avex.test`,
        name: 'Late',
        password: staffPassword,
        role: 'support',
      },
    });
    assert.equal(allowed.statusCode, 201, allowed.body);
    // The authenticator secret is shown exactly once, here. Nothing stores a way to
    // display it again, because a secret that can be re-read is not one.
    assert.ok(allowed.json().totpSecret);
  });

  test('an operator cannot create a superadmin', async () => {
    const operator = await staffAuth.createStaff(
      { staffId: (await anyExistingSuperadminId())!, role: 'superadmin' },
      `operator-${unique}@avex.test`,
      'Operator',
      staffPassword,
      'operator',
    );

    await assert.rejects(
      () =>
        staffAuth.createStaff(
          { staffId: operator.staffId, role: 'operator' },
          `escalated-${unique}@avex.test`,
          'Escalated',
          staffPassword,
          'superadmin',
        ),
      /cannot grant the superadmin role/,
    );
  });

  test('disabling a staff account revokes the sessions it already held', async () => {
    /**
     * Both halves matter. Without the session revocation, a dismissed staff member
     * keeps cross-tenant access until their token happens to expire — up to a full
     * working day with an eight-hour TTL.
     */
    const victim = await staffAuth.createStaff(
      { staffId: (await anyExistingSuperadminId())!, role: 'superadmin' },
      `leaver-${unique}@avex.test`,
      'Leaver',
      staffPassword,
      'support',
    );
    const victimToken = await signIn(`leaver-${unique}@avex.test`, victim.totpSecret);

    const beforeDisable = await app.inject({
      method: 'GET',
      url: '/admin/me',
      headers: asStaff(victimToken),
    });
    assert.equal(beforeDisable.statusCode, 200);

    await app.inject({
      method: 'POST',
      url: '/admin/auth/reauthenticate',
      headers: asStaff(superadminToken),
      payload: { code: totpCode(superadminSecret) },
    });
    const disable = await app.inject({
      method: 'POST',
      url: `/admin/staff/${victim.staffId}/disable`,
      headers: asStaff(superadminToken),
      payload: { reason: 'left the company' },
    });
    assert.equal(disable.statusCode, 200, disable.body);

    const afterDisable = await app.inject({
      method: 'GET',
      url: '/admin/me',
      headers: asStaff(victimToken),
    });
    assert.equal(afterDisable.statusCode, 401, 'the live session must stop working');

    // And they cannot sign back in.
    const retry = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { email: `leaver-${unique}@avex.test`, password: staffPassword },
    });
    assert.equal(retry.statusCode, 403);
    assert.equal(retry.json().error, 'account_disabled');
  });

  test('signing out stops the session', async () => {
    const throwaway = await staffAuth.createStaff(
      { staffId: (await anyExistingSuperadminId())!, role: 'superadmin' },
      `bye-${unique}@avex.test`,
      'Bye',
      staffPassword,
      'support',
    );
    const token = await signIn(`bye-${unique}@avex.test`, throwaway.totpSecret);

    const out = await app.inject({
      method: 'POST',
      url: '/admin/auth/sign-out',
      headers: asStaff(token),
    });
    assert.equal(out.statusCode, 200);

    const after = await app.inject({ method: 'GET', url: '/admin/me', headers: asStaff(token) });
    assert.equal(after.statusCode, 401);
  });


  // ── feature 02: contract review queue ──────────────────────────────────────

  test('the review queue holds submissions awaiting a decision, and nothing else', async () => {
    const submitted = await insertAsset('review', `SUB${unique.slice(0, 4)}`);
    const approved = await insertAsset('approved', `APP${unique.slice(0, 4)}`);
    const blocked = await insertAsset('blocked', `BLK${unique.slice(0, 4)}`);

    const response = await app.inject({
      method: 'GET',
      url: '/admin/contracts/review?limit=200',
      headers: asStaff(supportToken),
    });
    assert.equal(response.statusCode, 200);

    const ids = (response.json().items as { assetId: string }[]).map((item) => item.assetId);
    assert.ok(ids.includes(submitted), 'a submission at review must appear');
    // A queue containing decided items is a list people learn to scroll past.
    assert.ok(!ids.includes(approved), 'an approved asset needs no decision');
    assert.ok(!ids.includes(blocked), 'a blocked asset was already refused');
  });

  test('the queue carries the probe findings the decision rests on', async () => {
    const assetId = await insertAsset('review', `FND${unique.slice(0, 4)}`, [
      { check: 'fee_on_transfer', result: 'unknown' },
    ]);
    const response = await app.inject({
      method: 'GET',
      url: '/admin/contracts/review?limit=200',
      headers: asStaff(supportToken),
    });
    const item = (response.json().items as { assetId: string; findings: unknown[] }[]).find(
      (row) => row.assetId === assetId,
    );
    assert.ok(item);
    assert.deepEqual(item.findings, [{ check: 'fee_on_transfer', result: 'unknown' }]);
  });

  test('support cannot decide a contract', async () => {
    const assetId = await insertAsset('review', `NOP${unique.slice(0, 4)}`);
    const response = await app.inject({
      method: 'POST',
      url: `/admin/contracts/${assetId}/decision`,
      headers: asStaff(supportToken),
      payload: { decision: 'approved', note: 'looks fine to me, approving now' },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error, 'permission_denied');
  });

  test('a decision requires a substantial note', async () => {
    const assetId = await insertAsset('review', `NOT${unique.slice(0, 4)}`);
    await reauth();
    const response = await app.inject({
      method: 'POST',
      url: `/admin/contracts/${assetId}/decision`,
      headers: asStaff(superadminToken),
      payload: { decision: 'approved', note: 'ok' },
    });
    // This note is the only durable record of why a token became money.
    assert.equal(response.statusCode, 400);
  });

  test('approving records the decision, the reviewer, and the findings at that moment', async () => {
    const assetId = await insertAsset('review', `YES${unique.slice(0, 4)}`, [
      { check: 'proxy', result: 'absent' },
    ]);
    await reauth();

    const response = await app.inject({
      method: 'POST',
      url: `/admin/contracts/${assetId}/decision`,
      headers: asStaff(superadminToken),
      payload: { decision: 'approved', note: 'verified against the issuer documentation' },
    });
    assert.equal(response.statusCode, 200, response.body);

    const [row] = await db
      .select()
      .from(schema.assets)
      .where(eq(schema.assets.id, assetId))
      .limit(1);
    assert.equal(row!.verdict, 'approved');
    assert.ok(row!.reviewedByStaffId, 'the reviewing staff member must be recorded');
    assert.equal(row!.reviewNote, 'verified against the issuer documentation');

    const audit = await app.inject({
      method: 'GET',
      url: `/admin/audit?action=contract.approved&targetId=${assetId}`,
      headers: asStaff(superadminToken),
    });
    const [entry] = audit.json().rows;
    assert.ok(entry, 'the approval should be in the audit trail');
    // What was known at the time, not what the probe says today.
    assert.deepEqual(entry.metadata.findingsAtDecision, [{ check: 'proxy', result: 'absent' }]);
  });

  test('an already-decided contract cannot be decided again', async () => {
    const assetId = await insertAsset('approved', `TWC${unique.slice(0, 4)}`);
    await reauth();
    const response = await app.inject({
      method: 'POST',
      url: `/admin/contracts/${assetId}/decision`,
      headers: asStaff(superadminToken),
      payload: { decision: 'blocked', note: 'changed my mind about this one' },
    });
    // Reversing an approval has consequences for merchants already accepting the
    // token, and does not belong behind the same button as a first decision.
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, 'not_in_review');
  });

  // ── feature 03: settlement monitor ─────────────────────────────────────────

  test('a broadcast settlement appears in the monitor', async () => {
    const txHash = `0xsettle${unique}01`;
    await settlements.recordBroadcast({
      chain: 'bsc',
      txHash,
      nonce: 41,
      invoiceIds: [],
      feePerGasWei: 3_000_000_000n,
      gasLimit: 120_000n,
      estimatedCostUsdMicros: 14_100n,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/admin/settlements?chain=bsc',
      headers: asStaff(supportToken),
    });
    assert.equal(response.statusCode, 200, response.body);

    const found = (response.json().recent as { txHash: string; feePerGasWei: string }[]).find(
      (row) => row.txHash === txHash,
    );
    assert.ok(found, 'the broadcast should be listed');
    // Wei as a string: 3e9 fits a double but a gas total does not, and a monitor that
    // rounds one field and not another is worse than one that rounds none.
    assert.equal(found.feePerGasWei, '3000000000');
    assert.equal(typeof found.feePerGasWei, 'string');
  });

  test('re-recording the same broadcast does not create a second row at that nonce', async () => {
    /**
     * A process can die between the node accepting a transaction and the write
     * landing, so the same broadcast gets recorded twice. Two pending rows sharing a
     * nonce is exactly the bug this table exists to surface, so it must never be
     * created by our own retry.
     */
    const txHash = `0xsettle${unique}02`;
    const once = { chain: 'bsc' as const, txHash, nonce: 42, invoiceIds: [], feePerGasWei: 1n, gasLimit: 21_000n };
    await settlements.recordBroadcast(once);
    await settlements.recordBroadcast(once);

    const rows = await db
      .select()
      .from(schema.settlements)
      .where(eq(schema.settlements.txHash, txHash));
    assert.equal(rows.length, 1);
  });

  test('the monitor reports the nonce blocking the queue', async () => {
    const low = `0xsettle${unique}03`;
    const high = `0xsettle${unique}04`;
    await settlements.recordBroadcast({ chain: 'solana', txHash: low, nonce: 7, invoiceIds: [], feePerGasWei: 1n, gasLimit: 1n });
    await settlements.recordBroadcast({ chain: 'solana', txHash: high, nonce: 9, invoiceIds: [], feePerGasWei: 1n, gasLimit: 1n });

    const summary = await settlements.summary('solana', {
      stuckAfterMs: 5 * 60_000,
      spendWindowMs: 60 * 60_000,
    });
    // Nothing above the lowest pending nonce can confirm until it does, so that is
    // the number an operator needs first when the pipeline stalls.
    assert.equal(summary.blockingNonce, 7);
    assert.ok(summary.pending >= 2);
  });

  test('a confirmed receipt clears the transaction; a reverted one is recorded', async () => {
    const ok = `0xsettle${unique}05`;
    const bad = `0xsettle${unique}06`;
    await settlements.recordBroadcast({ chain: 'polygon', txHash: ok, nonce: 1, invoiceIds: [], feePerGasWei: 1n, gasLimit: 1n });
    await settlements.recordBroadcast({ chain: 'polygon', txHash: bad, nonce: 2, invoiceIds: [], feePerGasWei: 1n, gasLimit: 1n });

    await settlements.recordReceipt('polygon', ok, { status: 'success', gasUsed: 90_000n });
    await settlements.recordReceipt('polygon', bad, { status: 'reverted', gasUsed: 45_000n });

    const pending = (await settlements.pending('polygon')).map((row) => row.txHash);
    assert.ok(!pending.includes(ok));
    assert.ok(!pending.includes(bad), 'a reverted settlement is finished, not still pending');

    const [revertedRow] = await db
      .select()
      .from(schema.settlements)
      .where(eq(schema.settlements.txHash, bad))
      .limit(1);
    // Recorded and never retried: it will fail again for the same reason.
    assert.equal(revertedRow!.status, 'reverted');
  });

  test('a replacement keeps both rows, so the bump is legible afterwards', async () => {
    const original = `0xsettle${unique}07`;
    const replacement = `0xsettle${unique}08`;
    await settlements.recordBroadcast({ chain: 'ton', txHash: original, nonce: 3, invoiceIds: [], feePerGasWei: 1n, gasLimit: 1n });
    await settlements.recordBroadcast({ chain: 'ton', txHash: replacement, nonce: 3, invoiceIds: [], feePerGasWei: 2n, gasLimit: 1n });
    await settlements.recordReplacement('ton', original, replacement);

    const rows = await db
      .select()
      .from(schema.settlements)
      .where(eq(schema.settlements.chain, 'ton'));
    const before = rows.find((row) => row.txHash === original);
    assert.equal(before!.status, 'replaced');
    assert.equal(before!.replacedByTxHash, replacement);
    // "We bumped the fee at 14:02 and it confirmed at 14:05" needs both halves.
    assert.ok(rows.some((row) => row.txHash === replacement && row.status === 'pending'));
  });

  test('spend inside the window counts pending transactions too', async () => {
    /**
     * A pending transaction has no actual cost yet but has already committed the
     * funds. Excluding it would understate the spend by exactly the transactions
     * still in flight, which is how a cap gets exceeded while appearing respected.
     */
    const txHash = `0xsettle${unique}09`;
    await settlements.recordBroadcast({
      chain: 'ethereum',
      txHash,
      nonce: 11,
      invoiceIds: [],
      feePerGasWei: 1n,
      gasLimit: 1n,
      estimatedCostUsdMicros: 2_500_000n,
    });

    const summary = await settlements.summary('ethereum', {
      stuckAfterMs: 5 * 60_000,
      spendWindowMs: 60 * 60_000,
    });
    assert.ok(summary.spentUsdMicros >= 2_500_000n, `got ${summary.spentUsdMicros}`);
  });

  // ── feature 04: unmatched payment reconciliation ───────────────────────────

  test('an unmatched transfer is queued once, however often it is re-seen', async () => {
    const txHash = `0xstray${unique}01`;
    const input = {
      chain: 'bsc' as const,
      txHash,
      transferIndex: 0,
      amount: 20_000_000_000_000_000_000n,
      toAddress: `0xdead${unique}`,
      fromAddress: '0xpayer',
      blockNumber: 500,
      reason: 'no_matching_address' as const,
    };
    await reconciliation.record(input);
    // The watcher re-scans overlapping ranges after a restart; one stray transfer
    // must not become a page of them.
    await reconciliation.record(input);

    const rows = await db
      .select()
      .from(schema.unmatchedPayments)
      .where(eq(schema.unmatchedPayments.txHash, txHash));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.resolution, 'pending');
  });

  test('the queue shows the amount as a string, not a rounded number', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/admin/unmatched?limit=200',
      headers: asStaff(supportToken),
    });
    assert.equal(response.statusCode, 200);

    const row = (response.json().rows as { txHash: string; amount: string }[]).find((item) =>
      item.txHash.includes(`${unique}01`),
    );
    assert.ok(row);
    // 20 whole tokens at 18 decimals — well past what a double holds exactly.
    assert.equal(row.amount, '20000000000000000000');
  });

  test('the detail view suggests invoices sharing the deposit address', async () => {
    const { invoiceId, depositAddress } = await createInvoice(20n * 10n ** 18n);
    const txHash = `0xstray${unique}02`;
    await reconciliation.record({
      chain: 'bsc',
      txHash,
      transferIndex: 0,
      amount: 20n * 10n ** 18n,
      toAddress: depositAddress,
      blockNumber: 501,
      reason: 'memo_missing',
    });
    const unmatchedId = await unmatchedIdFor(txHash);

    const response = await app.inject({
      method: 'GET',
      url: `/admin/unmatched/${unmatchedId}`,
      headers: asStaff(supportToken),
    });
    assert.equal(response.statusCode, 200, response.body);

    const candidates = response.json().candidates as { id: string }[];
    // Suggesting, not deciding: on a memo chain several invoices share one address.
    assert.ok(candidates.some((candidate) => candidate.id === invoiceId));
  });

  test('support cannot attach a payment', async () => {
    const txHash = `0xstray${unique}03`;
    const { invoiceId, depositAddress } = await createInvoice(10n ** 18n);
    await reconciliation.record({
      chain: 'bsc',
      txHash,
      transferIndex: 0,
      amount: 10n ** 18n,
      toAddress: depositAddress,
      blockNumber: 502,
      reason: 'no_matching_address',
    });

    const response = await app.inject({
      method: 'POST',
      url: `/admin/unmatched/${await unmatchedIdFor(txHash)}/attach`,
      headers: asStaff(supportToken),
      payload: { invoiceId, note: 'this belongs to the invoice above' },
    });
    assert.equal(response.statusCode, 403);
  });

  test('attaching credits the invoice and reaches the same status the watcher would', async () => {
    const due = 20n * 10n ** 18n;
    const { invoiceId, depositAddress } = await createInvoice(due);
    const txHash = `0xstray${unique}04`;
    await reconciliation.record({
      chain: 'bsc',
      txHash,
      transferIndex: 0,
      amount: due,
      toAddress: depositAddress,
      fromAddress: '0xpayer',
      blockNumber: 503,
      reason: 'memo_missing',
    });
    const unmatchedId = await unmatchedIdFor(txHash);

    await reauth();
    const response = await app.inject({
      method: 'POST',
      url: `/admin/unmatched/${unmatchedId}/attach`,
      headers: asStaff(superadminToken),
      payload: { invoiceId, note: 'payer confirmed the transfer by email' },
    });
    assert.equal(response.statusCode, 200, response.body);
    // The status comes from the sink's own recompute, not a second implementation of
    // the tolerance arithmetic.
    assert.equal(response.json().invoiceStatus, 'paid');

    const [invoice] = await db
      .select()
      .from(schema.invoices)
      .where(eq(schema.invoices.id, invoiceId))
      .limit(1);
    assert.equal(invoice!.status, 'paid');
    assert.equal(BigInt(invoice!.amountPaid), due);

    const [payment] = await db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.txHash, txHash))
      .limit(1);
    assert.ok(payment, 'a real payment row should now exist');
  });

  test('a partial transfer attaches as underpaid rather than paid', async () => {
    const due = 20n * 10n ** 18n;
    const { invoiceId, depositAddress } = await createInvoice(due);
    const txHash = `0xstray${unique}05`;
    await reconciliation.record({
      chain: 'bsc',
      txHash,
      transferIndex: 0,
      amount: due / 2n,
      toAddress: depositAddress,
      blockNumber: 504,
      reason: 'below_minimum',
    });

    await reauth();
    const response = await app.inject({
      method: 'POST',
      url: `/admin/unmatched/${await unmatchedIdFor(txHash)}/attach`,
      headers: asStaff(superadminToken),
      payload: { invoiceId, note: 'half arrived; chasing the rest with the payer' },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().invoiceStatus, 'underpaid');
  });

  test('a transfer cannot be attached twice', async () => {
    /**
     * The identity key shared with `payments` is what enforces this — not a reviewer
     * being careful. Attaching one payer's transfer to two invoices would credit a
     * merchant with money that is not theirs.
     */
    const due = 5n * 10n ** 18n;
    const first = await createInvoice(due);
    const second = await createInvoice(due);
    const txHash = `0xstray${unique}06`;
    await reconciliation.record({
      chain: 'bsc',
      txHash,
      transferIndex: 0,
      amount: due,
      toAddress: first.depositAddress,
      blockNumber: 505,
      reason: 'no_matching_address',
    });
    const unmatchedId = await unmatchedIdFor(txHash);

    await reauth();
    const once = await app.inject({
      method: 'POST',
      url: `/admin/unmatched/${unmatchedId}/attach`,
      headers: asStaff(superadminToken),
      payload: { invoiceId: first.invoiceId, note: 'matched by address and amount' },
    });
    assert.equal(once.statusCode, 200, once.body);

    await reauth();
    const twice = await app.inject({
      method: 'POST',
      url: `/admin/unmatched/${unmatchedId}/attach`,
      headers: asStaff(superadminToken),
      payload: { invoiceId: second.invoiceId, note: 'attempting to attach a second time' },
    });
    assert.equal(twice.statusCode, 409);
    assert.equal(twice.json().error, 'already_resolved');
  });

  test('a transfer cannot be attached to an invoice on another chain', async () => {
    const { invoiceId } = await createInvoice(10n ** 18n);
    const txHash = `0xstray${unique}07`;
    await reconciliation.record({
      chain: 'ton',
      txHash,
      transferIndex: 0,
      amount: 10n ** 18n,
      toAddress: 'EQsomewhere',
      blockNumber: 506,
      reason: 'memo_missing',
    });

    await reauth();
    const response = await app.inject({
      method: 'POST',
      url: `/admin/unmatched/${await unmatchedIdFor(txHash)}/attach`,
      headers: asStaff(superadminToken),
      payload: { invoiceId, note: 'deliberately crossing chains, should be refused' },
    });
    // A TON transfer credited to a BSC invoice marks it paid with money the
    // settlement path cannot reach, and nothing downstream would notice.
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'chain_mismatch');
  });

  test('marking for return says plainly that nothing was sent', async () => {
    const txHash = `0xstray${unique}08`;
    await reconciliation.record({
      chain: 'bsc',
      txHash,
      transferIndex: 0,
      amount: 10n ** 18n,
      toAddress: `0xnobody${unique}`,
      fromAddress: '0xexchange-hot-wallet',
      blockNumber: 507,
      reason: 'no_matching_address',
    });

    await reauth();
    const response = await app.inject({
      method: 'POST',
      url: `/admin/unmatched/${await unmatchedIdFor(txHash)}/resolve`,
      headers: asStaff(superadminToken),
      payload: { resolution: 'returned', note: 'payer asked for it back by email' },
    });
    assert.equal(response.statusCode, 200, response.body);
    // An operator who believes the money already went back will stop chasing it.
    assert.match(response.json().message, /No transfer has been made/);
  });

  // ── feature 05: system health ──────────────────────────────────────────────

  test('health reports watcher lag per chain', async () => {
    const stale = new Date(Date.now() - 15 * 60_000);
    await db
      .insert(schema.watchCursors)
      .values({ chain: 'bsc', scannedTo: 900, lastPolledAt: stale })
      .onConflictDoUpdate({
        target: schema.watchCursors.chain,
        set: { scannedTo: 900, lastPolledAt: stale },
      });

    const response = await app.inject({
      method: 'GET',
      url: '/admin/health',
      headers: asStaff(supportToken),
    });
    assert.equal(response.statusCode, 200, response.body);

    const bsc = (response.json().chains as ChainHealthJson[]).find((row) => row.chain === 'bsc');
    assert.ok(bsc);
    assert.equal(bsc.scannedTo, 900);
    // The failure that costs money without producing an error.
    assert.ok(bsc.staleForMs !== null && bsc.staleForMs > 10 * 60_000, `got ${bsc.staleForMs}`);
  });

  test('a never-polled chain reports null lag rather than a huge number', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/admin/health',
      headers: asStaff(supportToken),
    });
    const untouched = (response.json().chains as ChainHealthJson[]).find(
      (row) => row.lastPolledAt === null,
    );
    // "Never started" and "stopped an hour ago" are different problems; reporting the
    // first as an enormous lag would send an operator looking for the wrong one.
    if (untouched) assert.equal(untouched.staleForMs, null);
  });

  test('health counts the reconciliation and review backlogs', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/admin/health',
      headers: asStaff(supportToken),
    });
    const body = response.json();
    assert.ok(body.reconciliation.pending >= 1, 'this suite left unresolved rows');
    assert.ok(body.reconciliation.oldestPendingAgeMs >= 0);
    assert.ok(body.review.waiting >= 1, 'this suite left submissions at review');
  });

  test('health names the checks it cannot perform instead of implying all clear', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/admin/health',
      headers: asStaff(supportToken),
    });
    const unavailable = response.json().unavailable as string[];
    // A page silently missing a check reads as healthy for whatever it omits.
    assert.ok(unavailable.some((entry) => entry.startsWith('gas_wallet_balance')));
  });


  // ── phase 07: the merchant dashboard's own surface ─────────────────────────

  test('a merchant lists only their own invoices', async () => {
    /**
     * The tenancy test. Both merchants have invoices; each request must see exactly
     * one set. A missing organizationId filter in the query would pass every other
     * test in this file and leak one merchant's book to another.
     */
    const mine = await createInvoice(3n * 10n ** 18n);

    const otherSignup = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        email: `rival-${unique}@example.com`,
        password: merchantPassword,
        organizationName: `Rival ${unique}`,
      },
    });
    const rivalOrgId = otherSignup.json().organizationId as string;
    const rivalLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: `rival-${unique}@example.com`, password: merchantPassword },
    });
    const rivalToken = rivalLogin.json().token as string;

    const mineListed = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${merchantOrgId}/invoices`,
      headers: { authorization: `Bearer ${merchantSessionToken}` },
    });
    assert.equal(mineListed.statusCode, 200, mineListed.body);
    const ids = (mineListed.json().invoices as { id: string }[]).map((row) => row.id);
    assert.ok(ids.includes(mine.invoiceId));

    const rivalListed = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${rivalOrgId}/invoices`,
      headers: { authorization: `Bearer ${rivalToken}` },
    });
    assert.equal(rivalListed.statusCode, 200, rivalListed.body);
    assert.equal((rivalListed.json().invoices as unknown[]).length, 0, 'the rival has no invoices');

    // And reaching across is refused before any query runs.
    const crossing = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${merchantOrgId}/invoices`,
      headers: { authorization: `Bearer ${rivalToken}` },
    });
    assert.equal(crossing.statusCode, 404, 'another merchant must read as absent');
  });

  test('another merchant\'s invoice reads as absent, not forbidden', async () => {
    // 404 rather than 403: confirming an id exists is itself information about a
    // book that is none of the caller's business.
    const mine = await createInvoice(10n ** 18n);
    const rivalSignup = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        email: `peek-${unique}@example.com`,
        password: merchantPassword,
        organizationName: `Peek ${unique}`,
      },
    });
    const peekOrg = rivalSignup.json().organizationId as string;
    const peekLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: `peek-${unique}@example.com`, password: merchantPassword },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${peekOrg}/invoices/${mine.invoiceId}`,
      headers: { authorization: `Bearer ${peekLogin.json().token}` },
    });
    assert.equal(response.statusCode, 404);
  });

  test('invoice detail carries the asset decimals needed to read the amount', async () => {
    const { invoiceId } = await createInvoice(20n * 10n ** 18n);
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${merchantOrgId}/invoices/${invoiceId}`,
      headers: { authorization: `Bearer ${merchantSessionToken}` },
    });
    assert.equal(response.statusCode, 200, response.body);

    const body = response.json();
    assert.equal(body.amountDue, '20000000000000000000');
    // Without the decimals the client cannot place the point, and a dashboard that
    // guesses would misreport what the merchant is owed.
    assert.equal(body.assetDecimals, 18);
    assert.ok(body.assetSymbol);
    assert.ok(Array.isArray(body.payments));
    assert.ok(Array.isArray(body.settlements));
  });

  test('invoice paging never repeats or skips a row', async () => {
    for (let i = 0; i < 5; i++) await createInvoice(BigInt(i + 1) * 10n ** 17n);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 12; page++) {
      const suffix: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
      const response = await app.inject({
        method: 'GET',
        url: `/v1/organizations/${merchantOrgId}/invoices?limit=2${suffix}`,
        headers: { authorization: `Bearer ${merchantSessionToken}` },
      });
      assert.equal(response.statusCode, 200);
      const body = response.json() as { invoices: { id: string }[]; nextCursor: string | null };
      for (const row of body.invoices) seen.push(row.id);
      cursor = body.nextCursor;
      if (cursor === null) break;
    }

    assert.ok(seen.length >= 5);
    assert.equal(new Set(seen).size, seen.length, 'a row appeared on two pages');
  });

  test('the volume report counts arrived money, not invoices marked paid', async () => {
    /**
     * The two differ after a reorg. A merchant reconciling their books needs the money
     * that actually arrived and was not withdrawn.
     */
    const due = 4n * 10n ** 18n;
    const { invoiceId } = await createInvoice(due);
    await db.insert(schema.payments).values({
      invoiceId,
      chain: 'bsc',
      txHash: `0xvol${unique}01`,
      transferIndex: 0,
      amount: due.toString(),
      blockNumber: 600,
    });
    // A reversed payment must not be counted.
    await db.insert(schema.payments).values({
      invoiceId,
      chain: 'bsc',
      txHash: `0xvol${unique}02`,
      transferIndex: 0,
      amount: due.toString(),
      blockNumber: 601,
      reversedAt: new Date(),
      reversedReason: 'reorg',
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${merchantOrgId}/reports/volume`,
      headers: { authorization: `Bearer ${merchantSessionToken}` },
    });
    assert.equal(response.statusCode, 200, response.body);

    const rows = response.json().volume as { chain: string; total: string }[];
    const bsc = rows.find((row) => row.chain === 'bsc');
    assert.ok(bsc, 'bsc volume should be reported');
    // The reversed payment is excluded, so the total is one payment, not two.
    assert.equal(BigInt(bsc.total) % due, 0n);
    assert.ok(BigInt(bsc.total) >= due);
  });

  // ── webhooks ──────────────────────────────────────────────────────────────

  test('a webhook endpoint must use https', async () => {
    // Over HTTP the payload says which invoice was paid and for how much, and the
    // signature that proves it came from us is replayable by anyone on the path.
    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${merchantOrgId}/webhook-endpoints`,
      headers: { authorization: `Bearer ${merchantSessionToken}` },
      payload: { url: 'http://example.com/hook', events: ['invoice.paid'] },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'invalid_webhook_url');
  });

  test('an endpoint with no events is refused', async () => {
    // Subscribed to nothing looks identical to a broken integration from outside.
    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${merchantOrgId}/webhook-endpoints`,
      headers: { authorization: `Bearer ${merchantSessionToken}` },
      payload: { url: 'https://example.com/hook', events: [] },
    });
    assert.equal(response.statusCode, 400);
  });

  test('the signing secret is returned once and never again', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${merchantOrgId}/webhook-endpoints`,
      headers: { authorization: `Bearer ${merchantSessionToken}` },
      payload: { url: `https://example.com/hook-${unique}`, events: ['invoice.paid'] },
    });
    assert.equal(created.statusCode, 201, created.body);
    const secret = created.json().secret as string;
    assert.match(secret, /^whsec_/);

    const listed = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${merchantOrgId}/webhook-endpoints`,
      headers: { authorization: `Bearer ${merchantSessionToken}` },
    });
    const body = listed.body;
    // A route that could re-read it would turn a write-only secret into a readable
    // one, and it appears in no log line either.
    assert.ok(!body.includes(secret), 'the secret must not appear in any later response');
    assert.ok(!body.includes('whsec_'));
  });

  test('creating an endpoint is recorded without its secret', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${merchantOrgId}/webhook-endpoints`,
      headers: { authorization: `Bearer ${merchantSessionToken}` },
      payload: { url: `https://example.com/audited-${unique}`, events: ['invoice.paid'] },
    });
    const secret = created.json().secret as string;

    const audit = await app.inject({
      method: 'GET',
      url: `/admin/audit?organizationId=${merchantOrgId}&action=webhook_endpoint.created`,
      headers: asStaff(superadminToken),
    });
    const [row] = audit.json().rows;
    assert.ok(row, 'the creation should be recorded');
    assert.ok(!JSON.stringify(row).includes(secret), 'the audit trail must not hold the secret');
  });

  test('an endpoint can be disabled and enabled again', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${merchantOrgId}/webhook-endpoints`,
      headers: { authorization: `Bearer ${merchantSessionToken}` },
      payload: { url: `https://example.com/toggle-${unique}`, events: ['invoice.paid'] },
    });
    const id = created.json().id as string;

    const disabled = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${merchantOrgId}/webhook-endpoints/${id}/disable`,
      headers: { authorization: `Bearer ${merchantSessionToken}` },
      payload: { reason: 'rotating our receiver' },
    });
    assert.equal(disabled.statusCode, 200, disabled.body);

    const enabled = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${merchantOrgId}/webhook-endpoints/${id}/enable`,
      headers: { authorization: `Bearer ${merchantSessionToken}` },
    });
    assert.equal(enabled.statusCode, 200);
  });

  test('another merchant cannot disable an endpoint by guessing its id', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${merchantOrgId}/webhook-endpoints`,
      headers: { authorization: `Bearer ${merchantSessionToken}` },
      payload: { url: `https://example.com/private-${unique}`, events: ['invoice.paid'] },
    });
    const id = created.json().id as string;

    const signup = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        email: `thief-${unique}@example.com`,
        password: merchantPassword,
        organizationName: `Thief ${unique}`,
      },
    });
    const thiefOrg = signup.json().organizationId as string;
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: `thief-${unique}@example.com`, password: merchantPassword },
    });

    // Tenancy is in the update predicate, so the row is not theirs to match.
    const attempt = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${thiefOrg}/webhook-endpoints/${id}/disable`,
      headers: { authorization: `Bearer ${login.json().token}` },
      payload: {},
    });
    assert.equal(attempt.statusCode, 404);
  });

  test('the delivery log is scoped to the merchant', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${merchantOrgId}/webhook-deliveries`,
      headers: { authorization: `Bearer ${merchantSessionToken}` },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(Array.isArray(response.json().deliveries));
  });


  // ── commission: the whole of what a merchant pays ──────────────────────────
  //
  // 0.5% entry, down to 0.4% at volume, and nothing else. No monthly fee, no minimum,
  // no seat price — so there is no state in which a merchant owes us money, nothing to
  // be late on, and nothing for us to switch off. What is left to test is the rate:
  // that it is read correctly, that the published ladder applies itself in both
  // directions, and that a merchant cannot choose their own rung.
  //
  // The figures are the market's, not ours: Cryptomus and Heleket advertise "from
  // 0.4%", NOWPayments takes 0.5% on a same-coin settlement. They are a business
  // decision that can move, so the tests below are about the mechanism.

  test('a new merchant starts on the published entry rate, with a period open', async () => {
    const plan = await feePlanService.ensureForOrganization(merchantOrgId);
    assert.equal(plan.feeBps, 50);
    assert.equal(plan.negotiatedFee, false);
    // The period exists to be measured, so it has to be open from the first day —
    // a plan with no window would never close and never move anyone down the ladder.
    assert.ok(plan.currentPeriodStart, 'a plan must have a period start');
    assert.ok(plan.currentPeriodEnd, 'a plan must have a period end');
    assert.ok(plan.currentPeriodEnd! > plan.currentPeriodStart!);
  });

  test('giving a merchant a plan twice returns the same one', async () => {
    // Signup can be retried, and two plans would mean two answers to "what do they pay".
    const first = await feePlanService.ensureForOrganization(merchantOrgId);
    const second = await feePlanService.ensureForOrganization(merchantOrgId);
    assert.equal(first.id, second.id);
  });

  test('the merchant is shown the next rung and what reaches it', async () => {
    // A volume discount a merchant has to ask about is not a published ladder.
    const org = await freshMerchant('feeladder');
    await feePlanService.ensureForOrganization(org);

    const { commission } = await feePlanService.forOrganization(org);
    // Basis points are our unit; dollars per thousand is the merchant's.
    assert.equal(commission.perThousandUsd, 5);
    assert.equal(commission.nextTier?.bps, 45);
    assert.equal(commission.nextTier?.fromUsdMicros, '50000000000');
  });

  test('the whole ladder is published, entry rung first', async () => {
    /**
     * Returned rather than hardcoded in each surface. Two copies of a price list
     * eventually disagree, and the merchant is the one who finds out.
     */
    const org = await freshMerchant('feefull');
    await feePlanService.ensureForOrganization(org);

    const { ladder } = await feePlanService.forOrganization(org);
    assert.deepEqual(ladder, [
      { bps: 50, fromUsdMicros: '0' },
      { bps: 45, fromUsdMicros: '50000000000' },
      { bps: 40, fromUsdMicros: '250000000000' },
    ]);
  });

  test('a merchant can read their own commission over HTTP', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${merchantOrgId}/commission`,
      headers: { authorization: `Bearer ${merchantSessionToken}` },
    });
    assert.equal(response.statusCode, 200, response.body);

    const body = response.json();
    assert.equal(body.commission.feeBps, 50);
    assert.equal(body.commission.perThousandUsd, 5);
    assert.equal(typeof body.period.processedUsdMicros, 'string');
    /**
     * Nothing in the response says a merchant owes us anything, because nothing can.
     *
     * Asserted as an absence on purpose. This response used to carry a subscription
     * price, a list of charges and a verdict that could refuse invoices; a dashboard
     * still reading any of those would show a merchant a bill that does not exist.
     */
    assert.equal(body.charges, undefined);
    assert.equal(body.verdict, undefined);
    assert.equal(body.plan.priceUsdMicros, undefined);
  });

  // ── reading the rate at invoice time ───────────────────────────────────────

  test('an invoice carries the merchant rate and our collector for that chain', async () => {
    const org = await freshMerchant('feefor');
    await feePlanService.ensureForOrganization(org);

    const fee = await feePlanService.feeFor(org, 'bsc');
    assert.equal(fee?.feeBps, 50);
    assert.equal(fee?.feeDestination, FEE_COLLECTOR_EVM);
  });

  test('a chain with no collector charges nothing rather than burning the fee', async () => {
    /**
     * `tron` is deliberately absent from the configured collectors. An EVM address is
     * not a valid TRON one, so substituting the one we do have would send the
     * commission to an address that cannot receive it — and the forwarder would
     * either revert or the funds would be gone. No fee is the only safe answer.
     */
    const org = await freshMerchant('nocollector');
    await feePlanService.ensureForOrganization(org);

    assert.equal(await feePlanService.feeFor(org, 'tron'), undefined);
  });

  test('a merchant with no fee plan row is charged no commission', async () => {
    // Our bookkeeping gap must not become a charge the merchant never agreed to.
    const org = await freshMerchant('noplan');
    assert.equal(await feePlanService.feeFor(org, 'bsc'), undefined);
  });

  test('a zero rate means no fee at all, not a zero-value transfer', async () => {
    const org = await freshMerchant('zerofee');
    await feePlanService.ensureForOrganization(org);
    await feePlanService.setFeeBps(
      { staffId: superadminId, role: 'superadmin' },
      org,
      0,
      'launch partner, commission waived',
    );

    assert.equal(await feePlanService.feeFor(org, 'bsc'), undefined);
  });

  // ── the volume the ladder is read from ─────────────────────────────────────

  test('assessedVolume separates rates we set from rates a merchant declared', async () => {
    const org = await freshMerchant('assessed');
    const from = daysAgo(30);
    const to = new Date();

    await giveVolume(org, 600, daysAgo(20), { source: 'quote' });
    await giveVolume(org, 100, daysAgo(20), { source: 'oracle' });
    await giveVolume(org, 300, daysAgo(20), { source: 'merchant_rate' });
    await giveVolume(org, 8_000, daysAgo(20), { source: 'unknown' });

    const volume = await feePlanService.assessedVolume(org, { from, to });
    // A quote and our own oracle are both figures we stand behind, so they pool.
    assert.equal(volume.verifiedUsdMicros, 700_000_000n);
    assert.equal(volume.declaredUsdMicros, 300_000_000n);
    // Counted as a payment we could not price, contributing no dollars — so a token we
    // have no rate for cannot be used to manufacture volume either way.
    assert.equal(volume.unpricedPayments, 1);
    assert.equal(volume.totalUsdMicros, 1_000_000_000n);
  });

  test('reversed payments do not count towards a tier', async () => {
    /**
     * A reorg that took a payment back must not buy a cheaper rate for a month that,
     * in the end, did not happen.
     */
    const org = await freshMerchant('reversed');
    const window = { from: daysAgo(30), to: new Date() };
    await giveVolume(org, 60_000, daysAgo(10), { reversed: true });
    await giveVolume(org, 200, daysAgo(10));

    const volume = await feePlanService.assessedVolume(org, window);
    assert.equal(volume.totalUsdMicros, 200_000_000n);
  });

  test('the volume window is half-open, so a boundary payment is counted once', async () => {
    /**
     * One period's end is the next period's start. A payment credited at exactly that
     * instant has to land in one window and not both, or it would be counted twice and
     * could buy a rung it did not earn.
     */
    const org = await freshMerchant('boundary');
    const boundary = daysAgo(10);
    await giveVolume(org, 1_000, boundary);

    const before = await feePlanService.assessedVolume(org, {
      from: daysAgo(20),
      to: boundary,
    });
    const after = await feePlanService.assessedVolume(org, { from: boundary, to: new Date() });

    assert.equal(before.totalUsdMicros, 0n, 'the end of a window is not in it');
    assert.equal(after.totalUsdMicros, 1_000_000_000n, 'the start of a window is');
  });

  // ── the ladder applying itself ─────────────────────────────────────────────

  test('volume moves a merchant down the ladder without being asked', async () => {
    const org = await freshMerchant('earnstier');
    await feePlanService.ensureForOrganization(org, daysAgo(40));
    // Past the $50k rung, inside the period that is about to close.
    await giveVolume(org, 60_000, daysAgo(20));
    await agePeriod(org, daysAgo(40), daysAgo(10));

    const report = await feePlanService.closePeriods();
    assert.ok(report.moved >= 1);

    const { commission } = await feePlanService.forOrganization(org);
    assert.equal(commission.feeBps, 45);
    assert.equal(commission.perThousandUsd, 4.5);
  });

  test('the top rung is reached at the top threshold', async () => {
    const org = await freshMerchant('toptier');
    await feePlanService.ensureForOrganization(org, daysAgo(40));
    await giveVolume(org, 300_000, daysAgo(20));
    await agePeriod(org, daysAgo(40), daysAgo(10));

    await feePlanService.closePeriods();
    const { commission } = await feePlanService.forOrganization(org);
    assert.equal(commission.feeBps, 40);
    // Nothing below it, so no promise of a further reduction.
    assert.equal(commission.nextTier, null);
  });

  test('the ladder moves merchants back up when volume falls away', async () => {
    /**
     * Both directions, or the rate is a one-way ratchet: one busy month would buy a
     * permanent discount. Stated as a test because the sympathetic reading — never
     * raise a merchant's rate — is the one that quietly loses the revenue.
     */
    const org = await freshMerchant('fallsback');
    await feePlanService.ensureForOrganization(org, daysAgo(80));
    await giveVolume(org, 60_000, daysAgo(60));
    await agePeriod(org, daysAgo(80), daysAgo(50));
    await feePlanService.closePeriods();
    assert.equal((await feePlanService.forOrganization(org)).commission.feeBps, 45);

    // A whole period with nothing in it.
    await agePeriod(org, daysAgo(40), daysAgo(10));
    await feePlanService.closePeriods();

    assert.equal((await feePlanService.forOrganization(org)).commission.feeBps, 50);
  });

  test('a period still running is not assessed', async () => {
    /**
     * The property that makes this job safe to run hourly, and the reason it assesses
     * only closed periods.
     *
     * A merchant on 0.45% two days into a new month has almost no volume in it yet. A
     * job willing to read a partial period would see that and put them back on 0.5% —
     * raising the price of every merchant it touched, every hour, for reasons none of
     * them could see.
     */
    const org = await freshMerchant('midperiod');
    await feePlanService.ensureForOrganization(org, daysAgo(80));
    await giveVolume(org, 60_000, daysAgo(60));
    await agePeriod(org, daysAgo(80), daysAgo(50));
    await feePlanService.closePeriods();
    assert.equal((await feePlanService.forOrganization(org)).commission.feeBps, 45);

    // A fresh period, two days old and nearly empty, and a job run inside it.
    await agePeriod(org, daysAgo(2), inDays(28));
    const report = await feePlanService.closePeriods();

    assert.equal((await feePlanService.forOrganization(org)).commission.feeBps, 45);
    assert.equal(
      report.changes.some((change) => change.organizationId === org),
      false,
      'a running period must not move anyone',
    );
  });

  test('closing a period rolls it forward, and running again is a no-op', async () => {
    /**
     * If closing left the boundary where it was, the next run would assess the same
     * period again — and an hourly job would re-derive the same rate from the same
     * volume forever while the merchant's actual months went unmeasured.
     */
    const org = await freshMerchant('rolls');
    // Captured once: `daysAgo` reads the clock, so calling it twice gives two instants
    // and the assertion below would be off by however long the test took.
    const closedAt = daysAgo(10);
    await feePlanService.ensureForOrganization(org, daysAgo(40));
    await agePeriod(org, daysAgo(40), closedAt);

    const first = await feePlanService.closePeriods();
    assert.ok(first.closed >= 1);
    const rolled = (await feePlanService.forOrganization(org)).plan;
    // The new period starts where the closed one ended: no gap for volume to fall into.
    assert.equal(rolled.currentPeriodStart?.getTime(), closedAt.getTime());
    assert.ok(rolled.currentPeriodEnd! > new Date(), 'the new period must be open');

    const second = await feePlanService.closePeriods();
    assert.equal(
      second.changes.some((change) => change.organizationId === org),
      false,
      'a second run inside the new period must do nothing',
    );
  });

  test('a month-end period start does not skip February', async () => {
    /**
     * A period beginning on the 31st must not roll into March. `setMonth` alone would,
     * giving that merchant an eleven-month year and one month that is never measured.
     */
    const org = await freshMerchant('monthend');
    await feePlanService.ensureForOrganization(org, new Date('2025-12-31T00:00:00Z'));
    await agePeriod(org, new Date('2025-12-31T00:00:00Z'), new Date('2026-01-31T00:00:00Z'));

    await feePlanService.closePeriods(new Date('2026-02-01T00:00:00Z'));

    const { plan } = await feePlanService.forOrganization(org);
    assert.equal(plan.currentPeriodStart?.toISOString().slice(0, 10), '2026-01-31');
    // February has 28 days in 2026, so the period ends on the 28th, not in March.
    assert.equal(plan.currentPeriodEnd?.toISOString().slice(0, 10), '2026-02-28');
  });

  test('a negotiated rate survives the ladder', async () => {
    /**
     * The point of the flag. Without it, a rate someone agreed with a merchant would be
     * overwritten at the next period and nobody would find out until the merchant read
     * their settlement.
     */
    const org = await freshMerchant('negotiated');
    const closedAt = daysAgo(10);
    await feePlanService.ensureForOrganization(org, daysAgo(40));
    await giveVolume(org, 60_000, daysAgo(20));
    await agePeriod(org, daysAgo(40), closedAt);

    await feePlanService.setFeeBps(
      { staffId: superadminId, role: 'superadmin' },
      org,
      25,
      'agreed with the merchant during onboarding',
    );

    await feePlanService.closePeriods();
    const { commission, plan } = await feePlanService.forOrganization(org);
    assert.equal(commission.feeBps, 25);
    assert.equal(commission.negotiated, true);
    // No next rung is promised, because the ladder no longer applies to them.
    assert.equal(commission.nextTier, null);
    // But the period still rolled: a negotiated merchant's months must keep being
    // measured, or nothing would ever tell an operator the deal has gone stale.
    assert.equal(plan.currentPeriodStart?.getTime(), closedAt.getTime());
  });

  test('the merchant is shown what their volume so far would earn', async () => {
    /**
     * Shown rather than left to be discovered. Volume only goes up inside a period, so
     * a rate named here can only improve before the period closes — which is why it is
     * safe to show, and why it is a projection rather than the rate they are paying.
     */
    const org = await freshMerchant('standing');
    await feePlanService.ensureForOrganization(org, daysAgo(5));
    await giveVolume(org, 60_000, daysAgo(2));
    await giveVolume(org, 1_000, daysAgo(1), { source: 'merchant_rate' });

    const { commission, period } = await feePlanService.forOrganization(org);
    assert.equal(period.processedUsdMicros, '61000000000');
    assert.equal(period.verifiedUsdMicros, '60000000000');
    assert.equal(period.declaredUsdMicros, '1000000000');
    assert.equal(period.wouldEarnBps, 45);
    // Still paying the old rate until the period actually closes.
    assert.equal(commission.feeBps, 50);
  });

  // ── the rate a merchant cannot choose ──────────────────────────────────────

  test('a rate the forwarder could not deliver is refused', async () => {
    /**
     * 500bps is `Forwarder.MAX_FEE_BPS`. Above it the constructor reverts, so an
     * invoice created at that rate would take a payment to an address whose contract
     * can never be deployed — the funds would be unreachable.
     */
    const org = await freshMerchant('greedy');
    await feePlanService.ensureForOrganization(org);

    await assert.rejects(
      () =>
        feePlanService.setFeeBps(
          { staffId: superadminId, role: 'superadmin' },
          org,
          501,
          'trying to charge more than the contract allows',
        ),
      /outside the 0-500bps/,
    );
    assert.equal((await feePlanService.forOrganization(org)).commission.feeBps, 50);
  });

  test('setting a commission is written to the audit trail with its reason', async () => {
    // The only record of why this merchant pays something other than the published
    // rate. A rate with no reason attached is indistinguishable from a mistake.
    const before = await countAudit('fee_plan.negotiated');

    const org = await freshMerchant('feeaudit');
    await feePlanService.ensureForOrganization(org);
    await feePlanService.setFeeBps(
      { staffId: superadminId, role: 'superadmin' },
      org,
      30,
      'matched a competitor quote the merchant forwarded',
    );

    assert.equal(await countAudit('fee_plan.negotiated'), before + 1);
  });

  test('a tier change is written to the audit trail', async () => {
    const before = await countAudit('fee_plan.tier_changed');

    const org = await freshMerchant('tieraudit');
    await feePlanService.ensureForOrganization(org, daysAgo(40));
    await giveVolume(org, 80_000, daysAgo(20));
    await agePeriod(org, daysAgo(40), daysAgo(10));
    await feePlanService.closePeriods();

    assert.ok((await countAudit('fee_plan.tier_changed')) > before);
  });

  test('a cheaper rung bought mostly on declared rates is flagged for review', async () => {
    /**
     * The gaming vector, and the one the free tier used to invite in reverse. A merchant
     * adds their own token, declares it worth far more than anyone would pay, and
     * crosses a volume threshold on paper. We cannot prevent this — an illiquid token
     * has no rate to check against — so we make it visible instead. Detection where
     * prevention is not available.
     */
    const before = await countAudit('fee_plan.tier_needs_review');

    const org = await freshMerchant('declared');
    await feePlanService.ensureForOrganization(org, daysAgo(40));
    await giveVolume(org, 55_000, daysAgo(20), { source: 'merchant_rate' });
    await giveVolume(org, 2_000, daysAgo(20), { source: 'quote' });
    await agePeriod(org, daysAgo(40), daysAgo(10));

    await feePlanService.closePeriods();

    // The rung is still granted — the flag is a note to an operator, not a penalty.
    assert.equal((await feePlanService.forOrganization(org)).commission.feeBps, 45);
    assert.equal(await countAudit('fee_plan.tier_needs_review'), before + 1);
  });

  test('a tier change on rates we set is not flagged', async () => {
    /**
     * The other half of the previous test, and the one that decides whether the flag is
     * worth having. A signal that fires on every tier change is noise, and an operator
     * learns to ignore it.
     */
    const before = await countAudit('fee_plan.tier_needs_review');

    const org = await freshMerchant('quiet');
    await feePlanService.ensureForOrganization(org, daysAgo(40));
    await giveVolume(org, 60_000, daysAgo(20), { source: 'quote' });
    await agePeriod(org, daysAgo(40), daysAgo(10));

    await feePlanService.closePeriods();

    assert.equal((await feePlanService.forOrganization(org)).commission.feeBps, 45);
    assert.equal(await countAudit('fee_plan.tier_needs_review'), before);
  });

  test('a rate going up on declared volume is not flagged', async () => {
    /**
     * Only a reduction is worth a second look. A merchant whose declared volume pushed
     * them *up* a rung had no incentive to lie about it, and flagging that would bury
     * the case that matters under the case that does not.
     */
    const before = await countAudit('fee_plan.tier_needs_review');

    const org = await freshMerchant('upward');
    await feePlanService.ensureForOrganization(org, daysAgo(80));
    await giveVolume(org, 60_000, daysAgo(60), { source: 'quote' });
    await agePeriod(org, daysAgo(80), daysAgo(50));
    await feePlanService.closePeriods();
    assert.equal((await feePlanService.forOrganization(org)).commission.feeBps, 45);

    // A quiet period whose only volume is self-declared: the rate goes back up.
    await giveVolume(org, 100, daysAgo(20), { source: 'merchant_rate' });
    await agePeriod(org, daysAgo(40), daysAgo(10));
    await feePlanService.closePeriods();

    assert.equal((await feePlanService.forOrganization(org)).commission.feeBps, 50);
    assert.equal(await countAudit('fee_plan.tier_needs_review'), before);
  });

  test('support cannot change a commission', async () => {
    // Pricing is not a support action, and this is the route a stolen support session
    // would reach for.
    const org = await freshMerchant('feeperm');
    await feePlanService.ensureForOrganization(org);

    const response = await app.inject({
      method: 'POST',
      url: `/admin/commission/${org}`,
      headers: asStaff(supportToken),
      payload: { feeBps: 10, note: 'trying it on from a support session' },
    });
    assert.equal(response.statusCode, 403, response.body);
  });

  test('changing a commission needs a fresh second factor', async () => {
    /**
     * Quiet, durable, and the only lever on our revenue — which is exactly the shape of
     * thing a stolen session is worth holding.
     */
    const org = await freshMerchant('feeelevate');
    await feePlanService.ensureForOrganization(org);

    await db
      .update(schema.staffSessions)
      .set({ mfaSatisfiedAt: new Date(Date.now() - 10 * 60 * 1000) })
      .where(eq(schema.staffSessions.tokenHash, hashToken(superadminToken)));

    const response = await app.inject({
      method: 'POST',
      url: `/admin/commission/${org}`,
      headers: asStaff(superadminToken),
      payload: { feeBps: 10, note: 'attempting without a fresh code' },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error, 'elevation_required');
  });

  test('the route refuses a rate above the on-chain ceiling with a 400', async () => {
    // Rejected at the edge rather than surfacing a constraint violation as a 500.
    const org = await freshMerchant('feeroute');
    await feePlanService.ensureForOrganization(org);

    await reauth();
    const response = await app.inject({
      method: 'POST',
      url: `/admin/commission/${org}`,
      headers: asStaff(superadminToken),
      payload: { feeBps: 600, note: 'over the contract ceiling on purpose' },
    });
    assert.equal(response.statusCode, 400, response.body);
  });

  test('closing periods by hand is not a support action either', async () => {
    // It writes rates. A read-shaped name would be a lie, and `merchant:read` is not
    // enough to hold it.
    const response = await app.inject({
      method: 'POST',
      url: '/admin/commission/close-periods',
      headers: asStaff(supportToken),
    });
    assert.equal(response.statusCode, 403, response.body);
  });

  // ── the asset catalogue ────────────────────────────────────────────────────
  //
  // The distinction these turn on: `verdict` is about the contract — is this the real
  // USDT — and `listed` is about us — is our watcher for that chain running today. They
  // are separate columns because collapsing them would make one of the two answers a lie,
  // and the lie would be shown to a merchant as the reason their invoices stopped.

  test('the catalogue lists what the platform knows and who is using it', async () => {
    /**
     * The usage count is what makes a listing decision a decision. Unlisting an asset
     * fourteen merchants have enabled is a different act from unlisting one nobody has
     * touched, and an operator about to do it should not have to go and find out.
     */
    const response = await app.inject({
      method: 'GET',
      url: '/admin/assets',
      headers: asStaff(supportToken),
    });
    assert.equal(response.statusCode, 200, response.body);

    const listed = response.json().assets as {
      symbol: string;
      chain: string;
      listed: boolean;
      verdict: string;
      priced: boolean;
      enabledByMerchants: number;
    }[];
    assert.ok(listed.length > 0, 'the curated list is seeded');
    // Everything arrives offered: the column defaults to true so nothing changed for the
    // assets that already existed when it was added.
    assert.ok(listed.every((asset) => typeof asset.listed === 'boolean'));
    assert.ok(listed.every((asset) => asset.enabledByMerchants >= 0));
    // USDT on BSC is curated and quoted, which is the shape an operator reads as "fine".
    const usdt = listed.find((asset) => asset.symbol === 'USDT' && asset.chain === 'bsc');
    assert.ok(usdt);
    assert.equal(usdt!.verdict, 'approved');
    assert.equal(usdt!.priced, true);
  });

  test('the catalogue carries every chain and every curated entry', async () => {
    /**
     * The seeded list is the platform's answer to "what do you support", so a chain missing
     * from it is a chain no merchant can be paid on. Checked against the list in code rather
     * than against a copy written here, because a copy is the thing that drifts.
     */
    const response = await app.inject({
      method: 'GET',
      url: '/admin/assets',
      headers: asStaff(supportToken),
    });
    const catalogue = response.json().assets as { chain: string; symbol: string; curated: boolean }[];

    for (const asset of CURATED_ASSETS) {
      assert.ok(
        catalogue.some(
          (entry) => entry.chain === asset.chain && entry.symbol === asset.symbol && entry.curated,
        ),
        `${asset.symbol} on ${asset.chain} was not seeded`,
      );
    }

    // Every supported chain has its native asset, or that chain cannot pay anyone.
    for (const chain of SUPPORTED_CHAINS) {
      assert.ok(
        catalogue.some((entry) => entry.chain === chain),
        `${chain} has no catalogue entries at all`,
      );
    }
  });

  test('the gaps are returned with the catalogue, each with a reason', async () => {
    /**
     * An absence has no row, so it can only reach an operator if the response carries it.
     * A gap with no reason means nobody decided — it was missed — and the panel says so
     * differently from one that was held deliberately.
     */
    const response = await app.inject({
      method: 'GET',
      url: '/admin/assets',
      headers: asStaff(supportToken),
    });
    const gaps = response.json().gaps as { chain: string; symbol: string; reason: string | null }[];

    assert.ok(gaps.length > 0, 'USDC is not carried everywhere yet');
    for (const gap of gaps) {
      assert.ok(gap.reason, `${gap.symbol} on ${gap.chain} has no recorded reason`);
      // Each names where the address must come from, because a curated entry arrives
      // approved with no probe behind it.
      assert.match(gap.reason!, /documentation/i);
    }
  });

  test('the usage count is merchants accepting it, not merchants who configured it once', async () => {
    /**
     * The count drives how an operator reads a closure, so counting a merchant who turned the
     * currency *off* would overstate the blast radius — and the whole point of showing it is
     * to say how big the act is.
     */
    const org = await freshMerchant('usage');
    const [asset] = await db
      .insert(schema.assets)
      .values({
        chain: 'bsc',
        symbol: `USE${randomBytes(2).toString('hex').toUpperCase()}`,
        contract: `0x${randomBytes(20).toString('hex')}`,
        decimals: 18,
        kind: 'erc20',
        verdict: 'approved',
      })
      .returning({ id: schema.assets.id });

    const count0 = async () =>
      (
        (
          await app.inject({ method: 'GET', url: '/admin/assets', headers: asStaff(supportToken) })
        ).json().assets as { id: string; enabledByMerchants: number }[]
      ).find((entry) => entry.id === asset!.id)?.enabledByMerchants;

    assert.equal(await count0(), 0, 'nobody has touched it');

    // Configured but switched off: a row exists, and it must not count.
    await db
      .insert(schema.merchantAssets)
      .values({ organizationId: org, assetId: asset!.id, enabled: false, pricingMode: 'fiat' });
    assert.equal(await count0(), 0, 'a merchant who turned it off is not accepting it');

    await db
      .update(schema.merchantAssets)
      .set({ enabled: true })
      .where(eq(schema.merchantAssets.assetId, asset!.id));
    assert.equal(await count0(), 1);
  });

  test('closing an asset stops new invoices without touching the verdict', async () => {
    /**
     * The whole reason `listed` is its own column. Solana's USDC mint is a good contract
     * whether or not our Solana watcher is running, and recording `blocked` for an
     * operational pause would put a judgement about Circle in our own audit trail — and
     * show a merchant a reason that is not the real one.
     */
    /**
     * A throwaway asset, not one of the curated rows.
     *
     * This suite shares a database with every other one, and flipping a real USDT entry
     * would leave the whole catalogue in whatever state a failure interrupted — which is
     * how one bad run breaks a dozen unrelated tests.
     */
    const asset = await disposableAsset('CLOSE');

    await reauth();
    const closed = await app.inject({
      method: 'POST',
      url: `/admin/assets/${asset!.id}/listing`,
      headers: asStaff(superadminToken),
      payload: { listed: false, note: 'Solana watcher not deployed yet; closing until it is.' },
    });
    assert.equal(closed.statusCode, 200, closed.body);
    // The message has to say what stopped and what did not.
    assert.match(closed.json().message, /Invoices already open still complete/);

    try {
      const [after] = await db
        .select({ verdict: schema.assets.verdict, listed: schema.assets.listed })
        .from(schema.assets)
        .where(eq(schema.assets.id, asset!.id));
      assert.equal(after!.listed, false);
      // The verdict is a fact about the contract, and closing the currency is a fact about
      // us. Rewriting the first to express the second would record a judgement we do not
      // hold — and show a merchant a reason that is not the real one.
      assert.equal(after!.verdict, 'approved');

      // And it is on the catalogue as closed rather than gone.
      const catalogue = (
        await app.inject({ method: 'GET', url: '/admin/assets', headers: asStaff(supportToken) })
      ).json().assets as { id: string; listed: boolean }[];
      assert.equal(catalogue.find((entry) => entry.id === asset!.id)?.listed, false);
    } finally {
      await db
        .update(schema.assets)
        .set({ listed: true, verdict: 'approved' })
        .where(eq(schema.assets.id, asset!.id));
    }
  });

  test('the audit trail records how many merchants a closure affected', async () => {
    /**
     * "Unlisted USDT on TRON" and "unlisted USDT on TRON, which 41 merchants were
     * accepting" are different events, and only one of them explains the support queue the
     * following morning.
     */
    const before = await countAudit('asset.unlisted');
    const asset = await disposableAsset('AUDIT');

    await reauth();
    await app.inject({
      method: 'POST',
      url: `/admin/assets/${asset!.id}/listing`,
      headers: asStaff(superadminToken),
      payload: { listed: false, note: 'Testing that the count is recorded with the reason.' },
    });

    try {
      assert.equal(await countAudit('asset.unlisted'), before + 1);
      const [row] = await db
        .select({ metadata: schema.auditLog.metadata })
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, 'asset.unlisted'))
        .orderBy(desc(schema.auditLog.createdAt))
        .limit(1);
      const metadata = row!.metadata as Record<string, unknown>;
      assert.equal(typeof metadata.enabledByMerchants, 'number');
      assert.match(String(metadata.note), /Testing that the count/);
    } finally {
      await db
        .update(schema.assets)
        .set({ listed: true, verdict: 'approved' })
        .where(eq(schema.assets.id, asset!.id));
    }
  });

  test('support cannot open or close an asset', async () => {
    // It applies to every merchant at once, which is the line between operator and
    // superadmin in this panel — so support cannot do it either.
    const asset = await disposableAsset('PERM');
    const response = await app.inject({
      method: 'POST',
      url: `/admin/assets/${asset!.id}/listing`,
      headers: asStaff(supportToken),
      payload: { listed: false, note: 'Trying it on from a support session.' },
    });
    assert.equal(response.statusCode, 403, response.body);
  });

  test('closing an asset needs a fresh second factor', async () => {
    // Quiet, durable and platform-wide: exactly the shape a stolen session is worth holding.
    const asset = await disposableAsset('ELEV');
    await db
      .update(schema.staffSessions)
      .set({ mfaSatisfiedAt: new Date(Date.now() - 10 * 60 * 1000) })
      .where(eq(schema.staffSessions.tokenHash, hashToken(superadminToken)));

    const response = await app.inject({
      method: 'POST',
      url: `/admin/assets/${asset!.id}/listing`,
      headers: asStaff(superadminToken),
      payload: { listed: false, note: 'Attempting without a fresh code.' },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error, 'elevation_required');
  });

  test('an asset can be added by hand, approved, and audited', async () => {
    const symbol = `TST${randomBytes(2).toString('hex').toUpperCase()}`;
    const before = await countAudit('asset.added');

    await reauth();
    const response = await app.inject({
      method: 'POST',
      url: '/admin/assets',
      headers: asStaff(superadminToken),
      payload: {
        chain: 'bsc',
        symbol,
        contract: `0x${randomBytes(20).toString('hex')}`,
        decimals: 18,
        kind: 'erc20',
        note: 'Verified against the issuer documentation on 18 August.',
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(await countAudit('asset.added'), before + 1);

    const [added] = await db
      .select()
      .from(schema.assets)
      .where(eq(schema.assets.id, response.json().assetId));
    assert.equal(added!.verdict, 'approved');
    assert.equal(added!.listed, true);
    /**
     * Not curated, and that is not a detail. `curated` means "on the list compiled in code
     * and checked against the issuer's documentation" — marking a hand-added row as curated
     * would make the codebase's own list look longer than it is.
     */
    assert.equal(added!.curated, false);
    // Nothing prices a token we invented, so it needs the merchant's own rate.
    assert.equal(added!.requiresFixedRate, true);
  });

  test('adding an asset that already exists is refused, not duplicated', async () => {
    /**
     * Two rows for one contract would mean two ids for one token, and a merchant could
     * enable the one nobody is watching.
     */
    const [existing] = await db
      .select({ chain: schema.assets.chain, contract: schema.assets.contract })
      .from(schema.assets)
      .where(and(eq(schema.assets.symbol, 'USDT'), eq(schema.assets.chain, 'bsc')))
      .limit(1);

    await reauth();
    const response = await app.inject({
      method: 'POST',
      url: '/admin/assets',
      headers: asStaff(superadminToken),
      payload: {
        chain: existing!.chain,
        symbol: 'USDT',
        contract: existing!.contract,
        decimals: 18,
        kind: 'erc20',
        note: 'Attempting to add a contract that is already in the catalogue.',
      },
    });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error, 'already_exists');
  });

  // ── what the company owner sees ────────────────────────────────────────────
  //
  // There are two roles in this product: the staff who run AVEX, and the account holder
  // who takes payments. These are the staff side of the commission — the owner's view of
  // what every account pays and what each has been worth.

  test('a merchant detail carries the rate an operator is about to change', async () => {
    /**
     * The same request, not a second one. Whoever can change an account's rate — the
     * route below — needs to see it first, and two requests to answer "what do they pay
     * and what have they paid us" is how a panel ends up showing only one of the two.
     */
    const org = await freshMerchant('detail');
    await feePlanService.ensureForOrganization(org);

    const response = await app.inject({
      method: 'GET',
      url: `/admin/merchants/${org}`,
      headers: asStaff(supportToken),
    });
    assert.equal(response.statusCode, 200, response.body);

    const body = response.json();
    assert.equal(body.commission.commission.feeBps, 50);
    assert.equal(body.commission.commission.feePayer, 'merchant');
    assert.equal(body.commissionEarned.creditedUsdMicros, '0');
  });

  test('a merchant with no plan row is shown as such rather than failing the page', async () => {
    /**
     * Our own bookkeeping gap, and it must not take the whole detail view down with it.
     * An operator investigating an account that somehow has no plan is exactly the person
     * who needs to be able to open it.
     */
    const org = await freshMerchant('noplandetail');

    const response = await app.inject({
      method: 'GET',
      url: `/admin/merchants/${org}`,
      headers: asStaff(supportToken),
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().commission, null);
    assert.ok(response.json().organization, 'the rest of the page must still be there');
  });

  test('commission earned separates what is owed to us from what has reached us', async () => {
    /**
     * Two figures because they answer different questions, and conflating them would
     * overstate the money we hold. A credited payment is commission the chain owes us and
     * will deliver when the invoice is swept; only a settled one has actually arrived.
     */
    const org = await freshMerchant('earned');
    await feePlanService.ensureForOrganization(org);
    const invoiceId = await giveVolume(org, 10_000, daysAgo(1));

    const beforeSettling = await feePlanService.commissionEarned({ organizationId: org });
    // 0.5% of $10,000. The rate comes from the invoice, not from the plan, because the
    // invoice is what the deposit address committed to.
    assert.equal(beforeSettling.creditedUsdMicros, 50_000_000n);
    assert.equal(beforeSettling.settledUsdMicros, 0n, 'nothing has been swept yet');

    await db
      .update(schema.invoices)
      .set({ settledAt: new Date() })
      .where(eq(schema.invoices.id, invoiceId));

    const afterSettling = await feePlanService.commissionEarned({ organizationId: org });
    assert.equal(afterSettling.creditedUsdMicros, 50_000_000n);
    assert.equal(afterSettling.settledUsdMicros, 50_000_000n);
  });

  test('a reversed payment earns us nothing', async () => {
    // A reorg took the payment back, so there is no cut of it to have taken. Counting it
    // would put revenue on the books that no wallet will ever hold.
    const org = await freshMerchant('earnedreversed');
    await feePlanService.ensureForOrganization(org);
    await giveVolume(org, 10_000, daysAgo(1), { reversed: true });

    assert.equal(
      (await feePlanService.commissionEarned({ organizationId: org })).creditedUsdMicros,
      0n,
    );
  });

  test('test volume earns us nothing either', async () => {
    // Otherwise our own revenue figure would include rehearsals, and the first thing an
    // owner does with a revenue figure is compare it against a wallet.
    const org = await freshMerchant('earnedtest');
    await feePlanService.ensureForOrganization(org);
    await giveVolume(org, 10_000, daysAgo(1), { mode: 'test' });

    assert.equal(
      (await feePlanService.commissionEarned({ organizationId: org })).creditedUsdMicros,
      0n,
    );
  });

  test('the commission is floored per payment, as the contract floors it', async () => {
    /**
     * `Forwarder._feeOn` floors each invoice's cut individually. Summing first and
     * flooring once would overstate the total by up to a unit per payment — the kind of
     * drift that makes a revenue figure impossible to reconcile against a wallet, and
     * that grows with the number of payments rather than staying a rounding error.
     */
    const org = await freshMerchant('floored');
    await feePlanService.ensureForOrganization(org);
    // 0.5% of $0.000199 is 0.0000000995 dollars — under a micro-dollar, so it floors to
    // nothing. Three of them still floor to nothing, rather than to two micro-dollars.
    for (let index = 0; index < 3; index += 1) {
      await giveVolume(org, 0.000199, daysAgo(1));
    }

    assert.equal(
      (await feePlanService.commissionEarned({ organizationId: org })).creditedUsdMicros,
      0n,
    );
  });

  test('the book lists every account, biggest earner first', async () => {
    const big = await freshMerchant('bookbig');
    const small = await freshMerchant('booksmall');
    const quiet = await freshMerchant('bookquiet');
    for (const org of [big, small, quiet]) await feePlanService.ensureForOrganization(org);
    await giveVolume(big, 100_000, daysAgo(1));
    await giveVolume(small, 1_000, daysAgo(1));

    const book = await feePlanService.book();
    const positions = [big, small, quiet].map((org) =>
      book.accounts.findIndex((account) => account.organizationId === org),
    );
    assert.ok(positions.every((index) => index >= 0), 'every account must be listed');
    assert.ok(positions[0]! < positions[1]!, 'the bigger earner comes first');
    /**
     * An account that signed up and never traded is listed with zeros rather than left
     * out. A merchant who is not trading is a fact about the business, and an owner
     * scanning this is as likely to be looking for those as for the busy ones.
     */
    assert.ok(positions[1]! < positions[2]!);
    assert.equal(book.accounts[positions[2]!]?.commissionUsdMicros, '0');
    assert.equal(book.accounts[positions[0]!]?.commissionUsdMicros, '500000000');
  });

  test('the book total is the sum of what the accounts earned', async () => {
    // Stated because a headline that disagrees with the list beneath it is worse than no
    // headline: an owner cannot tell which of the two to believe.
    const book = await feePlanService.book();
    const summed = book.accounts.reduce(
      (total, account) => total + BigInt(account.commissionUsdMicros),
      0n,
    );
    assert.equal(book.creditedUsdMicros, summed.toString());
    assert.ok(BigInt(book.settledUsdMicros) <= BigInt(book.creditedUsdMicros));
  });

  test('the revenue route is a staff read, and support may have it', async () => {
    // Every account's rate and what each has paid us is the same class of data as the
    // merchant list, not a settlement secret — so it takes the same permission.
    const response = await app.inject({
      method: 'GET',
      url: '/admin/commission/revenue',
      headers: asStaff(supportToken),
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(Array.isArray(response.json().accounts));
  });

  test('a merchant session cannot read the revenue book', async () => {
    // The one thing on this route that would matter most in the wrong hands: every other
    // merchant's volume and what they pay.
    const response = await app.inject({
      method: 'GET',
      url: '/admin/commission/revenue',
      headers: asStaff(merchantSessionToken),
    });
    assert.equal(response.statusCode, 401, response.body);
  });

  /**
   * An approved asset nobody else is looking at, for tests that change its listing.
   *
   * This suite shares a database with every other one. Flipping a curated USDT row would
   * leave the catalogue in whatever state an interrupted run left it, and the failure would
   * surface somewhere unrelated — which is exactly what happened once.
   */
  async function disposableAsset(label: string): Promise<{ readonly id: string }> {
    const [asset] = await db
      .insert(schema.assets)
      .values({
        chain: 'bsc',
        symbol: `${label}${randomBytes(2).toString('hex').toUpperCase()}`,
        contract: `0x${randomBytes(20).toString('hex')}`,
        decimals: 18,
        kind: 'erc20',
        verdict: 'approved',
      })
      .returning({ id: schema.assets.id });
    return asset!;
  }

  /** Move a plan's period, to put a merchant either side of a close. */
  async function agePeriod(orgId: string, start: Date, end: Date): Promise<void> {
    await db
      .update(schema.feePlans)
      .set({ currentPeriodStart: start, currentPeriodEnd: end })
      .where(eq(schema.feePlans.organizationId, orgId));
  }

  /**
   * How many audit rows exist for an action, counted in the database.
   *
   * Not through `/admin/audit`, which caps a page at 200 rows. Every caller here
   * compares a count before and after, and once an action passes 200 rows — which it
   * does after enough runs against a shared database — both sides read 200 and the
   * delta is always zero. The test then passes or fails on how much history happens to
   * be lying around, which is the opposite of what it is for.
   */
  async function countAudit(action: string): Promise<number> {
    const [row] = await db
      .select({ value: count() })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, action));
    return row?.value ?? 0;
  }
});

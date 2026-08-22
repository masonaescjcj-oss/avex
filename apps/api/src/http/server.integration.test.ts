import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import type { FastifyInstance } from 'fastify';

import {
  ContractProbe,
  DEFAULT_AGGREGATION,
  DEFAULT_BREAKER,
  PriceService,
  WebhookDispatcher,
  verifyWebhook,
} from '@avex/core';
import type { Asset, IncomingPayment } from '@avex/core';
import type { PriceSource, PriceSymbol } from '@avex/core';

import { eq } from 'drizzle-orm';

import { createDatabase, schema } from '../db/client.js';
import { CommissionLedger } from '../domain/commission-ledger.js';
import { WalletPoolChanges, WalletPoolService } from '../domain/wallet-pool-service.js';
import { PriceTickWriter } from '../domain/price-repository.js';
import { AssetService } from '../domain/asset-service.js';
import { AuditService } from '../domain/audit.js';
import { InviteService } from '../domain/invite-service.js';
import { MembershipService } from '../domain/membership-service.js';
import { DatabasePaymentSink } from '../domain/payment-sink.js';
import { PayoutAddressService } from '../domain/payout-service.js';
import { DatabaseWatchStore } from '../domain/watch-store.js';
import { WebhookService } from '../domain/webhook-service.js';
import { AdminService } from '../domain/admin-service.js';
import { AuthService } from '../domain/auth-service.js';
import { ReconciliationService } from '../domain/reconciliation-service.js';
import { MerchantService } from '../domain/merchant-service.js';
import { DepositAddressDeriver } from '../domain/deposit-address.js';
import { CheckoutService } from '../domain/checkout-service.js';
import { InvoiceCreationService } from '../domain/invoice-creation.js';
import { FeePlanService } from '../domain/fee-plan-service.js';
import { SettlementStore } from '../domain/settlement-store.js';
import { StaffAuthService } from '../domain/staff-auth.js';
import { totpCode } from '../auth/totp.js';
import { hashToken } from '../auth/tokens.js';
import { loadEnv } from '../env.js';
import { ConsoleMailer } from '../mailer.js';
import { buildServer } from './server.js';

/**
 * End-to-end exercise of Phase 1 against a real Postgres.
 *
 * Skipped when DATABASE_URL is unset so the unit suite stays runnable anywhere.
 * Run it with:
 *   DATABASE_URL=postgres://avex@localhost:5433/avex node --test dist/**\/*.test.js
 */
const databaseUrl = process.env.DATABASE_URL;

/**
 * The admin-panel services, for harnesses that do not exercise them.
 *
 * The recomputer is a stub: reconciliation has its own suite, in
 * admin.integration.test.ts, where it runs against a real payment sink so that
 * attaching a transfer produces a genuine invoice status. Wiring a full sink into
 * every harness here would drag a webhook dispatcher along with it for no coverage.
 */
/**
 * A forwarder factory and creation code for derivation in tests.
 *
 * Not the real compiled bytecode: what these suites need is a derivation that is
 * deterministic and that changes when its inputs change. That the off-chain
 * derivation agrees with what the EVM actually deploys is a different claim, and it
 * is tested where it belongs — against a real EVM, in contracts/test.
 */
const TEST_FACTORY = '0x00000000000000000000000000000000000f4c70';
const TEST_CREATION_CODE = '0x60806040523480156100115760006000fd5b50';
const TEST_FEE_COLLECTOR = '0x3333333333333333333333333333333333333333';

/** $1 a token, matching what the fake price sources in this file report. */
const priceStub = {
  async requireRate() {
    return { priceScaled: 10n ** 18n, observedAt: Date.now() };
  },
};

function invoiceServices(
  db: ReturnType<typeof createDatabase>['db'],
  audit: AuditService,
  prices: { requireRate(symbol: never): Promise<{ priceScaled: bigint; observedAt: number }> },
) {
  const feePlans = new FeePlanService(db, audit, {
    feeCollectors: { bsc: TEST_FEE_COLLECTOR, ethereum: TEST_FEE_COLLECTOR },
  });
  const deriver = new DepositAddressDeriver(
    {
      evm: {
        bsc: { factory: TEST_FACTORY, forwarderCreationCode: TEST_CREATION_CODE },
        ethereum: { factory: TEST_FACTORY, forwarderCreationCode: TEST_CREATION_CODE },
        polygon: { factory: TEST_FACTORY, forwarderCreationCode: TEST_CREATION_CODE },
      },
      // TON is the shared-address case, kept in so memo derivation is exercised.
      shared: { ton: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs' },
    },
    'test-memo-secret-not-a-real-one',
  );
  const invoiceCreation = new InvoiceCreationService(
    db,
    deriver,
    feePlans,
    prices as never,
    audit,
  );
  return {
    feePlans,
    invoiceCreation,
    checkouts: new CheckoutService(
      db,
      invoiceCreation,
      feePlans,
      deriver,
      prices as never,
      audit,
    ),
  };
}

function adminServices(db: ReturnType<typeof createDatabase>['db'], audit: AuditService) {
  const settlements = new SettlementStore(db);
  const reconciliation = new ReconciliationService(db, audit, {
    async recompute() {
      throw new Error('reconciliation is exercised in admin.integration.test.ts');
    },
  });
  return { settlements, reconciliation, admin: new AdminService(db, audit, settlements, reconciliation) };
}


/** A chain caller that answers nothing, for suites that never probe a contract. */
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



describe('api', { skip: databaseUrl ? false : 'DATABASE_URL not set' }, () => {
  let app: FastifyInstance;
  let mailer: ConsoleMailer;
  let close: () => Promise<void>;

  const unique = randomBytes(6).toString('hex');
  const ownerEmail = `owner-${unique}@example.com`;
  const password = 'a-sufficiently-long-password';

  /**
   * A price source under the test's control. The suite must not depend on a
   * third-party API being reachable, or CI fails for reasons unrelated to the code.
   */
  const fakeSource = (name: string): PriceSource => ({
    name,
    supports: () => true,
    async fetchUsdPrice() {
      return { priceScaled: 10n ** 18n, observedAt: Date.now() };
    },
  });

  before(async () => {
    const env = loadEnv({
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl!,
      // Room for the many requests this suite makes from one address.
      RATE_LIMIT_PER_MINUTE: '10000',
    });

    const database = createDatabase(env.DATABASE_URL);
    close = database.close;

    const audit = new AuditService(database.db);
    mailer = new ConsoleMailer(env.APP_URL, () => {});

    app = buildServer({
      ledger: new CommissionLedger(database.db),
      walletPool: new WalletPoolService(database.db),
      walletChanges: new WalletPoolChanges(
        database.db,
        new WalletPoolService(database.db),
        audit,
        // No wallet notice is sent in these cases; the transport only has to exist.
        new ConsoleMailer('http://localhost', () => {}),
      ),
      env,
      db: database.db,
      audit,
      mailer,
      minPriceSources: DEFAULT_AGGREGATION.minSources,
      payouts: new PayoutAddressService(database.db, audit, mailer ?? new ConsoleMailer(env.APP_URL, () => {})),
      invites: new InviteService(database.db, audit),
      memberships: new MembershipService(database.db, audit, mailer),
      assets: new AssetService(database.db, audit, new ContractProbe(offlineCaller), ['USDT']),
      prices: new PriceService(
        [fakeSource('fake-a'), fakeSource('fake-b')],
        { aggregation: DEFAULT_AGGREGATION, breaker: DEFAULT_BREAKER, cacheTtlMs: 10_000 },
      ),
      auth: new AuthService(database.db, audit, {
        sessionTtlMs: 60 * 60 * 1000,
        emailTokenTtlMs: 60 * 60 * 1000,
      }),
      staffAuth: new StaffAuthService(database.db, audit),
      ...adminServices(database.db, audit),
      merchant: new MerchantService(database.db),
      ...invoiceServices(database.db, audit, priceStub),
      // Deliveries go nowhere in these harnesses; the webhook suite has its own.
      webhooks: new WebhookService(
        database.db,
        new WebhookDispatcher({ async post() { return { statusCode: 200 }; } }),
      ),
    });
    await app.ready();
  });

  after(async () => {
    await app?.close();
    await close?.();
  });

  let organizationId: string;
  let sessionToken: string;
  let totpSecret: string;

  test('health is public', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'ok' });
  });

  test('anonymous requests to protected routes are refused', async () => {
    // Default-deny: a route is protected by existing, not by remembering to guard it.
    const response = await app.inject({ method: 'GET', url: '/v1/organizations' });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error, 'unauthenticated');
  });

  test('signup creates a user, an organization and an owner membership', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: ownerEmail, password, organizationName: 'Test Merchant' },
    });

    assert.equal(response.statusCode, 201);
    const body = response.json();
    assert.ok(body.organizationId, 'organization should be created alongside the user');
    assert.equal(body.emailVerificationRequired, true);
    organizationId = body.organizationId;

    // The verification token leaves through the mailer, never the API response.
    assert.ok(!JSON.stringify(body).includes('token'));
    const mail = mailer.sent.at(-1);
    assert.equal(mail?.to, ownerEmail);

    /**
     * And the link in it has to land on a page that exists.
     *
     * The token is reachable only through this mail, so the link is the only way it can ever
     * be spent — and the dashboard is one page that reads what to do from its query. This
     * pointed at `/verify-email` for a while, a path nothing serves, which meant every real
     * signup ended on a 404 with the address left unconfirmed.
     */
    const [, link] = mail!.body.match(/(https?:\/\/\S+)/) ?? [];
    assert.ok(link, `no link in the verification mail: ${mail!.body}`);
    const url = new URL(link);
    assert.equal(url.pathname, '/dashboard');
    const carried = url.searchParams.get('verify');
    assert.ok(carried && carried.length >= 16, `the link carries no token: ${link}`);
    assert.ok(!link.includes('/verify-email'), 'the link points at a path nothing serves');
  });

  test('a duplicate signup is indistinguishable from a new one', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: ownerEmail, password, organizationName: 'Impostor' },
    });

    // Same status and shape, so the endpoint cannot be used to discover which
    // addresses have accounts.
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().emailVerificationRequired, true);

    // The real owner is told about the attempt instead.
    assert.match(mailer.sent.at(-1)!.subject, /tried to sign up/);
  });

  test('signup rejects a weak password with field detail', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: `weak-${unique}@example.com`, password: 'short', organizationName: 'X' },
    });

    assert.equal(response.statusCode, 400);
    const body = response.json();
    assert.equal(body.error, 'invalid_request');
    assert.ok(body.fields.some((field: { path: string }) => field.path === 'password'));
  });

  test('login with the wrong password is refused', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: ownerEmail, password: 'not-the-right-password' },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error, 'invalid_credentials');
  });

  test('login with an unknown email gives the same answer', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: `nobody-${unique}@example.com`, password },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error, 'invalid_credentials');
  });

  test('login succeeds and returns a session token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: ownerEmail, password },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    // No second factor enrolled yet, so the session is immediately usable.
    assert.equal(body.status, 'ok');
    assert.ok(body.token);
    sessionToken = body.token;
  });

  const asOwner = () => ({ authorization: `Bearer ${sessionToken}` });

  test('the session identifies the user and lists their organization', async () => {
    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: asOwner() });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().email, ownerEmail);
    assert.equal(me.json().totpEnabled, false);

    const orgs = await app.inject({
      method: 'GET',
      url: '/v1/organizations',
      headers: asOwner(),
    });
    assert.equal(orgs.statusCode, 200);
    const [organization] = orgs.json().data;
    assert.equal(organization.id, organizationId);
    assert.equal(organization.role, 'owner');
  });

  test('a garbage bearer token is rejected', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    assert.equal(response.statusCode, 401);
  });

  test('an elevated action is refused until an authenticator is enrolled', async () => {
    // The owner holds the permission, but apikey:write is elevation-gated and no
    // authenticator exists yet. Granting it here would make elevation decorative
    // for every account that skipped two-factor setup.
    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${organizationId}/api-keys`,
      headers: asOwner(),
      payload: { name: 'first', mode: 'test', scopes: ['invoice:read'] },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error, 'two_factor_required');
  });

  test('enrolling an authenticator is not active until confirmed', async () => {
    const enroll = await app.inject({
      method: 'POST',
      url: '/v1/auth/totp/enroll',
      headers: asOwner(),
    });
    assert.equal(enroll.statusCode, 200);
    assert.equal(enroll.json().status, 'pending_confirmation');
    totpSecret = enroll.json().secret;

    // A wrong code must not complete enrolment.
    const wrong = await app.inject({
      method: 'POST',
      url: '/v1/auth/totp/confirm',
      headers: asOwner(),
      payload: { code: '000000' },
    });
    assert.equal(wrong.statusCode, 400);

    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: asOwner() });
    assert.equal(me.json().totpEnabled, false, 'unconfirmed enrolment must not count');
  });

  test('confirming enrolment returns recovery codes and invalidates the session factor', async () => {
    const confirm = await app.inject({
      method: 'POST',
      url: '/v1/auth/totp/confirm',
      headers: asOwner(),
      payload: { code: totpCode(totpSecret) },
    });

    assert.equal(confirm.statusCode, 200);
    const codes = confirm.json().recoveryCodes;
    assert.equal(codes.length, 10);

    // Enrolling a new factor means the existing session has not proven it.
    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: asOwner() });
    assert.equal(me.json().totpEnabled, true);
    assert.equal(me.json().mfaComplete, false);
  });

  test('a session with an outstanding factor cannot act', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${organizationId}/members`,
      headers: asOwner(),
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error, 'mfa_required');
  });

  test('proving the factor restores the session', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa',
      headers: asOwner(),
      payload: { code: '000000' },
    });
    assert.equal(bad.statusCode, 401);

    const good = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa',
      headers: asOwner(),
      payload: { code: totpCode(totpSecret) },
    });
    assert.equal(good.statusCode, 200);

    const members = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${organizationId}/members`,
      headers: asOwner(),
    });
    assert.equal(members.statusCode, 200);
    const [member] = members.json().data;
    assert.equal(member.email, ownerEmail);
    assert.equal(member.role, 'owner');
    assert.equal(member.twoFactorEnabled, true);
  });

  let apiKey: string;

  test('an api key is returned exactly once and never again', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${organizationId}/api-keys`,
      headers: asOwner(),
      payload: {
        name: 'server key',
        mode: 'test',
        scopes: ['invoice:read', 'invoice:create'],
      },
    });

    assert.equal(created.statusCode, 201);
    apiKey = created.json().key;
    assert.ok(apiKey.startsWith('ak_test_'), 'mode belongs in the key text');

    // Listing exposes only the prefix — the secret is unrecoverable.
    const listed = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${organizationId}/api-keys`,
      headers: asOwner(),
    });
    const [key] = listed.json().data;
    assert.equal(key.prefix, apiKey.slice(0, 12));
    assert.ok(!JSON.stringify(listed.json()).includes(apiKey.slice(12)));
  });

  test('a key cannot be granted a scope its creator could not exercise headlessly', async () => {
    // payout_address:write requires proving an authenticator, which a headless key
    // can never do — so it must not be grantable at all.
    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${organizationId}/api-keys`,
      headers: asOwner(),
      payload: { name: 'over-broad', mode: 'live', scopes: ['payout_address:write'] },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error, 'scope_exceeds_role');
  });

  test('an api key authenticates and is limited to its scopes', async () => {
    const headers = { authorization: `Bearer ${apiKey}` };

    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().kind, 'api_key');
    assert.equal(me.json().organizationId, organizationId);

    // Granted.
    const orgs = await app.inject({ method: 'GET', url: '/v1/organizations', headers });
    assert.equal(orgs.statusCode, 200);

    // Not granted: the key has invoice scopes only.
    const members = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${organizationId}/members`,
      headers,
    });
    assert.equal(members.statusCode, 403);
    assert.equal(members.json().error, 'scope_missing');
  });

  test('a revoked key stops working immediately', async () => {
    const listed = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${organizationId}/api-keys`,
      headers: asOwner(),
    });
    const keyId = listed.json().data.find((row: { revoked: boolean }) => !row.revoked).id;

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${organizationId}/api-keys/${keyId}`,
      headers: asOwner(),
    });
    assert.equal(revoked.statusCode, 204);

    const after_ = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${apiKey}` },
    });
    assert.equal(after_.statusCode, 401);
  });

  test('one tenant cannot reach another', async () => {
    // A second, unrelated merchant.
    const otherEmail = `other-${unique}@example.com`;
    const signup = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: otherEmail, password, organizationName: 'Other Merchant' },
    });
    const otherOrgId = signup.json().organizationId;

    // The first owner is fully authenticated and elevated, and still must not see it.
    // 404 rather than 403: confirming the organization exists is itself a leak.
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${otherOrgId}/members`,
      headers: asOwner(),
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error, 'not_found');
  });

  test('the audit log records what happened, without secrets', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${organizationId}/audit-log`,
      headers: asOwner(),
    });

    assert.equal(response.statusCode, 200);
    const actions = response.json().data.map((row: { action: string }) => row.action);

    assert.ok(actions.includes('user.signed_up'));
    assert.ok(actions.includes('api_key.created'));
    assert.ok(actions.includes('api_key.revoked'));

    // Nothing credential-shaped may ever be persisted here.
    const serialized = JSON.stringify(response.json());
    assert.ok(!serialized.includes(password));
    assert.ok(!serialized.includes(totpSecret));
  });

  test('logging out revokes the session', async () => {
    const logout = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: asOwner(),
    });
    assert.equal(logout.statusCode, 204);

    const after_ = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: asOwner(),
    });
    assert.equal(after_.statusCode, 401);
  });
});

describe('pricing', { skip: databaseUrl ? false : 'DATABASE_URL not set' }, () => {
  // A separate suite so it can authenticate independently of the sequence above,
  // which deliberately ends by revoking its session.
  let app: FastifyInstance;
  let close: () => Promise<void>;
  let token: string;
  let db: ReturnType<typeof createDatabase>['db'];

  const unique = randomBytes(6).toString('hex');

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
    const audit = new AuditService(database.db);
    const suiteMailer = new ConsoleMailer(env.APP_URL, () => {});

    app = buildServer({
      ledger: new CommissionLedger(database.db),
      walletPool: new WalletPoolService(database.db),
      walletChanges: new WalletPoolChanges(
        database.db,
        new WalletPoolService(database.db),
        audit,
        // No wallet notice is sent in these cases; the transport only has to exist.
        new ConsoleMailer('http://localhost', () => {}),
      ),
      env,
      db: database.db,
      audit,
      mailer: suiteMailer,
      minPriceSources: 2,
      payouts: new PayoutAddressService(database.db, audit, suiteMailer),
      invites: new InviteService(database.db, audit),
      memberships: new MembershipService(database.db, audit, suiteMailer),
      assets: new AssetService(database.db, audit, new ContractProbe(offlineCaller), ['USDT']),
      prices: new PriceService(
        [
          {
            name: 'agrees-a',
            supports: () => true,
            async fetchUsdPrice() {
              return { priceScaled: 2000n * 10n ** 18n, observedAt: Date.now() };
            },
          },
          {
            name: 'agrees-b',
            supports: () => true,
            async fetchUsdPrice() {
              return { priceScaled: 2001n * 10n ** 18n, observedAt: Date.now() };
            },
          },
          {
            name: 'always-fails',
            supports: () => true,
            async fetchUsdPrice(): Promise<never> {
              throw new Error('HTTP 503');
            },
          },
        ],
        { aggregation: DEFAULT_AGGREGATION, breaker: DEFAULT_BREAKER, cacheTtlMs: 0 },
      ),
      auth: new AuthService(database.db, audit, {
        sessionTtlMs: 60 * 60 * 1000,
        emailTokenTtlMs: 60 * 60 * 1000,
      }),
      staffAuth: new StaffAuthService(database.db, audit),
      ...adminServices(database.db, audit),
      merchant: new MerchantService(database.db),
      ...invoiceServices(database.db, audit, priceStub),
      // Deliveries go nowhere in these harnesses; the webhook suite has its own.
      webhooks: new WebhookService(
        database.db,
        new WebhookDispatcher({ async post() { return { statusCode: 200 }; } }),
      ),
    });
    await app.ready();

    await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        email: `prices-${unique}@example.com`,
        password: 'a-sufficiently-long-password',
        organizationName: 'Price Reader',
      },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: `prices-${unique}@example.com`,
        password: 'a-sufficiently-long-password',
      },
    });
    token = login.json().token;
  });

  after(async () => {
    await app?.close();
    await close?.();
  });

  test('prices require authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/prices?symbols=ETH' });
    assert.equal(response.statusCode, 401);
  });

  test('a rate is returned with the sources that backed it', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/prices?symbols=ETH',
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(response.statusCode, 200);
    const [eth] = response.json().data;
    assert.equal(eth.symbol, 'ETH');
    assert.equal(eth.available, true);
    // Median of 2000 and 2001, with the failing source excluded.
    assert.match(eth.usd, /^2000\.5/);
    assert.deepEqual(eth.sources.sort(), ['agrees-a', 'agrees-b']);
    assert.ok(!eth.sources.includes('always-fails'));
  });

  test('unknown symbols are ignored rather than erroring', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/prices?symbols=ETH,NOTATOKEN',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.length, 1);
  });

  test('coverage reports whether each asset has enough sources', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/prices/coverage',
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    const eth = body.data.find((row: { symbol: string }) => row.symbol === 'ETH');
    assert.equal(eth.sufficient, true);
    assert.equal(eth.sources.length, 3);
  });

  test('observations are persisted, failures included', async () => {
    // Reuses the suite's pool: opening a second one would keep the process alive
    // after the tests finish.
    const writer = new PriceTickWriter(db);
    writer.record({ symbol: 'ETH', source: 'unit-test', rate: { priceScaled: 5n, observedAt: Date.now() }, error: null });
    writer.record({ symbol: 'ETH', source: 'unit-test', rate: null, error: 'HTTP 500' });

    // Both rows must land: reconstructing why a rate was refused needs the failures.
    assert.equal(await writer.flush(), 2);
    assert.equal(writer.pending, 0);
  });
});

describe('assets', { skip: databaseUrl ? false : 'DATABASE_URL not set' }, () => {
  let app: FastifyInstance;
  let close: () => Promise<void>;
  let token: string;
  let orgId: string;
  let db: ReturnType<typeof createDatabase>['db'];
  let assetService: AssetService;

  const unique = randomBytes(6).toString('hex');
  const email = `assets-${unique}@example.com`;
  const password = 'a-sufficiently-long-password';
  /**
   * Unique per run. A hardcoded address would already be in the catalogue on a
   * second run, so the suite would pass once and then fail against its own
   * leftovers — which costs more time to diagnose than it saves to write.
   */
  const submittedContract = `0x${unique}${'ab'.repeat(14)}`;

  /** A token contract whose responses this suite dictates. */
  const fakeToken = (symbol: string, decimals: number) => ({
    async getCode(): Promise<string> {
      return '0x60806040523480156100';
    },
    async call(_to: string, data: string): Promise<string> {
      const sel = data.slice(0, 10);
      const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`;
      if (sel === '0x95d89b41' || sel === '0x06fdde03') {
        const bytes = Buffer.from(symbol, 'utf8');
        return (
          `0x${(32n).toString(16).padStart(64, '0')}` +
          bytes.length.toString(16).padStart(64, '0') +
          bytes.toString('hex').padEnd(64, '0')
        );
      }
      if (sel === '0x313ce567') return word(BigInt(decimals));
      if (sel === '0x18160ddd') return word(10n ** 24n);
      if (sel === '0x70a08231') return word(10n ** 20n);
      throw new Error('unexpected call');
    },
    async getStorageAt(): Promise<string> {
      return `0x${'00'.repeat(32)}`;
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
    const audit = new AuditService(database.db);
    const suiteMailer = new ConsoleMailer(env.APP_URL, () => {});

    assetService = new AssetService(
      database.db,
      audit,
      new ContractProbe(fakeToken('MERCH', 18)),
      ['USDT', 'USDC', 'ETH', 'BNB', 'POL', 'TRX', 'SOL', 'TON'],
    );

    app = buildServer({
      ledger: new CommissionLedger(database.db),
      walletPool: new WalletPoolService(database.db),
      walletChanges: new WalletPoolChanges(
        database.db,
        new WalletPoolService(database.db),
        audit,
        // No wallet notice is sent in these cases; the transport only has to exist.
        new ConsoleMailer('http://localhost', () => {}),
      ),
      env,
      db: database.db,
      audit,
      mailer: suiteMailer,
      minPriceSources: 2,
      payouts: new PayoutAddressService(database.db, audit, suiteMailer),
      invites: new InviteService(database.db, audit),
      memberships: new MembershipService(database.db, audit, suiteMailer),
      prices: new PriceService(
        [
          { name: 'a', supports: () => true, async fetchUsdPrice() { return { priceScaled: 10n ** 18n, observedAt: Date.now() }; } },
          { name: 'b', supports: () => true, async fetchUsdPrice() { return { priceScaled: 10n ** 18n, observedAt: Date.now() }; } },
        ],
        { aggregation: DEFAULT_AGGREGATION, breaker: DEFAULT_BREAKER, cacheTtlMs: 10_000 },
      ),
      // MERCH is deliberately absent from the priced symbols.
      assets: assetService,
      auth: new AuthService(database.db, audit, {
        sessionTtlMs: 60 * 60 * 1000,
        emailTokenTtlMs: 60 * 60 * 1000,
      }),
      staffAuth: new StaffAuthService(database.db, audit),
      ...adminServices(database.db, audit),
      merchant: new MerchantService(database.db),
      ...invoiceServices(database.db, audit, priceStub),
      // Deliveries go nowhere in these harnesses; the webhook suite has its own.
      webhooks: new WebhookService(
        database.db,
        new WebhookDispatcher({ async post() { return { statusCode: 200 }; } }),
      ),
    });
    await app.ready();

    const signup = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email, password, organizationName: 'Asset Merchant' },
    });
    orgId = signup.json().organizationId;

    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password },
    });
    token = login.json().token;
  });

  after(async () => {
    await app?.close();
    await close?.();
  });

  const auth = () => ({ authorization: `Bearer ${token}` });

  test('the curated catalogue is visible and marked as such', async () => {
    // Idempotent, so running it here is safe regardless of suite order.
    await assetService.seedCurated();

    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/assets`,
      headers: auth(),
    });

    assert.equal(response.statusCode, 200);
    const curated = response.json().data.filter((row: { curated: boolean }) => row.curated);
    assert.ok(curated.length > 0, 'curated assets should be seeded');

    // Every curated entry arrives approved; nothing else does.
    assert.ok(curated.every((row: { verdict: string }) => row.verdict === 'approved'));

    // The decimals gotcha, surfaced through the API.
    const bscUsdt = curated.find(
      (row: { chain: string; symbol: string }) => row.chain === 'bsc' && row.symbol === 'USDT',
    );
    assert.equal(bscUsdt.decimals, 18);
  });

  let submittedAssetId: string;

  test('a submitted contract is accepted for review, not approved', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/assets`,
      headers: auth(),
      payload: { chain: 'bsc', contract: submittedContract },
    });

    // 202, not 201: probed, but nothing is usable until a human accepts it.
    assert.equal(response.statusCode, 202);
    const body = response.json();
    assert.equal(body.verdict, 'review');
    assert.equal(body.symbol, 'MERCH');
    // No source can quote MERCH, so a market rate is impossible.
    assert.equal(body.requiresFixedRate, true);
    assert.ok(body.findings.length > 0, 'findings must be disclosed to the merchant');

    submittedAssetId = body.assetId;
  });

  test('transfer behaviour is reported unknown when it could not be checked', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/assets`,
      headers: auth(),
    });

    const submitted = response
      .json()
      .data.find((row: { id: string }) => row.id === submittedAssetId);
    const fee = submitted.findings.find(
      (finding: { kind: string }) => finding.kind === 'fee_on_transfer',
    );

    // The rule that matters most: a check that did not run must not read as clean.
    assert.equal(fee.status, 'unknown');
  });

  test('submitting the same contract twice is refused', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/assets`,
      headers: auth(),
      payload: { chain: 'bsc', contract: submittedContract },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, 'asset_exists');
  });

  test('an asset under review cannot be enabled', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/v1/organizations/${orgId}/assets/${submittedAssetId}`,
      headers: auth(),
      payload: { enabled: true, pricingMode: 'fixed_rate', fixedRate: '0.25' },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'not_approved');
    assert.match(response.json().message, /under review/);
  });

  test('an unpriceable asset cannot use a market-rate mode', async () => {
    // The Phase 2 link enforced: no source can quote MERCH, so `fiat` mode would
    // have nothing to convert with.
    // Stand in for the reviewer accepting it, so the pricing rule can be reached.
    await db
      .update(schema.assets)
      .set({ verdict: 'approved' })
      .where(eq(schema.assets.id, submittedAssetId));

    const response = await app.inject({
      method: 'PUT',
      url: `/v1/organizations/${orgId}/assets/${submittedAssetId}`,
      headers: auth(),
      payload: { enabled: true, pricingMode: 'fiat' },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'fixed_rate_required');
  });

  test('a fixed rate must carry an expiry', async () => {
    // A rate with no expiry is one nobody revisits, and a stale one misprices every
    // invoice without ever failing.
    const response = await app.inject({
      method: 'PUT',
      url: `/v1/organizations/${orgId}/assets/${submittedAssetId}`,
      headers: auth(),
      payload: { enabled: true, pricingMode: 'fixed_rate', fixedRate: '0.25' },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'expiry_required');
  });

  test('an expiry in the past is refused', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/v1/organizations/${orgId}/assets/${submittedAssetId}`,
      headers: auth(),
      payload: {
        enabled: true,
        pricingMode: 'fixed_rate',
        fixedRate: '0.25',
        fixedRateValidUntil: new Date(Date.now() - 1000).toISOString(),
      },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'expiry_in_past');
  });

  test('a well-formed fixed rate is accepted and reflected in the listing', async () => {
    const validUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const response = await app.inject({
      method: 'PUT',
      url: `/v1/organizations/${orgId}/assets/${submittedAssetId}`,
      headers: auth(),
      payload: {
        enabled: true,
        pricingMode: 'fixed_rate',
        fixedRate: '0.25',
        fixedRateValidUntil: validUntil.toISOString(),
        toleranceBps: 200,
      },
    });
    assert.equal(response.statusCode, 204);

    const listed = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/assets`,
      headers: auth(),
    });
    const row = listed.json().data.find((entry: { id: string }) => entry.id === submittedAssetId);

    assert.equal(row.enabled, true);
    assert.equal(row.pricingMode, 'fixed_rate');
    assert.equal(row.toleranceBps, 200);
    assert.ok(row.fixedRateValidUntil);
  });

  test('a malformed rate is rejected before it can become a wrong amount', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/v1/organizations/${orgId}/assets/${submittedAssetId}`,
      headers: auth(),
      payload: {
        enabled: true,
        pricingMode: 'fixed_rate',
        fixedRate: 'not-a-number',
        fixedRateValidUntil: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'invalid_request');
  });

  test('another merchant cannot see this one submission', async () => {
    const otherEmail = `other-assets-${unique}@example.com`;
    const signup = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: otherEmail, password, organizationName: 'Other' },
    });
    const otherOrgId = signup.json().organizationId;
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: otherEmail, password },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${otherOrgId}/assets`,
      headers: { authorization: `Bearer ${login.json().token}` },
    });

    const ids = response.json().data.map((row: { id: string }) => row.id);
    // Curated assets are shared; another merchant's submission is not.
    assert.ok(!ids.includes(submittedAssetId));
    assert.ok(response.json().data.some((row: { curated: boolean }) => row.curated));
  });
});

describe('payout addresses', { skip: databaseUrl ? false : 'DATABASE_URL not set' }, () => {
  let app: FastifyInstance;
  let close: () => Promise<void>;
  let db: ReturnType<typeof createDatabase>['db'];
  let payouts: PayoutAddressService;
  let mail: ConsoleMailer;

  let ownerToken: string;
  let viewerToken: string;
  let orgId: string;
  let ownerSecret: string;

  const unique = randomBytes(6).toString('hex');
  const ownerEmail = `payout-owner-${unique}@example.com`;
  const viewerEmail = `payout-viewer-${unique}@example.com`;
  const password = 'a-sufficiently-long-password';

  const FIRST = '0x1111111111111111111111111111111111111111';
  const ATTACKER = '0x2222222222222222222222222222222222222222';

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
    const audit = new AuditService(database.db);
    mail = new ConsoleMailer(env.APP_URL, () => {});
    payouts = new PayoutAddressService(database.db, audit, mail);

    app = buildServer({
      ledger: new CommissionLedger(database.db),
      walletPool: new WalletPoolService(database.db),
      walletChanges: new WalletPoolChanges(
        database.db,
        new WalletPoolService(database.db),
        audit,
        // No wallet notice is sent in these cases; the transport only has to exist.
        new ConsoleMailer('http://localhost', () => {}),
      ),
      env,
      db: database.db,
      audit,
      mailer: mail,
      payouts,
      invites: new InviteService(database.db, audit),
      memberships: new MembershipService(database.db, audit, mail),
      minPriceSources: 2,
      assets: new AssetService(database.db, audit, new ContractProbe(offlineCaller), ['USDT']),
      prices: new PriceService(
        [
          { name: 'a', supports: () => true, async fetchUsdPrice() { return { priceScaled: 10n ** 18n, observedAt: Date.now() }; } },
          { name: 'b', supports: () => true, async fetchUsdPrice() { return { priceScaled: 10n ** 18n, observedAt: Date.now() }; } },
        ],
        { aggregation: DEFAULT_AGGREGATION, breaker: DEFAULT_BREAKER, cacheTtlMs: 10_000 },
      ),
      auth: new AuthService(database.db, audit, {
        sessionTtlMs: 60 * 60 * 1000,
        emailTokenTtlMs: 60 * 60 * 1000,
      }),
      staffAuth: new StaffAuthService(database.db, audit),
      ...adminServices(database.db, audit),
      merchant: new MerchantService(database.db),
      ...invoiceServices(database.db, audit, priceStub),
      // Deliveries go nowhere in these harnesses; the webhook suite has its own.
      webhooks: new WebhookService(
        database.db,
        new WebhookDispatcher({ async post() { return { statusCode: 200 }; } }),
      ),
    });
    await app.ready();

    // Owner, with two-factor enrolled and proven — the only way to reach
    // payout_address:write at all.
    const signup = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: ownerEmail, password, organizationName: 'Payout Merchant' },
    });
    orgId = signup.json().organizationId;

    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: ownerEmail, password },
    });
    ownerToken = login.json().token;

    const enroll = await app.inject({
      method: 'POST',
      url: '/v1/auth/totp/enroll',
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    ownerSecret = enroll.json().secret;
    await app.inject({
      method: 'POST',
      url: '/v1/auth/totp/confirm',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { code: totpCode(ownerSecret) },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { code: totpCode(ownerSecret) },
    });

    // A viewer in the same organization, to prove who can cancel.
    const viewerSignup = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: viewerEmail, password, organizationName: 'Viewer Own Org' },
    });
    const viewerUserId = viewerSignup.json().userId;
    await db.insert(schema.memberships).values({
      organizationId: orgId,
      userId: viewerUserId,
      role: 'viewer',
    });
    const viewerLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: viewerEmail, password },
    });
    viewerToken = viewerLogin.json().token;
  });

  after(async () => {
    await app?.close();
    await close?.();
  });

  const asOwner = () => ({ authorization: `Bearer ${ownerToken}` });
  const asViewer = () => ({ authorization: `Bearer ${viewerToken}` });

  const reElevate = async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa',
      headers: asOwner(),
      payload: { code: totpCode(ownerSecret) },
    });
  };

  test('a viewer cannot set a payout address', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/payout-addresses`,
      headers: asViewer(),
      payload: { chain: 'bsc', address: FIRST },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error, 'permission_denied');
  });

  test('a malformed address is refused before any funds could move', async () => {
    await reElevate();
    for (const address of ['0x1234', 'not-an-address', `0x${'0'.repeat(40)}`]) {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/organizations/${orgId}/payout-addresses`,
        headers: asOwner(),
        payload: { chain: 'bsc', address },
      });
      assert.equal(response.statusCode, 400, address);
      assert.equal(response.json().error, 'invalid_address', address);
    }
  });

  test('the first address for a chain takes effect at once', async () => {
    // Nothing to redirect yet, so a delay would obstruct setup without protecting
    // anything.
    await reElevate();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/payout-addresses`,
      headers: asOwner(),
      payload: { chain: 'bsc', address: FIRST.toLowerCase() },
    });

    assert.equal(response.statusCode, 201);
    assert.equal(response.json().status, 'active');
    // Stored checksummed, so comparisons never depend on how it was typed.
    assert.equal(response.json().address, FIRST);
    assert.equal(await payouts.activeAddress(orgId, 'bsc'), FIRST);
  });

  test('replacing an address is scheduled, not applied', async () => {
    await reElevate();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/payout-addresses`,
      headers: asOwner(),
      payload: { chain: 'bsc', address: ATTACKER },
    });

    // 202, not 201. The attack this defends against succeeds quietly, so the
    // response must not read as done.
    assert.equal(response.statusCode, 202);
    assert.equal(response.json().status, 'pending');
    assert.match(response.json().message, /24 hours/);

    // Crucially, the active address has not moved.
    assert.equal(await payouts.activeAddress(orgId, 'bsc'), FIRST);
  });

  test('every member is emailed, not just the requester', async () => {
    // A delay nobody is told about protects nothing, and the person who needs to
    // see it is precisely the one who did not make the request.
    const notices = mail.sent.filter((message) => /Payout address change/.test(message.subject));
    const recipients = notices.map((message) => message.to);

    assert.ok(recipients.includes(ownerEmail));
    assert.ok(recipients.includes(viewerEmail), 'the viewer must be warned too');
    assert.match(notices.at(-1)!.body, /If you did not request this/);
  });

  test('a second change for the same chain is refused while one is pending', async () => {
    await reElevate();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/payout-addresses`,
      headers: asOwner(),
      payload: { chain: 'bsc', address: '0x3333333333333333333333333333333333333333' },
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, 'change_already_pending');
  });

  test('a viewer can cancel a scheduled change', async () => {
    // The heart of the design: a compromised owner account must not be the only
    // party able to intervene.
    const listed = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/payout-addresses`,
      headers: asViewer(),
    });
    const pending = listed.json().pending[0];
    assert.equal(pending.address, ATTACKER);

    const cancelled = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/payout-addresses/pending/${pending.id}`,
      headers: asViewer(),
    });
    assert.equal(cancelled.statusCode, 204);

    // And the change can never apply, even once its time arrives.
    const applied = await payouts.applyDueChanges(new Date(Date.now() + 48 * 60 * 60 * 1000));
    assert.equal(applied, 0);
    assert.equal(await payouts.activeAddress(orgId, 'bsc'), FIRST);
  });

  test('cancelling twice is refused', async () => {
    const cancelledChange = await db
      .select()
      .from(schema.pendingChanges)
      .where(eq(schema.pendingChanges.organizationId, orgId));
    const target = cancelledChange.find((row) => row.cancelledAt !== null);

    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/payout-addresses/pending/${target!.id}`,
      headers: asOwner(),
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'already_cancelled');
  });

  test('an uncancelled change applies once the delay elapses', async () => {
    await reElevate();
    const requested = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/payout-addresses`,
      headers: asOwner(),
      payload: { chain: 'bsc', address: ATTACKER },
    });
    assert.equal(requested.statusCode, 202);

    // Not yet.
    assert.equal(await payouts.applyDueChanges(new Date(Date.now() + 23 * 60 * 60 * 1000)), 0);
    assert.equal(await payouts.activeAddress(orgId, 'bsc'), FIRST);

    // Now.
    assert.equal(await payouts.applyDueChanges(new Date(Date.now() + 25 * 60 * 60 * 1000)), 1);
    assert.equal(await payouts.activeAddress(orgId, 'bsc'), ATTACKER);
  });

  test('the superseded address is kept, not overwritten', async () => {
    // "Which address was active when this invoice settled" gets asked during a
    // dispute, and an overwritten column cannot answer it.
    const rows = await db
      .select()
      .from(schema.payoutAddresses)
      .where(eq(schema.payoutAddresses.organizationId, orgId));

    const superseded = rows.filter((row) => row.supersededAt !== null);
    const active = rows.filter((row) => row.supersededAt === null);

    assert.equal(superseded.length, 1);
    assert.equal(superseded[0]!.address, FIRST);
    assert.equal(active.length, 1, 'exactly one active address per chain');
    assert.equal(active[0]!.address, ATTACKER);
  });

  test('setting the address already in use is refused', async () => {
    await reElevate();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/payout-addresses`,
      headers: asOwner(),
      payload: { chain: 'bsc', address: ATTACKER },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'unchanged');
  });

  test('an elevated session that has gone stale must prove itself again', async () => {
    // Five minutes after the last code, the session is signed in but no longer
    // elevated — so a stolen cookie alone still cannot move the address.
    await db
      .update(schema.sessions)
      .set({ mfaSatisfiedAt: new Date(Date.now() - 10 * 60 * 1000) })
      .where(eq(schema.sessions.tokenHash, hashToken(ownerToken)));

    const response = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/payout-addresses`,
      headers: asOwner(),
      payload: { chain: 'polygon', address: FIRST },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error, 'elevation_required');
  });

  test('the audit trail records the whole sequence', async () => {
    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.organizationId, orgId));
    const actions = rows.map((row) => row.action);

    for (const action of [
      'payout_address.set',
      'payout_address.change_requested',
      'payout_address.change_cancelled',
      'payout_address.change_applied',
    ]) {
      assert.ok(actions.includes(action), `missing ${action} in the audit trail`);
    }
  });

  test('each chain has its own address, validated for that chain', async () => {
    await reElevate();

    // An EVM address on a TON payout would send funds nowhere recoverable.
    const wrong = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/payout-addresses`,
      headers: asOwner(),
      payload: { chain: 'ton', address: FIRST },
    });
    assert.equal(wrong.statusCode, 400);
    assert.equal(wrong.json().error, 'invalid_address');

    await reElevate();
    const right = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/payout-addresses`,
      headers: asOwner(),
      payload: { chain: 'ton', address: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs' },
    });
    // First address for TON, so immediate — and independent of the BSC one.
    assert.equal(right.statusCode, 201);
    assert.equal(await payouts.activeAddress(orgId, 'bsc'), ATTACKER);
  });
});

describe('watcher and webhooks end to end', { skip: databaseUrl ? false : 'DATABASE_URL not set' }, () => {
  let db: ReturnType<typeof createDatabase>['db'];
  let close: () => Promise<void>;
  let sink: DatabasePaymentSink;
  let store: DatabaseWatchStore;
  let webhooks: WebhookService;
  let posted: { url: string; body: string; headers: Record<string, string> }[];
  let respondWith: (attempt: number) => number;

  let orgId: string;
  let assetId: string;
  let invoiceId: string;
  const unique = randomBytes(6).toString('hex');
  const DEPOSIT = `0x${unique}${'cd'.repeat(14)}`;
  /**
   * Transaction hashes must be unique per run. The payments table's unique key is
   * global by design — a transfer is identified by where it happened — so a
   * hardcoded hash would already exist on a second run and the suite would pass
   * once and then fail against its own leftovers.
   */
  const tx = (name: string) => `0x${unique}${name}`;
  const MERCHANT_PAYOUT = '0x4444444444444444444444444444444444444444';

  const USDT: Asset = {
    symbol: 'USDT',
    chain: 'bsc',
    decimals: 18,
    kind: 'erc20',
    contract: '0x55d398326f99059fF775485246999027B3197955',
  };

  /** 20 whole tokens, the invoice amount throughout. */
  const DUE = 20n * 10n ** 18n;

  const transfer = (
    txHash: string,
    amount: bigint,
    blockNumber: number,
    confirmations = 30,
  ): IncomingPayment => ({
    chain: 'bsc',
    txHash,
    transferIndex: 0,
    to: DEPOSIT,
    asset: USDT,
    amount,
    blockNumber,
    confirmations,
  });

  before(async () => {
    const database = createDatabase(databaseUrl!);
    db = database.db;
    close = database.close;
    const audit = new AuditService(db);

    posted = [];
    respondWith = () => 200;

    webhooks = new WebhookService(
      db,
      new WebhookDispatcher({
        async post(url, body, headers) {
          posted.push({ url, body, headers: { ...headers } });
          return { statusCode: respondWith(posted.length) };
        },
      }),
    );

    sink = new DatabasePaymentSink(db, audit, webhooks, () => 20);
    store = new DatabaseWatchStore(db);

    const [org] = await db
      .insert(schema.organizations)
      .values({ name: 'Watcher Merchant', slug: `watch-${unique}` })
      .returning({ id: schema.organizations.id });
    orgId = org!.id;

    const [asset] = await db
      .insert(schema.assets)
      .values({
        chain: 'bsc',
        symbol: 'USDT',
        contract: `0x${unique}${'ff'.repeat(14)}`,
        decimals: 18,
        kind: 'erc20',
        verdict: 'approved',
        curated: false,
      })
      .returning({ id: schema.assets.id });
    assetId = asset!.id;

    const [invoice] = await db
      .insert(schema.invoices)
      .values({
        organizationId: orgId,
        assetId,
        chain: 'bsc',
        depositAddress: DEPOSIT,
        payoutAddress: MERCHANT_PAYOUT,
        amountDue: DUE.toString(),
        toleranceBps: 50,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })
      .returning({ id: schema.invoices.id });
    invoiceId = invoice!.id;

    await db.insert(schema.webhookEndpoints).values({
      organizationId: orgId,
      url: 'https://merchant.example.com/hooks',
      secret: 'whsec_integration',
      events: ['*'],
    });
  });

  after(async () => {
    await close?.();
  });

  const invoiceRow = async () => {
    const [row] = await db
      .select()
      .from(schema.invoices)
      .where(eq(schema.invoices.id, invoiceId));
    return row!;
  };

  test('a shallow transfer moves the invoice to confirming without crediting', async () => {
    await sink.credit(transfer(tx('shallow'), DUE, 100, 1));

    const invoice = await invoiceRow();
    assert.equal(invoice.status, 'confirming');
    assert.equal(invoice.amountPaid, '0', 'nothing credited yet');
  });

  test('a final transfer credits the invoice and marks it paid', async () => {
    await sink.credit(transfer(tx('paid'), DUE, 101));

    const invoice = await invoiceRow();
    assert.equal(invoice.status, 'paid');
    assert.equal(BigInt(invoice.amountPaid), DUE);
    assert.ok(invoice.paidAt !== null, 'paidAt should be stamped');
  });

  test('the same transfer credited twice changes nothing', async () => {
    // The unique constraint on (chain, txHash, transferIndex) is where the
    // exactly-once guarantee lives — enforced by the database, not by remembering.
    await sink.credit(transfer(tx('paid'), DUE, 101));
    await sink.credit(transfer(tx('paid'), DUE, 101));

    const invoice = await invoiceRow();
    assert.equal(BigInt(invoice.amountPaid), DUE, 'the total must not double');

    const rows = await db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.invoiceId, invoiceId));
    assert.equal(rows.length, 1, 'exactly one payment row');
  });

  test('a webhook was queued for the paid transition', async () => {
    const queued = await webhooks.history(orgId);
    const paid = queued.find((row) => row.event === 'invoice.paid');
    assert.ok(paid, 'a paid webhook should have been queued');
    assert.equal(paid.status, 'pending', 'queued, not delivered inline');
  });

  test('draining delivers the webhook, signed and verifiable', async () => {
    // Drains repeatedly, as the real worker does. Deliveries are taken oldest
    // first with a limit, so a backlog left by earlier runs can sit ahead of this
    // one — a state the worker handles rather than a failure.
    let delivery: (typeof posted)[number] | undefined;
    for (let pass = 0; pass < 20 && !delivery; pass++) {
      const tally = await webhooks.drain();
      delivery = posted.find(
        (post) =>
          post.headers['avex-event'] === 'invoice.paid' &&
          JSON.parse(post.body).invoiceId === invoiceId,
      );
      if (tally.delivered + tally.retrying + tally.failed + tally.abandoned === 0) break;
    }

    assert.ok(delivery, 'the paid event for this invoice should have been posted');

    // The merchant can verify it with their secret.
    assert.equal(
      verifyWebhook('whsec_integration', delivery.headers['avex-signature']!, delivery.body)
        .valid,
      true,
    );

    const body = JSON.parse(delivery.body);
    assert.equal(body.invoiceId, invoiceId);
    assert.equal(body.status, 'paid');
    // Amounts stay strings; a JSON number cannot hold an 18-decimal value.
    assert.equal(body.amountPaid, DUE.toString());
  });

  test('an unmatched transfer is refused rather than credited somewhere', async () => {
    await assert.rejects(
      () =>
        sink.credit({
          ...transfer(tx('stray'), DUE, 102),
          to: '0x9999999999999999999999999999999999999999',
        }),
      /no invoice matches/,
    );
  });

  test('a reorg reversal takes the invoice back out of paid', async () => {
    // The whole point of recomputing rather than incrementing: after a reorg the
    // total has to be able to go down.
    await sink.reverse(`bsc:${tx('paid')}:0`, 'reorg: rewound to block 95');

    const invoice = await invoiceRow();
    assert.equal(BigInt(invoice.amountPaid), 0n);
    assert.equal(invoice.status, 'pending', 'back to the start');

    const [payment] = await db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.txHash, tx('paid')));
    // Marked, not deleted: during an incident "what did we credit then take back"
    // is exactly the question.
    assert.ok(payment!.reversedAt !== null);
    assert.match(payment!.reversedReason!, /reorg/);
  });

  test('the merchant is told the payment was reversed', async () => {
    const queued = await webhooks.history(orgId);
    const reversed = queued.find((row) => row.event === 'payment.reversed');
    assert.ok(reversed, 'a reversal webhook is the one the merchant most needs');
  });

  test('an underpayment is classified, not silently accepted', async () => {
    // 10% short, well outside the 50bps tolerance.
    await sink.credit(transfer(tx('short'), (DUE * 90n) / 100n, 110));

    const invoice = await invoiceRow();
    assert.equal(invoice.status, 'underpaid');
  });

  test('a top-up brings an underpaid invoice to paid', async () => {
    await sink.credit(transfer(tx('topup'), (DUE * 10n) / 100n, 111));

    const invoice = await invoiceRow();
    assert.equal(BigInt(invoice.amountPaid), DUE);
    assert.equal(invoice.status, 'paid');
  });

  test('a payment inside tolerance still counts as paid', async () => {
    const [second] = await db
      .insert(schema.invoices)
      .values({
        organizationId: orgId,
        assetId,
        chain: 'bsc',
        depositAddress: `0x${unique}${'ab'.repeat(14)}`,
        payoutAddress: MERCHANT_PAYOUT,
        amountDue: DUE.toString(),
        toleranceBps: 50,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })
      .returning({ id: schema.invoices.id, depositAddress: schema.invoices.depositAddress });

    // 20 bps short — an exchange rounding a withdrawal, which must not read as
    // underpaid.
    await sink.credit({
      ...transfer(tx('rounded'), (DUE * 9980n) / 10_000n, 120),
      to: second!.depositAddress,
    });

    const [row] = await db
      .select()
      .from(schema.invoices)
      .where(eq(schema.invoices.id, second!.id));
    assert.equal(row!.status, 'paid');
  });

  test('watcher state survives a restart', async () => {
    await store.saveCursor('bsc', '12345', 12345);
    await store.rememberBlocks('bsc', [
      { number: 12345, hash: '0xaaa' },
      { number: 12344, hash: '0xbbb' },
    ]);

    // A fresh store instance, as a restarted process would have.
    const reloaded = new DatabaseWatchStore(db);
    const { cursor, scannedTo } = await reloaded.loadCursor('bsc');
    assert.equal(cursor, '12345');
    assert.equal(scannedTo, 12345);

    const blocks = await reloaded.recentBlocks('bsc', 10);
    assert.equal(blocks[0]?.number, 12345);
    assert.equal(blocks[0]?.hash, '0xaaa');
  });

  test('a changed hash at a known height overwrites the old one', async () => {
    // Reorg detection compares against this, so the newest observation must win.
    await store.rememberBlocks('bsc', [{ number: 12345, hash: '0xnew' }]);
    const blocks = await store.recentBlocks('bsc', 1);
    assert.equal(blocks[0]?.hash, '0xnew');
  });

  test('a failed poll records the error without advancing the cursor', async () => {
    await store.recordError('bsc', 'RPC timeout');

    const { cursor } = await store.loadCursor('bsc');
    // Advancing here would skip the range that failed.
    assert.equal(cursor, '12345');

    const status = await store.status();
    const bsc = status.find((row) => row.chain === 'bsc');
    assert.equal(bsc?.lastError, 'RPC timeout');
  });

  test('creditedAbove finds exactly the payments a rewind must revisit', async () => {
    const affected = await store.creditedAbove('bsc', 109);
    // Blocks 110, 111 and 120 are above; the reversed one at 101 is excluded.
    assert.ok(affected.includes(`bsc:${tx('short')}:0`));
    assert.ok(affected.includes(`bsc:${tx('topup')}:0`));
    assert.ok(!affected.includes(`bsc:${tx('paid')}:0`), 'already reversed, so not revisited');
  });

  test('forgetBlocksAbove drops only what a rewind invalidates', async () => {
    await store.rememberBlocks('bsc', [
      { number: 200, hash: '0x200' },
      { number: 201, hash: '0x201' },
    ]);
    await store.forgetBlocksAbove('bsc', 200);

    const numbers = (await store.recentBlocks('bsc', 50)).map((block) => block.number);
    assert.ok(numbers.includes(200));
    assert.ok(!numbers.includes(201));
  });

  test('a failing endpoint is retried, then surfaced as unhealthy', async () => {
    respondWith = () => 503;
    await webhooks.enqueue(orgId, 'invoice.paid', { invoiceId, probe: true }, `probe-${unique}`);

    const tally = await webhooks.drain();
    assert.ok(tally.retrying >= 1, 'a 503 must be retried');

    const unhealthy = await webhooks.unhealthyEndpoints(orgId);
    assert.ok(unhealthy.length > 0, 'an operator should see the stuck endpoint');
    assert.match(unhealthy[0]!.lastError!, /503/);
  });

  test('a duplicate enqueue with the same key does not double-notify', async () => {
    const queued = await webhooks.enqueue(
      orgId,
      'invoice.paid',
      { invoiceId, probe: true },
      `probe-${unique}`,
    );
    assert.equal(queued, 0, 'the unique constraint should collapse the duplicate');
  });

  test('a 4xx fails without consuming retries', async () => {
    respondWith = () => 404;
    const key = `notfound-${unique}`;
    await webhooks.enqueue(orgId, 'invoice.paid', { invoiceId }, key);

    /**
     * Assert on this delivery's own outcome, not on the tally.
     *
     * `drain` selects globally, oldest-first, capped at 50, so a backlog left by
     * another suite or an earlier run can sit ahead of this row and leave the tally
     * at zero while nothing is wrong. That made this test fail once under a parallel
     * run and pass on its own — the worst kind of red.
     */
    let status: string | undefined;
    for (let attempt = 0; attempt < 20 && status !== 'failed'; attempt++) {
      await webhooks.drain();
      const [row] = await db
        .select({ status: schema.webhookDeliveries.status })
        .from(schema.webhookDeliveries)
        .where(eq(schema.webhookDeliveries.idempotencyKey, key))
        .limit(1);
      status = row?.status;
    }

    assert.equal(status, 'failed', 'a wrong URL should fail rather than retry for hours');
  });
});

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import type { FastifyInstance } from 'fastify';

import { DEFAULT_AGGREGATION, DEFAULT_BREAKER, PriceService } from '@avex/core';
import type { PriceSource, PriceSymbol } from '@avex/core';

import { createDatabase } from '../db/client.js';
import { PriceTickWriter } from '../domain/price-repository.js';
import { AuditService } from '../domain/audit.js';
import { AuthService } from '../domain/auth-service.js';
import { totpCode } from '../auth/totp.js';
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
      env,
      db: database.db,
      audit,
      mailer,
      minPriceSources: DEFAULT_AGGREGATION.minSources,
      prices: new PriceService(
        [fakeSource('fake-a'), fakeSource('fake-b')],
        { aggregation: DEFAULT_AGGREGATION, breaker: DEFAULT_BREAKER, cacheTtlMs: 10_000 },
      ),
      auth: new AuthService(database.db, audit, {
        sessionTtlMs: 60 * 60 * 1000,
        emailTokenTtlMs: 60 * 60 * 1000,
      }),
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
    assert.equal(mailer.sent.at(-1)?.to, ownerEmail);
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

    app = buildServer({
      env,
      db: database.db,
      audit,
      mailer: new ConsoleMailer(env.APP_URL, () => {}),
      minPriceSources: 2,
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

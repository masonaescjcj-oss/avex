import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import { ContractProbe, DEFAULT_AGGREGATION, DEFAULT_BREAKER, PriceService } from '@avex/core';
import type { PriceSource } from '@avex/core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import { hashToken } from '../auth/tokens.js';
import { totpCode } from '../auth/totp.js';
import { createDatabase, schema } from '../db/client.js';
import { AdminService } from '../domain/admin-service.js';
import { AssetService } from '../domain/asset-service.js';
import { AuditService } from '../domain/audit.js';
import { AuthService } from '../domain/auth-service.js';
import { PayoutAddressService } from '../domain/payout-service.js';
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

  const unique = randomBytes(6).toString('hex');
  const staffPassword = 'a-long-enough-staff-password';
  const merchantPassword = 'a-sufficiently-long-password';

  const superadminEmail = `root-${unique}@avex.test`;
  const supportEmail = `support-${unique}@avex.test`;
  const merchantEmail = `merchant-${unique}@example.com`;

  let superadminSecret: string;
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
      admin: new AdminService(db, audit),
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

  async function countAudit(action: string): Promise<number> {
    const response = await app.inject({
      method: 'GET',
      url: `/admin/audit?action=${encodeURIComponent(action)}&limit=200`,
      headers: asStaff(superadminToken),
    });
    return (response.json().rows as unknown[]).length;
  }
});

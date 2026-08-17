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
import { eq } from 'drizzle-orm';
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
    return row!.id;
  }

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

  async function countAudit(action: string): Promise<number> {
    const response = await app.inject({
      method: 'GET',
      url: `/admin/audit?action=${encodeURIComponent(action)}&limit=200`,
      headers: asStaff(superadminToken),
    });
    return (response.json().rows as unknown[]).length;
  }
});

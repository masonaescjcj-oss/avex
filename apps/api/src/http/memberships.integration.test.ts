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
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import { createDatabase } from '../db/client.js';
import { memberships } from '../db/schema.js';
import { totpCode } from '../auth/totp.js';
import { CommissionLedger } from '../domain/commission-ledger.js';
import { WalletPoolChanges, WalletPoolService } from '../domain/wallet-pool-service.js';
import { AdminService } from '../domain/admin-service.js';
import { AssetService } from '../domain/asset-service.js';
import { AuditService } from '../domain/audit.js';
import { AuthService } from '../domain/auth-service.js';
import { CheckoutService } from '../domain/checkout-service.js';
import { DepositAddressDeriver } from '../domain/deposit-address.js';
import { FeePlanService } from '../domain/fee-plan-service.js';
import { InviteService } from '../domain/invite-service.js';
import { InvoiceCreationService } from '../domain/invoice-creation.js';
import { MembershipService } from '../domain/membership-service.js';
import { MerchantService } from '../domain/merchant-service.js';
import { PayoutAddressService } from '../domain/payout-service.js';
import { ReconciliationService } from '../domain/reconciliation-service.js';
import { SettlementStore } from '../domain/settlement-store.js';
import { StaffAuthService } from '../domain/staff-auth.js';
import { WebhookService } from '../domain/webhook-service.js';
import { loadEnv } from '../env.js';
import { ConsoleMailer } from '../mailer.js';
import { buildServer } from './server.js';

/**
 * Removing somebody, and changing what they can do.
 *
 * One invariant is the reason this suite exists: an organisation always has at least one
 * owner. Owner is the only role that can change where money is sent, so an organisation
 * with none is one whose payout address can never be changed again — by anybody, including
 * us, short of an operator reaching into the database. Every path that could reach that
 * state is a test below: removing the last owner, demoting them, and an owner stepping back
 * before handing over.
 *
 * The rest is about the difference between the two operations. Changing a role is
 * owner-only and elevated because it can hand somebody the payout address. Removing
 * somebody else is elevated too. Leaving is neither, or a viewer could never leave and
 * somebody who never enrolled an authenticator would be trapped.
 */
const databaseUrl = process.env.DATABASE_URL;

const FACTORY = '0x00000000000000000000000000000000000f4c70';
const CREATION_CODE = '0x60806040523480156100115760006000fd5b50';
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

const source = (name: string): PriceSource => ({
  name,
  supports: () => true,
  async fetchUsdPrice() {
    return { priceScaled: 10n ** 18n, observedAt: Date.now() };
  },
});

describe('removing members and changing roles', {
  skip: databaseUrl ? false : 'DATABASE_URL not set',
}, () => {
  let app: FastifyInstance;
  let db: ReturnType<typeof createDatabase>['db'];
  let close: () => Promise<void>;
  let mailer: ConsoleMailer;
  let auth: AuthService;

  const unique = randomBytes(6).toString('hex');
  const password = 'a-sufficiently-long-password';

  const ownerEmail = `mem-owner-${unique}@example.com`;

  let ownerToken: string;
  let ownerSecret: string;
  let ownerUserId: string;
  let orgId: string;

  const asOwner = () => ({ authorization: `Bearer ${ownerToken}` });

  /**
   * Sign somebody up, returning a live session and their user id.
   *
   * The session comes from `auth.login` rather than from `POST /v1/auth/login`, which is
   * deliberate and not a shortcut around anything under test. That route allows ten attempts
   * a quarter hour *per address* — each one being a guess at a secret — and this suite needs
   * a dozen accounts from one address, so going through it made tests two thirds of the way
   * down the file fail as 429s about sign-in. The limiter has its own tests; what is under
   * test here is memberships.
   */
  async function account(email: string): Promise<{ token: string; userId: string }> {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email, password, organizationName: `Org for ${email}` },
    });
    assert.equal(created.statusCode, 201, created.body);

    const session = await auth.login(email, password);
    assert.equal(session.status, 'ok', JSON.stringify(session));
    return { token: (session as { sessionToken: string }).sessionToken, userId: created.json().userId };
  }

  /**
   * Put somebody into the owner's organisation at a given role, through the real path.
   *
   * Invite and accept rather than an insert, so what these tests remove is a membership
   * that arrived the way memberships actually arrive.
   */
  async function join(email: string, role: string): Promise<{ token: string; userId: string }> {
    const person = await account(email);
    const invited = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/members`,
      headers: asOwner(),
      payload: { email, role },
    });
    assert.equal(invited.statusCode, 202, invited.body);

    const mail = mailer.sent.at(-1)!;
    const [, link] = mail.body.match(/(https?:\/\/\S+)/) ?? [];
    const token = new URL(link!).searchParams.get('invite');
    const accepted = await app.inject({
      method: 'POST',
      url: '/v1/invites/accept',
      headers: { authorization: `Bearer ${person.token}` },
      payload: { token },
    });
    assert.equal(accepted.statusCode, 201, accepted.body);
    return person;
  }

  /**
   * Prove the owner's second factor.
   *
   * Called once in `before`, and once more by the test that deliberately lets elevation
   * lapse. Not per test: `/v1/auth/mfa` allows ten attempts a quarter hour per user, because
   * each one is a guess at a secret, and re-elevating in every test spent that budget about
   * two thirds of the way down this file — which failed as a 429 in tests that had nothing to
   * do with rate limiting. Elevation lasts five minutes and this suite takes about a second.
   */
  async function elevate(): Promise<void> {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa',
      headers: asOwner(),
      payload: { code: totpCode(ownerSecret) },
    });
    assert.equal(response.statusCode, 200, response.body);
  }

  const changeRole = (userId: string, role: string, headers = asOwner()) =>
    app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${orgId}/members/${userId}`,
      headers,
      payload: { role },
    });

  const remove = (userId: string, headers = asOwner()) =>
    app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/members/${userId}`,
      headers,
    });

  const roleOf = async (userId: string): Promise<string | null> => {
    const [row] = await db
      .select({ role: memberships.role, revokedAt: memberships.revokedAt })
      .from(memberships)
      .where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, userId)))
      .limit(1);
    return !row || row.revokedAt !== null ? null : row.role;
  };

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
    mailer = new ConsoleMailer(env.APP_URL, () => {});
    auth = new AuthService(db, audit, {
      sessionTtlMs: 60 * 60 * 1000,
      emailTokenTtlMs: 60 * 60 * 1000,
    });

    const prices = new PriceService([source('a'), source('b')], {
      aggregation: DEFAULT_AGGREGATION,
      breaker: DEFAULT_BREAKER,
      cacheTtlMs: 0,
    });
    const feePlans = new FeePlanService(db, audit, { feeCollectors: {} });
    const deriver = new DepositAddressDeriver(
      {
        evm: { bsc: { factory: FACTORY, forwarderCreationCode: CREATION_CODE } },
        shared: { ton: TON_WALLET },
      },
      'membership-suite-memo-secret',
    );
    const rates = { requireRate: (symbol: never) => prices.requireRate(symbol) };
    const invoiceCreation = new InvoiceCreationService(db, deriver, feePlans, rates, audit);
    const settlements = new SettlementStore(db);
    const reconciliation = new ReconciliationService(db, audit, {
      async recompute() {
        throw new Error('not exercised here');
      },
    });

    app = buildServer({
      ledger: new CommissionLedger(db),
      walletPool: new WalletPoolService(db),
      walletChanges: new WalletPoolChanges(db, new WalletPoolService(db), audit, mailer),
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
      auth,
      staffAuth: new StaffAuthService(db, audit),
      settlements,
      reconciliation,
      admin: new AdminService(db, audit, settlements, reconciliation),
      merchant: new MerchantService(db),
      webhooks: new WebhookService(
        db,
        new WebhookDispatcher({
          async post() {
            return { statusCode: 200 };
          },
        }),
      ),
      feePlans,
      invoiceCreation,
      checkouts: new CheckoutService(db, invoiceCreation, feePlans, deriver, rates, audit),
    });
    await app.ready();

    const owner = await account(ownerEmail);
    ownerToken = owner.token;
    ownerUserId = owner.userId;

    const organizations = await app.inject({
      method: 'GET',
      url: '/v1/organizations',
      headers: asOwner(),
    });
    orgId = organizations.json().data[0].id;

    // Both operations are elevation-gated, so the owner needs an authenticator.
    const enroll = await app.inject({
      method: 'POST',
      url: '/v1/auth/totp/enroll',
      headers: asOwner(),
    });
    ownerSecret = enroll.json().secret;
    await app.inject({
      method: 'POST',
      url: '/v1/auth/totp/confirm',
      headers: asOwner(),
      payload: { code: totpCode(ownerSecret) },
    });
    await elevate();
  });

  after(async () => {
    await app?.close();
    await close?.();
  });

  test('a role change moves somebody and reports both ends', async () => {
    // Both ends, because "was made an admin" and "was demoted to admin" are different
    // events and only the pair tells them apart.
    const person = await join(`promote-${unique}@example.com`, 'viewer');

    const response = await changeRole(person.userId, 'admin');
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { status: 'changed', from: 'viewer', to: 'admin' });
    assert.equal(await roleOf(person.userId), 'admin');
  });

  test('a role change takes effect on the next request the person makes', async () => {
    /**
     * Nothing invalidates their session, and nothing has to: the role is read from the
     * memberships table on every request. Worth asserting because the alternative design —
     * a role cached in the session — would leave a demoted admin holding admin rights until
     * they happened to sign out.
     */
    const person = await join(`demote-${unique}@example.com`, 'admin');
    const headers = { authorization: `Bearer ${person.token}` };

    // An admin may read the pending invitations list.
    const before_ = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/members`,
      headers,
      payload: { email: `x-${unique}@example.com`, role: 'viewer' },
    });
    assert.equal(before_.statusCode, 202, before_.body);

    assert.equal((await changeRole(person.userId, 'viewer')).statusCode, 200);

    const after_ = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/members`,
      headers,
      payload: { email: `y-${unique}@example.com`, role: 'viewer' },
    });
    assert.equal(after_.statusCode, 403, after_.body);
  });

  test('setting the role somebody already has changes nothing and logs nothing', async () => {
    // Recording a change that did not happen puts noise in the one log that has to be worth
    // reading during an incident.
    const person = await join(`same-${unique}@example.com`, 'developer');

    const response = await changeRole(person.userId, 'developer');
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { status: 'unchanged', role: 'developer' });

    const log = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/audit-log`,
      headers: asOwner(),
    });
    const changes = log
      .json()
      .data.filter(
        (row: { action: string; targetId: string }) =>
          row.action === 'member.role_changed' && row.targetId === person.userId,
      );
    assert.equal(changes.length, 0, JSON.stringify(changes));
  });

  test('removing somebody revokes the membership rather than deleting it', async () => {
    /**
     * "When did this person lose access" is asked during incidents, and a deleted row cannot
     * answer it. It is also what makes re-inviting them reinstate rather than duplicate.
     */
    const person = await join(`removed-${unique}@example.com`, 'developer');

    const response = await remove(person.userId);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(await roleOf(person.userId), null);

    const [row] = await db
      .select({ revokedAt: memberships.revokedAt })
      .from(memberships)
      .where(
        and(eq(memberships.organizationId, orgId), eq(memberships.userId, person.userId)),
      )
      .limit(1);
    assert.ok(row, 'the row must survive the removal');
    assert.ok(row.revokedAt instanceof Date);
  });

  test('a removed member is locked out on their next request', async () => {
    const person = await join(`locked-${unique}@example.com`, 'developer');
    const headers = { authorization: `Bearer ${person.token}` };
    assert.equal(
      (await app.inject({ method: 'GET', url: `/v1/organizations/${orgId}/members`, headers }))
        .statusCode,
      200,
    );

    assert.equal((await remove(person.userId)).statusCode, 200);

    const after_ = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/members`,
      headers,
    });
    assert.equal(after_.statusCode, 404, after_.body);
  });

  test('a removed member is told, and a departing one is not', async () => {
    /**
     * Somebody who was removed otherwise finds out from a 404, which reads as the product
     * being broken rather than a decision having been made. Somebody who left does not need
     * an email about leaving.
     */
    const removed = await join(`told-${unique}@example.com`, 'viewer');
    assert.equal((await remove(removed.userId)).statusCode, 200);
    const notice = mailer.sent.at(-1)!;
    assert.equal(notice.to, `told-${unique}@example.com`);
    assert.match(notice.subject, /access .* removed/i);
    // Their account is not gone, and the mail says so — that is the first thing they will
    // wonder.
    assert.match(notice.body, /account itself is unchanged/i);

    const before = mailer.sent.length;
    const leaver = await join(`leaver-${unique}@example.com`, 'viewer');
    const sentDuringJoin = mailer.sent.length;
    assert.ok(sentDuringJoin > before, 'joining sends the invitation mail');

    const left = await remove(leaver.userId, { authorization: `Bearer ${leaver.token}` });
    assert.equal(left.statusCode, 200, left.body);
    assert.equal(mailer.sent.length, sentDuringJoin, 'leaving should send no mail');
  });

  test('a viewer can leave without holding the permission to remove anybody', async () => {
    /**
     * Two authorisation paths on one route, because they are two different acts. A viewer has
     * no `member:remove`, and if leaving needed it there would be no way out of an
     * organisation at all.
     */
    const person = await join(`leaving-${unique}@example.com`, 'viewer');
    const headers = { authorization: `Bearer ${person.token}` };

    // They cannot remove somebody else.
    const other = await join(`other-${unique}@example.com`, 'viewer');
    const refused = await remove(other.userId, headers);
    assert.equal(refused.statusCode, 403, refused.body);

    // They can remove themselves, with no authenticator enrolled and no elevation.
    const left = await remove(person.userId, headers);
    assert.equal(left.statusCode, 200, left.body);
    assert.equal(await roleOf(person.userId), null);
  });

  test('the last owner cannot be removed', async () => {
    /**
     * The invariant. Owner is the only role that can change where money is sent, so an
     * organisation with no owner is one whose payout address can never be changed again.
     */
    const response = await remove(ownerUserId);
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error, 'last_owner');
    assert.equal(await roleOf(ownerUserId), 'owner');
  });

  test('the last owner cannot leave either', async () => {
    // Same invariant reached by the path somebody would actually take: stepping back before
    // handing over. The message says which, because the remedy is different from a refusal.
    const response = await remove(ownerUserId, asOwner());
    assert.equal(response.statusCode, 409, response.body);
    assert.match(response.json().message, /before you leave/i);
    assert.equal(await roleOf(ownerUserId), 'owner');
  });

  test('the last owner cannot be demoted', async () => {
    // The other way to reach zero owners, and the likelier one: handing over in the wrong
    // order.
    const response = await changeRole(ownerUserId, 'admin');
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error, 'last_owner');
    assert.match(response.json().message, /somebody else an owner first/i);
    assert.equal(await roleOf(ownerUserId), 'owner');
  });

  test('an owner may step back once there is a second owner', async () => {
    /**
     * The invariant is "at least one", not "the first one forever". Handing over has to be
     * possible or the refusals above become a trap rather than a guard.
     */
    const heir = await join(`heir-${unique}@example.com`, 'viewer');
    assert.equal((await changeRole(heir.userId, 'owner')).statusCode, 200);

    const stepBack = await changeRole(ownerUserId, 'admin');
    assert.equal(stepBack.statusCode, 200, stepBack.body);
    assert.equal(await roleOf(ownerUserId), 'admin');

    // Put it back, so the rest of the suite still has its owner — and now the heir is the
    // one who has to be demoted, which the invariant permits because there are two.
    const heirHeaders = { authorization: `Bearer ${heir.token}` };
    const enroll = await app.inject({
      method: 'POST',
      url: '/v1/auth/totp/enroll',
      headers: heirHeaders,
    });
    const heirSecret = enroll.json().secret;
    await app.inject({
      method: 'POST',
      url: '/v1/auth/totp/confirm',
      headers: heirHeaders,
      payload: { code: totpCode(heirSecret) },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa',
      headers: heirHeaders,
      payload: { code: totpCode(heirSecret) },
    });
    const restored = await app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${orgId}/members/${ownerUserId}`,
      headers: heirHeaders,
      payload: { role: 'owner' },
    });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(await roleOf(ownerUserId), 'owner');
  });

  test('an admin cannot change anybody\'s role', async () => {
    // `member:role_change` is the owner's alone: it is the operation that can hand somebody
    // the payout address, which is the one thing admins deliberately cannot reach.
    const admin = await join(`nonowner-${unique}@example.com`, 'admin');
    const victim = await join(`victim-${unique}@example.com`, 'viewer');

    const response = await changeRole(victim.userId, 'owner', {
      authorization: `Bearer ${admin.token}`,
    });
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(await roleOf(victim.userId), 'viewer');
  });

  test('changing a role without a fresh second factor is refused', async () => {
    /**
     * A stolen session must not be enough. Proved by letting the elevation lapse rather than
     * by asserting on a flag — the check is against a timestamp, and only the clock exercises
     * it.
     */
    const person = await join(`stale-${unique}@example.com`, 'viewer');

    // Push the last proof out of the window.
    const past = new Date(Date.now() - 60 * 60 * 1000);
    await db.execute(
      // eslint-disable-next-line no-restricted-syntax -- one column, no schema helper for it
      `update sessions set mfa_satisfied_at = '${past.toISOString()}' where user_id = '${ownerUserId}'`,
    );

    const response = await changeRole(person.userId, 'admin');
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(response.json().error, 'elevation_required');
    assert.equal(await roleOf(person.userId), 'viewer');

    // Restored, because every test after this one is elevation-gated too.
    await elevate();
  });

  test('a member of another organisation is a 404, in both directions', async () => {
    /**
     * Tenancy. Both halves are driven by this suite's owner, who is elevated: an id that is
     * not a member here, and an organisation they are not a member of. Either would be a data
     * leak if it answered differently from the other.
     */
    const stranger = await account(`unrelated-${unique}@example.com`);
    assert.equal((await remove(stranger.userId)).statusCode, 404);

    const theirs = await app.inject({
      method: 'GET',
      url: '/v1/organizations',
      headers: { authorization: `Bearer ${stranger.token}` },
    });
    const theirOrg = theirs.json().data[0].id;
    const crossTenant = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${theirOrg}/members/${stranger.userId}`,
      headers: asOwner(),
    });
    assert.equal(crossTenant.statusCode, 404, crossTenant.body);
    // And the stranger still owns their own organisation.
    const [theirRow] = await db
      .select({ role: memberships.role })
      .from(memberships)
      .where(
        and(eq(memberships.organizationId, theirOrg), eq(memberships.userId, stranger.userId)),
      )
      .limit(1);
    assert.equal(theirRow?.role, 'owner');
  });

  test('the second-factor requirement is reported before the target is looked up', async () => {
    /**
     * Asserted rather than discovered, because the ordering is a decision and this is the
     * only place it is written down.
     *
     * `requirePermission` refuses an elevation-gated action for somebody with no
     * authenticator before any handler runs, so a member id that does not exist here comes
     * back as "enrol an authenticator" rather than as a 404. That is the right way round: it
     * tells them the thing they can act on, and it does not confirm or deny that the id means
     * anything.
     */
    const noAuthenticator = await account(`bare-${unique}@example.com`);
    const theirs = await app.inject({
      method: 'GET',
      url: '/v1/organizations',
      headers: { authorization: `Bearer ${noAuthenticator.token}` },
    });
    const theirOrg = theirs.json().data[0].id;

    const response = await app.inject({
      method: 'DELETE',
      // A uuid that is nobody, in an organisation they own.
      url: `/v1/organizations/${theirOrg}/members/00000000-0000-4000-8000-000000000000`,
      headers: { authorization: `Bearer ${noAuthenticator.token}` },
    });
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(response.json().error, 'two_factor_required');
    assert.equal(response.json().permission, 'member:remove');
  });

  test('removing somebody leaves the API keys they created working', async () => {
    /**
     * Keys belong to the organisation, not to the person who typed them in — revoking them
     * on departure would take production down as a side effect of an HR action. Said in the
     * response, because the alternative is an operator assuming access is gone when a live
     * key is still out there.
     */
    const person = await join(`keyholder-${unique}@example.com`, 'developer');

    const response = await remove(person.userId);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().apiKeysUnaffected, true);
  });

  test('a removed member stops vouching for the invitations they sent', async () => {
    /**
     * The other half of the invitation design, from this side. A departing admin's pending
     * invitations must not still be admitting people — and nobody knows to withdraw an
     * invitation they cannot see.
     */
    const admin = await join(`departing-${unique}@example.com`, 'admin');
    const recruit = await account(`recruit-${unique}@example.com`);

    const invited = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/members`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { email: `recruit-${unique}@example.com`, role: 'viewer' },
    });
    assert.equal(invited.statusCode, 202, invited.body);
    const mail = mailer.sent.at(-1)!;
    const [, link] = mail.body.match(/(https?:\/\/\S+)/) ?? [];
    const inviteToken = new URL(link!).searchParams.get('invite');

    assert.equal((await remove(admin.userId)).statusCode, 200);

    const accepted = await app.inject({
      method: 'POST',
      url: '/v1/invites/accept',
      headers: { authorization: `Bearer ${recruit.token}` },
      payload: { token: inviteToken },
    });
    assert.equal(accepted.statusCode, 409, accepted.body);
    assert.equal(accepted.json().error, 'invite_no_longer_valid');
  });

  test('the audit log records both acts, with what changed', async () => {
    const log = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/audit-log`,
      headers: asOwner(),
    });
    assert.equal(log.statusCode, 200, log.body);
    const rows = log.json().data as {
      action: string;
      metadata: Record<string, unknown> | null;
    }[];

    const removed = rows.find((row) => row.action === 'member.removed');
    assert.ok(removed, 'a removal should be recorded');
    assert.ok(removed.metadata?.role, JSON.stringify(removed.metadata));
    // Whether they left or were shown the door, which is the interesting difference.
    assert.equal(typeof removed.metadata?.self, 'boolean');

    const changed = rows.find((row) => row.action === 'member.role_changed');
    assert.ok(changed, 'a role change should be recorded');
    assert.ok(changed.metadata?.from, JSON.stringify(changed.metadata));
    assert.ok(changed.metadata?.to, JSON.stringify(changed.metadata));

    // A departure is recorded as one.
    const departures = rows.filter(
      (row) => row.action === 'member.removed' && row.metadata?.self === true,
    );
    assert.ok(departures.length > 0, 'somebody left in this suite and it should say so');
  });
});

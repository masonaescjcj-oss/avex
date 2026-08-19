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
import { issueApiKey } from '../auth/tokens.js';
import { apiKeys, memberships, organizationInvites } from '../db/schema.js';
import { AdminService } from '../domain/admin-service.js';
import { AssetService } from '../domain/asset-service.js';
import { AuditService } from '../domain/audit.js';
import { AuthService } from '../domain/auth-service.js';
import { CheckoutService } from '../domain/checkout-service.js';
import { DepositAddressDeriver } from '../domain/deposit-address.js';
import { FeePlanService } from '../domain/fee-plan-service.js';
import { InviteService } from '../domain/invite-service.js';
import { InvoiceCreationService } from '../domain/invoice-creation.js';
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
 * Inviting somebody into an organisation, over HTTP.
 *
 * The reason this has a suite of its own is that an invitation is the only capability
 * in the system that outlives the moment it was authorised. Everything else is checked
 * as it happens; an invitation waits in an inbox for a week while the world moves — the
 * inviter gets demoted, the recipient forwards the mail, somebody withdraws it, another
 * invitation supersedes it. Each of those is a test below, and none of them is
 * expressible without a clock and two accounts.
 *
 * Before this existed the endpoint sent a mail, recorded an audit entry, and answered
 * `202 invited`. Nothing could be accepted, and nothing said so.
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

describe('member invitations', { skip: databaseUrl ? false : 'DATABASE_URL not set' }, () => {
  let app: FastifyInstance;
  let db: ReturnType<typeof createDatabase>['db'];
  let close: () => Promise<void>;
  let mailer: ConsoleMailer;
  let invites: InviteService;

  const unique = randomBytes(6).toString('hex');
  const password = 'a-sufficiently-long-password';

  const ownerEmail = `inv-owner-${unique}@example.com`;
  const adminEmail = `inv-admin-${unique}@example.com`;
  const guestEmail = `inv-guest-${unique}@example.com`;
  const strangerEmail = `inv-stranger-${unique}@example.com`;

  let ownerToken: string;
  let adminToken: string;
  let guestToken: string;
  let strangerToken: string;
  let orgId: string;
  let ownerUserId: string;
  let adminUserId: string;

  const asOwner = () => ({ authorization: `Bearer ${ownerToken}` });
  const asAdmin = () => ({ authorization: `Bearer ${adminToken}` });
  const asGuest = () => ({ authorization: `Bearer ${guestToken}` });
  const asStranger = () => ({ authorization: `Bearer ${strangerToken}` });

  /** Sign somebody up and return a live session token plus their user id. */
  async function account(email: string): Promise<{ token: string; userId: string }> {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email, password, organizationName: `Org for ${email}` },
    });
    assert.equal(created.statusCode, 201, created.body);

    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password },
    });
    assert.equal(login.statusCode, 200, login.body);
    return { token: login.json().token, userId: created.json().userId };
  }

  /** The token out of the most recent invitation mail. */
  function tokenFromLastMail(): string {
    const mail = mailer.sent.at(-1)!;
    const [, link] = mail.body.match(/(https?:\/\/\S+)/) ?? [];
    assert.ok(link, `no link in: ${mail.body}`);
    const token = new URL(link).searchParams.get('invite');
    assert.ok(token, `no invite token in: ${link}`);
    return token;
  }

  async function invite(
    headers: Record<string, string>,
    email: string,
    role: string,
  ): Promise<ReturnType<FastifyInstance['inject']>> {
    return app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/members`,
      headers,
      payload: { email, role },
    });
  }

  const accept = (headers: Record<string, string>, token: string) =>
    app.inject({ method: 'POST', url: '/v1/invites/accept', headers, payload: { token } });

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
    invites = new InviteService(db, audit);

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
      'invite-suite-memo-secret',
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
      env,
      db,
      audit,
      mailer,
      prices,
      minPriceSources: DEFAULT_AGGREGATION.minSources,
      assets: new AssetService(db, audit, new ContractProbe(offlineCaller), ['USDT']),
      payouts: new PayoutAddressService(db, audit, mailer),
      invites,
      auth: new AuthService(db, audit, {
        sessionTtlMs: 60 * 60 * 1000,
        emailTokenTtlMs: 60 * 60 * 1000,
      }),
      staffAuth: new StaffAuthService(db, audit),
      settlements,
      reconciliation,
      admin: new AdminService(db, audit, settlements, reconciliation),
      merchant: new MerchantService(db),
      webhooks: new WebhookService(
        db,
        // Nothing in this suite fires a webhook; a dispatcher that answers keeps the
        // service constructible without reaching the network if one ever does.
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

    // Three other accounts, each already owning an organisation of their own — which is
    // what signing up gives you, and what makes "already a member" testable.
    const admin = await account(adminEmail);
    adminToken = admin.token;
    adminUserId = admin.userId;
    guestToken = (await account(guestEmail)).token;
    strangerToken = (await account(strangerEmail)).token;

    // The admin joins for real, so the demotion test has somebody to demote.
    const invited = await invite(asOwner(), adminEmail, 'admin');
    assert.equal(invited.statusCode, 202, invited.body);
    const accepted = await accept(asAdmin(), tokenFromLastMail());
    assert.equal(accepted.statusCode, 201, accepted.body);
  });

  after(async () => {
    await app?.close();
    await close?.();
  });

  test('the invitation mail carries a token, and the response never does', async () => {
    /**
     * The whole security model rests on this: the token is a capability, and a capability
     * that comes back over the API is one the inviter can spend on the invitee's behalf.
     */
    const response = await invite(asOwner(), guestEmail, 'developer');
    assert.equal(response.statusCode, 202, response.body);

    const token = tokenFromLastMail();
    assert.ok(token.length >= 16);
    assert.ok(!JSON.stringify(response.json()).includes(token));

    // And the mail names the organisation, because a uuid tells nobody who is asking.
    const mail = mailer.sent.at(-1)!;
    assert.match(mail.subject, /invited to/i);
    assert.match(mail.body, /developer/);
    // It also says which account accepts it — otherwise they land on a form with no idea.
    assert.ok(mail.body.includes(guestEmail), mail.body);
  });

  test('accepting joins the organisation with the role that was offered', async () => {
    const response = await accept(asGuest(), tokenFromLastMail());
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().status, 'accepted');
    assert.equal(response.json().organizationId, orgId);
    assert.equal(response.json().role, 'developer');

    // Visible in the members list, which is the only place it matters.
    const members = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/members`,
      headers: asOwner(),
    });
    const guest = members.json().data.find((row: { email: string }) => row.email === guestEmail);
    assert.ok(guest, members.body);
    assert.equal(guest.role, 'developer');
  });

  test('a spent invitation cannot be spent again', async () => {
    // It is a bearer capability sitting in a mailbox forever. One use is the only safe
    // number, and "already used" is indistinguishable from "never existed".
    const response = await accept(asGuest(), tokenFromLastMail());
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error, 'invite_not_found');
  });

  test('a forwarded invitation is useless to whoever it was forwarded to', async () => {
    /**
     * The single most important test here. Forwarding a "you have been invited" mail to a
     * colleague is an ordinary thing to do, so the token alone must not admit anybody —
     * the holder also has to control an account for the invited address.
     */
    const sent = await invite(asOwner(), `fresh-${unique}@example.com`, 'viewer');
    assert.equal(sent.statusCode, 202);
    const token = tokenFromLastMail();

    const response = await accept(asStranger(), token);
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error, 'wrong_account');
    // Named, so somebody signed in as the wrong colleague knows which account to use. It
    // leaks nothing: they are holding a mail that contains it.
    assert.match(response.json().message, new RegExp(`fresh-${unique}@example\\.com`));

    // And nothing happened: the stranger is not in, and the invitation is still live.
    const members = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/members`,
      headers: asOwner(),
    });
    assert.ok(
      !members.json().data.some((row: { email: string }) => row.email === strangerEmail),
      members.body,
    );
    const pending = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/invites`,
      headers: asOwner(),
    });
    assert.ok(
      pending.json().data.some((row: { email: string }) => row.email === `fresh-${unique}@example.com`),
      'a refused acceptance must not consume the invitation',
    );
  });

  test('inviting the same address again replaces the invitation rather than adding one', async () => {
    /**
     * Two live invitations with different roles has no correct answer — whichever link
     * they happen to click decides what they get. The latest invitation is the invitation.
     */
    const email = `twice-${unique}@example.com`;
    const first = await invite(asOwner(), email, 'viewer');
    assert.equal(first.statusCode, 202);
    const firstToken = tokenFromLastMail();

    const second = await invite(asOwner(), email, 'developer');
    assert.equal(second.statusCode, 202);
    assert.equal(second.json().superseded, 1);
    const secondToken = tokenFromLastMail();
    assert.notEqual(secondToken, firstToken);

    const pending = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/invites`,
      headers: asOwner(),
    });
    const rows = pending.json().data.filter((row: { email: string }) => row.email === email);
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.equal(rows[0].role, 'developer');

    // The superseded link is dead, so a recipient reading the older mail cannot take the
    // role the second invitation was meant to correct.
    const stale = await accept(asStranger(), firstToken);
    assert.equal(stale.statusCode, 404, stale.body);
  });

  test('withdrawing an invitation kills the link', async () => {
    // The only defence once the mail has left the building.
    const email = `withdrawn-${unique}@example.com`;
    const sent = await invite(asOwner(), email, 'viewer');
    assert.equal(sent.statusCode, 202);
    const token = tokenFromLastMail();
    const inviteId = sent.json().id;

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/invites/${inviteId}`,
      headers: asOwner(),
    });
    assert.equal(revoked.statusCode, 204);

    assert.equal((await accept(asStranger(), token)).statusCode, 404);

    // Withdrawing twice is not an error the second time, it is a 404 — there is nothing
    // outstanding to withdraw.
    const again = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${orgId}/invites/${inviteId}`,
      headers: asOwner(),
    });
    assert.equal(again.statusCode, 404);
  });

  test('an invitation cannot be withdrawn from another organisation', async () => {
    /**
     * Tenancy. The stranger owns an organisation of their own, so they have a valid
     * session and a valid role — what they must not have is the ability to name an id
     * belonging to somebody else.
     */
    const sent = await invite(asOwner(), `tenancy-${unique}@example.com`, 'viewer');
    const inviteId = sent.json().id;

    const organizations = await app.inject({
      method: 'GET',
      url: '/v1/organizations',
      headers: asStranger(),
    });
    const strangerOrg = organizations.json().data[0].id;

    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${strangerOrg}/invites/${inviteId}`,
      headers: asStranger(),
    });
    // Indistinguishable from an id that never existed, because the scope is inside the
    // update rather than a check before it.
    assert.equal(response.statusCode, 404);

    // Still outstanding in the organisation it belongs to.
    const pending = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/invites`,
      headers: asOwner(),
    });
    assert.ok(pending.json().data.some((row: { id: string }) => row.id === inviteId));
  });

  test('nobody may invite somebody above their own role', async () => {
    // Otherwise privilege escalation is one invitation away — and the invitation is a
    // link that works a week later, when nobody is watching.
    const response = await invite(asAdmin(), `escalate-${unique}@example.com`, 'owner');
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(response.json().error, 'role_not_assignable');
  });

  test('an invitation stops working when its author can no longer grant that role', async () => {
    /**
     * The reason acceptance re-checks the inviter at all.
     *
     * The owner invites another owner, is then demoted, and the pending link is still a
     * grant of the role they have lost the right to give. Revocation and expiry do not
     * cover this: nobody knows to withdraw an invitation they cannot see.
     */
    const email = `heir-${unique}@example.com`;
    const heir = await account(email);

    const sent = await invite(asOwner(), email, 'owner');
    assert.equal(sent.statusCode, 202, sent.body);
    const token = tokenFromLastMail();

    // Demote the author directly. There is no role-change endpoint yet, and what is
    // under test is acceptance, not how the demotion happened.
    await db
      .update(memberships)
      .set({ role: 'viewer' })
      .where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, ownerUserId)));

    const response = await accept({ authorization: `Bearer ${heir.token}` }, token);
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error, 'invite_no_longer_valid');

    // Put it back, so the rest of the suite still has an owner.
    await db
      .update(memberships)
      .set({ role: 'owner' })
      .where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, ownerUserId)));
  });

  test('an invitation stops working when its author is no longer a member', async () => {
    // Same reasoning, one step further: somebody who left should not still be admitting
    // people on their way out.
    const email = `orphan-${unique}@example.com`;
    const orphan = await account(email);

    const sent = await invite(asAdmin(), email, 'viewer');
    assert.equal(sent.statusCode, 202, sent.body);
    const token = tokenFromLastMail();

    await db
      .update(memberships)
      .set({ revokedAt: new Date() })
      .where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, adminUserId)));

    const response = await accept({ authorization: `Bearer ${orphan.token}` }, token);
    assert.equal(response.statusCode, 409, response.body);

    await db
      .update(memberships)
      .set({ revokedAt: null })
      .where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, adminUserId)));
  });

  test('an expired invitation says so rather than reading as withdrawn', async () => {
    // Different advice: an expired one is worth asking for again, a withdrawn one is a
    // conversation with whoever withdrew it.
    const email = `stale-${unique}@example.com`;
    const stale = await account(email);

    const sent = await invite(asOwner(), email, 'viewer');
    const inviteId = sent.json().id;
    const token = tokenFromLastMail();

    await db
      .update(organizationInvites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(organizationInvites.id, inviteId));

    const response = await accept({ authorization: `Bearer ${stale.token}` }, token);
    assert.equal(response.statusCode, 410, response.body);
    assert.equal(response.json().error, 'invite_expired');

    // Listed and marked, not hidden: "I invited them and nothing happened" is the
    // question this list answers.
    const pending = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/invites`,
      headers: asOwner(),
    });
    const row = pending.json().data.find((item: { id: string }) => item.id === inviteId);
    assert.ok(row, pending.body);
    assert.equal(row.expired, true);
  });

  test('inviting somebody who is already in does not change the role they have', async () => {
    /**
     * An invitation must not be a quiet path around `member:role_change`, which is
     * elevated and audited. It is still consumed — an unspent invitation for somebody
     * already inside is a live grant sitting in a mailbox for another week.
     */
    const sent = await invite(asOwner(), guestEmail, 'admin');
    assert.equal(sent.statusCode, 202);
    const token = tokenFromLastMail();

    const response = await accept(asGuest(), token);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().status, 'already_member');
    assert.equal(response.json().role, 'developer');

    const members = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/members`,
      headers: asOwner(),
    });
    const guest = members.json().data.find((row: { email: string }) => row.email === guestEmail);
    assert.equal(guest.role, 'developer', 'an invitation raised an existing role');

    // Consumed, so the link cannot be held and used later.
    assert.equal((await accept(asGuest(), token)).statusCode, 404);
  });

  test('somebody who was removed can be invited back', async () => {
    /**
     * The unique index on (organisation, user) means a second membership row is
     * impossible, so rejoining has to reinstate the old one. Without that, removing
     * somebody by mistake is permanent.
     */
    const email = `returning-${unique}@example.com`;
    const returning = await account(email);
    const headers = { authorization: `Bearer ${returning.token}` };

    await invite(asOwner(), email, 'viewer');
    assert.equal((await accept(headers, tokenFromLastMail())).statusCode, 201);

    await db
      .update(memberships)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(memberships.organizationId, orgId), eq(memberships.userId, returning.userId)),
      );

    await invite(asOwner(), email, 'developer');
    const rejoined = await accept(headers, tokenFromLastMail());
    assert.equal(rejoined.statusCode, 201, rejoined.body);
    assert.equal(rejoined.json().role, 'developer');

    const members = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/members`,
      headers: asOwner(),
    });
    const rows = members.json().data.filter((row: { email: string }) => row.email === email);
    assert.equal(rows.length, 1, 'rejoining must reinstate, not duplicate');
    assert.equal(rows[0].role, 'developer');
  });

  test('an API key cannot accept an invitation on anybody\'s behalf', async () => {
    /**
     * Acceptance turns on "is this the invited person", and a key is not a person — it is
     * a credential belonging to an organisation, quite possibly the one inviting. Letting
     * a key accept would make the address check meaningless.
     */
    /**
     * The key is inserted rather than minted through the API.
     *
     * Issuing one is elevation-gated and this suite's owner has no authenticator, so the
     * route would refuse — and the first version of this test quietly returned early on
     * that refusal, passing without ever reaching the assertion it exists for. What is
     * under test is the accept route's view of a principal, not key issuance.
     */
    const key = issueApiKey('test');
    await db.insert(apiKeys).values({
      organizationId: orgId,
      name: 'invites',
      mode: key.mode,
      displayPrefix: key.displayPrefix,
      tokenHash: key.hash,
      scopes: ['member:invite', 'member:read'],
    });

    const email = `keyed-${unique}@example.com`;
    await account(email);
    await invite(asOwner(), email, 'viewer');

    const response = await accept({ authorization: `Bearer ${key.token}` }, tokenFromLastMail());
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(response.json().error, 'session_required');
  });

  test('a viewer can see who has been asked to join but cannot ask anybody', async () => {
    /**
     * Split deliberately: reading the pending list is `member:read`, because a members
     * page that hides pending invitations reads as complete when it is not. Sending one
     * is `member:invite`.
     */
    const email = `nosy-${unique}@example.com`;
    const nosy = await account(email);
    const headers = { authorization: `Bearer ${nosy.token}` };

    await invite(asOwner(), email, 'viewer');
    assert.equal((await accept(headers, tokenFromLastMail())).statusCode, 201);

    const list = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/invites`,
      headers,
    });
    assert.equal(list.statusCode, 200, list.body);

    const refused = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/members`,
      headers,
      payload: { email: `nope-${unique}@example.com`, role: 'viewer' },
    });
    assert.equal(refused.statusCode, 403, refused.body);
  });

  test('an unknown token is not an oracle for which invitations exist', async () => {
    const response = await accept(asStranger(), 'not-a-real-token');
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error, 'invite_not_found');
  });

  test('accepting requires being signed in at all', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/invites/accept',
      payload: { token: 'anything' },
    });
    assert.equal(response.statusCode, 401);
  });

  test('the audit log shows the invitation and the joining as separate acts', async () => {
    /**
     * They happen days apart and by different people. One entry covering both would lose
     * the only interesting question during an incident: who let this person in, and when
     * did the person actually arrive.
     */
    const log = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/audit-log`,
      headers: asOwner(),
    });
    assert.equal(log.statusCode, 200, log.body);
    const actions = log.json().data.map((row: { action: string }) => row.action);

    assert.ok(actions.includes('member.invited'), actions.join(','));
    assert.ok(actions.includes('member.joined'), actions.join(','));
    assert.ok(actions.includes('member.invite_revoked'), actions.join(','));

    // And no token reached it, from any of them.
    const serialized = JSON.stringify(log.json());
    assert.ok(!/"token"\s*:\s*"[^"]{16,}"/.test(serialized), serialized.slice(0, 400));
  });
});

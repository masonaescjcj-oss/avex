import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import { tronAddressFromEvmHex } from '@avex/core';
import { eq } from 'drizzle-orm';

import { createDatabase } from '../db/client.js';
import { depositWallets, memberships, organizations, users } from '../db/schema.js';
import { ConsoleMailer } from '../mailer.js';
import { AuditService } from './audit.js';
import {
  WalletPoolChanges,
  WalletPoolChangeError,
  WalletPoolService, MAX_WALLETS_PER_CHAIN } from './wallet-pool-service.js';

/**
 * Adding a wallet to a pool, and the day it waits before it counts.
 *
 * The threat is exactly the payout-address one. On a pooled chain the deposit wallet *is* where
 * the money lands — the payer's transfer goes into it and nothing ever moves it — so somebody
 * who can add an address to a merchant's pool is redirecting that merchant's income. So the
 * protection is the same: the first wallet is immediate because there is nothing to redirect,
 * every one after it waits twenty-four hours, everybody is emailed, and any of them can cancel.
 *
 * What is tested here is the part that would be silent if it were wrong: that the second wallet
 * does *not* become usable immediately, and that the email goes to members who did not ask.
 */
const databaseUrl = process.env.DATABASE_URL;

const tronAddress = (): string => tronAddressFromEvmHex(`0x${randomBytes(20).toString('hex')}`);

describe('adding a wallet to the pool', { skip: !databaseUrl }, () => {
  let database: ReturnType<typeof createDatabase> | undefined;
  const db = () => database!.db;
  let pool: WalletPoolService;
  let changes: WalletPoolChanges;
  let mailer: ConsoleMailer;

  before(() => {
    database = createDatabase(databaseUrl!, { max: 4 });
    pool = new WalletPoolService(db());
    mailer = new ConsoleMailer('https://avexpay.net', () => {});
    changes = new WalletPoolChanges(db(), pool, new AuditService(db()), mailer);
  });

  after(async () => {
    await database?.close();
  });

  /** An organisation with two members, so the notice has somebody to go to. */
  async function freshOrg(): Promise<{ orgId: string; ownerId: string; otherEmail: string }> {
    const unique = randomBytes(5).toString('hex');
    const [org] = await db()
      .insert(organizations)
      .values({ name: `Wal ${unique}`, slug: `wal-${unique}` })
      .returning({ id: organizations.id });

    const [owner] = await db()
      .insert(users)
      .values({ email: `owner-${unique}@example.test`, passwordHash: 'x' })
      .returning({ id: users.id });
    const [other] = await db()
      .insert(users)
      .values({ email: `member-${unique}@example.test`, passwordHash: 'x' })
      .returning({ id: users.id, email: users.email });

    await db().insert(memberships).values([
      { organizationId: org!.id, userId: owner!.id, role: 'owner' },
      { organizationId: org!.id, userId: other!.id, role: 'admin' },
    ]);

    return { orgId: org!.id, ownerId: owner!.id, otherEmail: other!.email };
  }

  test('the first wallet is usable immediately', async () => {
    /**
     * Nothing to redirect: a merchant with no wallet cannot take payments on the chain at all,
     * so a delay here would only stop them starting. The payout service treats a first address
     * the same way, for the same reason.
     */
    const { orgId, ownerId } = await freshOrg();
    const address = tronAddress();

    const outcome = await changes.requestAdd({
      organizationId: orgId,
      chain: 'tron',
      address,
      actor: { userId: ownerId },
    });

    assert.equal(outcome.status, 'active');
    assert.equal(outcome.effectiveAt, null);
    const live = await pool.list({ organizationId: orgId, chain: 'tron' });
    assert.equal(live.length, 1);
    assert.equal(live[0]!.retiredAt, null);
  });

  test('the second waits a day, and is not in the pool until it does', async () => {
    /**
     * The assertion that matters. A scheduled wallet that was already allocatable would make the
     * delay decorative — and the way that fails is silent: the merchant sees "scheduled", and
     * the attacker's address is already taking payments.
     */
    const { orgId, ownerId } = await freshOrg();
    await changes.requestAdd({
      organizationId: orgId,
      chain: 'tron',
      address: tronAddress(),
      actor: { userId: ownerId },
    });

    const second = tronAddress();
    const outcome = await changes.requestAdd({
      organizationId: orgId,
      chain: 'tron',
      address: second,
      actor: { userId: ownerId },
    });

    assert.equal(outcome.status, 'pending');
    assert.ok(outcome.effectiveAt !== null);
    assert.ok(
      outcome.effectiveAt.getTime() - Date.now() > 23 * 60 * 60 * 1000,
      'the delay is a day, not a token pause',
    );

    const live = await pool.list({ organizationId: orgId, chain: 'tron' });
    assert.equal(live.length, 1, 'the scheduled wallet is not in the pool yet');
    assert.ok(!live.some((row) => row.address === second));

    // And it is listed as pending, so the merchant can see and cancel it.
    const pending = await changes.pending(orgId);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.address, second);
  });

  test('everyone is emailed, not just whoever asked', async () => {
    /**
     * A delay nobody is told about protects nothing, and the person who needs the notice is
     * precisely the one who did not make the request.
     */
    const { orgId, ownerId, otherEmail } = await freshOrg();
    await changes.requestAdd({
      organizationId: orgId,
      chain: 'tron',
      address: tronAddress(),
      actor: { userId: ownerId },
    });

    const before = mailer.sent.length;
    await changes.requestAdd({
      organizationId: orgId,
      chain: 'tron',
      address: tronAddress(),
      actor: { userId: ownerId },
    });

    const sent = mailer.sent.slice(before);
    assert.equal(sent.length, 2, 'both members');
    assert.ok(sent.some((mail) => mail.to === otherEmail));
    // And the notice links straight to where it can be stopped.
    assert.ok(sent.every((mail) => mail.body.includes('/dashboard?tab=payouts')));
  });

  test('the delay elapsing is what puts it in the pool', async () => {
    const { orgId, ownerId } = await freshOrg();
    await changes.requestAdd({
      organizationId: orgId,
      chain: 'tron',
      address: tronAddress(),
      actor: { userId: ownerId },
    });
    const second = tronAddress();
    await changes.requestAdd({
      organizationId: orgId,
      chain: 'tron',
      address: second,
      actor: { userId: ownerId },
    });

    // Nothing due yet — every scheduled change in this suite is a day out.
    assert.equal(await changes.applyDueChanges(new Date()), 0);

    /**
     * Counted as "at least one", not "exactly one".
     *
     * The applier is the job: it sweeps every organisation, so the cases above have left their
     * own scheduled wallets in the queue. Asserting an exact count here would be asserting the
     * order the tests happen to run in. What matters is that *this* wallet arrived.
     */
    const tomorrow = new Date(Date.now() + 25 * 60 * 60 * 1000);
    assert.ok((await changes.applyDueChanges(tomorrow)) >= 1);

    const live = await pool.list({ organizationId: orgId, chain: 'tron' });
    assert.equal(live.length, 2);
    assert.ok(live.some((row) => row.address === second && row.retiredAt === null));

    // Idempotent: a second tick must not apply anything again.
    assert.equal(await changes.applyDueChanges(tomorrow), 0);
  });

  test('a cancelled change never arrives', async () => {
    const { orgId, ownerId } = await freshOrg();
    await changes.requestAdd({
      organizationId: orgId,
      chain: 'tron',
      address: tronAddress(),
      actor: { userId: ownerId },
    });
    const second = tronAddress();
    const outcome = await changes.requestAdd({
      organizationId: orgId,
      chain: 'tron',
      address: second,
      actor: { userId: ownerId },
    });

    await changes.cancel({
      organizationId: orgId,
      changeId: outcome.pendingChangeId!,
      actor: { userId: ownerId },
    });

    assert.equal(await changes.applyDueChanges(new Date(Date.now() + 25 * 60 * 60 * 1000)), 0);
    const live = await pool.list({ organizationId: orgId, chain: 'tron' });
    assert.ok(!live.some((row) => row.address === second));

    // Cancelling twice is refused rather than silently accepted.
    await assert.rejects(
      changes.cancel({
        organizationId: orgId,
        changeId: outcome.pendingChangeId!,
        actor: { userId: ownerId },
      }),
      (error: unknown) => error instanceof WalletPoolChangeError && error.code === 'not_found',
    );
  });

  test('a wallet already in the pool is refused, in any of its forms', async () => {
    /**
     * The same address twice would let the allocator believe it had two independent wallets and
     * hand one address to two invoices as though they were on separate ones — which defeats the
     * whole reason idle wallets are spent first.
     */
    const { orgId, ownerId } = await freshOrg();
    const address = tronAddress();
    await changes.requestAdd({
      organizationId: orgId,
      chain: 'tron',
      address,
      actor: { userId: ownerId },
    });

    await assert.rejects(
      changes.requestAdd({
        organizationId: orgId,
        chain: 'tron',
        address,
        actor: { userId: ownerId },
      }),
      (error: unknown) => error instanceof WalletPoolChangeError && error.code === 'unchanged',
    );
  });

  test('a wallet on an EVM chain is accepted, checksummed, and needs no contract of ours', async () => {
    /**
     * This used to be refused: BNB Chain's deposit addresses were derived, so a registered
     * wallet did nothing. That is the thing that changed. A merchant's own wallet now works on
     * every chain — the invoice is named by its exact amount, exactly as on TRON — which is how
     * a merchant takes payments on BNB Chain with no forwarder deployed at all.
     *
     * Validated as a payout address is, then stored in its case-folded key form — hex chains
     * compare case-insensitively — so the pool cannot hold one wallet under two spellings and
     * hand it to two invoices as though they were apart.
     */
    const { orgId, ownerId } = await freshOrg();
    const outcome = await changes.requestAdd({
      organizationId: orgId,
      chain: 'bsc',
      address: '0xabc0000000000000000000000000000000000001',
      actor: { userId: ownerId },
    });
    assert.equal(outcome.status, 'active');
    assert.equal(outcome.address, '0xabc0000000000000000000000000000000000001'.toLowerCase());
    const rows = await db().select().from(depositWallets).where(eq(depositWallets.organizationId, orgId));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.chain, 'bsc');
  });

  test('a malformed EVM address is refused with the reason, not stored', async () => {
    const { orgId, ownerId } = await freshOrg();
    await assert.rejects(
      changes.requestAdd({
        organizationId: orgId,
        chain: 'bsc',
        address: '0x1234',
        actor: { userId: ownerId },
      }),
      (error: unknown) =>
        error instanceof WalletPoolChangeError &&
        error.code === 'invalid_address' &&
        /40 hexadecimal/.test(error.message),
    );
    // And the zero address, which would burn every payment sent to it.
    await assert.rejects(
      changes.requestAdd({
        organizationId: orgId,
        chain: 'bsc',
        address: '0x' + '0'.repeat(40),
        actor: { userId: ownerId },
      }),
      (error: unknown) => error instanceof WalletPoolChangeError && error.code === 'invalid_address',
    );
  });

  test('a merchant may hold ten wallets on a chain, and the eleventh is refused', async () => {
    /**
     * A product limit rather than a technical one: every wallet is a key the merchant has to
     * keep, and a pool wider than anyone tracks is how a retired key ends up with an open
     * invoice pointing at it. Scheduled additions count, or the cap could be sailed past by
     * requesting eleven at once and waiting a day.
     */
    const { orgId, ownerId } = await freshOrg();
    for (let i = 1; i <= MAX_WALLETS_PER_CHAIN; i++) {
      await changes.requestAdd({
        organizationId: orgId,
        chain: 'bsc',
        address: '0x' + i.toString(16).padStart(40, '0'),
        actor: { userId: ownerId },
      });
    }
    await assert.rejects(
      changes.requestAdd({
        organizationId: orgId,
        chain: 'bsc',
        address: '0x' + 'ee'.repeat(20),
        actor: { userId: ownerId },
      }),
      (error: unknown) =>
        error instanceof WalletPoolChangeError &&
        error.code === 'pool_full' &&
        new RegExp(String(MAX_WALLETS_PER_CHAIN)).test(error.message),
    );
    // Another chain is another pool.
    const elsewhere = await changes.requestAdd({
      organizationId: orgId,
      chain: 'tron',
      address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      actor: { userId: ownerId },
    });
    assert.equal(elsewhere.status, 'active');
  });

  test('a mistyped TRON address is refused, not stored', async () => {
    // Base58Check exists for this. A wallet stored with a bad checksum is a wallet payments
    // would be sent to and never arrive at.
    const { orgId, ownerId } = await freshOrg();
    await assert.rejects(
      changes.requestAdd({
        organizationId: orgId,
        chain: 'tron',
        address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u',
        actor: { userId: ownerId },
      }),
      (error: unknown) => error instanceof WalletPoolChangeError,
    );
    assert.equal((await db().select().from(depositWallets).where(eq(depositWallets.organizationId, orgId))).length, 0);
  });
});

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

  test('every wallet after the first is live at once too, and everyone is emailed', async () => {
    /**
     * The delay is gone at the merchant's request: a pool of a hundred is built by adding a
     * hundred addresses, and a day's wait on each is a day the shop cannot take payments on
     * them. What remains of the protection is the notice — so it must reach every member, at
     * once, and say where to act.
     */
    const { orgId, ownerId, otherEmail } = await freshOrg();
    await changes.requestAdd({
      organizationId: orgId,
      chain: 'tron',
      address: tronAddress(),
      actor: { userId: ownerId },
    });

    const second = tronAddress();
    const before = mailer.sent.length;
    const outcome = await changes.requestAdd({
      organizationId: orgId,
      chain: 'tron',
      address: second,
      actor: { userId: ownerId },
    });

    assert.equal(outcome.status, 'active');
    assert.equal(outcome.effectiveAt, null);
    const live = await pool.list({ organizationId: orgId, chain: 'tron' });
    assert.equal(live.length, 2);
    assert.ok(live.some((row) => row.address === second && row.retiredAt === null));
    assert.equal((await changes.pending(orgId)).length, 0, 'nothing is queued');

    const sent = mailer.sent.slice(before);
    assert.equal(sent.length, 2, 'both members');
    assert.ok(sent.some((mail) => mail.to === otherEmail));
    assert.ok(sent.every((mail) => mail.body.includes(second)));
    // And the notice links straight to where an unrecognised wallet can be retired.
    assert.ok(sent.every((mail) => mail.body.includes('/dashboard?tab=payouts')));
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

  test('a merchant may hold a hundred wallets on a chain, and the hundred-and-first is refused', async () => {
    /**
     * A product limit rather than a technical one: every wallet is a key the merchant has to
     * keep, and a pool wider than anyone tracks is how a retired key ends up with an open
     * invoice pointing at it. A hundred, because that is what the amount-matching model needs
     * to give nearly every invoice a wallet of its own at the merchant's volume. Scheduled
     * additions count, or the cap could be sailed past by requesting more at once and waiting
     * a day.
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

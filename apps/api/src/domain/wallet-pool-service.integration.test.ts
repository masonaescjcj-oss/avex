import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import { tronAddressFromEvmHex } from '@avex/core';
import { and, eq } from 'drizzle-orm';

import { createDatabase } from '../db/client.js';
import { assets, depositWallets, invoices, organizations } from '../db/schema.js';
import { WalletPoolError } from './wallet-pool-allocator.js';
import { WalletPoolService } from './wallet-pool-service.js';

/**
 * The wallet pool against the real database.
 *
 * The allocator's own tests cover the decisions. This covers the part that cannot be tested
 * without Postgres: that an allocation is still true by the time the invoice is inserted, even
 * when another request is allocating at the same instant. Two invoices sharing an amount on one
 * address is the one state this design cannot recover from — not automatically and not by a
 * human, because nothing on either transfer says which invoice it was for.
 */
const databaseUrl = process.env.DATABASE_URL;

const tronAddress = (): string => tronAddressFromEvmHex(`0x${randomBytes(20).toString('hex')}`);

describe('the wallet pool', { skip: !databaseUrl }, () => {
  let database: ReturnType<typeof createDatabase> | undefined;
  const db = () => database!.db;
  let pool: WalletPoolService;
  let orgId = '';
  let assetId = '';

  before(async () => {
    database = createDatabase(databaseUrl!, { max: 6 });
    pool = new WalletPoolService(db());
    const unique = randomBytes(4).toString('hex');

    const [org] = await db()
      .insert(organizations)
      .values({ name: `Pool ${unique}`, slug: `pool-${unique}` })
      .returning({ id: organizations.id });
    orgId = org!.id;

    /**
     * The fixture asset, found by its own contract and never marked curated.
     *
     * `curated` decides whether a row appears in the admin catalogue as one whose issuer we have
     * checked, so a fixture claiming it shows up there with a null issuer — which broke the
     * catalogue test from another file entirely.
     */
    const FIXTURE_CONTRACT = 'TWKxbjHnf3EY3mZvYUcaLLxLBnMhqUXsQ4';
    const [existing] = await db()
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.chain, 'tron'), eq(assets.contract, FIXTURE_CONTRACT)))
      .limit(1);
    if (existing) {
      assetId = existing.id;
    } else {
      const [created] = await db()
        .insert(assets)
        .values({
          chain: 'tron',
          symbol: 'USDT',
          contract: FIXTURE_CONTRACT,
          decimals: 6,
          kind: 'trc20',
          curated: false,
          verdict: 'approved',
        })
        .returning({ id: assets.id });
      assetId = created!.id;
    }
  });

  after(async () => {
    await database?.close();
  });

  /** A fresh organisation, so one test's pool is never another's. */
  async function freshOrg(): Promise<string> {
    const unique = randomBytes(5).toString('hex');
    const [org] = await db()
      .insert(organizations)
      .values({ name: `Pool ${unique}`, slug: `pool-${unique}` })
      .returning({ id: organizations.id });
    return org!.id;
  }

  async function openInvoice(input: {
    readonly organizationId: string;
    readonly address: string;
    readonly amountDue: bigint;
  }): Promise<string> {
    const [row] = await db()
      .insert(invoices)
      .values({
        organizationId: input.organizationId,
        assetId,
        reference: `pool-${randomBytes(5).toString('hex')}`,
        chain: 'tron',
        amountDue: input.amountDue.toString(),
        amountPaid: '0',
        depositAddress: input.address,
        payoutAddress: input.address,
        status: 'pending',
        mode: 'live',
        toleranceBps: 0,
        feeBps: 0,
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning({ id: invoices.id });
    return row!.id;
  }

  test('registering is idempotent, and re-registering revives a retired wallet', async () => {
    const org = await freshOrg();
    const address = tronAddress();

    const first = await pool.register({ organizationId: org, chain: 'tron', address });
    const again = await pool.register({
      organizationId: org,
      chain: 'tron',
      address,
      label: 'main',
    });
    assert.equal(again.id, first.id, 'a second register must not create a second row');

    assert.equal(await pool.retire({ organizationId: org, walletId: first.id }), true);
    // Retiring twice is not an error but reports that it changed nothing.
    assert.equal(await pool.retire({ organizationId: org, walletId: first.id }), false);

    const revived = await pool.register({ organizationId: org, chain: 'tron', address });
    assert.equal(revived.id, first.id);
    const [row] = await db()
      .select({ retiredAt: depositWallets.retiredAt, label: depositWallets.label })
      .from(depositWallets)
      .where(eq(depositWallets.id, first.id));
    assert.equal(row!.retiredAt, null, 'reviving must clear the retirement');
    assert.equal(row!.label, 'main', 'and keep what was learned in between');
  });

  test('a retired wallet is no longer allocated but is still watched', async () => {
    /**
     * Both halves matter. Allocation must stop, or retiring a wallet does nothing. Watching
     * must not, because an invoice already pointing at that address is still owed money and a
     * watcher that stopped looking would miss the payment entirely.
     */
    const org = await freshOrg();
    const retired = tronAddress();
    const live = tronAddress();
    const { id } = await pool.register({ organizationId: org, chain: 'tron', address: retired });
    await pool.register({ organizationId: org, chain: 'tron', address: live });
    await pool.retire({ organizationId: org, walletId: id });

    const allocation = await db().transaction((tx) =>
      pool.allocate(tx, {
        organizationId: org,
        chain: 'tron',
        base: 20_000_000n,
        decimals: 6,
      }),
    );
    assert.equal(allocation.address, live);

    const watched = await pool.watchedAddresses('tron');
    assert.ok(watched.includes(retired), 'a retired address must still be watched');
    assert.ok(watched.includes(live));
  });

  test('an idle wallet is chosen over a busy one', async () => {
    const org = await freshOrg();
    const busy = tronAddress();
    const idle = tronAddress();
    await pool.register({ organizationId: org, chain: 'tron', address: busy });
    await pool.register({ organizationId: org, chain: 'tron', address: idle });
    await openInvoice({ organizationId: org, address: busy, amountDue: 20_000_042n });

    const allocation = await db().transaction((tx) =>
      pool.allocate(tx, {
        organizationId: org,
        chain: 'tron',
        base: 20_000_000n,
        decimals: 6,
      }),
    );
    assert.equal(allocation.address, idle);
  });

  test('an open invoice on the wallet cannot have its amount handed out again', async () => {
    const org = await freshOrg();
    const only = tronAddress();
    await pool.register({ organizationId: org, chain: 'tron', address: only });
    await openInvoice({ organizationId: org, address: only, amountDue: 20_000_007n });

    /**
     * The random source is pinned to the offset that is already taken, so the allocator has to
     * notice and move on. With a live `Math.random` this test would pass by luck 9998 times in
     * 9999 and prove nothing.
     */
    const allocation = await db().transaction((tx) =>
      pool.allocate(tx, {
        organizationId: org,
        chain: 'tron',
        base: 20_000_000n,
        decimals: 6,
        random: () => 6 / 9999,
      }),
    );
    assert.notEqual(allocation.amountDue, 20_000_007n);
    assert.ok(allocation.amountDue > 20_000_000n);
  });

  test('a paid invoice releases its amount', async () => {
    /**
     * The uniqueness is over *open* invoices, which is why no database constraint can express
     * it and why the lock exists. Once an invoice is paid its amount is free again — otherwise
     * a merchant selling one popular price would exhaust the window in a week.
     */
    const org = await freshOrg();
    const only = tronAddress();
    await pool.register({ organizationId: org, chain: 'tron', address: only });
    const invoiceId = await openInvoice({
      organizationId: org,
      address: only,
      amountDue: 20_000_007n,
    });
    await db().update(invoices).set({ status: 'paid' }).where(eq(invoices.id, invoiceId));

    const allocation = await db().transaction((tx) =>
      pool.allocate(tx, {
        organizationId: org,
        chain: 'tron',
        base: 20_000_000n,
        decimals: 6,
        random: () => 6 / 9999,
      }),
    );
    assert.equal(allocation.amountDue, 20_000_007n, 'the freed amount is available again');
  });

  test('concurrent allocations for one price never collide', async () => {
    /**
     * The reason this service exists rather than the allocator being called directly.
     *
     * Eight requests allocate the same price on a one-wallet pool at the same moment, each
     * inserting its invoice inside the transaction that allocated it — which is the contract.
     * Every random source offers the same offset, so nothing but the lock and the re-read can
     * keep them apart: without them, all eight would read an empty wallet, all eight would
     * choose offset 1, and eight invoices would sit on one address asking for one amount.
     */
    const org = await freshOrg();
    const only = tronAddress();
    await pool.register({ organizationId: org, chain: 'tron', address: only });

    const allocations = await Promise.all(
      Array.from({ length: 8 }, () =>
        db().transaction(async (tx) => {
          const allocation = await pool.allocate(tx, {
            organizationId: org,
            chain: 'tron',
            base: 20_000_000n,
            decimals: 6,
            // Every caller wants offset 1. Only one can have it.
            random: () => 0,
          });
          await tx.insert(invoices).values({
            organizationId: org,
            assetId,
            reference: `race-${randomBytes(5).toString('hex')}`,
            chain: 'tron',
            amountDue: allocation.amountDue.toString(),
            amountPaid: '0',
            depositAddress: allocation.address,
            payoutAddress: allocation.address,
            status: 'pending',
            mode: 'live',
            toleranceBps: 0,
            feeBps: 0,
            expiresAt: new Date(Date.now() + 3_600_000),
          });
          return allocation.amountDue;
        }),
      ),
    );

    const distinct = new Set(allocations.map((amount) => amount.toString()));
    assert.equal(distinct.size, 8, `amounts collided: ${[...distinct].join(', ')}`);
  });

  test('a merchant with no wallet is told so, by name', async () => {
    const org = await freshOrg();
    await assert.rejects(
      db().transaction((tx) =>
        pool.allocate(tx, {
          organizationId: org,
          chain: 'tron',
          base: 20_000_000n,
          decimals: 6,
        }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof WalletPoolError);
        assert.equal(error.code, 'pool_empty');
        return true;
      },
    );
  });

  test('one merchant’s wallets are never allocated to another', async () => {
    const mine = await freshOrg();
    const theirs = await freshOrg();
    const address = tronAddress();
    await pool.register({ organizationId: theirs, chain: 'tron', address });

    await assert.rejects(
      db().transaction((tx) =>
        pool.allocate(tx, {
          organizationId: mine,
          chain: 'tron',
          base: 20_000_000n,
          decimals: 6,
        }),
      ),
      /no deposit wallet is registered/,
    );
  });
});

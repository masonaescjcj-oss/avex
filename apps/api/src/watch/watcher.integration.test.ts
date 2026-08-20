import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import { DEFAULT_WATCHER, EvmAdapter, Watcher, keccak256, toHex } from '@avex/core';
import type { Asset, BlockRef } from '@avex/core';
import { and, eq } from 'drizzle-orm';

import { createDatabase } from '../db/client.js';
import { assets, invoices, organizations, payments } from '../db/schema.js';
import { AuditService } from '../domain/audit.js';
import { DatabaseAddressBook } from '../domain/address-book.js';
import { DatabasePaymentSink } from '../domain/payment-sink.js';
import { DatabaseWatchStore } from '../domain/watch-store.js';
import { WebhookService } from '../domain/webhook-service.js';
import { runWatchLoop } from './loop.js';

/**
 * The watcher, wired to the real database and a fake chain.
 *
 * Everything between an RPC response and a credited payment is under test here: the address
 * book that decides a transfer is ours, the sink that credits it exactly once, the cursor
 * that survives a restart. The chain itself is a hand-written JSON-RPC responder, because
 * the alternative is a test that needs a node — and a test that needs a node is a test that
 * does not run.
 *
 * Before this existed, `Watcher` had unit tests and nothing composed it: no `AddressBook`
 * implementation, no process, and a log line in `main.ts` claiming watchers start with the
 * settlement runner. This is the composition, exercised.
 */
const databaseUrl = process.env.DATABASE_URL;

const TRANSFER_TOPIC = toHex(
  keccak256(new TextEncoder().encode('Transfer(address,address,uint256)')),
);
const TOKEN = '0x55d398326f99059ff775485246999027b3197955';
const FACTORY = '0x00000000000000000000000000000000000f4c70';
const CREATION_CODE = '0x60806040523480156100115760006000fd5b50';

const USDT: Asset = {
  symbol: 'USDT',
  chain: 'bsc',
  decimals: 18,
  kind: 'erc20',
  contract: TOKEN,
};

const pad = (hex: string): string => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const blockHash = (n: number): string => `0x${pad(`0x${(n * 7 + 1).toString(16)}`)}`;

/** A transfer log, as an RPC would return it. */
function transferLog(input: {
  to: string;
  amount: bigint;
  block: number;
  txHash: string;
  logIndex: number;
}) {
  return {
    address: TOKEN,
    topics: [
      TRANSFER_TOPIC,
      `0x${pad('0x1111111111111111111111111111111111111111')}`,
      `0x${pad(input.to)}`,
    ],
    data: `0x${pad(`0x${input.amount.toString(16)}`)}`,
    blockNumber: `0x${input.block.toString(16)}`,
    blockHash: blockHash(input.block),
    transactionHash: input.txHash,
    logIndex: `0x${input.logIndex.toString(16)}`,
  };
}

/**
 * A chain under the test's control.
 *
 * Answers the four methods the adapter and the block source use. Head is a variable so a
 * test can advance the chain between polls, which is the only way to exercise the cursor.
 */
class FakeChain {
  /**
   * High enough that a log a few blocks down is final.
   *
   * BNB Chain needs 15 confirmations for an ordinary payment (30 above $10,000), and the
   * sink refuses to credit anything shallower — it marks the invoice `confirming` and waits,
   * which is correct and made the first version of every test below assert against zero
   * payments. So the fixtures put transfers well behind the head.
   */
  head = 1_000;
  logs: ReturnType<typeof transferLog>[] = [];
  readonly calls: string[] = [];

  async request<T>(method: string, params: readonly unknown[]): Promise<T> {
    this.calls.push(method);
    switch (method) {
      case 'eth_blockNumber':
        return `0x${this.head.toString(16)}` as T;
      case 'eth_getBlockByNumber': {
        const wanted = Number(params[0] as string);
        if (wanted > this.head) return null as T;
        return { number: `0x${wanted.toString(16)}`, hash: blockHash(wanted) } as T;
      }
      case 'eth_getLogs': {
        const filter = params[0] as { fromBlock: string; toBlock: string };
        const from = Number(filter.fromBlock);
        const to = Number(filter.toBlock);
        return this.logs.filter((log) => {
          const at = Number(log.blockNumber);
          return at >= from && at <= to;
        }) as T;
      }
      default:
        throw new Error(`the fake chain was asked for ${method}`);
    }
  }

  /** The `BlockSource` half, which the watcher uses to spot a reorg. */
  async headRef(): Promise<BlockRef> {
    return { number: this.head, hash: blockHash(this.head) };
  }

  async blockAt(number: number): Promise<BlockRef | null> {
    return number > this.head ? null : { number, hash: blockHash(number) };
  }
}

describe('the watcher, composed', { skip: databaseUrl ? false : 'DATABASE_URL not set' }, () => {
  let database: ReturnType<typeof createDatabase>;
  let chain: FakeChain;
  let orgId: string;
  let assetId: string;

  const unique = randomBytes(6).toString('hex');

  /**
   * A fresh deposit address per invoice, in mixed case.
   *
   * One each because `invoices_chain_deposit_key` is unique on (chain, deposit_address) —
   * which is right, an address is derived for exactly one invoice — and the first version of
   * this suite reused a single address and collided on the second insert.
   *
   * Mixed case because that is how an EIP-55 address is stored and shown, and the whole
   * point of one test below is that the chain reports it lowercase.
   */
  let addressCounter = 0;
  const nextAddress = (): string => {
    addressCounter += 1;
    const body = `${unique}${addressCounter.toString(16).padStart(2, '0')}`.padEnd(40, 'a');
    // Upper-case every other hex letter, which is not a real checksum and does not need to
    // be: what is under test is case-insensitive matching, not EIP-55 itself.
    const mixed = [...body.slice(0, 40)]
      .map((char, index) => (index % 2 === 0 ? char.toUpperCase() : char))
      .join('');
    return `0x${mixed}`;
  };

  const db = () => database.db;

  /**
   * A private lane in `watch_cursors` and `seen_blocks`.
   *
   * Those tables are keyed by chain, and every suite in this repository that touches a
   * watcher uses `bsc`. Node runs test files concurrently, so this suite positioned its
   * cursor, another suite moved it, and the poll scanned the wrong range — which passed
   * when run alone and failed in the full run, the least useful combination there is.
   *
   * The `Watcher`'s chain names its *state*; the adapter's chain is what a payment is
   * recorded as. Separating them here gives this suite state nobody else writes while the
   * payments it credits are still ordinary `bsc` ones, which is what the sink and the
   * confirmation rules have to see.
   */
  const stateChain = `bsc-watch-${randomBytes(4).toString('hex')}` as 'bsc';

  before(async () => {
    database = createDatabase(databaseUrl!);
    const [org] = await database.db
      .insert(organizations)
      .values({ name: `Watch ${unique}`, slug: `watch-${unique}` })
      .returning({ id: organizations.id });
    orgId = org!.id;

    /**
     * The USDT/bsc row, found or created.
     *
     * `assets_chain_native_key` allows one contract-less asset per chain and this one has a
     * contract, so a find-or-create is safe — and a dev database that has run other suites
     * already has it.
     */
    const [existing] = await database.db
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.chain, 'bsc'), eq(assets.symbol, 'USDT'), eq(assets.curated, true)))
      .limit(1);
    if (existing) {
      assetId = existing.id;
    } else {
      const [created] = await database.db
        .insert(assets)
        .values({
          chain: 'bsc',
          symbol: 'USDT',
          contract: TOKEN,
          decimals: 18,
          kind: 'erc20',
          curated: true,
          verdict: 'approved',
        })
        .returning({ id: assets.id });
      assetId = created!.id;
    }
  });

  after(async () => {
    await database?.close();
  });

  /** An invoice, with the deposit address it expects to be paid at. */
  async function openInvoice(
    reference: string,
    amountDue: bigint,
  ): Promise<{ id: string; depositAddress: string }> {
    const depositAddress = nextAddress();
    const [row] = await db()
      .insert(invoices)
      .values({
        organizationId: orgId,
        assetId,
        reference,
        chain: 'bsc',
        amountDue: amountDue.toString(),
        amountPaid: '0',
        depositAddress,
        /**
         * A payout address, because the column requires one and the deposit address commits
         * to it. Not used by anything here: crediting reads the invoice, and only a sweep
         * would need to know where the money goes.
         */
        payoutAddress: '0x1234567890AbcdEF1234567890aBcdef12345678',
        status: 'pending',
        mode: 'live',
        // Exact match required, so an underpayment is visible as one.
        toleranceBps: 0,
        feeBps: 0,
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning({ id: invoices.id });
    return { id: row!.id, depositAddress };
  }

  /**
   * Position the cursor just below a block, so the next poll scans it.
   *
   * A fresh watcher starts at the head — `from = cursor === null ? head : cursor + 1` — which
   * is deliberate: a new deployment does not rescan the chain's history looking for payments
   * to invoices that did not exist. So a test about a specific block has to say where the
   * watcher had got to, exactly as a running one would have.
   */
  async function resumeFrom(state: DatabaseWatchStore, block: number): Promise<void> {
    await state.saveCursor(stateChain, String(block - 1), block - 1);
  }

  function buildWatcher(): { watcher: Watcher; state: DatabaseWatchStore } {
    const audit = new AuditService(db());
    const webhooks = new WebhookService(db(), {
      async deliver() {
        return { statusCode: 200 };
      },
    } as never);
    const sink = new DatabasePaymentSink(db(), audit, webhooks, () => 0);
    const state = new DatabaseWatchStore(db());

    const adapter = new EvmAdapter(
      {
        chain: 'bsc',
        rpcUrl: 'http://fake',
        create2: { factory: FACTORY, forwarderCreationCode: CREATION_CODE },
        acceptedAssets: [USDT],
        pollRange: 500,
      },
      { nativePriceUsd: async () => 0 },
      {
        address: '0x0000000000000000000000000000000000000000',
        async sendTransaction(): Promise<never> {
          throw new Error('this test never settles');
        },
      },
      new DatabaseAddressBook(db(), 'bsc'),
    );

    // The adapter talks to the chain through its private rpc helper; point it at the fake.
    (adapter as unknown as { rpc: FakeChain['request'] }).rpc = (method, params) =>
      chain.request(method, params);

    const watcher = new Watcher(
      stateChain,
      adapter,
      { head: () => chain.headRef(), blockAt: (n) => chain.blockAt(n) },
      state,
      sink,
      { reorgDepth: 8, blockMemory: 32, maxBlocksPerPoll: 500 },
    );
    return { watcher, state };
  }

  test('a transfer to a known deposit address is credited to its invoice', async () => {
    /**
     * The whole path in one test: an RPC log, an address matched case-insensitively, a
     * payment row, and an invoice moved to paid.
     */
    chain = new FakeChain();
    const { id: invoiceId, depositAddress } = await openInvoice(`credit-${unique}`, 1_000n);
    const txHash = `0x${pad(`0x${unique}01`)}`;

    chain.logs = [
      transferLog({ to: depositAddress, amount: 1_000n, block: 900, txHash, logIndex: 0 }),
    ];

    const { watcher, state } = buildWatcher();
    await resumeFrom(state, 900);
    await watcher.poll();

    const credited = await db()
      .select({ amount: payments.amount, source: payments.valueSource })
      .from(payments)
      .where(eq(payments.invoiceId, invoiceId));
    assert.equal(credited.length, 1, JSON.stringify(credited));
    assert.equal(credited[0]!.amount, '1000');

    const [invoice] = await db()
      .select({ status: invoices.status, paid: invoices.amountPaid })
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    assert.equal(invoice!.status, 'paid');
    assert.equal(invoice!.paid, '1000');
  });

  test('the deposit address matches whatever case the chain reports', async () => {
    /**
     * The bug this exists to prevent, and it would have been total rather than partial.
     *
     * An EVM address is stored here in EIP-55 mixed case — that is what a merchant reads and
     * what a wallet shows — and an RPC log returns it lowercase. Compare them literally and
     * every payment on every EVM chain goes unrecognised, which looks like a quiet chain
     * rather than a bug.
     */
    chain = new FakeChain();
    const { id: invoiceId, depositAddress } = await openInvoice(`case-${unique}`, 500n);
    const txHash = `0x${pad(`0x${unique}02`)}`;
    assert.notEqual(depositAddress, depositAddress.toLowerCase(), 'the fixture must be mixed case');

    chain.logs = [
      transferLog({
        // Lowercase, as `eth_getLogs` returns it.
        to: depositAddress.toLowerCase(),
        amount: 500n,
        block: 901,
        txHash,
        logIndex: 0,
      }),
    ];

    const { watcher, state } = buildWatcher();
    await resumeFrom(state, 901);
    await watcher.poll();

    const credited = await db()
      .select({ id: payments.id })
      .from(payments)
      .where(and(eq(payments.invoiceId, invoiceId), eq(payments.txHash, txHash)));
    assert.equal(credited.length, 1, 'a lowercase address from the chain must still match');
  });

  test('a transfer to an address nobody owns is ignored, not guessed at', async () => {
    /**
     * The safe direction, and the only one. Crediting a transfer whose address we do not
     * recognise means picking an invoice to give somebody else's money to.
     */
    chain = new FakeChain();
    const { id: invoiceId } = await openInvoice(`stranger-${unique}`, 700n);
    chain.logs = [
      transferLog({
        to: '0x9999999999999999999999999999999999999999',
        amount: 700n,
        block: 902,
        txHash: `0x${pad(`0x${unique}03`)}`,
        logIndex: 0,
      }),
    ];

    const { watcher, state } = buildWatcher();
    await resumeFrom(state, 902);
    const outcome = await watcher.poll();

    assert.equal(outcome.credited, 0);
    const credited = await db()
      .select({ id: payments.id })
      .from(payments)
      .where(eq(payments.invoiceId, invoiceId));
    assert.deepEqual(credited, []);
  });

  test('the same transfer seen twice is credited once', async () => {
    /**
     * A poll that overlaps the previous range is ordinary — a restart resumes from a saved
     * cursor, and the cursor is saved after crediting. Idempotency on
     * (chain, txHash, transferIndex) is what makes that overlap harmless.
     */
    chain = new FakeChain();
    const { id: invoiceId, depositAddress } = await openInvoice(`twice-${unique}`, 300n);
    const txHash = `0x${pad(`0x${unique}04`)}`;
    chain.logs = [
      transferLog({ to: depositAddress, amount: 300n, block: 903, txHash, logIndex: 0 }),
    ];

    const { watcher, state } = buildWatcher();
    await resumeFrom(state, 903);
    await watcher.poll();

    /**
     * Rewind and scan the same range again, which is what a restart does: the cursor is saved
     * after crediting, so a process killed between the two resumes over ground it has already
     * covered. Idempotency on (chain, txHash, transferIndex) is what makes that harmless.
     */
    await resumeFrom(state, 903);
    await watcher.poll();

    const credited = await db()
      .select({ id: payments.id })
      .from(payments)
      .where(and(eq(payments.invoiceId, invoiceId), eq(payments.txHash, txHash)));
    assert.equal(credited.length, 1, 'the same transfer was credited twice');

    const [invoice] = await db()
      .select({ paid: invoices.amountPaid })
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    assert.equal(invoice!.paid, '300');
  });

  test('the cursor advances, so the next poll does not rescan from the start', async () => {
    // Otherwise every poll re-reads the whole chain, which is both slow and the reason a
    // provider starts rate limiting.
    chain = new FakeChain();
    const { watcher, state } = buildWatcher();
    await resumeFrom(state, 600);

    await watcher.poll();
    const first = await state.loadCursor(stateChain);
    assert.ok(first.scannedTo !== null && first.scannedTo >= 600, JSON.stringify(first));

    chain.head += 20;
    await watcher.poll();
    const second = await state.loadCursor(stateChain);
    assert.ok(second.scannedTo! > first.scannedTo!, 'the cursor did not move');
  });

  test('the loop keeps polling and stops cleanly', async () => {
    /**
     * The composition as it actually runs: the loop driving the watcher, rather than a test
     * calling `poll()` itself.
     */
    chain = new FakeChain();
    const { watcher } = buildWatcher();

    let polls = 0;
    let reached: () => void;
    const done = new Promise<void>((resolve) => {
      reached = resolve;
    });

    const handle = runWatchLoop(watcher, { intervalMs: 1, backoffMs: 1, maxBackoffMs: 1 }, {
      onPoll: () => {
        polls += 1;
        if (polls >= 2) reached();
      },
    });

    await done;
    await handle.stop();
    assert.ok(polls >= 2, `only ${polls} polls`);
  });
});

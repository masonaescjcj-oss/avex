import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import { TronAdapter, Watcher, tronAddressToEvmHex } from '@avex/core';
import type { Asset, BlockRef } from '@avex/core';
import { and, eq } from 'drizzle-orm';

import { createDatabase } from '../db/client.js';
import { assets, invoices, organizations, payments } from '../db/schema.js';
import { DatabaseAddressBook } from '../domain/address-book.js';
import { AuditService } from '../domain/audit.js';
import { CommissionLedger } from '../domain/commission-ledger.js';
import { DatabasePaymentSink } from '../domain/payment-sink.js';
import { DatabaseWatchStore } from '../domain/watch-store.js';
import { WalletPoolService } from '../domain/wallet-pool-service.js';
import { WebhookService } from '../domain/webhook-service.js';

/**
 * A TRON payment, from a log to a paid invoice and a billed commission.
 *
 * Everything in the pooled design has been tested a piece at a time: the codec, the allocator,
 * the lock, the matching rules, the ledger. This is the one test that runs them in sequence, and
 * it exists because the pieces fit together across two encodings and one arithmetic convention —
 * the sort of seam where every part is right and the whole is broken.
 *
 * What it does not test is TRON itself. The chain is a hand-written responder: a test that needs
 * a node is a test that does not run, and what is worth checking here is our own reasoning.
 */
const databaseUrl = process.env.DATABASE_URL;

/**
 * Fixture addresses with valid checksums, over deliberately repetitive bodies.
 *
 * `TR7NH…` is Tether's real contract. The rest are fixtures and look like it — invented by hand
 * they would not survive their own checksum, which is the codec doing its job.
 */
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const WALLET = 'TBXSw8fM4jpQkGc6zZjsVABFpVN7UvXPdV';
const PAYER = 'TD5gsCwxykWsLN9aPrq2TAfNjByuZKYp4E';

const USDT: Asset = {
  symbol: 'USDT',
  chain: 'tron',
  decimals: 6,
  kind: 'trc20',
  contract: USDT_CONTRACT,
};

const blockHash = (n: number): string => `0x${(n * 7 + 3).toString(16).padStart(64, '0')}`;

/** A TRON node, as far as this process can tell. */
class FakeTron {
  /**
   * Well ahead of the fixtures, because TRON needs 19 confirmations.
   *
   * The sink refuses to credit anything shallower — it marks the invoice `confirming` and waits,
   * which is correct and would make every assertion below about zero payments.
   */
  head = 1_000;
  logs: Record<string, unknown>[] = [];
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
        const filter = params[0] as { fromBlock: string; toBlock: string; address: string[] };
        const from = Number(filter.fromBlock);
        const to = Number(filter.toBlock);
        /**
         * The address filter is honoured, not ignored.
         *
         * A fake that returns every log regardless would hide the one mistake this integration
         * is most exposed to: sending Base58Check into `eth_getLogs`, which a real node answers
         * with an empty list and no error.
         */
        const wanted = new Set(filter.address.map((entry) => entry.toLowerCase()));
        return this.logs.filter((log) => {
          const at = Number(log.blockNumber as string);
          return at >= from && at <= to && wanted.has(String(log.address).toLowerCase());
        }) as T;
      }
      default:
        throw new Error(`the fake chain was asked for ${method}`);
    }
  }

  async headRef(): Promise<BlockRef> {
    return { number: this.head, hash: blockHash(this.head) };
  }

  async blockAt(number: number): Promise<BlockRef | null> {
    if (number > this.head) return null;
    return { number, hash: blockHash(number) };
  }

  transfer(input: { to: string; amount: bigint; block: number; contract?: string }): void {
    const pad = (hex: string): string => hex.replace(/^0x/, '').padStart(64, '0');
    this.logs.push({
      address: tronAddressToEvmHex(input.contract ?? USDT_CONTRACT),
      topics: [
        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
        `0x${pad(tronAddressToEvmHex(PAYER))}`,
        `0x${pad(tronAddressToEvmHex(input.to))}`,
      ],
      data: `0x${input.amount.toString(16)}`,
      blockNumber: `0x${input.block.toString(16)}`,
      transactionHash: `0x${randomBytes(32).toString('hex')}`,
      logIndex: '0x0',
    });
  }
}

describe('a TRON payment, end to end', { skip: !databaseUrl }, () => {
  let database: ReturnType<typeof createDatabase> | undefined;
  const db = () => database!.db;
  let chain: FakeTron;
  let ledger: CommissionLedger;
  let pool: WalletPoolService;
  let orgId = '';
  let assetId = '';

  /**
   * The watch cursor is keyed by chain, and every suite that watches uses the same one.
   *
   * So this one keeps its state under a private name while the payments stay on ordinary `tron`:
   * otherwise this suite and the BSC one would fight over one cursor row and each would pass
   * alone and fail together.
   */
  const stateChain = `tron-e2e-${randomBytes(4).toString('hex')}` as 'tron';

  const FIXTURE_CONTRACT = 'TGCAjMXComunWZEXCT1LPBdcYbDVuyexBv';

  before(async () => {
    database = createDatabase(databaseUrl!, { max: 4 });
    ledger = new CommissionLedger(db());
    pool = new WalletPoolService(db());

    const unique = randomBytes(5).toString('hex');
    const [org] = await db()
      .insert(organizations)
      .values({ name: `E2E ${unique}`, slug: `e2e-${unique}` })
      .returning({ id: organizations.id });
    orgId = org!.id;

    // Found by its own contract and never marked curated: a fixture must not appear in the
    // admin catalogue as a row whose issuer we have checked.
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

  /** The whole graph, pointed at the fake chain. */
  function compose() {
    const audit = new AuditService(db());
    const webhooks = new WebhookService(db(), {
      async deliver() {
        return { statusCode: 200 };
      },
    } as never);

    /**
     * A dollar per whole token, so the commission arithmetic in the assertions is legible.
     * A real price source would make every expected figure depend on the market.
     */
    const sink = new DatabasePaymentSink(
      db(),
      audit,
      webhooks,
      (payment) => Number(payment.amount) / 10 ** payment.asset.decimals,
      () => 'oracle',
      ledger,
    );

    const adapter = new TronAdapter(
      {
        chain: 'tron',
        rpcUrl: 'http://fake',
        acceptedAssets: [{ ...USDT, contract: USDT_CONTRACT }],
        pollRange: 500,
      },
      { nativePriceUsd: async () => 0.3 },
      new DatabaseAddressBook(db(), 'tron'),
    );
    (adapter as unknown as { rpc: FakeTron['request'] }).rpc = (method, params) =>
      chain.request(method, params);

    const state = new DatabaseWatchStore(db());
    const watcher = new Watcher(
      stateChain,
      adapter,
      { head: () => chain.headRef(), blockAt: (n) => chain.blockAt(n) },
      state,
      sink,
      { reorgDepth: 19, blockMemory: 64, maxBlocksPerPoll: 500 },
    );
    return { watcher, state };
  }

  /**
   * Say where the watcher had got to, exactly as a running one would have.
   *
   * A fresh watcher starts at the head — `from = cursor === null ? head : cursor + 1` — which is
   * deliberate: a new deployment does not rescan years of history looking for payments to
   * invoices that did not exist. So a test about a specific block has to place the cursor, and
   * without this every case below polls a range that does not contain its own transfer.
   */
  async function resumeFrom(state: DatabaseWatchStore, block: number): Promise<void> {
    await state.saveCursor(stateChain, String(block - 1), block - 1);
  }

  /** An invoice allocated the way production allocates one. */
  async function openInvoice(base: bigint): Promise<{ id: string; amountDue: bigint; address: string }> {
    const allocation = await db().transaction(async (tx) => {
      const chosen = await pool.allocate(tx, {
        organizationId: orgId,
        chain: 'tron',
        base,
        decimals: 6,
      });
      const [row] = await tx
        .insert(invoices)
        .values({
          organizationId: orgId,
          assetId,
          reference: `e2e-${randomBytes(5).toString('hex')}`,
          chain: 'tron',
          amountDue: chosen.amountDue.toString(),
          amountPaid: '0',
          depositAddress: chosen.address,
          payoutAddress: chosen.address,
          status: 'pending',
          mode: 'live',
          toleranceBps: 0,
          feeBps: 0,
          accruedFeeBps: 50,
          expiresAt: new Date(Date.now() + 3_600_000),
        })
        .returning({ id: invoices.id });
      return { id: row!.id, amountDue: chosen.amountDue, address: chosen.address };
    });
    return allocation;
  }

  const statusOf = async (id: string): Promise<string> => {
    const [row] = await db()
      .select({ status: invoices.status })
      .from(invoices)
      .where(eq(invoices.id, id));
    return row!.status;
  };

  test('a transfer to a pooled wallet pays its invoice and bills the commission', async () => {
    /**
     * The sequence, in one test: the pool hands out a wallet and an amount, the payer sends that
     * exact amount, the adapter finds it through the hex filter and reports it in Base58Check,
     * the sink matches it by amount, and the commission we cannot take on chain becomes a debt.
     */
    chain = new FakeTron();
    await pool.register({ organizationId: orgId, chain: 'tron', address: WALLET });

    const invoice = await openInvoice(20_000_000n);
    assert.equal(invoice.address, WALLET);
    chain.transfer({ to: WALLET, amount: invoice.amountDue, block: 900 });

    const balanceBefore = await ledger.balance(orgId);
    const { watcher, state } = compose();
    await resumeFrom(state, 900);
    const outcome = await watcher.poll();

    assert.equal(outcome.credited, 1, 'the payment was credited');
    assert.equal(await statusOf(invoice.id), 'paid');

    const rows = await db().select().from(payments).where(eq(payments.invoiceId, invoice.id));
    assert.equal(rows.length, 1);
    assert.equal(BigInt(rows[0]!.amount), invoice.amountDue, 'recorded at what arrived');

    /**
     * 0.5% of what arrived, floored, and negative because the merchant owes it.
     *
     * The amount includes the disambiguator, so this is a fraction of $20.00xxxx rather than of
     * $20 exactly — which is why the assertion is computed rather than written as a literal.
     */
    const expected = (invoice.amountDue * 50n) / 10_000n;
    assert.equal(balanceBefore - (await ledger.balance(orgId)), expected);
  });

  test('two invoices on one wallet are told apart by their amounts', async () => {
    /**
     * The claim the whole design rests on. One address, two open invoices, and nothing but the
     * amount to separate them — so a payment for one must leave the other untouched.
     */
    chain = new FakeTron();
    await pool.register({ organizationId: orgId, chain: 'tron', address: WALLET });

    const first = await openInvoice(30_000_000n);
    const second = await openInvoice(30_000_000n);
    assert.equal(first.address, second.address, 'one wallet');
    assert.notEqual(first.amountDue, second.amountDue);

    chain.transfer({ to: WALLET, amount: second.amountDue, block: 900 });
    const { watcher, state } = compose();
    await resumeFrom(state, 900);
    await watcher.poll();

    assert.equal(await statusOf(second.id), 'paid');
    assert.equal(await statusOf(first.id), 'pending', 'the neighbour is untouched');
  });

  test('a payment for the wrong amount with two invoices open is not guessed at', async () => {
    /**
     * The case that needs a human. Nothing on the chain says which of the two it was for, so the
     * watcher records it as unmatched rather than crediting a coin flip.
     */
    chain = new FakeTron();
    await pool.register({ organizationId: orgId, chain: 'tron', address: WALLET });

    const first = await openInvoice(40_000_000n);
    const second = await openInvoice(40_000_000n);
    chain.transfer({ to: WALLET, amount: 40_000_000n, block: 900 });

    const { watcher, state } = compose();
    await resumeFrom(state, 900);
    const outcome = await watcher.poll();
    assert.equal(outcome.credited, 0);
    assert.equal(await statusOf(first.id), 'pending');
    assert.equal(await statusOf(second.id), 'pending');
  });

  test('a transfer of an unwatched contract to our own wallet is ignored', async () => {
    /**
     * Deploying a TRC-20 called USDT costs a few cents, and the wallet is a real address anybody
     * can send anything to. A log from a contract not in the catalogue must not credit an
     * invoice — that is how a worthless clone becomes revenue.
     */
    chain = new FakeTron();
    await pool.register({ organizationId: orgId, chain: 'tron', address: WALLET });
    const invoice = await openInvoice(50_000_000n);

    chain.transfer({
      to: WALLET,
      amount: invoice.amountDue,
      block: 900,
      contract: 'TEdvoHEatmDKvTh3o9vBRB9Vdtbhn4QFhy',
    });

    const { watcher, state } = compose();
    await resumeFrom(state, 900);
    const outcome = await watcher.poll();
    assert.equal(outcome.credited, 0);
    assert.equal(await statusOf(invoice.id), 'pending');
  });

  test('a shallow payment waits rather than being credited', async () => {
    /**
     * TRON is irreversible after 19 confirmations and the sink enforces it. A payment three
     * blocks old moves the invoice to `confirming` and no further — visible progress for the
     * payer, and nothing released.
     */
    chain = new FakeTron();
    await pool.register({ organizationId: orgId, chain: 'tron', address: WALLET });
    const invoice = await openInvoice(60_000_000n);

    chain.transfer({ to: WALLET, amount: invoice.amountDue, block: chain.head - 2 });
    const { watcher, state } = compose();
    await resumeFrom(state, chain.head - 2);
    await watcher.poll();

    assert.equal(await statusOf(invoice.id), 'confirming');
    const rows = await db().select().from(payments).where(eq(payments.invoiceId, invoice.id));
    assert.equal(rows.length, 0, 'nothing recorded until it is final');
  });
});

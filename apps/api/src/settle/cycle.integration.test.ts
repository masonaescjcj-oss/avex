import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import { DEFAULT_FEE_POLICY, FeePolicy, SettlementRunner } from '@avex/core';
import type {
  ChainAdapter,
  ChainId,
  ChainSigner,
  GasSnapshot,
  SettlementCall,
  SettlementRequest,
} from '@avex/core';
import { eq, like } from 'drizzle-orm';

import { createDatabase, schema } from '../db/client.js';
import { SettlementSource } from '../domain/settlement-source.js';
import { SettlementStore } from '../domain/settlement-store.js';
import { SettlementCycle } from './cycle.js';

/**
 * Settlement, end to end, against a real database.
 *
 * The point of this suite is the one property the whole path exists for and that no unit test
 * can see: **an invoice is settled exactly once**. Every piece of it existed before and nothing
 * joined them up, so what is tested here is the joining — and the two ways it goes wrong are
 * both about the gap between broadcasting a transaction and hearing about it.
 *
 * Pay twice, and a merchant is paid twice out of an address that only held one payment: the
 * second flush moves nothing and the gas is spent. Never mark it settled, and it is re-broadcast
 * forever. Both are silent, which is why the assertions here are about `settled_at` and the
 * settlements table rather than about return values.
 */
const databaseUrl = process.env.DATABASE_URL;

/**
 * Ethereum, because this is the only suite that reads *every* invoice due on a chain.
 *
 * The other suites leave live, paid, unsettled BNB Chain invoices behind as fixtures — over a
 * thousand of them in a working database — and their deposit addresses are strings no chain
 * accepts. A cycle pointed at that chain would batch them, and this suite would be asserting
 * against whatever happened to sort first. Ethereum is the one EVM chain nothing else pays an
 * invoice on, so what the cycle finds here is what this file created.
 *
 * The assertions below are still written about this suite's own invoice and its own transaction
 * hash rather than about totals, so a future suite that starts paying Ethereum invoices makes
 * this slower rather than wrong.
 */
const CHAIN = 'ethereum' as const;

const CHEAP: GasSnapshot = {
  chain: CHAIN,
  nativePriceUsd: 600,
  feePerGasWei: 100_000_000n, // 0.1 gwei — half a cent a settlement, so nothing defers.
  observedAt: 0,
};

const CALL: SettlementCall = { to: '0xfactory', data: '0xdeadbeef', gasLimit: 200_000n };

/** An adapter that prepares a call and nothing else. */
function fakeAdapter(chain: ChainId): ChainAdapter {
  return {
    chain,
    addressModel: 'unique',
    async deriveDepositTarget() {
      throw new Error('not used here');
    },
    async poll() {
      return { payments: [], cursor: null };
    },
    async probeGas() {
      return { ...CHEAP, chain };
    },
    async prepareSettlement() {
      return CALL;
    },
  };
}

/** A signer whose receipts the test decides, one broadcast at a time. */
class FakeSigner implements ChainSigner {
  readonly address = '0x9999999999999999999999999999999999999999';
  readonly broadcasts: { nonce: number; to: string; data: string }[] = [];
  private readonly receipts = new Map<
    string,
    { status: 'success' | 'reverted'; gasUsed: bigint; feePerGasWei: bigint }
  >();
  private counter = 0;

  async pendingNonce() {
    return 5;
  }

  async balanceWei() {
    return 10n ** 20n;
  }

  async broadcast(tx: { nonce: number; to: string; data: string }) {
    /**
     * Random, not a counter.
     *
     * A counter produced the same first hash in every test, and `recordBroadcast` is idempotent
     * on `(chain, txHash)` — so the second test to run found the first one's row already there,
     * with whatever status that test had left it in. The suite failed asserting `pending` and
     * reading `reverted`, which is a real property of the store reported as a mystery.
     */
    const hash = `0x${randomBytes(32).toString('hex')}`;
    this.counter += 1;
    this.broadcasts.push({ nonce: tx.nonce, to: tx.to, data: tx.data });
    return { hash };
  }

  async receipt(hash: string) {
    return this.receipts.get(hash) ?? null;
  }

  /** What the chain will say about a transaction, once the test decides. */
  confirm(hash: string, status: 'success' | 'reverted' = 'success') {
    this.receipts.set(hash, { status, gasUsed: 150_000n, feePerGasWei: CHEAP.feePerGasWei! });
  }

  lastHash(): string {
    return `0x${this.counter.toString(16).padStart(64, 'a')}`;
  }
}

describe('settling, exactly once', { skip: databaseUrl ? false : 'DATABASE_URL is not set' }, () => {
  let database: ReturnType<typeof createDatabase> | undefined;
  const db = () => database!.db;
  let source: SettlementSource;
  let store: SettlementStore;
  let orgId: string;
  let assetId: string;
  let tronAssetId: string;

  before(async () => {
    database = createDatabase(databaseUrl!, { max: 4 });
    source = new SettlementSource(db());
    store = new SettlementStore(db());

    // Anything a previous run of this suite left behind, for the reason on `after`.
    await db().delete(schema.organizations).where(like(schema.organizations.slug, 'settle-%'));

    const unique = randomBytes(5).toString('hex');
    const [org] = await db()
      .insert(schema.organizations)
      .values({ name: `Settle ${unique}`, slug: `settle-${unique}` })
      .returning({ id: schema.organizations.id });
    orgId = org!.id;

    assetId = await asset(CHAIN, 18);
    tronAssetId = await asset('tron', 6);
  });

  /**
   * This suite cleans up after itself, which is unusual here and necessary.
   *
   * It reads *every* invoice due on its chain, so an invoice it leaves paid and unsettled is an
   * invoice the next run finds in its first batch — and the assertion "one transaction went out"
   * fails on the third run for a reason that has nothing to do with the code. Deleting the
   * organisation removes its invoices and quotes by cascade, which is the whole footprint.
   *
   * `after` rather than `before` so a failing run leaves its rows behind to look at; the
   * `before` sweep is what recovers from that once somebody has.
   */
  after(async () => {
    await db().delete(schema.organizations).where(eq(schema.organizations.id, orgId));
    await database?.close();
  });

  async function asset(chain: string, decimals: number): Promise<string> {
    const [row] = await db()
      .insert(schema.assets)
      .values({
        chain,
        symbol: 'USDT',
        contract: `0x${randomBytes(20).toString('hex')}`,
        decimals,
        kind: 'erc20',
        verdict: 'approved',
        probedAt: new Date(),
      })
      .returning({ id: schema.assets.id });
    return row!.id;
  }

  /** A paid invoice, as the watcher would have left it. */
  async function paidInvoice(
    options: {
      readonly chain?: string;
      readonly assetId?: string;
      readonly mode?: 'test' | 'live';
      readonly status?: 'paid' | 'pending' | 'overpaid';
      readonly amountPaid?: string;
    } = {},
  ): Promise<string> {
    const [quote] = await db()
      .insert(schema.quotes)
      .values({
        organizationId: orgId,
        chain: options.chain ?? CHAIN,
        assetSymbol: 'USDT',
        assetDecimals: '18',
        mode: 'fiat',
        amountDue: '20000000000000000000',
        spreadBps: '0',
        sources: [],
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning({ id: schema.quotes.id });

    const [invoice] = await db()
      .insert(schema.invoices)
      .values({
        organizationId: orgId,
        assetId: options.assetId ?? assetId,
        quoteId: quote!.id,
        amountDue: '20000000000000000000',
        amountPaid: options.amountPaid ?? '20000000000000000000',
        status: options.status ?? 'paid',
        mode: options.mode ?? 'live',
        chain: options.chain ?? CHAIN,
        depositAddress: `0x${randomBytes(20).toString('hex')}`,
        payoutAddress: `0x${randomBytes(20).toString('hex')}`,
        expiresAt: new Date(Date.now() + 3_600_000),
        paidAt: new Date(),
      })
      .returning({ id: schema.invoices.id });
    return invoice!.id;
  }

  const settledAt = async (invoiceId: string): Promise<Date | null> => {
    const [row] = await db()
      .select({ settledAt: schema.invoices.settledAt })
      .from(schema.invoices)
      .where(eq(schema.invoices.id, invoiceId))
      .limit(1);
    return row?.settledAt ?? null;
  };

  const settlementRow = async (txHash: string) => {
    const [row] = await db()
      .select()
      .from(schema.settlements)
      .where(eq(schema.settlements.txHash, txHash))
      .limit(1);
    return row;
  };

  /** A cycle with its own runner and signer, so tests do not share a nonce. */
  function build(
    options: {
      readonly gas?: () => Promise<GasSnapshot | null>;
      readonly log?: (message: string, data?: unknown) => void;
    } = {},
  ) {
    const signer = new FakeSigner();
    const runner = new SettlementRunner(CHAIN, signer, new FeePolicy(DEFAULT_FEE_POLICY));

    const cycle = new SettlementCycle({
      chain: CHAIN,
      adapter: fakeAdapter(CHAIN),
      runner,
      feePolicy: new FeePolicy(DEFAULT_FEE_POLICY),
      signer,
      source,
      store,
      gas: options.gas ?? (async () => CHEAP),
      ...(options.log === undefined ? {} : { log: options.log }),
    });

    return { cycle, signer, runner };
  }

  test('an invoice is broadcast once, and settled only when it confirms', async () => {
    const invoiceId = await paidInvoice();
    const { cycle, signer } = build();
    await cycle.start();

    const first = await cycle.once();
    assert.equal(first.enqueued >= 1, true, 'the paid invoice must be found due');
    assert.equal(first.broadcast.length, 1, 'and broadcast in one transaction');
    assert.equal(signer.broadcasts.length, 1);
    assert.equal(signer.broadcasts[0]!.to, CALL.to, 'the call the adapter prepared');

    // Recorded before anything else, because the row is how a dead process finds its work.
    const hash = first.broadcast[0]!;
    const row = await settlementRow(hash);
    assert.ok(row, 'the broadcast must be recorded');
    assert.equal(row.status, 'pending');
    assert.deepEqual(row.invoiceIds.includes(invoiceId), true);

    /**
     * And the invoice is *not* settled yet. This is the assertion that matters most: a
     * transaction in the mempool can be dropped, replaced or reverted, and an invoice marked
     * settled is one nothing will ever look at again.
     */
    assert.equal(await settledAt(invoiceId), null);

    // A second pass while it is in flight must not send it again.
    const second = await cycle.once();
    assert.equal(second.broadcast.length, 0);
    assert.equal(signer.broadcasts.length, 1, 'still one transaction');

    // The chain confirms it.
    signer.confirm(hash);
    const third = await cycle.once();
    assert.equal(third.confirmed, 1);
    assert.equal(third.settled, 1);
    assert.ok(await settledAt(invoiceId), 'now it is settled');

    const confirmedRow = await settlementRow(hash);
    assert.equal(confirmedRow!.status, 'confirmed');
    assert.equal(confirmedRow!.gasUsed, '150000', 'the gas used, not the limit it was sent with');

    // And it is never picked up again.
    const fourth = await cycle.once();
    assert.equal(fourth.enqueued, 0);
    assert.equal(fourth.broadcast.length, 0);
  });

  test('a reverted settlement leaves the invoice due and says so', async () => {
    /**
     * Gas was spent and nothing moved. Marking the invoice settled would hide a merchant not
     * being paid; retrying it in the same breath would spend more gas on the same failing
     * assumption. So the row says reverted and the invoice stays due for a later pass.
     */
    const invoiceId = await paidInvoice();
    const { cycle, signer } = build();
    await cycle.start();

    const first = await cycle.once();
    const hash = first.broadcast[0]!;
    signer.confirm(hash, 'reverted');

    const second = await cycle.once();
    assert.equal(second.reverted, 1);
    assert.equal(second.settled, 0);
    assert.equal(await settledAt(invoiceId), null, 'not settled');
    assert.equal((await settlementRow(hash))!.status, 'reverted');

    /**
     * And it is *not* retried on the next pass, which is the part this test was written to get
     * wrong. It found the invoice due again — the revert had recorded nothing that would stop it
     * — and broadcast a second transaction into the same failure. That is a loop billed to us
     * every pass, so the reverted row now blocks its invoices until somebody looks at why.
     */
    const third = await cycle.once();
    assert.equal(third.enqueued, 0, 'a reverted settlement is not retried automatically');
    assert.equal(signer.broadcasts.length, 1, 'and nothing else was sent');
  });

  test('a settlement left in flight by a previous process is adopted, not repeated', async () => {
    /**
     * The restart case, and the one that pays twice if it is wrong. A process broadcast a
     * transaction, recorded it, and died. The new process reads the pending row, finds the
     * receipt, and marks the invoices settled — rather than finding them due and settling them
     * again out of an address that no longer holds anything.
     */
    const invoiceId = await paidInvoice();
    const orphanHash = `0x${randomBytes(32).toString('hex')}`;
    await store.recordBroadcast({
      chain: CHAIN,
      txHash: orphanHash,
      nonce: 4,
      invoiceIds: [invoiceId],
      feePerGasWei: CHEAP.feePerGasWei!,
      gasLimit: 200_000n,
    });

    const { cycle, signer } = build();
    signer.confirm(orphanHash);

    await cycle.start();
    assert.ok(await settledAt(invoiceId), 'the invoice it carried is settled');
    assert.equal((await settlementRow(orphanHash))!.status, 'confirmed');

    const report = await cycle.once();
    assert.equal(report.enqueued, 0, 'nothing to do');
    assert.equal(signer.broadcasts.length, 0, 'and nothing was sent a second time');
  });

  test('an orphan with no receipt yet is reported, not assumed', async () => {
    /**
     * It may still confirm. What this process cannot do is replace it — the settlements table
     * records the nonce but not the call — so the honest outcome is a line an operator reads,
     * and the invoice stays unsettled rather than being sent again behind a nonce that is
     * blocked anyway.
     */
    const invoiceId = await paidInvoice();
    const orphanHash = `0x${randomBytes(32).toString('hex')}`;
    await store.recordBroadcast({
      chain: CHAIN,
      txHash: orphanHash,
      nonce: 4,
      invoiceIds: [invoiceId],
      feePerGasWei: CHEAP.feePerGasWei!,
      gasLimit: 200_000n,
    });

    const lines: string[] = [];
    const { cycle, signer } = build({ log: (message) => lines.push(message) });

    const started = await cycle.start();
    assert.ok(started.orphans >= 1);
    assert.ok(lines.some((line) => /still pending/.test(line)));
    assert.equal(await settledAt(invoiceId), null);

    /**
     * And crucially, it is not sent again while that transaction is outstanding.
     *
     * This is the double-payment the pending row exists to prevent: the money is already on its
     * way, nothing in this process knows it, and a second flush would find an empty address —
     * spending gas to move nothing while the record showed two settlements for one payment.
     */
    const report = await cycle.once();
    assert.equal(report.enqueued, 0);
    assert.equal(signer.broadcasts.length, 0);
  });

  test('nothing is broadcast without a gas price', async () => {
    /**
     * A transaction needs a fee. Without a live price the choice is between guessing — which is
     * either rejected by the mempool or an overpayment nobody authorised — and waiting. It
     * waits, and the invoice stays due.
     */
    const invoiceId = await paidInvoice();
    const { cycle, signer } = build({ gas: async () => null });
    await cycle.start();

    const report = await cycle.once();
    assert.equal(report.broadcast.length, 0);
    assert.equal(signer.broadcasts.length, 0);
    assert.match(report.note, /no gas snapshot/);
    assert.equal(await settledAt(invoiceId), null);
  });

  describe('what counts as due', () => {
    test('a chain that settles on receipt has nothing due, ever', async () => {
      /**
       * TRON's deposit address is one of the merchant's own wallets. The payer's transfer is the
       * only transaction there is, so a sweep would be a transaction with nothing to move — and
       * the queue refuses these too, which is belt and braces on purpose.
       */
      const invoiceId = await paidInvoice({ chain: 'tron', assetId: tronAssetId });
      assert.deepEqual(await source.due('tron'), []);

      // And it is not quietly settled either: nothing happened to it at all.
      assert.equal(await settledAt(invoiceId), null);
    });

    test('a test invoice is never settled', async () => {
      // Its deposit address is a string no chain accepts, so a settlement would revert — after
      // spending gas to find out.
      const invoiceId = await paidInvoice({ mode: 'test' });
      const due = await source.due(CHAIN);
      assert.ok(!due.some((entry) => entry.invoiceId === invoiceId));
    });

    test('an unpaid invoice and a zero balance are both left alone', async () => {
      const pending = await paidInvoice({ status: 'pending' });
      const empty = await paidInvoice({ amountPaid: '0' });
      const due = await source.due(CHAIN);

      assert.ok(!due.some((entry) => entry.invoiceId === pending), 'nothing has arrived');
      assert.ok(
        !due.some((entry) => entry.invoiceId === empty),
        'a paid invoice with nothing at its address would spend gas on an empty flush',
      );
    });

    test('the request carries what the adapter needs to build the call', async () => {
      // The deposit address, the merchant's payout address, and the asset. Getting any of them
      // from anywhere but the invoice would settle to an address the payer never funded.
      const invoiceId = await paidInvoice();
      const due = await source.due(CHAIN);
      const request = due.find((entry) => entry.invoiceId === invoiceId) as SettlementRequest;

      assert.ok(request);
      assert.match(request.depositAddress, /^0x[0-9a-f]{40}$/);
      assert.match(request.payoutAddress, /^0x[0-9a-f]{40}$/);
      assert.equal(request.asset.chain, CHAIN);
      assert.equal(request.asset.decimals, 18);
      assert.equal(request.amount, 20_000_000_000_000_000_000n);
    });
  });
});

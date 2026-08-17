import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import type {
  ChainAdapter,
  DeriveInput,
  DepositTarget,
  PollCursor,
  PollResult,
  SettlementRequest,
  SettlementResult,
} from '../chains/ChainAdapter.js';
import type { Asset, ChainId, GasSnapshot, IncomingPayment, Invoice } from '../types.js';
import { paymentKey } from '../types.js';
import { InvoiceService, type InvoiceStore } from './InvoiceService.js';

/**
 * The invoice lifecycle, on doubles rather than a chain.
 *
 * Two properties here are the ones a payment gateway cannot get wrong, and both are
 * about repetition rather than the happy path. Watchers re-scan overlapping block
 * ranges after every restart and RPC providers replay logs, so a service that
 * credits on each sighting pays a merchant twice for one payment. And a confirmed
 * transfer can still vanish in a reorg, so a credit has to be withdrawable — which
 * means `amountPaid` must be recomputable rather than a total that only rises.
 *
 * A third property arrived with percentage pricing: the fee is part of what the
 * deposit address commits to, so it has to be snapshotted at creation and carried
 * to settlement unchanged. Settling with today's fee instead of the quoted one
 * derives an address nobody funded, and the money stops being reachable.
 */

const USDT: Asset = {
  chain: 'bsc',
  symbol: 'USDT',
  decimals: 18,
  kind: 'erc20',
  contract: '0x55d398326f99059fF775485246999027B3197955',
};

const OTHER_TOKEN: Asset = { ...USDT, symbol: 'BUSD', contract: '0xAAAA' };

const MERCHANT = '0x1111111111111111111111111111111111111111';
const FEE_COLLECTOR = '0x3333333333333333333333333333333333333333';

const ONE = 10n ** 18n;

/** In-memory store, with the same contract the Postgres one has to honour. */
class MemoryStore implements InvoiceStore {
  readonly invoices = new Map<string, Invoice>();
  readonly credited = new Map<string, { invoiceId: string; amount: bigint }>();

  async get(id: string): Promise<Invoice | null> {
    return this.invoices.get(id) ?? null;
  }

  async put(invoice: Invoice): Promise<void> {
    this.invoices.set(invoice.id, invoice);
  }

  async findByDepositAddress(chain: ChainId, address: string): Promise<Invoice | null> {
    for (const invoice of this.invoices.values()) {
      if (
        invoice.asset.chain === chain &&
        invoice.depositAddress.toLowerCase() === address.toLowerCase()
      ) {
        return invoice;
      }
    }
    return null;
  }

  async findByMemo(chain: ChainId, memo: string): Promise<Invoice | null> {
    for (const invoice of this.invoices.values()) {
      if (invoice.asset.chain === chain && invoice.memo === memo) return invoice;
    }
    return null;
  }

  async hasPayment(key: string): Promise<boolean> {
    return this.credited.has(key);
  }

  async recordPayment(key: string, invoiceId: string, amount: bigint): Promise<void> {
    // The real store has a unique constraint here. Modelling it matters: the whole
    // point of the key is that a second insert must not quietly succeed.
    if (this.credited.has(key)) throw new Error(`duplicate payment ${key}`);
    this.credited.set(key, { invoiceId, amount });
  }

  async removePayment(key: string): Promise<{ invoiceId: string; amount: bigint } | null> {
    const found = this.credited.get(key);
    if (!found) return null;
    this.credited.delete(key);
    return found;
  }
}

/**
 * An adapter that derives an address from every input that the real EVM one hashes.
 *
 * Deliberately not a stub returning a constant: the fee tests below are about the
 * address changing when the fee does, and a constant address would let a broken
 * derivation pass.
 */
class FakeEvmAdapter implements ChainAdapter {
  readonly addressModel = 'unique' as const;
  readonly settled: SettlementRequest[] = [];

  constructor(readonly chain: ChainId = 'bsc') {}

  async deriveDepositTarget(input: DeriveInput): Promise<DepositTarget> {
    const fee = input.fee ? `${input.fee.feeDestination}:${input.fee.feeBps}` : 'none';
    return { address: `0xdep${hash(`${input.invoiceId}|${input.payoutAddress}|${fee}`)}` };
  }

  async probeGas(): Promise<GasSnapshot> {
    return { chain: this.chain, nativePriceUsd: 600, feePerGasWei: 10n ** 9n, observedAt: 0 };
  }

  async poll(): Promise<PollResult> {
    return { payments: [], cursor: null as PollCursor };
  }

  async settle(batch: readonly SettlementRequest[]): Promise<readonly SettlementResult[]> {
    this.settled.push(...batch);
    return [{ txHash: '0xtx', feePaid: 0n, invoiceIds: batch.map((r) => r.invoiceId) }];
  }

  confirmationsFor(): number {
    return 15;
  }
}

/**
 * A shared-address chain, which matches on memo rather than on address.
 *
 * A sibling of the EVM double rather than a subclass: `addressModel` is a literal
 * type, so a subclass cannot narrow it to a different one.
 */
class FakeMemoAdapter implements ChainAdapter {
  readonly addressModel = 'shared-memo' as const;

  constructor(readonly chain: ChainId = 'ton') {}

  async deriveDepositTarget(input: DeriveInput): Promise<DepositTarget> {
    // Every invoice shares one address; the memo is what distinguishes them.
    return { address: '0xshared', memo: `memo-${input.invoiceId}` };
  }

  async probeGas(): Promise<GasSnapshot> {
    return { chain: this.chain, nativePriceUsd: 5, observedAt: 0 };
  }

  async poll(): Promise<PollResult> {
    return { payments: [], cursor: null as PollCursor };
  }

  async settle(): Promise<readonly SettlementResult[]> {
    // Shared-memo chains deliver straight to the merchant, so there is nothing to
    // sweep — the payer's transfer already landed in the destination wallet.
    return [];
  }

  confirmationsFor(): number {
    return 50;
  }
}

/** Records what was released, so a test can assert money moved exactly once. */
class RecordingQueue {
  readonly enqueued: SettlementRequest[] = [];

  enqueue(request: SettlementRequest): void {
    this.enqueued.push(request);
  }
}

function hash(text: string): string {
  let value = 0;
  for (const character of text) value = (value * 31 + character.charCodeAt(0)) | 0;
  return Math.abs(value).toString(16).padStart(8, '0');
}

function payment(overrides: Partial<IncomingPayment> & { to: string }): IncomingPayment {
  return {
    chain: 'bsc',
    txHash: '0xabc',
    transferIndex: 0,
    asset: USDT,
    amount: ONE,
    blockNumber: 100,
    confirmations: 20,
    ...overrides,
  };
}

describe('InvoiceService', () => {
  let store: MemoryStore;
  let adapter: FakeEvmAdapter;
  let queue: RecordingQueue;
  let service: InvoiceService;

  beforeEach(() => {
    store = new MemoryStore();
    adapter = new FakeEvmAdapter();
    queue = new RecordingQueue();
    service = new InvoiceService(
      store,
      new Map<ChainId, ChainAdapter>([['bsc', adapter]]),
      queue as never,
      // $1 a token, so a one-token payment sits under every high-value threshold.
      () => 1,
    );
  });

  const create = (overrides: Partial<Parameters<InvoiceService['create']>[0]> = {}) =>
    service.create({
      id: 'inv_1',
      merchantId: 'org_1',
      asset: USDT,
      amountDue: ONE,
      payoutAddress: MERCHANT,
      ttlMs: 3_600_000,
      ...overrides,
    });

  // ── creation ───────────────────────────────────────────────────────────────

  test('a new invoice is pending, unpaid, and bound to a derived address', async () => {
    const invoice = await create();

    assert.equal(invoice.status, 'pending');
    assert.equal(invoice.amountPaid, 0n);
    assert.equal(invoice.payoutAddress, MERCHANT);
    assert.ok(invoice.depositAddress.startsWith('0xdep'));
    // Persisted, not just returned: the watcher finds invoices through the store.
    assert.equal((await store.get('inv_1'))?.depositAddress, invoice.depositAddress);
  });

  test('a zero or negative amount is refused', async () => {
    // An invoice for nothing is either a bug upstream or an attempt to make every
    // payment an overpayment. Neither should reach the database.
    await assert.rejects(() => create({ amountDue: 0n }), /amountDue must be positive/);
    await assert.rejects(() => create({ amountDue: -1n }), /amountDue must be positive/);
  });

  test('an unsupported chain is refused rather than silently unwatched', async () => {
    // An invoice on a chain with no adapter would take a payment nobody is looking
    // for, which is worse than a rejected request.
    await assert.rejects(
      () => create({ asset: { ...USDT, chain: 'solana' } }),
      /no adapter for chain solana/,
    );
  });

  // ── the fee snapshot ───────────────────────────────────────────────────────

  test('a fee changes the deposit address', async () => {
    /**
     * On EVM chains the fee is a constructor argument to the forwarder, so it feeds
     * the init code hash CREATE2 uses. Two invoices identical but for their fee must
     * not share an address, or one of them is unsettleable.
     */
    const free = await create({ id: 'inv_free' });
    const charged = await create({
      id: 'inv_free',
      fee: { feeDestination: FEE_COLLECTOR, feeBps: 100 },
    });

    assert.notEqual(free.depositAddress, charged.depositAddress);
  });

  test('the fee is snapshotted on the invoice, not looked up later', async () => {
    const fee = { feeDestination: FEE_COLLECTOR, feeBps: 150 };
    await create({ fee });

    const stored = await store.get('inv_1');
    assert.deepEqual(stored?.fee, fee);
  });

  test('an invoice without a fee records none, rather than a zero-fee object', async () => {
    // `undefined` and `{feeBps: 0}` derive different addresses off-chain only if the
    // two sides disagree about the convention, so the absence must stay an absence.
    await create();
    assert.equal((await store.get('inv_1'))?.fee, undefined);
  });

  test('settlement is released with the fee the invoice was quoted with', async () => {
    /**
     * The property the whole snapshot exists for. If settlement used a current
     * configuration value instead, a pricing change between quote and sweep would
     * derive an address the payer never funded — and the funds would sit in the
     * forwarder with nothing able to reach them.
     */
    const fee = { feeDestination: FEE_COLLECTOR, feeBps: 200 };
    const invoice = await create({ fee });

    await service.applyPayment(payment({ to: invoice.depositAddress }));

    assert.equal(queue.enqueued.length, 1);
    assert.deepEqual(queue.enqueued[0]?.fee, fee);
    assert.equal(queue.enqueued[0]?.depositAddress, invoice.depositAddress);
  });

  test('a free invoice releases settlement with no fee attached', async () => {
    const invoice = await create();
    await service.applyPayment(payment({ to: invoice.depositAddress }));

    assert.equal(queue.enqueued.length, 1);
    assert.equal(queue.enqueued[0]?.fee, undefined);
  });

  // ── idempotency ────────────────────────────────────────────────────────────

  test('the same transfer seen twice is credited once', async () => {
    /**
     * The single most important test here. A watcher re-scans overlapping ranges
     * after a restart, so this exact sequence happens in normal operation — not
     * only under attack.
     */
    const invoice = await create();
    const seen = payment({ to: invoice.depositAddress });

    const first = await service.applyPayment(seen);
    const second = await service.applyPayment(seen);

    assert.equal(first.kind, 'status');
    assert.equal(second.kind, 'ignored');
    assert.match(second.kind === 'ignored' ? second.reason : '', /already credited/);
    assert.equal((await store.get('inv_1'))?.amountPaid, ONE);
    // And the merchant is paid once, not twice.
    assert.equal(queue.enqueued.length, 1);
  });

  test('two transfers in one transaction are distinct payments', async () => {
    // A batching contract can emit several Transfers in one transaction. Keying on
    // the hash alone would credit the first and discard the rest.
    const invoice = await create({ amountDue: 2n * ONE });
    const to = invoice.depositAddress;

    await service.applyPayment(payment({ to, transferIndex: 0, amount: ONE }));
    await service.applyPayment(payment({ to, transferIndex: 1, amount: ONE }));

    assert.equal((await store.get('inv_1'))?.amountPaid, 2n * ONE);
    assert.equal((await store.get('inv_1'))?.status, 'paid');
  });

  test('a transfer to an unknown address is ignored, never guessed at', async () => {
    await create();
    const result = await service.applyPayment(payment({ to: '0xdepUNKNOWN' }));

    assert.equal(result.kind, 'ignored');
    assert.match(result.kind === 'ignored' ? result.reason : '', /no matching invoice/);
    assert.equal(queue.enqueued.length, 0);
  });

  test('the wrong token to the right address is ignored', async () => {
    /**
     * A forwarder address will accept any token. Crediting whatever arrives would
     * mean a worthless clone could pay an invoice denominated in USDT.
     */
    const invoice = await create();
    const result = await service.applyPayment(
      payment({ to: invoice.depositAddress, asset: OTHER_TOKEN }),
    );

    assert.equal(result.kind, 'ignored');
    assert.match(result.kind === 'ignored' ? result.reason : '', /asset mismatch/);
    assert.equal((await store.get('inv_1'))?.amountPaid, 0n);
  });

  // ── confirmations ──────────────────────────────────────────────────────────

  test('an unconfirmed payment moves the invoice to confirming without crediting', async () => {
    // The payer needs to see that their transfer was noticed, and the merchant must
    // not be told it is final. Both, from one state.
    const invoice = await create();
    const result = await service.applyPayment(
      payment({ to: invoice.depositAddress, confirmations: 1 }),
    );

    assert.equal(result.kind, 'status');
    assert.equal((await store.get('inv_1'))?.status, 'confirming');
    assert.equal((await store.get('inv_1'))?.amountPaid, 0n);
    assert.equal(queue.enqueued.length, 0);
  });

  test('a payment confirming twice does not re-announce', async () => {
    // Otherwise every poll while a payment matures fires another webhook.
    const invoice = await create();
    const seen = payment({ to: invoice.depositAddress, confirmations: 1 });

    await service.applyPayment(seen);
    const second = await service.applyPayment(seen);

    assert.equal(second.kind, 'ignored');
    assert.match(second.kind === 'ignored' ? second.reason : '', /awaiting 15 confirmations/);
  });

  test('the same payment credits once it has matured', async () => {
    // The realistic sequence: seen at 1 confirmation, then again at 20. The first
    // sighting must not have consumed the idempotency key.
    const invoice = await create();
    await service.applyPayment(payment({ to: invoice.depositAddress, confirmations: 1 }));
    await service.applyPayment(payment({ to: invoice.depositAddress, confirmations: 20 }));

    assert.equal((await store.get('inv_1'))?.status, 'paid');
    assert.equal((await store.get('inv_1'))?.amountPaid, ONE);
  });

  // ── tolerance ──────────────────────────────────────────────────────────────

  test('a payment a little short is still paid, within tolerance', async () => {
    // Exchanges round withdrawal amounts. A strict equality check rejects payments
    // made in good faith, and a merchant loses a sale over four wei.
    const invoice = await create({ amountDue: 10_000n, toleranceBps: 50 });
    await service.applyPayment(payment({ to: invoice.depositAddress, amount: 9_950n }));

    assert.equal((await store.get('inv_1'))?.status, 'paid');
    assert.equal(queue.enqueued.length, 1);
  });

  test('a payment beyond tolerance is underpaid and releases nothing', async () => {
    const invoice = await create({ amountDue: 10_000n, toleranceBps: 50 });
    await service.applyPayment(payment({ to: invoice.depositAddress, amount: 9_000n }));

    assert.equal((await store.get('inv_1'))?.status, 'underpaid');
    // Under- and overpayments need a decision before money moves.
    assert.equal(queue.enqueued.length, 0);
  });

  test('a payment beyond tolerance upward is overpaid and also releases nothing', async () => {
    const invoice = await create({ amountDue: 10_000n, toleranceBps: 50 });
    await service.applyPayment(payment({ to: invoice.depositAddress, amount: 20_000n }));

    assert.equal((await store.get('inv_1'))?.status, 'overpaid');
    assert.equal(queue.enqueued.length, 0);
  });

  test('an underpayment topped up becomes paid and releases once', async () => {
    const invoice = await create({ amountDue: 2n * ONE });
    const to = invoice.depositAddress;

    await service.applyPayment(payment({ to, transferIndex: 0, amount: ONE }));
    assert.equal((await store.get('inv_1'))?.status, 'underpaid');
    assert.equal(queue.enqueued.length, 0);

    await service.applyPayment(payment({ to, transferIndex: 1, amount: ONE }));
    assert.equal((await store.get('inv_1'))?.status, 'paid');
    assert.equal(queue.enqueued.length, 1);
  });

  // ── reversal ───────────────────────────────────────────────────────────────

  test('a reversed payment is withdrawn from the total', async () => {
    /**
     * A reorg can take back a transfer we already confirmed. If `amountPaid` were a
     * running total that only rose, there would be no way to undo the credit, and
     * the invoice would claim money that no longer exists on the chain.
     */
    const invoice = await create();
    const seen = payment({ to: invoice.depositAddress });
    await service.applyPayment(seen);

    const result = await service.reversePayment(paymentKey(seen));

    assert.equal(result.kind, 'status');
    assert.equal((await store.get('inv_1'))?.amountPaid, 0n);
    // Back to pending, not left as paid-with-nothing-behind-it.
    assert.equal((await store.get('inv_1'))?.status, 'pending');
  });

  test('reversing one of two payments leaves the other credited', async () => {
    const invoice = await create({ amountDue: 2n * ONE });
    const to = invoice.depositAddress;
    const first = payment({ to, transferIndex: 0, amount: ONE });
    await service.applyPayment(first);
    await service.applyPayment(payment({ to, transferIndex: 1, amount: ONE }));

    await service.reversePayment(paymentKey(first));

    assert.equal((await store.get('inv_1'))?.amountPaid, ONE);
    assert.equal((await store.get('inv_1'))?.status, 'underpaid');
  });

  test('a reversed payment can be re-credited if it comes back', async () => {
    // A reorg can also restore a transaction. Reversal must release the idempotency
    // key, or a payment that returned to the chain could never be credited again.
    const invoice = await create();
    const seen = payment({ to: invoice.depositAddress });

    await service.applyPayment(seen);
    await service.reversePayment(paymentKey(seen));
    const again = await service.applyPayment(seen);

    assert.equal(again.kind, 'status');
    assert.equal((await store.get('inv_1'))?.amountPaid, ONE);
  });

  test('reversing an unknown payment is ignored rather than an error', async () => {
    // Reorg handling runs speculatively; a reversal for something never credited is
    // an ordinary outcome, not a fault.
    const result = await service.reversePayment('bsc:0xnope:0');
    assert.equal(result.kind, 'ignored');
    assert.match(result.kind === 'ignored' ? result.reason : '', /no such credited payment/);
  });

  // ── expiry ─────────────────────────────────────────────────────────────────

  test('an invoice past its expiry expires', async () => {
    const invoice = await create({ ttlMs: 1_000 });
    const result = await service.expire(invoice.id, invoice.createdAt + 2_000);

    assert.equal(result.kind, 'status');
    assert.equal((await store.get('inv_1'))?.status, 'expired');
  });

  test('an invoice still inside its window does not expire', async () => {
    const invoice = await create({ ttlMs: 3_600_000 });
    const result = await service.expire(invoice.id, invoice.createdAt + 1_000);

    assert.equal(result.kind, 'ignored');
    assert.equal((await store.get('inv_1'))?.status, 'pending');
  });

  test('a paid invoice does not expire out from under a payer', async () => {
    /**
     * The race that matters: a payer sends at the last second and the transfer
     * confirms after the deadline. Expiring a paid invoice would leave funds at an
     * address whose invoice says nothing is owed.
     */
    const invoice = await create({ ttlMs: 1_000 });
    await service.applyPayment(payment({ to: invoice.depositAddress }));

    const result = await service.expire(invoice.id, invoice.createdAt + 10_000);
    assert.equal(result.kind, 'ignored');
    assert.match(result.kind === 'ignored' ? result.reason : '', /status paid is terminal/);
    assert.equal((await store.get('inv_1'))?.status, 'paid');
  });

  test('a confirming invoice can still expire', async () => {
    // Deliberately different from `paid`: a transfer that was seen but never matured
    // has not delivered anything, and holding the invoice open forever would leave a
    // deposit address live indefinitely.
    const invoice = await create({ ttlMs: 1_000 });
    await service.applyPayment(payment({ to: invoice.depositAddress, confirmations: 1 }));

    const result = await service.expire(invoice.id, invoice.createdAt + 10_000);
    assert.equal(result.kind, 'status');
    assert.equal((await store.get('inv_1'))?.status, 'expired');
  });

  // ── shared-address chains ──────────────────────────────────────────────────

  test('on a shared-address chain the memo identifies the invoice', async () => {
    const memoAdapter = new FakeMemoAdapter('ton');
    const memoService = new InvoiceService(
      store,
      new Map<ChainId, ChainAdapter>([['ton', memoAdapter]]),
      queue as never,
      () => 1,
    );
    const asset: Asset = { chain: 'ton', symbol: 'TON', decimals: 9, kind: 'native' };

    const invoice = await memoService.create({
      id: 'inv_ton',
      merchantId: 'org_1',
      asset,
      amountDue: ONE,
      payoutAddress: 'EQmerchant',
      ttlMs: 3_600_000,
    });
    assert.equal(invoice.memo, 'memo-inv_ton');

    await memoService.applyPayment({
      chain: 'ton',
      txHash: '0xton',
      transferIndex: 0,
      to: '0xshared',
      memo: invoice.memo,
      asset,
      amount: ONE,
      blockNumber: 1,
      confirmations: 50,
    });

    assert.equal((await store.get('inv_ton'))?.status, 'paid');
  });

  test('a memo-chain payment with no memo is ignored, not matched by address', async () => {
    /**
     * Every invoice on a shared-address chain has the same deposit address, so
     * falling back to address matching would credit an arbitrary invoice. A payer who
     * omits the memo has to be handled by reconciliation, not by a guess.
     */
    const memoAdapter = new FakeMemoAdapter('ton');
    const memoService = new InvoiceService(
      store,
      new Map<ChainId, ChainAdapter>([['ton', memoAdapter]]),
      queue as never,
      () => 1,
    );
    const asset: Asset = { chain: 'ton', symbol: 'TON', decimals: 9, kind: 'native' };

    await memoService.create({
      id: 'inv_ton2',
      merchantId: 'org_1',
      asset,
      amountDue: ONE,
      payoutAddress: 'EQmerchant',
      ttlMs: 3_600_000,
    });

    const result = await memoService.applyPayment({
      chain: 'ton',
      txHash: '0xton2',
      transferIndex: 0,
      to: '0xshared',
      asset,
      amount: ONE,
      blockNumber: 1,
      confirmations: 50,
    });

    assert.equal(result.kind, 'ignored');
    assert.match(result.kind === 'ignored' ? result.reason : '', /no matching invoice/);
  });
});

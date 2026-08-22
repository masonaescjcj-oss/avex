import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { ChainAdapter, SettlementCall, SettlementRequest } from '../chains/ChainAdapter.js';
import { DEFAULT_FEE_POLICY, FeePolicy } from '../fees/FeePolicy.js';
import type { Asset, ChainId, GasSnapshot } from '../types.js';
import { DEFAULT_QUEUE_CONFIG, SettlementQueue } from './SettlementQueue.js';
import type { Broadcaster } from './SettlementQueue.js';

/**
 * When a batch is sent, which is a different question from whether it can be.
 *
 * The queue holds settlements while a chain is expensive and lets them go when it is cheap or
 * when they have waited long enough. It is the highest-leverage cost control in the system —
 * funds sit at an address that can only pay their merchant, so deferring is safe, and on a busy
 * chain the difference between settling on receipt and settling at a moment of our choosing is
 * roughly an order of magnitude.
 *
 * It had no tests, and until this change it also broadcast through the adapter — a second
 * settlement path with no nonce and no memory of what was outstanding. Now it prepares a call
 * and hands it to the runner, so what is worth testing is the handover: that a refusal is not
 * counted as a failure, that an exception is, and that neither loses a merchant's money.
 */

const USDT: Asset = {
  symbol: 'USDT',
  chain: 'bsc',
  decimals: 18,
  kind: 'erc20',
  contract: '0x55d398326f99059ff775485246999027b3197955',
};

const CALL: SettlementCall = { to: '0xfactory', data: '0xdead', gasLimit: 400_000n };

const request = (id: string): SettlementRequest => ({
  invoiceId: id,
  depositAddress: `0xdep${id}`,
  payoutAddress: '0xpayout',
  asset: USDT,
  amount: 20_000_000_000_000_000_000n,
});

/**
 * A gas snapshot, in wei per gas rather than gwei.
 *
 * Wei because the thresholds are finer than a gwei on this chain: `deferAboveUsd.bsc` is five
 * cents, a deploy-and-flush is 400,000 gas, and BNB is priced in the hundreds — so one whole
 * gwei is already about 24 cents and would be deferred. Which is a real fact about the
 * configured limits and not what these tests are about, so `CHEAP` is a tenth of a gwei.
 */
const snapshot = (feePerGasWei: bigint): GasSnapshot => ({
  chain: 'bsc',
  nativePriceUsd: 600,
  feePerGasWei,
  observedAt: 0,
});

const CHEAP = 100_000_000n; // 0.1 gwei — about 2.4 cents for one settlement.
const EXPENSIVE = 100_000_000_000n; // 100 gwei.

/** An adapter that prepares a call and records what it was asked to prepare. */
function fakeAdapter(options: { readonly gas: GasSnapshot; readonly call?: SettlementCall | null }) {
  const prepared: SettlementRequest[][] = [];
  const adapter = {
    chain: 'bsc' as ChainId,
    addressModel: 'unique' as const,
    async deriveDepositTarget() {
      throw new Error('not used');
    },
    async poll() {
      return { payments: [], cursor: null };
    },
    async probeGas() {
      return options.gas;
    },
    async prepareSettlement(batch: readonly SettlementRequest[]) {
      prepared.push([...batch]);
      return options.call === undefined ? CALL : options.call;
    },
  } satisfies ChainAdapter;
  return { adapter, prepared };
}

/** A runner that answers however the test needs, and records what it was handed. */
function fakeBroadcaster(
  answer: (nth: number) => Awaited<ReturnType<Broadcaster['settle']>>,
): Broadcaster & { readonly seen: { batch: readonly SettlementRequest[]; call: SettlementCall }[] } {
  const seen: { batch: readonly SettlementRequest[]; call: SettlementCall }[] = [];
  return {
    seen,
    async settle(batch, call) {
      seen.push({ batch, call });
      return answer(seen.length);
    },
  };
}

const ok = (hash: string) => ({ ok: true as const, transaction: { hash } });

function queueWith(input: {
  readonly gas: GasSnapshot;
  readonly broadcaster: Broadcaster;
  readonly call?: SettlementCall | null;
}) {
  const { adapter, prepared } = fakeAdapter({ gas: input.gas, ...(input.call === undefined ? {} : { call: input.call }) });
  const queue = new SettlementQueue(
    new Map<ChainId, ChainAdapter>([['bsc', adapter]]),
    new FeePolicy(DEFAULT_FEE_POLICY),
    input.broadcaster,
  );
  return { queue, prepared };
}

describe('holding settlements until the chain is cheap', () => {
  test('a cheap chain settles at once', async () => {
    const broadcaster = fakeBroadcaster(() => ok('0xaaa'));
    const { queue } = queueWith({ gas: snapshot(CHEAP), broadcaster });

    queue.enqueue(request('i1'), 0);
    queue.enqueue(request('i2'), 0);
    const [report] = await queue.drain(1_000);

    assert.deepEqual(report!.broadcast, ['0xaaa']);
    assert.equal(report!.deferred, 0);
    assert.equal(broadcaster.seen.length, 1, 'one transaction for both invoices');
    assert.equal(broadcaster.seen[0]!.batch.length, 2);
  });

  test('an expensive chain holds, and says what it is waiting for', async () => {
    /**
     * The whole point of the queue. Nothing is broadcast, nothing is lost, and the note carries
     * the figure — an operator asking "why has nothing settled on Ethereum today" needs the
     * price, not the word "deferred".
     */
    const broadcaster = fakeBroadcaster(() => ok('0xaaa'));
    const { queue } = queueWith({ gas: snapshot(EXPENSIVE), broadcaster });

    queue.enqueue(request('i1'), 0);
    const [report] = await queue.drain(1_000);

    assert.deepEqual(report!.broadcast, []);
    assert.equal(report!.deferred, 1);
    assert.match(report!.note, /^holding 1: \$\d/);
    assert.equal(broadcaster.seen.length, 0);
  });

  test('a batch held too long goes anyway', async () => {
    /**
     * Deferring is safe but not free: funds a merchant cannot see are funds they will ask about,
     * and a chain that stays expensive for a week would hold them for a week. The deadline is
     * what makes the deferral a cost control rather than a hostage situation.
     */
    const broadcaster = fakeBroadcaster(() => ok('0xaaa'));
    const { queue } = queueWith({ gas: snapshot(EXPENSIVE), broadcaster });

    queue.enqueue(request('i1'), 0);
    const [report] = await queue.drain(DEFAULT_QUEUE_CONFIG.maxDeferralMs + 1);

    assert.deepEqual(report!.broadcast, ['0xaaa']);
    assert.match(report!.note, /deferral deadline/);
  });

  test('a refusal returns the batch to the front and costs it no attempt', async () => {
    /**
     * The distinction this change introduced. The runner refuses for reasons that pass — the gas
     * price is above its ceiling, the spend window is full, a nonce is stuck — so counting a
     * refusal as an attempt would abandon a merchant's settlement because the chain was busy.
     *
     * Refused five times and then accepted: with the refusals counted, `maxAttempts` of five
     * would have dropped it to the operator queue before the sixth.
     */
    const broadcaster = fakeBroadcaster((nth) =>
      nth <= 5
        ? { ok: false as const, reason: 'spend_cap', detail: 'window full' }
        : ok('0xbbb'),
    );
    const { queue } = queueWith({ gas: snapshot(CHEAP), broadcaster });

    queue.enqueue(request('i1'), 0);
    for (let i = 0; i < 5; i++) {
      const [report] = await queue.drain(1_000);
      assert.deepEqual(report!.broadcast, [], `attempt ${i + 1}`);
      assert.equal(report!.failed, 0, 'a refusal is not a failure');
      assert.match(report!.note, /refused 1: spend_cap/);
    }

    const [final] = await queue.drain(1_000);
    assert.deepEqual(final!.broadcast, ['0xbbb'], 'still there, and still settled');
  });

  test('an exception is a failure, and is given up on eventually', async () => {
    /**
     * The other half. A throw is not a considered refusal — an RPC that rejects, a malformed
     * call — and retrying it forever means a queue that never drains and a merchant who is never
     * told. After `maxAttempts` the item is dropped with a log line for an operator.
     */
    const broadcaster: Broadcaster = {
      async settle() {
        throw new Error('rpc exploded');
      },
    };
    const logged: string[] = [];
    const { adapter } = fakeAdapter({ gas: snapshot(CHEAP) });
    const queue = new SettlementQueue(
      new Map<ChainId, ChainAdapter>([['bsc', adapter]]),
      new FeePolicy(DEFAULT_FEE_POLICY),
      broadcaster,
      DEFAULT_QUEUE_CONFIG,
      (message) => logged.push(message),
    );

    queue.enqueue(request('i1'), 0);
    for (let i = 0; i < DEFAULT_QUEUE_CONFIG.maxAttempts - 1; i++) {
      const [report] = await queue.drain(1_000);
      assert.equal(report!.failed, 0, `attempt ${i + 1} is retried`);
      assert.match(report!.note, /rpc exploded/);
    }

    const [final] = await queue.drain(1_000);
    assert.equal(final!.failed, 1);
    assert.equal(queue.depth('bsc'), 0, 'and it is out of the queue rather than spinning');
    assert.ok(logged.some((line) => /needs manual review/.test(line)));
  });

  test('a chain that settles on receipt is never enqueued', async () => {
    /**
     * TON's one shared address and TRON's pool of the merchant's own wallets both receive the
     * payer's transfer directly, so the funds are already where they are going. Enqueuing them
     * would mean a sweep with nothing to move.
     */
    const logged: string[] = [];
    const { adapter } = fakeAdapter({ gas: snapshot(CHEAP) });
    const tron = { ...adapter, chain: 'tron' as ChainId } as unknown as ChainAdapter;
    const queue = new SettlementQueue(
      new Map<ChainId, ChainAdapter>([['tron', tron]]),
      new FeePolicy(DEFAULT_FEE_POLICY),
      fakeBroadcaster(() => ok('0xaaa')),
      DEFAULT_QUEUE_CONFIG,
      (message) => logged.push(message),
    );

    queue.enqueue({ ...request('i1'), asset: { ...USDT, chain: 'tron' } }, 0);
    assert.equal(queue.depth('tron'), 0);
    assert.ok(logged.some((line) => /settles on receipt/.test(line)));
  });

  test('a prepared call of null completes the batch rather than retrying it', async () => {
    /**
     * Belt and braces: `enqueue` already refuses the chains that answer null. If one got
     * through, requeuing would spin forever on a chain that will never produce a transaction.
     */
    const broadcaster = fakeBroadcaster(() => ok('0xaaa'));
    const { queue } = queueWith({ gas: snapshot(CHEAP), broadcaster, call: null });

    queue.enqueue(request('i1'), 0);
    const [report] = await queue.drain(1_000);

    assert.deepEqual(report!.broadcast, []);
    assert.equal(report!.failed, 0);
    assert.equal(queue.depth('bsc'), 0);
    assert.match(report!.note, /needed no transaction/);
  });

  test('the batch is bounded, and the rest stays queued', async () => {
    const broadcaster = fakeBroadcaster(() => ok('0xaaa'));
    const { queue } = queueWith({ gas: snapshot(CHEAP), broadcaster });

    for (let i = 0; i < DEFAULT_QUEUE_CONFIG.maxBatchSize + 3; i++) {
      queue.enqueue(request(`i${i}`), 0);
    }
    const [report] = await queue.drain(1_000);

    assert.equal(broadcaster.seen[0]!.batch.length, DEFAULT_QUEUE_CONFIG.maxBatchSize);
    assert.equal(report!.deferred, 3);
  });

  test('the call the runner receives is the one the adapter prepared', async () => {
    // The queue must not rewrite the bytes. It decides when, and nothing about what.
    const broadcaster = fakeBroadcaster(() => ok('0xaaa'));
    const { queue, prepared } = queueWith({ gas: snapshot(CHEAP), broadcaster });

    queue.enqueue(request('i1'), 0);
    await queue.drain(1_000);

    assert.deepEqual(broadcaster.seen[0]!.call, CALL);
    assert.deepEqual(prepared[0]!.map((r) => r.invoiceId), ['i1']);
  });
});

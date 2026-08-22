import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ChainAdapter, PollCursor, PollResult } from '../chains/ChainAdapter.js';
import type { Asset, IncomingPayment } from '../types.js';
import { paymentKey } from '../types.js';
import {
  DEFAULT_WATCHER,
  Watcher,
  type BlockRef,
  type BlockSource,
  type PaymentSink,
  type WatchStateStore,
} from './Watcher.js';

const USDT: Asset = {
  symbol: 'USDT',
  chain: 'bsc',
  decimals: 18,
  kind: 'erc20',
  contract: '0x55d398326f99059fF775485246999027B3197955',
};

/**
 * A chain the test controls, including its history.
 *
 * Reorgs cannot be provoked on a real chain, so simulating one is the only way to
 * test the behaviour that matters most here.
 */
class FakeChain implements BlockSource {
  /** number -> hash. Rewriting an entry is a reorg. */
  private blocks = new Map<number, string>();

  constructor(height: number, suffix = 'a') {
    for (let number = 0; number <= height; number++) {
      this.blocks.set(number, `0x${number}${suffix}`);
    }
  }

  get height(): number {
    return Math.max(...this.blocks.keys());
  }

  async head(): Promise<BlockRef> {
    const number = this.height;
    return { number, hash: this.blocks.get(number)! };
  }

  async blockAt(number: number): Promise<BlockRef | null> {
    const hash = this.blocks.get(number);
    return hash === undefined ? null : { number, hash };
  }

  /** Rewrite history from `fromBlock` upward, as a reorg does. */
  reorg(fromBlock: number, newHeight: number, suffix = 'b'): void {
    for (const number of [...this.blocks.keys()]) {
      if (number >= fromBlock) this.blocks.delete(number);
    }
    for (let number = fromBlock; number <= newHeight; number++) {
      this.blocks.set(number, `0x${number}${suffix}`);
    }
  }

  /** Drop the top of the chain without replacing it. */
  truncate(toBlock: number): void {
    for (const number of [...this.blocks.keys()]) {
      if (number > toBlock) this.blocks.delete(number);
    }
  }
}

class MemoryState implements WatchStateStore {
  cursor: PollCursor = null;
  scannedTo: number | null = null;
  blocks: BlockRef[] = [];
  credited = new Map<string, number>();
  errors: string[] = [];

  async loadCursor() {
    return { cursor: this.cursor, scannedTo: this.scannedTo };
  }

  async saveCursor(_chain: unknown, cursor: PollCursor, scannedTo: number) {
    this.cursor = cursor;
    this.scannedTo = scannedTo;
  }

  async recordError(_chain: unknown, message: string) {
    this.errors.push(message);
  }

  async recentBlocks(_chain: unknown, limit: number) {
    return [...this.blocks].sort((a, b) => b.number - a.number).slice(0, limit);
  }

  async rememberBlocks(_chain: unknown, refs: readonly BlockRef[]) {
    for (const ref of refs) {
      this.blocks = this.blocks.filter((block) => block.number !== ref.number);
      this.blocks.push(ref);
    }
  }

  async forgetBlocksAbove(_chain: unknown, number: number) {
    this.blocks = this.blocks.filter((block) => block.number <= number);
  }

  async creditedAbove(_chain: unknown, number: number) {
    return [...this.credited.entries()]
      .filter(([, blockNumber]) => blockNumber > number)
      .map(([key]) => key);
  }
}

class RecordingSink implements PaymentSink {
  readonly creditedKeys: string[] = [];
  readonly reversedKeys: string[] = [];
  failOn = new Set<string>();

  constructor(private readonly state: MemoryState) {}

  async credit(payment: IncomingPayment) {
    const key = paymentKey(payment);
    if (this.failOn.has(key)) throw new Error('credit refused');
    // Idempotent, as the real store is.
    if (!this.state.credited.has(key)) {
      this.creditedKeys.push(key);
      this.state.credited.set(key, payment.blockNumber);
    }
  }

  async reverse(key: string) {
    this.reversedKeys.push(key);
    this.state.credited.delete(key);
  }
}

/** An adapter that returns whatever transfers the test scripts for each poll. */
class ScriptedAdapter implements ChainAdapter {
  readonly chain = 'bsc' as const;
  readonly addressModel = 'unique' as const;
  polls = 0;

  constructor(private readonly script: (poll: number) => readonly IncomingPayment[]) {}

  async deriveDepositTarget() {
    return { address: '0x0000000000000000000000000000000000000001' };
  }

  async probeGas() {
    return { chain: this.chain, nativePriceUsd: 600, observedAt: Date.now() };
  }

  async poll(cursor: PollCursor): Promise<PollResult> {
    const payments = this.script(this.polls++);
    return {
      payments,
      cursor: String(payments.at(-1)?.blockNumber ?? cursor ?? 0),
    };
  }

  async prepareSettlement() {
    return null;
  }
}

function transfer(
  txHash: string,
  blockNumber: number,
  confirmations = 20,
): IncomingPayment {
  return {
    chain: 'bsc',
    txHash,
    transferIndex: 0,
    to: '0x0000000000000000000000000000000000000001',
    asset: USDT,
    amount: 10n ** 18n,
    blockNumber,
    confirmations,
  };
}

function build(chain: FakeChain, script: (poll: number) => readonly IncomingPayment[]) {
  const state = new MemoryState();
  const sink = new RecordingSink(state);
  const adapter = new ScriptedAdapter(script);
  const watcher = new Watcher('bsc', adapter, chain, state, sink, {
    reorgDepth: 3,
    blockMemory: 8,
    maxBlocksPerPoll: 100,
  });
  return { watcher, state, sink, adapter };
}

test('a transfer is credited and the cursor advances', async () => {
  const chain = new FakeChain(10);
  const { watcher, state, sink } = build(chain, (poll) =>
    poll === 0 ? [transfer('0xaa', 9)] : [],
  );

  const outcome = await watcher.poll();

  assert.equal(outcome.credited, 1);
  assert.equal(outcome.reorg, null);
  assert.deepEqual(sink.creditedKeys, ['bsc:0xaa:0']);
  assert.equal(state.scannedTo, 10);
});

test('the same transfer seen twice is credited once', async () => {
  // Watchers rescan overlapping ranges after a restart and providers replay logs.
  // Without idempotency the merchant is paid twice for one payment.
  const chain = new FakeChain(10);
  const { watcher, sink } = build(chain, () => [transfer('0xaa', 9)]);

  await watcher.poll();
  await watcher.poll();

  assert.deepEqual(sink.creditedKeys, ['bsc:0xaa:0'], 'credited exactly once');
});

test('an unconfirmed transfer is not credited yet', async () => {
  // Anything shallow can still be reorganised out, and reversing a credit is more
  // disruptive than waiting for one.
  const chain = new FakeChain(10);
  const { watcher, sink } = build(chain, () => [transfer('0xaa', 10, 0)]);

  const outcome = await watcher.poll();

  assert.equal(outcome.credited, 0);
  assert.equal(outcome.ignored, 1);
  assert.deepEqual(sink.creditedKeys, []);
});

test('a reorg is detected and the affected credit is withdrawn', async () => {
  // The behaviour this module exists for. A credit that survives a reorg means
  // the merchant was paid for a payment that no longer exists.
  const chain = new FakeChain(10);
  const { watcher, state, sink } = build(chain, (poll) =>
    poll === 0 ? [transfer('0xaa', 9)] : [],
  );

  await watcher.poll();
  assert.equal(state.credited.size, 1);

  // Blocks 8 upward are replaced, so the transaction in block 9 is gone.
  chain.reorg(8, 12, 'b');

  const outcome = await watcher.poll();

  assert.ok(outcome.reorg, 'the reorg should have been detected');
  assert.equal(outcome.reversed, 1);
  assert.deepEqual(sink.reversedKeys, ['bsc:0xaa:0']);
  assert.equal(state.credited.size, 0, 'the credit must not survive');
});

test('a reorg below the credited block leaves it alone', async () => {
  const chain = new FakeChain(20);
  const { watcher, state, sink } = build(chain, (poll) =>
    poll === 0 ? [transfer('0xaa', 12)] : [],
  );

  await watcher.poll();

  // Rewrite only the tip, well above the credited transfer, and deeper than the
  // rewind window reaches down to.
  chain.reorg(19, 21, 'b');
  const outcome = await watcher.poll();

  assert.ok(outcome.reorg);
  // The rewind stops at 16 (19 - reorgDepth 3), so block 12 is untouched.
  assert.equal(outcome.reversed, 0);
  assert.deepEqual(sink.reversedKeys, []);
  assert.equal(state.credited.size, 1);
});

test('the rewind reaches the deepest disagreement, not the shallowest', async () => {
  // Walking down from the tip, block 10 disagrees first, but the fork actually
  // starts at 9. Rewinding from the shallowest mismatch would leave block 9
  // credited — the exact failure this mechanism exists to prevent.
  const chain = new FakeChain(10);
  const { watcher, state } = build(chain, (poll) => (poll === 0 ? [transfer('0xaa', 9)] : []));

  await watcher.poll();
  chain.reorg(9, 11, 'b');
  const outcome = await watcher.poll();

  assert.ok(outcome.reorg);
  assert.equal(outcome.reorg.detectedAt, 9, 'the deepest disagreeing block');
  // Block 8 still matches, so it is proven good and needs no further margin.
  assert.equal(outcome.reorg.rewoundTo, 8);
  assert.equal(state.blocks.every((block) => block.number <= 11), true);
});

test('a fork deeper than reorgDepth is still fully rewound', async () => {
  // reorgDepth is 3 here, but the fork is 5 blocks deep. Rewinding a fixed depth
  // below the first mismatch would stop short and leave credits standing.
  const chain = new FakeChain(20);
  const { watcher, sink } = build(chain, (poll) =>
    poll === 0 ? [transfer('0xdeep', 16), transfer('0xshallow', 19)] : [],
  );

  await watcher.poll();
  chain.reorg(16, 22, 'b');
  const outcome = await watcher.poll();

  assert.ok(outcome.reorg);
  assert.equal(outcome.reorg.detectedAt, 16);
  assert.equal(outcome.reorg.rewoundTo, 15, 'rewound to the last matching block');
  // Both credits are above the fork, so both must be withdrawn.
  assert.equal(outcome.reversed, 2);
  assert.deepEqual(sink.reversedKeys.sort(), ['bsc:0xdeep:0', 'bsc:0xshallow:0']);
});

test('a chain that shrank is treated as a reorg', async () => {
  // A block we scanned no longer existing is itself a rollback, even before a
  // replacement appears.
  const chain = new FakeChain(10);
  const { watcher, sink } = build(chain, (poll) => (poll === 0 ? [transfer('0xaa', 10)] : []));

  await watcher.poll();
  chain.truncate(6);

  const outcome = await watcher.poll();
  assert.ok(outcome.reorg, 'a shorter chain must be recognised');
  assert.ok(sink.reversedKeys.length > 0);
});

test('a reorg deeper than remembered history still rewinds', async () => {
  const chain = new FakeChain(10);
  const { watcher, state } = build(chain, (poll) => (poll === 0 ? [transfer('0xaa', 9)] : []));

  await watcher.poll();
  const oldest = Math.min(...state.blocks.map((block) => block.number));

  // Rewrite from below everything we remember.
  chain.reorg(oldest - 1, 12, 'c');
  const outcome = await watcher.poll();

  // Nothing remembered agrees, so it must not conclude the chain is fine.
  assert.ok(outcome.reorg, 'divergence deeper than memory must still be caught');
});

test('the first poll on an empty state is not mistaken for a reorg', async () => {
  const chain = new FakeChain(10);
  const { watcher } = build(chain, () => []);

  const outcome = await watcher.poll();
  assert.equal(outcome.reorg, null);
});

test('a transfer that fails to credit does not stall the chain behind it', async () => {
  const chain = new FakeChain(10);
  const { watcher, state, sink } = build(chain, (poll) =>
    poll === 0 ? [transfer('0xbad', 8), transfer('0xgood', 9)] : [],
  );
  sink.failOn.add('bsc:0xbad:0');

  const outcome = await watcher.poll();

  assert.equal(outcome.credited, 1);
  assert.equal(outcome.ignored, 1);
  assert.deepEqual(sink.creditedKeys, ['bsc:0xgood:0']);
  // The cursor still advanced, so one poison transfer cannot block the chain.
  assert.equal(state.scannedTo, 10);
});

test('the cursor never claims to be ahead of the head', async () => {
  const chain = new FakeChain(10);
  const { watcher, state } = build(chain, () => [transfer('0xaa', 99)]);

  await watcher.poll();
  assert.equal(state.scannedTo, 10, 'a payment above the head must not advance the cursor past it');
});

test('a failing poll is recorded rather than thrown away', async () => {
  const chain = new FakeChain(10);
  const state = new MemoryState();
  const sink = new RecordingSink(state);
  const adapter = new ScriptedAdapter(() => {
    throw new Error('RPC timeout');
  });
  const watcher = new Watcher('bsc', adapter, chain, state, sink, DEFAULT_WATCHER);

  const outcome = await watcher.pollSafely();

  assert.equal(outcome, null);
  assert.deepEqual(state.errors, ['RPC timeout']);
});

test('block memory shallower than the rewind depth is refused at construction', () => {
  // Otherwise a reorg deeper than memory would be undetectable, silently.
  const chain = new FakeChain(10);
  const state = new MemoryState();
  assert.throws(
    () =>
      new Watcher('bsc', new ScriptedAdapter(() => []), chain, state, new RecordingSink(state), {
        reorgDepth: 64,
        blockMemory: 8,
        maxBlocksPerPoll: 100,
      }),
    /blockMemory must be at least reorgDepth/,
  );
});

test('reversal happens before the cursor moves back', async () => {
  // If the process dies between the two, re-scanning a range whose credits are
  // already withdrawn is harmless because crediting is idempotent. The opposite
  // order would leave credits standing for transactions never revisited.
  const chain = new FakeChain(10);
  const order: string[] = [];

  const state = new MemoryState();
  const sink: PaymentSink = {
    async credit(payment) {
      state.credited.set(paymentKey(payment), payment.blockNumber);
    },
    async reverse(key) {
      order.push(`reverse:${key}`);
      state.credited.delete(key);
    },
  };
  const originalSave = state.saveCursor.bind(state);
  state.saveCursor = async (chainId, cursor, scannedTo) => {
    order.push(`cursor:${scannedTo}`);
    return originalSave(chainId, cursor, scannedTo);
  };

  const watcher = new Watcher(
    'bsc',
    new ScriptedAdapter((poll) => (poll === 0 ? [transfer('0xaa', 9)] : [])),
    chain,
    state,
    sink,
    { reorgDepth: 3, blockMemory: 8, maxBlocksPerPoll: 100 },
  );

  await watcher.poll();
  order.length = 0;
  chain.reorg(8, 12, 'b');
  await watcher.poll();

  assert.equal(order[0], 'reverse:bsc:0xaa:0', 'reversal must come first');
  assert.ok(order[1]?.startsWith('cursor:'));
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SettlementRequest } from '../chains/ChainAdapter.js';
import { FeePolicy } from '../fees/FeePolicy.js';
import type { Asset, GasSnapshot } from '../types.js';
import {
  DEFAULT_RUNNER,
  SettlementRunner,
  weiToUsd,
  type ChainSigner,
  type SettlementCall,
} from './SettlementRunner.js';

const NOW = 1_700_000_000_000;

const USDT: Asset = {
  symbol: 'USDT',
  chain: 'bsc',
  decimals: 18,
  kind: 'erc20',
  contract: '0x55d398326f99059fF775485246999027B3197955',
};

const CALL: SettlementCall = {
  to: '0x00000000000000000000000000000000000000f0',
  data: '0xdeadbeef',
  gasLimit: 150_000n,
};

function request(invoiceId: string): SettlementRequest {
  return {
    invoiceId,
    depositAddress: '0x1111111111111111111111111111111111111111',
    payoutAddress: '0x2222222222222222222222222222222222222222',
    asset: USDT,
    amount: 10n ** 18n,
  };
}

function snapshot(gwei: number, nativePriceUsd = 600): GasSnapshot {
  return {
    chain: 'bsc',
    nativePriceUsd,
    feePerGasWei: BigInt(Math.round(gwei * 1e9)),
    observedAt: NOW,
  };
}

/** A signer the test drives, including receipts and balance. */
class FakeSigner implements ChainSigner {
  readonly address = '0x9999999999999999999999999999999999999999';
  readonly broadcasts: { nonce: number; feePerGasWei: bigint; hash: string }[] = [];
  balance = 10n ** 20n;
  startNonce = 7;
  private receipts = new Map<
    string,
    { status: 'success' | 'reverted'; gasUsed: bigint; feePerGasWei: bigint }
  >();
  private counter = 0;

  async pendingNonce() {
    return this.startNonce;
  }

  async balanceWei() {
    return this.balance;
  }

  async broadcast(tx: { nonce: number; feePerGasWei: bigint }) {
    const hash = `0xtx${this.counter++}`;
    this.broadcasts.push({ nonce: tx.nonce, feePerGasWei: tx.feePerGasWei, hash });
    return { hash };
  }

  async receipt(hash: string) {
    return this.receipts.get(hash) ?? null;
  }

  confirm(hash: string, status: 'success' | 'reverted' = 'success') {
    this.receipts.set(hash, { status, gasUsed: 140_000n, feePerGasWei: 10n ** 9n });
  }
}

function build(config = DEFAULT_RUNNER) {
  const signer = new FakeSigner();
  const runner = new SettlementRunner('bsc', signer, new FeePolicy(), config);
  return { signer, runner };
}

test('the first nonce comes from the chain, not from zero', async () => {
  // Guessing zero would collide with every transaction the account already sent,
  // and each collision is a settlement the mempool silently drops.
  const { signer, runner } = build();
  const nonce = await runner.start();

  assert.equal(nonce, signer.startNonce);
});

test('nonces are sequential across settlements', async () => {
  const { signer, runner } = build();
  await runner.start();

  for (const id of ['inv_1', 'inv_2', 'inv_3']) {
    const result = await runner.settle([request(id)], CALL, snapshot(1), NOW);
    assert.ok(result.ok);
  }

  assert.deepEqual(
    signer.broadcasts.map((broadcast) => broadcast.nonce),
    [7, 8, 9],
  );
});

test('the nonce does not advance when a broadcast fails', async () => {
  // A gap would leave every later transaction unmined behind it.
  const { signer, runner } = build();
  await runner.start();

  signer.broadcast = async () => {
    throw new Error('rpc rejected');
  };
  await assert.rejects(() => runner.settle([request('inv_1')], CALL, snapshot(1), NOW));

  assert.equal(runner.status(NOW).nextNonce, 7, 'still the original nonce');
});

test('a settlement above the per-transaction limit is refused', async () => {
  // Bounds what a mispriced gas estimate or a runaway loop can do to the wallet.
  const { runner } = build({ ...DEFAULT_RUNNER, maxTransactionCostUsd: 1 });
  await runner.start();

  // 150k gas at 100 gwei with the native asset at $600 is well over $1.
  const result = await runner.settle([request('inv_1')], CALL, snapshot(100), NOW);

  assert.ok(!result.ok);
  assert.equal(result.reason, 'transaction_too_expensive');
  assert.match(result.detail, /per-transaction limit/);
});

test('a refusal is a normal outcome, not an exception', async () => {
  const { runner } = build({ ...DEFAULT_RUNNER, maxTransactionCostUsd: 0.000001 });
  await runner.start();

  // The batch simply stays queued and is retried when conditions change.
  const result = await runner.settle([request('inv_1')], CALL, snapshot(1), NOW);
  assert.equal(result.ok, false);
});

test('the spend cap stops further settlement in the window', async () => {
  const { runner, signer } = build({
    ...DEFAULT_RUNNER,
    spendCapUsd: 0.2,
    maxTransactionCostUsd: 10,
  });
  await runner.start();

  // Each settlement here costs about $0.09.
  const first = await runner.settle([request('inv_1')], CALL, snapshot(1), NOW);
  const second = await runner.settle([request('inv_2')], CALL, snapshot(1), NOW);
  assert.ok(first.ok);
  assert.ok(second.ok);

  const third = await runner.settle([request('inv_3')], CALL, snapshot(1), NOW);
  assert.ok(!third.ok);
  assert.equal(third.reason, 'spend_cap_reached');
  assert.equal(signer.broadcasts.length, 2, 'the third must not be broadcast');
});

test('the spend window rolls forward', async () => {
  const { runner } = build({
    ...DEFAULT_RUNNER,
    spendCapUsd: 0.2,
    spendWindowMs: 60_000,
    maxTransactionCostUsd: 10,
  });
  await runner.start();

  await runner.settle([request('inv_1')], CALL, snapshot(1), NOW);
  await runner.settle([request('inv_2')], CALL, snapshot(1), NOW);
  assert.equal((await runner.settle([request('inv_3')], CALL, snapshot(1), NOW)).ok, false);

  // Past the window, the earlier spend no longer counts.
  const later = await runner.settle([request('inv_4')], CALL, snapshot(1), NOW + 61_000);
  assert.ok(later.ok);
});

test('a wallet that cannot cover the transaction refuses and alerts', async () => {
  const { signer, runner } = build();
  await runner.start();
  signer.balance = 1n;

  const result = await runner.settle([request('inv_1')], CALL, snapshot(1), NOW);

  assert.ok(!result.ok);
  assert.equal(result.reason, 'insufficient_gas_balance');

  const alerts = runner.takeAlerts();
  const critical = alerts.find((alert) => alert.kind === 'low_gas_balance');
  assert.equal(critical?.severity, 'critical');
});

test('a low balance warns while there is still time to top up', async () => {
  // Alerting only once settlement has stopped is too late — funds are already
  // sitting at deposit addresses unpaid.
  const { signer, runner } = build({ ...DEFAULT_RUNNER, lowBalanceSettlements: 50 });
  await runner.start();

  // Enough for about 10 settlements, below the threshold of 50.
  signer.balance = 150_000n * 10n ** 9n * 10n;

  const result = await runner.settle([request('inv_1')], CALL, snapshot(1), NOW);
  assert.ok(result.ok, 'it should still settle');

  const warning = runner
    .takeAlerts()
    .find((alert) => alert.kind === 'low_gas_balance' && alert.severity === 'warning');
  assert.ok(warning, 'a warning should precede the wallet emptying');
  assert.match(warning.detail, /runway/);
});

test('a confirmed settlement is reported and stops being tracked', async () => {
  const { signer, runner } = build();
  await runner.start();

  const result = await runner.settle([request('inv_1')], CALL, snapshot(1), NOW);
  assert.ok(result.ok);
  signer.confirm(result.transaction.hash);

  const outcome = await runner.reconcile(snapshot(1), NOW + 1000);

  assert.equal(outcome.confirmed.length, 1);
  assert.deepEqual(outcome.confirmed[0]?.invoiceIds, ['inv_1']);
  assert.equal(outcome.stillPending, 0);
});

test('a reverted settlement is surfaced, never treated as success', async () => {
  // Gas was spent and nothing moved. Retrying blindly just burns more.
  const { signer, runner } = build();
  await runner.start();

  const result = await runner.settle([request('inv_1')], CALL, snapshot(1), NOW);
  assert.ok(result.ok);
  signer.confirm(result.transaction.hash, 'reverted');

  const outcome = await runner.reconcile(snapshot(1), NOW + 1000);

  assert.equal(outcome.confirmed.length, 0);
  assert.equal(outcome.reverted.length, 1);

  const alert = runner.takeAlerts().find((entry) => entry.kind === 'reverted_settlement');
  assert.equal(alert?.severity, 'critical');
  assert.match(alert.detail, /needs investigation/);
});

test('a stuck transaction is replaced at the same nonce with a higher fee', async () => {
  // The only way past a transaction that will not confirm — and it must be done,
  // because every later nonce is blocked until it is.
  const { signer, runner } = build({ ...DEFAULT_RUNNER, stuckAfterMs: 60_000 });
  await runner.start();

  const result = await runner.settle([request('inv_1')], CALL, snapshot(1), NOW);
  assert.ok(result.ok);
  const original = result.transaction;

  const outcome = await runner.reconcile(snapshot(1), NOW + 61_000);

  assert.equal(outcome.replaced.length, 1);
  const replacement = signer.broadcasts.at(-1)!;
  assert.equal(replacement.nonce, original.nonce, 'the same nonce, so it replaces');
  assert.ok(
    replacement.feePerGasWei > original.feePerGasWei,
    'a replacement must raise the fee or the node discards it',
  );
});

test('the replacement bump meets the minimum percentage', async () => {
  // Nodes reject a replacement that does not raise the fee enough, so a timid bump
  // is silently discarded and the transaction stays stuck.
  const { signer, runner } = build({
    ...DEFAULT_RUNNER,
    stuckAfterMs: 60_000,
    replacementBumpPercent: 15,
  });
  await runner.start();

  const result = await runner.settle([request('inv_1')], CALL, snapshot(10), NOW);
  assert.ok(result.ok);

  // Market has not moved, so the bump alone must carry it.
  await runner.reconcile(snapshot(10), NOW + 61_000);

  const original = result.transaction.feePerGasWei;
  const replacement = signer.broadcasts.at(-1)!.feePerGasWei;
  assert.ok(replacement >= (original * 115n) / 100n, `${replacement} is not 15% above ${original}`);
});

test('a replacement takes the market rate when it exceeds the bump', async () => {
  const { signer, runner } = build({ ...DEFAULT_RUNNER, stuckAfterMs: 60_000 });
  await runner.start();

  const result = await runner.settle([request('inv_1')], CALL, snapshot(1), NOW);
  assert.ok(result.ok);

  // Gas has risen far past a 15% bump; matching only the bump would stay stuck.
  await runner.reconcile(snapshot(20), NOW + 61_000);

  assert.equal(signer.broadcasts.at(-1)!.feePerGasWei, 20n * 10n ** 9n);
});

test('a transaction is not replaced before it is considered stuck', async () => {
  const { signer, runner } = build({ ...DEFAULT_RUNNER, stuckAfterMs: 60_000 });
  await runner.start();

  await runner.settle([request('inv_1')], CALL, snapshot(1), NOW);
  const outcome = await runner.reconcile(snapshot(1), NOW + 59_000);

  assert.equal(outcome.replaced.length, 0);
  assert.equal(outcome.stillPending, 1);
  assert.equal(signer.broadcasts.length, 1);
});

test('a replacement too expensive to send blocks the nonce and alerts loudly', async () => {
  // Refusing leaves settlement blocked, which is bad — but quietly spending past
  // the safety limit is worse, so an operator decides.
  const { signer, runner } = build({
    ...DEFAULT_RUNNER,
    stuckAfterMs: 60_000,
    maxTransactionCostUsd: 0.1,
  });
  await runner.start();

  const result = await runner.settle([request('inv_1')], CALL, snapshot(1), NOW);
  assert.ok(result.ok);

  const outcome = await runner.reconcile(snapshot(500), NOW + 61_000);

  assert.equal(outcome.replaced.length, 0);
  assert.equal(signer.broadcasts.length, 1, 'nothing further was broadcast');

  const alert = runner.takeAlerts().find((entry) => entry.kind === 'stuck_transaction');
  assert.equal(alert?.severity, 'critical');
  assert.match(alert.detail, /blocked behind this nonce/);
});

test('status reports what an operator needs to see', async () => {
  const { runner } = build();
  await runner.start();

  await runner.settle([request('inv_1')], CALL, snapshot(1), NOW);
  const status = runner.status(NOW + 30_000);

  assert.equal(status.chain, 'bsc');
  assert.equal(status.inFlight, 1);
  assert.equal(status.nextNonce, 8);
  assert.equal(status.oldestPendingAgeMs, 30_000);
  assert.ok(status.spentInWindowUsd > 0);
  assert.equal(status.spendCapUsd, DEFAULT_RUNNER.spendCapUsd);
});

test('alerts are drained, not repeated forever', async () => {
  const { signer, runner } = build();
  await runner.start();
  signer.balance = 1n;

  await runner.settle([request('inv_1')], CALL, snapshot(1), NOW);
  assert.ok(runner.takeAlerts().length > 0);
  assert.equal(runner.takeAlerts().length, 0, 'draining should empty the list');
});

test('settling without a live gas price is refused', async () => {
  const { runner } = build();
  await runner.start();

  const result = await runner.settle(
    [request('inv_1')],
    CALL,
    { chain: 'bsc', nativePriceUsd: 600, observedAt: NOW },
    NOW,
  );

  assert.ok(!result.ok);
  assert.match(result.detail, /no live gas price/);
});

test('weiToUsd keeps precision on small and large values', () => {
  // 150k gas at 1 gwei is 1.5e14 wei; at $600 that is $0.09.
  assert.ok(Math.abs(weiToUsd(150_000n * 10n ** 9n, 600) - 0.09) < 1e-9);
  assert.equal(weiToUsd(0n, 600), 0);
  assert.ok(weiToUsd(10n ** 18n, 600) === 600);
});

test('shouldSettle defers to the fee policy', async () => {
  const { runner } = build();
  // Cheap: the policy allows settling.
  assert.equal(runner.shouldSettle(snapshot(0.01)), true);
  // Expensive: the policy says wait, independently of the safety limits here.
  assert.equal(runner.shouldSettle(snapshot(100)), false);
});

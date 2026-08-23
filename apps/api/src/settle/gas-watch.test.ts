import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { GasSnapshot } from '@avex/core';

import { DEFAULT_GAS_WATCH, GasWatch } from './gas-watch.js';

/**
 * The arithmetic on the boundary, which is the part anybody would get wrong.
 *
 * What is being protected is the one alert that arrives in time to act on. Before this existed
 * the only balance check happened inside `SettlementRunner.settle`, against the transaction in
 * hand — so a wallet draining on a quiet chain was never looked at, and the message that did
 * arrive was `warning`, which `AlertForwarder` logs rather than emails. The only email an
 * operator ever received meant settlement had already stopped.
 */

/** BNB Chain at 3 gwei. One deploy-and-flush is 95,000 gas. */
const snapshot = (gwei: number): GasSnapshot => ({
  chain: 'bsc',
  nativePriceUsd: 600,
  feePerGasWei: BigInt(gwei) * 1_000_000_000n,
  observedAt: 0,
});

/** The wei cost of `count` settlements at that fee. */
const settlements = (count: number, gwei: number): bigint =>
  BigInt(count) * 95_000n * BigInt(gwei) * 1_000_000_000n;

describe('the gas runway', () => {
  test('a comfortable balance says nothing', () => {
    const watch = new GasWatch();
    const { alerts, reading } = watch.check('bsc', settlements(500, 3), snapshot(3));

    assert.deepEqual(alerts, []);
    assert.equal(reading?.runway, 500);
  });

  test('below the warning threshold is logged, not emailed', () => {
    const watch = new GasWatch();
    const { alerts } = watch.check('bsc', settlements(30, 3), snapshot(3));

    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.severity, 'warning');
  });

  test('below the critical threshold is an email while there is still runway', () => {
    /**
     * The whole point. Nine settlements of runway is not an outage — it is the last moment at
     * which topping up is a calm decision rather than an incident.
     */
    const watch = new GasWatch();
    const { alerts } = watch.check('bsc', settlements(9, 3), snapshot(3));

    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.severity, 'critical');
    assert.match(alerts[0]!.detail, /top up/);
  });

  test('an empty wallet is critical', () => {
    const watch = new GasWatch();
    const { alerts, reading } = watch.check('bsc', 0n, snapshot(3));

    assert.equal(reading?.runway, 0);
    assert.equal(alerts[0]?.severity, 'critical');
  });

  test('the runway shrinks when gas gets more expensive, on the same balance', () => {
    /**
     * The reason this is priced per pass rather than once. A balance that covered a hundred
     * settlements at 3 gwei covers ten at 30, and nothing about the wallet changed — which is
     * exactly the situation where an operator has not thought to look.
     */
    const watch = new GasWatch();
    const balance = settlements(100, 3);

    assert.equal(watch.check('bsc', balance, snapshot(3)).reading?.runway, 100);
    assert.equal(watch.check('bsc', balance, snapshot(30)).reading?.runway, 10);
  });

  test('a recovery is announced once, and only after a critical', () => {
    const watch = new GasWatch();

    // Low, then topped up.
    assert.equal(watch.check('bsc', settlements(2, 3), snapshot(3)).alerts[0]?.severity, 'critical');
    const recovered = watch.check('bsc', settlements(500, 3), snapshot(3));
    assert.equal(recovered.alerts.length, 1);
    assert.match(recovered.alerts[0]!.detail, /recovered/);

    // And not again on the next healthy pass.
    assert.deepEqual(watch.check('bsc', settlements(500, 3), snapshot(3)).alerts, []);
  });

  test('a healthy chain does not announce a recovery on its first pass', () => {
    // There is no previous reading to have recovered from, and a first-pass "recovered" would
    // train an operator to ignore the word.
    const watch = new GasWatch();
    assert.deepEqual(watch.check('bsc', settlements(500, 3), snapshot(3)).alerts, []);
  });

  test('each chain is tracked separately', () => {
    const watch = new GasWatch();
    watch.check('bsc', settlements(1, 3), snapshot(3));

    // Ethereum has its own history; bsc being low must not make it announce a recovery.
    const ethereum = watch.check(
      'ethereum',
      settlements(500, 3),
      { ...snapshot(3), chain: 'ethereum' },
    );
    assert.deepEqual(ethereum.alerts, []);
  });

  test('no fee in the snapshot means no conclusion', () => {
    /**
     * Silence rather than a guess. Without a live fee there is nothing to divide by, and a
     * runway computed from an invented number is worse than none: it is a number somebody would
     * act on.
     */
    const watch = new GasWatch();
    const noFee: GasSnapshot = { chain: 'bsc', nativePriceUsd: 600, observedAt: 0 };

    assert.deepEqual(watch.check('bsc', 0n, noFee), { alerts: [], reading: null });
    assert.deepEqual(watch.check('bsc', 0n, null), { alerts: [], reading: null });
  });

  test('a chain that settles on receipt has no runway to report', () => {
    // TRON: the payer's transfer reaches the merchant, so we never send a transaction and there
    // is no gas wallet to run out.
    const watch = new GasWatch();
    const reading = watch.check('tron', 0n, { ...snapshot(3), chain: 'tron' });

    assert.deepEqual(reading, { alerts: [], reading: null });
  });

  test('the critical threshold is below the warning one', () => {
    // Otherwise every warning is also an email, and the distinction that makes the email
    // meaningful is gone.
    assert.ok(DEFAULT_GAS_WATCH.criticalSettlements < DEFAULT_GAS_WATCH.warningSettlements);
  });
});

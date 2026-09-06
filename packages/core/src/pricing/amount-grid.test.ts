import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  MAX_AMOUNT_DECIMALS,
  amountGrid,
  ceilToGrid,
  humanAmount,
  isOnGrid,
  sameHumanAmount,
} from './amount-grid.js';

describe('the three-decimal grid every asked amount sits on', () => {
  test('the grid is three decimals whatever the token has', () => {
    assert.equal(MAX_AMOUNT_DECIMALS, 3);
    assert.equal(amountGrid(6), 1_000n, 'USDT: a thousand smallest units is 0.001');
    assert.equal(amountGrid(18), 10n ** 15n, 'an EVM token');
    assert.equal(amountGrid(3), 1n, 'already on the grid');
    assert.equal(amountGrid(2), 1n, 'coarser than the grid: its own unit');
    assert.equal(amountGrid(0), 1n);
  });

  test('rounding is up, never down, and leaves a round figure alone', () => {
    /**
     * The eighteen-decimal quote from the bug report: 25.253529057985269131 USDC. The payer is
     * asked for 25.254, a fraction of a cent more, and never for 25.253 — which would leave
     * the merchant short by the rounding.
     */
    const quoted = 25_253_529_057_985_269_131n;
    assert.equal(ceilToGrid(quoted, 18), 25_254_000_000_000_000_000n);
    assert.equal(ceilToGrid(25_254_000_000_000_000_000n, 18), 25_254_000_000_000_000_000n);
    assert.equal(ceilToGrid(20_000_001n, 6), 20_001_000n, '20.000001 USDT becomes 20.001');
    assert.equal(ceilToGrid(0n, 6), 0n);
    assert.throws(() => ceilToGrid(-1n, 6));
  });

  test('on-grid is the same question as "has at most three decimals"', () => {
    assert.equal(isOnGrid(20_001_000n, 6), true);
    assert.equal(isOnGrid(20_001_001n, 6), false);
    assert.equal(isOnGrid(7n, 2), true);
  });

  test('amounts in tokens of different precision compare as the number a person reads', () => {
    /**
     * 20.001 USDT on TRON has six decimals and 20.001 USDC on BNB Chain eighteen: different
     * integers, the same number. The shared wallet identifies an invoice by the number the payer
     * typed, so this is the comparison that has to hold.
     */
    assert.ok(sameHumanAmount({ amount: 20_001_000n, decimals: 6 }, { amount: 20_001n * 10n ** 15n, decimals: 18 }));
    assert.ok(!sameHumanAmount({ amount: 20_001_000n, decimals: 6 }, { amount: 20_002n * 10n ** 15n, decimals: 18 }));
    assert.equal(humanAmount(1n, 0), 10n ** 36n);
    assert.throws(() => humanAmount(1n, 37), 'wider than anything compared');
  });
});

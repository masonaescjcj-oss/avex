import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  MAX_AMOUNT_DECIMALS,
  MAX_STEP_USD,
  MIN_AMOUNT_DECIMALS,
  amountGrid,
  ceilToGrid,
  gridDecimals,
  humanAmount,
  isOnGrid,
  sameHumanAmount,
} from './amount-grid.js';

describe('the grid every asked amount sits on', () => {
  test('three decimals on a stablecoin, whatever the token has', () => {
    assert.equal(MIN_AMOUNT_DECIMALS, 3);
    assert.equal(amountGrid(6, 1), 1_000n, 'USDT: a thousand smallest units is 0.001');
    assert.equal(amountGrid(18, 1), 10n ** 15n, 'an 18-decimal stablecoin');
    assert.equal(amountGrid(6), 1_000n, 'and with no price at all');
    assert.equal(amountGrid(3), 1n, 'already on the grid');
    assert.equal(amountGrid(2), 1n, 'coarser than the grid: its own unit');
    assert.equal(amountGrid(0), 1n);
  });

  test('a dear token gets more decimals, up to five, so a step is never more than a nickel', () => {
    /**
     * The merchant's rule: three decimals on everything, five on BNB and ETH. Derived from the
     * price rather than a list of tickers, so a token that becomes dear moves on its own.
     */
    assert.equal(MAX_AMOUNT_DECIMALS, 5);
    assert.equal(MAX_STEP_USD, 0.05);
    assert.equal(gridDecimals(18, 600), 5, 'BNB: 0.00001 is $0.006');
    assert.equal(gridDecimals(18, 3_000), 5, 'ETH: 0.00001 is $0.03');
    assert.equal(gridDecimals(6, 0.3), 3, 'TRX stays at three');
    assert.equal(gridDecimals(18, 0.4), 3, 'POL too');
    assert.equal(gridDecimals(18, 30), 3, 'a $30 token: 0.001 is 3 cents, still under a nickel');
    assert.equal(gridDecimals(18, 80), 4, 'an $80 token: 0.001 is 8 cents, so four');
    assert.equal(gridDecimals(8, 60_000), 5, 'never more than five, however dear');
    assert.equal(gridDecimals(4, 3_000), 4, 'and never more than the token has');
    assert.equal(amountGrid(18, 600), 10n ** 13n);
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
    // 0.0333333… ETH at $3,000 is asked as 0.03334.
    assert.equal(ceilToGrid(33_333_333_333_333_333n, 18, 3_000), 33_340_000_000_000_000n);
    assert.equal(ceilToGrid(0n, 6), 0n);
    assert.throws(() => ceilToGrid(-1n, 6));
  });

  test('on-grid is the same question as "has at most three decimals"', () => {
    assert.equal(isOnGrid(20_001_000n, 6), true);
    assert.equal(isOnGrid(20_001_001n, 6), false);
    assert.equal(isOnGrid(10n ** 13n, 18, 600), true, 'the fifth decimal of BNB');
    assert.equal(isOnGrid(10n ** 13n, 18, 1), false, 'but not of a stablecoin');
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

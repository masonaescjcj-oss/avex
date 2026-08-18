import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  FeePayerError,
  amountAfterFee,
  applyFeePayer,
  feeOnAmount,
  grossUpForFee,
} from './fee-payer.js';

/**
 * Who bears the commission.
 *
 * Every test here is about one of two losses. A gross-up that is too low leaves the
 * merchant quietly short on every order they ever take. One that is too high overcharges
 * the payer, who has no way of knowing. Both are silent, which is why the arithmetic is
 * pinned rather than eyeballed.
 */

describe('the cut the forwarder takes', () => {
  test('it rounds down, exactly as the contract does', () => {
    /**
     * `Forwarder._feeOn` rounds down, which favours the merchant. A mirror that rounded
     * the other way would put every projected settlement one unit below the real one —
     * an unexplained penny in reconciliation rather than an error anyone can act on.
     */
    assert.equal(feeOnAmount(1_000n, 50), 5n);
    // 1001 * 50 / 10000 = 5.005
    assert.equal(feeOnAmount(1_001n, 50), 5n);
    assert.equal(feeOnAmount(1_999n, 50), 9n);
  });

  test('dust below the granularity of the fee is not charged', () => {
    // 1 unit at 0.5% is 0.005 units, and there is no such thing. Not rounded up to 1,
    // which would be a 100% fee on the smallest possible payment.
    assert.equal(feeOnAmount(1n, 50), 0n);
    assert.equal(feeOnAmount(199n, 50), 0n);
    assert.equal(feeOnAmount(200n, 50), 1n);
  });

  test('a zero rate takes nothing at all', () => {
    assert.equal(feeOnAmount(10n ** 18n, 0), 0n);
    assert.equal(amountAfterFee(10n ** 18n, 0), 10n ** 18n);
  });

  test('an amount beyond double precision is exact', () => {
    // An 18-decimal token amount is routinely above 2^53, which is why none of this
    // touches a float.
    const amount = 123_456_789_123_456_789_123n;
    assert.equal(feeOnAmount(amount, 50), 617_283_945_617_283_945n);
    assert.equal(amountAfterFee(amount, 50), amount - 617_283_945_617_283_945n);
  });

  test('a rate the forwarder cannot deliver is refused rather than computed', () => {
    // 500bps is the contract ceiling. Computing a fee above it would produce a number
    // for an invoice that could never be swept.
    assert.throws(() => feeOnAmount(1_000n, 501), FeePayerError);
    assert.throws(() => feeOnAmount(1_000n, -1), FeePayerError);
    assert.throws(() => feeOnAmount(1_000n, 12.5), FeePayerError);
  });
});

describe('grossing up so the merchant is not short', () => {
  test('the merchant receives at least what they asked for', () => {
    const net = 1_000n;
    const gross = grossUpForFee(net, 50);
    assert.equal(gross, 1_005n);
    // 1005 - floor(1005 * 50 / 10000) = 1005 - 5 = 1000, exactly what was asked for.
    assert.equal(amountAfterFee(gross, 50), net);
  });

  test('never short, at any amount, at any published rate', () => {
    /**
     * The property that matters, checked by exhaustion rather than by argument. A
     * gross-up one unit low is invisible in a single example and costs the merchant on
     * every order.
     */
    for (const feeBps of [0, 1, 40, 45, 50, 100, 499, 500]) {
      for (let net = 1n; net <= 3_000n; net += 1n) {
        const gross = grossUpForFee(net, feeBps);
        assert.ok(
          amountAfterFee(gross, feeBps) >= net,
          `${net} at ${feeBps}bps grossed to ${gross}, netting ${amountAfterFee(gross, feeBps)}`,
        );
      }
    }
  });

  test('and never more than it has to be', () => {
    /**
     * The other direction, and the reason the closed form alone is not enough. Asking a
     * payer for 2 units to deliver 1 is a 100% surcharge, and it is exactly what
     * `ceil(net * 10000 / (10000 - bps))` returns for a dust invoice, because the fee on
     * the smaller amount rounds away to nothing.
     */
    for (const feeBps of [1, 40, 45, 50, 100, 499, 500]) {
      for (let net = 1n; net <= 3_000n; net += 1n) {
        const gross = grossUpForFee(net, feeBps);
        assert.ok(
          amountAfterFee(gross - 1n, feeBps) < net,
          `${net} at ${feeBps}bps grossed to ${gross}, but ${gross - 1n} would have done`,
        );
      }
    }
  });

  test('dust is not doubled', () => {
    // The concrete case the minimality test generalises. One unit, and the fee on one
    // unit is nothing, so one unit is what the payer sends.
    assert.equal(grossUpForFee(1n, 50), 1n);
    assert.equal(grossUpForFee(199n, 50), 199n);
  });

  test('a zero rate grosses up to nothing', () => {
    // No fee to cover, so "the payer pays the fee" must not change the invoice at all.
    assert.equal(grossUpForFee(10n ** 18n, 0), 10n ** 18n);
  });

  test('an 18-decimal amount is grossed up exactly', () => {
    const net = 20n * 10n ** 18n;
    const gross = grossUpForFee(net, 50);
    assert.ok(amountAfterFee(gross, 50) >= net);
    assert.ok(amountAfterFee(gross - 1n, 50) < net);
    // Just over 0.5% more, which is the whole point.
    assert.ok(gross - net > (net * 50n) / 10_000n);
    assert.ok(gross - net < (net * 51n) / 10_000n);
  });
});

describe('who bears the fee', () => {
  const net = 20n * 10n ** 18n;

  test('by default the merchant absorbs it and the payer sends the price', () => {
    const result = applyFeePayer(net, 50, 'merchant');
    assert.equal(result.amountDue, net, 'the payer is asked for the price, unchanged');
    assert.equal(result.surcharge, 0n);
    assert.equal(result.feeAmount, (net * 50n) / 10_000n);
    assert.equal(result.amountNet, net - result.feeAmount, 'the merchant is short by the fee');
  });

  test('when the payer bears it the merchant is made whole', () => {
    const result = applyFeePayer(net, 50, 'payer');
    assert.ok(result.amountNet >= net, 'the merchant must receive what they asked for');
    assert.ok(result.surcharge > 0n, 'the payer is asked for more');
    assert.equal(result.amountDue, net + result.surcharge);
  });

  test('the surcharge is the difference the checkout has to disclose', () => {
    /**
     * A payer charged more than the merchant's price and not told why has been
     * overcharged as far as they can tell, so this figure is a product requirement and
     * not an implementation detail.
     */
    const result = applyFeePayer(1_000_000n, 50, 'payer');
    assert.equal(result.surcharge, result.amountDue - 1_000_000n);
    assert.equal(result.surcharge, 5_025n);
  });

  test('a zero rate is identical whoever is said to bear it', () => {
    // Nothing is being charged, so the choice cannot change a single unit. Otherwise a
    // merchant on a waived commission would still be surcharging their customers.
    const merchant = applyFeePayer(net, 0, 'merchant');
    const payer = applyFeePayer(net, 0, 'payer');
    assert.deepEqual(merchant, payer);
    assert.equal(payer.amountDue, net);
  });
});

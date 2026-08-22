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

describe('the cost of the transfer, which is the payer\'s either way', () => {
  /**
   * The rule the network fee follows, and why it is not just another `feeBps`.
   *
   * A commission is a price, and a merchant may choose to absorb it as a courtesy to their
   * customer. What the chain charges to move the payment is not a price and cannot be absorbed
   * without the merchant paying to be paid. So it is grossed onto the payer on every invoice on
   * a chain we settle on, and `feePayer` has nothing to say about it.
   */
  const twenty = 20_000_000n; // $20 of a six-decimal stablecoin.

  test('a $20 invoice becomes $20.10 when settling costs ten cents', () => {
    // 50 basis points of $20 is exactly ten cents, which is the case the whole feature is for.
    const result = applyFeePayer(twenty, 0, 'merchant', 50);

    assert.equal(result.amountDue, 20_100_502n);
    assert.equal(result.surcharge, 100_502n, 'about ten cents, and the payer is told');
    assert.ok(result.amountNet >= twenty, 'and the merchant still receives their price');
  });

  test('the merchant absorbing the commission does not absorb the transfer', () => {
    const absorbed = applyFeePayer(twenty, 50, 'merchant', 50);
    const passedOn = applyFeePayer(twenty, 50, 'payer', 50);

    // Both are surcharged the network fee; only the second is surcharged the commission.
    assert.ok(absorbed.surcharge > 0n, 'the transfer is charged whoever bears the commission');
    assert.ok(passedOn.surcharge > absorbed.surcharge, 'and the commission is on top of it');

    /**
     * The merchant absorbing the commission receives their price less the commission, not less
     * both. That is the whole claim: the gross-up covered the gas, and the split took it.
     */
    assert.ok(absorbed.amountNet < twenty);
    assert.ok(twenty - absorbed.amountNet < 105_000n, 'short by the commission, not by both');
    assert.ok(passedOn.amountNet >= twenty);
  });

  test('the split takes the network fee out of what arrives, whoever was asked for it', () => {
    // Otherwise the extra the payer sent would settle to the merchant and the gas wallet would
    // still be paying — the surcharge would be money moved from a payer to a merchant.
    const result = applyFeePayer(twenty, 0, 'merchant', 50);
    assert.equal(result.feeAmount, feeOnAmount(result.amountDue, 50));
    assert.ok(result.feeAmount >= 100_000n, 'the ten cents reaches the collector');
  });

  test('zero is zero: a chain we send nothing on charges nothing', () => {
    const pooled = applyFeePayer(twenty, 0, 'merchant', 0);
    assert.equal(pooled.amountDue, twenty);
    assert.equal(pooled.surcharge, 0n);
  });

  test('an omitted network fee leaves every existing caller exactly as it was', () => {
    // The argument is optional, and it has to be inert when absent: every quote already issued
    // was computed by the three-argument form.
    for (const payer of ['merchant', 'payer'] as const) {
      assert.deepEqual(applyFeePayer(twenty, 50, payer), applyFeePayer(twenty, 50, payer, 0));
    }
  });
});

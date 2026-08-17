import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  FIAT_SCALE,
  InvalidRateError,
  RATE_SCALE,
  applySpread,
  deviationBps,
  fiatMicrosFromDecimalString,
  fiatMicrosToDecimalString,
  fiatToTokenAmount,
  rateFromDecimalString,
  rateToDecimalString,
  rateToNumber,
  tokenAmountToFiat,
} from './rate.js';

const AT = 1_700_000_000_000;

test('a whole-number rate scales exactly', () => {
  assert.equal(rateFromDecimalString('1', AT).priceScaled, RATE_SCALE);
  assert.equal(rateFromDecimalString('64213', AT).priceScaled, 64_213n * RATE_SCALE);
});

test('a fractional rate keeps every digit', () => {
  // The case that motivates integer arithmetic: 0.9998 is not representable as a
  // double, so parsing and multiplying would already be wrong here.
  const rate = rateFromDecimalString('0.9998', AT);
  assert.equal(rate.priceScaled, 999_800_000_000_000_000n);
  assert.equal(rateToDecimalString(rate, 4), '0.9998');
});

test('rates survive a round trip through string form', () => {
  for (const value of ['1', '0.5', '0.000001', '2500.12345678', '99999.99999999']) {
    const rate = rateFromDecimalString(value, AT);
    const back = rateToDecimalString(rate, value.split('.')[1]?.length ?? 0);
    assert.equal(Number(back), Number(value), value);
  }
});

test('a very cheap token does not collapse to zero', () => {
  // A 1e-18 scale exists so that sub-cent assets remain representable.
  const rate = rateFromDecimalString('0.000000000000000123', AT);
  assert.equal(rate.priceScaled, 123n);
  assert.ok(rate.priceScaled > 0n);
});

test('malformed and non-positive rates are rejected', () => {
  for (const value of ['', 'abc', '-1', '1.2.3', '1e5', ' ', '0', '0.0']) {
    assert.throws(() => rateFromDecimalString(value, AT), InvalidRateError, value);
  }
});

test('a stablecoin invoice converts to the expected token amount', () => {
  // $20.00 of a $1.00 token with 6 decimals is exactly 20 000 000 units.
  const rate = rateFromDecimalString('1', AT);
  const amount = fiatToTokenAmount(fiatMicrosFromDecimalString('20'), rate, 6);
  assert.equal(amount, 20_000_000n);
});

test('an 18-decimal token at a four-figure price converts exactly', () => {
  // $20 of a $2000 token is 0.01 tokens = 1e16 wei.
  const rate = rateFromDecimalString('2000', AT);
  const amount = fiatToTokenAmount(fiatMicrosFromDecimalString('20'), rate, 18);
  assert.equal(amount, 10_000_000_000_000_000n);
});

test('conversion rounds up, never leaving the merchant short', () => {
  // $10 at $3 per token is 3.333… tokens. With 2 decimals the exact value is
  // 333.33…, so the payer is asked for 334 units rather than 333.
  const rate = rateFromDecimalString('3', AT);
  const amount = fiatToTokenAmount(fiatMicrosFromDecimalString('10'), rate, 2);
  assert.equal(amount, 334n);

  // And the value of what was asked for is at least the invoice amount.
  assert.ok(tokenAmountToFiat(amount, rate, 2) >= fiatMicrosFromDecimalString('10'));
});

test('valuation rounds down, so tiering never asks for too few confirmations', () => {
  const rate = rateFromDecimalString('3', AT);
  // 333 units of a 2-decimal token at $3 is $9.99, not $10.
  assert.equal(tokenAmountToFiat(333n, rate, 2), 9_990_000n);
});

test('zero converts to zero in both directions', () => {
  const rate = rateFromDecimalString('1234.5', AT);
  assert.equal(fiatToTokenAmount(0n, rate, 18), 0n);
  assert.equal(tokenAmountToFiat(0n, rate, 18), 0n);
});

test('negative amounts are rejected rather than silently inverted', () => {
  const rate = rateFromDecimalString('1', AT);
  assert.throws(() => fiatToTokenAmount(-1n, rate, 6), InvalidRateError);
  assert.throws(() => tokenAmountToFiat(-1n, rate, 6), InvalidRateError);
});

test('round-tripping a large invoice loses at most one smallest unit', () => {
  const rate = rateFromDecimalString('64213.75', AT);
  const original = fiatMicrosFromDecimalString('98765.432100');

  const tokens = fiatToTokenAmount(original, rate, 8);
  const back = tokenAmountToFiat(tokens, rate, 8);

  // Both roundings favour the merchant, so the recovered value is never below the
  // original, and the gap is bounded by one unit's worth.
  assert.ok(back >= original, `expected ${back} >= ${original}`);
  const oneUnitValue = tokenAmountToFiat(1n, rate, 8);
  assert.ok(back - original <= oneUnitValue + 1n);
});

test('a spread raises the token amount the payer must send', () => {
  const spot = rateFromDecimalString('100', AT);
  const withSpread = applySpread(spot, 50); // 0.50%

  assert.ok(withSpread.priceScaled < spot.priceScaled, 'effective price must fall');

  const at_spot = fiatToTokenAmount(fiatMicrosFromDecimalString('100'), spot, 18);
  const at_spread = fiatToTokenAmount(fiatMicrosFromDecimalString('100'), withSpread, 18);
  assert.ok(at_spread > at_spot, 'a spread must ask for more tokens, not fewer');

  // 50 bps on $100 of a $100 token: 1 token becomes about 1.005.
  assert.equal(at_spread, 1_005_025_125_628_140_704n);
});

test('a zero spread is a no-op and an out-of-range spread is refused', () => {
  const spot = rateFromDecimalString('100', AT);
  assert.equal(applySpread(spot, 0).priceScaled, spot.priceScaled);

  for (const bps of [-1, 10_000, 20_000, 1.5]) {
    assert.throws(() => applySpread(spot, bps), InvalidRateError, String(bps));
  }
});

test('fiat strings round-trip through micros', () => {
  assert.equal(fiatMicrosFromDecimalString('20'), 20n * FIAT_SCALE);
  assert.equal(fiatMicrosFromDecimalString('0.01'), 10_000n);
  assert.equal(fiatMicrosFromDecimalString('19.99'), 19_990_000n);
  assert.equal(fiatMicrosToDecimalString(19_990_000n), '19.990000');
});

test('deviationBps measures distance from a reference in both directions', () => {
  const hundred = rateFromDecimalString('100', AT).priceScaled;
  assert.equal(deviationBps(hundred, hundred), 0);
  assert.equal(deviationBps(rateFromDecimalString('101', AT).priceScaled, hundred), 100);
  assert.equal(deviationBps(rateFromDecimalString('99', AT).priceScaled, hundred), 100);
  assert.equal(deviationBps(rateFromDecimalString('110', AT).priceScaled, hundred), 1000);
});

test('rateToNumber approximates for heuristics only', () => {
  assert.ok(Math.abs(rateToNumber(rateFromDecimalString('2000.5', AT)) - 2000.5) < 1e-9);
});

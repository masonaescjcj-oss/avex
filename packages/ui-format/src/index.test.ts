import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  FormatError,
  formatAgo,
  formatDuration,
  formatGwei,
  formatUnits,
  formatUnitsGrouped,
  formatUntil,
  formatUsdMicros,
  humanizeAction,
  shortenAddress,
  shortenHash,
} from './index.js';

test('a whole token amount loses its trailing zeros', () => {
  assert.equal(formatUnits('20000000000000000000', 18), '20');
  assert.equal(formatUnits('20020000', 6), '20.02');
  assert.equal(formatUnits('0', 18), '0');
});

test('one smallest unit is not rounded away', () => {
  /**
   * The case that matters most. Rounding this to "0" would tell an operator that
   * nothing arrived, when in fact a payment did — and dust arriving at an address is
   * exactly the kind of thing they are looking at the panel to explain.
   */
  assert.equal(formatUnits('1', 18), '0.000000000000000001');
  assert.equal(formatUnits('1', 6), '0.000001');
});

test('an amount beyond double precision survives intact', () => {
  // 2^53 is where a double stops counting by ones. Anything above it that came back
  // correct proves nothing went through Number on the way.
  const huge = '123456789012345678901234567890';
  assert.equal(formatUnits(huge, 18), '123456789012.34567890123456789');
  assert.equal(formatUnits('9007199254740993', 0), '9007199254740993');
});

test('a zero-decimal asset formats as a plain integer', () => {
  assert.equal(formatUnits('64000', 0), '64000');
});

test('grouping applies to the whole part only', () => {
  assert.equal(formatUnitsGrouped('1948000000', 6), '1,948');
  assert.equal(formatUnitsGrouped('1234567891234', 6), '1,234,567.891234');
  // Grouping a fraction is not a convention anyone reads.
  assert.ok(!formatUnitsGrouped('1000000000000000001', 18).includes(',0'));
});

test('a malformed amount is refused rather than shown as NaN', () => {
  // Silently rendering "NaN" in a money column invites someone to act on it.
  assert.throws(() => formatUnits('20.5', 18), FormatError);
  assert.throws(() => formatUnits('', 18), FormatError);
  assert.throws(() => formatUnits('0x10', 18), FormatError);
  assert.throws(() => formatUnits('100', -1), FormatError);
});

test('negative amounts keep their sign', () => {
  assert.equal(formatUnits('-1500000', 6), '-1.5');
  assert.equal(formatUnitsGrouped('-1234567000000', 6), '-1,234,567');
});

test('a small dollar figure keeps four places', () => {
  /**
   * $0.0141 rounded to $0.01 destroys the fee engine's whole point: the difference
   * between 0.047 gwei and 9 gwei is two orders of magnitude in settlement cost, and
   * two decimal places cannot show it.
   */
  assert.equal(formatUsdMicros('14100'), '$0.0141');
  assert.equal(formatUsdMicros('1000'), '$0.0010');
});

test('a large dollar figure keeps two places and groups', () => {
  assert.equal(formatUsdMicros('2500000'), '$2.50');
  assert.equal(formatUsdMicros('250000000'), '$250.00');
  assert.equal(formatUsdMicros('1234567890000'), '$1,234,567.89');
  assert.equal(formatUsdMicros('0'), '$0.00');
});

test('a negative dollar figure puts the sign before the symbol', () => {
  assert.equal(formatUsdMicros('-2500000'), '-$2.50');
});

test('gwei keeps enough places to tell cheap gas apart', () => {
  assert.equal(formatGwei('47000000'), '0.047 gwei');
  assert.equal(formatGwei('9000000000'), '9 gwei');
  assert.equal(formatGwei('50000000'), '0.050 gwei');
  // The two figures the fee tests pin must not render identically.
  assert.notEqual(formatGwei('47000000'), formatGwei('50000000'));
});

test('durations use the coarsest unit that is still true', () => {
  assert.equal(formatDuration(3 * 60_000), '3m');
  assert.equal(formatDuration(90 * 60_000), '1h 30m');
  assert.equal(formatDuration(26 * 60 * 60_000), '1d 2h');
});

test('a fresh timestamp reads as just now, never as zero', () => {
  // "0m" beside a watcher that polled four seconds ago looks like a stopped clock.
  assert.equal(formatDuration(4_000), 'just now');
  assert.equal(formatDuration(0), 'just now');
  assert.equal(formatDuration(59_000), '1m');
});

test('a missing or unparseable timestamp reads as an em dash', () => {
  // "never polled" and "polled long ago" are different problems; neither is "NaN".
  assert.equal(formatDuration(null), '—');
  assert.equal(formatAgo(null), '—');
  assert.equal(formatAgo(undefined), '—');
  assert.equal(formatAgo('not a date'), '—');
});

test('a clock skewed into the future does not print a negative age', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(formatAgo('2026-01-01T00:05:00Z', now), 'just now');
});

test('formatAgo measures backwards from now', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  assert.equal(formatAgo('2026-01-01T11:30:00Z', now), '30m');
  assert.equal(formatAgo('2025-12-31T12:00:00Z', now), '1d 0h');
});

test('a shortened address keeps both ends', () => {
  const address = '0x55d398326f99059fF775485246999027B3197955';
  const short = shortenAddress(address);
  assert.ok(short.startsWith('0x55d3'));
  assert.ok(short.endsWith('7955'));
});

test('two addresses sharing a long prefix still render differently', () => {
  /**
   * Operators compare addresses by eye. Vanity addresses and contracts from one
   * factory share prefixes, so a leading fragment alone can match the wrong thing.
   */
  const a = '0x1111111111111111111111111111111111111111';
  const b = '0x1111111111111111111111111111111111112222';
  assert.notEqual(shortenAddress(a), shortenAddress(b));
});

test('a short string is returned whole rather than mangled', () => {
  assert.equal(shortenAddress('0x1234'), '0x1234');
  assert.equal(shortenAddress(''), '');
});

test('a hash is shortened harder than an address', () => {
  const hash = `0x${'ab'.repeat(32)}`;
  assert.ok(shortenHash(hash).length < hash.length);
  assert.ok(shortenHash(hash).startsWith('0xabababab'));
});

test('an action name becomes readable without losing its structure', () => {
  assert.equal(humanizeAction('payout_address.change_requested'), 'payout address · change requested');
  assert.equal(humanizeAction('merchant.suspended'), 'merchant · suspended');
  assert.equal(humanizeAction('staff.read'), 'staff · read');
});

describe('formatUntil', () => {
  test('counts down to a future instant', () => {
    const now = Date.parse('2026-08-19T00:00:00.000Z');
    assert.equal(formatUntil('2026-08-21T02:00:00.000Z', now), '2d 2h');
    assert.equal(formatUntil('2026-08-19T00:30:00.000Z', now), '30m');
  });

  test('a passed deadline is null, not a duration of zero', () => {
    /**
     * The whole reason this is not a flag on `formatAgo`, which reports a future instant as
     * "just now" to absorb clock skew. Applied to a deadline that produced "in just now" for
     * an invitation with five days left, and nothing for one that had expired.
     */
    const now = Date.parse('2026-08-19T00:00:00.000Z');
    assert.equal(formatUntil('2026-08-18T23:59:59.000Z', now), null);
    // Exactly now counts as passed: a deadline is over the moment it arrives.
    assert.equal(formatUntil('2026-08-19T00:00:00.000Z', now), null);
  });

  test('nothing and nonsense are both null', () => {
    // So a caller cannot accidentally render "in NaN" from a field the API left out.
    assert.equal(formatUntil(null), null);
    assert.equal(formatUntil(undefined), null);
    assert.equal(formatUntil(''), null);
    assert.equal(formatUntil('not a date'), null);
  });
});

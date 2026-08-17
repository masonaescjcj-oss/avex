import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_AGGREGATION,
  aggregate,
  medianBigInt,
  type SourceObservation,
} from './aggregate.js';
import { rateFromDecimalString, rateToDecimalString } from './rate.js';

const NOW = 1_700_000_000_000;

function at(source: string, price: string, ageMs = 0): SourceObservation {
  return { source, rate: rateFromDecimalString(price, NOW - ageMs) };
}

function failed(source: string, error = 'timeout'): SourceObservation {
  return { source, rate: null, error };
}

test('medianBigInt handles odd and even counts', () => {
  assert.equal(medianBigInt([3n]), 3n);
  assert.equal(medianBigInt([3n, 1n, 2n]), 2n);
  assert.equal(medianBigInt([1n, 2n, 3n, 4n]), 2n); // (2+3)/2 truncates to 2
  assert.throws(() => medianBigInt([]));
});

test('three agreeing sources produce their median', () => {
  const result = aggregate(
    [at('coingecko', '2000'), at('binance', '2001'), at('kraken', '1999')],
    DEFAULT_AGGREGATION,
    NOW,
  );

  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.equal(rateToDecimalString(result.rate, 0), '2000');
  assert.equal(result.usedSources.length, 3);
});

test('a single wrong source is outvoted, not averaged in', () => {
  // The failure mode this design exists for: an API returning a plausible but
  // wrong number. A mean would be dragged to ~1467; the median is not.
  const result = aggregate(
    [at('coingecko', '2000'), at('binance', '2001'), at('broken', '400')],
    DEFAULT_AGGREGATION,
    NOW,
  );

  assert.ok(result.ok);
  assert.equal(rateToDecimalString(result.rate, 0), '2000');
  assert.deepEqual(
    result.rejected.map((entry) => entry.source),
    ['broken'],
  );
  assert.equal(result.rejected[0]?.reason, 'outlier');
});

test('a failed source is recorded and excluded', () => {
  const result = aggregate(
    [at('coingecko', '2000'), at('binance', '2000'), failed('kraken', 'HTTP 503')],
    DEFAULT_AGGREGATION,
    NOW,
  );

  assert.ok(result.ok);
  assert.equal(result.usedSources.length, 2);
  assert.equal(result.rejected[0]?.reason, 'failed');
  assert.equal(result.rejected[0]?.detail, 'HTTP 503');
});

test('every source failing refuses rather than guessing', () => {
  const result = aggregate([failed('a'), failed('b'), failed('c')], DEFAULT_AGGREGATION, NOW);
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.equal(result.reason, 'no_sources_responded');
});

test('stale observations are discarded even when the source responded', () => {
  // A cached price without a timestamp check is how a stale rate becomes an
  // under-priced invoice.
  const result = aggregate(
    [at('fresh', '2000'), at('fresh2', '2000'), at('stale', '2000', 10 * 60_000)],
    DEFAULT_AGGREGATION,
    NOW,
  );

  assert.ok(result.ok);
  assert.equal(result.usedSources.length, 2);
  assert.equal(result.rejected[0]?.reason, 'stale');
});

test('all-stale refuses with its own reason', () => {
  const result = aggregate(
    [at('a', '2000', 10 * 60_000), at('b', '2000', 10 * 60_000)],
    DEFAULT_AGGREGATION,
    NOW,
  );
  assert.ok(!result.ok);
  assert.equal(result.reason, 'all_observations_stale');
});

test('one usable source is not enough by default', () => {
  const result = aggregate([at('coingecko', '2000'), failed('b'), failed('c')], DEFAULT_AGGREGATION, NOW);
  assert.ok(!result.ok);
  assert.equal(result.reason, 'insufficient_sources');
  assert.match(result.detail, /need 2/);
});

test('outlier rejection can itself drop below the minimum', () => {
  // Median of [2000, 400, 500] is 500; both 2000 and 400 are far from it, so too
  // few survive. Refusing is right — there is no majority to believe.
  const result = aggregate(
    [at('a', '2000'), at('b', '400'), at('c', '500')],
    { ...DEFAULT_AGGREGATION, minSources: 3 },
    NOW,
  );
  assert.ok(!result.ok);
  assert.equal(result.reason, 'insufficient_sources');
});

test('surviving sources that still disagree too much refuse a rate', () => {
  // Both inside the 200bps outlier band around the median but spanning more than
  // the 300bps dispersion limit once measured against each other.
  const result = aggregate(
    [at('a', '2000'), at('b', '2100')],
    { ...DEFAULT_AGGREGATION, outlierToleranceBps: 500, maxDispersionBps: 100 },
    NOW,
  );

  assert.ok(!result.ok);
  assert.equal(result.reason, 'excessive_dispersion');
  assert.match(result.detail, /bps/);
});

test('the aggregate is only as fresh as its oldest surviving input', () => {
  const result = aggregate(
    [at('a', '2000', 0), at('b', '2000', 30_000)],
    DEFAULT_AGGREGATION,
    NOW,
  );

  assert.ok(result.ok);
  // Otherwise a staleness check downstream would be reading an optimistic figure.
  assert.equal(result.rate.observedAt, NOW - 30_000);
});

test('dispersion is reported on success for monitoring', () => {
  const result = aggregate(
    [at('a', '2000'), at('b', '2000'), at('c', '2000')],
    DEFAULT_AGGREGATION,
    NOW,
  );
  assert.ok(result.ok);
  assert.equal(result.dispersionBps, 0);
});

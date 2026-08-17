import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_AGGREGATION } from './aggregate.js';
import { DEFAULT_BREAKER } from './breaker.js';
import {
  DEFAULT_PRICE_SERVICE,
  PriceService,
  PriceUnavailableError,
  type TickObserver,
} from './PriceService.js';
import { rateFromDecimalString, rateToDecimalString } from './rate.js';
import type { PriceSource, PriceSymbol } from './sources/index.js';

const NOW = 1_700_000_000_000;

/** A source under the test's control: no network, no timing dependence. */
class FakeSource implements PriceSource {
  calls = 0;

  constructor(
    readonly name: string,
    private behaviour: { price?: string; fail?: string; ageMs?: number },
    private readonly supported: readonly PriceSymbol[] = ['ETH', 'USDT'],
  ) {}

  supports(symbol: PriceSymbol): boolean {
    return this.supported.includes(symbol);
  }

  async fetchUsdPrice(symbol: PriceSymbol) {
    this.calls += 1;
    if (this.behaviour.fail) throw new Error(this.behaviour.fail);
    return rateFromDecimalString(this.behaviour.price!, NOW - (this.behaviour.ageMs ?? 0));
  }

  set(behaviour: { price?: string; fail?: string; ageMs?: number }): void {
    this.behaviour = behaviour;
  }
}

test('agreeing sources produce a median rate', async () => {
  const service = new PriceService([
    new FakeSource('a', { price: '2000' }),
    new FakeSource('b', { price: '2002' }),
    new FakeSource('c', { price: '2001' }),
  ]);

  const result = await service.getRate('ETH', NOW);
  assert.ok(result.ok);
  assert.equal(rateToDecimalString(result.rate, 0), '2001');
  assert.equal(result.sources.length, 3);
  assert.equal(result.cached, false);
});

test('only sources that support the symbol are consulted', async () => {
  const ethOnly = new FakeSource('eth-only', { price: '2000' }, ['ETH']);
  const both = new FakeSource('both', { price: '1' }, ['ETH', 'USDT']);
  const service = new PriceService([ethOnly, both]);

  // Binance not pricing USDT is the real instance of this: a source that cannot
  // quote a symbol must be skipped, not counted as a failure.
  const result = await service.getRate('USDT', NOW);
  assert.equal(ethOnly.calls, 0);
  assert.equal(both.calls, 1);
  assert.ok(!result.ok, 'one source is below the minimum of two');
  assert.equal(result.reason, 'insufficient_sources');
});

test('a rate is cached briefly so a burst of loads makes one round of fetches', async () => {
  const source = new FakeSource('a', { price: '2000' });
  const other = new FakeSource('b', { price: '2000' });
  const service = new PriceService([source, other]);

  await service.getRate('ETH', NOW);
  const second = await service.getRate('ETH', NOW + 1000);

  assert.ok(second.ok);
  assert.equal(second.cached, true);
  assert.equal(source.calls, 1, 'the source must not be hit twice inside the cache window');
});

test('the cache expires on schedule', async () => {
  const source = new FakeSource('a', { price: '2000' });
  const service = new PriceService([source, new FakeSource('b', { price: '2000' })]);

  await service.getRate('ETH', NOW);
  await service.getRate('ETH', NOW + DEFAULT_PRICE_SERVICE.cacheTtlMs + 1);
  assert.equal(source.calls, 2);
});

test('concurrent callers share a single round of fetches', async () => {
  const source = new FakeSource('a', { price: '2000' });
  const service = new PriceService([source, new FakeSource('b', { price: '2000' })]);

  const [first, second, third] = await Promise.all([
    service.getRate('ETH', NOW),
    service.getRate('ETH', NOW),
    service.getRate('ETH', NOW),
  ]);

  assert.equal(source.calls, 1, 'three concurrent callers, one fetch');
  assert.ok(first.ok && second.ok && third.ok);
});

test('a wrong source is outvoted and reported', async () => {
  const service = new PriceService([
    new FakeSource('good1', { price: '2000' }),
    new FakeSource('good2', { price: '2001' }),
    new FakeSource('broken', { price: '20' }),
  ]);

  const result = await service.getRate('ETH', NOW);
  assert.ok(result.ok);
  assert.ok(!result.sources.includes('broken'));
});

test('sources disagreeing wildly suspend the asset immediately', async () => {
  const service = new PriceService(
    [new FakeSource('a', { price: '2000' }), new FakeSource('b', { price: '2200' })],
    {
      aggregation: { ...DEFAULT_AGGREGATION, outlierToleranceBps: 5000, maxDispersionBps: 100 },
      breaker: DEFAULT_BREAKER,
      cacheTtlMs: 0,
    },
  );

  const first = await service.getRate('ETH', NOW);
  assert.ok(!first.ok);
  assert.equal(first.reason, 'excessive_dispersion');

  // The breaker is now open, so the next attempt is refused without fetching at all.
  const second = await service.getRate('ETH', NOW + 1);
  assert.ok(!second.ok);
  assert.equal(second.reason, 'circuit_open');
  assert.deepEqual(service.suspendedSymbols(NOW + 1), ['ETH']);
});

test('invoicing resumes once the feed recovers', async () => {
  const a = new FakeSource('a', { price: '2000' });
  const b = new FakeSource('b', { price: '2200' });
  const service = new PriceService([a, b], {
    aggregation: { ...DEFAULT_AGGREGATION, outlierToleranceBps: 5000, maxDispersionBps: 100 },
    breaker: DEFAULT_BREAKER,
    cacheTtlMs: 0,
  });

  await service.getRate('ETH', NOW);
  assert.equal(service.breakerStatus('ETH', NOW).state, 'open');

  b.set({ price: '2000' });
  const afterCooldown = NOW + DEFAULT_BREAKER.cooldownMs;
  const recovered = await service.getRate('ETH', afterCooldown);

  assert.ok(recovered.ok, 'the probe should succeed and close the breaker');
  assert.equal(service.breakerStatus('ETH', afterCooldown).state, 'closed');
});

test('a suspended asset does not suspend the others', async () => {
  const service = new PriceService(
    [new FakeSource('a', { price: '2000' }), new FakeSource('b', { price: '2200' })],
    {
      aggregation: { ...DEFAULT_AGGREGATION, outlierToleranceBps: 5000, maxDispersionBps: 100 },
      breaker: DEFAULT_BREAKER,
      cacheTtlMs: 0,
    },
  );

  await service.getRate('ETH', NOW);
  assert.equal(service.breakerStatus('ETH', NOW).state, 'open');
  assert.equal(service.breakerStatus('USDT', NOW).state, 'closed');
});

test('requireRate throws rather than inventing a fallback', async () => {
  const service = new PriceService([
    new FakeSource('a', { fail: 'HTTP 503' }),
    new FakeSource('b', { fail: 'timeout' }),
  ]);

  // Quote creation and gas estimation cannot express "no price", so they must not
  // be handed a made-up one.
  await assert.rejects(() => service.requireRate('ETH', NOW), PriceUnavailableError);
});

test('nativePriceUsd resolves a chain to its native symbol', async () => {
  const service = new PriceService(
    [
      new FakeSource('a', { price: '2000' }, ['ETH']),
      new FakeSource('b', { price: '2000' }, ['ETH']),
    ],
    DEFAULT_PRICE_SERVICE,
  );

  const price = await service.nativePriceUsd('ethereum', NOW);
  assert.ok(Math.abs(price - 2000) < 1e-9);
});

test('every observation is reported for persistence, successes and failures alike', async () => {
  const ticks: { source: string; ok: boolean }[] = [];
  const observer: TickObserver = (tick) => {
    ticks.push({ source: tick.source, ok: tick.rate !== null });
  };

  const service = new PriceService(
    [
      new FakeSource('good', { price: '2000' }),
      new FakeSource('bad', { fail: 'HTTP 500' }),
    ],
    DEFAULT_PRICE_SERVICE,
    observer,
  );

  await service.getRate('ETH', NOW);

  // Failures are recorded too: reconstructing why a rate was refused later needs
  // the failures, not just the successes.
  assert.deepEqual(ticks.sort((x, y) => x.source.localeCompare(y.source)), [
    { source: 'bad', ok: false },
    { source: 'good', ok: true },
  ]);
});

test('resetting a breaker also clears the cached rate', async () => {
  const source = new FakeSource('a', { price: '2000' });
  const service = new PriceService([source, new FakeSource('b', { price: '2000' })]);

  await service.getRate('ETH', NOW);
  service.resetBreaker('ETH');

  // An operator forcing a reset wants a fresh reading, not the value that was
  // cached before they intervened.
  await service.getRate('ETH', NOW);
  assert.equal(source.calls, 2);
});

test('coverage reports which sources can price what', async () => {
  const service = new PriceService([
    new FakeSource('wide', { price: '1' }, ['ETH', 'USDT']),
    new FakeSource('narrow', { price: '1' }, ['ETH']),
  ]);

  const coverage = service.coverage();
  assert.deepEqual(coverage.get('ETH'), ['wide', 'narrow']);
  // Surfaces the gap that would otherwise only appear as repeated failures.
  assert.deepEqual(coverage.get('USDT'), ['wide']);
  assert.equal(coverage.get('SOL'), undefined);
});

test('a service with no sources is refused at construction', () => {
  assert.throws(() => new PriceService([]), /at least one source/);
});

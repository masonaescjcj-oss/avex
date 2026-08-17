import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_BREAKER, PriceCircuitBreaker } from './breaker.js';

const NOW = 1_700_000_000_000;

test('a fresh breaker allows quoting', () => {
  const breaker = new PriceCircuitBreaker();
  assert.equal(breaker.allowsQuoting('USDT:bsc', NOW), true);
  assert.equal(breaker.status('USDT:bsc', NOW).state, 'closed');
});

test('transient failures are tolerated up to the threshold', () => {
  const breaker = new PriceCircuitBreaker();

  breaker.recordFailure('ETH', 'insufficient_sources', NOW);
  assert.equal(breaker.allowsQuoting('ETH', NOW), true, 'one failure is not enough');

  breaker.recordFailure('ETH', 'insufficient_sources', NOW);
  assert.equal(breaker.allowsQuoting('ETH', NOW), true, 'two failures is not enough');

  breaker.recordFailure('ETH', 'insufficient_sources', NOW);
  assert.equal(breaker.allowsQuoting('ETH', NOW), false, 'the third trips it');
  assert.equal(breaker.status('ETH', NOW).state, 'open');
});

test('sources disagreeing wildly opens the breaker at once', () => {
  // Not a flake: at least one source is reporting a price that is not the
  // market's. Waiting for a second occurrence would issue invoices in between.
  const breaker = new PriceCircuitBreaker();
  breaker.recordFailure('ETH', 'excessive_dispersion', NOW);

  assert.equal(breaker.allowsQuoting('ETH', NOW), false);
  assert.equal(breaker.status('ETH', NOW).lastReason, 'excessive_dispersion');
});

test('a success resets the failure count', () => {
  const breaker = new PriceCircuitBreaker();
  breaker.recordFailure('ETH', 'insufficient_sources', NOW);
  breaker.recordFailure('ETH', 'insufficient_sources', NOW);
  breaker.recordSuccess('ETH');

  assert.equal(breaker.status('ETH', NOW).consecutiveFailures, 0);

  // The counter really restarted: two more failures must not trip it.
  breaker.recordFailure('ETH', 'insufficient_sources', NOW);
  breaker.recordFailure('ETH', 'insufficient_sources', NOW);
  assert.equal(breaker.allowsQuoting('ETH', NOW), true);
});

test('an open breaker admits one probe after the cooldown', () => {
  const breaker = new PriceCircuitBreaker();
  breaker.recordFailure('ETH', 'excessive_dispersion', NOW);

  const stillOpen = NOW + DEFAULT_BREAKER.cooldownMs - 1;
  assert.equal(breaker.allowsQuoting('ETH', stillOpen), false);

  const afterCooldown = NOW + DEFAULT_BREAKER.cooldownMs;
  assert.equal(breaker.allowsQuoting('ETH', afterCooldown), true);
  assert.equal(breaker.status('ETH', afterCooldown).state, 'half_open');
});

test('a successful probe closes the breaker', () => {
  const breaker = new PriceCircuitBreaker();
  breaker.recordFailure('ETH', 'excessive_dispersion', NOW);

  const afterCooldown = NOW + DEFAULT_BREAKER.cooldownMs;
  breaker.allowsQuoting('ETH', afterCooldown);
  breaker.recordSuccess('ETH');

  assert.equal(breaker.status('ETH', afterCooldown).state, 'closed');
  assert.equal(breaker.allowsQuoting('ETH', afterCooldown), true);
});

test('a failed probe re-opens immediately and restarts the cooldown', () => {
  const breaker = new PriceCircuitBreaker();
  breaker.recordFailure('ETH', 'excessive_dispersion', NOW);

  const probeAt = NOW + DEFAULT_BREAKER.cooldownMs;
  breaker.allowsQuoting('ETH', probeAt);

  // One transient reason is enough while probing — it already had its chance.
  breaker.recordFailure('ETH', 'insufficient_sources', probeAt);
  assert.equal(breaker.status('ETH', probeAt).state, 'open');
  assert.equal(breaker.allowsQuoting('ETH', probeAt), false);

  // The new cooldown runs from the probe failure, not the original trip.
  assert.equal(breaker.status('ETH', probeAt).retryAt, probeAt + DEFAULT_BREAKER.cooldownMs);
});

test('breakers are independent per asset', () => {
  const breaker = new PriceCircuitBreaker();
  breaker.recordFailure('ETH', 'excessive_dispersion', NOW);

  // One broken feed must not stop the whole gateway.
  assert.equal(breaker.allowsQuoting('ETH', NOW), false);
  assert.equal(breaker.allowsQuoting('USDT', NOW), true);
});

test('openAssets reports what an operator needs to see', () => {
  const breaker = new PriceCircuitBreaker();
  breaker.recordFailure('ETH', 'excessive_dispersion', NOW);
  breaker.recordFailure('OBSCURE', 'no_sources_responded', NOW);
  breaker.recordSuccess('USDT');

  assert.deepEqual(breaker.openAssets(NOW), ['ETH']);
});

test('an operator can force a breaker closed', () => {
  const breaker = new PriceCircuitBreaker();
  breaker.recordFailure('ETH', 'excessive_dispersion', NOW);
  breaker.reset('ETH');

  assert.equal(breaker.allowsQuoting('ETH', NOW), true);
  assert.equal(breaker.status('ETH', NOW).state, 'closed');
});

test('retryAt is only meaningful while open', () => {
  const breaker = new PriceCircuitBreaker();
  assert.equal(breaker.status('ETH', NOW).retryAt, null);

  breaker.recordFailure('ETH', 'excessive_dispersion', NOW);
  assert.equal(breaker.status('ETH', NOW).retryAt, NOW + DEFAULT_BREAKER.cooldownMs);
});

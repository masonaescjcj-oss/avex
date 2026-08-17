import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RateLimiter } from './rate-limit.js';

test('requests are allowed up to the limit and refused after it', () => {
  const limiter = new RateLimiter(3, 60_000);
  const now = 1_700_000_000_000;

  for (let i = 0; i < 3; i++) {
    assert.equal(limiter.check('ip:1.2.3.4', now).allowed, true, `request ${i + 1}`);
  }

  const refused = limiter.check('ip:1.2.3.4', now);
  assert.equal(refused.allowed, false);
  assert.equal(refused.remaining, 0);
  assert.ok(refused.retryAfterSeconds > 0, 'a refusal must say when to retry');
});

test('remaining counts down accurately', () => {
  const limiter = new RateLimiter(3, 60_000);
  const now = 1_700_000_000_000;
  assert.equal(limiter.check('k', now).remaining, 2);
  assert.equal(limiter.check('k', now).remaining, 1);
  assert.equal(limiter.check('k', now).remaining, 0);
});

test('the window resets once it elapses', () => {
  const limiter = new RateLimiter(2, 60_000);
  const start = 1_700_000_000_000;

  limiter.check('k', start);
  limiter.check('k', start);
  assert.equal(limiter.check('k', start + 59_999).allowed, false, 'still inside the window');
  assert.equal(limiter.check('k', start + 60_001).allowed, true, 'window elapsed');
});

test('keys are independent', () => {
  const limiter = new RateLimiter(1, 60_000);
  const now = 1_700_000_000_000;

  assert.equal(limiter.check('a', now).allowed, true);
  assert.equal(limiter.check('a', now).allowed, false);
  // One client exhausting its budget must not affect another.
  assert.equal(limiter.check('b', now).allowed, true);
});

test('pruning removes only elapsed windows', () => {
  const limiter = new RateLimiter(5, 60_000);
  const start = 1_700_000_000_000;

  limiter.check('old', start);
  limiter.check('new', start + 30_000);
  assert.equal(limiter.size, 2);

  assert.equal(limiter.prune(start + 60_001), 1);
  assert.equal(limiter.size, 1, 'the newer window must survive');
});

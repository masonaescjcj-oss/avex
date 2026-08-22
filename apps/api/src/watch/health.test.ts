import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { FAILURES_BEFORE_ALERT, STALL_AFTER_MS, WatchHealth } from './health.js';

/**
 * Noticing that the watcher stopped watching.
 *
 * The failure being detected here is the one nobody reports. A payer's transfer confirms on
 * chain, the merchant sees nothing arrive, and each blames the other — while the process is up,
 * the API answers, and the database is fine. So these thresholds are the only thing between a
 * stalled cursor and finding out about it from a support ticket days later.
 */

const MINUTE = 60_000;

describe('watching the watcher', () => {
  test('a cursor that keeps moving says nothing', async () => {
    const health = new WatchHealth();

    assert.equal(health.observed('bsc', 100, 0), null, 'the first observation is a baseline');
    assert.equal(health.observed('bsc', 103, 3_000), null);
    assert.equal(health.observed('bsc', 106, 6_000), null);
    // Hours later, still moving. Silence is the correct output.
    assert.equal(health.observed('bsc', 10_000, 6 * 60 * MINUTE), null);
  });

  test('a cursor standing still becomes critical, once', async () => {
    /**
     * Every chain here produces a block every few seconds, so a cursor that has not moved in ten
     * minutes is stuck whatever the chain is — no per-chain threshold and no second call to the
     * node. And it alerts once rather than on every pass: the forwarder throttles too, but on a
     * fifteen-minute window, and this is checked every few seconds.
     */
    const health = new WatchHealth();
    health.observed('bsc', 100, 0);

    assert.equal(health.observed('bsc', 100, 5 * MINUTE), null, 'five minutes is not yet a stall');

    const alert = health.observed('bsc', 100, STALL_AFTER_MS + 1);
    assert.ok(alert);
    assert.equal(alert.severity, 'critical');
    assert.equal(alert.kind, 'watcher_stalled');
    assert.match(alert.detail, /has not advanced past block 100/);
    // The detail has to say what it means, not just what happened.
    assert.match(alert.detail, /not being detected/);

    assert.equal(
      health.observed('bsc', 100, STALL_AFTER_MS + 30_000),
      null,
      'the same stall does not alert again',
    );
  });

  test('recovery is reported, because otherwise nobody learns it is fixed', async () => {
    /**
     * An alert with no all-clear is an alert somebody has to go and check, which is how alerts
     * stop being read. One message when it breaks, one when it comes back.
     */
    const health = new WatchHealth();
    health.observed('bsc', 100, 0);
    assert.ok(health.observed('bsc', 100, STALL_AFTER_MS + 1));

    const recovered = health.observed('bsc', 140, STALL_AFTER_MS + 60_000);
    assert.ok(recovered);
    assert.equal(recovered.severity, 'warning', 'good news is not critical');
    assert.match(recovered.detail, /advancing again, now at block 140/);

    // And it is quiet again from there.
    assert.equal(health.observed('bsc', 180, STALL_AFTER_MS + 120_000), null);
  });

  test('chains are tracked separately', async () => {
    // One provider having a bad day must not mask another chain that is fine, and must not
    // report a stall on it either.
    const health = new WatchHealth();
    health.observed('bsc', 100, 0);
    health.observed('ethereum', 500, 0);

    health.observed('ethereum', 520, STALL_AFTER_MS + 1);
    const alert = health.observed('bsc', 100, STALL_AFTER_MS + 1);

    assert.ok(alert, 'bsc is stalled');
    assert.match(alert.detail, /^bsc/);
    assert.equal(health.observed('ethereum', 540, STALL_AFTER_MS + 2), null, 'ethereum is fine');
  });

  test('a few failed polls are weather; five in a row are not', async () => {
    /**
     * The loop already retries with a backoff, and an endpoint that is rate limiting us is
     * normal. What is not normal is every attempt failing — at that point payments are not being
     * detected, and the backoff is making it quieter rather than better.
     */
    const health = new WatchHealth();
    health.observed('bsc', 100, 0);

    for (let attempt = 1; attempt < FAILURES_BEFORE_ALERT; attempt += 1) {
      assert.equal(health.failed('bsc', attempt, 'HTTP 429', attempt * 1_000), null, `${attempt}`);
    }

    const alert = health.failed('bsc', FAILURES_BEFORE_ALERT, 'HTTP 429', 10_000);
    assert.ok(alert);
    assert.equal(alert.severity, 'critical');
    assert.equal(alert.kind, 'watcher_failing');
    assert.match(alert.detail, /HTTP 429/, 'the reason has to travel with it');

    // Still failing is not new information.
    assert.equal(health.failed('bsc', 20, 'HTTP 429', 20_000), null);
  });

  test('a poll succeeding after failures reports the recovery', async () => {
    const health = new WatchHealth();
    health.observed('bsc', 100, 0);
    assert.ok(health.failed('bsc', FAILURES_BEFORE_ALERT, 'econnrefused', 10_000));

    const recovered = health.observed('bsc', 100, 20_000);
    assert.ok(recovered);
    assert.equal(recovered.kind, 'watcher_failing');
    assert.match(recovered.detail, /polling successfully again/);
  });

  test('a chain that fails before it ever succeeds is still reported', async () => {
    /**
     * The startup case: a misconfigured endpoint means the first poll fails and there is no
     * baseline to compare against. Reporting it is the whole point — this is a deployment that
     * has never worked, and it looks exactly like a quiet chain.
     */
    const health = new WatchHealth();
    const alert = health.failed('polygon', FAILURES_BEFORE_ALERT, 'no such host', 5_000);
    assert.ok(alert);
    assert.match(alert.detail, /^polygon has failed/);
  });
});

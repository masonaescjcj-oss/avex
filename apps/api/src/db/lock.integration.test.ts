import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { sql } from 'drizzle-orm';

import { createDatabase } from './client.js';
import { JOB_LOCKS, withJobLock } from './lock.js';

/**
 * The advisory lock that stops two copies of a background job running at once.
 *
 * Needs two real connections to test at all: an advisory lock is held per session, so a
 * single pool would hand the second attempt the same session and it would succeed — which
 * is the bug this would have shipped with if it were unit tested against a mock.
 */
const databaseUrl = process.env.DATABASE_URL;

describe('job locks', { skip: databaseUrl ? false : 'DATABASE_URL not set' }, () => {
  let first: ReturnType<typeof createDatabase>;
  let second: ReturnType<typeof createDatabase>;

  before(() => {
    first = createDatabase(databaseUrl!);
    second = createDatabase(databaseUrl!);
  });

  after(async () => {
    await first?.close();
    await second?.close();
  });

  test('the job runs, and the lock is released afterwards', async () => {
    let ran = 0;
    const once = await withJobLock(first.db, JOB_LOCKS.webhookDelivery, async () => {
      ran += 1;
      return 'done';
    });
    assert.deepEqual(once, { ran: true, result: 'done' });

    // Released, so the next tick can take it. A lock that leaked would make this fail.
    const again = await withJobLock(first.db, JOB_LOCKS.webhookDelivery, async () => {
      ran += 1;
      return 'again';
    });
    assert.equal(again.ran, true);
    assert.equal(ran, 2);
  });

  test('a second process skips instead of running the same job', async () => {
    /**
     * The whole point. The second attempt must return rather than wait: a scheduler firing
     * every minute has to skip a busy minute, not queue behind it, or a slow run becomes a
     * pile of connections all waiting to do work already in progress.
     */
    let concurrent = 0;
    let overlapped = false;
    let secondRan = false;

    await withJobLock(first.db, JOB_LOCKS.payoutChanges, async () => {
      concurrent += 1;

      const attempt = await withJobLock(second.db, JOB_LOCKS.payoutChanges, async () => {
        secondRan = true;
        if (concurrent > 0) overlapped = true;
      });

      assert.equal(attempt.ran, false, 'the second process must not run the job');
      assert.equal(attempt.result, null);
      concurrent -= 1;
    });

    assert.equal(secondRan, false);
    assert.equal(overlapped, false);
  });

  test('different jobs do not block each other', async () => {
    // Otherwise a slow webhook drain would stop payout changes from being applied, and the
    // delay on a payout change is the whole protection it offers.
    let inner = false;
    await withJobLock(first.db, JOB_LOCKS.webhookDelivery, async () => {
      const attempt = await withJobLock(second.db, JOB_LOCKS.commissionPeriods, async () => {
        inner = true;
      });
      assert.equal(attempt.ran, true);
    });
    assert.equal(inner, true);
  });

  test('a job that throws still releases the lock', async () => {
    /**
     * The failure mode that would be worst: one exception and the job never runs again
     * until the process is restarted, silently, with nothing but a stalled queue to show
     * for it.
     */
    await assert.rejects(
      withJobLock(first.db, JOB_LOCKS.commissionPeriods, async () => {
        throw new Error('boom');
      }),
      /boom/,
    );

    const after_ = await withJobLock(first.db, JOB_LOCKS.commissionPeriods, async () => 'ok');
    assert.equal(after_.ran, true, 'the lock was not released after a failure');
  });

  test('every job has its own lock number', () => {
    // Two jobs sharing one would make each skip while the other ran, which looks like both
    // working and is neither.
    const numbers = Object.values(JOB_LOCKS);
    assert.equal(new Set(numbers).size, numbers.length, JSON.stringify(JOB_LOCKS));
  });

  test('nothing is left locked when the tests finish', async () => {
    /**
     * Read from `pg_locks` rather than trusted: the unlock is in a `finally` whose failure
     * is deliberately swallowed, so this is the only thing that would notice it never
     * working at all.
     */
    const held = await first.db.execute<{ objid: number }>(
      sql`select objid from pg_locks where locktype = 'advisory' and objid = any(${sql.raw(
        `array[${Object.values(JOB_LOCKS).join(',')}]`,
      )})`,
    );
    assert.deepEqual([...held], []);
  });
});

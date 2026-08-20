import { sql } from 'drizzle-orm';

import type { Database } from './client.js';

/**
 * Run something once, no matter how many copies of this process exist.
 *
 * The three background jobs were `setInterval` in a single process, which was safe only
 * because there was exactly one. Two API instances behind a load balancer, or a scheduler
 * firing while the previous run is still going, and they overlap — and two of the three do
 * things that must not happen twice:
 *
 *   - webhook delivery reads pending rows and posts them, so an overlap delivers a payment
 *     notification twice to a merchant whose handler may not be idempotent;
 *   - the payout worker applies scheduled address changes, and applying one twice is
 *     harmless only by luck of the update being idempotent.
 *
 * A Postgres advisory lock rather than a row: it is held by the session and released when
 * that session dies, so a process killed mid-run does not leave a lock nobody can clear.
 * A `lock` table would need exactly that recovery path, and it would be the code nobody
 * tests until the night it matters.
 *
 * `pg_try_advisory_lock`, never the blocking form. A scheduler that fires every minute
 * must skip a busy minute, not queue up behind it — the blocking version turns a slow run
 * into a growing pile of connections all waiting to do work that is already being done.
 */

/**
 * Lock identities.
 *
 * Named here so two jobs cannot silently share a number. The values are arbitrary but
 * fixed: changing one during a deploy means the old and new processes are using different
 * locks and both run, which is the exact thing this file exists to prevent.
 */
export const JOB_LOCKS = {
  webhookDelivery: 8_140_001,
  commissionPeriods: 8_140_002,
  payoutChanges: 8_140_003,
  /**
   * The watcher's claim on its role, not on a pass.
   *
   * Held for the life of the process rather than per poll: a second copy — started by a
   * deploy that did not stop the first, which is the ordinary way this goes wrong — must
   * exit rather than scan the same ranges and race the first one's cursor writes.
   */
  chainWatcher: 8_140_004,
} as const;

export type JobLock = (typeof JOB_LOCKS)[keyof typeof JOB_LOCKS];

export interface LockedRun<T> {
  /** False when another copy held the lock; nothing was run. */
  readonly ran: boolean;
  readonly result: T | null;
}

/**
 * Take the lock, run the job, release it.
 *
 * The release is in a `finally` and its failure is swallowed deliberately: the connection
 * dying is itself the release, so a failed unlock is either redundant or unreachable. What
 * must not happen is an unlock error masking the job's own error.
 */
export async function withJobLock<T>(
  db: Database,
  lock: JobLock,
  job: () => Promise<T>,
): Promise<LockedRun<T>> {
  const [taken] = await db.execute<{ locked: boolean }>(
    sql`select pg_try_advisory_lock(${lock}) as locked`,
  );
  if (taken?.locked !== true) return { ran: false, result: null };

  try {
    return { ran: true, result: await job() };
  } finally {
    await db.execute(sql`select pg_advisory_unlock(${lock})`).catch(() => undefined);
  }
}

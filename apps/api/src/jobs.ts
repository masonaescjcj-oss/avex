import type { FeePlanService } from './domain/fee-plan-service.js';
import type { PayoutAddressService } from './domain/payout-service.js';
import type { WebhookService } from './domain/webhook-service.js';
import type { Database } from './db/client.js';
import { JOB_LOCKS, withJobLock } from './db/lock.js';
import type { JobLock } from './db/lock.js';

/**
 * The three things that happen on a clock rather than on a request.
 *
 * Defined here rather than inside `main.ts` because there are two ways to drive them and
 * only one definition should exist. A long-lived process runs them on `setInterval`. A
 * deployment with no long-lived process — a serverless function, a container that scales to
 * zero — has a scheduler call them over HTTP instead. Same job, same lock, same tally.
 *
 * The lock is not optional in either mode, and that is the reason this file exists at all:
 * as intervals in a single process they could not overlap, so the code never needed one. A
 * scheduler can fire while the previous run is still going, and two API instances behind a
 * load balancer both hold a timer — either of which delivers a merchant's payment webhook
 * twice.
 */

export const JOB_NAMES = ['webhooks', 'commission', 'payouts'] as const;
export type JobName = (typeof JOB_NAMES)[number];

export function isJobName(value: string): value is JobName {
  return (JOB_NAMES as readonly string[]).includes(value);
}

export interface JobOutcome {
  readonly job: JobName;
  /** False when another copy held the lock. Not an error: the work is being done. */
  readonly ran: boolean;
  /** Whatever the job counted, for the log. Null when it did not run. */
  readonly detail: unknown;
}

export interface JobDependencies {
  readonly db: Database;
  readonly webhooks: WebhookService;
  readonly feePlans: FeePlanService;
  readonly payouts: PayoutAddressService;
}

interface JobDefinition {
  readonly lock: JobLock;
  /**
   * How often a driver should attempt it.
   *
   * Carried with the job rather than at the call site so the interval driver and the
   * scheduler cannot disagree about it — a cron entry saying hourly beside a comment saying
   * daily is a discrepancy nobody notices until a merchant asks why their rate is stale.
   */
  readonly everyMs: number;
  readonly run: (deps: JobDependencies) => Promise<unknown>;
}

const DEFINITIONS: Readonly<Record<JobName, JobDefinition>> = {
  /**
   * Delivery runs on its own clock rather than inline, so a retry backlog drains
   * independently of whatever is happening on-chain.
   */
  webhooks: {
    lock: JOB_LOCKS.webhookDelivery,
    everyMs: 10_000,
    run: async ({ webhooks }) => {
      const tally = await webhooks.drain();
      return tally.delivered + tally.failed + tally.abandoned > 0 ? tally : null;
    },
  },

  /**
   * Commission periods close hourly rather than daily.
   *
   * Hourly means a merchant whose month just ended is on the rate their volume earned
   * within the hour, rather than up to a day later. Safe to run this often because a plan
   * whose period ends in the future is not selected, so a second run in the same hour does
   * nothing — and because it only ever assesses a period that has closed, so frequency
   * cannot make it read a partial month.
   */
  commission: {
    lock: JOB_LOCKS.commissionPeriods,
    everyMs: 60 * 60_000,
    run: async ({ feePlans }) => {
      const report = await feePlans.closePeriods();
      return report.moved > 0 ? report : null;
    },
  },

  payouts: {
    lock: JOB_LOCKS.payoutChanges,
    everyMs: 60_000,
    run: async ({ payouts }) => {
      const count = await payouts.applyDueChanges();
      return count > 0 ? { count } : null;
    },
  },
};

export function jobInterval(job: JobName): number {
  return DEFINITIONS[job].everyMs;
}

/** Run one job, unless another copy of it is already running. */
export async function runJob(job: JobName, deps: JobDependencies): Promise<JobOutcome> {
  const definition = DEFINITIONS[job];
  const outcome = await withJobLock(deps.db, definition.lock, () => definition.run(deps));
  return { job, ran: outcome.ran, detail: outcome.result };
}

/**
 * Run all three, in order, one at a time.
 *
 * Sequential deliberately. A scheduler that can only be given one hook — which is the
 * common case — would otherwise open three pooled connections at once for work that is not
 * urgent, and on a connection-limited deployment that is the request path's budget being
 * spent on housekeeping.
 *
 * Each job is locked separately, so this is not one big lock: a slow webhook drain does not
 * stop a payout change from being applied, and the delay on a payout change is the entire
 * protection it offers.
 */
export async function runAllJobs(deps: JobDependencies): Promise<readonly JobOutcome[]> {
  const outcomes: JobOutcome[] = [];
  for (const job of JOB_NAMES) {
    outcomes.push(await runJob(job, deps));
  }
  return outcomes;
}

/**
 * Drive the jobs on timers, for a deployment that has a process to keep them in.
 *
 * `unref` so the timers never hold the process open: shutdown is decided by the server, and
 * a timer that outlives it turns a clean stop into a thirty-second wait.
 */
export function startJobTimers(
  deps: JobDependencies,
  log: { info: (data: unknown, message: string) => void; error: (data: unknown, message: string) => void },
): () => void {
  const timers = JOB_NAMES.map((job) => {
    const timer = setInterval(() => {
      void runJob(job, deps)
        .then((outcome) => {
          // Only when something happened. A log line every ten seconds saying nothing
          // happened is how the log stops being read.
          if (outcome.ran && outcome.detail !== null) {
            log.info({ job, detail: outcome.detail }, 'scheduled job did work');
          }
        })
        .catch((error: unknown) => log.error({ err: error, job }, 'scheduled job failed'));
    }, jobInterval(job));
    timer.unref();
    return timer;
  });

  return () => {
    for (const timer of timers) clearInterval(timer);
  };
}

import type { PollOutcome, Watcher } from '@avex/core';

/**
 * Driving a watcher, forever.
 *
 * `Watcher.poll()` does one pass and returns. Something has to call it repeatedly, decide
 * what to do when it throws, and stop when the process is going away — and that is all this
 * file is. It is separate from the watcher because the two fail differently: a bad poll is a
 * chain or provider problem, and a bad loop is an availability problem.
 *
 * The behaviour that matters is what happens on failure. An RPC endpoint that is down, rate
 * limiting us, or lying about the head is the normal weather, not an exception — so the loop
 * backs off and keeps going rather than exiting. A watcher that dies on the first 429 is a
 * watcher that stops crediting payments at the exact moment traffic is highest.
 */

export interface LoopOptions {
  /** Gap between successful polls. Roughly a block time; shorter only wastes requests. */
  readonly intervalMs: number;
  /** First wait after a failure. Doubles from here. */
  readonly backoffMs: number;
  /**
   * Cap on the backoff.
   *
   * Bounded because an outage that lasts an hour must not leave the next attempt an hour
   * away: the chain caught up long before that, and the merchant is waiting.
   */
  readonly maxBackoffMs: number;
}

export const DEFAULT_LOOP: LoopOptions = {
  intervalMs: 5_000,
  backoffMs: 2_000,
  maxBackoffMs: 60_000,
};

export interface LoopHandle {
  /** Resolves once the loop has stopped and is not mid-poll. */
  stop(): Promise<void>;
}

export interface LoopHooks {
  readonly onPoll?: ((outcome: PollOutcome) => void) | undefined;
  readonly onError?: ((error: unknown, consecutive: number) => void) | undefined;
  /**
   * Wait, injectable so a test does not have to.
   *
   * The alternative is a test that sleeps for real, which is slow, or one that mocks timers
   * globally, which then fights every other async thing in the process.
   */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // So a pending wait never holds the process open at shutdown.
    timer.unref?.();
  });

/**
 * Poll until stopped.
 *
 * Returns immediately with a handle; the loop runs in the background. `stop()` waits for the
 * poll in flight rather than abandoning it, because a poll interrupted between crediting a
 * payment and saving its cursor is a payment that gets credited again on restart — the sink
 * is idempotent, so that is survivable, but it is noise in the one log that should be quiet.
 */
export function runWatchLoop(
  watcher: Watcher,
  options: LoopOptions = DEFAULT_LOOP,
  hooks: LoopHooks = {},
): LoopHandle {
  const sleep = hooks.sleep ?? realSleep;
  let running = true;
  let consecutiveFailures = 0;

  const finished = (async () => {
    while (running) {
      try {
        const outcome = await watcher.poll();
        consecutiveFailures = 0;
        hooks.onPoll?.(outcome);
        if (running) await sleep(options.intervalMs);
      } catch (error) {
        consecutiveFailures += 1;
        hooks.onError?.(error, consecutiveFailures);

        /**
         * Exponential, capped, and measured in consecutive failures rather than elapsed
         * time. One bad response should not slow the next poll much; twenty in a row means
         * something is properly wrong and hammering it makes it worse.
         */
        const wait = Math.min(
          options.backoffMs * 2 ** (consecutiveFailures - 1),
          options.maxBackoffMs,
        );
        if (running) await sleep(wait);
      }
    }
  })();

  return {
    async stop(): Promise<void> {
      running = false;
      await finished;
    },
  };
}

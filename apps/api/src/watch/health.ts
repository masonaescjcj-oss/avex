import type { Alert, ChainId } from '@avex/core';

/**
 * Noticing that the watcher has stopped watching.
 *
 * This is the worst silent failure in the system, and the reason is that nobody complains. A
 * payer sends funds and the transfer confirms on chain; a merchant sees nothing arrive and blames
 * the payer; the payer has a transaction hash and blames the merchant. Both are right, and
 * neither is looking at us. Meanwhile every other signal is healthy: the process is up, the API
 * answers, the database is fine.
 *
 * ## Two signals, and why not the obvious one
 *
 * The obvious one is distance from the chain head, and it needs a second call to the node on
 * every check plus a threshold per chain — twelve blocks is nothing on BNB Chain and a long way
 * on Ethereum. These two need neither:
 *
 * **The cursor must advance.** Every chain here produces a block every few seconds, so a cursor
 * that has not moved in ten minutes is stuck whatever the chain's block time is. It catches the
 * cases that are otherwise invisible: a provider that returns the same head forever, a poll that
 * throws inside a `catch` somewhere, a chain that has genuinely halted.
 *
 * **Polls must mostly succeed.** The loop already retries with a backoff, which is right — an
 * endpoint that is rate limiting us is the normal weather. Five failures in a row is not weather.
 *
 * Both are computed from what a poll already reports, so checking costs nothing and cannot itself
 * fail. The class is pure: it returns alerts and forwards nothing, so the thresholds can be
 * tested without a mail server.
 */

/**
 * How long a cursor may stand still before it is a problem.
 *
 * Ten minutes. The fastest chain here produces two hundred blocks in that time and the slowest
 * fifty, so there is no chain on which this is a normal pause — and it is long enough that a
 * provider being briefly unreachable, which the loop's backoff covers, does not reach it.
 */
export const STALL_AFTER_MS = 10 * 60_000;

/** Consecutive failures before the chain is treated as down rather than flaky. */
export const FAILURES_BEFORE_ALERT = 5;

interface ChainState {
  scannedTo: number;
  advancedAt: number;
  /** Set while an alert for this chain is outstanding, so recovery can be reported once. */
  stalled: boolean;
  failing: boolean;
}

export class WatchHealth {
  private readonly state = new Map<ChainId, ChainState>();

  constructor(
    private readonly stallAfterMs: number = STALL_AFTER_MS,
    private readonly failuresBeforeAlert: number = FAILURES_BEFORE_ALERT,
  ) {}

  /**
   * A successful poll. Returns an alert when the cursor has stood still too long, or when it has
   * started moving again after having stopped.
   *
   * The recovery notice matters as much as the alarm: the alarm says "look at this", and without
   * a second message the only way to learn it is fixed is to go and check. That is the difference
   * between an alert somebody trusts and one they learn to ignore.
   */
  observed(chain: ChainId, scannedTo: number, now: number = Date.now()): Alert | null {
    const previous = this.state.get(chain);

    if (previous === undefined) {
      this.state.set(chain, { scannedTo, advancedAt: now, stalled: false, failing: false });
      return null;
    }

    // A poll succeeded, so whatever was failing is not failing now.
    if (previous.failing) {
      previous.failing = false;
      this.state.set(chain, previous);
      return {
        severity: 'warning',
        kind: 'watcher_failing',
        detail: `${chain} is polling successfully again`,
      };
    }

    if (scannedTo > previous.scannedTo) {
      const wasStalled = previous.stalled;
      this.state.set(chain, { scannedTo, advancedAt: now, stalled: false, failing: false });
      return wasStalled
        ? {
            severity: 'warning',
            kind: 'watcher_stalled',
            detail: `${chain} is advancing again, now at block ${scannedTo}`,
          }
        : null;
    }

    /**
     * The cursor has not moved. Alert once, not on every pass.
     *
     * The forwarder throttles too, but on a fifteen-minute window — and this condition is
     * checked every few seconds, so the flag is what keeps the log readable as well as the
     * mailbox.
     */
    if (now - previous.advancedAt >= this.stallAfterMs && !previous.stalled) {
      previous.stalled = true;
      this.state.set(chain, previous);
      return {
        severity: 'critical',
        kind: 'watcher_stalled',
        detail:
          `${chain} has not advanced past block ${previous.scannedTo} in ` +
          `${Math.round((now - previous.advancedAt) / 60_000)} minutes. Payments on this chain ` +
          'are not being detected: a payer whose transfer confirmed is seeing nothing arrive.',
      };
    }

    return null;
  }

  /** A poll that threw. Returns an alert on the nth consecutive failure, once. */
  failed(
    chain: ChainId,
    consecutive: number,
    detail: string,
    now: number = Date.now(),
  ): Alert | null {
    const previous =
      this.state.get(chain) ??
      ({ scannedTo: -1, advancedAt: now, stalled: false, failing: false } satisfies ChainState);

    if (consecutive < this.failuresBeforeAlert || previous.failing) {
      this.state.set(chain, previous);
      return null;
    }

    previous.failing = true;
    this.state.set(chain, previous);
    return {
      severity: 'critical',
      kind: 'watcher_failing',
      detail:
        `${chain} has failed ${consecutive} polls in a row: ${detail}. Payments on this chain ` +
        'are not being detected.',
    };
  }
}

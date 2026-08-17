import type { AggregationFailureReason } from './aggregate.js';

/**
 * Per-asset circuit breaker over the price feed.
 *
 * When pricing cannot be trusted, the correct behaviour is to stop issuing new
 * invoices for that asset — not to carry on with the last rate that happened to
 * work. Continuing is what turns a few minutes of feed trouble into a real loss,
 * because nothing visibly breaks: invoices keep being created, at prices nobody
 * can justify afterwards.
 *
 * Invoices already issued are unaffected. Their rate was locked when they were
 * created, and honouring it is the whole point of locking.
 */

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerConfig {
  /** Consecutive failures tolerated before the breaker opens. */
  readonly failureThreshold: number;
  /** How long to stay open before letting one probe through. */
  readonly cooldownMs: number;
  /**
   * Failures that open the breaker on first occurrence.
   *
   * Sources disagreeing wildly is not a transient flake — it means at least one
   * of them is reporting a price that is not the market's. Waiting for a second
   * occurrence would issue invoices in between.
   */
  readonly openImmediatelyOn: readonly AggregationFailureReason[];
}

export const DEFAULT_BREAKER: BreakerConfig = {
  failureThreshold: 3,
  cooldownMs: 60_000,
  openImmediatelyOn: ['excessive_dispersion'],
};

export interface BreakerStatus {
  readonly state: BreakerState;
  readonly consecutiveFailures: number;
  readonly openedAt: number | null;
  readonly lastReason: AggregationFailureReason | null;
  /** When a probe will next be permitted. Null unless open. */
  readonly retryAt: number | null;
}

interface AssetBreaker {
  state: BreakerState;
  consecutiveFailures: number;
  openedAt: number | null;
  lastReason: AggregationFailureReason | null;
}

export class PriceCircuitBreaker {
  private readonly breakers = new Map<string, AssetBreaker>();

  constructor(private readonly config: BreakerConfig = DEFAULT_BREAKER) {}

  private get(key: string): AssetBreaker {
    let breaker = this.breakers.get(key);
    if (!breaker) {
      breaker = { state: 'closed', consecutiveFailures: 0, openedAt: null, lastReason: null };
      this.breakers.set(key, breaker);
    }
    return breaker;
  }

  /**
   * Whether a new quote may be priced for this asset right now.
   *
   * Transitions an expired cooldown to `half_open` as a side effect, so the next
   * pricing attempt acts as the probe.
   */
  allowsQuoting(key: string, now: number = Date.now()): boolean {
    const breaker = this.get(key);

    if (breaker.state === 'open') {
      const elapsed = now - (breaker.openedAt ?? now);
      if (elapsed >= this.config.cooldownMs) {
        breaker.state = 'half_open';
        return true;
      }
      return false;
    }

    return true;
  }

  recordSuccess(key: string): void {
    const breaker = this.get(key);
    breaker.state = 'closed';
    breaker.consecutiveFailures = 0;
    breaker.openedAt = null;
    breaker.lastReason = null;
  }

  recordFailure(key: string, reason: AggregationFailureReason, now: number = Date.now()): void {
    const breaker = this.get(key);
    breaker.consecutiveFailures += 1;
    breaker.lastReason = reason;

    // A failed probe re-opens immediately; it already had its second chance.
    const wasProbing = breaker.state === 'half_open';

    if (
      wasProbing ||
      this.config.openImmediatelyOn.includes(reason) ||
      breaker.consecutiveFailures >= this.config.failureThreshold
    ) {
      breaker.state = 'open';
      breaker.openedAt = now;
    }
  }

  status(key: string, now: number = Date.now()): BreakerStatus {
    const breaker = this.get(key);
    return {
      state: breaker.state,
      consecutiveFailures: breaker.consecutiveFailures,
      openedAt: breaker.openedAt,
      lastReason: breaker.lastReason,
      retryAt:
        breaker.state === 'open' && breaker.openedAt !== null
          ? breaker.openedAt + this.config.cooldownMs
          : null,
    };
  }

  /** Assets currently refusing new quotes — what an operator dashboard shows. */
  openAssets(now: number = Date.now()): readonly string[] {
    return [...this.breakers.entries()]
      .filter(([key]) => !this.allowsQuoting(key, now))
      .map(([key]) => key);
  }

  /** Force closed. For an operator who has confirmed the feed is healthy. */
  reset(key: string): void {
    this.recordSuccess(key);
  }
}

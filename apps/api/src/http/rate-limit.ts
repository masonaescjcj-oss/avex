/**
 * Fixed-window rate limiter.
 *
 * In-process and therefore per-instance: two API servers allow twice the
 * configured rate. That is an accepted limitation for Phase 1 and must move to
 * Redis before horizontal scaling, since the login endpoint depends on this to
 * blunt credential stuffing. The interface is deliberately storage-agnostic so
 * that swap does not reach callers.
 */

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  /** Unix milliseconds when the current window resets. */
  readonly resetAt: number;
  readonly retryAfterSeconds: number;
}

interface Window {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  check(key: string, now: number = Date.now()): RateLimitDecision {
    const existing = this.windows.get(key);

    if (!existing || existing.resetAt <= now) {
      const resetAt = now + this.windowMs;
      this.windows.set(key, { count: 1, resetAt });
      return { allowed: true, remaining: this.limit - 1, resetAt, retryAfterSeconds: 0 };
    }

    if (existing.count >= this.limit) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: existing.resetAt,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
      };
    }

    existing.count += 1;
    return {
      allowed: true,
      remaining: this.limit - existing.count,
      resetAt: existing.resetAt,
      retryAfterSeconds: 0,
    };
  }

  /** Drop expired windows. Called on a timer so the map cannot grow without bound. */
  prune(now: number = Date.now()): number {
    let removed = 0;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) {
        this.windows.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.windows.size;
  }
}

/**
 * Tighter limits for endpoints where each attempt is a guess at a secret.
 * Keyed by IP *and* by account, so one attacker cannot lock out a victim by
 * exhausting the account's budget from many addresses, nor spray many accounts
 * from one address.
 */
export const AUTH_ATTEMPT_LIMIT = 10;
export const AUTH_ATTEMPT_WINDOW_MS = 15 * 60_000;

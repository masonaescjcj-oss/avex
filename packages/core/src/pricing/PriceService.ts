import { chainConfig } from '../chains/registry.js';
import type { ChainId } from '../types.js';
import {
  DEFAULT_AGGREGATION,
  aggregate,
  type AggregationConfig,
  type AggregationFailureReason,
  type RejectedSource,
  type SourceObservation,
} from './aggregate.js';
import {
  DEFAULT_BREAKER,
  PriceCircuitBreaker,
  type BreakerConfig,
  type BreakerStatus,
} from './breaker.js';
import type { Rate } from './rate.js';
import { rateToNumber } from './rate.js';
import type { PriceSource, PriceSymbol } from './sources/index.js';

/**
 * The pricing engine's front door: fetch from every configured source in
 * parallel, aggregate, and consult the circuit breaker.
 */

export interface PriceServiceConfig {
  readonly aggregation: AggregationConfig;
  readonly breaker: BreakerConfig;
  /**
   * How long an aggregated rate may be reused.
   *
   * Short, and separate from the staleness limit. Its job is to keep a burst of
   * checkout page loads from exhausting a source's rate limit, not to extend the
   * life of a price — the cached entry keeps its original `observedAt`, so it ages
   * out of the staleness check on schedule regardless.
   */
  readonly cacheTtlMs: number;
}

export const DEFAULT_PRICE_SERVICE: PriceServiceConfig = {
  aggregation: DEFAULT_AGGREGATION,
  breaker: DEFAULT_BREAKER,
  cacheTtlMs: 10_000,
};

export type RateResult =
  | {
      readonly ok: true;
      readonly rate: Rate;
      readonly sources: readonly string[];
      readonly dispersionBps: number;
      readonly cached: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: AggregationFailureReason | 'circuit_open';
      readonly detail: string;
      readonly breaker: BreakerStatus;
      readonly rejected: readonly RejectedSource[];
    };

/** Emitted for every observation, so ticks can be persisted for later audit. */
export interface TickObserver {
  (tick: {
    readonly symbol: PriceSymbol;
    readonly source: string;
    readonly rate: Rate | null;
    readonly error: string | null;
  }): void;
}

export class PriceUnavailableError extends Error {
  constructor(
    readonly symbol: string,
    readonly reason: string,
    detail: string,
  ) {
    super(`no trustworthy price for ${symbol}: ${reason} (${detail})`);
    this.name = 'PriceUnavailableError';
  }
}

interface CacheEntry {
  readonly result: Extract<RateResult, { ok: true }>;
  readonly fetchedAt: number;
}

export class PriceService {
  private readonly breaker: PriceCircuitBreaker;
  private readonly cache = new Map<PriceSymbol, CacheEntry>();
  /** In-flight requests, so concurrent callers share one round of fetches. */
  private readonly inFlight = new Map<PriceSymbol, Promise<RateResult>>();

  constructor(
    private readonly sources: readonly PriceSource[],
    private readonly config: PriceServiceConfig = DEFAULT_PRICE_SERVICE,
    private readonly onTick: TickObserver = () => {},
  ) {
    if (sources.length === 0) throw new Error('PriceService requires at least one source');
    this.breaker = new PriceCircuitBreaker(config.breaker);
  }

  async getRate(symbol: PriceSymbol, now: number = Date.now()): Promise<RateResult> {
    const cached = this.cache.get(symbol);
    if (cached && now - cached.fetchedAt < this.config.cacheTtlMs) {
      return { ...cached.result, cached: true };
    }

    // A burst of checkout loads must produce one round of fetches, not one each.
    const existing = this.inFlight.get(symbol);
    if (existing) return existing;

    const pending = this.fetchAndAggregate(symbol, now).finally(() => {
      this.inFlight.delete(symbol);
    });
    this.inFlight.set(symbol, pending);
    return pending;
  }

  private async fetchAndAggregate(symbol: PriceSymbol, now: number): Promise<RateResult> {
    if (!this.breakerAllows(symbol, now)) {
      const status = this.breaker.status(symbol, now);
      return {
        ok: false,
        reason: 'circuit_open',
        detail:
          `pricing suspended after ${status.consecutiveFailures} failure(s) ` +
          `(${status.lastReason ?? 'unknown'})`,
        breaker: status,
        rejected: [],
      };
    }

    const capable = this.sources.filter((source) => source.supports(symbol));

    const observations: SourceObservation[] = await Promise.all(
      capable.map(async (source): Promise<SourceObservation> => {
        try {
          const rate = await source.fetchUsdPrice(symbol);
          this.onTick({ symbol, source: source.name, rate, error: null });
          return { source: source.name, rate };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'unknown error';
          this.onTick({ symbol, source: source.name, rate: null, error: message });
          return { source: source.name, rate: null, error: message };
        }
      }),
    );

    const result = aggregate(observations, this.config.aggregation, now);

    if (!result.ok) {
      this.breaker.recordFailure(symbol, result.reason, now);
      return {
        ok: false,
        reason: result.reason,
        detail: result.detail,
        breaker: this.breaker.status(symbol, now),
        rejected: result.rejected,
      };
    }

    this.breaker.recordSuccess(symbol);
    const success = {
      ok: true as const,
      rate: result.rate,
      sources: result.usedSources,
      dispersionBps: result.dispersionBps,
      cached: false,
    };
    this.cache.set(symbol, { result: success, fetchedAt: now });
    return success;
  }

  private breakerAllows(symbol: PriceSymbol, now: number): boolean {
    return this.breaker.allowsQuoting(symbol, now);
  }

  /**
   * Rate or nothing.
   *
   * Callers that cannot express "no price available" — quote creation, gas
   * estimation — get an exception instead of a fallback. Continuing with a stale
   * or invented number is how a feed problem becomes a pricing loss.
   */
  async requireRate(symbol: PriceSymbol, now: number = Date.now()): Promise<Rate> {
    const result = await this.getRate(symbol, now);
    if (!result.ok) throw new PriceUnavailableError(symbol, result.reason, result.detail);
    return result.rate;
  }

  /**
   * Implements the `PriceOracle` interface the chain adapters depend on.
   *
   * `now` is optional so the signature still satisfies that interface, but exists
   * so staleness can be evaluated against a supplied clock rather than the wall
   * clock — otherwise this path is untestable without waiting in real time.
   */
  async nativePriceUsd(chain: ChainId, now: number = Date.now()): Promise<number> {
    const symbol = chainConfig(chain).nativeSymbol as PriceSymbol;
    return rateToNumber(await this.requireRate(symbol, now));
  }

  /** Assets currently refusing new quotes — for the operator dashboard. */
  suspendedSymbols(now: number = Date.now()): readonly string[] {
    return this.breaker.openAssets(now);
  }

  breakerStatus(symbol: PriceSymbol, now: number = Date.now()): BreakerStatus {
    return this.breaker.status(symbol, now);
  }

  /** Force a breaker closed, once an operator has confirmed the feed is healthy. */
  resetBreaker(symbol: PriceSymbol): void {
    this.breaker.reset(symbol);
    this.cache.delete(symbol);
  }

  /** Which symbols any configured source can price — surfaces coverage gaps. */
  coverage(): ReadonlyMap<string, readonly string[]> {
    const map = new Map<string, string[]>();
    for (const source of this.sources) {
      for (const symbol of ['ETH', 'BNB', 'POL', 'TRX', 'SOL', 'TON', 'USDT', 'USDC'] as const) {
        if (!source.supports(symbol)) continue;
        const existing = map.get(symbol) ?? [];
        existing.push(source.name);
        map.set(symbol, existing);
      }
    }
    return map;
  }
}

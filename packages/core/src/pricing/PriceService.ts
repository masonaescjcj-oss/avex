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
import { rateFromDecimalString, rateToNumber } from './rate.js';
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
  /**
   * How long the last good aggregate may stand in for a failed fetch.
   *
   * Zero, the default, means it never does: a failed fetch is "no price", as it always was.
   * A deployment that turns this on is choosing a rate up to this old over a currency picker
   * that flickers when one source has a bad minute — see `recent()`. Never longer than the
   * aggregation's own staleness limit, whatever is configured.
   */
  readonly staleFallbackMs?: number | undefined;
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

/**
 * Assets that are a dollar by design, and how far from it one is still believed.
 *
 * A stablecoin quote needs two agreeing sources like anything else — until it has only one.
 * Then the ordinary rule says "no price", and the checkout loses USDT, the currency nearly
 * every payer holds, for the length of one exchange's bad minute. But a single source saying a
 * stablecoin is worth $0.9997 is not a guess; the peg is the second opinion. So for these
 * symbols one fresh observation within `PEG_TOLERANCE_BPS` of the peg is accepted. One that is
 * *not* within it is exactly the depeg a merchant needs to be protected from, and is refused
 * as before.
 */
export const DOLLAR_PEGGED: Readonly<Partial<Record<PriceSymbol, number>>> = { USDT: 1, USDC: 1 };
export const PEG_TOLERANCE_BPS = 100;

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

  /**
   * The last good aggregate, if it is still within the staleness limit.
   *
   * The reason this exists is a currency picker that flickered. Sources fail for a moment —
   * one of two answers a 429, and "two fresh sources needed" is not met — and for that moment
   * `requireRate` threw, the checkout marked BNB unavailable, and the next load had it back. A
   * rate aggregated ninety seconds ago from the same sources is a better answer than "no price"
   * for a payer who is choosing a currency, and it is exactly as old as an observation the
   * aggregator would still accept from a source — `maxStalenessMs` is the one limit for both.
   * Past that limit nothing is served, as before: stale is not a rate, it is a loss waiting.
   */
  private recent(symbol: PriceSymbol, now: number): RateResult | null {
    const window = Math.min(
      this.config.staleFallbackMs ?? 0,
      this.config.aggregation.maxStalenessMs,
    );
    if (window <= 0) return null;
    const cached = this.cache.get(symbol);
    if (!cached) return null;
    if (now - cached.fetchedAt >= window) return null;
    return { ...cached.result, cached: true };
  }

  private async fetchAndAggregate(symbol: PriceSymbol, now: number): Promise<RateResult> {
    if (!this.breakerAllows(symbol, now)) {
      const recent = this.recent(symbol, now);
      if (recent) return recent;
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

    let result = aggregate(observations, this.config.aggregation, now);

    if (!result.ok && result.reason === 'insufficient_sources') {
      const pegged = this.peggedFallback(symbol, observations, now);
      if (pegged) result = pegged;
    }

    if (!result.ok) {
      // The breaker still learns of the failure; a feed that stays down is still suspended.
      this.breaker.recordFailure(symbol, result.reason, now);
      const recent = this.recent(symbol, now);
      if (recent) return recent;
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

  /**
   * One fresh source on a dollar-pegged asset, if it agrees with the peg. See `DOLLAR_PEGGED`.
   */
  private peggedFallback(
    symbol: PriceSymbol,
    observations: readonly SourceObservation[],
    now: number,
  ): ReturnType<typeof aggregate> | null {
    const peg = DOLLAR_PEGGED[symbol];
    if (peg === undefined) return null;
    const pegScaled = rateFromDecimalString(peg.toFixed(6), now).priceScaled;
    const usable = observations.filter((observation) => {
      if (!observation.rate) return false;
      if (now - observation.rate.observedAt > this.config.aggregation.maxStalenessMs) return false;
      const diff = observation.rate.priceScaled - pegScaled;
      const bps = Number(((diff < 0n ? -diff : diff) * 10_000n) / pegScaled);
      return bps <= PEG_TOLERANCE_BPS;
    });
    if (usable.length === 0) return null;
    return aggregate(usable, { ...this.config.aggregation, minSources: 1 }, now);
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

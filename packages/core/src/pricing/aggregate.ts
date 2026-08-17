import type { Rate } from './rate.js';
import { deviationBps } from './rate.js';

/**
 * Combining several price sources into one rate.
 *
 * A single source is never trusted. Not because APIs go down — a failure is easy
 * to notice — but because an API that returns a *wrong number* is not, and a
 * wrong rate silently under-prices every invoice until someone reconciles the
 * books. The median of several sources is resistant to one of them being wrong;
 * comparing the survivors against each other catches the case where they
 * disagree so badly that no answer should be trusted at all.
 */

export interface SourceObservation {
  readonly source: string;
  /** Null when the source failed or returned nothing usable. */
  readonly rate: Rate | null;
  readonly error?: string;
}

export interface AggregationConfig {
  /** Minimum usable sources. Below this, refuse rather than guess. */
  readonly minSources: number;
  /** A source further than this from the median is discarded as an outlier. */
  readonly outlierToleranceBps: number;
  /**
   * If the surviving sources still span more than this, the market is either
   * genuinely dislocated or a source is broken. Either way, no rate is issued.
   */
  readonly maxDispersionBps: number;
  readonly maxStalenessMs: number;
}

export const DEFAULT_AGGREGATION: AggregationConfig = {
  minSources: 2,
  outlierToleranceBps: 200,
  maxDispersionBps: 300,
  maxStalenessMs: 120_000,
};

export type AggregationFailureReason =
  | 'no_sources_responded'
  | 'all_observations_stale'
  | 'insufficient_sources'
  | 'excessive_dispersion';

export interface RejectedSource {
  readonly source: string;
  readonly reason: 'failed' | 'stale' | 'outlier';
  readonly detail?: string;
}

export type AggregationResult =
  | {
      readonly ok: true;
      readonly rate: Rate;
      readonly usedSources: readonly string[];
      readonly rejected: readonly RejectedSource[];
      readonly dispersionBps: number;
    }
  | {
      readonly ok: false;
      readonly reason: AggregationFailureReason;
      readonly detail: string;
      readonly rejected: readonly RejectedSource[];
    };

/** Median of a non-empty list. Even counts average the two middle values. */
export function medianBigInt(values: readonly bigint[]): bigint {
  if (values.length === 0) throw new Error('median of an empty list');
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2n;
}

export function aggregate(
  observations: readonly SourceObservation[],
  config: AggregationConfig = DEFAULT_AGGREGATION,
  now: number = Date.now(),
): AggregationResult {
  const rejected: RejectedSource[] = [];

  const responded = observations.filter((observation) => {
    if (observation.rate === null) {
      rejected.push({
        source: observation.source,
        reason: 'failed',
        ...(observation.error === undefined ? {} : { detail: observation.error }),
      });
      return false;
    }
    return true;
  });

  if (responded.length === 0) {
    return {
      ok: false,
      reason: 'no_sources_responded',
      detail: `all ${observations.length} source(s) failed`,
      rejected,
    };
  }

  // Staleness is checked before anything else. A cached price with no timestamp
  // is precisely how a stale rate becomes an under-priced invoice.
  const fresh = responded.filter((observation) => {
    const age = now - observation.rate!.observedAt;
    if (age > config.maxStalenessMs) {
      rejected.push({
        source: observation.source,
        reason: 'stale',
        detail: `${Math.round(age / 1000)}s old`,
      });
      return false;
    }
    return true;
  });

  if (fresh.length === 0) {
    return {
      ok: false,
      reason: 'all_observations_stale',
      detail: `every observation exceeded ${config.maxStalenessMs}ms`,
      rejected,
    };
  }

  if (fresh.length < config.minSources) {
    return {
      ok: false,
      reason: 'insufficient_sources',
      detail: `${fresh.length} fresh source(s), need ${config.minSources}`,
      rejected,
    };
  }

  // First median is provisional: it only exists to identify outliers.
  const provisional = medianBigInt(fresh.map((observation) => observation.rate!.priceScaled));

  const survivors = fresh.filter((observation) => {
    const deviation = deviationBps(observation.rate!.priceScaled, provisional);
    if (deviation > config.outlierToleranceBps) {
      rejected.push({
        source: observation.source,
        reason: 'outlier',
        detail: `${deviation}bps from median`,
      });
      return false;
    }
    return true;
  });

  if (survivors.length < config.minSources) {
    return {
      ok: false,
      reason: 'insufficient_sources',
      detail:
        `${survivors.length} source(s) within ${config.outlierToleranceBps}bps ` +
        `of the median, need ${config.minSources}`,
      rejected,
    };
  }

  const prices = survivors.map((observation) => observation.rate!.priceScaled);
  const median = medianBigInt(prices);

  const dispersionBps = Math.max(
    ...prices.map((price) => deviationBps(price, median)),
  );

  if (dispersionBps > config.maxDispersionBps) {
    return {
      ok: false,
      reason: 'excessive_dispersion',
      detail:
        `surviving sources span ${dispersionBps}bps, above the ` +
        `${config.maxDispersionBps}bps limit`,
      rejected,
    };
  }

  return {
    ok: true,
    rate: {
      priceScaled: median,
      // The aggregate is only as fresh as its oldest input.
      observedAt: Math.min(...survivors.map((observation) => observation.rate!.observedAt)),
    },
    usedSources: survivors.map((observation) => observation.source),
    rejected,
    dispersionBps,
  };
}

import { RATE_SCALE, type Rate } from '@avex/core';

import type { Database } from '../db/client.js';
import { priceTicks } from '../db/schema.js';

/**
 * Persists price observations.
 *
 * Buffered rather than written inline. `PriceService` emits a tick per source per
 * fetch, and awaiting a database round trip inside the pricing path would put
 * storage latency on every checkout page load. Losing a handful of buffered ticks
 * to a crash is acceptable — they are an audit aid, not a source of truth.
 */

export interface TickRow {
  readonly symbol: string;
  readonly source: string;
  readonly rate: Rate | null;
  readonly error: string | null;
}

export class PriceTickWriter {
  private buffer: TickRow[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Database,
    private readonly flushIntervalMs = 5_000,
    /** Hard cap, so a stuck flush cannot grow the buffer without bound. */
    private readonly maxBuffered = 5_000,
    private readonly log: (message: string) => void = () => {},
  ) {}

  record(tick: TickRow): void {
    if (this.buffer.length >= this.maxBuffered) {
      this.buffer.shift();
    }
    this.buffer.push(tick);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.flushIntervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  async flush(): Promise<number> {
    if (this.buffer.length === 0) return 0;

    const batch = this.buffer;
    this.buffer = [];

    try {
      await this.db.insert(priceTicks).values(
        batch.map((tick) => ({
          symbol: tick.symbol,
          source: tick.source,
          // numeric(78,0) round-trips through strings; BigInt keeps it exact.
          priceScaled: tick.rate ? tick.rate.priceScaled.toString() : null,
          observedAt: tick.rate ? new Date(tick.rate.observedAt) : null,
          error: tick.error,
        })),
      );
      return batch.length;
    } catch (error) {
      // Never resurface: a failed audit write must not break pricing.
      this.log(
        `price tick flush failed, dropping ${batch.length}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      return 0;
    }
  }

  get pending(): number {
    return this.buffer.length;
  }
}

/** Human-readable USD price from a scaled rate, for API responses. */
export function formatRateUsd(rate: Rate, decimalPlaces = 8): string {
  const whole = rate.priceScaled / RATE_SCALE;
  const fraction = rate.priceScaled % RATE_SCALE;
  const digits = RATE_SCALE.toString().length - 1;
  return `${whole}.${fraction.toString().padStart(digits, '0').slice(0, decimalPlaces)}`;
}

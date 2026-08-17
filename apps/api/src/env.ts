import { z } from 'zod';

/**
 * Configuration is validated at boot and never read from `process.env` again.
 * A missing database URL should stop the process immediately, not surface as a
 * confusing error on the first request that happens to touch the database.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().url(),

  /** Public origin, used in verification links. */
  APP_URL: z.string().url().default('http://localhost:3000'),

  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(24 * 14),
  EMAIL_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(60),

  /** Requests per minute per client, before rate limiting kicks in. */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),

  /**
   * Enabled price sources, in no particular order.
   *
   * Configuration rather than code because reachability varies by deployment: an
   * exchange unreachable from where this runs would fail every request and hold
   * the circuit breaker open, blocking invoices for a reason unrelated to the
   * market. Swapping one out must not require a release.
   */
  PRICE_SOURCES: z
    .string()
    .default('coingecko,binance,kraken')
    .transform((value) => value.split(',').map((entry) => entry.trim()).filter(Boolean)),

  /** Usable sources required before a rate is trusted. */
  PRICE_MIN_SOURCES: z.coerce.number().int().min(1).default(2),
  /** A source further than this from the median is discarded. */
  PRICE_OUTLIER_TOLERANCE_BPS: z.coerce.number().int().positive().default(200),
  /** Surviving sources spanning more than this produce no rate at all. */
  PRICE_MAX_DISPERSION_BPS: z.coerce.number().int().positive().default(300),
  PRICE_MAX_STALENESS_MS: z.coerce.number().int().positive().default(120_000),
  PRICE_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(10_000),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

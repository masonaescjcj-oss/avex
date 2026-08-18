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

  /**
   * EVM RPC endpoints, as `chain=url` pairs separated by commas.
   *
   * Several per chain is intended: hosted providers geofence some regions, so a
   * single endpoint is a single point of failure for contract vetting and for
   * every settlement that follows.
   */
  /**
   * Settlement signing key, hex, for development only.
   *
   * `LocalKeyProvider` refuses to hold a key in process memory when NODE_ENV is
   * production, so setting this there fails at startup rather than running with the
   * key in a heap dump. Production supplies a KMS-backed provider instead — the seam
   * is `KeyProvider` in @avex/core.
   */
  SETTLEMENT_KEY_HEX: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),

  /** Fraction of the fee ceiling offered as a tip. Integer basis points internally. */
  SETTLEMENT_PRIORITY_FRACTION: z.coerce.number().min(0).max(1).default(0.1),

  /**
   * Deployed `ForwarderFactory` per chain, as `chain=address` pairs.
   *
   * A chain absent here cannot issue invoices, and that is the safe direction: the
   * deposit address is a hash over this factory, so a wrong or default value would
   * hand payers addresses that no CREATE2 will ever produce.
   */
  FORWARDER_FACTORIES: z
    .string()
    .default('')
    .transform(parsePairs),

  /**
   * Compiled `Forwarder` creation code, hex.
   *
   * Every derived address is a hash over these bytes, so recompiling with different
   * settings changes every address already handed out. It is configuration rather
   * than a build artifact for exactly that reason — the value has to match whatever
   * was deployed, which may predate this build.
   */
  FORWARDER_CREATION_CODE: z
    .string()
    .regex(/^0x[0-9a-fA-F]*$/, 'must be hex')
    .default('0x'),

  /** One wallet per shared-address chain, as `chain=address`. TON today. */
  SHARED_DEPOSIT_WALLETS: z.string().default('').transform(parsePairs),

  /**
   * Where commission is collected, as `chain=address`.
   *
   * Per chain because an address is chain-shaped. A chain missing from here charges
   * no commission at all rather than falling back to another chain's address, which
   * would send the fee somewhere it cannot be received.
   */
  FEE_COLLECTORS: z.string().default('').transform(parsePairs),

  /**
   * Secret behind invoice memos on shared-address chains.
   *
   * A memo has to be unguessable: it is visible to anyone watching the shared wallet,
   * and a predictable one would let a stranger reuse someone else's memo to claim
   * their payment. Defaulted only so development boots; production sets it.
   */
  MEMO_SECRET: z.string().min(16).default('development-memo-secret-do-not-ship'),

  EVM_RPC_URLS: z
    .string()
    .default('bsc=https://bsc-dataseed.binance.org')
    .transform((value) => {
      const map: Record<string, string[]> = {};
      for (const entry of value.split(',')) {
        const [chain, ...rest] = entry.split('=');
        const url = rest.join('=').trim();
        if (!chain || !url) continue;
        (map[chain.trim()] ??= []).push(url);
      }
      return map;
    }),
});

/** `a=1,b=2` into `{a: '1', b: '2'}`. Malformed entries are skipped, not fatal. */
function parsePairs(value: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const entry of value.split(',')) {
    const [key, ...rest] = entry.split('=');
    const parsed = rest.join('=').trim();
    if (!key || !parsed) continue;
    map[key.trim()] = parsed;
  }
  return map;
}

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

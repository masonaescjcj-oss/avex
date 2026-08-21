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

  /**
   * A second connection string that always reaches Postgres directly.
   *
   * Managed Postgres is usually fronted by a transaction-mode pooler, and a transaction
   * pooler cannot run everything: `CREATE TYPE`, advisory locks that must outlive a
   * statement, and `LISTEN` all need a session of their own. Migrations in particular —
   * this schema has enums, and applying one through a transaction pooler fails in a way
   * that reads like a syntax error.
   *
   * Optional, and falls back to `DATABASE_URL`, which is right for a plain Postgres where
   * the two are the same string.
   */
  DIRECT_DATABASE_URL: z.string().url().optional(),

  /**
   * Whether the driver may use prepared statements.
   *
   * Off through a transaction-mode pooler, which hands each statement whichever backend is
   * free — so a statement prepared on one connection is unknown on the next, and the error
   * ("prepared statement \"s1\" does not exist") names nothing that appears in this
   * codebase. Inferred from the URL below; set it explicitly to override.
   */
  DATABASE_PREPARE: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),

  /**
   * Shared secret a scheduler presents to run the background jobs over HTTP.
   *
   * For a deployment with no long-lived process to hold timers in. Absent, the endpoint
   * refuses every request — an unauthenticated way to trigger webhook delivery would let
   * anybody drain the queue at whatever rate they liked.
   */
  CRON_SECRET: z.string().min(24).optional(),

  /**
   * Whether this process should hold the job timers itself.
   *
   * Defaults on, because that is right for a server. Turned off where a scheduler drives
   * the jobs instead, so both are not running them — the lock makes that safe, but a
   * timer firing every ten seconds against a pooled connection it does not need is waste.
   */
  RUN_JOBS_IN_PROCESS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

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

  /**
   * Origins allowed to call the payer-facing checkout routes from a browser.
   *
   * An allowlist rather than `*`, and scoped to `/pay` alone. Those routes take no
   * credentials, so a wildcard there leaks nothing by itself — but the same header on
   * an authenticated route would let any page a merchant visits read their invoices
   * with their own session, so the narrow version is the one worth having.
   *
   * Empty by default, which means no cross-origin browser access at all. A deployment
   * serving the checkout page from the same origin as the API needs nothing here.
   */
  CHECKOUT_ORIGINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((entry) => entry.trim().replace(/\/$/, ''))
        .filter(Boolean),
    ),

  /**
   * Origins allowed to call the authenticated routes from a browser.
   *
   * Needed only when the dashboard is served from a different origin than the API — a static
   * host in front, the API somewhere else. Same-origin deployments leave this empty and get
   * no cross-origin access at all, which is the right default.
   *
   * Every caution in `CHECKOUT_ORIGINS` applies harder here, because these routes *do* take
   * credentials. So: named origins only and never a wildcard, since a wildcard would let any
   * page a signed-in merchant visits read their invoices with their own token. Credentials
   * are still never allowed — the session travels in an `Authorization` header this page
   * sets, not in a cookie a browser would attach on its own, and that difference is what
   * keeps a hostile page from riding along.
   */
  DASHBOARD_ORIGINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((entry) => entry.trim().replace(/\/$/, ''))
        .filter(Boolean),
    ),

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

import { DEFAULT_BUILD_STAMP_FILE } from './build-stamp.js';
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

  /**
   * Where this API answers from the public internet.
   *
   * Separate from `APP_URL`, which is the pages origin. Needed because Telegram has to be
   * told a URL to deliver a bot's updates to, and only this process knows what that is —
   * `APP_URL` would send them to the static site, where nothing would answer.
   *
   * Optional, and its absence is not fatal: everything except connecting a Telegram bot
   * works without it, and a merchant who tries is told plainly that the server has not been
   * given its own address rather than having a broken webhook registered on their behalf.
   */
  PUBLIC_API_URL: z.string().url().optional(),

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
    .default('coingecko,binance,kraken,coinbase,bitstamp')
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
   * How long the last good price may stand in for a source that failed this second.
   *
   * Ninety seconds: inside the two-minute staleness limit the aggregator applies to a source's
   * own observation, so nothing is quoted from a figure the engine would not otherwise accept.
   * What it buys is a currency picker that does not lose BNB for one page load because one of
   * two sources answered 429. Zero turns it off.
   */
  PRICE_STALE_FALLBACK_MS: z.coerce.number().int().nonnegative().default(90_000),

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

  /**
   * A file holding the settlement key, which is the production path.
   *
   * Read once at startup and never again. The intended shape is a systemd encrypted credential:
   * `systemd-creds encrypt` at deploy time, `LoadCredentialEncrypted=` in the unit, and this set
   * to `${CREDENTIALS_DIRECTORY}/settlement-key` — which systemd decrypts into a tmpfs visible
   * only inside that unit's mount namespace. Any readable path works; the point is that it is
   * not an environment variable, which lives in `/proc/<pid>/environ` for the life of the
   * process and in whatever set it.
   *
   * Set this or `SETTLEMENT_KEY_HEX`, never both.
   */
  SETTLEMENT_KEY_FILE: z.string().min(1).optional(),

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
   * Deployed `ForwarderLogic` address per chain, as `chain=address`.
   *
   * Every deposit address is a minimal proxy pointing here, so this address is part of the hash
   * that produces it. Per chain because each chain has its own deployment, and it must be the
   * logic the factory in `FORWARDER_FACTORIES` was constructed with — a mismatched pair derives
   * addresses that factory will never settle.
   *
   * This replaced `FORWARDER_CREATION_CODE`, which carried the compiled bytecode of a forwarder
   * back when each deposit address deployed a full copy of it. Configuration rather than a build
   * artifact for the same reason as before: the value has to match what was deployed, which may
   * predate this build.
   */
  FORWARDER_IMPLEMENTATIONS: z.string().default('').transform(parsePairs),

  /**
   * Where transactional mail goes out, as `smtps://user:pass@host:465`.
   *
   * Unset means nothing is sent: the console transport records and logs every message instead,
   * which is right for development and is a launch blocker in production. `compose` says so at
   * startup rather than leaving it to be discovered by a merchant whose verification mail never
   * arrived.
   *
   * SMTP rather than a provider's HTTP API because it is the transport that works with any
   * provider — including a regional one, which matters here. See `mail/smtp.ts`.
   */
  SMTP_URL: z.string().optional(),

  /**
   * The address these messages come from, and the name beside it.
   *
   * Must be an address the SMTP server is willing to send as, which for every hosted provider
   * means a domain that has been verified with SPF and DKIM. Without those the mail is
   * delivered to spam, which for a verification link is the same as not delivered.
   */
  MAIL_FROM: z.string().email().default('no-reply@avexpay.net'),
  MAIL_FROM_NAME: z.string().default('AVEX Pay'),

  /**
   * Where a critical operational alert goes.
   *
   * The gas wallet running dry, a nonce nothing can get past, a settlement that reverted — the
   * conditions where money has already stopped moving and no merchant will report it, because
   * from their side a payment was received. Unset means they are logged only, which the
   * settlement startup says out loud.
   */
  OPERATOR_EMAIL: z.string().email().optional(),

  /**
   * Where the installer records which commit it built, for `/health` to report.
   *
   * A default rather than a required setting, so an existing deployment picks this up
   * without its `api.env` being touched — that file holds secrets and is deliberately
   * never rewritten by an update. A missing file is not an error: `/health` then answers
   * exactly as it did before, without a build.
   */
  BUILD_STAMP_FILE: z.string().default(DEFAULT_BUILD_STAMP_FILE),

  /**
   * The floor on invoice value, in dollars, where there is no settlement to pay for.
   *
   * The whole of the minimum on TRON and TON. Kept low on purpose — a fifty-cent order on a
   * chain that settles directly costs us nothing to take — and configurable so a real
   * payment can be tested for pennies without editing the fee library.
   */
  MIN_INVOICE_USD: z.coerce.number().nonnegative().default(0.5),

  /**
   * The floor on the chains we do pay to settle, as a ratio: minimum = cost ÷ this.
   *
   * 0.004 is the lowest published commission, which is what makes the floor hold for every
   * merchant rather than only for a new one — the derivation is in `FeePolicyConfig`. Raise
   * it to take small EVM invoices, understanding that it is the margin absorbing a chain
   * that got dearer between pricing an invoice and settling it.
   */
  MIN_INVOICE_FEE_RATIO: z.coerce.number().positive().max(1).default(0.004),

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
   * The key that encrypts secrets we have to be able to read back.
   *
   * One thing uses it today: a merchant's Telegram bot token, which has to be presented to
   * Telegram on every call and so cannot be hashed like every other credential here.
   *
   * Defaulted so development boots, and the default is useless on purpose — a server running
   * on it is a server whose stored tokens are readable by anyone who reads the database.
   * `install.sh` generates a real one and appends it to an existing `api.env` that predates
   * this key, because the installer skips configuration entirely when the file already exists.
   *
   * Losing it loses the tokens: they cannot be recovered, and every merchant would have to
   * connect their bot again. It is worth the same care as the database password.
   */
  TOKEN_ENCRYPTION_KEY: z.string().min(16).default('development-token-key-do-not-ship'),

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

  /**
   * Solana's endpoint, in its own variable because Solana speaks its own RPC.
   *
   * `EVM_RPC_URLS` is where TRON's endpoint lives and that is not a mistake — a TRON node
   * answers `eth_getLogs`. A Solana node answers none of it, and the same map is read by the
   * gas oracle and the contract prober, so a Solana URL in there would give both an endpoint
   * that replies "method not found" to everything they ask.
   *
   * No default, deliberately. The public endpoint exists but is rate-limited to a level that
   * would make a busy poll fail intermittently, and a chain that is quietly on and quietly
   * failing is worse than one that is off until an operator names an endpoint.
   */
  SOLANA_RPC_URLS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((entry) => entry.trim().replace(/\/$/, ''))
        .filter(Boolean),
    ),

  /**
   * TON's indexer, which is not a node and cannot be one.
   *
   * What this system needs to know on TON — what was paid into a wallet and with what comment
   * — is not a question a node answers: a jetton transfer arrives at a contract derived from
   * the wallet and the jetton, and the comment is inside a payload cell. toncenter's v3 index
   * has already done both. `https://toncenter.com/api/v3` is the public one.
   *
   * No default, for the same reason as Solana: the anonymous rate limit is about one request
   * a second, and a chain that is quietly on and quietly failing is worse than one that is
   * off until an operator names an endpoint.
   */
  TON_API_URL: z
    .string()
    .default('')
    .transform((value) => value.trim().replace(/\/$/, '')),

  /** Raises toncenter's rate limit well above the anonymous one. */
  TON_API_KEY: z.string().min(1).optional(),

  EVM_RPC_URLS: z
    .string()
    .default('bsc=https://bsc-rpc.publicnode.com')
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

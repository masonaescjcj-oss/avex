import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Phase 1 schema: identity, organisations, credentials, audit.
 *
 * Two conventions run throughout.
 *
 * Nothing is hard-deleted. Sessions, keys and memberships are revoked with a
 * timestamp instead of removed, because "when did this key stop working" is a
 * question that gets asked during incidents and a deleted row cannot answer it.
 *
 * No secret is stored in recoverable form. Passwords are scrypt hashes; session
 * tokens, email tokens, API keys and recovery codes are SHA-256 hashes. A dump of
 * this database grants an attacker no working credential.
 */

/**
 * Role values are written out here rather than imported from the domain module.
 *
 * The migration tool loads this file through a CommonJS resolver that cannot
 * follow the project's ESM import extensions, and a schema that pulls in
 * application code would drag half the app into every migration run. The
 * duplication is guarded by a test that fails if the two lists diverge — see
 * schema.test.ts. Order is fixed: changing it rewrites the Postgres enum.
 */
export const ROLE_VALUES = ['owner', 'admin', 'developer', 'viewer'] as const;

export const roleEnum = pgEnum('role', ROLE_VALUES);
export const apiKeyModeEnum = pgEnum('api_key_mode', ['test', 'live']);
export const emailTokenPurposeEnum = pgEnum('email_token_purpose', [
  'verify_email',
  'reset_password',
  'confirm_sensitive_change',
]);

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set by an AVEX operator; blocks all money movement while present. */
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    suspendedReason: text('suspended_reason'),
  },
  (table) => [uniqueIndex('organizations_slug_key').on(table.slug)],
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    passwordHash: text('password_hash').notNull(),
    /** Base32 shared secret. Present once enrolment starts, before confirmation. */
    totpSecret: text('totp_secret'),
    /** Only a confirmed enrolment counts as two-factor being active. */
    totpEnabledAt: timestamp('totp_enabled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('users_email_key').on(table.email)],
);

export const recoveryCodes = pgTable(
  'recovery_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (table) => [index('recovery_codes_user_idx').on(table.userId)],
);

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: roleEnum('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('memberships_org_user_key').on(table.organizationId, table.userId),
    index('memberships_user_idx').on(table.userId),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    /**
     * When the second factor was last proven. Elevated actions require this to be
     * recent, so a stolen session alone cannot move a payout address.
     */
    mfaSatisfiedAt: timestamp('mfa_satisfied_at', { withTimezone: true }),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_key').on(table.tokenHash),
    index('sessions_user_idx').on(table.userId),
  ],
);

export const emailTokens = pgTable(
  'email_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    purpose: emailTokenPurposeEnum('purpose').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('email_tokens_token_hash_key').on(table.tokenHash),
    index('email_tokens_user_purpose_idx').on(table.userId, table.purpose),
  ],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    mode: apiKeyModeEnum('mode').notNull(),
    /** Leading segment, in the clear, so a key can be identified without being held. */
    displayPrefix: text('display_prefix').notNull(),
    tokenHash: text('token_hash').notNull(),
    /** Permission subset this key may exercise; never wider than its creator's role. */
    scopes: jsonb('scopes').$type<string[]>().notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('api_keys_token_hash_key').on(table.tokenHash),
    index('api_keys_org_idx').on(table.organizationId),
  ],
);

/**
 * Append-only record of every action that changes configuration or moves money.
 *
 * Nothing in the application updates or deletes a row here. When a merchant asks
 * why their payout address changed, this is the only answer that can be trusted.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'set null',
    }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actorApiKeyId: uuid('actor_api_key_id').references(() => apiKeys.id, {
      onDelete: 'set null',
    }),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    /** Before/after values and request context. Never credentials. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_log_org_created_idx').on(table.organizationId, table.createdAt),
    index('audit_log_actor_idx').on(table.actorUserId),
  ],
);

/**
 * Changes that take effect after a delay instead of immediately.
 *
 * Built generically in Phase 1 and used first in Phase 4 for payout addresses.
 * The delay is the protection: it turns a silent redirect of a merchant's revenue
 * into something they have a window to notice and cancel.
 */
export const pendingChanges = pgTable(
  'pending_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    requestedByUserId: uuid('requested_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledByUserId: uuid('cancelled_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [index('pending_changes_org_effective_idx').on(table.organizationId, table.effectiveAt)],
);

/**
 * Phase 2: pricing.
 *
 * Convention for large integers: stored as `numeric(78, 0)`, which is exact and
 * orderable, and converted with `BigInt(...)` at the repository boundary. Postgres
 * `bigint` is too narrow — an 18-decimal token amount overflows 2^63 at 9.2
 * tokens — and `text` would sort lexicographically, making "10" precede "9".
 */

export const pricingModeEnum = pgEnum('pricing_mode', ['fiat', 'token', 'fixed_rate']);

/**
 * Every observation from every source, successes and failures alike.
 *
 * The failures matter as much as the prices: reconstructing why a quote was
 * refused, or why a breaker opened, is impossible from successes alone.
 */
export const priceTicks = pgTable(
  'price_ticks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    symbol: text('symbol').notNull(),
    source: text('source').notNull(),
    /** USD per whole unit, scaled by 1e18. Null when the source failed. */
    priceScaled: numeric('price_scaled', { precision: 78, scale: 0 }),
    /** When the source observed it, not when we stored it. */
    observedAt: timestamp('observed_at', { withTimezone: true }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('price_ticks_symbol_created_idx').on(table.symbol, table.createdAt)],
);

/**
 * A locked price. Created before an invoice and referenced by it, so the rate a
 * payer was shown is recoverable long after the market has moved.
 */
export const quotes = pgTable(
  'quotes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    chain: text('chain').notNull(),
    assetSymbol: text('asset_symbol').notNull(),
    assetContract: text('asset_contract'),
    assetDecimals: text('asset_decimals').notNull(),

    mode: pricingModeEnum('mode').notNull(),
    /** What the payer must send, in the asset's smallest unit. */
    amountDue: numeric('amount_due', { precision: 78, scale: 0 }).notNull(),
    /** Observed market rate before the spread. Null in `token` mode. */
    marketRateScaled: numeric('market_rate_scaled', { precision: 78, scale: 0 }),
    /** Rate actually applied. Null in `token` mode, where nothing was converted. */
    effectiveRateScaled: numeric('effective_rate_scaled', { precision: 78, scale: 0 }),
    spreadBps: text('spread_bps').notNull(),
    /** Fiat value in micro-dollars. Null in `token` mode with no rate available. */
    amountFiatMicros: numeric('amount_fiat_micros', { precision: 78, scale: 0 }),
    /** Which sources backed the rate, for later dispute resolution. */
    sources: jsonb('sources').$type<string[]>().notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set when an invoice is opened against this quote. */
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (table) => [
    index('quotes_org_created_idx').on(table.organizationId, table.createdAt),
    index('quotes_expires_idx').on(table.expiresAt),
  ],
);

/**
 * Phase 3: the asset catalogue.
 *
 * Two layers. `assets` is the global catalogue — curated entries plus contracts
 * merchants submitted and a reviewer accepted. `merchant_assets` is what a given
 * merchant has actually switched on, with their pricing choice for it.
 *
 * The separation matters because approval and enablement are different decisions
 * made by different people: AVEX decides a contract is safe to credit at all, and
 * a merchant decides whether they want to accept it.
 */

export const assetVerdictEnum = pgEnum('asset_verdict', ['blocked', 'review', 'approved']);
export const assetKindEnum = pgEnum('asset_kind', ['native', 'erc20', 'trc20', 'spl', 'jetton']);

export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chain: text('chain').notNull(),
    symbol: text('symbol').notNull(),
    /** Null for a chain's native asset. */
    contract: text('contract'),
    decimals: integer('decimals').notNull(),
    kind: assetKindEnum('kind').notNull(),

    /** On the hand-verified global list; the only route to automatic approval. */
    curated: boolean('curated').notNull().default(false),
    verdict: assetVerdictEnum('verdict').notNull(),
    /** No price source can quote this, so the merchant must supply a rate. */
    requiresFixedRate: boolean('requires_fixed_rate').notNull().default(false),

    /** The full probe output, kept so a decision can be re-examined later. */
    findings: jsonb('findings').$type<unknown[]>(),
    probedAt: timestamp('probed_at', { withTimezone: true }),

    /** Null for curated entries; set when a merchant submitted the contract. */
    submittedByOrganizationId: uuid('submitted_by_organization_id').references(
      () => organizations.id,
      { onDelete: 'set null' },
    ),
    reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewNote: text('review_note'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('assets_chain_contract_key').on(table.chain, table.contract),
    // Postgres treats NULLs as distinct, so the index above would permit several
    // native assets per chain. This one closes that gap.
    uniqueIndex('assets_chain_native_key')
      .on(table.chain)
      .where(sql`${table.contract} is null`),
    index('assets_verdict_idx').on(table.verdict),
  ],
);

export const merchantAssets = pgTable(
  'merchant_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),

    enabled: boolean('enabled').notNull().default(true),
    pricingMode: pricingModeEnum('pricing_mode').notNull(),

    /** Merchant-set rate, scaled by 1e18. Required when pricing mode is fixed_rate. */
    fixedRateScaled: numeric('fixed_rate_scaled', { precision: 78, scale: 0 }),
    /**
     * When the merchant's rate stops being usable.
     *
     * A fixed rate with no expiry is a rate nobody revisits, and a stale one
     * silently misprices every invoice — so it is required rather than optional.
     */
    fixedRateValidUntil: timestamp('fixed_rate_valid_until', { withTimezone: true }),

    spreadBps: integer('spread_bps').notNull().default(50),
    /**
     * Accepted deviation from the invoiced amount. Raised above the default for a
     * fee-on-transfer token, which delivers less than was sent and would otherwise
     * make every payment read as underpaid.
     */
    toleranceBps: integer('tolerance_bps').notNull().default(50),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('merchant_assets_org_asset_key').on(table.organizationId, table.assetId),
    index('merchant_assets_org_idx').on(table.organizationId),
  ],
);

/**
 * Phase 4: where settled funds go.
 *
 * Addresses are never updated in place and never deleted. A replacement inserts a
 * new row and marks the old one superseded, because "which address was active when
 * this invoice settled" is a question that gets asked during a dispute, and an
 * overwritten column cannot answer it.
 */
export const payoutAddresses = pgTable(
  'payout_addresses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    chain: text('chain').notNull(),
    address: text('address').notNull(),

    activeFrom: timestamp('active_from', { withTimezone: true }).notNull().defaultNow(),
    /** Set when a replacement takes effect. Null means currently active. */
    supersededAt: timestamp('superseded_at', { withTimezone: true }),

    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** The delayed change this address came from, if it was not the first. */
    pendingChangeId: uuid('pending_change_id').references(() => pendingChanges.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // At most one active address per chain. A partial index, because superseded
    // rows must be allowed to accumulate for the audit trail.
    uniqueIndex('payout_addresses_active_key')
      .on(table.organizationId, table.chain)
      .where(sql`${table.supersededAt} is null`),
    index('payout_addresses_org_idx').on(table.organizationId),
  ],
);

// ── Invoices and observed payments ────────────────────────────────────────────

export const invoiceStatusEnum = pgEnum('invoice_status', [
  'pending',
  'confirming',
  'paid',
  'underpaid',
  'overpaid',
  'expired',
]);

export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'restrict' }),
    quoteId: uuid('quote_id').references(() => quotes.id, { onDelete: 'set null' }),

    /** Merchant's own reference, for reconciliation on their side. */
    reference: text('reference'),

    amountDue: numeric('amount_due', { precision: 78, scale: 0 }).notNull(),
    /** Recomputed from credited payments, never incremented blindly. */
    amountPaid: numeric('amount_paid', { precision: 78, scale: 0 }).notNull().default('0'),
    status: invoiceStatusEnum('status').notNull().default('pending'),

    chain: text('chain').notNull(),
    /**
     * Where the payer sends. On EVM chains this is the CREATE2 forwarder, whose
     * address commits to `payoutAddress` — so the two cannot drift apart.
     */
    depositAddress: text('deposit_address').notNull(),
    /** Present only on shared-address chains, where it identifies the invoice. */
    memo: text('memo'),
    /** Captured at creation: the address active then, not whatever is active now. */
    payoutAddress: text('payout_address').notNull(),

    toleranceBps: integer('tolerance_bps').notNull().default(50),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (table) => [
    // The watcher matches an arriving transfer by address, so this must be fast
    // and must not collide across merchants.
    uniqueIndex('invoices_chain_deposit_key').on(table.chain, table.depositAddress),
    index('invoices_org_created_idx').on(table.organizationId, table.createdAt),
    index('invoices_status_idx').on(table.status),
    index('invoices_chain_memo_idx').on(table.chain, table.memo),
  ],
);

/**
 * Every transfer the watcher has credited.
 *
 * The unique key is the idempotency guarantee: a transfer is identified by where
 * it happened, not by when we noticed. Watchers rescan overlapping ranges after a
 * restart and RPC providers replay logs, so without this a merchant gets paid
 * twice for one payment.
 */
export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),

    chain: text('chain').notNull(),
    txHash: text('tx_hash').notNull(),
    /** Position within the transaction; one transaction can carry many transfers. */
    transferIndex: integer('transfer_index').notNull(),

    amount: numeric('amount', { precision: 78, scale: 0 }).notNull(),
    blockNumber: integer('block_number').notNull(),
    blockHash: text('block_hash'),
    /** The payer's address, needed to offer a refund anywhere sensible. */
    fromAddress: text('from_address'),

    creditedAt: timestamp('credited_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set when a reorg removed the transaction and the credit was withdrawn. */
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reversedReason: text('reversed_reason'),
  },
  (table) => [
    uniqueIndex('payments_identity_key').on(table.chain, table.txHash, table.transferIndex),
    index('payments_invoice_idx').on(table.invoiceId),
    // Rewinding a reorg needs every payment above a block height.
    index('payments_chain_block_idx').on(table.chain, table.blockNumber),
  ],
);

// ── Watcher state ─────────────────────────────────────────────────────────────

/**
 * How far each chain has been scanned.
 *
 * Persisted so a restart resumes instead of rescanning from genesis, and so two
 * instances cannot silently disagree about progress.
 */
export const watchCursors = pgTable('watch_cursors', {
  chain: text('chain').primaryKey(),
  cursor: text('cursor'),
  /** Highest block whose contents have been credited. */
  scannedTo: integer('scanned_to'),
  lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
  lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
  lastError: text('last_error'),
});

/**
 * Recent block hashes per chain, kept only deep enough to spot a reorg.
 *
 * A reorg is detected by a block we already scanned reporting a different hash.
 * Without this, a transaction that vanished from the canonical chain stays
 * credited, and the merchant has been paid for a payment that no longer exists.
 */
export const seenBlocks = pgTable(
  'seen_blocks',
  {
    chain: text('chain').notNull(),
    number: integer('number').notNull(),
    hash: text('hash').notNull(),
    seenAt: timestamp('seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('seen_blocks_key').on(table.chain, table.number),
    index('seen_blocks_chain_number_idx').on(table.chain, table.number),
  ],
);

// ── Webhooks ──────────────────────────────────────────────────────────────────

export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    /** Signing secret, shown once at creation. Stored hashed is not an option —
     *  we must be able to sign with it — so this is the one recoverable secret,
     *  and it grants nothing beyond forging our own callbacks to the merchant. */
    secret: text('secret').notNull(),
    events: jsonb('events').$type<string[]>().notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    disabledReason: text('disabled_reason'),
  },
  (table) => [index('webhook_endpoints_org_idx').on(table.organizationId)],
);

export const webhookDeliveryStatusEnum = pgEnum('webhook_delivery_status', [
  'pending',
  'delivered',
  'failed',
  'abandoned',
]);

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    event: text('event').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    /**
     * Stable across retries, so a merchant can discard a duplicate they already
     * processed. Retrying is safe for us and must be safe for them too.
     */
    idempotencyKey: text('idempotency_key').notNull(),

    status: webhookDeliveryStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastStatusCode: integer('last_status_code'),
    lastError: text('last_error'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('webhook_deliveries_idempotency_key').on(
      table.endpointId,
      table.idempotencyKey,
    ),
    index('webhook_deliveries_due_idx').on(table.status, table.nextAttemptAt),
    index('webhook_deliveries_org_idx').on(table.organizationId, table.createdAt),
  ],
);

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
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

/** Mirrors `STAFF_ROLES` in domain/staff-rbac.ts; the same test guards the pair. */
export const STAFF_ROLE_VALUES = ['support', 'operator', 'superadmin'] as const;

export const roleEnum = pgEnum('role', ROLE_VALUES);
export const staffRoleEnum = pgEnum('staff_role', STAFF_ROLE_VALUES);
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

// ── Phase 6: AVEX staff, for the admin panel ─────────────────────────────────

/**
 * Platform staff. A separate table from `users`, on purpose.
 *
 * A staff member acts across every merchant, so their credential is a different
 * kind of thing from a merchant login and is kept apart from it. The practical
 * consequences: a phished merchant password grants nothing here, one person can
 * hold both a merchant account and a staff account under the same email without
 * colliding, and the two live behind different origins and different cookies.
 *
 * Two differences from `users` are deliberate rather than incidental.
 * `totpEnabledAt` is what a login checks rather than an optional extra — staff
 * without a second factor cannot sign in at all. And there is no self-service
 * signup path anywhere in the API: a row here is created by an existing superadmin,
 * or by the bootstrap command when there are none.
 */
export const staff = pgTable(
  'staff',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: staffRoleEnum('role').notNull(),
    /** Base32 shared secret, present from the moment enrolment starts. */
    totpSecret: text('totp_secret'),
    /** Mandatory: a staff account cannot complete a login until this is set. */
    totpEnabledAt: timestamp('totp_enabled_at', { withTimezone: true }),
    createdByStaffId: uuid('created_by_staff_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Revocation, never deletion — "who did this in March" must stay answerable. */
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    disabledReason: text('disabled_reason'),
  },
  (table) => [uniqueIndex('staff_email_key').on(table.email)],
);

export const staffSessions = pgTable(
  'staff_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    staffId: uuid('staff_id')
      .notNull()
      .references(() => staff.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    mfaSatisfiedAt: timestamp('mfa_satisfied_at', { withTimezone: true }),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('staff_sessions_token_hash_key').on(table.tokenHash),
    index('staff_sessions_staff_idx').on(table.staffId),
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
    /**
     * Set when the actor was AVEX staff rather than someone inside the merchant.
     *
     * A merchant reading their own audit trail needs to be able to tell "we changed
     * this" from "AVEX changed this", and the actor columns are the only place that
     * distinction can live.
     */
    actorStaffId: uuid('actor_staff_id').references(() => staff.id, { onDelete: 'set null' }),
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
    index('audit_log_staff_idx').on(table.actorStaffId),
    // The admin panel's search is cross-merchant and newest-first, which the
    // org-scoped index above cannot serve.
    index('audit_log_created_idx').on(table.createdAt),
    index('audit_log_action_idx').on(table.action),
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

/**
 * Whether an object is real money or a rehearsal.
 *
 * A merchant integrating needs to drive their own code end to end — create a payment,
 * see the webhook, mark the order shipped — without moving funds. So test objects are
 * first-class rather than a separate sandbox deployment, and the mode travels on the
 * row.
 *
 * Everything that follows from that is about keeping the two apart. A test invoice gets
 * no real deposit address, is never settled, and is excluded from every figure that
 * decides money: the merchant's volume report and the commission assessment. A merchant
 * able to inflate their assessed volume with test data would be able to choose their own
 * commission tier.
 */
export const objectModeEnum = pgEnum('object_mode', ['test', 'live']);

/**
 * Who the commission is charged to.
 *
 * The forwarder always takes its cut out of what arrives, so this is not a choice about
 * how the money moves — it is a choice about what the invoice asks for. `merchant` asks
 * for the price and settles less the commission. `payer` asks for enough that the split
 * leaves the merchant the full price.
 *
 * `merchant` is the default because it is the option that cannot surprise a payer.
 */
export const feePayerEnum = pgEnum('fee_payer', ['merchant', 'payer']);

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
export const assetKindEnum = pgEnum('asset_kind', [
  'native',
  'erc20',
  'trc20',
  'spl',
  'jetton',
  /**
   * Telegram Stars, which are not a token on any chain.
   *
   * Included because merchants selling inside Telegram want one set of orders and one
   * webhook stream, not two. What AVEX can honestly offer for Stars is narrower than for
   * crypto, and the narrowness is structural rather than a gap to fill later — see
   * `telegram_payments` below.
   */
  'stars',
]);

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

    /**
     * Whether the platform is offering this asset right now.
     *
     * Deliberately separate from `verdict`, because the two answer different questions and
     * collapsing them would make one of the answers a lie. `verdict` is about the contract:
     * is this the real USDT, does it behave like a token, can it be trusted. `listed` is
     * about us: is our adapter for that chain deployed, is the price feed healthy, do we
     * want to be taking this today.
     *
     * Solana's USDC mint is a perfectly good contract whether or not our Solana watcher is
     * running. Turning it off by setting `verdict` to `blocked` would record a judgement
     * about Circle that we do not hold, and would show a merchant a reason that is not the
     * real one.
     *
     * Unlisting stops new invoices. It does not touch invoices already open: their deposit
     * addresses are already committed and a payer may be mid-transfer.
     */
    listed: boolean('listed').notNull().default(true),
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
    /**
     * Who reviewed it, now that reviewing happens in the admin panel.
     *
     * `reviewedByUserId` is kept rather than migrated: it holds real history from
     * before staff existed as a separate identity, and rewriting it would replace a
     * true record with a guess about which staff account corresponds to which user.
     */
    reviewedByStaffId: uuid('reviewed_by_staff_id').references(() => staff.id, {
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

    /**
     * Test or live. Taken from the credential that created the invoice, never from the
     * request body alone — a test key must not be able to mint a live invoice.
     */
    mode: objectModeEnum('mode').notNull().default('live'),

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

    /**
     * The percentage cut to take when this invoice is swept, fixed at creation.
     *
     * Snapshotted for the same reason `payoutAddress` is, only more sharply: on EVM
     * chains the fee is a constructor argument to the forwarder, so it is part of
     * the init code that produced `deposit_address`. Settling with a different fee
     * derives a *different* address, which no payer funded, and the money would stay
     * in the forwarder with nothing able to reach it. Changing our pricing must
     * therefore never reach an invoice already quoted.
     *
     * Zero — the case for a merchant on a negotiated 0% rate, and for every Stars
     * record, where there is nothing on chain to take a cut of — means the merchant
     * receives the whole balance.
     */
    feeBps: integer('fee_bps').notNull().default(0),
    /** Null whenever `fee_bps` is zero: there is nowhere for nothing to go. */
    feeDestination: text('fee_destination'),
    /**
     * Who the commission was charged to, snapshotted for the same reason as the rate.
     *
     * Load-bearing rather than informational: when this is `payer`, `amount_due` was
     * grossed up so the split leaves the merchant the price they asked for. The gross-up
     * is baked into `amount_due` and cannot be recovered from it — the same 20.1 USDT
     * could be a payer-paid $20 invoice or a merchant-paid $20.1 one — so without this
     * column nothing could later explain the figure to a merchant disputing it.
     */
    feePayer: feePayerEnum('fee_payer').notNull().default('merchant'),

    toleranceBps: integer('tolerance_bps').notNull().default(50),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (table) => [
    /**
     * What must be unique differs by address model, so the indexes are partial.
     *
     * On a unique-address chain the address *is* the invoice's identity: the watcher
     * matches an arriving transfer by it, so two invoices sharing one address would
     * make an incoming payment ambiguous. Hence unique — but only where there is no
     * memo.
     *
     * On a shared-address chain every invoice has the same deposit address by design,
     * and the memo is what distinguishes them. A blanket unique index on (chain,
     * address) makes those chains unusable after their very first invoice, which is
     * exactly what it did until a TON test caught it.
     */
    uniqueIndex('invoices_chain_deposit_key')
      .on(table.chain, table.depositAddress)
      .where(sql`${table.memo} is null`),
    /**
     * And the memo carries the same weight there that the address does elsewhere: two
     * invoices on one shared wallet with the same memo could not be told apart, so a
     * payment would be credited to whichever was found first.
     */
    uniqueIndex('invoices_chain_memo_key')
      .on(table.chain, table.memo)
      .where(sql`${table.memo} is not null`),
    index('invoices_org_created_idx').on(table.organizationId, table.createdAt),
    // Volume, billing and reports all filter on mode, and each of them scans a
    // merchant's history rather than a single row.
    index('invoices_org_mode_idx').on(table.organizationId, table.mode),
    index('invoices_status_idx').on(table.status),

    /**
     * One invoice per merchant reference — the property that makes a retry safe.
     *
     * A merchant retrying "invoice for order #1234" after a timeout must get the same
     * invoice back, not a second one with a second deposit address. Checking for an
     * existing row first is not enough on its own: two simultaneous retries both find
     * nothing and both insert. This index is what turns the second insert into a
     * conflict the service can resolve by returning the first one.
     *
     * Partial, because a reference is optional and many rows without one must not
     * collide with each other.
     */
    uniqueIndex('invoices_org_reference_key')
      .on(table.organizationId, table.reference)
      .where(sql`${table.reference} is not null`),

    /**
     * The fee invariants, enforced here rather than only in application code.
     *
     * Both mirror a `revert` in Forwarder.sol. A row that violates either one
     * describes a forwarder that cannot be deployed, so the invoice would take a
     * payment to an address whose contract can never exist — the funds would be
     * unreachable. That is not a state worth being able to represent, and the
     * database is the one layer every write path goes through.
     */
    check('invoices_fee_bps_ceiling', sql`${table.feeBps} between 0 and 500`),
    check(
      'invoices_fee_has_destination',
      sql`${table.feeBps} = 0 or ${table.feeDestination} is not null`,
    ),
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
export const paymentValueSourceEnum = pgEnum('payment_value_source', [
  /** From the rate locked on the invoice's own quote — our figure, at the time. */
  'quote',
  /** From our price oracle at credit time. */
  'oracle',
  /** From a rate the merchant set for an asset nobody else prices. Unverifiable. */
  'merchant_rate',
  /** No price was available at all. Counts as nothing, and is visible as such. */
  'unknown',
  /**
   * Reported by the merchant's own server, with nothing of ours confirming it.
   *
   * Telegram Stars are the case. The payment happens between the customer and the
   * merchant's bot, so there is no chain to read and no address to watch — the merchant
   * tells us, authenticated with their API key, and that is the whole of the evidence.
   *
   * Kept distinct from `quote` and `oracle` because a merchant reporting their own volume
   * can shift themselves into a cheaper commission tier. Counting it while labelling it is
   * the same trade as `merchant_rate`: prevention is not available, so detection is.
   */
  'self_reported',
]);

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

    /**
     * What this transfer was worth in micro-dollars when it was credited.
     *
     * Recorded rather than recomputed, because the value of a payment is a fact about
     * the moment it arrived. Valuing last month's volume at today's price would make a
     * merchant's free-tier eligibility move with the market after the fact.
     */
    valueUsdMicros: numeric('value_usd_micros', { precision: 78, scale: 0 }),
    /**
     * Where that figure came from, which decides how much it can be trusted.
     *
     * A merchant setting their own `fixed_rate` is declaring a value we cannot check,
     * and a merchant who wants to stay under a volume threshold has an obvious reason
     * to declare it low. Keeping the provenance means the billing rule can count
     * verified volume and merely *flag* declared volume, rather than treating a
     * self-reported number as fact.
     */
    valueSource: paymentValueSourceEnum('value_source'),

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

/**
 * Transfers that arrived but belong to no invoice.
 *
 * `payments.invoice_id` is `not null`, so a transfer with no home cannot be
 * recorded there — and dropping it means a payer is out of pocket with nothing in
 * the system to show it. This table is where those land, and reconciling them is a
 * Tier 1 admin feature because every row is a person waiting for an answer.
 *
 * The identity key is the same `(chain, tx_hash, transfer_index)` triple the
 * payments table uses, which buys two things at once. Re-scanning a block range
 * cannot duplicate a row here, and because `payments` carries the same unique key,
 * an operator cannot attach one transfer to two different invoices — the second
 * insert fails on the constraint rather than on a reviewer noticing.
 */
export const unmatchedReasonEnum = pgEnum('unmatched_reason', [
  /** Nothing in `invoices` claims this deposit address. */
  'no_matching_address',
  /** A shared-address chain and the payer omitted the memo. */
  'memo_missing',
  /** The address is known but the token sent is not the one invoiced. */
  'wrong_asset',
  /** Matched an invoice that had already expired. */
  'invoice_expired',
  /** Below the amount at which settling is economic. */
  'below_minimum',
]);

export const unmatchedResolutionEnum = pgEnum('unmatched_resolution', [
  'pending',
  /** Credited to an invoice by an operator. */
  'attached',
  /** Marked for sending back to the payer. */
  'returned',
  /** Deliberately left alone, with a reason recorded. */
  'ignored',
]);

export const unmatchedPayments = pgTable(
  'unmatched_payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    chain: text('chain').notNull(),
    txHash: text('tx_hash').notNull(),
    transferIndex: integer('transfer_index').notNull(),

    amount: numeric('amount', { precision: 78, scale: 0 }).notNull(),
    /** Null when the token itself is not in the catalogue. */
    assetId: uuid('asset_id').references(() => assets.id, { onDelete: 'set null' }),
    /** Recorded even when unknown, because it is the only clue to the token. */
    contract: text('contract'),

    toAddress: text('to_address').notNull(),
    /** The payer, and the only address a return could sensibly go to. */
    fromAddress: text('from_address'),
    memo: text('memo'),
    blockNumber: integer('block_number').notNull(),

    reason: unmatchedReasonEnum('reason').notNull(),
    resolution: unmatchedResolutionEnum('resolution').notNull().default('pending'),

    /** Set when an operator attached this to an invoice. */
    attachedInvoiceId: uuid('attached_invoice_id').references(() => invoices.id, {
      onDelete: 'set null',
    }),
    resolvedByStaffId: uuid('resolved_by_staff_id').references(() => staff.id, {
      onDelete: 'set null',
    }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    note: text('note'),

    seenAt: timestamp('seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('unmatched_identity_key').on(table.chain, table.txHash, table.transferIndex),
    // The queue view is "everything still unresolved, oldest first".
    index('unmatched_resolution_idx').on(table.resolution, table.seenAt),
    // Reconciliation starts from an address a merchant asks about.
    index('unmatched_to_address_idx').on(table.chain, table.toAddress),
  ],
);

/**
 * Every settlement transaction we have broadcast.
 *
 * Until now the runner held its in-flight transactions in memory only, which has a
 * consequence beyond the admin panel being unable to show them: after a restart
 * nothing knows a transaction is outstanding at a given nonce, so a stuck
 * transaction can neither be found nor replaced. Persisting it is what makes the
 * pipeline recoverable, and the monitor is a by-product.
 */
export const settlementStatusEnum = pgEnum('settlement_status', [
  'pending',
  'confirmed',
  /** Mined and failed. Never retried — see SettlementRunner. */
  'reverted',
  /** Superseded by another transaction at the same nonce. */
  'replaced',
]);

export const settlements = pgTable(
  'settlements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chain: text('chain').notNull(),
    txHash: text('tx_hash').notNull(),
    /** The nonce this occupies. Two pending rows sharing one is a bug worth seeing. */
    nonce: integer('nonce').notNull(),

    /** Which invoices this batch flushes. */
    invoiceIds: jsonb('invoice_ids').$type<string[]>().notNull(),

    feePerGasWei: numeric('fee_per_gas_wei', { precision: 78, scale: 0 }).notNull(),
    gasLimit: numeric('gas_limit', { precision: 78, scale: 0 }).notNull(),
    gasUsed: numeric('gas_used', { precision: 78, scale: 0 }),
    /** Estimated at broadcast, in micro-dollars; the actual cost on confirmation. */
    estimatedCostUsdMicros: numeric('estimated_cost_usd_micros', { precision: 78, scale: 0 }),
    actualCostUsdMicros: numeric('actual_cost_usd_micros', { precision: 78, scale: 0 }),

    status: settlementStatusEnum('status').notNull().default('pending'),
    replacedByTxHash: text('replaced_by_tx_hash'),

    broadcastAt: timestamp('broadcast_at', { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('settlements_chain_tx_key').on(table.chain, table.txHash),
    index('settlements_chain_status_idx').on(table.chain, table.status),
    // Finding what occupies a nonce is the first question when the pipeline stalls.
    index('settlements_chain_nonce_idx').on(table.chain, table.nonce),
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

// ── Phase 7: commission ──────────────────────────────────────────────────────

/**
 * What a merchant pays AVEX: a percentage of what flows through the gateway.
 *
 * One row per merchant, and nothing in it is a bill. There is no monthly fee, no
 * invoice we raise against a merchant and no state in which we owe each other money —
 * the commission is taken on chain, by the forwarder, at the moment a payment is swept.
 * That is the whole billing relationship, and it is why this table has no status column:
 * a merchant cannot fall behind on a fee that is deducted from the money as it moves.
 *
 * What the row is *for* is the rate and the window used to review it. The published
 * ladder moves a merchant between rungs on their monthly volume, so something has to
 * remember which month is being measured.
 */
export const feePlans = pgTable(
  'fee_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    /**
     * The commission this merchant pays, in basis points.
     *
     * Bounded by the same 500bps ceiling as the forwarder, because a rate this column
     * cannot deliver on chain is not a rate at all — an invoice carrying it would take
     * a payment and then revert when swept.
     */
    feeBps: integer('fee_bps').notNull().default(50),
    /**
     * Set when a human chose this rate rather than the volume ladder producing it.
     *
     * Without it the ladder would overwrite every negotiated rate at the next period,
     * which would make each negotiation silently temporary — the worst of both, since
     * nobody would find out until the merchant looked at their next settlement.
     */
    negotiatedFee: boolean('negotiated_fee').notNull().default(false),

    /**
     * This merchant's default answer to who bears the commission.
     *
     * A default rather than a rule, because a merchant who normally passes the fee on
     * still has orders where they would rather absorb it — a refund top-up, a complaint,
     * a customer they want to keep. So each invoice may override it, and each invoice
     * records what it used.
     */
    feePayer: feePayerEnum('fee_payer').notNull().default('merchant'),

    /**
     * The volume period currently being measured.
     *
     * A closed period rather than a rolling window, because "you processed $61,000 in
     * July, so August is 0.45%" is a statement a merchant can check against their own
     * records. A trailing thirty days as of whenever a job happened to run is not.
     */
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One plan per merchant. Two would mean two answers to "what do they pay".
    uniqueIndex('fee_plans_org_key').on(table.organizationId),

    // The forwarder reverts above 500bps, so a plan carrying more than that could
    // never produce a settleable invoice.
    check('fee_plans_fee_bps_ceiling', sql`${table.feeBps} between 0 and 500`),
  ],
);

export const checkoutSessionStatusEnum = pgEnum('checkout_session_status', [
  /** Created, and the payer has not chosen a currency yet. */
  'open',
  /** A currency was chosen and an invoice exists. */
  'selected',
  /** The chosen invoice was paid. */
  'paid',
  /** Nobody chose in time. */
  'expired',
  /** Withdrawn by the merchant before payment. */
  'cancelled',
]);

/**
 * A payment the merchant has asked for, before the payer has chosen how to pay it.
 *
 * The piece that makes a hosted checkout possible. A merchant knows the fiat amount
 * they want; only the payer knows which coin they hold. An invoice cannot be created
 * until that is decided, because the amount, the chain and the deposit address all
 * follow from the asset — so something has to exist in between, and this is it.
 *
 * The session is what a payer's link points at. It is deliberately thin: the money,
 * the reference and a deadline. Everything about how the payment is actually made
 * lives on the invoice created once a currency is picked.
 */
export const checkoutSessions = pgTable(
  'checkout_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    /** The merchant's own order id. Doubles as the idempotency key, as on invoices. */
    reference: text('reference'),
    /** What the merchant is charging, in micro-dollars. */
    amountFiatMicros: numeric('amount_fiat_micros', { precision: 78, scale: 0 }).notNull(),
    /** Shown to the payer above the amount, so they know what they are paying for. */
    description: text('description'),

    status: checkoutSessionStatusEnum('status').notNull().default('open'),
    /** Test or live, from the credential. A test session opens test invoices only. */
    mode: objectModeEnum('mode').notNull().default('live'),

    /**
     * Who pays the commission on the invoice this session opens. Null means the
     * merchant's current default.
     *
     * Null rather than a copy of the default, and the difference matters: a session can
     * sit unopened for an hour, and a merchant who changed their mind in between should
     * have the invoice follow the new answer. Only an explicit per-checkout choice — a
     * goodwill order, a complaint — should survive that.
     */
    feePayer: feePayerEnum('fee_payer'),

    /**
     * The invoice for the currency the payer chose. Null while still open.
     *
     * Repointed rather than replaced if the payer changes their mind before paying.
     * The previous invoice is left alone: payment matching is by address, so a payer
     * who had already copied the old address and sends anyway is still credited.
     * Deleting or expiring it would turn a slow payer into a lost payment.
     */
    invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'set null' }),

    /** Where to send the payer once the payment is final. Merchant-supplied. */
    successUrl: text('success_url'),
    cancelUrl: text('cancel_url'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    selectedAt: timestamp('selected_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
  },
  (table) => [
    index('checkout_sessions_org_created_idx').on(table.organizationId, table.createdAt),
    index('checkout_sessions_status_idx').on(table.status),
    /**
     * One session per merchant reference, for the same reason invoices have one.
     *
     * A merchant retrying "checkout for order #1234" after a timeout must get the same
     * session back — two payment links for one order means a customer can be shown
     * either, and only one of them will ever be marked paid.
     */
    uniqueIndex('checkout_sessions_org_reference_key')
      .on(table.organizationId, table.reference)
      .where(sql`${table.reference} is not null`),
  ],
);


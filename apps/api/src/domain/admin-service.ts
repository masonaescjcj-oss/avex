import { and, asc, count, desc, eq, gte, ilike, isNull, lt, lte, or, sql } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import {
  apiKeys,
  auditLog,
  invoices,
  memberships,
  organizations,
  payoutAddresses,
  payments,
  staff,
  users,
} from '../db/schema.js';
import type { AuditService } from './audit.js';
import type { StaffRole } from './staff-rbac.js';

/**
 * The read and write surface behind the admin panel's first tier.
 *
 * Everything here exists because without it the same question has to be answered
 * with a hand-written query against live money. That is the criterion the tier was
 * chosen on, and it is also why the queries live in a service rather than inline in
 * routes: a support question answered by `psql` is unauditable, and one answered by
 * a named method is not.
 *
 * A note on money in this file. Amounts come out of Postgres as decimal strings and
 * are handed on as strings, not converted to `number`. A JavaScript number cannot
 * hold an 18-decimal token amount, and an admin panel that displays a rounded
 * balance is worse than one that displays none.
 */

export class AdminError extends Error {
  constructor(
    readonly code: 'not_found' | 'already_suspended' | 'not_suspended',
    message: string,
  ) {
    super(message);
    this.name = 'AdminError';
  }
}

export interface MerchantListItem {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly createdAt: Date;
  readonly suspendedAt: Date | null;
  readonly suspendedReason: string | null;
  readonly memberCount: number;
  readonly invoiceCount: number;
  /** Sum of credited, unreversed payments, in smallest units, as a decimal string. */
  readonly paidVolume: string;
  readonly lastInvoiceAt: Date | null;
}

export interface MerchantListPage {
  readonly items: readonly MerchantListItem[];
  readonly total: number;
}

export type MerchantFilter = 'all' | 'active' | 'suspended';

export interface AuditSearchQuery {
  readonly organizationId?: string | null | undefined;
  readonly staffId?: string | null | undefined;
  readonly userId?: string | null | undefined;
  /** Prefix match on the dotted action, e.g. `payout_address` or `staff.disabled`. */
  readonly actionPrefix?: string | null | undefined;
  readonly targetId?: string | null | undefined;
  readonly from?: Date | null | undefined;
  readonly to?: Date | null | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | null | undefined;
}

export interface AuditRow {
  readonly id: string;
  readonly createdAt: Date;
  readonly action: string;
  readonly organizationId: string | null;
  readonly organizationName: string | null;
  readonly actor:
    | { readonly kind: 'staff'; readonly id: string; readonly email: string; readonly role: StaffRole }
    | { readonly kind: 'user'; readonly id: string; readonly email: string }
    | { readonly kind: 'api_key'; readonly id: string }
    | { readonly kind: 'system' };
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly metadata: Record<string, unknown> | null;
  readonly ip: string | null;
}

export interface AuditSearchPage {
  readonly rows: readonly AuditRow[];
  /** Opaque continuation token; absent when the last page has been reached. */
  readonly nextCursor: string | null;
}

/** Bounds on a page. Large enough to be useful, small enough to stay a query. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export class AdminService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /**
   * Merchants, newest first, with the few counts an operator needs to triage.
   *
   * The aggregates are subqueries rather than joins. A join across memberships and
   * invoices multiplies rows before grouping, and an operator who sees a merchant's
   * invoice count multiplied by their member count will believe it.
   */
  async listMerchants(options: {
    readonly search?: string | null | undefined;
    readonly filter?: MerchantFilter | undefined;
    readonly limit?: number | undefined;
    readonly offset?: number | undefined;
  } = {}): Promise<MerchantListPage> {
    const limit = clampLimit(options.limit);
    const offset = Math.max(0, options.offset ?? 0);
    const filter = options.filter ?? 'all';

    const conditions = [];
    const search = options.search?.trim();
    if (search) {
      conditions.push(
        or(ilike(organizations.name, `%${search}%`), ilike(organizations.slug, `%${search}%`)),
      );
    }
    if (filter === 'active') conditions.push(isNull(organizations.suspendedAt));
    if (filter === 'suspended') conditions.push(sql`${organizations.suspendedAt} is not null`);

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    /**
     * The aggregates are correlated subqueries written out longhand, with an alias
     * on each inner table.
     *
     * Two details are load-bearing. A join across memberships and invoices would
     * multiply rows before grouping, and an operator shown an invoice count
     * multiplied by a member count will believe it — hence subqueries. And the outer
     * column is written `${organizations}."id"` rather than `${organizations.id}`,
     * because inside a `sql` template the latter renders as a bare `"id"` that
     * Postgres reads as ambiguous against the aliased inner table's own `id`.
     */
    const rows = await this.db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        createdAt: organizations.createdAt,
        suspendedAt: organizations.suspendedAt,
        suspendedReason: organizations.suspendedReason,
        memberCount: sql<number>`(
          select count(*)::int from ${memberships} mem
          where mem.organization_id = ${organizations}."id" and mem.revoked_at is null
        )`,
        invoiceCount: sql<number>`(
          select count(*)::int from ${invoices} inv
          where inv.organization_id = ${organizations}."id"
        )`,
        // Credited and not reversed: a reorged payment must not inflate volume.
        paidVolume: sql<string>`coalesce((
          select sum(pay.amount)
          from ${payments} pay
          join ${invoices} inv on inv.id = pay.invoice_id
          where inv.organization_id = ${organizations}."id" and pay.reversed_at is null
        ), 0)::text`,
        lastInvoiceAt: sql<Date | null>`(
          select max(inv.created_at) from ${invoices} inv
          where inv.organization_id = ${organizations}."id"
        )`,
      })
      .from(organizations)
      .where(where)
      .orderBy(desc(organizations.createdAt))
      .limit(limit)
      .offset(offset);

    const [totalRow] = await this.db
      .select({ value: count() })
      .from(organizations)
      .where(where);

    return {
      items: rows.map((row) => ({
        ...row,
        lastInvoiceAt: row.lastInvoiceAt === null ? null : new Date(row.lastInvoiceAt),
      })),
      total: totalRow?.value ?? 0,
    };
  }

  /**
   * One merchant in full: members, payout addresses, keys, recent invoices.
   *
   * Payout addresses are returned including superseded ones. "It used to go here
   * and now it goes there" is the shape of the question that actually gets asked,
   * and only the history can answer it.
   */
  async getMerchant(organizationId: string) {
    const [organization] = await this.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    if (!organization) throw new AdminError('not_found', 'No such merchant.');

    const members = await this.db
      .select({
        userId: users.id,
        email: users.email,
        role: memberships.role,
        emailVerifiedAt: users.emailVerifiedAt,
        totpEnabledAt: users.totpEnabledAt,
        joinedAt: memberships.createdAt,
        revokedAt: memberships.revokedAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.organizationId, organizationId))
      .orderBy(asc(memberships.createdAt));

    const payouts = await this.db
      .select()
      .from(payoutAddresses)
      .where(eq(payoutAddresses.organizationId, organizationId))
      .orderBy(desc(payoutAddresses.createdAt));

    const keys = await this.db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        mode: apiKeys.mode,
        displayPrefix: apiKeys.displayPrefix,
        scopes: apiKeys.scopes,
        createdAt: apiKeys.createdAt,
        lastUsedAt: apiKeys.lastUsedAt,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.organizationId, organizationId))
      .orderBy(desc(apiKeys.createdAt));

    const recentInvoices = await this.db
      .select({
        id: invoices.id,
        reference: invoices.reference,
        chain: invoices.chain,
        status: invoices.status,
        amountDue: invoices.amountDue,
        amountPaid: invoices.amountPaid,
        depositAddress: invoices.depositAddress,
        createdAt: invoices.createdAt,
        expiresAt: invoices.expiresAt,
        settledAt: invoices.settledAt,
      })
      .from(invoices)
      .where(eq(invoices.organizationId, organizationId))
      .orderBy(desc(invoices.createdAt))
      .limit(20);

    const statusCounts = await this.db
      .select({ status: invoices.status, value: count() })
      .from(invoices)
      .where(eq(invoices.organizationId, organizationId))
      .groupBy(invoices.status);

    return {
      organization,
      members,
      payoutAddresses: payouts,
      apiKeys: keys,
      recentInvoices,
      invoicesByStatus: Object.fromEntries(statusCounts.map((row) => [row.status, row.value])),
    };
  }

  /**
   * Suspend a merchant, with effect immediately.
   *
   * The teeth are already in `requireOrganizationAccess`, which refuses a suspended
   * organisation before any handler runs — so this one column write stops new
   * invoices, new API calls and new configuration changes together. Nothing here
   * touches settlement of money already received: funds that arrived before the
   * suspension belong to the merchant, and withholding them would be theft rather
   * than enforcement.
   */
  async suspendMerchant(
    actor: { readonly staffId: string; readonly role: StaffRole },
    organizationId: string,
    reason: string,
    context: { readonly ip?: string | null | undefined; readonly userAgent?: string | null | undefined } = {},
  ): Promise<void> {
    const [organization] = await this.db
      .select({ id: organizations.id, suspendedAt: organizations.suspendedAt })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    if (!organization) throw new AdminError('not_found', 'No such merchant.');
    if (organization.suspendedAt !== null) {
      throw new AdminError('already_suspended', 'That merchant is already suspended.');
    }

    await this.db
      .update(organizations)
      .set({ suspendedAt: new Date(), suspendedReason: reason })
      .where(eq(organizations.id, organizationId));

    await this.audit.record({
      staffId: actor.staffId,
      organizationId,
      action: 'merchant.suspended',
      targetType: 'organization',
      targetId: organizationId,
      metadata: { reason, actorRole: actor.role },
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
    });
  }

  async reinstateMerchant(
    actor: { readonly staffId: string; readonly role: StaffRole },
    organizationId: string,
    note: string | null,
    context: { readonly ip?: string | null | undefined; readonly userAgent?: string | null | undefined } = {},
  ): Promise<void> {
    const [organization] = await this.db
      .select({ id: organizations.id, suspendedAt: organizations.suspendedAt, reason: organizations.suspendedReason })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    if (!organization) throw new AdminError('not_found', 'No such merchant.');
    if (organization.suspendedAt === null) {
      throw new AdminError('not_suspended', 'That merchant is not suspended.');
    }

    await this.db
      .update(organizations)
      .set({ suspendedAt: null, suspendedReason: null })
      .where(eq(organizations.id, organizationId));

    await this.audit.record({
      staffId: actor.staffId,
      organizationId,
      action: 'merchant.reinstated',
      targetType: 'organization',
      targetId: organizationId,
      // The reason it was suspended is recorded here too, because the suspension
      // row is the only other place it existed and this write clears it.
      metadata: { note, clearedReason: organization.reason, actorRole: actor.role },
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
    });
  }

  /**
   * Search the audit trail across every merchant.
   *
   * Paginated by keyspace rather than by offset: `(createdAt, id)` strictly
   * descending, with the cursor carrying both. An offset would silently skip or
   * repeat rows, because this table grows while it is being read — and in an audit
   * trail a skipped row is the one somebody was looking for.
   */
  async searchAudit(query: AuditSearchQuery): Promise<AuditSearchPage> {
    const limit = clampLimit(query.limit);
    const conditions = [];

    if (query.organizationId) {
      /**
       * A row is "about" a merchant if it is scoped to them or if it targets them.
       *
       * Staff reads carry the merchant only in `targetId`, because that column has
       * no foreign key and can therefore record an access attempt against an id that
       * turns out not to exist. Matching one column alone would silently omit every
       * staff read from a merchant's history — the opposite of the point.
       */
      conditions.push(
        or(
          eq(auditLog.organizationId, query.organizationId),
          and(eq(auditLog.targetType, 'organization'), eq(auditLog.targetId, query.organizationId)),
        ),
      );
    }
    if (query.staffId) conditions.push(eq(auditLog.actorStaffId, query.staffId));
    if (query.userId) conditions.push(eq(auditLog.actorUserId, query.userId));
    if (query.targetId) conditions.push(eq(auditLog.targetId, query.targetId));
    if (query.from) conditions.push(gte(auditLog.createdAt, query.from));
    if (query.to) conditions.push(lte(auditLog.createdAt, query.to));

    if (query.actionPrefix) {
      // Escape the LIKE metacharacters so a search for `a_b` cannot match `axb`.
      const escaped = query.actionPrefix.replace(/([%_\\])/g, '\\$1');
      conditions.push(sql`${auditLog.action} like ${escaped + '%'}`);
    }

    const cursor = decodeCursor(query.cursor);
    if (cursor) {
      // Strictly-after in the descending order: an older timestamp, or the same
      // timestamp with a smaller id. Without the id tiebreak, rows written in the
      // same transaction share a timestamp and one of them is skipped.
      conditions.push(
        or(
          lt(auditLog.createdAt, cursor.createdAt),
          and(eq(auditLog.createdAt, cursor.createdAt), lt(auditLog.id, cursor.id)),
        ),
      );
    }

    // One extra row tells us whether another page exists without a second count.
    const rows = await this.db
      .select({
        id: auditLog.id,
        createdAt: auditLog.createdAt,
        action: auditLog.action,
        organizationId: auditLog.organizationId,
        organizationName: organizations.name,
        actorStaffId: auditLog.actorStaffId,
        staffEmail: staff.email,
        staffRole: staff.role,
        actorUserId: auditLog.actorUserId,
        userEmail: users.email,
        actorApiKeyId: auditLog.actorApiKeyId,
        targetType: auditLog.targetType,
        targetId: auditLog.targetId,
        metadata: auditLog.metadata,
        ip: auditLog.ip,
      })
      .from(auditLog)
      .leftJoin(organizations, eq(organizations.id, auditLog.organizationId))
      .leftJoin(staff, eq(staff.id, auditLog.actorStaffId))
      .leftJoin(users, eq(users.id, auditLog.actorUserId))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const last = page.at(-1);

    return {
      rows: page.map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        action: row.action,
        organizationId: row.organizationId,
        organizationName: row.organizationName,
        actor: describeActor(row),
        targetType: row.targetType,
        targetId: row.targetId,
        metadata: row.metadata,
        ip: row.ip,
      })),
      nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }
}

function describeActor(row: {
  actorStaffId: string | null;
  staffEmail: string | null;
  staffRole: StaffRole | null;
  actorUserId: string | null;
  userEmail: string | null;
  actorApiKeyId: string | null;
}): AuditRow['actor'] {
  if (row.actorStaffId !== null) {
    return {
      kind: 'staff',
      id: row.actorStaffId,
      // A staff row is only deleted by `on delete set null`, which also clears the
      // id — so reaching here with a null email means the join lost, not that the
      // account is anonymous. Say so rather than printing "null".
      email: row.staffEmail ?? '(removed staff account)',
      role: row.staffRole ?? 'support',
    };
  }
  if (row.actorUserId !== null) {
    return { kind: 'user', id: row.actorUserId, email: row.userEmail ?? '(removed account)' };
  }
  if (row.actorApiKeyId !== null) return { kind: 'api_key', id: row.actorApiKeyId };
  return { kind: 'system' };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

/**
 * Cursors are opaque to the caller but plain to us: a timestamp and an id.
 *
 * Base64url rather than JSON in the query string, so a client cannot come to depend
 * on the shape and constrain a later change to the ordering.
 */
function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | null | undefined): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = decoded.lastIndexOf('|');
  if (separator === -1) return null;

  const createdAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  // A malformed cursor returns the first page rather than throwing. It is a
  // pagination hint, and refusing the whole request over a mangled one is worse.
  if (Number.isNaN(createdAt.getTime()) || id.length === 0) return null;

  return { createdAt, id };
}

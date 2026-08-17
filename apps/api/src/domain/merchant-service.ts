import { and, asc, count, desc, eq, gte, isNull, lt, lte, or, sql } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import {
  assets,
  invoices,
  payments,
  settlements,
  webhookDeliveries,
  webhookEndpoints,
} from '../db/schema.js';

/**
 * The read surface behind the merchant dashboard.
 *
 * Every method takes an organisation id and scopes to it. That is not a convention to
 * remember: `requireOrganizationAccess` is the only way a route obtains one, so a
 * query here cannot be reached without tenancy having been established. A method that
 * forgot its `organizationId` filter would be a cross-merchant data leak, and the
 * shape of these signatures is what makes that hard to write by accident.
 *
 * Amounts leave as decimal strings, paired with the asset's decimals so the client can
 * place the point. Converting to `number` here would round an 18-decimal balance, and
 * a dashboard that misreports what a merchant is owed is worse than one that shows
 * nothing.
 */

export class MerchantError extends Error {
  constructor(
    readonly code: 'not_found',
    message: string,
  ) {
    super(message);
    this.name = 'MerchantError';
  }
}

export interface InvoiceListQuery {
  readonly status?: string | undefined;
  readonly chain?: string | undefined;
  readonly reference?: string | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export class MerchantService {
  constructor(private readonly db: Database) {}

  /**
   * Invoices, newest first, paginated by keyspace rather than offset.
   *
   * Same reasoning as the admin audit search: this table grows while it is being
   * read, and an offset silently skips rows. A merchant reconciling their own books
   * against ours must be able to page through without a gap.
   */
  async listInvoices(organizationId: string, query: InvoiceListQuery = {}) {
    const limit = clampLimit(query.limit);
    const conditions = [eq(invoices.organizationId, organizationId)];

    if (query.status) conditions.push(eq(invoices.status, query.status as never));
    if (query.chain) conditions.push(eq(invoices.chain, query.chain));
    if (query.reference) conditions.push(eq(invoices.reference, query.reference));
    if (query.from) conditions.push(gte(invoices.createdAt, query.from));
    if (query.to) conditions.push(lte(invoices.createdAt, query.to));

    const cursor = decodeCursor(query.cursor);
    if (cursor) {
      conditions.push(
        or(
          lt(invoices.createdAt, cursor.createdAt),
          and(eq(invoices.createdAt, cursor.createdAt), lt(invoices.id, cursor.id)),
        )!,
      );
    }

    const rows = await this.db
      .select({
        id: invoices.id,
        reference: invoices.reference,
        chain: invoices.chain,
        status: invoices.status,
        amountDue: invoices.amountDue,
        amountPaid: invoices.amountPaid,
        depositAddress: invoices.depositAddress,
        memo: invoices.memo,
        toleranceBps: invoices.toleranceBps,
        createdAt: invoices.createdAt,
        expiresAt: invoices.expiresAt,
        paidAt: invoices.paidAt,
        settledAt: invoices.settledAt,
        assetSymbol: assets.symbol,
        assetDecimals: assets.decimals,
      })
      .from(invoices)
      .innerJoin(assets, eq(assets.id, invoices.assetId))
      .where(and(...conditions))
      .orderBy(desc(invoices.createdAt), desc(invoices.id))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const last = page.at(-1);

    return {
      invoices: page,
      nextCursor:
        rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  /**
   * One invoice with its payments and its settlement, if any.
   *
   * Reversed payments are included rather than filtered out. A merchant who saw a
   * payment yesterday and does not see it today would reasonably conclude we lost it;
   * showing it marked reversed, with the reason, is the only honest answer after a
   * reorg.
   */
  async getInvoice(organizationId: string, invoiceId: string) {
    const [invoice] = await this.db
      .select({
        invoice: invoices,
        assetSymbol: assets.symbol,
        assetDecimals: assets.decimals,
        assetContract: assets.contract,
      })
      .from(invoices)
      .innerJoin(assets, eq(assets.id, invoices.assetId))
      // The tenancy filter and the id together: an invoice belonging to another
      // merchant must read as absent, not as forbidden, or the id space leaks.
      .where(and(eq(invoices.id, invoiceId), eq(invoices.organizationId, organizationId)))
      .limit(1);
    if (!invoice) throw new MerchantError('not_found', 'No such invoice.');

    const received = await this.db
      .select({
        id: payments.id,
        txHash: payments.txHash,
        transferIndex: payments.transferIndex,
        amount: payments.amount,
        blockNumber: payments.blockNumber,
        fromAddress: payments.fromAddress,
        creditedAt: payments.creditedAt,
        reversedAt: payments.reversedAt,
        reversedReason: payments.reversedReason,
      })
      .from(payments)
      .where(eq(payments.invoiceId, invoiceId))
      .orderBy(asc(payments.creditedAt));

    /**
     * The settlement that swept this invoice, found by looking for its id in the
     * batch. `invoice_ids` is JSONB, so this is a containment check rather than a
     * join — batches hold many invoices and normalising them into a join table would
     * buy nothing but a migration.
     */
    const sweeps = await this.db
      .select({
        txHash: settlements.txHash,
        status: settlements.status,
        broadcastAt: settlements.broadcastAt,
        confirmedAt: settlements.confirmedAt,
        actualCostUsdMicros: settlements.actualCostUsdMicros,
        estimatedCostUsdMicros: settlements.estimatedCostUsdMicros,
      })
      .from(settlements)
      .where(sql`${settlements.invoiceIds} @> ${JSON.stringify([invoiceId])}::jsonb`)
      .orderBy(desc(settlements.broadcastAt));

    return {
      ...invoice.invoice,
      assetSymbol: invoice.assetSymbol,
      assetDecimals: invoice.assetDecimals,
      assetContract: invoice.assetContract,
      payments: received,
      settlements: sweeps,
    };
  }

  /**
   * Volume by chain and asset over a window.
   *
   * Counts credited, unreversed payments — not invoices marked paid. The two differ
   * after a reorg, and the figure a merchant reconciles against should be the money
   * that actually arrived.
   */
  async volumeReport(
    organizationId: string,
    options: { readonly from?: Date | undefined; readonly to?: Date | undefined } = {},
  ) {
    const conditions = [eq(invoices.organizationId, organizationId), isNull(payments.reversedAt)];
    if (options.from) conditions.push(gte(payments.creditedAt, options.from));
    if (options.to) conditions.push(lte(payments.creditedAt, options.to));

    const rows = await this.db
      .select({
        chain: invoices.chain,
        assetSymbol: assets.symbol,
        assetDecimals: assets.decimals,
        paymentCount: count(),
        total: sql<string>`coalesce(sum(${payments.amount}), 0)::text`,
      })
      .from(payments)
      .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
      .innerJoin(assets, eq(assets.id, invoices.assetId))
      .where(and(...conditions))
      .groupBy(invoices.chain, assets.symbol, assets.decimals)
      .orderBy(desc(sql`sum(${payments.amount})`));

    const byStatus = await this.db
      .select({ status: invoices.status, value: count() })
      .from(invoices)
      .where(eq(invoices.organizationId, organizationId))
      .groupBy(invoices.status);

    return {
      volume: rows,
      invoicesByStatus: Object.fromEntries(byStatus.map((row) => [row.status, row.value])),
    };
  }

  // ── webhooks ────────────────────────────────────────────────────────────────

  async listWebhookEndpoints(organizationId: string) {
    return this.db
      .select({
        id: webhookEndpoints.id,
        url: webhookEndpoints.url,
        events: webhookEndpoints.events,
        enabled: webhookEndpoints.enabled,
        createdAt: webhookEndpoints.createdAt,
        disabledAt: webhookEndpoints.disabledAt,
        disabledReason: webhookEndpoints.disabledReason,
        // The secret is deliberately absent. It was shown once at creation; a route
        // that could re-read it would turn a write-only secret into a readable one.
        pending: sql<number>`(
          select count(*)::int from ${webhookDeliveries} wd
          where wd.endpoint_id = ${webhookEndpoints}."id" and wd.status = 'pending'
        )`,
        failed: sql<number>`(
          select count(*)::int from ${webhookDeliveries} wd
          where wd.endpoint_id = ${webhookEndpoints}."id" and wd.status in ('failed', 'abandoned')
        )`,
      })
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.organizationId, organizationId))
      .orderBy(desc(webhookEndpoints.createdAt));
  }

  /**
   * Recent deliveries, so a merchant can see why their endpoint is not receiving.
   *
   * Scoped through the endpoint's organisation rather than by taking an endpoint id on
   * trust — otherwise one merchant could read another's delivery log, including the
   * payloads, by guessing a uuid.
   */
  async listWebhookDeliveries(organizationId: string, limit = 50) {
    return this.db
      .select({
        id: webhookDeliveries.id,
        endpointId: webhookDeliveries.endpointId,
        url: webhookEndpoints.url,
        event: webhookDeliveries.event,
        status: webhookDeliveries.status,
        attempts: webhookDeliveries.attempts,
        lastError: webhookDeliveries.lastError,
        nextAttemptAt: webhookDeliveries.nextAttemptAt,
        createdAt: webhookDeliveries.createdAt,
        deliveredAt: webhookDeliveries.deliveredAt,
      })
      .from(webhookDeliveries)
      .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
      .where(eq(webhookEndpoints.organizationId, organizationId))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(clampLimit(limit));
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = decoded.lastIndexOf('|');
  if (separator === -1) return null;

  const createdAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  // A mangled cursor returns the first page. It is a pagination hint, and refusing
  // the whole request over one would turn a cosmetic problem into an unusable page.
  if (Number.isNaN(createdAt.getTime()) || id.length === 0) return null;
  return { createdAt, id };
}

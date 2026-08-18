import { randomUUID } from 'node:crypto';

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
    readonly code:
      | 'not_found'
      | 'not_test_mode'
      | 'not_stars'
      | 'payload_mismatch'
      | 'charge_reused',
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
    /**
     * Live only.
     *
     * A merchant reconciling their books against this figure is reconciling real money.
     * Test payments in the same total would make it useless for the one purpose it has,
     * and a merchant who had been testing would find their revenue overstated.
     */
    const conditions = [
      eq(invoices.organizationId, organizationId),
      eq(invoices.mode, 'live'),
      isNull(payments.reversedAt),
    ];
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
      .where(and(eq(invoices.organizationId, organizationId), eq(invoices.mode, 'live')))
      .groupBy(invoices.status);

    return {
      volume: rows,
      invoicesByStatus: Object.fromEntries(byStatus.map((row) => [row.status, row.value])),
    };
  }

  /**
   * Credit a test invoice as though a payment arrived.
   *
   * The mode check is the whole security of this method, so it is the first thing it
   * does and it reads from the row rather than from anything the caller supplied. A
   * live invoice is paid by a chain or not at all — there is no override, because the
   * only thing an override could add is the ability to release goods against money that
   * never existed.
   *
   * Everything else mirrors what the real payment path does: a `payments` row keyed the
   * same way, `amountPaid` recomputed from those rows rather than incremented, and the
   * status classified against the invoice's own tolerance. A test that took a different
   * route through the code would be testing the wrong code.
   */
  async simulatePayment(organizationId: string, invoiceId: string, amount?: bigint) {
    const [invoice] = await this.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.organizationId, organizationId)))
      .limit(1);
    if (!invoice) throw new MerchantError('not_found', 'No such invoice.');

    if (invoice.mode !== 'test') {
      throw new MerchantError(
        'not_test_mode',
        'Only a test invoice can be paid this way. A live invoice is paid on chain.',
      );
    }

    const due = BigInt(invoice.amountDue);
    const paid = amount ?? due;

    /**
     * A synthetic transaction hash, marked as such.
     *
     * Keyed like a real payment so the unique constraint still prevents a double
     * credit, and prefixed so nobody looking at a payments table, an export or a
     * support ticket mistakes it for something that happened on a chain.
     */
    const txHash = `0xtest${randomUUID().replace(/-/g, '')}`;

    await this.db.insert(payments).values({
      invoiceId,
      chain: invoice.chain,
      txHash,
      transferIndex: 0,
      amount: paid.toString(),
      blockNumber: 0,
      creditedAt: new Date(),
      valueUsdMicros: null,
      // Not `quote`: nothing was priced, and letting simulated payments claim a
      // verified valuation would put them in reach of the volume assessment if the
      // mode filter were ever removed.
      valueSource: 'unknown',
    });

    const total = await this.db
      .select({ sum: sql<string>`coalesce(sum(${payments.amount}), 0)::text` })
      .from(payments)
      .where(and(eq(payments.invoiceId, invoiceId), isNull(payments.reversedAt)));
    const amountPaid = BigInt(total[0]?.sum ?? '0');

    const tolerance = (due * BigInt(invoice.toleranceBps)) / 10_000n;
    const status =
      amountPaid < due - tolerance ? 'underpaid' : amountPaid > due + tolerance ? 'overpaid' : 'paid';

    await this.db
      .update(invoices)
      .set({
        amountPaid: amountPaid.toString(),
        status,
        paidAt: status === 'paid' ? new Date() : invoice.paidAt,
      })
      .where(eq(invoices.id, invoiceId));

    return { invoiceId, mode: invoice.mode, status, amountPaid: amountPaid.toString(), txHash };
  }

  /**
   * Record a Telegram Stars payment reported by the merchant's own bot.
   *
   * What AVEX can honestly do for Stars is narrower than for crypto, and the narrowness is
   * structural. Stars paid to a bot land in that bot's Telegram balance: there is no chain
   * to read, no address to watch and nothing for us to sweep. So we are the record rather
   * than the custodian — one order model, one dashboard, one webhook stream covering both
   * rails, which is what a merchant selling inside Telegram actually wants.
   *
   * The evidence is the merchant's API key and nothing more. That is worth stating plainly
   * rather than dressing up: a merchant could report Stars that never arrived. It would
   * only inflate their own volume — which raises their bill — except in one direction that
   * matters, since more volume reaches a cheaper commission tier. So the payment is
   * recorded with `self_reported` provenance and counted as such, the same trade already
   * made for merchant-set rates: prevention is not available here, so detection is.
   *
   * Idempotent on Telegram's own `telegram_payment_charge_id`. A bot that retries its
   * forward, or receives the same update twice, must not credit twice.
   */
  async recordStarsPayment(
    organizationId: string,
    invoiceId: string,
    input: {
      readonly chargeId: string;
      readonly amountStars: bigint;
      readonly payload?: string | undefined;
    },
  ) {
    const [invoice] = await this.db
      .select({ invoice: invoices, assetKind: assets.kind })
      .from(invoices)
      .innerJoin(assets, eq(assets.id, invoices.assetId))
      .where(and(eq(invoices.id, invoiceId), eq(invoices.organizationId, organizationId)))
      .limit(1);
    if (!invoice) throw new MerchantError('not_found', 'No such invoice.');

    if (invoice.assetKind !== 'stars') {
      throw new MerchantError(
        'not_stars',
        'That invoice is not denominated in Telegram Stars. A crypto invoice is paid on chain.',
      );
    }

    /**
     * The payload must match, when one was sent.
     *
     * Telegram echoes back whatever the bot put in `invoice_payload`, and ours is the
     * invoice's own deposit column. Checking it catches a bot that reported the right
     * payment against the wrong invoice — which is the mistake an integration makes when it
     * keys its own order table differently from ours.
     */
    if (input.payload !== undefined && input.payload !== invoice.invoice.depositAddress) {
      throw new MerchantError(
        'payload_mismatch',
        'That payment belongs to a different invoice: the Telegram payload does not match.',
      );
    }

    /**
     * Keyed on Telegram's charge id, in the column the chain path uses for a transaction
     * hash. Same unique constraint, same protection — a retried forward is a duplicate
     * insert rather than a second credit.
     */
    const txHash = `tg:${input.chargeId}`;
    try {
      await this.db.insert(payments).values({
        invoiceId,
        chain: invoice.invoice.chain,
        txHash,
        transferIndex: 0,
        amount: input.amountStars.toString(),
        blockNumber: 0,
        creditedAt: new Date(),
        /**
         * The invoice's own fiat figure, not a rate applied now.
         *
         * The merchant priced this invoice when they created it; re-deriving a value here
         * would let a rate change between creation and payment silently restate what the
         * sale was worth.
         */
        valueUsdMicros: null,
        valueSource: 'self_reported',
      });
    } catch (error) {
      /**
       * A duplicate has two causes, and they need different answers.
       *
       * The uniqueness is on (chain, txHash) across every invoice, not within one — so the
       * lookup deliberately ignores the invoice id. If the existing row belongs to *this*
       * invoice, a bot retried its forward and there is nothing to do. If it belongs to
       * another, one Telegram charge has been reported against two invoices, which is a bug
       * in the integration and not something a retry will fix.
       *
       * Reporting the second as "already recorded" would be worse than the 500 it replaces:
       * the bot would mark an order paid against a payment that belongs elsewhere.
       */
      const [existing] = await this.db
        .select({ invoiceId: payments.invoiceId })
        .from(payments)
        .where(and(eq(payments.chain, invoice.invoice.chain), eq(payments.txHash, txHash)))
        .limit(1);
      if (!existing) throw error;

      if (existing.invoiceId !== invoiceId) {
        throw new MerchantError(
          'charge_reused',
          'That Telegram charge is already recorded against a different invoice.',
        );
      }
      return { invoiceId, status: invoice.invoice.status, alreadyRecorded: true } as const;
    }

    const total = await this.db
      .select({ sum: sql<string>`coalesce(sum(${payments.amount}), 0)::text` })
      .from(payments)
      .where(and(eq(payments.invoiceId, invoiceId), isNull(payments.reversedAt)));
    const amountPaid = BigInt(total[0]?.sum ?? '0');

    const due = BigInt(invoice.invoice.amountDue);
    const tolerance = (due * BigInt(invoice.invoice.toleranceBps)) / 10_000n;
    const status =
      amountPaid < due - tolerance ? 'underpaid' : amountPaid > due + tolerance ? 'overpaid' : 'paid';

    await this.db
      .update(invoices)
      .set({
        amountPaid: amountPaid.toString(),
        status,
        paidAt: status === 'paid' ? new Date() : invoice.invoice.paidAt,
      })
      .where(eq(invoices.id, invoiceId));

    return { invoiceId, status, amountPaid: amountPaid.toString(), alreadyRecorded: false } as const;
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

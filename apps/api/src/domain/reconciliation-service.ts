import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';

import type { ChainId } from '@avex/core';

import type { Database } from '../db/client.js';
import { assets, invoices, payments, unmatchedPayments } from '../db/schema.js';
import type { AuditService } from './audit.js';
import type { StaffRole } from './staff-rbac.js';

/**
 * The one capability reconciliation borrows from the payment sink.
 *
 * Narrowed to a method rather than taking the sink itself, because the sink also
 * credits payments and dispatches webhooks — powers this service has no business
 * holding. Reusing the sink's implementation is the point; inheriting its reach is
 * not.
 */
export interface InvoiceRecomputer {
  recompute(invoiceId: string): Promise<string>;
}

/**
 * Reconciling transfers that arrived with no invoice to credit.
 *
 * Every row in this queue is a person who sent money and has not got what they paid
 * for. That is why it is a Tier 1 admin feature and why it is not automated: the
 * decision of which invoice a stray transfer belongs to is a judgement, and a wrong
 * guess credits one merchant with another's money.
 *
 * The safety property throughout is the identity key `(chain, txHash, transferIndex)`
 * shared with the `payments` table. It means a transfer can be attached exactly
 * once, enforced by the database rather than by a reviewer being careful.
 */

export class ReconciliationError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'already_resolved'
      | 'invoice_not_found'
      | 'chain_mismatch'
      | 'already_credited',
    message: string,
  ) {
    super(message);
    this.name = 'ReconciliationError';
  }
}

export type UnmatchedReason =
  | 'no_matching_address'
  | 'memo_missing'
  | 'wrong_asset'
  | 'invoice_expired'
  | 'below_minimum';

export interface RecordUnmatchedInput {
  readonly chain: ChainId;
  readonly txHash: string;
  readonly transferIndex: number;
  readonly amount: bigint;
  readonly toAddress: string;
  readonly fromAddress?: string | null | undefined;
  readonly contract?: string | null | undefined;
  readonly assetId?: string | null | undefined;
  readonly memo?: string | null | undefined;
  readonly blockNumber: number;
  readonly reason: UnmatchedReason;
}

export interface UnmatchedRow {
  readonly id: string;
  readonly chain: string;
  readonly txHash: string;
  readonly transferIndex: number;
  readonly amount: string;
  readonly toAddress: string;
  readonly fromAddress: string | null;
  readonly memo: string | null;
  readonly contract: string | null;
  readonly assetSymbol: string | null;
  readonly assetDecimals: number | null;
  readonly blockNumber: number;
  readonly reason: string;
  readonly resolution: string;
  readonly attachedInvoiceId: string | null;
  readonly note: string | null;
  readonly seenAt: Date;
  /**
   * Invoices whose deposit address matches this transfer, as candidates.
   *
   * Populated only on the detail view. Suggesting rather than deciding is the point:
   * the address is strong evidence, but on a memo chain several invoices share one
   * address and only a human can pick between them.
   */
  readonly candidates?: readonly {
    readonly id: string;
    readonly organizationId: string;
    readonly reference: string | null;
    readonly amountDue: string;
    readonly amountPaid: string;
    readonly status: string;
    readonly memo: string | null;
    readonly expiresAt: Date;
  }[];
}

export class ReconciliationService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly invoices: InvoiceRecomputer,
  ) {}

  /**
   * Park a transfer that could not be credited.
   *
   * Idempotent on the identity key, because the watcher re-scans overlapping block
   * ranges after a restart and would otherwise queue the same stray transfer many
   * times over — turning one problem into a page of them.
   */
  async record(input: RecordUnmatchedInput): Promise<void> {
    await this.db
      .insert(unmatchedPayments)
      .values({
        chain: input.chain,
        txHash: input.txHash,
        transferIndex: input.transferIndex,
        amount: input.amount.toString(),
        toAddress: input.toAddress,
        fromAddress: input.fromAddress ?? null,
        contract: input.contract ?? null,
        assetId: input.assetId ?? null,
        memo: input.memo ?? null,
        blockNumber: input.blockNumber,
        reason: input.reason,
      })
      .onConflictDoNothing({
        target: [
          unmatchedPayments.chain,
          unmatchedPayments.txHash,
          unmatchedPayments.transferIndex,
        ],
      });
  }

  /** The queue: unresolved first and oldest first, because age is the harm. */
  async list(options: {
    readonly resolution?: 'pending' | 'attached' | 'returned' | 'ignored' | 'all';
    readonly chain?: ChainId | undefined;
    readonly limit?: number | undefined;
  } = {}): Promise<{ readonly rows: readonly UnmatchedRow[]; readonly pendingTotal: number }> {
    const resolution = options.resolution ?? 'pending';
    const conditions = [];
    if (resolution !== 'all') conditions.push(eq(unmatchedPayments.resolution, resolution));
    if (options.chain) conditions.push(eq(unmatchedPayments.chain, options.chain));

    const rows = await this.db
      .select({
        row: unmatchedPayments,
        symbol: assets.symbol,
        decimals: assets.decimals,
      })
      .from(unmatchedPayments)
      .leftJoin(assets, eq(assets.id, unmatchedPayments.assetId))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(unmatchedPayments.seenAt))
      .limit(Math.min(200, Math.max(1, options.limit ?? 50)));

    const [pending] = await this.db
      .select({ value: count() })
      .from(unmatchedPayments)
      .where(eq(unmatchedPayments.resolution, 'pending'));

    return {
      rows: rows.map(({ row, symbol, decimals }) => toRow(row, symbol, decimals)),
      pendingTotal: pending?.value ?? 0,
    };
  }

  /** One row, with the invoices that share its deposit address as candidates. */
  async get(id: string): Promise<UnmatchedRow> {
    const [found] = await this.db
      .select({ row: unmatchedPayments, symbol: assets.symbol, decimals: assets.decimals })
      .from(unmatchedPayments)
      .leftJoin(assets, eq(assets.id, unmatchedPayments.assetId))
      .where(eq(unmatchedPayments.id, id))
      .limit(1);
    if (!found) throw new ReconciliationError('not_found', 'No such unmatched payment.');

    const candidates = await this.db
      .select({
        id: invoices.id,
        organizationId: invoices.organizationId,
        reference: invoices.reference,
        amountDue: invoices.amountDue,
        amountPaid: invoices.amountPaid,
        status: invoices.status,
        memo: invoices.memo,
        expiresAt: invoices.expiresAt,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.chain, found.row.chain),
          eq(invoices.depositAddress, found.row.toAddress),
        ),
      )
      .orderBy(asc(invoices.createdAt))
      .limit(20);

    return { ...toRow(found.row, found.symbol, found.decimals), candidates };
  }

  /**
   * Credit an unmatched transfer to an invoice.
   *
   * Both writes happen in one transaction, and the payment insert is not
   * `onConflictDoNothing` — a conflict here means this transfer is already credited
   * somewhere, and quietly succeeding would tell the operator they had fixed
   * something while the payer's money sat against a different invoice. The
   * constraint is doing the work; the code's job is to not swallow it.
   */
  async attach(
    actor: { readonly staffId: string; readonly role: StaffRole },
    unmatchedId: string,
    invoiceId: string,
    note: string,
    context: { readonly ip?: string | null | undefined; readonly userAgent?: string | null | undefined } = {},
  ): Promise<{ readonly invoiceStatus: string }> {
    const [row] = await this.db
      .select()
      .from(unmatchedPayments)
      .where(eq(unmatchedPayments.id, unmatchedId))
      .limit(1);
    if (!row) throw new ReconciliationError('not_found', 'No such unmatched payment.');
    if (row.resolution !== 'pending') {
      throw new ReconciliationError(
        'already_resolved',
        `That payment was already marked ${row.resolution}.`,
      );
    }

    const [invoice] = await this.db
      .select({ id: invoices.id, chain: invoices.chain, organizationId: invoices.organizationId })
      .from(invoices)
      .where(eq(invoices.id, invoiceId))
      .limit(1);
    if (!invoice) throw new ReconciliationError('invoice_not_found', 'No such invoice.');

    /**
     * A transfer can only pay an invoice on its own chain.
     *
     * Refused rather than warned about. Crediting a BSC transfer to a TON invoice
     * would produce an invoice marked paid with money that is not reachable from its
     * settlement path, and nothing downstream would ever notice.
     */
    if (invoice.chain !== row.chain) {
      throw new ReconciliationError(
        'chain_mismatch',
        `That transfer is on ${row.chain} but the invoice is on ${invoice.chain}.`,
      );
    }

    const now = new Date();
    try {
      await this.db.transaction(async (tx) => {
        await tx.insert(payments).values({
          invoiceId,
          chain: row.chain,
          txHash: row.txHash,
          transferIndex: row.transferIndex,
          amount: row.amount,
          blockNumber: row.blockNumber,
          fromAddress: row.fromAddress,
          creditedAt: now,
        });

        await tx
          .update(unmatchedPayments)
          .set({
            resolution: 'attached',
            attachedInvoiceId: invoiceId,
            resolvedByStaffId: actor.staffId,
            resolvedAt: now,
            note,
          })
          .where(eq(unmatchedPayments.id, unmatchedId));
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ReconciliationError(
          'already_credited',
          'That transfer is already credited to an invoice. Find it before attaching again.',
        );
      }
      throw error;
    }

    // Outside the transaction: recompute reads the payment rows and must see the
    // committed insert.
    const invoiceStatus = await this.invoices.recompute(invoiceId);

    await this.audit.record({
      staffId: actor.staffId,
      organizationId: invoice.organizationId,
      action: 'payment.attached',
      targetType: 'invoice',
      targetId: invoiceId,
      metadata: {
        unmatchedId,
        chain: row.chain,
        txHash: row.txHash,
        transferIndex: row.transferIndex,
        amount: row.amount,
        invoiceStatus,
        note,
        actorRole: actor.role,
      },
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
    });

    return { invoiceStatus };
  }

  /**
   * Mark a transfer for return, or deliberately leave it.
   *
   * Neither sends anything. Returning crypto is its own dangerous operation — the
   * sending address is often an exchange's hot wallet, where a return is simply
   * lost — so this records the decision and the actual transfer stays a separate,
   * confirmed action. A queue entry that silently triggered a transfer would be the
   * most dangerous button in the panel.
   */
  async resolveWithout(
    actor: { readonly staffId: string; readonly role: StaffRole },
    unmatchedId: string,
    resolution: 'returned' | 'ignored',
    note: string,
    context: { readonly ip?: string | null | undefined; readonly userAgent?: string | null | undefined } = {},
  ): Promise<void> {
    const [row] = await this.db
      .select()
      .from(unmatchedPayments)
      .where(eq(unmatchedPayments.id, unmatchedId))
      .limit(1);
    if (!row) throw new ReconciliationError('not_found', 'No such unmatched payment.');
    if (row.resolution !== 'pending') {
      throw new ReconciliationError(
        'already_resolved',
        `That payment was already marked ${row.resolution}.`,
      );
    }

    await this.db
      .update(unmatchedPayments)
      .set({
        resolution,
        resolvedByStaffId: actor.staffId,
        resolvedAt: new Date(),
        note,
      })
      .where(eq(unmatchedPayments.id, unmatchedId));

    await this.audit.record({
      staffId: actor.staffId,
      action: resolution === 'returned' ? 'payment.marked_for_return' : 'payment.ignored',
      targetType: 'unmatched_payment',
      targetId: unmatchedId,
      metadata: {
        chain: row.chain,
        txHash: row.txHash,
        amount: row.amount,
        fromAddress: row.fromAddress,
        note,
        actorRole: actor.role,
      },
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
    });
  }

  /** Age of the oldest unresolved row, for the health view. Null when the queue is empty. */
  async oldestPendingAgeMs(now: Date = new Date()): Promise<number | null> {
    const [row] = await this.db
      .select({ seenAt: unmatchedPayments.seenAt })
      .from(unmatchedPayments)
      .where(and(eq(unmatchedPayments.resolution, 'pending'), isNull(unmatchedPayments.resolvedAt)))
      .orderBy(asc(unmatchedPayments.seenAt))
      .limit(1);
    return row ? now.getTime() - row.seenAt.getTime() : null;
  }
}

function toRow(
  row: typeof unmatchedPayments.$inferSelect,
  symbol: string | null,
  decimals: number | null,
): UnmatchedRow {
  return {
    id: row.id,
    chain: row.chain,
    txHash: row.txHash,
    transferIndex: row.transferIndex,
    // A decimal string, never a number: an 18-decimal amount does not fit a double,
    // and this figure is the whole reason someone is reading the row.
    amount: row.amount,
    toAddress: row.toAddress,
    fromAddress: row.fromAddress,
    memo: row.memo,
    contract: row.contract,
    assetSymbol: symbol,
    assetDecimals: decimals,
    blockNumber: row.blockNumber,
    reason: row.reason,
    resolution: row.resolution,
    attachedInvoiceId: row.attachedInvoiceId,
    note: row.note,
    seenAt: row.seenAt,
  };
}

/** Postgres reports a unique-constraint breach as 23505. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

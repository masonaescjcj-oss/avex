import type { IncomingPayment, PaymentSink } from '@avex/core';
import { requiredConfirmations } from '@avex/core';
import { and, eq, isNull } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { invoices, payments } from '../db/schema.js';
import type { AuditService } from './audit.js';
import type { WebhookService } from './webhook-service.js';

/**
 * Credits observed transfers against invoices.
 *
 * Two rules shape everything here.
 *
 * A transfer is identified by where it happened — chain, transaction, position —
 * not by when it was noticed, and the database enforces that with a unique
 * constraint. Re-crediting is impossible rather than merely unlikely.
 *
 * And `amountPaid` is always recomputed from the surviving payment rows, never
 * incremented. A running total that only goes up cannot be corrected when a reorg
 * removes one of its contributions.
 */
export class DatabasePaymentSink implements PaymentSink {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly webhooks: WebhookService,
    /** USD value of a token amount, for confirmation tiering. */
    private readonly valueUsd: (payment: IncomingPayment) => number,
  ) {}

  async credit(payment: IncomingPayment): Promise<void> {
    const invoice = await this.match(payment);
    if (!invoice) {
      // Never guessed at. An unmatched transfer goes to reconciliation, because
      // crediting the wrong invoice is worse than crediting none.
      throw new UnmatchedPaymentError(payment);
    }

    if (invoice.chain !== payment.chain) {
      throw new UnmatchedPaymentError(payment);
    }

    const needed = requiredConfirmations(payment.chain, this.valueUsd(payment));
    if (payment.confirmations < needed) {
      // Visible progress for the payer without releasing anything.
      if (invoice.status === 'pending') {
        await this.db
          .update(invoices)
          .set({ status: 'confirming' })
          .where(eq(invoices.id, invoice.id));
      }
      return;
    }

    const previousStatus = invoice.status;

    const inserted = await this.db
      .insert(payments)
      .values({
        invoiceId: invoice.id,
        chain: payment.chain,
        txHash: payment.txHash,
        transferIndex: payment.transferIndex,
        amount: payment.amount.toString(),
        blockNumber: payment.blockNumber,
        fromAddress: null,
      })
      // The exactly-once guarantee, enforced by the database rather than by
      // remembering to check first.
      .onConflictDoNothing({
        target: [payments.chain, payments.txHash, payments.transferIndex],
      })
      .returning({ id: payments.id });

    if (inserted.length === 0) return;

    const status = await this.recompute(invoice.id);

    await this.audit.record({
      organizationId: invoice.organizationId,
      action: 'payment.credited',
      targetType: 'invoice',
      targetId: invoice.id,
      metadata: {
        chain: payment.chain,
        txHash: payment.txHash,
        transferIndex: payment.transferIndex,
        amount: payment.amount.toString(),
        blockNumber: payment.blockNumber,
        status,
      },
    });

    // Only on the transition, so a re-scan that changes nothing does not tell the
    // merchant the same news twice.
    if (status !== previousStatus) {
      await this.webhooks.enqueue(invoice.organizationId, `invoice.${status}`, {
        invoiceId: invoice.id,
        reference: invoice.reference,
        chain: invoice.chain,
        status,
        amountDue: invoice.amountDue,
        amountPaid: await this.amountPaid(invoice.id),
        txHash: payment.txHash,
      });
    }
  }

  async reverse(paymentKey: string, reason: string): Promise<void> {
    const [chain, txHash, transferIndexRaw] = paymentKey.split(':');
    const transferIndex = Number(transferIndexRaw);
    if (!chain || !txHash || !Number.isInteger(transferIndex)) {
      throw new Error(`malformed payment key: ${paymentKey}`);
    }

    const [row] = await this.db
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.chain, chain),
          eq(payments.txHash, txHash),
          eq(payments.transferIndex, transferIndex),
          isNull(payments.reversedAt),
        ),
      )
      .limit(1);
    if (!row) return;

    const [invoice] = await this.db
      .select()
      .from(invoices)
      .where(eq(invoices.id, row.invoiceId))
      .limit(1);

    await this.db
      .update(payments)
      // Marked, not deleted. During an incident, "what did we credit and then take
      // back" is the question being asked, and a deleted row cannot answer it.
      .set({ reversedAt: new Date(), reversedReason: reason })
      .where(eq(payments.id, row.id));

    const status = await this.recompute(row.invoiceId);

    if (invoice) {
      await this.audit.record({
        organizationId: invoice.organizationId,
        action: 'payment.reversed',
        targetType: 'invoice',
        targetId: invoice.id,
        metadata: { chain, txHash, transferIndex, reason, status },
      });

      // The merchant may already have shipped against a paid callback, so this is
      // the one webhook they most need.
      await this.webhooks.enqueue(invoice.organizationId, 'payment.reversed', {
        invoiceId: invoice.id,
        reference: invoice.reference,
        chain,
        txHash,
        reason,
        status,
        amountPaid: await this.amountPaid(invoice.id),
      });
    }
  }

  private async match(payment: IncomingPayment) {
    // Shared-address chains identify an invoice by memo; everywhere else the
    // deposit address is unique to one invoice.
    if (payment.memo) {
      const [byMemo] = await this.db
        .select()
        .from(invoices)
        .where(and(eq(invoices.chain, payment.chain), eq(invoices.memo, payment.memo)))
        .limit(1);
      if (byMemo) return byMemo;
    }

    const [byAddress] = await this.db
      .select()
      .from(invoices)
      .where(
        and(eq(invoices.chain, payment.chain), eq(invoices.depositAddress, payment.to)),
      )
      .limit(1);
    return byAddress ?? null;
  }

  private async amountPaid(invoiceId: string): Promise<string> {
    const rows = await this.db
      .select({ amount: payments.amount })
      .from(payments)
      .where(and(eq(payments.invoiceId, invoiceId), isNull(payments.reversedAt)));

    return rows.reduce((total, row) => total + BigInt(row.amount), 0n).toString();
  }

  /**
   * Recompute an invoice's paid total and status from its surviving payments.
   *
   * Summing rather than incrementing is what makes a reversal correct: after a
   * reorg the total has to be able to go down, and a counter that only rises
   * cannot.
   *
   * Public because reconciliation needs it too: an operator attaching an unmatched
   * transfer to an invoice must arrive at the same status the watcher would have.
   * Two implementations of the underpaid/overpaid boundary would be two places to
   * get the tolerance wrong.
   */
  async recompute(invoiceId: string): Promise<string> {
    const [invoice] = await this.db
      .select()
      .from(invoices)
      .where(eq(invoices.id, invoiceId))
      .limit(1);
    if (!invoice) return 'pending';

    const total = BigInt(await this.amountPaid(invoiceId));
    const due = BigInt(invoice.amountDue);
    const tolerance = (due * BigInt(invoice.toleranceBps)) / 10_000n;

    let status: 'pending' | 'confirming' | 'paid' | 'underpaid' | 'overpaid';
    if (total === 0n) {
      // Back to the start: whatever was seen has been taken back.
      status = 'pending';
    } else if (total < due - tolerance) {
      status = 'underpaid';
    } else if (total > due + tolerance) {
      status = 'overpaid';
    } else {
      status = 'paid';
    }

    await this.db
      .update(invoices)
      .set({
        amountPaid: total.toString(),
        status,
        // Recorded once, on the first time it was fully paid.
        paidAt: status === 'paid' && invoice.paidAt === null ? new Date() : invoice.paidAt,
      })
      .where(eq(invoices.id, invoiceId));

    return status;
  }
}

export class UnmatchedPaymentError extends Error {
  constructor(readonly payment: IncomingPayment) {
    super(
      `no invoice matches ${payment.chain} transfer ${payment.txHash}:${payment.transferIndex} ` +
        `to ${payment.to}${payment.memo ? ` memo ${payment.memo}` : ''}`,
    );
    this.name = 'UnmatchedPaymentError';
  }
}

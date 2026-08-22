import type { IncomingPayment, PaymentSink } from '@avex/core';
import { addressKey, chainConfig, foldsAddressCase, requiredConfirmations } from '@avex/core';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { invoices, payments } from '../db/schema.js';

/** Mirrors `paymentValueSourceEnum`; guarded by the schema drift test. */
export type PaymentValueSource = 'quote' | 'oracle' | 'merchant_rate' | 'unknown';
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
    /**
     * USD value of a token amount.
     *
     * Used for two things now: choosing how many confirmations to require, and
     * recording what the payment was worth so platform billing can assess volume. The
     * second use is why the result is persisted rather than only consulted — see
     * `payments.valueUsdMicros`.
     */
    private readonly valueUsd: (payment: IncomingPayment) => number,
    /**
     * Where the valuation came from, if the caller can say.
     *
     * Defaults to `unknown`, which counts as nothing towards a volume threshold and is
     * visible as such. A caller that knows better should say so — treating an
     * unpriceable payment as zero silently is bad, but treating it as verified would be
     * worse.
     */
    private readonly valueSource: (payment: IncomingPayment) => PaymentValueSource = () =>
      'unknown',
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
        ...this.valuation(payment),
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
        /**
         * The mode, and this field is load-bearing rather than informational.
         *
         * A receiver has to be able to refuse a test invoice against a live order,
         * because completing one means shipping goods against a simulated payment. Any
         * sane implementation defaults a missing field to `live` — so leaving it out
         * does not make the check cautious, it makes the check pass. Our own WooCommerce
         * plugin had exactly that hole until this line existed.
         */
        mode: invoice.mode,
        chain: invoice.chain,
        status,
        amountDue: invoice.amountDue,
        amountPaid: await this.amountPaid(invoice.id),
        txHash: payment.txHash,
      });
    }
  }

  /**
   * The recorded value of a payment, in micro-dollars, with its provenance.
   *
   * Integer micro-dollars from a float USD figure, rounded down. Rounding down means a
   * merchant is never pushed over a billing threshold by a rounding artefact — the
   * direction to be wrong in when the consequence is charging someone.
   */
  private valuation(payment: IncomingPayment): {
    valueUsdMicros: string | null;
    valueSource: PaymentValueSource;
  } {
    const source = this.valueSource(payment);
    let usd: number;
    try {
      usd = this.valueUsd(payment);
    } catch {
      // A pricing failure must never stop a payment being credited. The merchant's
      // money has arrived; what it was worth in dollars is our bookkeeping problem.
      return { valueUsdMicros: null, valueSource: 'unknown' };
    }

    if (!Number.isFinite(usd) || usd < 0) return { valueUsdMicros: null, valueSource: 'unknown' };
    return { valueUsdMicros: BigInt(Math.floor(usd * 1_000_000)).toString(), valueSource: source };
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
        // Present on every invoice event, so a receiver never has to guess.
        mode: invoice.mode,
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

    /**
     * How the address is compared, and why it is not simply `=`.
     *
     * The watcher hands over `toChecksumAddress(...)`, and our own deriver stores the same
     * EIP-55 form, so an exact comparison happens to work today. It stops working the moment
     * a deposit address reaches this table in any other case — a shared-memo wallet typed in
     * by an operator, a row restored from an export, a chain adapter that reports lowercase —
     * and the failure is silent and total: a real transfer to a real invoice matches nothing
     * and goes to reconciliation as unmatched, which reads as the payer never sending it.
     *
     * So the case is folded on hex chains, on both sides rather than trusting either. What
     * this must *not* do is fold on a base58 chain: TRON addresses lose information when
     * lowercased, and two distinct valid ones can fold onto the same string — here that is a
     * payment credited to the wrong merchant's invoice, which is worse than not crediting it.
     * `addressKey` decides; the address book asks it the same question.
     */
    const key = addressKey(payment.chain, payment.to);
    const atAddress = and(
      eq(invoices.chain, payment.chain),
      foldsAddressCase(payment.chain)
        ? sql`lower(${invoices.depositAddress}) = ${key}`
        : eq(invoices.depositAddress, key),
    );

    /**
     * On a pooled chain the address is not the identity; the exact amount is.
     *
     * Several open invoices share one of the merchant's own wallets, each asking for a slightly
     * different amount. Looking up by address alone — which is what every other chain does and
     * what this method did — would return whichever row Postgres found first and credit a
     * stranger's payment to it. That is why this branch exists rather than a comment warning
     * about it.
     */
    if (chainConfig(payment.chain).addressModel === 'pooled') {
      return this.matchPooled(payment, atAddress);
    }

    const [byAddress] = await this.db.select().from(invoices).where(atAddress).limit(1);
    return byAddress ?? null;
  }

  /**
   * Which invoice a payment to a pooled wallet belongs to.
   *
   * Three outcomes, in the order they are tried, and the third is the interesting one.
   *
   * 1. **An open invoice asks for exactly this amount.** The ordinary case, and unambiguous:
   *    every open invoice on a wallet is given a distinct amount for precisely this lookup.
   *
   * 2. **No exact match, and exactly one invoice is open here.** The payer sent the wrong
   *    amount — their exchange rounded the withdrawal, or they typed the round number — and
   *    there is only one invoice it could be for. Credited, and the existing over/under
   *    classification records the difference: an underpayment keeps the shortfall rather than
   *    failing, because real money arrived and saying otherwise would be a lie. This is what
   *    the allocator's preference for idle wallets buys.
   *
   * 3. **No exact match and more than one invoice open here.** Nothing on the chain says which
   *    of them this was for, so nothing here guesses. Returning null sends it to the unmatched
   *    queue for an operator, which is where the payer's support ticket will meet it.
   *
   * Note what case 3 does *not* do: wait. An earlier sketch had it hold the payment in the hope
   * that the other invoices would be settled by exact matches and leave only one candidate.
   * That is a real and useful inference, but it is a later pass over the queue rather than a
   * decision at receive time — a `credit` call that returns "come back later" would either
   * block the watcher's poll or silently drop the transfer.
   */
  private async matchPooled(payment: IncomingPayment, atAddress: SQL | undefined) {
    const open = await this.db
      .select()
      .from(invoices)
      .where(and(atAddress, sql`${invoices.status} in ('pending', 'confirming')`));

    const exact = open.filter((invoice) => BigInt(invoice.amountDue) === payment.amount);
    /**
     * More than one exact match should be impossible, and is treated as ambiguous rather than
     * resolved arbitrarily.
     *
     * The allocator's lock is what makes it impossible; a bug there, or rows written by
     * something else, would produce two invoices at one amount. Taking the first would credit a
     * coin flip. This is the assertion that turns that bug into an operator's queue item.
     */
    if (exact.length === 1) return exact[0]!;
    if (exact.length > 1) return null;

    if (open.length === 1) return open[0]!;

    /**
     * Zero open invoices is not the same as several, but the answer is the same.
     *
     * A payment to a pooled wallet with nothing open is most likely a late payer whose invoice
     * expired — still their money, still needing a human. `invoices.status` excludes expired
     * rows here deliberately: crediting an expired invoice automatically would let a payment
     * arriving days later reopen a settled order.
     */
    return null;
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

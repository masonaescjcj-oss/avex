import { and, eq, lte, or, sql } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { invoices } from '../db/schema.js';
import type { WebhookService } from './webhook-service.js';

/**
 * Closing invoices whose time has run out.
 *
 * Until this existed, nothing did. `expires_at` was written on every invoice and read by the
 * checkout page, which counted down to it and told the payer the rate had lapsed — and the row
 * stayed `pending` forever. On a forwarder address that was harmless. On a shared wallet it was
 * the whole model failing quietly: every abandoned checkout stayed an "open" invoice, so every
 * wallet filled up, a wrong-amount payment never again had a single candidate, and the amounts
 * of invoices nobody would ever pay were reserved for good.
 *
 * ## Which invoices, and when
 *
 * A `pending` invoice — nothing seen — expires at its deadline. A `confirming` one has money on
 * the way: a transfer was seen and is waiting for the chain to finalise it, and expiring it in
 * that window would make the credit that follows land on an expired invoice. So a confirming
 * invoice is left for a further day, which is longer than any chain's finality by orders of
 * magnitude; if it is still confirming then, the transfer was reorganised out and never
 * returned, and the invoice is closed.
 *
 * ## What expiry does not do
 *
 * It does not free the invoice's amount on its wallet — the pool keeps it reserved for a day —
 * and it does not stop an exact-amount payment being credited late. Both are the payment
 * sink's rules, and they exist so that a payer who was slow is not a payer who lost money.
 */

/** How long a `confirming` invoice may sit past its deadline before it is given up on. */
export const CONFIRMING_GRACE_MS = 24 * 60 * 60 * 1000;

/** Rows closed in one pass. Bounded so a backlog after downtime is worked through in steps. */
const BATCH = 500;

export async function expireInvoices(
  db: Database,
  webhooks: WebhookService,
  now: Date = new Date(),
): Promise<number> {
  const confirmingCutoff = new Date(now.getTime() - CONFIRMING_GRACE_MS);

  const due = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(
      or(
        and(eq(invoices.status, 'pending'), lte(invoices.expiresAt, now)),
        and(eq(invoices.status, 'confirming'), lte(invoices.expiresAt, confirmingCutoff)),
      ),
    )
    .limit(BATCH);
  if (due.length === 0) return 0;

  /**
   * Guarded on the current status, so a payment credited between the select and this update
   * wins: `recompute` will have moved the row to paid, and a row that is no longer pending is
   * not touched. The returning rows are the ones actually closed, and only those get a webhook.
   */
  const closed = await db
    .update(invoices)
    .set({ status: 'expired' })
    .where(
      and(
        sql`${invoices.id} in ${due.map((row) => row.id)}`,
        sql`${invoices.status} in ('pending', 'confirming')`,
      ),
    )
    .returning({
      id: invoices.id,
      organizationId: invoices.organizationId,
      reference: invoices.reference,
      mode: invoices.mode,
      chain: invoices.chain,
      amountDue: invoices.amountDue,
      amountPaid: invoices.amountPaid,
    });

  for (const row of closed) {
    await webhooks.enqueue(row.organizationId, 'invoice.expired', {
      invoiceId: row.id,
      reference: row.reference,
      mode: row.mode,
      chain: row.chain,
      status: 'expired',
      amountDue: row.amountDue,
      amountPaid: row.amountPaid,
    });
  }

  return closed.length;
}

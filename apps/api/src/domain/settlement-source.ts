import { chainConfig } from '@avex/core';
import type { Asset, ChainId, SettlementRequest } from '@avex/core';
import { and, asc, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { assets, invoices } from '../db/schema.js';

/**
 * Which invoices are waiting for their funds to be moved.
 *
 * The gap this fills: nothing ever read them. Payments were detected and credited, invoices went
 * to `paid`, and `settled_at` was a column no code wrote — so on an EVM chain a merchant's money
 * reached a deposit address and stayed there. The watcher's own startup line said as much
 * ("watcher cursors loaded; no watcher loop runs in this process yet"), which is the only reason
 * it was not worse than silent.
 *
 * A settlement is a transaction we pay for, so what counts as due is narrow on purpose:
 *
 *   - Paid or overpaid. A partially funded invoice has money at its address, but flushing it
 *     would move less than the merchant is owed and leave the invoice open with nothing at the
 *     address to complete it. That is a decision for reconciliation, not a sweep.
 *   - Live. A test invoice's deposit address is a string no chain accepts.
 *   - Not already settled, and not already in a transaction that is in flight.
 *   - On a chain we actually settle. TON's shared wallet and TRON's pooled wallets receive the
 *     payer's transfer directly: there is nothing of ours to move, and enqueuing them would be
 *     a sweep with no funds to sweep.
 */

/** An invoice due for settlement, in the shape the queue and the adapter both take. */
export interface DueSettlement extends SettlementRequest {
  readonly chain: ChainId;
}

export class SettlementSource {
  constructor(private readonly db: Database) {}

  /**
   * Whether this chain has anything for us to send at all.
   *
   * Read from the registry rather than configuration: a chain settles directly because of how
   * its transfers work, and no environment variable changes that.
   */
  static settles(chain: ChainId): boolean {
    return chainConfig(chain).settlement.kind !== 'direct';
  }

  /**
   * Invoices due on this chain, oldest first, excluding anything already in flight.
   *
   * Oldest first because a merchant waiting longest should be paid first, and because a batch
   * built from a stable order is a batch two processes would build the same way — which matters
   * when the second one is a deploy that has not stopped the first yet.
   *
   * `exclude` is the set of invoice ids already carried by a broadcast transaction. It is passed
   * in rather than read from the settlements table here, because the runner in memory and the
   * table on disk can briefly disagree — a broadcast that has not been recorded yet — and the
   * caller is the only place that knows both.
   */
  async due(
    chain: ChainId,
    options: { readonly limit?: number; readonly exclude?: readonly string[] } = {},
  ): Promise<readonly DueSettlement[]> {
    if (!SettlementSource.settles(chain)) return [];

    const rows = await this.db
      .select({
        invoiceId: invoices.id,
        depositAddress: invoices.depositAddress,
        payoutAddress: invoices.payoutAddress,
        amountPaid: invoices.amountPaid,
        symbol: assets.symbol,
        decimals: assets.decimals,
        kind: assets.kind,
        contract: assets.contract,
      })
      .from(invoices)
      .innerJoin(assets, eq(assets.id, invoices.assetId))
      .where(
        and(
          eq(invoices.chain, chain),
          eq(invoices.mode, 'live'),
          isNull(invoices.settledAt),
          or(eq(invoices.status, 'paid'), eq(invoices.status, 'overpaid')),
          /**
           * Something must actually have arrived.
           *
           * A paid invoice with a zero balance is not a state this system should be able to
           * reach, and settling one would spend gas to deploy a forwarder over an empty
           * address. Cheap to exclude, and the exclusion is the kind that stops a bug
           * elsewhere from becoming a bill.
           */
          sql`${invoices.amountPaid}::numeric > 0`,
          /**
           * Parameterised, not interpolated.
           *
           * These ids come from our own settlements table, so a literal would be safe today —
           * and it would be the line somebody copies to a place where the input is a merchant's
           * reference. There is no reason to write the unsafe shape at all.
           */
          ...(options.exclude && options.exclude.length > 0
            ? [notInArray(invoices.id, [...options.exclude])]
            : []),
        ),
      )
      .orderBy(asc(invoices.paidAt))
      .limit(options.limit ?? 100);

    return rows.map((row) => ({
      chain,
      invoiceId: row.invoiceId,
      depositAddress: row.depositAddress,
      payoutAddress: row.payoutAddress,
      amount: BigInt(row.amountPaid),
      asset: {
        symbol: row.symbol,
        chain,
        decimals: row.decimals,
        kind: row.kind as Asset['kind'],
        ...(row.contract === null ? {} : { contract: row.contract }),
      },
    }));
  }

  /**
   * Mark invoices settled, once a transaction carrying them has confirmed.
   *
   * Only on a confirmation, never on a broadcast. A transaction that was accepted by a node and
   * then dropped, replaced or reverted has moved nothing — and an invoice marked settled is one
   * nothing will ever look at again, so the optimistic version of this write is the one that
   * loses a merchant's money quietly.
   *
   * `settled_at` is set only where it is null, so a re-run of the same confirmation is a no-op
   * rather than a rewritten timestamp. Reconciliation reads that column to decide what to
   * investigate, and a date that moves is a date nobody can reason from.
   */
  async markSettled(invoiceIds: readonly string[], at: Date = new Date()): Promise<number> {
    if (invoiceIds.length === 0) return 0;
    const updated = await this.db
      .update(invoices)
      .set({ settledAt: at })
      .where(and(inArray(invoices.id, [...invoiceIds]), isNull(invoices.settledAt)))
      .returning({ id: invoices.id });
    return updated.length;
  }
}

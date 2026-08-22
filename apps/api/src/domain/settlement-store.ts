import { and, asc, count, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';

import type { ChainId } from '@avex/core';

import type { Database } from '../db/client.js';
import { settlements } from '../db/schema.js';

/**
 * Persistence for settlement transactions.
 *
 * The runner in `@avex/core` tracks its in-flight transactions in memory, which is
 * correct for a single continuous process and wrong the moment one restarts:
 * nothing then knows a transaction is outstanding at a given nonce, so a stuck one
 * can neither be found nor replaced, and every later nonce stays blocked behind it.
 *
 * This store is what survives the restart. The admin panel's settlement monitor
 * reads from it, but that is a by-product — the reason it exists is recovery.
 *
 * Money and gas are `bigint` in and `bigint` out. They cross the database boundary
 * as decimal strings because `numeric(78, 0)` is the only exact, orderable choice
 * for values that overflow a 64-bit integer.
 */

export interface RecordBroadcastInput {
  readonly chain: ChainId;
  readonly txHash: string;
  readonly nonce: number;
  readonly invoiceIds: readonly string[];
  readonly feePerGasWei: bigint;
  readonly gasLimit: bigint;
  /** Estimated at broadcast time, in micro-dollars. */
  readonly estimatedCostUsdMicros?: bigint | undefined;
  readonly broadcastAt?: Date | undefined;
}

export interface SettlementRow {
  readonly id: string;
  readonly chain: string;
  readonly txHash: string;
  readonly nonce: number;
  readonly invoiceIds: readonly string[];
  readonly status: 'pending' | 'confirmed' | 'reverted' | 'replaced';
  readonly feePerGasWei: bigint;
  readonly gasLimit: bigint;
  readonly gasUsed: bigint | null;
  readonly estimatedCostUsdMicros: bigint | null;
  readonly actualCostUsdMicros: bigint | null;
  readonly replacedByTxHash: string | null;
  readonly broadcastAt: Date;
  readonly confirmedAt: Date | null;
}

export interface ChainSettlementSummary {
  readonly chain: string;
  readonly pending: number;
  readonly confirmed: number;
  readonly reverted: number;
  readonly replaced: number;
  /** Pending for longer than the stuck threshold — the pipeline is blocked. */
  readonly stuck: readonly SettlementRow[];
  /** Lowest nonce still pending; nothing above it can confirm until it does. */
  readonly blockingNonce: number | null;
  readonly spentUsdMicros: bigint;
}

export class SettlementStore {
  constructor(private readonly db: Database) {}

  /**
   * Record a broadcast. Idempotent on `(chain, txHash)`.
   *
   * A re-broadcast of the same transaction — which happens when a process dies
   * between the node accepting it and the write landing — must not create a second
   * row claiming the same nonce, because that reads as exactly the bug this table
   * exists to surface.
   */
  async recordBroadcast(input: RecordBroadcastInput): Promise<void> {
    await this.db
      .insert(settlements)
      .values({
        chain: input.chain,
        txHash: input.txHash,
        nonce: input.nonce,
        invoiceIds: [...input.invoiceIds],
        feePerGasWei: input.feePerGasWei.toString(),
        gasLimit: input.gasLimit.toString(),
        estimatedCostUsdMicros: input.estimatedCostUsdMicros?.toString() ?? null,
        broadcastAt: input.broadcastAt ?? new Date(),
      })
      .onConflictDoNothing({ target: [settlements.chain, settlements.txHash] });
  }

  /**
   * Mark a transaction mined.
   *
   * A reverted settlement is recorded and never retried. The runner's reasoning
   * holds here: a settlement that reverted did so for a reason that will still be
   * true on the next attempt, and retrying spends gas to fail again.
   */
  async recordReceipt(
    chain: ChainId,
    txHash: string,
    receipt: {
      readonly status: 'success' | 'reverted';
      readonly gasUsed: bigint;
      readonly actualCostUsdMicros?: bigint | undefined;
    },
  ): Promise<void> {
    await this.db
      .update(settlements)
      .set({
        status: receipt.status === 'success' ? 'confirmed' : 'reverted',
        gasUsed: receipt.gasUsed.toString(),
        actualCostUsdMicros: receipt.actualCostUsdMicros?.toString() ?? null,
        confirmedAt: new Date(),
      })
      .where(and(eq(settlements.chain, chain), eq(settlements.txHash, txHash)));
  }

  /**
   * Note that one transaction superseded another at the same nonce.
   *
   * Both rows are kept. The replaced one is history — "we bumped the fee at 14:02
   * and it confirmed at 14:05" is the sentence someone needs during an incident, and
   * deleting the first half of it saves nothing.
   */
  async recordReplacement(
    chain: ChainId,
    originalTxHash: string,
    replacementTxHash: string,
  ): Promise<void> {
    await this.db
      .update(settlements)
      .set({ status: 'replaced', replacedByTxHash: replacementTxHash })
      .where(and(eq(settlements.chain, chain), eq(settlements.txHash, originalTxHash)));
  }

  /**
   * Transactions still outstanding, oldest first.
   *
   * This is what a restarting runner reads to rebuild its in-flight set before
   * broadcasting anything — without it, it would adopt the chain nonce and could
   * collide with a transaction it has forgotten.
   */
  async pending(chain: ChainId): Promise<readonly SettlementRow[]> {
    const rows = await this.db
      .select()
      .from(settlements)
      .where(and(eq(settlements.chain, chain), eq(settlements.status, 'pending')))
      .orderBy(asc(settlements.nonce));
    return rows.map(toRow);
  }

  /**
   * Invoices that must not be handed to a new settlement, and why.
   *
   * Two states, and each is a way of paying twice or paying for nothing:
   *
   * **Pending.** A transaction carrying them is in the mempool. If it was broadcast by a process
   * that has since died, nothing in memory knows about it — so without this the invoices look due
   * and a second transaction goes out for money that is already on its way. One of the two
   * flushes then finds an empty address and the gas for it is spent for nothing.
   *
   * **Reverted.** Gas was spent and nothing moved. Whatever made it revert — a token that paused
   * transfers, a payout address that rejects them, an assumption that was wrong — is still true,
   * so retrying immediately is a loop that bills us every pass. `recordReceipt` says the same
   * thing about the row; this is what makes it hold. An operator clears it by looking at why.
   */
  async blockedInvoiceIds(chain: ChainId): Promise<readonly string[]> {
    const rows = await this.db
      .select({ invoiceIds: settlements.invoiceIds, status: settlements.status })
      .from(settlements)
      .where(
        and(
          eq(settlements.chain, chain),
          inArray(settlements.status, ['pending', 'reverted']),
        ),
      );
    return [...new Set(rows.flatMap((row) => row.invoiceIds))];
  }

  /** Per-chain counts, stuck transactions, and the nonce holding up the queue. */
  async summary(
    chain: ChainId,
    options: { readonly stuckAfterMs: number; readonly spendWindowMs: number; readonly now?: Date },
  ): Promise<ChainSettlementSummary> {
    const now = options.now ?? new Date();

    const byStatus = await this.db
      .select({ status: settlements.status, value: count() })
      .from(settlements)
      .where(eq(settlements.chain, chain))
      .groupBy(settlements.status);

    const tally = Object.fromEntries(byStatus.map((row) => [row.status, row.value])) as Record<
      string,
      number | undefined
    >;

    const stuckBefore = new Date(now.getTime() - options.stuckAfterMs);
    const stuck = await this.db
      .select()
      .from(settlements)
      .where(
        and(
          eq(settlements.chain, chain),
          eq(settlements.status, 'pending'),
          lt(settlements.broadcastAt, stuckBefore),
        ),
      )
      .orderBy(asc(settlements.nonce));

    const [lowest] = await this.db
      .select({ nonce: settlements.nonce })
      .from(settlements)
      .where(and(eq(settlements.chain, chain), eq(settlements.status, 'pending')))
      .orderBy(asc(settlements.nonce))
      .limit(1);

    /**
     * Spend inside the window, actual where known and estimated where not.
     *
     * A pending transaction has no actual cost yet but has already committed the
     * funds, so leaving it out would understate the spend and let the cap be
     * exceeded by exactly the transactions still in flight.
     */
    const [spend] = await this.db
      .select({
        total: sql<string>`coalesce(sum(coalesce(
          ${settlements.actualCostUsdMicros}, ${settlements.estimatedCostUsdMicros}, 0
        )), 0)::text`,
      })
      .from(settlements)
      .where(
        and(
          eq(settlements.chain, chain),
          // `gte` rather than a raw `sql` comparison: a Date interpolated into a
          // template is passed to the driver unmapped, which throws at bind time.
          gte(settlements.broadcastAt, new Date(now.getTime() - options.spendWindowMs)),
          inArray(settlements.status, ['pending', 'confirmed', 'reverted']),
        ),
      );

    return {
      chain,
      pending: tally.pending ?? 0,
      confirmed: tally.confirmed ?? 0,
      reverted: tally.reverted ?? 0,
      replaced: tally.replaced ?? 0,
      stuck: stuck.map(toRow),
      blockingNonce: lowest?.nonce ?? null,
      spentUsdMicros: BigInt(spend?.total ?? '0'),
    };
  }

  /** Most recent settlements across all chains, for the monitor's table. */
  async recent(limit = 50): Promise<readonly SettlementRow[]> {
    const rows = await this.db
      .select()
      .from(settlements)
      .orderBy(desc(settlements.broadcastAt))
      .limit(Math.min(200, Math.max(1, limit)));
    return rows.map(toRow);
  }
}

function toRow(row: typeof settlements.$inferSelect): SettlementRow {
  return {
    id: row.id,
    chain: row.chain,
    txHash: row.txHash,
    nonce: row.nonce,
    invoiceIds: row.invoiceIds,
    status: row.status,
    feePerGasWei: BigInt(row.feePerGasWei),
    gasLimit: BigInt(row.gasLimit),
    gasUsed: row.gasUsed === null ? null : BigInt(row.gasUsed),
    estimatedCostUsdMicros:
      row.estimatedCostUsdMicros === null ? null : BigInt(row.estimatedCostUsdMicros),
    actualCostUsdMicros: row.actualCostUsdMicros === null ? null : BigInt(row.actualCostUsdMicros),
    replacedByTxHash: row.replacedByTxHash,
    broadcastAt: row.broadcastAt,
    confirmedAt: row.confirmedAt,
  };
}

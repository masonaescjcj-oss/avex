import type { BlockRef, ChainId, PollCursor, WatchStateStore } from '@avex/core';
import { and, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { payments, seenBlocks, watchCursors } from '../db/schema.js';

/**
 * Database-backed watcher state.
 *
 * Persisted rather than held in memory so a restart resumes where it stopped.
 * Rescanning from genesis would be slow; worse, forgetting recent block hashes
 * would make the first reorg after a restart undetectable.
 */
export class DatabaseWatchStore implements WatchStateStore {
  constructor(
    private readonly db: Database,
    /**
     * How many block hashes to keep. Must stay deeper than the watcher's
     * `blockMemory`, or pruning would silently cap how deep a reorg can be found.
     */
    private readonly retainBlocks = 512,
  ) {}

  async loadCursor(chain: ChainId) {
    const [row] = await this.db
      .select()
      .from(watchCursors)
      .where(eq(watchCursors.chain, chain))
      .limit(1);
    return { cursor: row?.cursor ?? null, scannedTo: row?.scannedTo ?? null };
  }

  async saveCursor(chain: ChainId, cursor: PollCursor, scannedTo: number): Promise<void> {
    await this.db
      .insert(watchCursors)
      .values({ chain, cursor, scannedTo, lastPolledAt: new Date() })
      .onConflictDoUpdate({
        target: watchCursors.chain,
        set: { cursor, scannedTo, lastPolledAt: new Date() },
      });
  }

  async recordError(chain: ChainId, message: string): Promise<void> {
    await this.db
      .insert(watchCursors)
      .values({ chain, lastErrorAt: new Date(), lastError: message })
      .onConflictDoUpdate({
        target: watchCursors.chain,
        // The cursor is untouched: a failed poll has not made progress, and
        // advancing it here would skip the range that failed.
        set: { lastErrorAt: new Date(), lastError: message },
      });
  }

  async recentBlocks(chain: ChainId, limit: number): Promise<readonly BlockRef[]> {
    const rows = await this.db
      .select({ number: seenBlocks.number, hash: seenBlocks.hash })
      .from(seenBlocks)
      .where(eq(seenBlocks.chain, chain))
      .orderBy(desc(seenBlocks.number))
      .limit(limit);
    return rows;
  }

  async rememberBlocks(chain: ChainId, blocks: readonly BlockRef[]): Promise<void> {
    if (blocks.length === 0) return;

    for (const block of blocks) {
      await this.db
        .insert(seenBlocks)
        .values({ chain, number: block.number, hash: block.hash })
        .onConflictDoUpdate({
          target: [seenBlocks.chain, seenBlocks.number],
          // A changed hash at a known height is exactly what reorg detection
          // compares against, so the newest observation wins.
          set: { hash: block.hash, seenAt: new Date() },
        });
    }

    // Prune well below the tip, or this table grows for the life of the chain.
    const highest = Math.max(...blocks.map((block) => block.number));
    await this.db
      .delete(seenBlocks)
      .where(and(eq(seenBlocks.chain, chain), lt(seenBlocks.number, highest - this.retainBlocks)));
  }

  async forgetBlocksAbove(chain: ChainId, number: number): Promise<void> {
    await this.db
      .delete(seenBlocks)
      .where(and(eq(seenBlocks.chain, chain), gt(seenBlocks.number, number)));
  }

  /**
   * Credited payments above a height, as watcher payment keys.
   *
   * Already-reversed rows are excluded: reversing twice would be harmless but the
   * duplicated audit entries make an incident harder to read afterwards.
   */
  async creditedAbove(chain: ChainId, number: number): Promise<readonly string[]> {
    const rows = await this.db
      .select({
        txHash: payments.txHash,
        transferIndex: payments.transferIndex,
      })
      .from(payments)
      .where(
        and(
          eq(payments.chain, chain),
          gt(payments.blockNumber, number),
          isNull(payments.reversedAt),
        ),
      );

    return rows.map((row) => `${chain}:${row.txHash}:${row.transferIndex}`);
  }

  /** Watcher health, for the operator dashboard. */
  async status(): Promise<
    readonly {
      chain: string;
      scannedTo: number | null;
      lastPolledAt: string | null;
      lastError: string | null;
      blocksRemembered: number;
    }[]
  > {
    const cursors = await this.db.select().from(watchCursors);
    const counts = await this.db
      .select({ chain: seenBlocks.chain, count: sql<number>`count(*)::int` })
      .from(seenBlocks)
      .groupBy(seenBlocks.chain);

    const byChain = new Map(counts.map((row) => [row.chain, row.count]));

    return cursors.map((row) => ({
      chain: row.chain,
      scannedTo: row.scannedTo,
      lastPolledAt: row.lastPolledAt?.toISOString() ?? null,
      lastError: row.lastError,
      blocksRemembered: byChain.get(row.chain) ?? 0,
    }));
  }
}

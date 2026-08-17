import type { ChainAdapter, PollCursor } from '../chains/ChainAdapter.js';
import type { ChainId, IncomingPayment } from '../types.js';
import { paymentKey } from '../types.js';

/**
 * Chain watcher.
 *
 * Finds incoming transfers and credits them, exactly once, and withdraws credits
 * whose transactions have left the canonical chain.
 *
 * The second half is the part that is easy to skip and expensive to omit. A
 * confirmed transaction can disappear in a reorg; if the credit stays, the
 * merchant has been paid for a payment that no longer exists and nothing in the
 * system will ever notice.
 */

/** Block identity, the minimum needed to tell a reorg from ordinary progress. */
export interface BlockRef {
  readonly number: number;
  readonly hash: string;
}

/** Chain access the watcher needs beyond polling for transfers. */
export interface BlockSource {
  /** Current head. */
  head(): Promise<BlockRef>;
  /** Block at a height, or null if the chain is shorter than that. */
  blockAt(number: number): Promise<BlockRef | null>;
}

/** Persistence, so a restart resumes rather than rescanning from genesis. */
export interface WatchStateStore {
  loadCursor(chain: ChainId): Promise<{ cursor: PollCursor; scannedTo: number | null }>;
  saveCursor(chain: ChainId, cursor: PollCursor, scannedTo: number): Promise<void>;
  recordError(chain: ChainId, message: string): Promise<void>;

  /** Recent block hashes, newest first. */
  recentBlocks(chain: ChainId, limit: number): Promise<readonly BlockRef[]>;
  /**
   * Record block hashes, replacing any already stored at the same heights.
   *
   * Implementations should prune well below the newest height they hold, or the
   * table grows for the life of the chain. Retention must stay deeper than
   * `blockMemory`, since anything shallower silently caps how deep a reorg can be
   * detected.
   */
  rememberBlocks(chain: ChainId, blocks: readonly BlockRef[]): Promise<void>;
  /** Drop remembered blocks strictly above a height, after a rewind. */
  forgetBlocksAbove(chain: ChainId, number: number): Promise<void>;

  /** Credited payments strictly above a height — the ones a rewind must revisit. */
  creditedAbove(chain: ChainId, number: number): Promise<readonly string[]>;
}

/** What the watcher does with a transfer once it has been matched. */
export interface PaymentSink {
  /** Credit a transfer. Must be idempotent on `chain:txHash:transferIndex`. */
  credit(payment: IncomingPayment): Promise<void>;
  /** Withdraw a credit whose transaction is no longer in the chain. */
  reverse(paymentKey: string, reason: string): Promise<void>;
}

export interface WatcherConfig {
  /**
   * How far to rewind when a reorg is found.
   *
   * Must exceed the deepest reorg a chain realistically produces, because a
   * rewind that stops short leaves the divergent range credited. Polygon PoS is
   * the reason this is configurable rather than a constant.
   */
  readonly reorgDepth: number;
  /** How many block hashes to retain. Must be at least `reorgDepth`. */
  readonly blockMemory: number;
  /** Blocks per poll, kept under the provider's getLogs range cap. */
  readonly maxBlocksPerPoll: number;
}

export const DEFAULT_WATCHER: WatcherConfig = {
  reorgDepth: 64,
  blockMemory: 128,
  maxBlocksPerPoll: 500,
};

export interface PollOutcome {
  readonly chain: ChainId;
  readonly credited: number;
  readonly ignored: number;
  /** Set when a reorg was detected, with the height rewound to. */
  readonly reorg: { readonly detectedAt: number; readonly rewoundTo: number } | null;
  readonly reversed: number;
  readonly scannedTo: number;
  readonly note: string;
}

export class Watcher {
  constructor(
    private readonly chain: ChainId,
    private readonly adapter: ChainAdapter,
    private readonly blocks: BlockSource,
    private readonly state: WatchStateStore,
    private readonly sink: PaymentSink,
    private readonly config: WatcherConfig = DEFAULT_WATCHER,
    private readonly log: (message: string) => void = () => {},
  ) {
    if (config.blockMemory < config.reorgDepth) {
      // Otherwise a reorg deeper than memory is undetectable, silently.
      throw new Error('blockMemory must be at least reorgDepth');
    }
  }

  /**
   * One pass: check for a reorg, rewind if needed, then scan forward.
   *
   * Reorg handling comes first on purpose. Scanning forward from a cursor that
   * sits on an orphaned block would credit transfers from a chain that no longer
   * exists.
   */
  async poll(): Promise<PollOutcome> {
    const reorg = await this.detectReorg();
    let reversed = 0;

    if (reorg) {
      reversed = await this.rewind(reorg.rewoundTo);
    }

    const { cursor } = await this.state.loadCursor(this.chain);
    const head = await this.blocks.head();

    const result = await this.adapter.poll(cursor);

    let credited = 0;
    let ignored = 0;

    for (const payment of result.payments) {
      // Credit only what is final. Anything shallower can still be reorganised
      // out, and reversing a credit is more disruptive than waiting for it.
      if (payment.confirmations <= 0) {
        ignored += 1;
        continue;
      }

      try {
        await this.sink.credit(payment);
        credited += 1;
      } catch (error) {
        // One bad transfer must not stall the whole chain behind it.
        ignored += 1;
        this.log(
          `${this.chain}: could not credit ${paymentKey(payment)}: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }

    const scannedTo = this.highestBlock(result.payments, head.number);
    await this.rememberRange(scannedTo);
    await this.state.saveCursor(this.chain, result.cursor, scannedTo);

    return {
      chain: this.chain,
      credited,
      ignored,
      reorg,
      reversed,
      scannedTo,
      note: reorg
        ? `reorg at ${reorg.detectedAt}, rewound to ${reorg.rewoundTo}, reversed ${reversed}`
        : `credited ${credited}, ignored ${ignored}, scanned to ${scannedTo}`,
    };
  }

  /**
   * Compare remembered block hashes against the chain as it is now.
   *
   * Walks newest to oldest looking for the *deepest* disagreement, and rewinds to
   * the shallowest block that still verifiably matches.
   *
   * Stopping at the first disagreement found would be wrong. Walking down from the
   * tip, the first mismatch is the shallowest one, and a fork deeper than
   * `reorgDepth` below it would be left credited — which is the exact failure this
   * whole mechanism exists to prevent. Rewinding to a block whose hash was just
   * confirmed identical needs no safety margin, because it is proven good.
   */
  private async detectReorg(): Promise<PollOutcome['reorg']> {
    const remembered = await this.state.recentBlocks(this.chain, this.config.blockMemory);
    if (remembered.length === 0) return null;

    let deepestMismatch: number | null = null;
    let agreedAt: number | null = null;

    for (const block of remembered) {
      const current = await this.blocks.blockAt(block.number);

      // A chain shorter than a block we remember is itself a rollback: that block
      // was removed and not yet replaced. Keep looking for solid ground below it.
      if (current === null) {
        deepestMismatch = block.number;
        continue;
      }

      if (current.hash === block.hash) {
        agreedAt = block.number;
        break;
      }

      this.log(
        `${this.chain}: block ${block.number} was ${block.hash}, is now ${current.hash}`,
      );
      deepestMismatch = block.number;
    }

    if (deepestMismatch === null) return null;

    // With no agreement anywhere in memory, the fork is deeper than we can see, so
    // fall back to a margin below the oldest block we know about.
    const oldest = remembered[remembered.length - 1]!.number;
    const rewoundTo =
      agreedAt !== null ? agreedAt : Math.max(0, oldest - this.config.reorgDepth);

    return { detectedAt: deepestMismatch, rewoundTo };
  }

  /**
   * Withdraw credits above a height and move the cursor back.
   *
   * Reversal comes before the cursor moves. If the process dies between the two,
   * the next pass re-scans a range whose credits are already withdrawn — which
   * `credit` being idempotent makes harmless. The opposite order would leave
   * credits standing for transactions the watcher no longer intends to revisit.
   */
  private async rewind(toBlock: number): Promise<number> {
    const affected = await this.state.creditedAbove(this.chain, toBlock);

    for (const key of affected) {
      await this.sink.reverse(key, `reorg: rewound to block ${toBlock}`);
    }

    await this.state.forgetBlocksAbove(this.chain, toBlock);
    await this.state.saveCursor(this.chain, String(toBlock), toBlock);

    this.log(
      `${this.chain}: rewound to ${toBlock}, reversed ${affected.length} credited payment(s)`,
    );
    return affected.length;
  }

  private highestBlock(payments: readonly IncomingPayment[], headNumber: number): number {
    // Never claim to have scanned past the head, even if a payment reports a
    // higher block than the head we read a moment earlier.
    const highestPayment = payments.reduce(
      (highest, payment) => Math.max(highest, payment.blockNumber),
      0,
    );
    return Math.min(Math.max(highestPayment, headNumber), headNumber);
  }

  /**
   * Remember hashes below the new tip so the next pass can spot a reorg.
   *
   * Covers `blockMemory`, not `reorgDepth`. Remembering only as far as the rewind
   * depth would cap detection at that depth too — a fork below it would find no
   * remembered block to disagree with, and pass unnoticed. Memory has to be deeper
   * than the rewind it informs.
   */
  private async rememberRange(scannedTo: number): Promise<void> {
    const from = Math.max(0, scannedTo - this.config.blockMemory + 1);
    const refs: BlockRef[] = [];

    for (let number = scannedTo; number >= from; number--) {
      const block = await this.blocks.blockAt(number);
      if (block) refs.push(block);
    }

    if (refs.length > 0) await this.state.rememberBlocks(this.chain, refs);
  }

  /** Wrap a pass so a transient RPC failure is recorded rather than thrown away. */
  async pollSafely(): Promise<PollOutcome | null> {
    try {
      return await this.poll();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.state.recordError(this.chain, message);
      this.log(`${this.chain}: poll failed: ${message}`);
      return null;
    }
  }
}

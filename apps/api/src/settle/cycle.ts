import { SettlementQueue } from '@avex/core';
import type {
  Alert,
  ChainAdapter,
  ChainId,
  ChainSigner,
  FeePolicy,
  GasSnapshot,
  SettlementCall,
  SettlementQueueConfig,
  SettlementRequest,
  SettlementRunner,
} from '@avex/core';

import type { SettlementSource } from '../domain/settlement-source.js';
import type { SettlementStore } from '../domain/settlement-store.js';

/**
 * One pass of settlement, on one chain.
 *
 * Everything this needs already existed and nothing joined it up. `SettlementQueue` decides when
 * a batch is worth broadcasting, `SettlementRunner` holds the nonce and the spend limits,
 * `SettlementStore` is the record, and `SettlementSource` finds the invoices — and no production
 * entry point constructed any of them. So on an EVM chain a payment was detected, credited, and
 * the money stayed at the deposit address indefinitely. This class is the missing join, kept
 * apart from the process that runs it so a pass can be tested without a timer.
 *
 * ## The order of the steps is the design
 *
 * Receipts first, then new work. A transaction that confirmed frees its invoices from the
 * in-flight set, and one that is stuck gets replaced — and until the stuck one moves, nothing
 * behind its nonce can confirm, so broadcasting more would be adding to a queue that cannot
 * drain. Doing it the other way round means the first thing a busy chain does is make itself
 * busier.
 *
 * ## What is recorded, and when
 *
 * A broadcast is written to the settlements table before it is anything else, because the row is
 * how a process that dies knows what it left in flight. An invoice is marked settled only when a
 * transaction carrying it has confirmed — never on a broadcast, because a transaction can be
 * dropped, replaced or reverted, and an invoice marked settled is one nothing will ever look at
 * again.
 */

export interface CycleReport {
  readonly chain: ChainId;
  /** Invoices found due and handed to the queue this pass. */
  readonly enqueued: number;
  readonly broadcast: readonly string[];
  readonly confirmed: number;
  readonly reverted: number;
  readonly replaced: number;
  /** Invoices whose `settled_at` was written this pass. */
  readonly settled: number;
  readonly deferred: number;
  /** Whatever the queue had to say about why it did or did not go. */
  readonly note: string;
  /** Pending rows from before this process started, which it cannot replace. */
  readonly orphans: number;
}

export interface CycleDependencies {
  readonly chain: ChainId;
  readonly adapter: ChainAdapter;
  readonly runner: SettlementRunner;
  readonly feePolicy: FeePolicy;
  readonly queueConfig?: SettlementQueueConfig;
  readonly signer: ChainSigner;
  readonly source: SettlementSource;
  readonly store: SettlementStore;
  /**
   * A gas snapshot, from the same cache the fee quoting uses.
   *
   * Null is a refusal to broadcast rather than a reason to guess: a transaction needs a fee, and
   * a fee invented without a live price is either rejected by the mempool or an overpayment
   * nobody authorised.
   */
  readonly gas: () => Promise<GasSnapshot | null>;
  readonly log?: (message: string, data?: unknown) => void;
  /** How many invoices to consider in one pass. The queue's own batch cap applies after. */
  readonly batchLimit?: number;
  /**
   * Where the runner's alerts go. Absent means they stay in the log.
   *
   * Drained here rather than by the process loop because this is the only place that knows a
   * pass has finished — and an alert raised mid-pass that nobody drains is a buffer that grows
   * until the process restarts, which is the one moment nobody is reading it.
   */
  readonly alerts?: { forward(alerts: readonly Alert[], now?: number): Promise<void> };
}

export class SettlementCycle {
  private readonly log: (message: string, data?: unknown) => void;
  /**
   * Owned rather than injected, because the two refer to each other.
   *
   * The queue broadcasts through this class and this class drains the queue. Passing it in meant
   * a caller constructing one with a placeholder and patching it afterwards, which is a shape
   * that invites somebody to forget the second half.
   */
  private readonly queue: SettlementQueue;

  constructor(private readonly deps: CycleDependencies) {
    this.log = deps.log ?? (() => {});
    this.queue = new SettlementQueue(
      new Map<ChainId, ChainAdapter>([[deps.chain, deps.adapter]]),
      deps.feePolicy,
      this.broadcaster(),
      ...(deps.queueConfig === undefined ? [] : ([deps.queueConfig] as const)),
    );
  }

  /** The depth of the queue, for a caller that logs it. */
  depth(): number {
    return this.queue.depth(this.deps.chain);
  }

  /**
   * Adopt the chain's nonce, and account for anything a previous process left behind.
   *
   * Called once before the first pass. `SettlementRunner.start` reads the pending nonce, which
   * counts transactions already in the mempool — so the nonce is safe on its own. What is not
   * safe is forgetting the transactions themselves: their receipts would never be read, and the
   * invoices they carry would never be marked settled, so the next pass would find them due and
   * settle them a second time. `reconcileOrphans` is what closes that.
   */
  async start(): Promise<{ readonly nonce: number; readonly orphans: number }> {
    const nonce = await this.deps.runner.start();
    const orphans = await this.reconcileOrphans();
    return { nonce, orphans };
  }

  async once(now: number = Date.now()): Promise<CycleReport> {
    const snapshot = await this.deps.gas();

    let confirmed = 0;
    let reverted = 0;
    let replaced = 0;
    let settled = 0;

    // 1. Receipts, before anything new is sent. See the note on the class.
    if (snapshot !== null) {
      const outcome = await this.deps.runner.reconcile(snapshot, now);
      confirmed = outcome.confirmed.length;
      reverted = outcome.reverted.length;
      replaced = outcome.replaced.length;

      for (const transaction of outcome.confirmed) {
        /**
         * The receipt is read again for the figures.
         *
         * `reconcile` reports which transactions confirmed but not what they cost, and the gas
         * limit is not the gas used — recording the limit would overstate every settlement in
         * the table the cost reporting reads from, by whatever headroom the estimate carried.
         * One extra call for a figure that does not change once it exists.
         */
        const receipt = await this.deps.signer.receipt(transaction.hash);
        await this.deps.store.recordReceipt(this.deps.chain, transaction.hash, {
          status: 'success',
          gasUsed: receipt?.gasUsed ?? transaction.gasLimit,
        });
        settled += await this.deps.source.markSettled(transaction.invoiceIds, new Date(now));
      }

      for (const transaction of outcome.reverted) {
        /**
         * Recorded, and the invoices are deliberately left unsettled.
         *
         * A settlement that reverted spent gas and moved nothing. Marking the invoices settled
         * would hide it; retrying it automatically would spend more gas on the same failing
         * assumption. So the row says `reverted`, the invoices stay due, and the runner has
         * already raised a critical alert — the next pass will try again only because a chain
         * that was too expensive or a token that was paused is a condition that changes.
         */
        const receipt = await this.deps.signer.receipt(transaction.hash);
        await this.deps.store.recordReceipt(this.deps.chain, transaction.hash, {
          status: 'reverted',
          gasUsed: receipt?.gasUsed ?? transaction.gasLimit,
        });
      }

      for (const swap of outcome.replaced) {
        await this.deps.store.recordReplacement(this.deps.chain, swap.from, swap.to);
      }
    }

    /**
     * 2. Whatever is due, minus everything that must not be sent again.
     *
     * Three sources of exclusion, and each closes a way of paying twice. The runner knows what
     * it broadcast in this process. The table knows what a *previous* process broadcast that is
     * still pending — invisible from memory, and the reason a restart used to be able to
     * double-settle. And it knows what reverted, which must wait for somebody to look at why
     * rather than be retried on the next pass, forever, at our expense.
     */
    const due = await this.deps.source.due(this.deps.chain, {
      ...(this.deps.batchLimit === undefined ? {} : { limit: this.deps.batchLimit }),
      exclude: [
        ...this.inFlightInvoiceIds(),
        ...(await this.deps.store.blockedInvoiceIds(this.deps.chain)),
      ],
    });
    for (const request of due) this.queue.enqueue(request, now);

    // 3. Let the queue decide whether now is the moment.
    const reports = await this.queue.drain(now);
    const report = reports.find((entry) => entry.chain === this.deps.chain);

    /**
     * 4. Whatever the runner wanted somebody to know, after the work rather than before.
     *
     * Last because the most important alerts are raised *by* the work: a gas wallet that cannot
     * cover a settlement, a nonce that is stuck, a batch that reverted. Draining first would
     * forward the previous pass's news and leave this pass's in the buffer for thirty seconds.
     */
    await this.deps.alerts?.forward(this.deps.runner.takeAlerts(), now);

    return {
      chain: this.deps.chain,
      enqueued: due.length,
      broadcast: report?.broadcast ?? [],
      confirmed,
      reverted,
      replaced,
      settled,
      deferred: report?.deferred ?? this.queue.depth(this.deps.chain),
      note: snapshot === null ? 'no gas snapshot: nothing broadcast' : (report?.note ?? 'nothing due'),
      /**
       * Counted at startup, not per pass.
       *
       * An orphan is a transaction a *previous* process left in flight, so there is nothing to
       * find on a later pass: either its receipt arrived and it stopped being one, or it is the
       * same one `start` already reported. Recounting it every pass would read as a problem
       * getting worse.
       */
      orphans: 0,
    };
  }

  /**
   * The broadcaster the queue hands prepared calls to.
   *
   * This is the seam between "when to settle" and "how", and it is where the record is written:
   * the runner returns a hash, and the row goes in before this returns. A process that died in
   * between would leave a transaction in the mempool that nothing remembered — which is exactly
   * the orphan case, and why `recordBroadcast` is idempotent on `(chain, txHash)`.
   */
  broadcaster(): {
    settle(
      batch: readonly SettlementRequest[],
      call: SettlementCall,
    ): Promise<
      | { readonly ok: true; readonly transaction: { readonly hash: string } }
      | { readonly ok: false; readonly reason: string; readonly detail: string }
    >;
  } {
    return {
      settle: async (batch, call) => {
        const snapshot = await this.deps.gas();
        if (snapshot === null) {
          return {
            ok: false,
            reason: 'no_gas_snapshot',
            detail: 'no live gas price, so no fee could be set',
          };
        }

        const outcome = await this.deps.runner.settle(batch, call, snapshot);
        if (!outcome.ok) return outcome;

        await this.deps.store.recordBroadcast({
          chain: this.deps.chain,
          txHash: outcome.transaction.hash,
          nonce: outcome.transaction.nonce,
          invoiceIds: outcome.transaction.invoiceIds,
          feePerGasWei: outcome.transaction.feePerGasWei,
          gasLimit: outcome.transaction.gasLimit,
        });

        return outcome;
      },
    };
  }

  /**
   * Invoice ids the runner is already carrying.
   *
   * From the runner rather than the table, because the runner is ahead of it: a broadcast is in
   * memory before the row is written, and a pass that read the table in that instant would find
   * the invoice due and settle it twice.
   */
  private inFlightInvoiceIds(): readonly string[] {
    return this.deps.runner.inFlightInvoiceIds();
  }

  /**
   * Pending rows this process did not broadcast, resolved as far as they can be.
   *
   * A previous process broadcast them and died. Their receipts are readable — that is enough to
   * mark their invoices settled or record a revert, which is what stops the next pass paying
   * twice. What cannot be done from here is replacing one that is stuck: the table records the
   * nonce but not the call, so there is nothing to re-broadcast. That case gets a line an
   * operator has to read, which is the honest answer rather than a guess at what the
   * transaction contained.
   */
  private async reconcileOrphans(): Promise<number> {
    const pending = await this.deps.store.pending(this.deps.chain);
    let unresolved = 0;

    for (const row of pending) {
      const receipt = await this.deps.signer.receipt(row.txHash);
      if (receipt === null) {
        unresolved += 1;
        this.log('settlement from a previous process is still pending', {
          chain: this.deps.chain,
          txHash: row.txHash,
          nonce: row.nonce,
          invoices: row.invoiceIds.length,
          detail:
            'its receipt will be read on a later pass. It cannot be replaced from here: the ' +
            'record holds the nonce but not the call.',
        });
        continue;
      }

      await this.deps.store.recordReceipt(this.deps.chain, row.txHash, {
        status: receipt.status,
        gasUsed: receipt.gasUsed,
      });
      if (receipt.status === 'success') {
        const settled = await this.deps.source.markSettled(row.invoiceIds);
        this.log('adopted a settlement from a previous process', {
          chain: this.deps.chain,
          txHash: row.txHash,
          settled,
        });
      } else {
        this.log('a settlement from a previous process had reverted', {
          chain: this.deps.chain,
          txHash: row.txHash,
          invoices: row.invoiceIds.length,
        });
      }
    }

    return unresolved;
  }
}

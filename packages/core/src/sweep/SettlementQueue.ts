import type {
  ChainAdapter,
  SettlementCall,
  SettlementRequest,
} from '../chains/ChainAdapter.js';
import { chainConfig } from '../chains/registry.js';
import type { FeePolicy } from '../fees/FeePolicy.js';
import type { ChainId, GasSnapshot } from '../types.js';

export interface SettlementQueueConfig {
  /**
   * How long funds may wait for a cheaper block before we settle anyway.
   * Without this bound, a chain that stays expensive would hold merchant funds
   * indefinitely — cheap, but a broken product.
   */
  readonly maxDeferralMs: number;
  /** Upper bound on invoices per settlement transaction. */
  readonly maxBatchSize: number;
  readonly maxAttempts: number;
}

export const DEFAULT_QUEUE_CONFIG: SettlementQueueConfig = {
  maxDeferralMs: 6 * 60 * 60 * 1000,
  maxBatchSize: 50,
  maxAttempts: 5,
};

interface QueueItem {
  readonly request: SettlementRequest;
  readonly enqueuedAt: number;
  attempts: number;
}

/**
 * Who actually broadcasts. `SettlementRunner` implements this.
 *
 * The queue decides *when* — hold for a cheaper block, batch, give up after a deadline. The
 * runner decides *whether and how*: against a spend cap and a per-transaction ceiling, with a
 * nonce it owns and a record of what is outstanding. Splitting them is what left one settlement
 * path instead of two, and it is why this is a parameter rather than something the adapter does.
 */
export interface Broadcaster {
  settle(
    batch: readonly SettlementRequest[],
    call: SettlementCall,
    snapshot: GasSnapshot,
    now?: number,
  ): Promise<
    | { readonly ok: true; readonly transaction: { readonly hash: string } }
    | { readonly ok: false; readonly reason: string; readonly detail: string }
  >;
}

export interface DrainReport {
  readonly chain: ChainId;
  /** Hashes broadcast for this chain. Empty when the batch was held or refused. */
  readonly broadcast: readonly string[];
  readonly deferred: number;
  readonly failed: number;
  readonly note: string;
}

export type QueueLogger = (message: string) => void;

/**
 * Holds settlements until the chain is cheap, then batches them.
 *
 * This is the single highest-leverage cost control in the system. Funds sit at
 * an address that can only pay their merchant, so deferring is safe, and the
 * difference between settling at the moment of payment and settling at a moment
 * of our choosing is roughly an order of magnitude on Ethereum during a spike.
 */
export class SettlementQueue {
  private readonly pending = new Map<ChainId, QueueItem[]>();

  constructor(
    private readonly adapters: ReadonlyMap<ChainId, ChainAdapter>,
    private readonly feePolicy: FeePolicy,
    /** Where a prepared batch goes. See `Broadcaster`. */
    private readonly broadcaster: Broadcaster,
    private readonly config: SettlementQueueConfig = DEFAULT_QUEUE_CONFIG,
    private readonly log: QueueLogger = () => {},
  ) {}

  enqueue(request: SettlementRequest, now: number = Date.now()): void {
    const adapter = this.adapters.get(request.asset.chain);
    if (!adapter) throw new Error(`no adapter for chain ${request.asset.chain}`);

    /**
     * Chains that settle on receipt have nothing to enqueue.
     *
     * Asked of the registry rather than of the address model, because two different models
     * answer yes and for the same reason: TON's one shared address and TRON's pool of the
     * merchant's own addresses both receive the payer's transfer directly, so the funds are
     * already where they are going. Keying off `addressModel === 'shared-memo'` — which is what
     * this did — silently enqueued every pooled invoice for a sweep that has no signer, no
     * destination different from the one it is already at, and nothing to move.
     */
    if (chainConfig(adapter.chain).settlement.kind === 'direct') {
      this.log(`${request.invoiceId}: ${adapter.chain} settles on receipt, not enqueued`);
      return;
    }

    const queue = this.pending.get(adapter.chain) ?? [];
    queue.push({ request, enqueuedAt: now, attempts: 0 });
    this.pending.set(adapter.chain, queue);
  }

  depth(chain: ChainId): number {
    return this.pending.get(chain)?.length ?? 0;
  }

  /** Run one pass over every chain with pending work. */
  async drain(now: number = Date.now()): Promise<readonly DrainReport[]> {
    const reports: DrainReport[] = [];

    for (const [chain, queue] of this.pending) {
      if (queue.length === 0) continue;

      const adapter = this.adapters.get(chain);
      if (!adapter) continue;

      const snapshot = await adapter.probeGas();
      const cheapEnough = this.feePolicy.shouldSettleNow(snapshot);
      const overdue = queue.some((item) => now - item.enqueuedAt >= this.config.maxDeferralMs);

      if (!cheapEnough && !overdue) {
        const { usd, detail } = this.feePolicy.settlementCostUsd(snapshot);
        reports.push({
          chain,
          broadcast: [],
          deferred: queue.length,
          failed: 0,
          note: `holding ${queue.length}: $${usd.toFixed(4)} — ${detail}`,
        });
        continue;
      }

      const batch = queue.splice(0, this.config.maxBatchSize);
      const requests = batch.map((item) => item.request);

      try {
        const call = await adapter.prepareSettlement(requests);
        if (call === null) {
          /**
           * Nothing to broadcast, and the batch is done rather than retried.
           *
           * Reached only if a chain that settles on receipt got past `enqueue`, which refuses
           * them — so this is a belt-and-braces branch. Requeuing would spin forever on a chain
           * that will never produce a transaction.
           */
          reports.push({
            chain,
            broadcast: [],
            deferred: queue.length,
            failed: 0,
            note: `${batch.length} needed no transaction`,
          });
          continue;
        }

        const outcome = await this.broadcaster.settle(requests, call, snapshot, now);
        if (!outcome.ok) {
          /**
           * A refusal is not a failure, and the difference matters.
           *
           * The runner refuses for reasons that pass — the gas price is above the ceiling, the
           * spend window is full, a nonce is stuck. So the batch goes back to the *front* of the
           * queue with its attempt count untouched: counting a refusal as an attempt would
           * abandon a merchant's settlement because the chain was busy.
           */
          queue.unshift(...batch);
          reports.push({
            chain,
            broadcast: [],
            deferred: queue.length,
            failed: 0,
            note: `refused ${batch.length}: ${outcome.reason} — ${outcome.detail}`,
          });
          continue;
        }

        reports.push({
          chain,
          broadcast: [outcome.transaction.hash],
          deferred: queue.length,
          failed: 0,
          note: overdue && !cheapEnough
            ? `broadcast ${batch.length} on deferral deadline`
            : `broadcast ${batch.length} at target cost`,
        });
      } catch (error) {
        // Requeue at the front so ordering survives, dropping exhausted items to
        // an operator queue rather than retrying them forever.
        let failed = 0;
        const retry: QueueItem[] = [];
        for (const item of batch) {
          item.attempts += 1;
          if (item.attempts >= this.config.maxAttempts) {
            failed += 1;
            this.log(
              `${item.request.invoiceId}: settlement abandoned after ` +
                `${item.attempts} attempts — needs manual review`,
            );
          } else {
            retry.push(item);
          }
        }
        queue.unshift(...retry);
        reports.push({
          chain,
          broadcast: [],
          deferred: queue.length,
          failed,
          note: `settlement failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    return reports;
  }
}

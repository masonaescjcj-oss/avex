import type { ChainAdapter, SettlementRequest, SettlementResult } from '../chains/ChainAdapter.js';
import type { FeePolicy } from '../fees/FeePolicy.js';
import type { ChainId } from '../types.js';

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

export interface DrainReport {
  readonly chain: ChainId;
  readonly settled: readonly SettlementResult[];
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
 * of our choosing is roughly an order of magnitude on Ethereum and Bitcoin.
 */
export class SettlementQueue {
  private readonly pending = new Map<ChainId, QueueItem[]>();

  constructor(
    private readonly adapters: ReadonlyMap<ChainId, ChainAdapter>,
    private readonly feePolicy: FeePolicy,
    private readonly config: SettlementQueueConfig = DEFAULT_QUEUE_CONFIG,
    private readonly log: QueueLogger = () => {},
  ) {}

  enqueue(request: SettlementRequest, now: number = Date.now()): void {
    const adapter = this.adapters.get(request.asset.chain);
    if (!adapter) throw new Error(`no adapter for chain ${request.asset.chain}`);

    // Shared-memo chains have already delivered the funds to the merchant.
    if (adapter.addressModel === 'shared-memo') {
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
          settled: [],
          deferred: queue.length,
          failed: 0,
          note: `holding ${queue.length}: $${usd.toFixed(4)} — ${detail}`,
        });
        continue;
      }

      const batch = queue.splice(0, this.config.maxBatchSize);
      const requests = batch.map((item) => item.request);

      try {
        const settled = await adapter.settle(requests);
        reports.push({
          chain,
          settled,
          deferred: queue.length,
          failed: 0,
          note: overdue && !cheapEnough
            ? `settled ${batch.length} on deferral deadline`
            : `settled ${batch.length} at target cost`,
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
          settled: [],
          deferred: queue.length,
          failed,
          note: `settlement failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    return reports;
  }
}

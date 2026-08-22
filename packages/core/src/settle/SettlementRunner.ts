import type { SettlementCall, SettlementRequest } from '../chains/ChainAdapter.js';
import type { FeePolicy } from '../fees/FeePolicy.js';
import type { ChainId, GasSnapshot } from '../types.js';

/**
 * Broadcasting settlement transactions.
 *
 * Everything here exists because of one asymmetry: payer funds are protected by
 * the forwarder's immutable destination, but the account that pays gas is an
 * ordinary hot key. It cannot redirect anyone's money, yet it can be drained, and
 * if it empties or jams then every settlement stops — funds sit at their deposit
 * addresses and no merchant gets paid.
 *
 * So this module is mostly limits: a nonce that is never reused, a ceiling on what
 * a transaction may cost, a cap on what may be spent in a window, and a way out of
 * a transaction that is stuck.
 */

/** Chain access for broadcasting. Signing is delegated so the key can live in a KMS. */
export interface ChainSigner {
  readonly address: string;
  /** Nonce the chain expects next, counting transactions already in the mempool. */
  pendingNonce(): Promise<number>;
  balanceWei(): Promise<bigint>;
  broadcast(tx: {
    readonly nonce: number;
    readonly to: string;
    readonly data: string;
    readonly gasLimit: bigint;
    readonly feePerGasWei: bigint;
  }): Promise<{ readonly hash: string }>;
  /** Null while still pending. */
  receipt(hash: string): Promise<{
    readonly status: 'success' | 'reverted';
    readonly gasUsed: bigint;
    readonly feePerGasWei: bigint;
  } | null>;
}

export interface InFlightTransaction {
  readonly hash: string;
  readonly nonce: number;
  readonly feePerGasWei: bigint;
  readonly gasLimit: bigint;
  /**
   * The call this transaction carries, kept so a replacement can be the same call.
   *
   * Not here originally, and the omission was a real defect rather than a gap: `replace`
   * broadcast `to: ''` with empty data at the stuck nonce. That is not a replacement of a
   * settlement — it is an empty transaction to nowhere, which either fails or succeeds at
   * doing nothing, and either way the batch it was supposed to carry is gone. The queue had
   * already counted those invoices as broadcast, so nothing would have retried them.
   */
  readonly to: string;
  readonly data: string;
  readonly invoiceIds: readonly string[];
  readonly broadcastAt: number;
  /** Set when this transaction was replaced by one with the same nonce. */
  readonly replacedByHash?: string;
}

export interface RunnerConfig {
  /**
   * Ceiling on a single settlement's cost, in USD. Above it, the batch waits.
   *
   * Distinct from `FeePolicy.deferAboveUsd`, which decides whether settling is
   * economic. This is a safety limit: it bounds the damage a mispriced gas
   * estimate or a runaway loop can do to the wallet.
   */
  readonly maxTransactionCostUsd: number;
  /** Total gas spend permitted per window, in USD. */
  readonly spendCapUsd: number;
  readonly spendWindowMs: number;
  /**
   * How long before a pending transaction is considered stuck.
   *
   * A transaction that never confirms blocks every later nonce behind it, so the
   * whole pipeline halts until it is replaced. Waiting too long to notice is worse
   * than replacing slightly early.
   */
  readonly stuckAfterMs: number;
  /**
   * Minimum fee increase when replacing, as a percentage.
   *
   * Nodes reject a replacement that does not raise the fee enough — commonly by at
   * least 10% — so a timid bump is silently discarded and the transaction stays
   * stuck.
   */
  readonly replacementBumpPercent: number;
  /** Warn when the wallet holds less than this many settlements' worth of gas. */
  readonly lowBalanceSettlements: number;
}

export const DEFAULT_RUNNER: RunnerConfig = {
  maxTransactionCostUsd: 25,
  spendCapUsd: 250,
  spendWindowMs: 60 * 60 * 1000,
  stuckAfterMs: 5 * 60_000,
  replacementBumpPercent: 15,
  lowBalanceSettlements: 50,
};

export type RefusalReason =
  | 'transaction_too_expensive'
  | 'spend_cap_reached'
  | 'insufficient_gas_balance'
  | 'nonce_blocked';

export type SettleResult =
  | { readonly ok: true; readonly transaction: InFlightTransaction }
  | { readonly ok: false; readonly reason: RefusalReason; readonly detail: string };

export interface Alert {
  readonly severity: 'warning' | 'critical';
  readonly kind: 'low_gas_balance' | 'stuck_transaction' | 'spend_cap' | 'reverted_settlement';
  readonly detail: string;
}

interface SpendEntry {
  readonly at: number;
  readonly usd: number;
}

/**
 * Transaction bytes to broadcast, produced by the chain adapter.
 *
 * Re-exported rather than declared, so there is one definition of what a settlement transaction
 * is. Two identical interfaces in two files is how the adapter and the runner come to disagree
 * about a field.
 */
export type { SettlementCall } from '../chains/ChainAdapter.js';

export class SettlementRunner {
  private readonly inFlight = new Map<number, InFlightTransaction>();
  private spend: SpendEntry[] = [];
  private nextNonce: number | null = null;
  private readonly alerts: Alert[] = [];

  constructor(
    private readonly chain: ChainId,
    private readonly signer: ChainSigner,
    private readonly feePolicy: FeePolicy,
    private readonly config: RunnerConfig = DEFAULT_RUNNER,
    private readonly log: (message: string) => void = () => {},
  ) {}

  /**
   * Adopt the chain's nonce as the starting point.
   *
   * Must run before the first broadcast. Guessing zero would collide with every
   * transaction the account has already sent, and each collision is a settlement
   * silently dropped by the mempool.
   */
  async start(): Promise<number> {
    this.nextNonce = await this.signer.pendingNonce();
    return this.nextNonce;
  }

  /**
   * Broadcast a batch, subject to every limit.
   *
   * Refuses rather than throwing, because a refusal is a normal outcome — the
   * batch simply stays queued and is retried when conditions change.
   */
  async settle(
    batch: readonly SettlementRequest[],
    call: SettlementCall,
    snapshot: GasSnapshot,
    now: number = Date.now(),
  ): Promise<SettleResult> {
    if (this.nextNonce === null) await this.start();

    const feePerGasWei = snapshot.feePerGasWei;
    if (feePerGasWei === undefined) {
      return {
        ok: false,
        reason: 'transaction_too_expensive',
        detail: 'no live gas price available',
      };
    }

    const costWei = call.gasLimit * feePerGasWei;
    const costUsd = weiToUsd(costWei, snapshot.nativePriceUsd);

    if (costUsd > this.config.maxTransactionCostUsd) {
      return {
        ok: false,
        reason: 'transaction_too_expensive',
        detail:
          `settlement would cost $${costUsd.toFixed(2)}, above the ` +
          `$${this.config.maxTransactionCostUsd} per-transaction limit`,
      };
    }

    const spent = this.spentInWindow(now);
    if (spent + costUsd > this.config.spendCapUsd) {
      this.raise({
        severity: 'warning',
        kind: 'spend_cap',
        detail:
          `gas spend cap reached: $${spent.toFixed(2)} of $${this.config.spendCapUsd} ` +
          `in the last ${Math.round(this.config.spendWindowMs / 60_000)} minutes`,
      });
      return {
        ok: false,
        reason: 'spend_cap_reached',
        detail: `spending $${costUsd.toFixed(2)} would exceed the window cap`,
      };
    }

    const balance = await this.signer.balanceWei();
    if (balance < costWei) {
      this.raise({
        severity: 'critical',
        kind: 'low_gas_balance',
        detail:
          `${this.chain} gas wallet ${this.signer.address} cannot cover a settlement: ` +
          `has ${balance} wei, needs ${costWei}`,
      });
      return {
        ok: false,
        reason: 'insufficient_gas_balance',
        detail: 'the gas wallet cannot cover this transaction',
      };
    }

    // Warn while there is still time to top up, rather than once settlement has
    // already stopped.
    const runway = costWei > 0n ? Number(balance / costWei) : Number.MAX_SAFE_INTEGER;
    if (runway < this.config.lowBalanceSettlements) {
      this.raise({
        severity: 'warning',
        kind: 'low_gas_balance',
        detail:
          `${this.chain} gas wallet has roughly ${runway} settlement(s) of runway ` +
          `(threshold ${this.config.lowBalanceSettlements})`,
      });
    }

    const nonce = this.nextNonce!;
    const { hash } = await this.signer.broadcast({
      nonce,
      to: call.to,
      data: call.data,
      gasLimit: call.gasLimit,
      feePerGasWei,
    });

    // Advance only after a successful broadcast. Advancing first would leave a gap
    // on failure, and every later transaction would sit unmined behind it.
    this.nextNonce = nonce + 1;

    const transaction: InFlightTransaction = {
      hash,
      nonce,
      feePerGasWei,
      gasLimit: call.gasLimit,
      to: call.to,
      data: call.data,
      invoiceIds: batch.map((request) => request.invoiceId),
      broadcastAt: now,
    };
    this.inFlight.set(nonce, transaction);
    this.spend.push({ at: now, usd: costUsd });

    this.log(
      `${this.chain}: broadcast ${hash} nonce ${nonce} for ${batch.length} invoice(s), ` +
        `$${costUsd.toFixed(4)}`,
    );

    return { ok: true, transaction };
  }

  /**
   * Check in-flight transactions and replace any that are stuck.
   *
   * A replacement reuses the nonce with a higher fee. That is the only way past a
   * transaction that will not confirm — and it must be done, because everything
   * behind that nonce is blocked until it is.
   */
  async reconcile(
    snapshot: GasSnapshot,
    now: number = Date.now(),
  ): Promise<{
    confirmed: readonly InFlightTransaction[];
    replaced: readonly { from: string; to: string; nonce: number }[];
    reverted: readonly InFlightTransaction[];
    stillPending: number;
  }> {
    const confirmed: InFlightTransaction[] = [];
    const reverted: InFlightTransaction[] = [];
    const replaced: { from: string; to: string; nonce: number }[] = [];

    for (const [nonce, transaction] of [...this.inFlight]) {
      const receipt = await this.signer.receipt(transaction.hash);

      if (receipt) {
        this.inFlight.delete(nonce);

        if (receipt.status === 'reverted') {
          // Gas was spent and nothing moved. Never silently retried: a settlement
          // that reverts usually means a bad assumption, and repeating it just
          // burns more gas.
          reverted.push(transaction);
          this.raise({
            severity: 'critical',
            kind: 'reverted_settlement',
            detail:
              `settlement ${transaction.hash} reverted, covering ` +
              `${transaction.invoiceIds.length} invoice(s) — needs investigation`,
          });
        } else {
          confirmed.push(transaction);
        }
        continue;
      }

      if (now - transaction.broadcastAt < this.config.stuckAfterMs) continue;

      const replacement = await this.replace(transaction, snapshot, now);
      if (replacement) {
        replaced.push({ from: transaction.hash, to: replacement.hash, nonce });
      }
    }

    return { confirmed, replaced, reverted, stillPending: this.inFlight.size };
  }

  private async replace(
    stuck: InFlightTransaction,
    snapshot: GasSnapshot,
    now: number,
  ): Promise<InFlightTransaction | null> {
    const minimum =
      (stuck.feePerGasWei * BigInt(100 + this.config.replacementBumpPercent)) / 100n;
    // Take whichever is higher: the required bump, or the current market rate.
    const feePerGasWei =
      snapshot.feePerGasWei !== undefined && snapshot.feePerGasWei > minimum
        ? snapshot.feePerGasWei
        : minimum;

    const costUsd = weiToUsd(stuck.gasLimit * feePerGasWei, snapshot.nativePriceUsd);
    if (costUsd > this.config.maxTransactionCostUsd) {
      // Refusing to bump leaves the nonce blocked, which is bad — but quietly
      // spending past the safety limit is worse, so an operator decides.
      this.raise({
        severity: 'critical',
        kind: 'stuck_transaction',
        detail:
          `${stuck.hash} at nonce ${stuck.nonce} is stuck and replacing it would ` +
          `cost $${costUsd.toFixed(2)}, above the per-transaction limit; settlement ` +
          'is blocked behind this nonce until an operator intervenes',
      });
      return null;
    }

    this.raise({
      severity: 'warning',
      kind: 'stuck_transaction',
      detail:
        `replacing ${stuck.hash} at nonce ${stuck.nonce} after ` +
        `${Math.round((now - stuck.broadcastAt) / 1000)}s with a ` +
        `${this.config.replacementBumpPercent}% higher fee`,
    });

    /**
     * The same nonce and the same call: this replaces the transaction rather than adding one.
     *
     * The call has to be carried on the in-flight record for that to be possible. It was not,
     * and this line sent an empty transaction to the zero address instead — spending gas to
     * unblock the nonce while quietly abandoning the settlement it was replacing.
     */
    const { hash } = await this.signer.broadcast({
      nonce: stuck.nonce,
      to: stuck.to,
      data: stuck.data,
      gasLimit: stuck.gasLimit,
      feePerGasWei,
    });

    const replacement: InFlightTransaction = {
      ...stuck,
      hash,
      feePerGasWei,
      broadcastAt: now,
    };
    this.inFlight.set(stuck.nonce, replacement);
    this.spend.push({ at: now, usd: costUsd });

    return replacement;
  }

  private spentInWindow(now: number): number {
    this.spend = this.spend.filter((entry) => now - entry.at < this.config.spendWindowMs);
    return this.spend.reduce((total, entry) => total + entry.usd, 0);
  }

  private raise(alert: Alert): void {
    this.alerts.push(alert);
    this.log(`[${alert.severity}] ${alert.kind}: ${alert.detail}`);
  }

  /**
   * Invoice ids carried by transactions still in flight.
   *
   * What stops an invoice being settled twice. Whatever feeds the queue reads "paid and not
   * settled", and an invoice stays in that set until a transaction carrying it *confirms* — so
   * between broadcast and confirmation it is still due, and something has to know it is already
   * on its way. This is read from memory rather than from the settlements table because the
   * runner is ahead of the table by however long the write takes.
   */
  inFlightInvoiceIds(): readonly string[] {
    return [...this.inFlight.values()].flatMap((transaction) => [...transaction.invoiceIds]);
  }

  /** Drain accumulated alerts, for whatever forwards them to an operator. */
  takeAlerts(): readonly Alert[] {
    return this.alerts.splice(0, this.alerts.length);
  }

  /** Operational snapshot, for the admin dashboard. */
  status(now: number = Date.now()): {
    chain: ChainId;
    address: string;
    nextNonce: number | null;
    inFlight: number;
    oldestPendingAgeMs: number | null;
    spentInWindowUsd: number;
    spendCapUsd: number;
  } {
    const ages = [...this.inFlight.values()].map((tx) => now - tx.broadcastAt);
    return {
      chain: this.chain,
      address: this.signer.address,
      nextNonce: this.nextNonce,
      inFlight: this.inFlight.size,
      oldestPendingAgeMs: ages.length > 0 ? Math.max(...ages) : null,
      spentInWindowUsd: this.spentInWindow(now),
      spendCapUsd: this.config.spendCapUsd,
    };
  }

  /** Whether the FeePolicy considers this chain cheap enough to settle at all. */
  shouldSettle(snapshot: GasSnapshot): boolean {
    return this.feePolicy.shouldSettleNow(snapshot);
  }
}

/**
 * Convert a wei cost to USD.
 *
 * Staged through whole and fractional parts so a large wei value keeps its low
 * digits. Used only for limits and alerting, never for an amount owed.
 */
export function weiToUsd(wei: bigint, nativePriceUsd: number): number {
  const scale = 10n ** 18n;
  const whole = wei / scale;
  const fraction = wei % scale;
  return (Number(whole) + Number(fraction) / Number(scale)) * nativePriceUsd;
}

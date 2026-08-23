import { chainConfig } from '@avex/core';
import type { Alert, ChainId, GasSnapshot } from '@avex/core';

/**
 * Whether the gas wallet can still pay for settlements, checked whether or not there are any.
 *
 * ## The gap this closes
 *
 * `SettlementRunner` already checks the balance, and it checks it in the one place that is too
 * late: inside `settle`, against the transaction it is about to send. Two consequences followed
 * from that, and both are the failure mode this product is worst at — money stops moving and
 * nothing says so.
 *
 * A wallet draining while the queue is empty was never looked at. On a quiet chain the balance
 * could reach zero over a weekend and the first thing to notice would be the first merchant
 * waiting for a settlement on Monday.
 *
 * And the alert that arrived in time was the wrong severity to arrive at all. The runner raises
 * `warning` when the runway is short and `critical` only once the balance cannot cover the
 * transaction in hand — but `AlertForwarder` emails critical alerts and logs warnings, so the
 * only message an operator actually received was the one that meant settlement had already
 * stopped. The useful one, "top up, you have a day", went to a log file.
 *
 * So this runs every pass, from the cycle, and raises `critical` while there is still runway to
 * act on. The forwarder's per-kind throttle is what keeps that to one email every fifteen
 * minutes rather than one every thirty seconds.
 *
 * ## Why it is pure
 *
 * It returns alerts and sends none, the same shape as `WatchHealth`. A component that both
 * decides and delivers is one that cannot be tested without a mail server, and the thing worth
 * testing here is the arithmetic on the boundary — which is the only part anybody will get
 * wrong.
 */

export interface GasWatchThresholds {
  /**
   * Runway, in settlements, below which this is an emergency worth an email.
   *
   * Ten rather than the runner's fifty. The two numbers answer different questions: fifty is
   * "this is getting low", which belongs in a log, and ten is "act today", which belongs in
   * somebody's inbox. Setting them the same would either email constantly or say nothing until
   * it was too late.
   */
  readonly criticalSettlements: number;
  /** Runway below which it is worth a log line. Matches the runner's own threshold. */
  readonly warningSettlements: number;
}

export const DEFAULT_GAS_WATCH: GasWatchThresholds = {
  criticalSettlements: 10,
  warningSettlements: 50,
};

export interface GasWatchReading {
  readonly balanceWei: bigint;
  /** What one settlement costs at the snapshot's fee, in wei. */
  readonly perSettlementWei: bigint;
  /** How many settlements the balance covers. Integer, rounded down. */
  readonly runway: number;
}

export class GasWatch {
  /**
   * The last runway reported per chain, so a recovery can be announced.
   *
   * Without it, topping up a wallet is silent: the alerts stop, which is indistinguishable from
   * the watcher having died. An operator should be told the thing they fixed is fixed.
   */
  readonly #lastRunway = new Map<ChainId, number>();

  constructor(private readonly thresholds: GasWatchThresholds = DEFAULT_GAS_WATCH) {}

  /**
   * One reading, turned into whatever needs saying about it.
   *
   * A null snapshot means no live fee, so there is no cost to divide by and nothing can be
   * concluded — silence rather than a guess, because a wrong runway is worse than none.
   */
  check(
    chain: ChainId,
    balanceWei: bigint,
    snapshot: GasSnapshot | null,
  ): { readonly alerts: readonly Alert[]; readonly reading: GasWatchReading | null } {
    if (snapshot === null || snapshot.feePerGasWei === undefined) {
      return { alerts: [], reading: null };
    }

    const profile = chainConfig(chain).settlement;
    if (profile.kind !== 'evm') return { alerts: [], reading: null };

    /**
     * One deploy-and-flush, which is what a settlement is on the first payment to an address.
     *
     * The measured figure from the registry rather than an estimate: `eth_estimateGas` against
     * forwarders that do not exist yet simulates state that does not exist and fails. Using the
     * more expensive of the two operations is deliberate — a runway quoted on the cheaper one
     * would be optimistic exactly when it mattered.
     */
    const perSettlementWei = BigInt(profile.gasDeployAndFlushToken) * snapshot.feePerGasWei;
    if (perSettlementWei <= 0n) return { alerts: [], reading: null };

    const runway = Number(balanceWei / perSettlementWei);
    const reading: GasWatchReading = { balanceWei, perSettlementWei, runway };

    const previous = this.#lastRunway.get(chain);
    this.#lastRunway.set(chain, runway);

    const detail =
      `${chain} gas wallet covers about ${runway} settlement(s) ` +
      `(${balanceWei} wei, ${perSettlementWei} wei each)`;

    if (runway < this.thresholds.criticalSettlements) {
      return {
        alerts: [{ severity: 'critical', kind: 'low_gas_balance', detail: `${detail} — top up` }],
        reading,
      };
    }

    /**
     * Recovered, and said once.
     *
     * Only when the previous reading was itself critical, so a chain that has always been
     * healthy does not announce it on the first pass.
     */
    if (previous !== undefined && previous < this.thresholds.criticalSettlements) {
      return {
        alerts: [
          { severity: 'warning', kind: 'low_gas_balance', detail: `${detail} — recovered` },
        ],
        reading,
      };
    }

    if (runway < this.thresholds.warningSettlements) {
      return { alerts: [{ severity: 'warning', kind: 'low_gas_balance', detail }], reading };
    }

    return { alerts: [], reading };
  }
}

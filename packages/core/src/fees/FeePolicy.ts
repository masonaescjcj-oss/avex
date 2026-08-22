import { chainConfig } from '../chains/registry.js';
import type { ChainId, GasSnapshot, SettlementCost } from '../types.js';

/**
 * Converts a smallest-unit bigint to a float, staged through whole and
 * fractional parts so large wei values don't lose their low digits.
 * Only ever used for fee heuristics — never for balances.
 */
function toFloat(raw: bigint, decimals: number): number {
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const frac = raw % scale;
  return Number(whole) + Number(frac) / Number(scale);
}

export interface FeePolicyConfig {
  /**
   * Ceiling on settlement cost as a share of invoice value. An invoice is only
   * offered on a chain when the cost of moving its funds stays under this.
   */
  readonly targetFeeRatio: number;

  /** Floor on invoice size, independent of fees. */
  readonly absoluteMinUsd: number;

  /**
   * Per-chain settlement cost, in USD, above which we defer rather than settle.
   * This is what keeps Ethereum usable: at 0.05 gwei we settle immediately, at
   * 9 gwei the same settlement waits for a cheaper block.
   */
  readonly deferAboveUsd: Readonly<Record<ChainId, number>>;

  /** Where TRON energy comes from, and what it costs us. See `TronEnergySupply`. */
  readonly tronEnergy: TronEnergySupply;
}

/**
 * How this deployment pays for TRON energy.
 *
 * There are three ways and they differ by a factor of ten, which is why "add TRON cheaply" is
 * a question about this field and not about the adapter.
 *
 * The previous version of this was a boolean, `tronEnergyDelegation`, and when it was true the
 * settlement cost was reported as **$0** — "the cost is staked TRX, not burned per transfer".
 * That reasoning is half right and the conclusion is wrong in the direction that loses money.
 * Staked TRX yields a *daily allowance* of energy, not an unlimited supply: every settlement
 * spends a share of a finite quota, and once the day's quota is gone the next settlement
 * either fails or falls back to burning TRX at the network's full price. Priced at zero, the
 * fee policy will happily accept invoices whose settlement costs more than they earn, and the
 * minimum-invoice figure — the one number standing between us and losing money on small
 * payments — is computed from it.
 *
 * So every source carries a price, and there is no way to spell "free".
 */
export type TronEnergySupply =
  /**
   * Burn TRX per transaction, at whatever the network charges. The honest fallback and the
   * most expensive: the price comes from `GasSnapshot.sunPerEnergy`, live.
   */
  | { readonly source: 'burn' }
  /**
   * Rent energy from a provider for the length of the transaction. Usually the cheapest way
   * to run a gateway, because the capital stays with the provider — but the price is a market
   * and belongs in configuration, not in this file.
   */
  | { readonly source: 'rented'; readonly sunPerEnergy: number }
  /**
   * Our own staked TRX, delegated to the settlement account.
   *
   * `sunPerEnergy` here is an amortised figure the operator states: the carrying cost of the
   * staked TRX divided by the energy it yields over the same period. It is not zero, and this
   * type will not let it be omitted.
   */
  | { readonly source: 'staked'; readonly sunPerEnergy: number };

/** Bandwidth is priced by the network itself, and not by us. */
const SUN_PER_BANDWIDTH_POINT = 1_000;

export const DEFAULT_FEE_POLICY: FeePolicyConfig = {
  targetFeeRatio: 0.01,
  absoluteMinUsd: 0.5,
  deferAboveUsd: {
    ethereum: 0.5,
    polygon: 0.05,
    bsc: 0.05,
    tron: 0.5,
    solana: 0.01,
    ton: 0,
  },
  /**
   * Burning, as the default, because it is the only source that needs no local knowledge.
   *
   * A deployment that has staked or rented should say so — that is the cheap path and it
   * lowers the minimum invoice. Defaulting *to* the cheap path would mean a deployment that
   * has arranged nothing quotes prices as though it had.
   */
  tronEnergy: { source: 'burn' },
};

export interface ChainAvailability {
  readonly chain: ChainId;
  readonly available: boolean;
  readonly minInvoiceUsd: number;
  readonly cost: SettlementCost;
  readonly reason?: string;
}

export class FeePolicy {
  constructor(private readonly config: FeePolicyConfig = DEFAULT_FEE_POLICY) {}

  /**
   * What it costs AVEX to move one invoice's funds to the merchant, right now.
   *
   * This is deliberately not the headline "network fee" a comparison site
   * quotes. On a unique-address chain the payer's transfer is only the first of
   * the transactions involved; this figure covers the ones we pay for.
   */
  settlementCostUsd(snapshot: GasSnapshot): SettlementCost {
    const config = chainConfig(snapshot.chain);
    const profile = config.settlement;
    const price = snapshot.nativePriceUsd;

    switch (profile.kind) {
      case 'direct':
        return {
          chain: snapshot.chain,
          usd: 0,
          detail: 'shared-memo chain: payer transfer delivers funds directly',
        };

      case 'evm': {
        const feePerGas = snapshot.feePerGasWei;
        if (feePerGas === undefined) {
          throw new Error(`${snapshot.chain}: GasSnapshot.feePerGasWei required`);
        }
        const gas = BigInt(profile.gasDeployAndFlushToken);
        const native = toFloat(gas * feePerGas, config.nativeDecimals);
        const gwei = toFloat(feePerGas, 9);
        return {
          chain: snapshot.chain,
          usd: native * price,
          detail:
            `${profile.gasDeployAndFlushToken} gas (CREATE2 deploy + flush) ` +
            `@ ${gwei.toFixed(4)} gwei`,
        };
      }

      case 'tron': {
        const supply = this.config.tronEnergy;
        /**
         * The burn price is live and the other two are stated, and neither may be missing.
         *
         * Throwing rather than substituting a default: a settlement cost quietly computed
         * from a made-up energy price is the same failure as the $0 this replaced, only
         * harder to spot.
         */
        const sunPerEnergy =
          supply.source === 'burn' ? snapshot.sunPerEnergy : supply.sunPerEnergy;
        if (sunPerEnergy === undefined) {
          throw new Error('tron: GasSnapshot.sunPerEnergy required when energy is burned');
        }

        const energy = profile.energyDeployAndFlush;
        const bandwidthSun = profile.bandwidthPerTransfer * SUN_PER_BANDWIDTH_POINT;
        const trx = (energy * sunPerEnergy + bandwidthSun) / 1e6;
        return {
          chain: 'tron',
          usd: trx * price,
          detail:
            `${energy} energy (CREATE2 deploy + flush) @ ${sunPerEnergy} SUN ` +
            `${supply.source} + ${profile.bandwidthPerTransfer} bandwidth`,
        };
      }

      case 'solana': {
        const lamportsPerSignature = snapshot.lamportsPerSignature;
        if (lamportsPerSignature === undefined) {
          throw new Error('solana: GasSnapshot.lamportsPerSignature required');
        }
        const lamports = profile.signaturesPerFlush * lamportsPerSignature;
        return {
          chain: 'solana',
          usd: (lamports / 1e9) * price,
          detail:
            `${profile.signaturesPerFlush} signature(s) @ ${lamportsPerSignature} lamports ` +
            `(+${profile.ataRentLamports} lamports ATA rent, refundable on close)`,
        };
      }
    }
  }

  /**
   * Smallest invoice worth accepting on this chain under current conditions.
   *
   * Deriving this from live gas rather than a hardcoded table is what lets
   * Ethereum participate at all: the same rule that permits a $1.50 invoice at
   * 0.05 gwei quietly raises the bar past $250 during a spike, with no operator
   * intervention and no invoices accepted that cost more to settle than they
   * are worth.
   */
  minInvoiceUsd(snapshot: GasSnapshot): number {
    const { usd } = this.settlementCostUsd(snapshot);
    return Math.max(this.config.absoluteMinUsd, usd / this.config.targetFeeRatio);
  }

  /** Whether to offer this chain at checkout for an invoice of this size. */
  availability(snapshot: GasSnapshot, invoiceUsd: number): ChainAvailability {
    const cost = this.settlementCostUsd(snapshot);
    const minInvoiceUsd = this.minInvoiceUsd(snapshot);
    const available = invoiceUsd >= minInvoiceUsd;

    return {
      chain: snapshot.chain,
      available,
      minInvoiceUsd,
      cost,
      ...(available
        ? {}
        : {
            reason:
              `settling costs $${cost.usd.toFixed(4)}, which exceeds ` +
              `${(this.config.targetFeeRatio * 100).toFixed(1)}% of a ` +
              `$${invoiceUsd.toFixed(2)} invoice`,
          }),
    };
  }

  /**
   * Rank the chains we can offer, cheapest first, dropping any that are too
   * expensive for this invoice. Defaulting checkout to the top entry lowers our
   * cost and raises conversion at the same time.
   */
  rankForCheckout(
    snapshots: readonly GasSnapshot[],
    invoiceUsd: number,
  ): readonly ChainAvailability[] {
    return snapshots
      .map((snapshot) => this.availability(snapshot, invoiceUsd))
      .filter((entry) => entry.available)
      .sort((a, b) => a.cost.usd - b.cost.usd);
  }

  /**
   * Whether settling now is worth it, or whether the funds should keep waiting.
   *
   * Safe to defer because the money is already sitting at an address that can
   * only pay the merchant — so waiting for a cheap block costs nothing but time.
   */
  shouldSettleNow(snapshot: GasSnapshot): boolean {
    const { usd } = this.settlementCostUsd(snapshot);
    return usd <= (this.config.deferAboveUsd[snapshot.chain] ?? 0);
  }
}

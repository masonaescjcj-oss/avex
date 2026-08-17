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

  /** Inputs assumed per Bitcoin consolidation, for amortising overhead. */
  readonly bitcoinBatchInputs: number;

  /**
   * Whether TRON energy is supplied by delegation from a staked account. When
   * true a TRC-20 settlement burns nothing — the cost has been paid once, as
   * locked TRX, instead of per transaction.
   */
  readonly tronEnergyDelegation: boolean;
}

export const DEFAULT_FEE_POLICY: FeePolicyConfig = {
  targetFeeRatio: 0.01,
  absoluteMinUsd: 0.5,
  deferAboveUsd: {
    ethereum: 0.5,
    polygon: 0.05,
    bsc: 0.05,
    tron: 0.5,
    bitcoin: 0.3,
    solana: 0.01,
    ton: 0,
  },
  bitcoinBatchInputs: 50,
  tronEnergyDelegation: true,
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

      case 'bitcoin': {
        const satPerVByte = snapshot.satPerVByte;
        if (satPerVByte === undefined) {
          throw new Error('bitcoin: GasSnapshot.satPerVByte required');
        }
        // Consolidating many inputs into one output spreads the overhead, which
        // is why deferred batching moves Bitcoin from unusable to viable.
        const vBytes =
          profile.vBytesPerInput + profile.vBytesOverhead / this.config.bitcoinBatchInputs;
        const sats = vBytes * satPerVByte;
        return {
          chain: 'bitcoin',
          usd: (sats / 1e8) * price,
          detail:
            `${vBytes.toFixed(1)} vB amortised over ` +
            `${this.config.bitcoinBatchInputs} inputs @ ${satPerVByte} sat/vB`,
        };
      }

      case 'tron': {
        if (this.config.tronEnergyDelegation) {
          return {
            chain: 'tron',
            usd: 0,
            detail:
              `${profile.energyPerTransfer} energy covered by delegation ` +
              '(cost is staked TRX, not burned per transfer)',
          };
        }
        const sunPerEnergy = snapshot.sunPerEnergy;
        if (sunPerEnergy === undefined) {
          throw new Error('tron: GasSnapshot.sunPerEnergy required without delegation');
        }
        const trx = (profile.energyPerTransfer * sunPerEnergy) / 1e6;
        return {
          chain: 'tron',
          usd: trx * price,
          detail:
            `${profile.energyPerTransfer} energy burned @ ${sunPerEnergy} SUN ` +
            '(enable delegation to remove this)',
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

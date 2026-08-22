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

  /**
   * Ceiling on the network fee charged to the payer, in basis points.
   *
   * The settlement cost is a fixed number of dollars and the invoice is not, so as a share
   * of the invoice it is unbounded: a $0.34 Ethereum settlement is 1.7% of $20 and 34% of a
   * dollar. Something has to stop the second case reaching a payer, and it cannot be the
   * contract's 5% — that is a hard limit shared with the commission, and hitting it means an
   * address that cannot be deployed rather than a fee that is merely rude.
   *
   * Two per cent. Above that the invoice is too small for the chain, which is what
   * `minInvoiceUsd` is for; charging 4% of a payment to move it is a number a payer reads as
   * a scam, and the honest answer to it is a different chain.
   */
  readonly networkFeeMaxBps: number;
}

export const DEFAULT_FEE_POLICY: FeePolicyConfig = {
  targetFeeRatio: 0.01,
  absoluteMinUsd: 0.5,
  networkFeeMaxBps: 200,
  deferAboveUsd: {
    ethereum: 0.5,
    polygon: 0.05,
    bsc: 0.05,
    tron: 0.5,
    solana: 0.01,
    ton: 0,
  },
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
   * The settlement cost as a share of one invoice, in basis points, for charging to the payer.
   *
   * This is the whole of "the payer pays the transfer fee". A $20 invoice on a chain where
   * moving the money costs $0.10 becomes a $20.10 invoice, and the extra ten cents is taken
   * by the same on-chain split that takes the commission — so it reaches the collector that
   * funds the gas wallet rather than the merchant.
   *
   * Expressed in basis points because that is the only shape available. The deposit address is
   * a hash over the forwarder's constructor arguments and the fee rate is one of them, so what
   * is charged has to be a rate, decided before the address exists and never revisited. A
   * fixed cent figure would have to be a second transfer, and there is nobody to send it.
   *
   * Rounded up, and that direction is deliberate: rounding down leaves us a fraction of a cent
   * short on every invoice on the chain, which is a real loss that compounds with volume,
   * against at most one micro-dollar of overcharge on a single payment.
   *
   * Zero on the chains that settle directly — TON, and TRON's pool of the merchant's own
   * wallets. We send no transaction there, so there is no cost to pass on, and the payer sees
   * the cheap chain being cheaper.
   */
  networkFeeBps(snapshot: GasSnapshot, invoiceValueUsdMicros: bigint): number {
    if (invoiceValueUsdMicros <= 0n) return 0;

    const { usd } = this.settlementCostUsd(snapshot);
    if (!(usd > 0)) return 0;

    /**
     * The cost in micro-dollars, so the ratio is integer arithmetic from here on.
     *
     * `Math.ceil` twice over — once into micro-dollars and once into basis points — for the
     * same reason: every rounding on this path goes against us rather than against a payer we
     * would have to explain it to.
     */
    const costUsdMicros = BigInt(Math.ceil(usd * 1_000_000));
    const bps = (costUsdMicros * 10_000n + invoiceValueUsdMicros - 1n) / invoiceValueUsdMicros;

    const ceiling = BigInt(this.config.networkFeeMaxBps);
    return Number(bps > ceiling ? ceiling : bps);
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

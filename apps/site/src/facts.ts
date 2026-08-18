import { CURATED_ASSETS, type CuratedAsset } from '@avex/core';

/**
 * The facts the site states, read from the product rather than transcribed.
 *
 * A marketing page is the one surface nobody tests against reality, so it is the surface
 * where a claim quietly stops being true. "Six chains" survives a chain being removed;
 * "0.5%" survives a repricing; a currency table typed out by hand survives anything.
 *
 * So every figure on the page that describes the product comes from here, and here reads
 * the same modules the gateway does. What is left in the HTML is prose — which is allowed
 * to be persuasive, but is not allowed to be the source of a number.
 */

/** The commission ladder, mirroring `FEE_TIERS` in the API's fee-plan service. */
export const LADDER: readonly { readonly bps: number; readonly fromUsdMicros: bigint }[] = [
  { bps: 50, fromUsdMicros: 0n },
  { bps: 45, fromUsdMicros: 50_000_000_000n },
  { bps: 40, fromUsdMicros: 250_000_000_000n },
];

/**
 * The on-chain ceiling is not re-declared here.
 *
 * `create2.ts` already exports `MAX_FEE_BPS`, mirroring `Forwarder.MAX_FEE_BPS`, and the
 * page reads that one. Declaring a second copy is what broke the first build of this page:
 * the inliner concatenates every module into one scope, so two constants of the same name
 * are a `SyntaxError` that takes the whole script down — the address panel, the currency
 * table and the ladder all at once, with only the static HTML fallbacks left showing.
 */

/** How long a webhook signature stays valid, mirroring the plugin's tolerance. */
export const SIGNATURE_WINDOW_SECONDS = 300;

/** Chain identifiers as a reader would recognise them. */
const CHAIN_LABELS: Readonly<Record<string, string>> = {
  bsc: 'BNB Chain',
  ethereum: 'Ethereum',
  polygon: 'Polygon',
  ton: 'TON',
  tron: 'TRON',
  solana: 'Solana',
};

export interface ChainRow {
  readonly chain: string;
  readonly label: string;
  /** The chain's own gas asset, which every chain has exactly one of. */
  readonly native: string;
  /** Stablecoins, with who stands behind each — the distinction three letters hide. */
  readonly stablecoins: readonly {
    readonly symbol: string;
    readonly issuer: 'native' | 'bridged';
  }[];
}

/**
 * What a merchant can accept, per chain.
 *
 * Ordered by how much stablecoin volume each chain actually carries rather than
 * alphabetically, because the first row is the one most readers are looking for.
 */
const CHAIN_ORDER = ['tron', 'ethereum', 'bsc', 'solana', 'ton', 'polygon'];

export function chainRows(assets: readonly CuratedAsset[] = CURATED_ASSETS): readonly ChainRow[] {
  const chains = [...new Set(assets.map((asset) => asset.chain))];

  return chains
    .map((chain) => {
      const onChain = assets.filter((asset) => asset.chain === chain);
      const native = onChain.find((asset) => asset.kind === 'native');

      return {
        chain,
        label: CHAIN_LABELS[chain] ?? chain,
        // Every supported chain has exactly one, and a chain without it cannot pay anyone —
        // so an empty string here would be a visible hole rather than a silent one.
        native: native?.symbol ?? '',
        stablecoins: onChain
          .filter((asset) => asset.kind !== 'native')
          .map((asset) => ({ symbol: asset.symbol, issuer: asset.issuer }))
          .sort((left, right) => left.symbol.localeCompare(right.symbol)),
      };
    })
    .sort((left, right) => {
      const rank = (chain: string) => {
        const index = CHAIN_ORDER.indexOf(chain);
        return index === -1 ? CHAIN_ORDER.length : index;
      };
      return rank(left.chain) - rank(right.chain) || left.label.localeCompare(right.label);
    });
}

/** Basis points as a percentage, without trailing zeros: 45 → "0.45%". */
export function percentOf(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

/** Micro-dollars as a round figure for prose: 50000000000n → "$50,000". */
export function roundUsd(micros: bigint): string {
  const whole = micros / 1_000_000n;
  return `$${whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

/**
 * What the merchant keeps and what we take, on a given amount.
 *
 * Computed rather than written out because the page shows it on a worked example, and a
 * worked example with the arithmetic done by hand is the first thing to go stale after a
 * repricing.
 */
export function split(
  amountUsd: number,
  bps: number,
): { readonly fee: string; readonly net: string } {
  const micros = BigInt(Math.round(amountUsd * 1_000_000));
  const fee = (micros * BigInt(bps)) / 10_000n;
  const money = (value: bigint) =>
    `$${(value / 1_000_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${(
      (value % 1_000_000n) /
      10_000n
    )
      .toString()
      .padStart(2, '0')}`;

  return { fee: money(fee), net: money(micros - fee) };
}

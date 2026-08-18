import type { Asset, ChainId } from '../types.js';

/**
 * The curated global asset list.
 *
 * The only path to `approved` without a human. Every entry is a contract address
 * verified by hand against the issuer's own documentation, because the whole
 * defence against a token calling itself USDT is knowing which address the real
 * one lives at.
 *
 * Addresses are checksummed. Comparisons lowercase both sides — a merchant pasting
 * a lowercase address must still match.
 */

export interface CuratedAsset extends Asset {
  /** Why this entry is trusted, for the audit trail. */
  readonly note: string;
}

export const CURATED_ASSETS: readonly CuratedAsset[] = [
  // ── BNB Smart Chain — the first chain to go live ──────────────────────────
  {
    symbol: 'USDT',
    chain: 'bsc',
    decimals: 18,
    kind: 'erc20',
    contract: '0x55d398326f99059fF775485246999027B3197955',
    note: 'Binance-Peg BSC-USD. Note 18 decimals, not the 6 used on Ethereum.',
  },
  {
    symbol: 'USDC',
    chain: 'bsc',
    decimals: 18,
    kind: 'erc20',
    contract: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    note: 'Binance-Peg USD Coin, 18 decimals.',
  },
  { symbol: 'BNB', chain: 'bsc', decimals: 18, kind: 'native', note: 'Native gas asset.' },

  // ── Ethereum ─────────────────────────────────────────────────────────────
  {
    symbol: 'USDT',
    chain: 'ethereum',
    decimals: 6,
    kind: 'erc20',
    contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    note: 'Tether USD. Issuer can freeze balances; disclosed rather than disqualifying.',
  },
  {
    symbol: 'USDC',
    chain: 'ethereum',
    decimals: 6,
    kind: 'erc20',
    contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    note: 'Circle USD Coin. Upgradeable proxy by design.',
  },
  { symbol: 'ETH', chain: 'ethereum', decimals: 18, kind: 'native', note: 'Native gas asset.' },

  // ── Polygon PoS ──────────────────────────────────────────────────────────
  {
    symbol: 'USDT',
    chain: 'polygon',
    decimals: 6,
    kind: 'erc20',
    contract: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    note: 'Bridged Tether USD on Polygon PoS.',
  },
  {
    symbol: 'USDC',
    chain: 'polygon',
    decimals: 6,
    kind: 'erc20',
    contract: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    note: 'Native Circle USDC on Polygon, not the older bridged USDC.e.',
  },
  { symbol: 'POL', chain: 'polygon', decimals: 18, kind: 'native', note: 'Native gas asset.' },

  // ── TON ──────────────────────────────────────────────────────────────────
  { symbol: 'TON', chain: 'ton', decimals: 9, kind: 'native', note: 'Native asset.' },
  {
    symbol: 'USDT',
    chain: 'ton',
    decimals: 6,
    kind: 'jetton',
    contract: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs',
    note: 'Tether USD jetton on TON.',
  },

  // ── Solana ───────────────────────────────────────────────────────────────
  { symbol: 'SOL', chain: 'solana', decimals: 9, kind: 'native', note: 'Native asset.' },
  {
    symbol: 'USDC',
    chain: 'solana',
    decimals: 6,
    kind: 'spl',
    contract: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    note: 'Circle USDC SPL mint.',
  },
  {
    symbol: 'USDT',
    chain: 'solana',
    decimals: 6,
    kind: 'spl',
    contract: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    note: 'Tether USD SPL mint.',
  },

  // ── TRON — built last, but the registry entry is settled ─────────────────
  { symbol: 'TRX', chain: 'tron', decimals: 6, kind: 'native', note: 'Native asset.' },
  {
    symbol: 'USDT',
    chain: 'tron',
    decimals: 6,
    kind: 'trc20',
    contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    note: 'Tether USD TRC-20, the highest-volume stablecoin contract anywhere.',
  },
];

/**
 * What a complete catalogue would carry on every chain.
 *
 * Written down so that "missing" and "deliberately absent" are different states. Without
 * it, a chain quietly lacking USDC looks identical to a chain where we decided against it,
 * and the only way to tell is for somebody to notice — usually a merchant.
 */
export const EXPECTED_STABLECOINS: readonly string[] = ['USDT', 'USDC'];

/**
 * A stablecoin we do not carry on a chain, and why not.
 *
 * Every one of these is here for the same reason: the address is the whole of the
 * protection. `CURATED_ASSETS` entries arrive `approved` with no probe and no review, so a
 * wrong address in that list is a counterfeit token approved for every merchant at once —
 * and an address recalled from memory is exactly how a wrong one gets in.
 *
 * So a gap stays a gap until a human has the issuer's own page open beside the panel. The
 * admin catalogue offers "Add a currency" for precisely that, and it records where the
 * address was verified. Listing the gaps here is what turns an omission into a task.
 */
export interface CuratedGap {
  readonly chain: ChainId;
  readonly symbol: string;
  readonly kind: Asset['kind'];
  /** What is missing, and what would close it. */
  readonly reason: string;
}

export const CURATED_GAPS: readonly CuratedGap[] = [
  {
    chain: 'ton',
    symbol: 'USDC',
    kind: 'jetton',
    reason:
      'Circle issues USDC on TON, but its jetton master address is not recorded here. ' +
      'Add it through the admin catalogue once the address has been read off Circle’s own ' +
      'documentation — not from memory, and not from a block explorer’s search results, ' +
      'which rank by activity and will happily put a copycat first.',
  },
  {
    chain: 'tron',
    symbol: 'USDC',
    kind: 'trc20',
    reason:
      'Circle issues USDC as a TRC-20 contract, but its address is not recorded here. ' +
      'Same rule: verify it against Circle’s own documentation before adding it, because a ' +
      'curated entry is approved for every merchant with no review behind it.',
  },
];

/**
 * Which of the expected stablecoins each chain is missing, and whether that is on purpose.
 *
 * Returns one row per hole. A hole with a declared gap is a decision; one without is an
 * oversight, and the test beside this refuses to let the second kind exist quietly.
 */
export function curatedCoverage(
  chains: readonly ChainId[],
): readonly {
  readonly chain: ChainId;
  readonly symbol: string;
  readonly declared: CuratedGap | null;
}[] {
  const holes = [];

  for (const chain of chains) {
    const carried = new Set(
      CURATED_ASSETS.filter((asset) => asset.chain === chain).map((asset) =>
        asset.symbol.toUpperCase(),
      ),
    );

    for (const symbol of EXPECTED_STABLECOINS) {
      if (carried.has(symbol)) continue;
      holes.push({
        chain,
        symbol,
        declared:
          CURATED_GAPS.find(
            (gap) => gap.chain === chain && gap.symbol.toUpperCase() === symbol,
          ) ?? null,
      });
    }
  }

  return holes;
}

/** Curated entry for a chain and contract, or null. Case-insensitive. */
export function findCuratedAsset(
  chain: ChainId,
  contract: string | null,
): CuratedAsset | null {
  const needle = contract?.toLowerCase() ?? null;
  return (
    CURATED_ASSETS.find((asset) => {
      if (asset.chain !== chain) return false;
      if (needle === null) return asset.contract === undefined;
      return asset.contract?.toLowerCase() === needle;
    }) ?? null
  );
}

export function isCurated(chain: ChainId, contract: string | null): boolean {
  return findCuratedAsset(chain, contract) !== null;
}

export function curatedForChain(chain: ChainId): readonly CuratedAsset[] {
  return CURATED_ASSETS.filter((asset) => asset.chain === chain);
}

/**
 * Whether a symbol is claimed by a curated asset on a *different* contract.
 *
 * The impersonation test: "USDT" on BSC is legitimate at one address and a fraud
 * at every other.
 */
export function symbolClaimedElsewhere(
  chain: ChainId,
  contract: string | null,
  symbol: string,
): boolean {
  const upper = symbol.toUpperCase();
  const needle = contract?.toLowerCase() ?? null;

  return CURATED_ASSETS.some(
    (asset) =>
      asset.chain === chain &&
      asset.symbol.toUpperCase() === upper &&
      (asset.contract?.toLowerCase() ?? null) !== needle,
  );
}

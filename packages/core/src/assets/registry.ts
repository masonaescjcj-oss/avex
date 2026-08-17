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

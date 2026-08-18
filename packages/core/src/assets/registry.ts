import type { Asset, ChainId } from '../types.js';

/**
 * The curated global asset list.
 *
 * The only path to `approved` without a human. Every entry is a contract address
 * verified against the issuer's own documentation, because the whole defence against a
 * token calling itself USDT is knowing which address the real one lives at.
 *
 * Addresses are checksummed. Comparisons lowercase both sides — a merchant pasting
 * a lowercase address must still match.
 */

/**
 * Who actually issues the token at this address.
 *
 * The distinction a payment gateway cannot afford to blur. `native` means the stablecoin's
 * own issuer mints it on that chain and will redeem it: Tether's USD₮ on TRON, Circle's
 * USDC on Solana. `bridged` means somebody else holds the real thing and issues a
 * representation of it — Binance-Peg BSC-USD is a Binance liability, not a Tether one.
 *
 * Both are perfectly usable and merchants accept both. But they fail differently: a native
 * token depends on its issuer's reserves, a bridged one depends on those *and* on the
 * bridge's custodian. A merchant choosing what to accept is entitled to know which they are
 * taking, and calling both of them plainly "USDT" would hide it.
 */
export type CuratedIssuer = 'native' | 'bridged';

/** Where an address was checked, so the claim can be re-checked rather than trusted. */
export interface CuratedSource {
  /** The issuer's own page. Not a block explorer, whose search ranks by activity. */
  readonly url: string;
  /** ISO date the address was last read off that page. */
  readonly checkedOn: string;
}

export interface CuratedAsset extends Asset {
  /** Why this entry is trusted, for the audit trail. */
  readonly note: string;
  readonly issuer: CuratedIssuer;
  /**
   * The page the address came from.
   *
   * Recorded because "verified by hand" is unfalsifiable a year later. A URL and a date can
   * be re-opened; a claim that somebody once checked cannot. Native assets have no contract
   * to verify, so they carry the chain's own documentation instead.
   */
  readonly source: CuratedSource;
}

/** Issuer pages the addresses below were read from. */
const TETHER = 'https://tether.to/en/supported-protocols/';
const CIRCLE = 'https://developers.circle.com/stablecoins/usdc-contract-addresses';
const BINANCE_PEG = 'https://www.binance.com/en/blog/ecosystem/introducing-binancepegged-tokens-421499824684903156';
const CHECKED = '2026-08-18';

export const CURATED_ASSETS: readonly CuratedAsset[] = [
  // ── BNB Smart Chain — the first chain to go live ──────────────────────────
  {
    symbol: 'USDT',
    chain: 'bsc',
    decimals: 18,
    kind: 'erc20',
    contract: '0x55d398326f99059fF775485246999027B3197955',
    note: 'Binance-Peg BSC-USD, not a Tether issuance — Tether lists no BNB Chain contract. Note 18 decimals, not the 6 used on Ethereum.',
    issuer: 'bridged',
    source: { url: BINANCE_PEG, checkedOn: CHECKED },
  },
  {
    symbol: 'USDC',
    chain: 'bsc',
    decimals: 18,
    kind: 'erc20',
    contract: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    note: 'Binance-Peg USD Coin, not a Circle issuance — Circle lists no BNB Chain contract. 18 decimals.',
    issuer: 'bridged',
    source: { url: BINANCE_PEG, checkedOn: CHECKED },
  },
  { symbol: 'BNB', chain: 'bsc', decimals: 18, kind: 'native', note: 'Native gas asset.',
    issuer: 'native',
    source: { url: 'https://docs.bnbchain.org/', checkedOn: CHECKED } },

  // ── Ethereum ─────────────────────────────────────────────────────────────
  {
    symbol: 'USDT',
    chain: 'ethereum',
    decimals: 6,
    kind: 'erc20',
    contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    note: 'Tether USD, issued by Tether. Issuer can freeze balances; disclosed rather than disqualifying.',
    issuer: 'native',
    source: { url: TETHER, checkedOn: CHECKED },
  },
  {
    symbol: 'USDC',
    chain: 'ethereum',
    decimals: 6,
    kind: 'erc20',
    contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    note: 'Circle USD Coin. Upgradeable proxy by design.',
    issuer: 'native',
    source: { url: CIRCLE, checkedOn: CHECKED },
  },
  { symbol: 'ETH', chain: 'ethereum', decimals: 18, kind: 'native', note: 'Native gas asset.',
    issuer: 'native',
    source: { url: 'https://ethereum.org/en/developers/docs/', checkedOn: CHECKED } },

  // ── Polygon PoS ──────────────────────────────────────────────────────────
  {
    symbol: 'USDT',
    chain: 'polygon',
    decimals: 6,
    kind: 'erc20',
    contract: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    note: 'Bridged Tether USD on Polygon PoS. Tether does not list Polygon among its supported chains, so this is a bridged representation rather than a Tether issuance.',
    issuer: 'bridged',
    source: { url: TETHER, checkedOn: CHECKED },
  },
  {
    symbol: 'USDC',
    chain: 'polygon',
    decimals: 6,
    kind: 'erc20',
    contract: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    note: 'Native Circle USDC on Polygon PoS, not the older bridged USDC.e.',
    issuer: 'native',
    source: { url: CIRCLE, checkedOn: CHECKED },
  },
  { symbol: 'POL', chain: 'polygon', decimals: 18, kind: 'native', note: 'Native gas asset.',
    issuer: 'native',
    source: { url: 'https://docs.polygon.technology/', checkedOn: CHECKED } },

  // ── TON ──────────────────────────────────────────────────────────────────
  { symbol: 'TON', chain: 'ton', decimals: 9, kind: 'native', note: 'Native asset.',
    issuer: 'native',
    source: { url: 'https://docs.ton.org/', checkedOn: CHECKED } },
  {
    symbol: 'USDT',
    chain: 'ton',
    decimals: 6,
    kind: 'jetton',
    contract: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs',
    note: 'Tether USD jetton on TON, issued by Tether.',
    issuer: 'native',
    source: { url: TETHER, checkedOn: CHECKED },
  },

  // ── Solana ───────────────────────────────────────────────────────────────
  { symbol: 'SOL', chain: 'solana', decimals: 9, kind: 'native', note: 'Native asset.',
    issuer: 'native',
    source: { url: 'https://solana.com/docs', checkedOn: CHECKED } },
  {
    symbol: 'USDC',
    chain: 'solana',
    decimals: 6,
    kind: 'spl',
    contract: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    note: 'Circle USDC SPL mint.',
    issuer: 'native',
    source: { url: CIRCLE, checkedOn: CHECKED },
  },
  {
    symbol: 'USDT',
    chain: 'solana',
    decimals: 6,
    kind: 'spl',
    contract: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    note: 'Tether USD SPL mint, issued by Tether.',
    issuer: 'native',
    source: { url: TETHER, checkedOn: CHECKED },
  },

  // ── TRON — built last, but the registry entry is settled ─────────────────
  { symbol: 'TRX', chain: 'tron', decimals: 6, kind: 'native', note: 'Native asset.',
    issuer: 'native',
    source: { url: 'https://developers.tron.network/', checkedOn: CHECKED } },
  {
    symbol: 'USDT',
    chain: 'tron',
    decimals: 6,
    kind: 'trc20',
    contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    note: 'Tether USD TRC-20, the highest-volume stablecoin contract anywhere.',
    issuer: 'native',
    source: { url: TETHER, checkedOn: CHECKED },
  },
];

/**
 * What a complete catalogue would carry on every chain, if the issuers offered it.
 *
 * Written down so that "missing" and "does not exist" are different states. Without it, a
 * chain lacking USDC looks the same whether nobody added it or the issuer never minted
 * there — and the first is a task while the second is a fact.
 */
export const EXPECTED_STABLECOINS: readonly string[] = ['USDT', 'USDC'];

/**
 * A stablecoin we do not carry on a chain, and which kind of absence it is.
 *
 * `not_issued` closes the question: the issuer does not mint it there, so no address exists
 * and none ever will until they change their mind. An entry like this must not read as a
 * task, or an operator goes looking for an address that cannot be found — and the way that
 * ends is somebody adding a lookalike they found on an explorer.
 *
 * `unverified` is the open case: it exists, and nobody has read the address off the
 * issuer's own page yet. That is the one the panel should nag about.
 *
 * The distinction is load-bearing because `CURATED_ASSETS` entries arrive `approved` with no
 * probe behind them. A wrong address there is a counterfeit approved for every merchant at
 * once, so "we could not find it" has to be a stable resting state rather than pressure.
 */
export type GapKind =
  /** The issuer does not mint this asset on this chain. There is nothing to add. */
  | 'not_issued'
  /** It exists; the address has not been verified against the issuer's own page yet. */
  | 'unverified';

export interface CuratedGap {
  readonly chain: ChainId;
  readonly symbol: string;
  readonly kind: GapKind;
  /** What the issuer says, and where they say it. */
  readonly reason: string;
  readonly source: CuratedSource;
}

export const CURATED_GAPS: readonly CuratedGap[] = [
  {
    chain: 'tron',
    symbol: 'USDC',
    kind: 'not_issued',
    /**
     * Circle wound this down deliberately, and said so.
     *
     * Which makes it the most dangerous kind of absence: USDC on TRON *used to* exist, so
     * an address for it is findable, still has a contract on chain, and would probe
     * perfectly well. Adding it would give merchants a token whose issuer has stopped
     * minting and stopped redeeming — worth nothing that Circle will honour.
     */
    reason:
      'Circle discontinued USDC on TRON: minting stopped in February 2024 and the ' +
      'wind-down for transfers and redemption ran through February 2025. Contracts from ' +
      'before then are still on chain and still findable, which is exactly why this must ' +
      'not be added — the issuer no longer redeems them.',
    source: {
      url: 'https://www.circle.com/blog/circle-is-discontinuing-support-for-usdc-on-the-tron-blockchain',
      checkedOn: CHECKED,
    },
  },
  {
    chain: 'ton',
    symbol: 'USDC',
    kind: 'not_issued',
    reason:
      'Circle does not issue USDC on TON. TON is absent from Circle’s own list of chains ' +
      'carrying native USDC, so any USDC-labelled jetton there is somebody else’s bridged ' +
      'representation rather than a Circle liability.',
    source: { url: 'https://www.circle.com/multi-chain-usdc', checkedOn: CHECKED },
  },
];

/**
 * Which of the expected stablecoins each chain is missing, and what kind of absence it is.
 *
 * Returns one row per hole. A hole with no declaration is an oversight, and the test beside
 * this refuses to let that exist quietly — but a declared `not_issued` is an answer, not a
 * backlog item, and callers are expected to render the two differently.
 */
export function curatedCoverage(
  chains: readonly ChainId[],
  /**
   * Injectable so the undeclared case can be reached.
   *
   * With the real list every hole happens to be declared, which makes "an undeclared hole is
   * treated as work" untestable against production data — and that is the branch whose
   * failure is silent: an oversight would simply stop appearing.
   */
  gaps: readonly CuratedGap[] = CURATED_GAPS,
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
          gaps.find((gap) => gap.chain === chain && gap.symbol.toUpperCase() === symbol) ?? null,
      });
    }
  }

  return holes;
}

/**
 * Holes somebody still has to close: it exists and we have not verified the address.
 *
 * Separated from the full coverage list because these are the only ones worth putting in
 * front of an operator. Telling somebody to go and add USDC on TRON — which Circle stopped
 * issuing — is worse than saying nothing: it sends them looking for an address that is
 * findable and wrong.
 */
export function openCuratedWork(
  chains: readonly ChainId[],
  gaps: readonly CuratedGap[] = CURATED_GAPS,
): readonly { readonly chain: ChainId; readonly symbol: string; readonly reason: string | null }[] {
  return curatedCoverage(chains, gaps)
    .filter((hole) => hole.declared === null || hole.declared.kind === 'unverified')
    .map((hole) => ({
      chain: hole.chain,
      symbol: hole.symbol,
      reason: hole.declared?.reason ?? null,
    }));
}

/** Curated assets whose token somebody other than the issuer stands behind. */
export function bridgedAssets(): readonly CuratedAsset[] {
  return CURATED_ASSETS.filter((asset) => asset.issuer === 'bridged');
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

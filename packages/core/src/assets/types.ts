import type { ChainId } from '../types.js';

/**
 * Contract vetting.
 *
 * Merchants can add their own token contracts, which is necessary and also the
 * most direct way an attacker reaches this system: anyone can deploy a contract
 * that calls itself USDT. Nothing is credited on the strength of what a contract
 * says about itself.
 */

export type FindingKind =
  /** Nothing deployed at the address. */
  | 'no_code'
  /** Does not answer the calls an ERC-20 must answer. */
  | 'not_erc20'
  /** A decimals value that breaks amount arithmetic or display. */
  | 'decimals_unusual'
  /** Fewer tokens arrive than were sent. */
  | 'fee_on_transfer'
  /** Balances change without a transfer. */
  | 'rebasing'
  /** Behaviour can be replaced after approval. */
  | 'upgradeable_proxy'
  /** The issuer can pause, freeze, blacklist or mint. */
  | 'issuer_controls'
  /** Claims the symbol of a major asset without being it. */
  | 'symbol_impersonation'
  /** No supply, so nothing can ever be paid with it. */
  | 'zero_supply';

/**
 * Whether the check answered.
 *
 * `unknown` is not a soft `absent`. A check that could not run has established
 * nothing, and treating silence as safety is how an unvetted contract reaches
 * production — so `unknown` on anything that affects money forces manual review.
 */
export type FindingStatus = 'present' | 'absent' | 'unknown';

export type Severity =
  /** Cannot be used at all, under any review. */
  | 'blocking'
  /** Needs a human decision before it may credit invoices. */
  | 'high'
  /** Needs disclosure and a human decision. */
  | 'medium'
  /** Worth recording, not worth blocking. */
  | 'info';

export interface Finding {
  readonly kind: FindingKind;
  readonly status: FindingStatus;
  readonly severity: Severity;
  readonly detail: string;
}

export interface Erc20Metadata {
  readonly symbol: string | null;
  readonly name: string | null;
  readonly decimals: number | null;
  readonly totalSupply: bigint | null;
}

export type AssetVerdict =
  /** Unusable. */
  | 'blocked'
  /** Plausible, but a human must decide. */
  | 'review'
  /** Safe to enable without a human. Reserved for the curated list. */
  | 'approved';

export interface VettingReport {
  readonly chain: ChainId;
  readonly contract: string;
  readonly metadata: Erc20Metadata;
  readonly findings: readonly Finding[];
  readonly verdict: AssetVerdict;
  /**
   * True when no configured price source can quote this symbol, so the merchant
   * must supply a rate themselves. The link back to the pricing engine: an asset
   * nobody prices cannot be sold in fiat terms at a market rate.
   */
  readonly requiresFixedRate: boolean;
  readonly probedAt: number;
}

/** Symbols a major asset owns. A contract claiming one of these had better be it. */
export const RESERVED_SYMBOLS: readonly string[] = [
  'USDT',
  'USDC',
  'ETH',
  'WETH',
  'BNB',
  'WBNB',
  'BTC',
  'WBTC',
  'DAI',
  'POL',
  'MATIC',
  'TRX',
  'SOL',
  'TON',
  'BUSD',
];

/**
 * Decimals outside this range are rejected outright.
 *
 * Above 36, `10 ** decimals` starts to dominate the integer arithmetic in
 * `pricing/rate.ts`; a contract declaring 255 is either broken or deliberately
 * trying to overflow a consumer.
 */
export const MAX_SANE_DECIMALS = 36;

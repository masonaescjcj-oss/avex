/**
 * Core domain types for AVEX Pay.
 *
 * Money rule: on-chain amounts are ALWAYS `bigint` in the asset's smallest unit.
 * Floating point appears only in fee heuristics (see fees/FeePolicy.ts), never in
 * a balance, an amount due, or anything that lands in the ledger.
 */

/**
 * The chains AVEX Pay supports.
 *
 * Bitcoin is deliberately absent. It has no equivalent of the Forwarder's
 * immutable destination, so consolidating deposits would require holding
 * spending keys — making that one path custodial while every other path is not.
 * Rather than ship a gateway whose non-custodial claim has an asterisk, Bitcoin
 * is out of v1. See docs/ARCHITECTURE.md.
 */
export type ChainId =
  | 'ethereum'
  | 'polygon'
  | 'bsc'
  | 'tron'
  | 'solana'
  | 'ton';

/**
 * How a chain identifies which invoice an incoming payment belongs to.
 *
 * - `unique`     : one freshly derived address per invoice. Deriving is free on
 *                  every chain we support; only settling costs money, and we
 *                  choose when that happens (see sweep/SettlementQueue.ts).
 * - `shared-memo`: one address for many invoices, disambiguated by a native memo
 *                  field. Strictly better where available — zero settlement cost,
 *                  because funds land directly in the destination wallet.
 */
export type AddressModel = 'unique' | 'shared-memo';

export type AssetKind = 'native' | 'erc20' | 'trc20' | 'spl' | 'jetton';

export interface Asset {
  readonly symbol: string;
  readonly chain: ChainId;
  readonly decimals: number;
  readonly kind: AssetKind;
  /** Contract / mint / jetton master address. Absent for native assets. */
  readonly contract?: string;
}

export type InvoiceStatus =
  /** Created; deposit target handed to the payer; nothing seen yet. */
  | 'pending'
  /** A matching transaction is visible but not yet final. */
  | 'confirming'
  /** Final and within tolerance. The merchant has been credited. */
  | 'paid'
  /** Final but short of `amountDue` beyond tolerance. Needs a decision. */
  | 'underpaid'
  /** Final and above `amountDue` beyond tolerance. Needs a refund decision. */
  | 'overpaid'
  /** Window closed with no final payment. */
  | 'expired';

export interface Invoice {
  readonly id: string;
  readonly merchantId: string;
  readonly asset: Asset;

  /** Amount owed, in the asset's smallest unit. */
  readonly amountDue: bigint;
  /** Sum of all final payments matched to this invoice. */
  amountPaid: bigint;

  status: InvoiceStatus;

  /**
   * Where the money ends up. In the non-custodial model this is the merchant's
   * own address, and on EVM chains it is baked into the deposit address's
   * init code — so the deposit address cryptographically commits to this
   * destination and not even AVEX can redirect the funds.
   */
  readonly payoutAddress: string;

  /** Address the payer sends to. */
  readonly depositAddress: string;
  /** Present only on `shared-memo` chains. */
  readonly memo?: string;

  /**
   * Accepted deviation from `amountDue`, in basis points. Exchanges round
   * withdrawal amounts, so a strict equality check rejects good payments.
   */
  readonly toleranceBps: number;

  readonly createdAt: number;
  readonly expiresAt: number;
}

/** A payment observed on-chain. */
export interface IncomingPayment {
  readonly chain: ChainId;
  readonly txHash: string;
  /**
   * Position of the transfer within the transaction. Together with `txHash`
   * this is the idempotency key: a transaction can carry several transfers,
   * and a reorg can replay the whole thing.
   */
  readonly transferIndex: number;
  readonly to: string;
  readonly memo?: string;
  readonly asset: Asset;
  readonly amount: bigint;
  readonly blockNumber: number;
  readonly confirmations: number;
}

/** Idempotency key for an observed transfer. Never credit the same one twice. */
export function paymentKey(p: IncomingPayment): string {
  return `${p.chain}:${p.txHash}:${p.transferIndex}`;
}

/**
 * Live fee conditions for one chain. Produced by a per-chain probe and consumed
 * by FeePolicy. Fields are chain-specific; only the relevant ones are set.
 */
export interface GasSnapshot {
  readonly chain: ChainId;
  /** USD price of the chain's native token, from the price oracle. */
  readonly nativePriceUsd: number;
  /** EVM: base fee + priority, in wei. */
  readonly feePerGasWei?: bigint;
  /** Tron: SUN per unit of energy when not covered by delegation. */
  readonly sunPerEnergy?: number;
  /** Solana: lamports per signature. */
  readonly lamportsPerSignature?: number;
  readonly observedAt: number;
}

export interface SettlementCost {
  readonly chain: ChainId;
  readonly usd: number;
  /** Human-readable basis for the estimate, for logs and merchant-facing UI. */
  readonly detail: string;
}

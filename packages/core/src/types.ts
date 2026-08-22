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
/**
 * How a chain tells one invoice's payment from another's.
 *
 * `unique` — one address per invoice, derived so that funds sent there can only reach the
 * merchant. EVM and Solana.
 *
 * `shared-memo` — one address for everything, and the payer's transfer carries a comment
 * naming the invoice. TON.
 *
 * `pooled` — a handful of the merchant's own addresses, and the invoice is named by the exact
 * amount it asks for. TRON, because TRC-20 transfers carry no memo and a per-invoice contract
 * pays for its own code on every first sweep. The payer's transfer lands in the merchant's
 * wallet directly, so there is no settlement transaction at all — which is what makes it the
 * cheapest model on that chain rather than merely the cheapest-looking one. The cost is that
 * two payers on one address who both send the wrong amount cannot be told apart, and that case
 * goes to a human.
 */
export type AddressModel = 'unique' | 'shared-memo' | 'pooled';

export type AssetKind = 'native' | 'erc20' | 'trc20' | 'spl' | 'jetton';

export interface Asset {
  readonly symbol: string;
  readonly chain: ChainId;
  readonly decimals: number;
  readonly kind: AssetKind;
  /** Contract / mint / jetton master address. Absent for native assets. */
  readonly contract?: string;
}

/**
 * A percentage cut taken at settlement, alongside the merchant's payout.
 *
 * Lives here rather than beside the chain adapters because an invoice carries one:
 * on `unique`-address chains it is part of what the deposit address commits to, so
 * derivation and settlement must be handed identical values or they name different
 * addresses.
 */
export interface FeeSplit {
  readonly feeDestination: string;
  /** Basis points of the swept amount. Capped by the forwarder at 500 (5%). */
  readonly feeBps: number;
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
   * The percentage cut taken at settlement, fixed when this invoice was created.
   *
   * Recorded on the invoice rather than read from configuration at sweep time, and
   * that is not a preference. On `unique`-address chains the fee is part of the
   * init code that produced `depositAddress`, so settling with a different fee
   * derives a different address — one nobody funded — and the money would sit in
   * the forwarder indefinitely. Changing our pricing must not orphan invoices
   * already in flight, so the fee is snapshotted here and the snapshot is what
   * settlement uses.
   *
   * Absent means no fee: a merchant on a negotiated 0%, a chain we hold no collector
   * address for, or a Stars record, which never touches a chain to take a cut from.
   */
  readonly fee?: FeeSplit;

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

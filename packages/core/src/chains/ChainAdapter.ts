import type {
  AddressModel,
  Asset,
  ChainId,
  GasSnapshot,
  IncomingPayment,
} from '../types.js';

/** Where the payer sends funds for one invoice. */
export interface DepositTarget {
  readonly address: string;
  /** Set only on `shared-memo` chains; the payer MUST include it. */
  readonly memo?: string;
}

/**
 * A percentage cut taken at settlement, alongside the merchant's payout.
 *
 * Present on both derivation and settlement because on `unique`-address chains it
 * is baked into the deposit address, so the two must be given identical values or
 * they name different addresses. Optional, and absent means no fee — which is the
 * case for every subscription-only merchant.
 */
export interface FeeSplit {
  readonly feeDestination: string;
  readonly feeBps: number;
}

export interface DeriveInput {
  readonly invoiceId: string;
  /** The merchant's own address. Funds may only ever move here. */
  readonly payoutAddress: string;
  readonly asset: Asset;
  readonly fee?: FeeSplit | undefined;
}

/** One invoice's worth of funds waiting to be moved to the merchant. */
export interface SettlementRequest {
  readonly invoiceId: string;
  readonly depositAddress: string;
  readonly payoutAddress: string;
  readonly asset: Asset;
  readonly amount: bigint;
  /**
   * The fee this invoice was quoted with, read back from its record.
   *
   * Not a current configuration value. The deposit address commits to the fee, so
   * sweeping with a different one derives an address nobody funded and the money
   * stays where it is.
   */
  readonly fee?: FeeSplit | undefined;
}

export interface SettlementResult {
  readonly txHash: string;
  /** Fee actually paid, in the chain's native smallest unit. */
  readonly feePaid: bigint;
  /** Invoices covered by this transaction — a batch settles many at once. */
  readonly invoiceIds: readonly string[];
}

/**
 * Opaque per-chain position marker for the payment watcher. Persist it so a
 * restart resumes where it stopped instead of rescanning history.
 */
export type PollCursor = string | null;

export interface PollResult {
  readonly payments: readonly IncomingPayment[];
  readonly cursor: PollCursor;
}

/**
 * The seam that makes adding a chain cheap.
 *
 * Everything chain-specific — address derivation, transfer discovery, fee units,
 * settlement mechanics — lives behind this interface. Nothing above it (invoice
 * state machine, fee policy, settlement queue, webhooks) knows which chain it is
 * talking to. Getting this boundary right on day one is the difference between
 * "half a day to add a chain" and an unmaintainable codebase at chain four.
 */
export interface ChainAdapter {
  readonly chain: ChainId;
  readonly addressModel: AddressModel;

  /**
   * Derive the deposit target for an invoice. Must be deterministic: calling it
   * twice with the same input yields the same target, so a lost response never
   * strands a payer at an address we forgot.
   *
   * Non-custodial invariant: on `unique` chains the derived address must be
   * bound to `payoutAddress` such that funds sent to it can only reach the
   * merchant. On EVM this holds because the destination is an immutable
   * constructor argument, and therefore part of the CREATE2 init code hash that
   * determines the address itself.
   */
  deriveDepositTarget(input: DeriveInput): Promise<DepositTarget>;

  /** Discover transfers to watched targets. Called on a timer by the watcher. */
  poll(cursor: PollCursor): Promise<PollResult>;

  /** Current fee conditions, for FeePolicy. */
  probeGas(): Promise<GasSnapshot>;

  /**
   * Move funds to the merchants' payout addresses, batching where the chain
   * allows it — one EVM transaction deploying and flushing many forwarders, one
   * TRON batch under delegated energy, and so on.
   *
   * `shared-memo` chains have nothing to do here — the payer's own transfer
   * already delivered the funds — and return an empty array.
   */
  settle(batch: readonly SettlementRequest[]): Promise<readonly SettlementResult[]>;
}

/** Settlement implementation for `shared-memo` chains: there is no work to do. */
export async function noSettlementNeeded(): Promise<readonly SettlementResult[]> {
  return [];
}

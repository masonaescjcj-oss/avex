import type { AddressModel, ChainId } from '../types.js';

/**
 * Per-chain cost model used by FeePolicy to turn a live GasSnapshot into a USD
 * settlement cost. Each chain measures work differently, so the profile is a
 * discriminated union rather than one fake "gas" number.
 */
export type SettlementProfile =
  | {
      readonly kind: 'evm';
      /** CREATE2 deploy of the forwarder + flush of one token, in gas units. */
      readonly gasDeployAndFlushToken: number;
      /** Flush of the native asset from an already-deployed forwarder. */
      readonly gasFlushNative: number;
    }
  | {
      readonly kind: 'solana';
      readonly signaturesPerFlush: number;
      /** Lamports locked as rent for an associated token account. Refundable. */
      readonly ataRentLamports: number;
    }
  | {
      /** Shared-memo chains settle for free: funds land in the destination wallet. */
      readonly kind: 'direct';
    };

/**
 * Measured settlement gas for the EVM forwarder, shared by every EVM chain.
 *
 * Identical bytecode means identical gas; only the price of gas differs, and that
 * comes from a live snapshot rather than from this table. Both figures are measured
 * against the compiled contract by contracts/test/settlement-gas.test.mjs, which
 * fails if they drift — they are claims about bytecode, and a comment cannot check
 * itself.
 *
 * The marginal cost of one more invoice in a batch, not the cost of a whole
 * transaction: the 21,000-gas floor is paid once however many invoices ride along,
 * so charging it per invoice would make every batch look uneconomic.
 */

/**
 * CREATE2 deploy of a deposit address plus a token flush: 86,546 measured, rounded up.
 *
 * It was 400,000, and the difference is the whole reason the floor under an invoice moved.
 * A deposit address used to deploy a full copy of the forwarder — 1,567 bytes at 200 gas each,
 * 313,400 of the total — and now deploys an 87-byte minimal proxy that delegates to one shared
 * implementation. Four fifths of the cost of moving a merchant's money was writing bytecode
 * identical to the bytecode next door.
 *
 * What is left is mostly irreducible: 32,000 for CREATE2, a token transfer or two, and the
 * account the merchant may not have. Which changes the character of the deferral logic — at a
 * tenth of a gwei on BNB Chain a settlement is half a cent rather than two and a half, so the
 * queue holds far less and `deferAboveUsd` bites far later.
 */
const EVM_GAS_DEPLOY_AND_FLUSH = 95_000;

/**
 * Flushing a deposit address that already exists: 16,206 measured, plus 25,000 for creating the
 * payout account when it has never held this asset.
 *
 * Still well below a deploy, though the gap narrowed from an order of magnitude to about five
 * times when the deploy stopped carrying a copy of the contract. Kept as its own figure so a
 * re-sweep — a payer who sent twice, a late transfer to a settled invoice — is not deferred as
 * though it cost a deployment.
 */
const EVM_GAS_FLUSH_ONLY = 42_000;

export interface ChainConfig {
  readonly chain: ChainId;
  readonly displayName: string;
  readonly addressModel: AddressModel;
  readonly nativeSymbol: string;
  readonly nativeDecimals: number;

  /**
   * Whether two spellings of one address may be compared with the case folded away.
   *
   * True of hex, false of base58 and base64url — and it decides which invoice a payment is
   * credited to, so the reasoning is written out where it is acted on: `chains/address-key.ts`.
   */
  readonly addressCase: 'insensitive' | 'sensitive';

  /**
   * Confirmations before a payment is treated as final. Scaled by value: a $5
   * invoice does not need the same reorg protection as a $50,000 one.
   */
  readonly confirmations: {
    readonly standard: number;
    readonly highValue: number;
    readonly highValueThresholdUsd: number;
  };

  /**
   * Whether a block this chain has confirmed can still be taken back.
   *
   * `'possible'` on every proof-of-work or proof-of-stake chain whose finality is
   * probabilistic, which is all of them here bar one: the watcher remembers block hashes,
   * compares them every pass, and rewinds when they disagree. `'none'` where finality is a
   * property of the consensus rather than of depth — Solana's `finalized` commitment means
   * rooted by a supermajority of stake, and a rooted slot is never removed.
   *
   * It is a registry fact and not a watcher setting because the watcher would otherwise have
   * to name the chain to know it, and this codebase decides per-address-model and
   * per-profile precisely so that adding a chain is a table entry. With `'none'` the reorg
   * machinery is switched off rather than fed slot hashes it would never disagree with —
   * which on Solana would be a hundred and twenty-eight `getBlock` calls per poll looking
   * for something that cannot happen.
   */
  readonly reorgs: 'possible' | 'none';

  readonly settlement: SettlementProfile;
}

export const CHAINS: Readonly<Record<ChainId, ChainConfig>> = {
  ethereum: {
    chain: 'ethereum',
    displayName: 'Ethereum',
    addressModel: 'unique',
    addressCase: 'insensitive',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    confirmations: { standard: 12, highValue: 32, highValueThresholdUsd: 10_000 },
    reorgs: 'possible',
    settlement: { kind: 'evm', gasDeployAndFlushToken: EVM_GAS_DEPLOY_AND_FLUSH, gasFlushNative: EVM_GAS_FLUSH_ONLY },
  },

  polygon: {
    chain: 'polygon',
    displayName: 'Polygon PoS',
    addressModel: 'unique',
    addressCase: 'insensitive',
    nativeSymbol: 'POL',
    nativeDecimals: 18,
    // Polygon PoS has historically produced deep reorgs; stay conservative.
    confirmations: { standard: 64, highValue: 128, highValueThresholdUsd: 10_000 },
    reorgs: 'possible',
    settlement: { kind: 'evm', gasDeployAndFlushToken: EVM_GAS_DEPLOY_AND_FLUSH, gasFlushNative: EVM_GAS_FLUSH_ONLY },
  },

  bsc: {
    chain: 'bsc',
    displayName: 'BNB Smart Chain',
    addressModel: 'unique',
    addressCase: 'insensitive',
    nativeSymbol: 'BNB',
    nativeDecimals: 18,
    confirmations: { standard: 15, highValue: 30, highValueThresholdUsd: 10_000 },
    reorgs: 'possible',
    settlement: { kind: 'evm', gasDeployAndFlushToken: EVM_GAS_DEPLOY_AND_FLUSH, gasFlushNative: EVM_GAS_FLUSH_ONLY },
  },

  // Highest stablecoin volume of any chain here, and the one Iranian payers
  // reach for first — but the last to be built, because energy delegation is a
  // prerequisite and it is the only chain whose adapter shares nothing with the
  // EVM implementation.
  tron: {
    chain: 'tron',
    displayName: 'TRON',
    // Pooled: a few of the merchant's own addresses, the exact amount names the invoice.
    // Why, and what it costs, in `chains/tron/TronAdapter.ts`.
    addressModel: 'pooled',
    // Base58Check. See `addressCase` above; `tron/address.ts` is the codec.
    addressCase: 'sensitive',
    nativeSymbol: 'TRX',
    nativeDecimals: 6,
    // TRON blocks are irreversible after 19 confirmations (2/3+1 of 27 SRs).
    confirmations: { standard: 19, highValue: 19, highValueThresholdUsd: 10_000 },
    reorgs: 'possible',
    // Nothing to settle: the payer's transfer already reached the merchant's own wallet.
    settlement: { kind: 'direct' },
  },

  solana: {
    chain: 'solana',
    displayName: 'Solana',
    /**
     * Pooled, not unique, and that is a decision about what was built.
     *
     * A unique deposit account per invoice is a better matching story and needs three things
     * this repository does not have: an ed25519 key per invoice, a sweep that closes the
     * associated token account to reclaim its rent, and a signer. None were written, so the
     * chain was excluded from the watcher and never offered to a payer — correct, and also
     * permanently unavailable. Pooled is what the product is built on everywhere else: the
     * payer sends to a wallet the merchant owns, the exact amount names the invoice, and
     * there is nothing to sweep and no key to hold. See `chains/solana/SolanaAdapter.ts`.
     */
    addressModel: 'pooled',
    // Base58, without the checksum wrapper TRON adds. Still case-significant.
    addressCase: 'sensitive',
    nativeSymbol: 'SOL',
    nativeDecimals: 9,
    /**
     * Slots, and they are not what makes a payment final here — the commitment is.
     *
     * Everything is read at `finalized`, which is already irreversible, so this count is
     * only the depth the sink is shown so that an ordinary payment credits on first sight.
     * Thirty-two slots is about thirteen seconds and is roughly what finality costs anyway.
     */
    confirmations: { standard: 32, highValue: 32, highValueThresholdUsd: 10_000 },
    reorgs: 'none',
    // Nothing to settle: the payer's transfer already reached the merchant's own wallet.
    settlement: { kind: 'direct' },
  },

  ton: {
    chain: 'ton',
    displayName: 'TON',
    // TON carries a native comment field, so one address serves every invoice
    // and the payer's transfer already lands in the merchant's wallet.
    addressModel: 'shared-memo',
    // Base64url, and case-significant like the base58 chains.
    addressCase: 'sensitive',
    nativeSymbol: 'TON',
    nativeDecimals: 9,
    confirmations: { standard: 1, highValue: 3, highValueThresholdUsd: 10_000 },
    reorgs: 'possible',
    settlement: { kind: 'direct' },
  },
};

export const SUPPORTED_CHAINS: readonly ChainId[] = Object.keys(CHAINS) as ChainId[];

export function chainConfig(chain: ChainId): ChainConfig {
  const config = CHAINS[chain];
  if (!config) throw new Error(`unsupported chain: ${chain}`);
  return config;
}

/** Confirmations required for a payment of the given USD value. */
export function requiredConfirmations(chain: ChainId, valueUsd: number): number {
  const { confirmations } = chainConfig(chain);
  return valueUsd >= confirmations.highValueThresholdUsd
    ? confirmations.highValue
    : confirmations.standard;
}

/**
 * EIP-155 chain ids, which a signed transaction must carry.
 *
 * Separate from the rest of the chain config because getting one wrong has a specific
 * and nasty consequence: a transaction signed for the wrong chain id is a valid
 * transaction on *that* chain, so it can be replayed there by anyone who sees it.
 * They are written out rather than fetched from the node, so a misconfigured RPC
 * endpoint cannot quietly change which chain we are signing for.
 */
export const EVM_CHAIN_IDS: Readonly<Record<string, number>> = {
  ethereum: 1,
  bsc: 56,
  polygon: 137,
};

export function evmChainId(chain: string): number {
  const id = EVM_CHAIN_IDS[chain];
  if (id === undefined) throw new Error(`no EIP-155 chain id is known for ${chain}`);
  return id;
}

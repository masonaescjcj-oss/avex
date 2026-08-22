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
      readonly kind: 'tron';
      /**
       * Energy for the settlement we actually perform: deploy the forwarder and flush it.
       *
       * This replaced a single `energyPerTransfer: 65_000`, which was the cost of a bare
       * TRC-20 `transfer` — the *payer's* transaction, not ours. Ours deploys a contract in
       * the same transaction that empties it, exactly as on EVM, and a contract deployment
       * pays for its own code at a fixed rate per byte on top of execution. Budgeting a
       * deploy at the price of a transfer understates our own cost by roughly six times, and
       * it is the number the minimum-invoice calculation is built on.
       *
       * TVM executes the same bytecode as the EVM and charges energy per opcode where the EVM
       * charges gas, so this is the repository's measured EVM figure carried across rather
       * than a second guess. It is still an estimate: nothing here has run against a TRON
       * node. Measure on Nile before this decides what a merchant is charged.
       */
      readonly energyDeployAndFlush: number;
      /** Flushing a forwarder that already exists — a second payment to the same address. */
      readonly energyFlushOnly: number;
      /**
       * Bandwidth points per transaction, priced by the network at a fixed 1000 SUN each.
       *
       * Small next to energy and deliberately still counted: the free daily allowance is 600
       * points per account, which one settlement spends, so in production this is paid on
       * every transaction rather than covered.
       */
      readonly bandwidthPerTransfer: number;
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
 * CREATE2 deploy of a forwarder plus a token flush: 385,000 measured, rounded up.
 *
 * Dominated by the code deposit — 200 gas for each of the runtime's ~1,570 bytes —
 * which is why deferring settlement until gas is cheap matters so much more here
 * than the arithmetic inside the contract does.
 */
const EVM_GAS_DEPLOY_AND_FLUSH = 400_000;

/**
 * Flushing a forwarder that already exists: 17,300 measured, plus 25,000 for
 * creating the payout account when it has never held this asset.
 *
 * An order of magnitude below a deploy, because there is no code to write. Kept as
 * its own figure so a re-sweep of an existing forwarder is not deferred as though
 * it cost a deployment.
 */
const EVM_GAS_FLUSH_ONLY = 45_000;

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
    settlement: { kind: 'evm', gasDeployAndFlushToken: EVM_GAS_DEPLOY_AND_FLUSH, gasFlushNative: EVM_GAS_FLUSH_ONLY },
  },

  // Highest stablecoin volume of any chain here, and the one Iranian payers
  // reach for first — but the last to be built, because energy delegation is a
  // prerequisite and it is the only chain whose adapter shares nothing with the
  // EVM implementation.
  tron: {
    chain: 'tron',
    displayName: 'TRON',
    addressModel: 'unique',
    // Base58Check. See `addressCase` above; `tron/address.ts` is the codec.
    addressCase: 'sensitive',
    nativeSymbol: 'TRX',
    nativeDecimals: 6,
    // TRON blocks are irreversible after 19 confirmations (2/3+1 of 27 SRs).
    confirmations: { standard: 19, highValue: 19, highValueThresholdUsd: 10_000 },
    settlement: {
      kind: 'tron',
      energyDeployAndFlush: EVM_GAS_DEPLOY_AND_FLUSH,
      energyFlushOnly: EVM_GAS_FLUSH_ONLY,
      bandwidthPerTransfer: 350,
    },
  },

  solana: {
    chain: 'solana',
    displayName: 'Solana',
    addressModel: 'unique',
    // Base58, without the checksum wrapper TRON adds. Still case-significant.
    addressCase: 'sensitive',
    nativeSymbol: 'SOL',
    nativeDecimals: 9,
    // 32 slots ≈ the `finalized` commitment level.
    confirmations: { standard: 32, highValue: 32, highValueThresholdUsd: 10_000 },
    settlement: { kind: 'solana', signaturesPerFlush: 1, ataRentLamports: 2_039_280 },
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

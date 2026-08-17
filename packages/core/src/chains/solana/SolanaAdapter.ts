import type { ChainAdapter, DeriveInput, DepositTarget, PollCursor, PollResult, SettlementRequest, SettlementResult } from '../ChainAdapter.js';
import type { ChainId, GasSnapshot } from '../../types.js';

const NOT_IMPLEMENTED = 'SolanaAdapter is not implemented yet — see the design notes in this file';

/**
 * Solana adapter — NOT YET IMPLEMENTED.
 *
 * Design decisions already settled:
 *
 * 1. Unique deposit accounts per invoice. At roughly $0.001 per settlement the
 *    cost of a unique address is irrelevant, so take the reliable matching.
 *
 * 2. Account rent is real but refundable. Each SPL associated token account locks
 *    about 0.00204 SOL, reclaimable by closing the account after settlement.
 *    FeePolicy deliberately excludes it from settlement cost and reports it in
 *    the detail string instead — it is working capital, not a fee. Closing
 *    accounts after settlement must be part of the settlement path, or the locked
 *    balance grows without bound.
 *
 * 3. `finalized` commitment, ~32 slots. Confirming at `processed` risks crediting
 *    a payment on a fork.
 *
 * 4. Mint allowlist. As on every chain, only mints in `acceptedAssets` credit an
 *    invoice; anyone can create a token that calls itself USDC.
 *
 * Note that derivation is ed25519-based and shares nothing with the EVM's HD
 * path, so this adapter cannot reuse `chains/evm/create2.ts`.
 */
export class SolanaAdapter implements ChainAdapter {
  readonly chain: ChainId = 'solana';
  readonly addressModel = 'unique' as const;

  deriveDepositTarget(_input: DeriveInput): Promise<DepositTarget> {
    throw new Error(NOT_IMPLEMENTED);
  }

  probeGas(): Promise<GasSnapshot> {
    throw new Error(NOT_IMPLEMENTED);
  }

  poll(_cursor: PollCursor): Promise<PollResult> {
    throw new Error(NOT_IMPLEMENTED);
  }

  settle(_batch: readonly SettlementRequest[]): Promise<readonly SettlementResult[]> {
    throw new Error(NOT_IMPLEMENTED);
  }
}

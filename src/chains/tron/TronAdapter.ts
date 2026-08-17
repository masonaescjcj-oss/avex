import type { ChainAdapter, DeriveInput, DepositTarget, PollCursor, PollResult, SettlementRequest, SettlementResult } from '../ChainAdapter.js';
import type { ChainId, GasSnapshot } from '../../types.js';

const NOT_IMPLEMENTED = 'TronAdapter is not implemented yet — see the design notes in this file';

/**
 * TRON adapter — NOT YET IMPLEMENTED.
 *
 * Design decisions already settled, so implementation is mechanical:
 *
 * 1. Unique addresses, not a shared one. TRC-20 has no native memo, so a shared
 *    address would force amount-matching, which breaks the moment an exchange
 *    rounds a withdrawal. Deriving addresses from an HD seed costs nothing; only
 *    settlement costs, and the queue decides when that happens.
 *
 * 2. Energy delegation, not per-transfer burn. TRON can delegate energy and
 *    bandwidth from a central staked account to a target address without sending
 *    it any TRX. That removes the gas-funding transaction entirely, halving the
 *    transaction count per settlement and taking the cost from roughly $1.20 to
 *    the region of $0.30. Set `tronEnergyDelegation` in FeePolicyConfig to match
 *    whether this is actually wired up — leaving it true while burning TRX would
 *    make every minimum-invoice calculation wrong in the dangerous direction.
 *
 * 3. 19 confirmations. TRON blocks become irreversible after 19 (2/3+1 of the 27
 *    super representatives), so there is no reason to wait longer or accept less.
 *
 * 4. Contract allowlist. TRC-20 clones impersonating USDT are common; only
 *    contracts in `acceptedAssets` may ever credit an invoice.
 */
export class TronAdapter implements ChainAdapter {
  readonly chain: ChainId = 'tron';
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

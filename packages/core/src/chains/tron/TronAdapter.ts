import type { ChainAdapter, DeriveInput, DepositTarget, PollCursor, PollResult, SettlementRequest, SettlementResult } from '../ChainAdapter.js';
import type { ChainId, GasSnapshot } from '../../types.js';

const NOT_IMPLEMENTED = 'TronAdapter is not implemented yet — see the design notes in this file';

/**
 * TRON adapter — NOT YET IMPLEMENTED.
 *
 * The design notes below were revised when the address codec and the cost model went in, and
 * two of the four decisions changed. Both changes are corrections, not preferences.
 *
 * 1. **CREATE2 forwarders, not addresses from an HD seed.** The note here used to say the
 *    deposit addresses would be derived from a seed, because "deriving addresses costs
 *    nothing; only settlement costs". That is true and it is not the constraint. An address
 *    derived from a seed is an ordinary account whose key we hold, so between the payer's
 *    transfer and our sweep the funds are ours to move anywhere — that is custody, it is what
 *    the front page promises we do not do, and `ChainAdapter.deriveDepositTarget` states the
 *    invariant in its own doc comment: on a `unique` chain the derived address must be bound
 *    to `payoutAddress` such that funds sent to it can only reach the merchant. TVM has
 *    CREATE2 and runs the same `Forwarder` bytecode, so the EVM construction ports directly:
 *    destination and fee are constructor arguments, therefore part of the init code hash,
 *    therefore part of the address. The extra energy a deployment costs over a bare transfer
 *    is the price of that guarantee, and it is now in the cost model where it can be seen.
 *
 * 2. **Energy is priced, never free.** `tronEnergyDelegation: boolean` is gone; the field is
 *    `tronEnergy: TronEnergySupply`, one of `burn` / `rented` / `staked`, and every one of
 *    them carries a price per energy unit. Delegated energy used to report a settlement cost
 *    of $0 on the grounds that staked TRX is paid for once. Staked TRX yields a *daily
 *    allowance*: each settlement spends a share of a finite quota, and when the quota is gone
 *    the next one burns TRX at full price. Zero made every minimum-invoice figure on TRON
 *    zero as well.
 *
 * 3. **19 confirmations.** Unchanged. TRON blocks are irreversible after 19 (2/3+1 of the 27
 *    super representatives), so there is no reason to wait longer or accept less.
 *
 * 4. **Contract allowlist.** Unchanged, and load-bearing. TRC-20 clones impersonating USDT
 *    are common and cheap to deploy; only contracts in `acceptedAssets` may ever credit an
 *    invoice.
 *
 * What exists already, so the implementation does not have to start with it:
 *
 *   - `tron/address.ts` — Base58Check both ways, plus the 21-byte and EVM-shaped hex forms.
 *     Every TronGrid response and every merchant-entered payout address goes through it.
 *   - `chains/address-key.ts` — how a TRON address is compared. Not by folding its case:
 *     base58 loses information when lowercased, and this codebase lowercased addresses
 *     everywhere before TRON arrived.
 *   - The cost model above, which decides the minimum invoice this chain can carry.
 *
 * What is still missing, in the order it will be needed: transaction building (TRON wraps its
 * calls in protobuf, so this shares nothing with `evm/transaction.ts`), signing over the
 * protobuf `raw_data` hash, TronGrid polling for TRC-20 `Transfer` events, and the energy
 * arrangement itself — rented or staked — without which every sweep burns TRX at full price.
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

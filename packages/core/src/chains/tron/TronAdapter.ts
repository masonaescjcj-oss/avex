import type { ChainAdapter, DeriveInput, DepositTarget, PollCursor, PollResult, SettlementRequest, SettlementResult } from '../ChainAdapter.js';
import type { ChainId, GasSnapshot } from '../../types.js';

const NOT_IMPLEMENTED = 'TronAdapter is not implemented yet — see the design notes in this file';

/**
 * TRON adapter — NOT YET IMPLEMENTED.
 *
 * The design notes below were revised when the address codec and the cost model went in, and
 * two of the four decisions changed. Both changes are corrections, not preferences.
 *
 * 1. **Pooled deposit addresses — the merchant's own — and not addresses derived from a seed.**
 *    The note here first said the addresses would come from an HD seed, because "deriving
 *    addresses costs nothing; only settlement costs". True, and not the constraint. An address
 *    derived from a seed is an ordinary account whose key we hold, so between the payer's
 *    transfer and our sweep the funds are ours to move anywhere. That is custody, whatever else
 *    it is called.
 *
 *    The second answer was a CREATE2 forwarder per invoice, as on EVM: destination and fee are
 *    constructor arguments, so they are part of the init code hash and therefore of the address
 *    itself, and nothing we hold can redirect the money. That construction ports to TVM
 *    unchanged and it is the right one on EVM. On TRON it is expensive in a specific way: a
 *    deployment pays for its own contract code by the byte, and the forwarder's runtime is over
 *    fifteen hundred bytes, so the code deposit — not the transfer — is the largest single cost
 *    in the system.
 *
 *    What is built instead: the merchant registers a handful of their own addresses, and an
 *    invoice is named by the exact amount it asks for. Nobody holds a key but the merchant, the
 *    payer's transfer lands in their wallet directly, and there is no settlement transaction to
 *    pay for. `WalletPoolService` and `wallet-pool-allocator.ts` in the API implement it.
 *
 *    The cost is one case, and it is worth stating plainly rather than discovering later. Two
 *    invoices open on one address, both paid an amount matching neither, cannot be told apart by
 *    anything on the chain: those go to an operator, and the payer goes to support. Everything
 *    else about the allocation exists to make that case rare — idle wallets are handed out
 *    before busy ones, because one open invoice on an address can absorb a wrong amount without
 *    ambiguity, and every open invoice is given a non-round amount so that a payer whose
 *    exchange truncated the withdrawal cannot land exactly on a stranger's invoice.
 *
 * 2. **There is no energy cost model any more, because there is no transaction.** For a while
 *    this was a live design question and the answer went through three versions. First
 *    `tronEnergyDelegation: boolean`, which reported a settlement cost of $0 while still
 *    sending a transaction — wrong, because staked TRX buys a finite *daily allowance* and each
 *    settlement spends a share of it, so the zero made every minimum-invoice figure on this
 *    chain zero too. Then a priced supply model, `burn` / `rented` / `staked`. Then the pooled
 *    design, which removes the transaction and makes the zero true. The middle version is in the
 *    history and would be needed again to offer per-invoice addresses here.
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

import type { ChainAdapter, DeriveInput, DepositTarget, PollCursor, PollResult, SettlementRequest, SettlementResult } from '../ChainAdapter.js';
import type { ChainId, GasSnapshot } from '../../types.js';

const NOT_IMPLEMENTED = 'BitcoinAdapter is not implemented yet — see the design notes in this file';

/**
 * Bitcoin adapter — NOT YET IMPLEMENTED.
 *
 * Design decisions already settled:
 *
 * 1. Unique addresses from the merchant's xpub, at `m/84'/0'/0'/0/{index}`.
 *    Deriving is free and requires no key material beyond a public key, so there
 *    is no reason to share an address and fall back to amount-matching.
 *
 * 2. Aggressive consolidation batching. Bitcoin's cost is entirely in spending,
 *    and a consolidation spending N inputs to one output costs roughly
 *    `vBytesOverhead + N * vBytesPerInput`. Batching 50 inputs takes the
 *    per-invoice cost from about $1.50 to about $0.10 — the single largest
 *    saving anywhere in the system, and the reason SettlementQueue exists.
 *
 * 3. Deferral bounded by `maxDeferralMs`, not left open. Waiting for a cheap
 *    block is free, but making a merchant wait indefinitely is not.
 *
 * 4. Confirmations scaled by value: 2 for ordinary invoices, 6 above the
 *    high-value threshold.
 *
 * Non-custodial note: this is the one chain where the model is weaker. Bitcoin
 * has no equivalent of the Forwarder's immutable destination, so consolidation
 * requires AVEX to hold spending keys for the deposit addresses. Either derive
 * the addresses from the merchant's own xpub and have the merchant co-sign, or
 * be explicit with merchants that Bitcoin settlement is custodial in a way the
 * EVM and TON paths are not. Do not describe it as non-custodial without one of
 * those two being true.
 */
export class BitcoinAdapter implements ChainAdapter {
  readonly chain: ChainId = 'bitcoin';
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

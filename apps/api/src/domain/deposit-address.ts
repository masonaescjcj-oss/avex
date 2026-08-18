import { createHmac } from 'node:crypto';

import {
  invoiceSalt,
  predictForwarder,
  toChecksumAddress,
  type Create2Config,
  type FeeSplit,
} from '@avex/core';

/**
 * Where a payer sends, derived from configuration alone.
 *
 * Deliberately not a `ChainAdapter`. Deriving a deposit address needs no RPC on any
 * chain we support — CREATE2 is a hash, and a memo chain's address is a constant —
 * so making invoice creation depend on a live node would add a failure mode that
 * buys nothing. An RPC outage should stop settlement, not stop merchants trading.
 *
 * The two address models differ in where the invoice's identity lives. On EVM chains
 * it is in the address itself, which is a hash over the merchant's payout address and
 * the fee; on TON it is in a memo beside one shared address. That difference is why
 * `memo` is present on one branch and absent on the other rather than being optional
 * everywhere and null half the time.
 */

export class DepositAddressError extends Error {
  constructor(
    readonly code: 'chain_unsupported' | 'not_configured',
    message: string,
  ) {
    super(message);
    this.name = 'DepositAddressError';
  }
}

export interface DepositTarget {
  readonly address: string;
  /** Present only on shared-address chains, where it identifies the invoice. */
  readonly memo?: string;
}

export interface EvmChainConfig {
  readonly factory: string;
  readonly forwarderCreationCode: string;
}

export interface DepositAddressConfig {
  /** CREATE2 factories, by chain. A chain absent here cannot issue EVM invoices. */
  readonly evm: Readonly<Record<string, EvmChainConfig>>;
  /** One wallet per shared-address chain, disambiguated by memo. */
  readonly shared: Readonly<Record<string, string>>;
}

/**
 * How a memo is formed.
 *
 * Short and opaque. It has to be typed by hand into a wallet field by some payers, so
 * length costs accuracy; and it must not carry the invoice's uuid, because a memo is
 * visible to anyone watching the shared address and a guessable one would let a
 * stranger claim someone else's payment by reusing it.
 */
export function memoFor(invoiceId: string, secret: string): string {
  // A short HMAC-shaped tag over the id. Truncated to 12 hex characters: 48 bits is
  // far beyond guessing for the number of invoices any merchant will ever open, and
  // still fits a wallet's memo field without wrapping.
  const digest = createHmac('sha256', secret).update(invoiceId).digest('hex');
  return 'AVEX-' + digest.slice(0, 12).toUpperCase();
}

export class DepositAddressDeriver {
  constructor(
    private readonly config: DepositAddressConfig,
    private readonly memoSecret: string,
  ) {}

  /** Chains this deployment can currently issue invoices on. */
  supportedChains(): readonly string[] {
    return [...Object.keys(this.config.evm), ...Object.keys(this.config.shared)].sort();
  }

  /**
   * Derive the address for one invoice.
   *
   * `fee` feeds the EVM derivation, so it must be the fee the invoice will be stored
   * with. Passing a different one later produces a different address, and the funds
   * a payer sent to this one would be unreachable.
   */
  derive(input: {
    readonly invoiceId: string;
    readonly chain: string;
    readonly payoutAddress: string;
    readonly fee?: FeeSplit | undefined;
  }): DepositTarget {
    const evm = this.config.evm[input.chain];
    if (evm) {
      const create2: Create2Config = {
        factory: evm.factory,
        forwarderCreationCode: evm.forwarderCreationCode,
      };
      return {
        address: predictForwarder(
          create2,
          input.invoiceId,
          toChecksumAddress(input.payoutAddress),
          input.fee && input.fee.feeBps > 0 ? input.fee : undefined,
        ),
      };
    }

    const shared = this.config.shared[input.chain];
    if (shared) {
      return { address: shared, memo: memoFor(input.invoiceId, this.memoSecret) };
    }

    /**
     * Two distinct failures, kept distinct.
     *
     * A chain we have no code for is a client error — the merchant asked for
     * something that does not exist. A chain we support but have not been given a
     * factory for is our own misconfiguration, and reporting it as "unsupported"
     * would send an operator looking for a missing feature instead of a missing
     * environment variable.
     */
    if (KNOWN_CHAINS.has(input.chain)) {
      throw new DepositAddressError(
        'not_configured',
        `${input.chain} is supported but this deployment has no deposit configuration ` +
          'for it. Set its forwarder factory or shared wallet.',
      );
    }
    throw new DepositAddressError('chain_unsupported', `Unknown chain: ${input.chain}.`);
  }

  /** The salt an invoice's forwarder is deployed at, for settlement to reproduce. */
  saltFor(invoiceId: string): Uint8Array {
    return invoiceSalt(invoiceId);
  }
}

const KNOWN_CHAINS = new Set(['ethereum', 'polygon', 'bsc', 'tron', 'solana', 'ton']);

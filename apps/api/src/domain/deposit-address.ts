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
  /**
   * Chains whose deposit address comes from the merchant's own wallet pool.
   *
   * Named here and nowhere else in this class, because this is the one address model that
   * cannot be derived. A pooled address is a row in `deposit_wallets` chosen against the
   * invoices currently open on it — a database read inside the transaction that writes the
   * invoice — so `derive` refuses them and `WalletPoolService.allocate` answers instead.
   *
   * They still belong in `supportedChains()`. That is what the checkout filters its currency
   * list by, and a chain missing from it is a chain a merchant cannot be offered at all — which
   * is how TRON came to be silently absent from every checkout after it became pooled.
   */
  readonly pooled?: readonly string[];
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
    return [
      ...Object.keys(this.config.evm),
      ...Object.keys(this.config.shared),
      ...(this.config.pooled ?? []),
    ].sort();
  }

  /** Whether this chain's address comes from a wallet pool rather than from configuration. */
  isPooled(chain: string): boolean {
    return (this.config.pooled ?? []).includes(chain);
  }

  /**
   * A deposit address for a test invoice.
   *
   * Deliberately not a real address, and deliberately not a valid one on any chain.
   * The alternative — a testnet address — would need a testnet node, a faucet and a
   * second set of contracts, and would still leave a merchant able to confuse the two.
   * An address that no wallet will accept cannot take a payment by mistake, which is
   * the property that matters: a payer who somehow reached a test checkout must not be
   * able to send real money into it.
   *
   * Derived from the invoice id so it is stable across reads, and prefixed so it is
   * obvious in a log, a dashboard or a support ticket which kind of object it belongs
   * to.
   */
  private testTarget(invoiceId: string, chain: string): DepositTarget {
    const digest = createHmac('sha256', this.memoSecret)
      .update(`test:${chain}:${invoiceId}`)
      .digest('hex');
    return {
      address: `AVEXTEST-${chain.toUpperCase()}-${digest.slice(0, 24).toUpperCase()}`,
      ...(this.config.shared[chain] ? { memo: memoFor(invoiceId, this.memoSecret) } : {}),
    };
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
    readonly mode?: 'test' | 'live' | undefined;
  }): DepositTarget {
    /**
     * Test first, before any of the chain checks below.
     *
     * A test invoice must be creatable on a chain this deployment has no factory for —
     * a merchant integrating should not be blocked by our deployment configuration,
     * and there is no address to get wrong.
     */
    if (input.mode === 'test') {
      if (!KNOWN_CHAINS.has(input.chain)) {
        throw new DepositAddressError('chain_unsupported', `Unknown chain: ${input.chain}.`);
      }
      return this.testTarget(input.invoiceId, input.chain);
    }

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
     * A pooled chain has no derivable address, and saying so is the whole point.
     *
     * Falling through to the errors below would report "this deployment has no deposit
     * configuration for tron", sending an operator to look for a missing environment variable
     * that does not exist. The caller is supposed to have allocated from the pool before
     * reaching here; if it did not, this is our bug and it should read like one.
     */
    if (this.isPooled(input.chain)) {
      throw new DepositAddressError(
        'not_configured',
        `${input.chain} is a pooled chain: its deposit address comes from the merchant's ` +
          'wallet pool and must be allocated before the invoice is written, not derived here.',
      );
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

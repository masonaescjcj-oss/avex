import { chainConfig, DEFAULT_FEE_POLICY, FeePolicy } from '@avex/core';
import type { ChainId } from '@avex/core';

import type { GasOracle } from './gas-oracle.js';

/**
 * The smallest order worth taking on a chain, right now.
 *
 * The rule this enforces is one number: an invoice must be large enough that the cost of
 * settling it is a small fraction of it. `FeePolicy.minInvoiceUsd` has computed that from live
 * gas since the beginning — and until this module existed, nothing called it. The thresholds
 * were a table nobody read.
 *
 * ## Why there is a minimum at all, now that the payer pays the gas
 *
 * Because the charge is fixed before the cost is paid. The network fee is decided when the
 * invoice is created — it has to be, the deposit address commits to it — and the settlement
 * happens later, at whatever gas the chain is charging then. So what we recover is an estimate
 * and what we pay is a fact, and the gap between them is ours.
 *
 * On a large order that gap is nothing: the commission dwarfs it. On a small one the commission
 * is smaller than the gas bill, so a chain that got busier between the two moments turns the
 * order into a loss no fee could have covered. `targetFeeRatio` is where that margin is set,
 * and the derivation is written out there.
 *
 * ## Failure is always "allow"
 *
 * A gas probe is a third-party network call on the path that takes money. If it could refuse an
 * invoice, an unreachable RPC endpoint would stop every merchant selling — to protect a few
 * cents. So no snapshot means no minimum: we take the order and carry the risk, which is the
 * only direction that costs nobody but us.
 */
export class ChainMinimums {
  constructor(
    private readonly gas: GasOracle,
    private readonly policy: FeePolicy = new FeePolicy(DEFAULT_FEE_POLICY),
  ) {}

  /**
   * The floor for this chain in micro-dollars, or `null` when there is no answer to give.
   *
   * Null for the chains that settle directly — TON's shared wallet and TRON's pool of the
   * merchant's own addresses receive the payer's transfer and nothing of ours moves afterwards,
   * so there is no settlement whose cost could exceed anything. It is also null when the probe
   * failed, and the caller cannot tell the two apart on purpose: both mean "do not refuse".
   */
  async minInvoiceUsdMicros(chain: string): Promise<bigint | null> {
    if (!isSupported(chain)) return null;
    if (chainConfig(chain).settlement.kind === 'direct') return null;

    const snapshot = await this.gas.snapshot(chain);
    if (snapshot === null) return null;

    /**
     * Rounded up to the cent, and stated in cents rather than micro-dollars.
     *
     * The figure goes into a message a merchant reads — "the minimum on BNB Smart Chain is
     * $12.00" — and a minimum of $11.997341 would be one nobody could act on. Up rather than
     * down so the stated figure is always one that passes the check it is quoted from.
     */
    const cents = Math.ceil(this.policy.minInvoiceUsd(snapshot) * 100);
    return BigInt(cents) * 10_000n;
  }

  /**
   * Whether an order of this size can carry its own settlement on this chain.
   *
   * `null` for value means a token-priced invoice, which has no dollar figure at creation. It
   * passes: a minimum is a dollar comparison, and a conversion invented here would refuse a
   * merchant's order against a number they were never shown.
   */
  async verdict(
    chain: string,
    valueUsdMicros: bigint | null | undefined,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly minUsdMicros: bigint }> {
    if (valueUsdMicros === null || valueUsdMicros === undefined || valueUsdMicros <= 0n) {
      return { ok: true };
    }

    const minimum = await this.minInvoiceUsdMicros(chain);
    if (minimum === null || valueUsdMicros >= minimum) return { ok: true };
    return { ok: false, minUsdMicros: minimum };
  }
}

function isSupported(chain: string): chain is ChainId {
  try {
    chainConfig(chain as ChainId);
    return true;
  } catch {
    /**
     * Telegram Stars reach here as `telegram`, which is not a chain and has no settlement.
     * Answering "no minimum" rather than throwing keeps the rail out of a check that is about
     * gas — there is none to pay, and the merchant's bot holds the balance either way.
     */
    return false;
  }
}

/** Dollars from micro-dollars, for a message a person reads. Two places needed it. */
export function formatUsdMicros(micros: bigint): string {
  const cents = micros / 10_000n;
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

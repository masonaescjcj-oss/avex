import { tokenAmountToFiat } from '@avex/core';
import type { IncomingPayment, PriceSymbol, Rate } from '@avex/core';

import type { PaymentValueSource } from './payment-sink.js';

/**
 * What a credited payment was worth, in dollars.
 *
 * Both production entry points passed `() => 0` here — a placeholder that was never replaced —
 * and it was not harmless. Three things read this figure, and all three were wrong:
 *
 *   - **Confirmations.** `requiredConfirmations(chain, valueUsd)` scales the wait by value: a
 *     $50,000 payment on Ethereum is meant to wait 32 blocks and a small one 12. At zero, every
 *     payment took the shallow count, so the deepest reorg protection in the system was
 *     unreachable for exactly the payments it exists for.
 *   - **The volume ladder.** 0.5% falls to 0.45% at $50,000 of assessed volume, measured from
 *     `payments.value_usd_micros`. Every row was zero, so no merchant could ever reach a
 *     threshold and the ladder was decorative.
 *   - **Revenue, and now the commission ledger.** `commissionEarned` sums a percentage of these
 *     values, so it reported nothing. And the commission a pooled chain accrues is a percentage
 *     of this figure too — at zero, the fee the merchant agreed to would never be charged, and
 *     the failure would look exactly like nobody having bought anything.
 *
 * So this is the real one, and it is a separate module because the watcher and the API both need
 * it and neither should own it.
 */

/** The narrow slice of the price service this needs. */
export interface RateSource {
  requireRate(symbol: PriceSymbol): Promise<Rate>;
}

/**
 * Dollars for one payment.
 *
 * Throws rather than returning zero when there is no trustworthy price, because the sink already
 * has the right behaviour for that: it records the value as unknown and credits the payment
 * anyway. The merchant's money has arrived; what it was worth is our bookkeeping problem, and a
 * zero written as though it were a real figure would flow into a merchant's volume and into what
 * they are billed.
 */
export function paymentValueUsd(rates: RateSource) {
  return async (payment: IncomingPayment): Promise<number> => {
    /**
     * Priced by symbol, which is what the price service knows.
     *
     * The asset on an `IncomingPayment` came from the accepted-asset catalogue, so its symbol is
     * one we curate rather than one a contract claimed for itself — an important distinction on
     * a chain where deploying a token called USDT costs a few cents.
     */
    const rate = await rates.requireRate(payment.asset.symbol as PriceSymbol);
    const micros = tokenAmountToFiat(payment.amount, rate, payment.asset.decimals);
    return Number(micros) / 1_000_000;
  };
}

/**
 * Where the number came from.
 *
 * `oracle` rather than `quote`: this is the live aggregate price at the moment of crediting, not
 * the rate the invoice was quoted at. The distinction is recorded on every payment row because
 * "what was this worth" and "what did we promise it was worth" are different questions, and a
 * merchant disputing their assessed volume is asking the first one.
 */
export function paymentValueSource(): (payment: IncomingPayment) => PaymentValueSource {
  return () => 'oracle';
}

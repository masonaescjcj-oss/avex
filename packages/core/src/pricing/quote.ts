import type { Asset } from '../types.js';
import {
  applySpread,
  fiatToTokenAmount,
  tokenAmountToFiat,
  type Rate,
} from './rate.js';

/**
 * Quotes: turning "twenty dollars" into "this many token units, at this rate,
 * until this moment".
 *
 * The rate is fixed when the quote is created and honoured until it expires, even
 * if the market moves. That is the merchant's exposure, and it is why a spread is
 * configurable rather than assumed.
 */

export type PricingMode =
  /** Priced in fiat and converted at quote time. The merchant carries FX risk. */
  | 'fiat'
  /** Priced directly in token units. No conversion, so no FX risk at all. */
  | 'token'
  /**
   * Priced in fiat at a rate the merchant sets, for assets no market prices —
   * typically a token the merchant issued themselves.
   */
  | 'fixed_rate';

export interface QuoteInput {
  readonly id: string;
  readonly asset: Asset;
  readonly mode: PricingMode;
  /** Required for `fiat` and `fixed_rate`. */
  readonly amountFiatMicros?: bigint;
  /** Required for `token`. */
  readonly amountToken?: bigint;
  /**
   * The market rate for `fiat`, or the merchant's own rate for `fixed_rate`.
   * Optional in `token` mode, where it only informs the recorded fiat value.
   */
  readonly rate?: Rate;
  readonly spreadBps: number;
  readonly ttlMs: number;
  /**
   * How much the round-up may add to the invoice, in basis points, before the
   * asset is judged too coarse-grained to price this amount.
   */
  readonly maxRoundingOverheadBps?: number;
}

export interface Quote {
  readonly id: string;
  readonly asset: Asset;
  readonly mode: PricingMode;
  /** What the payer must send, in the asset's smallest unit. */
  readonly amountDue: bigint;
  /** The rate observed, before the spread. Null when nothing was converted. */
  readonly marketRate: Rate | null;
  /** The rate actually applied. Null when nothing was converted. */
  readonly effectiveRate: Rate | null;
  readonly spreadBps: number;
  /** Fiat value of `amountDue`. Null when no rate was available in `token` mode. */
  readonly amountFiatMicros: bigint | null;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export class QuoteInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuoteInputError';
  }
}

/**
 * Build a quote. Pure — the caller resolves the rate, so every branch here is
 * directly testable and no quote is ever created as a side effect of a network
 * call that half-succeeded.
 */
export function createQuote(input: QuoteInput, now: number = Date.now()): Quote {
  if (input.ttlMs <= 0) throw new QuoteInputError('ttlMs must be positive');

  const base = {
    id: input.id,
    asset: input.asset,
    mode: input.mode,
    spreadBps: input.spreadBps,
    createdAt: now,
    expiresAt: now + input.ttlMs,
  } as const;

  switch (input.mode) {
    case 'fiat':
    case 'fixed_rate': {
      const amountFiatMicros = input.amountFiatMicros;
      if (amountFiatMicros === undefined || amountFiatMicros <= 0n) {
        throw new QuoteInputError(`${input.mode} mode requires a positive amountFiatMicros`);
      }
      if (!input.rate) {
        throw new QuoteInputError(
          input.mode === 'fiat'
            ? 'fiat mode requires a market rate'
            : 'fixed_rate mode requires the merchant-configured rate',
        );
      }

      // A merchant-set rate is already the price they chose to sell at, so a
      // spread on top would silently overcharge beyond what they configured.
      const effectiveRate =
        input.mode === 'fiat' ? applySpread(input.rate, input.spreadBps) : input.rate;

      const amountDue = fiatToTokenAmount(
        amountFiatMicros,
        effectiveRate,
        input.asset.decimals,
      );

      /**
       * Guard against a coarse-grained asset turning rounding-up into a real
       * overcharge.
       *
       * Conversion rounds up so the merchant is never short, which is harmless
       * when a smallest unit is worth a fraction of a cent. But for an asset whose
       * smallest unit is worth more than the invoice — a high-priced token with few
       * decimals — rounding up to one unit can ask for many times the amount owed.
       * Rejecting is the only honest outcome: the asset simply cannot express this
       * price.
       */
      const overhead =
        tokenAmountToFiat(amountDue, effectiveRate, input.asset.decimals) - amountFiatMicros;
      const allowed =
        (amountFiatMicros * BigInt(input.maxRoundingOverheadBps ?? DEFAULT_MAX_ROUNDING_BPS)) /
        10_000n;

      if (overhead > allowed) {
        throw new QuoteInputError(
          `${input.asset.symbol} granularity is too coarse for this amount: rounding up ` +
            `adds ${overhead} micro-USD to a ${amountFiatMicros} micro-USD invoice`,
        );
      }

      return {
        ...base,
        amountDue,
        marketRate: input.rate,
        effectiveRate,
        amountFiatMicros,
      };
    }

    case 'token': {
      const amountToken = input.amountToken;
      if (amountToken === undefined || amountToken <= 0n) {
        throw new QuoteInputError('token mode requires a positive amountToken');
      }

      // No conversion happened, so no spread applies and there is nothing to lock.
      // A rate, if supplied, is recorded only so downstream confirmation tiering
      // and minimum-invoice checks have a value to work with.
      return {
        ...base,
        amountDue: amountToken,
        marketRate: input.rate ?? null,
        effectiveRate: null,
        spreadBps: 0,
        amountFiatMicros: input.rate
          ? tokenAmountToFiat(amountToken, input.rate, input.asset.decimals)
          : null,
      };
    }
  }
}

export function isQuoteExpired(quote: Quote, now: number = Date.now()): boolean {
  return now >= quote.expiresAt;
}

export function quoteRemainingMs(quote: Quote, now: number = Date.now()): number {
  return Math.max(0, quote.expiresAt - now);
}

/**
 * Whether a quote may still be used to create an invoice.
 *
 * Separate from `isQuoteExpired` because the distinction matters: an invoice
 * already created against a quote keeps its locked amount for the invoice's own
 * lifetime. Expiry stops new invoices, it does not invalidate existing ones.
 */
export function canOpenInvoice(quote: Quote, now: number = Date.now()): boolean {
  return !isQuoteExpired(quote, now);
}

/** Default lock window. Long enough to pay, short enough to bound FX exposure. */
export const DEFAULT_QUOTE_TTL_MS = 15 * 60_000;

/** Default protective spread on converted quotes. */
export const DEFAULT_SPREAD_BPS = 50;

/** Default ceiling on what rounding up may add to a converted invoice. */
export const DEFAULT_MAX_ROUNDING_BPS = 100;

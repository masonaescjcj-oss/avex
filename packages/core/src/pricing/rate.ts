/**
 * Exchange-rate arithmetic.
 *
 * Every conversion between a fiat amount and a token amount happens here, in
 * integer arithmetic. Floating point is banned from this file: `0.1 + 0.2` is not
 * `0.3`, and a gateway that prices invoices with doubles accumulates a slow,
 * silent discrepancy that only surfaces when the books are reconciled.
 *
 * Two fixed-point scales are used:
 *
 * - Fiat amounts are **micro-dollars** (1e-6 USD). Cents are too coarse for
 *   per-unit token prices, and micros leave room for sub-cent invoice totals.
 * - Rates are USD per whole token, scaled by `RATE_SCALE` (1e18). That covers
 *   both a token worth $100,000 and one worth $0.000001 without losing digits.
 */

/** Scale applied to a rate: `priceScaled = usdPerWholeToken * RATE_SCALE`. */
export const RATE_SCALE = 10n ** 18n;

/** Scale applied to fiat amounts: `amountMicros = usd * FIAT_SCALE`. */
export const FIAT_SCALE = 10n ** 6n;

export interface Rate {
  /** USD per one whole token, multiplied by `RATE_SCALE`. */
  readonly priceScaled: bigint;
  /** When the underlying observation was taken, for staleness checks. */
  readonly observedAt: number;
}

export class InvalidRateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRateError';
  }
}

/**
 * Build a rate from a decimal string such as `"0.9998"` or `"64213.75"`.
 *
 * A string, not a number: parsing `"64213.75"` into a double and multiplying is
 * exactly the rounding error this module exists to avoid. Source APIs return
 * these as strings already, so nothing is lost by keeping them that way.
 */
export function rateFromDecimalString(value: string, observedAt: number): Rate {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new InvalidRateError(`not a positive decimal: ${value}`);
  }

  const [whole, fraction = ''] = trimmed.split('.');
  // Pad or truncate the fraction to exactly the scale's digit count.
  const scaleDigits = RATE_SCALE.toString().length - 1;
  const normalizedFraction = fraction.padEnd(scaleDigits, '0').slice(0, scaleDigits);

  const priceScaled = BigInt(whole!) * RATE_SCALE + BigInt(normalizedFraction || '0');
  if (priceScaled <= 0n) throw new InvalidRateError(`rate must be positive: ${value}`);

  return { priceScaled, observedAt };
}

/** Render a rate back to a decimal string, for display and for storage. */
export function rateToDecimalString(rate: Rate, decimalPlaces = 8): string {
  const whole = rate.priceScaled / RATE_SCALE;
  const fraction = rate.priceScaled % RATE_SCALE;
  const scaleDigits = RATE_SCALE.toString().length - 1;
  const padded = fraction.toString().padStart(scaleDigits, '0').slice(0, decimalPlaces);
  return decimalPlaces > 0 ? `${whole}.${padded}` : whole.toString();
}

/** Fiat amount from a decimal string, in micro-dollars. */
export function fiatMicrosFromDecimalString(value: string): bigint {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new InvalidRateError(`not a positive decimal: ${value}`);
  }
  const [whole, fraction = ''] = trimmed.split('.');
  const scaleDigits = FIAT_SCALE.toString().length - 1;
  const normalized = fraction.padEnd(scaleDigits, '0').slice(0, scaleDigits);
  return BigInt(whole!) * FIAT_SCALE + BigInt(normalized || '0');
}

export function fiatMicrosToDecimalString(micros: bigint): string {
  const whole = micros / FIAT_SCALE;
  const fraction = micros % FIAT_SCALE;
  return `${whole}.${fraction.toString().padStart(6, '0')}`;
}

/** Divide, rounding away from zero, so a remainder never rounds down to nothing. */
function divideCeil(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new InvalidRateError('denominator must be positive');
  return (numerator + denominator - 1n) / denominator;
}

/**
 * Token amount, in smallest units, owed for a fiat amount at a given rate.
 *
 * Rounds **up**. The alternative is asking a payer for marginally less than the
 * invoice is worth, which combined with the tolerance band lets a systematic
 * shortfall through. One extra smallest unit is beneath notice on every asset we
 * support; a merchant reliably receiving slightly less than they invoiced is not.
 */
export function fiatToTokenAmount(
  amountMicros: bigint,
  rate: Rate,
  tokenDecimals: number,
): bigint {
  if (amountMicros < 0n) throw new InvalidRateError('amount must not be negative');
  if (amountMicros === 0n) return 0n;
  if (rate.priceScaled <= 0n) throw new InvalidRateError('rate must be positive');

  const tokenScale = 10n ** BigInt(tokenDecimals);
  return divideCeil(amountMicros * RATE_SCALE * tokenScale, rate.priceScaled * FIAT_SCALE);
}

/**
 * Fiat value, in micro-dollars, of a token amount at a given rate.
 *
 * Rounds **down**, the mirror of the rule above: this figure drives confirmation
 * tiering and minimum-invoice checks, where understating value is the safe
 * direction — it can only ask for more confirmations, never fewer.
 */
export function tokenAmountToFiat(
  tokenAmount: bigint,
  rate: Rate,
  tokenDecimals: number,
): bigint {
  if (tokenAmount < 0n) throw new InvalidRateError('amount must not be negative');
  const tokenScale = 10n ** BigInt(tokenDecimals);
  return (tokenAmount * rate.priceScaled * FIAT_SCALE) / (RATE_SCALE * tokenScale);
}

/** Convenience for callers that need a plain number, e.g. fee heuristics. */
export function rateToNumber(rate: Rate): number {
  const whole = rate.priceScaled / RATE_SCALE;
  const fraction = rate.priceScaled % RATE_SCALE;
  return Number(whole) + Number(fraction) / Number(RATE_SCALE);
}

/**
 * Apply a protective spread, lowering the effective price so the payer sends
 * more tokens than the spot rate alone would require.
 *
 * The merchant carries the exchange-rate risk for the life of a locked quote. A
 * spread is how they buy insurance against the token falling inside that window;
 * without one, a volatile market erodes their revenue a fraction at a time.
 */
export function applySpread(rate: Rate, spreadBps: number): Rate {
  if (!Number.isInteger(spreadBps) || spreadBps < 0 || spreadBps >= 10_000) {
    throw new InvalidRateError(`spread must be an integer in [0, 10000): ${spreadBps}`);
  }
  return {
    priceScaled: (rate.priceScaled * BigInt(10_000 - spreadBps)) / 10_000n,
    observedAt: rate.observedAt,
  };
}

/** Deviation between two rates in basis points, relative to `reference`. */
export function deviationBps(rate: bigint, reference: bigint): number {
  if (reference <= 0n) throw new InvalidRateError('reference must be positive');
  const difference = rate > reference ? rate - reference : reference - rate;
  return Number((difference * 10_000n) / reference);
}

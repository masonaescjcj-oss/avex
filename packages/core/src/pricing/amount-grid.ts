/**
 * How many decimals a payer is ever asked to type.
 *
 * A checkout that says "send 25.253529057985269131 USDC" is asking for a number nobody can
 * type, check, or read back over the phone, and on a shared address a mistyped amount is a
 * payment that cannot be attributed. So every amount a payer is asked for — quoted on the
 * checkout, written on the invoice — is rounded *up* to a small number of decimal places,
 * whatever the token's own precision. Up, never down: rounding an amount owed downwards would
 * leave every invoice a fraction short, and the merchant is the one who would be short.
 *
 * ## How many decimals
 *
 * Three on a stablecoin and on anything cheap. Three rather than two because the disambiguator
 * on a pooled wallet needs a digit of its own beneath the cents: a $20 order becomes 20.001,
 * 20.002, … rather than 20.01, 20.02, and the payer is asked for a tenth of a cent more than
 * the price instead of a whole one.
 *
 * More on a dear token, up to five. A thousandth of BNB at $600 is sixty cents and a
 * thousandth of ETH is three dollars — not a rounding but a surcharge — so the grid is chosen
 * from the token's dollar price: the fewest decimals, from three to five, at which one step is
 * worth no more than `MAX_STEP_USD`. BNB and ETH land on five, where a step is under a dime.
 * Without a price — a token-priced invoice — three is used, which is right for the
 * stablecoins that are nearly all such invoices.
 *
 * Tokens so dear that even the fifth decimal is a real surcharge are refused on pooled
 * wallets by `wallet-pool-allocator`, which is where that limit is written. At five decimals
 * that takes a token worth more than half a million dollars.
 */

/** The grid on a stablecoin, and the fewest decimals ever used. */
export const MIN_AMOUNT_DECIMALS = 3;
/** The most decimals a payer is ever asked to type, however dear the token. */
export const MAX_AMOUNT_DECIMALS = 5;
/** The most one step of the grid should be worth; decides how many decimals a dear token gets. */
export const MAX_STEP_USD = 0.05;

/**
 * How many decimals amounts in this token are issued with, from its price.
 *
 * Never more than the token itself has: a two-decimal token is asked for in its own units.
 */
export function gridDecimals(decimals: number, unitPriceUsd?: number | null | undefined): number {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`decimals must be a non-negative integer, got ${decimals}`);
  }
  let places = MIN_AMOUNT_DECIMALS;
  if (unitPriceUsd !== undefined && unitPriceUsd !== null && Number.isFinite(unitPriceUsd) && unitPriceUsd > 0) {
    while (places < MAX_AMOUNT_DECIMALS && unitPriceUsd / 10 ** places > MAX_STEP_USD) places += 1;
  }
  return Math.min(decimals, places);
}

/**
 * One step of the grid, in the token's smallest units.
 *
 * On a six-decimal stablecoin that is 1,000 units; on eighteen-decimal ETH 10^13. A token with
 * no more decimals than the grid is already on it, so its step is one unit.
 */
export function amountGrid(decimals: number, unitPriceUsd?: number | null | undefined): bigint {
  return 10n ** BigInt(decimals - gridDecimals(decimals, unitPriceUsd));
}

/** The smallest multiple of the grid that is not below `amount`. Zero stays zero. */
export function ceilToGrid(
  amount: bigint,
  decimals: number,
  unitPriceUsd?: number | null | undefined,
): bigint {
  if (amount < 0n) throw new Error('an amount owed cannot be negative');
  const grid = amountGrid(decimals, unitPriceUsd);
  const remainder = amount % grid;
  return remainder === 0n ? amount : amount + (grid - remainder);
}

/** Whether an amount already sits on the grid for its token. */
export function isOnGrid(amount: bigint, decimals: number, unitPriceUsd?: number | null | undefined): boolean {
  return amount % amountGrid(decimals, unitPriceUsd) === 0n;
}

/**
 * Two token amounts, compared as the numbers a person reads.
 *
 * 20.001 USDT on TRON (six decimals) and 20.001 USDC on BNB Chain (eighteen) are different
 * integers and the same number. The pooled wallet identifies an invoice by the number the payer
 * typed, so that is what has to be compared — and a payer who sent the right number in the
 * wrong stablecoin must still be found. Both sides are brought to a common scale wide enough
 * for any token in the catalogue.
 */
const COMPARISON_DECIMALS = 36;

export function humanAmount(amount: bigint, decimals: number): bigint {
  if (decimals > COMPARISON_DECIMALS) {
    throw new Error(`a token with ${decimals} decimals is beyond what amounts are compared at`);
  }
  return amount * 10n ** BigInt(COMPARISON_DECIMALS - decimals);
}

export function sameHumanAmount(
  left: { readonly amount: bigint; readonly decimals: number },
  right: { readonly amount: bigint; readonly decimals: number },
): boolean {
  return humanAmount(left.amount, left.decimals) === humanAmount(right.amount, right.decimals);
}

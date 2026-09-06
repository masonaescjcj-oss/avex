/**
 * How many decimals a payer is ever asked to type.
 *
 * A checkout that says "send 25.253529057985269131 USDC" is asking for a number nobody can
 * type, check, or read back over the phone, and on a shared address a mistyped amount is a
 * payment that cannot be attributed. So every amount a payer is asked for — quoted on the
 * checkout, written on the invoice — is rounded *up* to three decimal places, whatever the
 * token's own precision. Up, never down: rounding an amount owed downwards would leave every
 * invoice a fraction short, and the merchant is the one who would be short.
 *
 * Three rather than two because the disambiguator on a pooled wallet needs a digit of its own
 * beneath the cents: a $20 order becomes 20.001, 20.002, … rather than 20.01, 20.02, and the
 * payer is asked for a tenth of a cent more than the price instead of a whole one.
 *
 * The cost of the rule, stated plainly because it is the merchant's to weigh: on a token worth
 * hundreds of dollars a thousandth is not a rounding. A thousandth of BNB at $600 is sixty
 * cents; of ETH at $3,000 it is three dollars. The rounding goes to the merchant — it lands in
 * their wallet — so nobody is short, but a payer on such a token is asked for up to one
 * thousandth more than the price. Tokens dear enough for that to be a real surcharge are
 * refused on pooled wallets by `wallet-pool-allocator`, which is where that limit is written.
 */

export const MAX_AMOUNT_DECIMALS = 3;

/**
 * One step of the three-decimal grid, in the token's smallest units.
 *
 * On a six-decimal token that is 1,000 units; on an eighteen-decimal one 10^15. A token with
 * three or fewer decimals is already on the grid, so its step is one unit.
 */
export function amountGrid(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`decimals must be a non-negative integer, got ${decimals}`);
  }
  return 10n ** BigInt(Math.max(0, decimals - MAX_AMOUNT_DECIMALS));
}

/** The smallest multiple of the grid that is not below `amount`. Zero stays zero. */
export function ceilToGrid(amount: bigint, decimals: number): bigint {
  if (amount < 0n) throw new Error('an amount owed cannot be negative');
  const grid = amountGrid(decimals);
  const remainder = amount % grid;
  return remainder === 0n ? amount : amount + (grid - remainder);
}

/** Whether an amount already sits on the grid, i.e. has at most three decimals. */
export function isOnGrid(amount: bigint, decimals: number): boolean {
  return amount % amountGrid(decimals) === 0n;
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

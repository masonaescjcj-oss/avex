import { amountGrid, ceilToGrid, gridDecimals } from '@avex/core';

/**
 * Which wallet an invoice gets, and what exact amount identifies it.
 *
 * Pure, and separate from the service that reads the database, because these are the two
 * decisions that decide whether a payment can be attributed to the right invoice — and both
 * have edge cases that are cheap to test here and expensive to test through a transaction.
 *
 * The model: a merchant registers up to a hundred of their own addresses per chain. An invoice
 * is given one of them plus an amount that is unique among the invoices recently issued on
 * that address. The payer's transfer goes straight to the merchant, so there is no sweep and
 * no settlement cost — the amount is doing the job a memo does on TON and a per-invoice
 * address does on EVM.
 */

/** One wallet in the pool, with what is already pointing at it. */
export interface WalletLoad {
  readonly id: string;
  readonly address: string;
  /**
   * Amounts, in smallest units, that this wallet must not hand out again: every invoice open
   * on it, and every invoice that closed recently enough that a late payment for it could
   * still arrive. See `RESERVATION_MS` in the pool service.
   */
  readonly openAmounts: readonly bigint[];
  /**
   * Invoices actually open here — pending or confirming and not yet past their expiry.
   *
   * This is the count that decides how busy a wallet is; the reserved amounts above include
   * finished invoices whose numbers are merely still spoken for. Defaults to the length of
   * `openAmounts` for a caller that does not distinguish.
   */
  readonly openCount?: number | undefined;
  /**
   * When an invoice was last issued on this wallet, as epoch milliseconds; null if never.
   *
   * Breaks ties between equally idle wallets in favour of the one that has been quiet longest,
   * so the gap between an old invoice and a new one on the same address is as wide as the
   * pool allows. A payer paying an old invoice late is then least likely to land on a wallet
   * that has just been given a fresh one.
   */
  readonly lastInvoiceAt?: number | null | undefined;
}

export class WalletPoolError extends Error {
  constructor(
    readonly code: 'pool_empty' | 'pool_exhausted' | 'decimals_too_few' | 'tick_too_dear',
    message: string,
  ) {
    super(message);
    this.name = 'WalletPoolError';
  }
}

/**
 * How the amount is nudged, for one token.
 *
 * ## The shape a payer can type
 *
 * Every amount a payer is asked for has three decimals, or up to five on a token dear enough
 * that a thousandth is real money — that rule lives in `@avex/core`'s `amount-grid`, and it
 * applies to every currency on every chain. The nudge that tells one invoice from another on a
 * shared wallet therefore lives in the last of those decimals: a $20 order in USDT is issued as
 * 20.001, the next one at that price on the same wallet as 20.002, and so on; in BNB the step
 * is 0.00001. The payer is asked for under a dime more than the price on any token. There are
 * 999 such steps before a wallet runs out of amounts for one price, which at a hundred wallets
 * per chain is not a limit anybody reaches.
 *
 * ## Why the smallest free step, not a random one
 *
 * An earlier version chose at random within a tier so the count of open invoices could not be
 * read off the amounts. The cost was a surcharge of up to nine steps where one would do, and
 * on a token worth hundreds of dollars a step is not a rounding. The allocation runs under a
 * lock per merchant and chain, so there is no race for randomness to paper over; and the
 * address is the merchant's own public wallet, so its activity was never a secret.
 *
 * ## Tokens too dear for the rule
 *
 * The grid stops at five decimals, and a hundred-thousandth of a token worth half a million
 * dollars is five dollars — which a payer cannot be asked to round up by. `MAX_TICK_USD` is
 * where that line is drawn, and a token above it is refused on pooled wallets rather than
 * issued with a surcharge nobody agreed to. No listed token is near it; the check exists so
 * that one never quietly becomes so.
 */
export interface DisambiguatorPlan {
  /** One step, in smallest units: the last decimal place issued. Every offset is a multiple. */
  readonly unit: bigint;
  /** Offsets available, as multiples of `unit`: 1 to this. */
  readonly ticks: number;
  /** The largest amount that can be added, in smallest units. */
  readonly max: bigint;
  /** Decimal places the amount is issued with: three, up to five on a dear token. */
  readonly decimals: number;
}

/** Steps available for one price on one wallet: 1 to 999 of the last decimal issued. */
export const DISAMBIGUATOR_TICKS = 999;

/**
 * The fewest decimals a token may have to be used on a pooled address.
 *
 * With two decimals the step is a hundredth of a token — a cent on a stablecoin, which is a
 * nudge. With one it is a tenth and with none a whole token, and neither is. Refused rather
 * than scaled, so a merchant is told instead of quietly overcharged.
 */
export const MIN_DECIMALS_FOR_POOL = 2;

/** The most one step may be worth for a token to be issued on a pooled wallet. */
export const MAX_TICK_USD = 5;

export function disambiguatorPlan(input: {
  readonly decimals: number;
  /** Dollar price of one whole token, or nothing for an invoice priced in tokens. */
  readonly unitPriceUsd?: number | null | undefined;
}): DisambiguatorPlan {
  if (input.decimals < MIN_DECIMALS_FOR_POOL) {
    throw new WalletPoolError(
      'decimals_too_few',
      `an asset with ${input.decimals} decimals cannot be used on a pooled address: the ` +
        `disambiguator would be a surcharge, not a rounding`,
    );
  }

  const price = input.unitPriceUsd;
  const decimals = gridDecimals(input.decimals, price);
  if (price !== undefined && price !== null && Number.isFinite(price) && price > 0) {
    const stepUsd = price / 10 ** decimals;
    if (stepUsd > MAX_TICK_USD) {
      throw new WalletPoolError(
        'tick_too_dear',
        `one step of the amount on this token is worth $${stepUsd.toFixed(2)}, more than the ` +
          `$${MAX_TICK_USD} a payer can be asked to round up by; it cannot be paid into a ` +
          'shared wallet',
      );
    }
  }

  const unit = amountGrid(input.decimals, price);
  return {
    unit,
    ticks: DISAMBIGUATOR_TICKS,
    max: unit * BigInt(DISAMBIGUATOR_TICKS),
    decimals,
  };
}

/**
 * Pick the wallet for a new invoice.
 *
 * The rule the merchant asked for, and the reason for it: prefer a wallet with no open invoice
 * at all. Where a wallet has exactly one open invoice, a payment to it can be attributed even
 * when the amount is wrong — an exchange that rounded the withdrawal, a payer who typed the
 * round number — because there is only one invoice it could belong to. The moment two invoices
 * share a wallet, a wrong amount is ambiguous and needs a human. So idle wallets are spent
 * first, and only when every wallet is busy do invoices start sharing one.
 *
 * Among equally loaded wallets, the one that has been quiet longest. A wallet whose last
 * invoice closed a minute ago may still receive that invoice's late payment; one that has
 * been idle for hours almost certainly will not. Spreading invoices across the pool in that
 * order keeps late money and fresh invoices apart, which is what lets a wrong amount on a
 * quiet wallet be credited without a human.
 *
 * Among busy wallets, the least busy. That keeps the ambiguous case as rare and as small as it
 * can be: three invoices on one wallet while another holds one is strictly worse than two and
 * two, because ambiguity grows with the number of candidates on a single address.
 */
export function chooseWallet(pool: readonly WalletLoad[]): WalletLoad {
  if (pool.length === 0) {
    throw new WalletPoolError(
      'pool_empty',
      'no deposit wallet is registered for this chain; the merchant must add at least one',
    );
  }

  const load = (wallet: WalletLoad): number => wallet.openCount ?? wallet.openAmounts.length;
  // Never used sorts before any time: epoch milliseconds are positive, so -1 is "before all".
  const lastUsed = (wallet: WalletLoad): number => wallet.lastInvoiceAt ?? -1;

  /**
   * Final ties broken by address, not left to the array's order.
   *
   * The database returns rows in whatever order it likes, so without this the choice among
   * equally loaded, equally quiet wallets is unpredictable — which is not wrong, but it makes
   * a test that asserts anything about the choice flaky, and a support conversation about
   * "which wallet did this invoice get" unanswerable.
   */
  return [...pool].sort((left, right) => {
    const byLoad = load(left) - load(right);
    if (byLoad !== 0) return byLoad;
    const byAge = lastUsed(left) - lastUsed(right);
    if (byAge !== 0) return byAge;
    return left.address.localeCompare(right.address);
  })[0]!;
}

/**
 * The exact amount this invoice will ask for.
 *
 * `base` is what the merchant charged, in smallest units and at the token's full precision.
 * It is first rounded up to the token's grid, then a step is added. The return value is always
 * strictly greater than `base`, always has at most the grid's decimals, and never equals an
 * amount another invoice on the same wallet is still waiting for or was recently paid with.
 *
 * Two properties are deliberate and worth stating, because both are load-bearing:
 *
 *   - **Always added, never subtracted.** A merchant who invoiced $20 must never be paid
 *     $19.99 because of a mechanism of ours. The payer pays a fraction more than the price;
 *     nobody is short.
 *   - **Never the round number.** Every invoice on a wallet therefore asks for an amount at
 *     least one step above the price, so a payer whose exchange truncated the withdrawal to
 *     the round number cannot land exactly on a *different* invoice's amount. Their payment
 *     becomes unmatched-but-attributable rather than silently credited to a stranger.
 */
export function chooseAmount(input: {
  readonly base: bigint;
  readonly decimals: number;
  readonly taken: readonly bigint[];
  readonly unitPriceUsd?: number | null | undefined;
}): bigint {
  const plan = disambiguatorPlan(input);
  const base = ceilToGrid(input.base, input.decimals, input.unitPriceUsd);

  /**
   * Only the collisions that could actually happen are considered.
   *
   * `taken` is every amount reserved on this wallet, whatever its size. Filtering to the window
   * this invoice can reach keeps the exhaustion check honest: a thousand open invoices for
   * other prices do not make this price unavailable. An amount off the grid — an invoice from
   * before this scheme — cannot be hit by an amount on it, and is ignored.
   */
  const reachable = new Set<number>();
  for (const amount of input.taken) {
    const offset = amount - base;
    if (offset <= 0n || offset > plan.max || offset % plan.unit !== 0n) continue;
    reachable.add(Number(offset / plan.unit));
  }

  for (let tick = 1; tick <= plan.ticks; tick++) {
    if (!reachable.has(tick)) return base + BigInt(tick) * plan.unit;
  }

  /**
   * Every offset for this exact price is in use on this wallet.
   *
   * Refusing is the only safe answer: reusing one would create two invoices asking for the
   * same amount on the same address, which is precisely the state no rule can untangle. In
   * practice this needs a thousand invoices at one price on one wallet inside a day, and the
   * fix is another wallet.
   */
  throw new WalletPoolError(
    'pool_exhausted',
    'every disambiguator for this amount is in use on this wallet; add another wallet',
  );
}

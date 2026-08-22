/**
 * Which wallet an invoice gets, and what exact amount identifies it.
 *
 * Pure, and separate from the service that reads the database, because these are the two
 * decisions that decide whether a payment can be attributed to the right invoice — and both
 * have edge cases that are cheap to test here and expensive to test through a transaction.
 *
 * The model: a merchant registers a few of their own addresses. An invoice is given one of
 * them plus an amount that is unique among the invoices currently open on that address. The
 * payer's transfer goes straight to the merchant, so there is no sweep and no settlement cost
 * — the amount is doing the job a memo does on TON and a per-invoice address does on EVM.
 */

/** One wallet in the pool, with how many open invoices already point at it. */
export interface WalletLoad {
  readonly id: string;
  readonly address: string;
  /** Amounts, in smallest units, that open invoices on this wallet already ask for. */
  readonly openAmounts: readonly bigint[];
}

export class WalletPoolError extends Error {
  constructor(
    readonly code: 'pool_empty' | 'pool_exhausted' | 'decimals_too_few',
    message: string,
  ) {
    super(message);
    this.name = 'WalletPoolError';
  }
}

/**
 * How many smallest units the disambiguator may use.
 *
 * 1 to 9999, which on a 6-decimal token is 0.000001 to 0.009999 — at most one cent added to
 * an invoice, and 9999 invoices can be open at once on a single wallet before the space is full.
 * Wider would cost the payer more; narrower would run out.
 */
export const DISAMBIGUATOR_MIN = 1n;
export const DISAMBIGUATOR_MAX = 9999n;

/**
 * The fewest decimals a token may have to be used on a pooled chain.
 *
 * With six, the disambiguator is lost in the hundredths of a cent. With two it would be up to
 * 99 whole units, which is not a disambiguator but a surcharge. Refused rather than scaled,
 * because a token with two decimals on a shared address cannot be made to work this way and
 * a merchant should be told that instead of being quietly overcharged.
 */
export const MIN_DECIMALS_FOR_POOL = 6;

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

  /**
   * Ties broken by address, not left to the array's order.
   *
   * The database returns rows in whatever order it likes, so without this the choice among
   * equally loaded wallets is unpredictable — which is not wrong, but it makes a test that
   * asserts anything about the choice flaky, and a support conversation about "which wallet
   * did this invoice get" unanswerable.
   */
  return [...pool].sort((left, right) => {
    const byLoad = left.openAmounts.length - right.openAmounts.length;
    return byLoad !== 0 ? byLoad : left.address.localeCompare(right.address);
  })[0]!;
}

/**
 * The exact amount this invoice will ask for.
 *
 * `base` is what the merchant charged. The return value is always strictly greater, by between
 * one and 9999 smallest units, and never equal to an amount another open invoice on the same
 * wallet is waiting for.
 *
 * Two properties are deliberate and worth stating, because both are load-bearing:
 *
 *   - **Always added, never subtracted.** A merchant who invoiced $20 must never be paid
 *     $19.99 because of a mechanism of ours. The payer pays at most a cent more than the price;
 *     nobody is short.
 *   - **Never zero.** Every open invoice on a wallet therefore asks for a non-round amount, so
 *     a payer whose exchange truncated the withdrawal to the round number cannot land exactly
 *     on a *different* invoice's amount. Their payment becomes unmatched-but-attributable
 *     rather than silently credited to a stranger.
 *
 * Chosen at random from what is free rather than sequentially. Sequential numbers would leak
 * the merchant's open-invoice count to anybody watching the address, and would collide under
 * concurrency in the gap between reading the highest and writing the next.
 */
export function chooseAmount(input: {
  readonly base: bigint;
  readonly decimals: number;
  readonly taken: readonly bigint[];
  /** Injected so a test can pin the choice. Returns a float in [0, 1). */
  readonly random?: () => number;
}): bigint {
  if (input.decimals < MIN_DECIMALS_FOR_POOL) {
    throw new WalletPoolError(
      'decimals_too_few',
      `an asset with ${input.decimals} decimals cannot be used on a pooled address: the ` +
        `disambiguator would be a surcharge, not a rounding`,
    );
  }

  /**
   * Only the collisions that could actually happen are considered.
   *
   * `taken` is every amount open on this wallet, whatever its size. Filtering to the window
   * this invoice can reach keeps the exhaustion check honest: 9998 open invoices for other
   * prices do not make this price unavailable.
   */
  const reachable = new Set(
    input.taken
      .filter((amount) => amount > input.base && amount - input.base <= DISAMBIGUATOR_MAX)
      .map((amount) => amount - input.base),
  );

  const span = Number(DISAMBIGUATOR_MAX - DISAMBIGUATOR_MIN + 1n);
  if (reachable.size >= span) {
    /**
     * Every offset for this exact price is in use on this wallet.
     *
     * Refusing is the only safe answer: reusing one would create two open invoices asking for
     * the same amount on the same address, which is precisely the state no rule can untangle.
     * In practice this needs ten thousand simultaneously open invoices at one price on one
     * wallet, and the fix is another wallet.
     */
    throw new WalletPoolError(
      'pool_exhausted',
      'every disambiguator for this amount is in use on this wallet; add another wallet',
    );
  }

  const random = input.random ?? Math.random;

  /**
   * Try random offsets, then fall back to a scan.
   *
   * The random path is what runs: with a handful of open invoices it succeeds on the first
   * attempt essentially always. The scan exists so that a nearly-full window terminates —
   * random probing into a space that is 99% occupied would take an unbounded number of tries,
   * and "unbounded" inside invoice creation is a request that never returns.
   */
  for (let attempt = 0; attempt < 24; attempt++) {
    const offset = DISAMBIGUATOR_MIN + BigInt(Math.floor(random() * span));
    if (!reachable.has(offset)) return input.base + offset;
  }
  for (let offset = DISAMBIGUATOR_MIN; offset <= DISAMBIGUATOR_MAX; offset++) {
    if (!reachable.has(offset)) return input.base + offset;
  }
  // Unreachable: the size check above guarantees a free offset exists.
  throw new WalletPoolError('pool_exhausted', 'no free disambiguator');
}

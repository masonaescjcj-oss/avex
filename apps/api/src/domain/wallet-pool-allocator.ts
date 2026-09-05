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
 * How the amount is nudged, for one token.
 *
 * ## The shape a payer can type
 *
 * The first version of this added between 1 and 9999 smallest units — on a six-decimal token,
 * up to 0.009999. Under a cent, which was the goal, and unreadable, which was the cost: a payer
 * typing an amount into a wallet by hand was asked for 20.004137 USDT. That is a number people
 * mistype, and a mistyped amount on a shared address is a payment nobody can attribute.
 *
 * So the nudge is now placed in the digits a person reads. On a stablecoin it is cents:
 * 20.05, 20.03. Only once nine invoices at one price are open on one wallet does it move to
 * the next digit — 20.011, 20.024 — and only past ninety-nine to the one after. The payer is
 * asked for at most a tenth of a dollar more than the price, and almost always for a round
 * few cents.
 *
 * ## Why the token's price decides where the digit is
 *
 * "Cents" is a dollar idea, and the amount is in tokens. A hundredth of a USDT is a cent; a
 * hundredth of an ETH is thirty dollars, which is not a nudge but a robbery. So the coarse
 * step is chosen from the token's dollar price: two decimals past the price's magnitude, which
 * is a cent on a stablecoin, a tenth of a cent on TRX, and a third of a cent on ETH at six
 * decimals. Without a price — a token-priced invoice — the step falls to four decimals
 * inside the token's precision, which is where the old rule lived and is right for the
 * stablecoins that are nearly all of those.
 */
export interface DisambiguatorPlan {
  /** The finest step, in smallest units. Every offset is a multiple of this. */
  readonly unit: bigint;
  /** Offsets available, as multiples of `unit`: 1 to this. */
  readonly ticks: number;
  /** The largest amount that can be added, in smallest units. */
  readonly max: bigint;
  /** Decimal places the coarsest offsets occupy — 2 on a stablecoin, so 20.05. */
  readonly coarseDecimals: number;
}

/** Multiples of `unit` at the finest tier. Nine coarse, ninety mid, nine hundred fine. */
export const DISAMBIGUATOR_TICKS = 999;

/**
 * The fewest decimals a token may have to be used on a pooled address.
 *
 * Two for the coarse digit and two more beneath it for the finer tiers. A two-decimal token
 * would make the coarse step a whole unit and the fine step a cent, and neither is a nudge.
 * Refused rather than scaled, so a merchant is told instead of quietly overcharged.
 */
export const MIN_DECIMALS_FOR_POOL = 4;

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
  const fromPrice =
    price !== undefined && price !== null && Number.isFinite(price) && price > 0
      ? Math.ceil(Math.log10(price)) + 2
      : input.decimals - 4;
  // Never coarser than a hundredth of a token, never so fine that the two tiers beneath it
  // would run out of decimals.
  const coarseDecimals = Math.min(Math.max(fromPrice, 2), input.decimals - 2);

  const unit = 10n ** BigInt(input.decimals - coarseDecimals - 2);
  return {
    unit,
    ticks: DISAMBIGUATOR_TICKS,
    max: unit * BigInt(DISAMBIGUATOR_TICKS),
    coarseDecimals,
  };
}

/**
 * How round an offset is, as a tier: 0 for a whole coarse step, 1 for a whole mid step, 2
 * otherwise. Lower is preferred — it is the tier a payer reads as "a few cents".
 */
function tierOf(tick: number): 0 | 1 | 2 {
  if (tick % 100 === 0) return 0;
  if (tick % 10 === 0) return 1;
  return 2;
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
 * `base` is what the merchant charged. The return value is always strictly greater, by an
 * offset from the plan above, and never equal to an amount another open invoice on the same
 * wallet is waiting for.
 *
 * Two properties are deliberate and worth stating, because both are load-bearing:
 *
 *   - **Always added, never subtracted.** A merchant who invoiced $20 must never be paid
 *     $19.99 because of a mechanism of ours. The payer pays a few cents more than the price;
 *     nobody is short.
 *   - **Never zero.** Every open invoice on a wallet therefore asks for a non-round amount, so
 *     a payer whose exchange truncated the withdrawal to the round number cannot land exactly
 *     on a *different* invoice's amount. Their payment becomes unmatched-but-attributable
 *     rather than silently credited to a stranger.
 *
 * Chosen at random within the roundest tier that still has room, rather than sequentially.
 * Sequential numbers would leak the merchant's open-invoice count to anybody watching the
 * address, and would collide under concurrency in the gap between reading the highest and
 * writing the next. Random *within a tier* keeps the amounts readable for as long as they can
 * be: nine invoices at one price on one wallet all get whole cents before the tenth is asked
 * for a tenth of one.
 */
export function chooseAmount(input: {
  readonly base: bigint;
  readonly decimals: number;
  readonly taken: readonly bigint[];
  readonly unitPriceUsd?: number | null | undefined;
  /** Injected so a test can pin the choice. Returns a float in [0, 1). */
  readonly random?: () => number;
}): bigint {
  const plan = disambiguatorPlan(input);

  /**
   * Only the collisions that could actually happen are considered.
   *
   * `taken` is every amount open on this wallet, whatever its size. Filtering to the window
   * this invoice can reach keeps the exhaustion check honest: a thousand open invoices for
   * other prices do not make this price unavailable.
   */
  const reachable = new Set<number>();
  for (const amount of input.taken) {
    const offset = amount - input.base;
    if (offset <= 0n || offset > plan.max || offset % plan.unit !== 0n) continue;
    reachable.add(Number(offset / plan.unit));
  }

  const free: number[][] = [[], [], []];
  for (let tick = 1; tick <= plan.ticks; tick++) {
    if (!reachable.has(tick)) free[tierOf(tick)]!.push(tick);
  }

  const tier = free.find((candidates) => candidates.length > 0);
  if (tier === undefined) {
    /**
     * Every offset for this exact price is in use on this wallet.
     *
     * Refusing is the only safe answer: reusing one would create two open invoices asking for
     * the same amount on the same address, which is precisely the state no rule can untangle.
     * In practice this needs a thousand simultaneously open invoices at one price on one
     * wallet, and the fix is another wallet.
     */
    throw new WalletPoolError(
      'pool_exhausted',
      'every disambiguator for this amount is in use on this wallet; add another wallet',
    );
  }

  const random = input.random ?? Math.random;
  const tick = tier[Math.min(tier.length - 1, Math.floor(random() * tier.length))]!;
  return input.base + BigInt(tick) * plan.unit;
}

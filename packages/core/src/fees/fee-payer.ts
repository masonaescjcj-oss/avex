import { MAX_FEE_BPS } from '../chains/evm/create2.js';

/**
 * Who bears the commission, and the arithmetic that follows from the answer.
 *
 * The forwarder always takes its cut out of what arrives: it computes
 * `floor(balance * feeBps / 10000)`, sends that to the collector, and sends the rest to
 * the merchant. There is no other shape available to us — the split happens on chain,
 * in one transaction, out of one balance.
 *
 * So "the payer pays the fee" cannot mean a second transfer. It means the invoice asks
 * for more, so that what is left after the split is the amount the merchant actually
 * wanted. That grossing-up is the whole of this module, and it is separated out because
 * getting it wrong in either direction is a real loss to a real party: too low and the
 * merchant is quietly short on every order, too high and the payer is overcharged.
 */

/** Who the invoice's commission is charged to. */
export type FeePayer =
  /**
   * Deducted from the settlement. The payer sends the price; the merchant receives the
   * price less the commission. The default, because it is the one that cannot surprise
   * a payer.
   */
  | 'merchant'
  /**
   * Added to the invoice. The payer sends the price plus the commission; the merchant
   * receives the price. Disclosed on the checkout as its own line — a payer who is
   * charged more than the merchant's price and is not told why has been overcharged as
   * far as they can tell.
   */
  | 'payer';

export class FeePayerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeePayerError';
  }
}

function assertBps(feeBps: number): void {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_FEE_BPS) {
    throw new FeePayerError(
      `feeBps must be an integer in 0-${MAX_FEE_BPS}; got ${String(feeBps)}`,
    );
  }
}

/**
 * The cut the forwarder will take from a balance, to the unit.
 *
 * This must match `Forwarder._feeOn` exactly, including the direction of the rounding.
 * The contract rounds down, which favours the merchant, and a mirror here that rounded
 * the other way would make every projected settlement one unit short of the real one —
 * a discrepancy that would show up as an unexplained penny in reconciliation rather
 * than as an error anyone could act on.
 */
export function feeOnAmount(amount: bigint, feeBps: number): bigint {
  assertBps(feeBps);
  if (amount <= 0n) return 0n;
  return (amount * BigInt(feeBps)) / 10_000n;
}

/** What the merchant receives when `amount` arrives. */
export function amountAfterFee(amount: bigint, feeBps: number): bigint {
  return amount - feeOnAmount(amount, feeBps);
}

/**
 * The smallest amount that leaves the merchant with `net` after the split.
 *
 * Two properties, and both are tested rather than argued: the result never leaves the
 * merchant short, and it is the *smallest* amount with that property.
 *
 * The second is not fussiness. The closed form `ceil(net * 10000 / (10000 - bps))`
 * satisfies the first but overshoots, because the fee the contract actually charges is
 * floored. At a dust amount the floor takes the fee to nothing, and the closed form
 * still asks for 2 units to deliver 1 — a 100% surcharge. So the closed form is only a
 * starting point, walked down to the real boundary.
 *
 * Floor division, not ceiling, and it is worth saying why the cheaper one is safe. With
 * `g = floor(net * 10000 / (10000 - bps))` we have `g > net * 10000 / (10000 - bps) - 1`,
 * so `f(g) >= g * (10000 - bps) / 10000 > net - 1` where `f(g) = g - floor(g * bps / 10000)`.
 * `f(g)` is an integer, so `f(g) >= net`: the starting point is never below the answer, and
 * the walk down does the rest. Rounding up first would only ever add an iteration.
 *
 * From that starting point one step is in fact always enough at every rate the forwarder
 * allows — measured, not assumed. It is written as a loop anyway, because that fact
 * depends on `bps` being far below 10000 and a loop needs no such argument to be right.
 * A single `if` here passes every test in the suite; the loop is the version whose
 * correctness does not rest on a bound somebody could later raise.
 */
export function grossUpForFee(net: bigint, feeBps: number): bigint {
  assertBps(feeBps);
  if (net <= 0n) return net;

  // Integer division throughout. A float here would lose exactness above 2^53, which is
  // well inside the range of an 18-decimal token amount.
  let gross = (net * 10_000n) / BigInt(10_000 - feeBps);

  while (gross > 1n && amountAfterFee(gross - 1n, feeBps) >= net) gross -= 1n;
  return gross;
}

/**
 * What to ask the payer for, and what the merchant will keep, given who bears the fee.
 *
 * Returned together because they are two views of one decision and every surface needs
 * both: the payer sees `amountDue`, the merchant sees `amountNet`, and the difference is
 * the line the checkout has to disclose.
 */
export function applyFeePayer(
  netRequested: bigint,
  feeBps: number,
  feePayer: FeePayer,
): {
  readonly amountDue: bigint;
  readonly amountNet: bigint;
  readonly feeAmount: bigint;
  /** What the invoice asks for beyond the merchant's price. Zero unless the payer pays. */
  readonly surcharge: bigint;
} {
  const amountDue = feePayer === 'payer' ? grossUpForFee(netRequested, feeBps) : netRequested;
  const feeAmount = feeOnAmount(amountDue, feeBps);
  return {
    amountDue,
    amountNet: amountDue - feeAmount,
    feeAmount,
    surcharge: amountDue - netRequested,
  };
}

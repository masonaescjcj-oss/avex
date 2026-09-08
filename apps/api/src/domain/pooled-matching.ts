import { sameHumanAmount } from '@avex/core';

/**
 * Whose payment is this? The rules for a transfer that reached a shared wallet.
 *
 * On a forwarder address the question does not arise: the address was derived for one invoice
 * and anything that reaches it is that invoice's. On a merchant's own wallet several invoices
 * are open at once and the transfer carries three clues — how much, in which token, from whom —
 * none of which is an identity. This module is every rule for reading those clues, in the order
 * they are trusted, written as a pure function so that every scenario in the design can be a
 * test rather than an incident.
 *
 * ## What is trusted, in order
 *
 * 1. **The exact number.** Every invoice on a wallet is issued with a distinct amount — that is
 *    what the disambiguator is for — so a transfer for exactly one invoice's amount is that
 *    invoice's. Compared as the number a person read and typed, not as smallest units, so the
 *    right number in the wrong stablecoin still finds its invoice. Honoured for a day after the
 *    invoice closed, because the pool keeps the number reserved that long: a payer who let the
 *    invoice expire and paid an hour later still sent the exact figure they were shown.
 *
 * 2. **The same sender, topping up.** A wallet that paid part of an invoice here and now sends
 *    again, with a different amount, is completing it. That payment belongs with the first,
 *    not to whichever stranger's invoice happens to be open. Only an invoice still short —
 *    pending, confirming, underpaid — counts as evidence. One already paid does not: a
 *    wallet that settled an order this morning and sends a new amount this afternoon is a
 *    repeat customer with a new invoice, not somebody paying a finished order twice. (The
 *    first version treated it as the latter, and a merchant's own test wallet, paying every
 *    trial invoice from one address, saw each new payment attached to the previous order.)
 *    The rare genuine double payment of a settled invoice still finds it, through rule 1,
 *    when it repeats the exact figure.
 *
 * 3. **The only candidate.** When exactly one invoice is open on the wallet, nothing else the
 *    transfer could be for exists, whatever the amount and whatever the token. Credited, and
 *    the over/under classification records the difference — an underpayment keeps the
 *    shortfall rather than failing, because real money arrived. This is what the allocator's
 *    preference for idle wallets buys. Only *open* invoices count: an expired one on the same
 *    wallet does not hold a new payment back. Its payer, if late, sends the exact figure they
 *    were shown and rule 1 finds them; a payer who is both late and wrong is the rare case the
 *    merchant chose to accept rather than make every other payer wait.
 *
 * 4. **Nothing.** Two or more invoices open and a transfer matching none of them: nothing on
 *    the chain says which it was for, so nothing here guesses. It is parked for a later pass —
 *    once the other invoices are paid exactly, or expire, the survivor is the only candidate
 *    and rule 3 applies — and, failing that, for an operator.
 *
 * ## What the rules never do
 *
 * They never credit an invoice created after the transfer was seen; that invoice cannot have
 * been what the payer was looking at. They never pick between two exact matches, which the
 * allocator's lock makes impossible and a bug elsewhere could produce — a coin flip with
 * somebody's money is worse than a queue entry. And they never wait: a decision is a decision
 * or a parking, never "ask again in a minute", because the caller is the chain watcher and it
 * must not stall behind one transfer.
 */

/** One invoice at the wallet, as the rules see it. */
export interface CandidateInvoice {
  readonly id: string;
  readonly amountDue: bigint;
  readonly decimals: number;
  /** The token, in a form two invoices or a transfer can be compared by. */
  readonly assetKey: string;
  readonly status: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
  readonly createdAt: number;
}

/** The transfer being decided. */
export interface ObservedTransfer {
  readonly amount: bigint;
  readonly decimals: number;
  readonly assetKey: string;
  readonly from: string | null;
  /** When it was first seen, epoch milliseconds. Now, at receive time; earlier on a re-run. */
  readonly seenAt: number;
}

/** A payment already credited to an invoice at this wallet, for the sender rule. */
export interface PriorPayment {
  readonly invoiceId: string;
  readonly from: string | null;
  readonly creditedAt: number;
}

export interface MatchContext {
  readonly now: number;
  readonly candidates: readonly CandidateInvoice[];
  readonly priorPayments: readonly PriorPayment[];
}

export type MatchRule = 'exact_amount' | 'exact_amount_late' | 'same_sender' | 'sole_open';

export type MatchDecision =
  | {
      readonly kind: 'credit';
      readonly invoiceId: string;
      readonly rule: MatchRule;
      /** False when the token differs from the one invoiced; the sink then credits by value. */
      readonly sameAsset: boolean;
    }
  | {
      readonly kind: 'park';
      readonly reason: 'ambiguous' | 'invoice_expired';
    };

/**
 * How long after an invoice closes its exact amount still names it.
 *
 * The same day the pool keeps the amount reserved for — the two are one rule seen from two
 * sides, and `wallet-pool-service` states the reasoning.
 */
export const LATE_PAYMENT_GRACE_MS = 24 * 60 * 60 * 1000;

const OPEN = new Set(['pending', 'confirming']);

/** Statuses a second transfer from the same wallet can be completing. Never `paid`. */
const TOPPABLE = new Set(['pending', 'confirming', 'underpaid']);

export function isOpen(candidate: CandidateInvoice, now: number): boolean {
  return OPEN.has(candidate.status) && candidate.expiresAt > now;
}

export function decidePooled(
  transfer: ObservedTransfer,
  context: MatchContext,
): MatchDecision {
  const { now } = context;
  /**
   * Only invoices that existed when the transfer was seen can be what it paid.
   *
   * At receive time this excludes nothing. On a re-run over a parked transfer it excludes every
   * invoice issued since, which is what makes "the survivor is the only candidate" safe: a fresh
   * invoice put on this wallet after the stray arrived is not a survivor, it is a newcomer.
   */
  const candidates = context.candidates.filter((c) => c.createdAt <= transfer.seenAt);
  const sameAsset = (c: CandidateInvoice): boolean => c.assetKey === transfer.assetKey;

  // 1. The exact number, on an invoice still open or closed within the grace period.
  const exact = candidates.filter(
    (c) =>
      sameHumanAmount(
        { amount: transfer.amount, decimals: transfer.decimals },
        { amount: c.amountDue, decimals: c.decimals },
      ) &&
      (isOpen(c, now) || c.expiresAt > now - LATE_PAYMENT_GRACE_MS),
  );
  if (exact.length === 1) {
    const [only] = exact;
    return {
      kind: 'credit',
      invoiceId: only!.id,
      rule: isOpen(only!, now) ? 'exact_amount' : 'exact_amount_late',
      sameAsset: sameAsset(only!),
    };
  }
  if (exact.length > 1) {
    /**
     * Two invoices at one amount should be impossible; the allocator's lock is what makes it
     * so. If one of them is open and the rest are closed, the open one is overwhelmingly the
     * answer — a reused number after the reservation lapsed. Two open at one amount is the bug
     * the lock exists to prevent, and is handed to a person rather than resolved by row order.
     */
    const open = exact.filter((c) => isOpen(c, now));
    if (open.length === 1) {
      return { kind: 'credit', invoiceId: open[0]!.id, rule: 'exact_amount', sameAsset: sameAsset(open[0]!) };
    }
    return { kind: 'park', reason: 'ambiguous' };
  }

  // 2. The same sender as a payment already credited here, to an invoice still short of it.
  if (transfer.from !== null) {
    const known = new Set<string>();
    for (const prior of context.priorPayments) {
      if (prior.from === null || prior.from !== transfer.from) continue;
      if (prior.creditedAt < now - LATE_PAYMENT_GRACE_MS) continue;
      const invoice = candidates.find((c) => c.id === prior.invoiceId);
      if (invoice === undefined || !TOPPABLE.has(invoice.status)) continue;
      known.add(prior.invoiceId);
    }
    if (known.size === 1) {
      const [invoiceId] = known;
      const invoice = candidates.find((c) => c.id === invoiceId)!;
      return { kind: 'credit', invoiceId: invoiceId!, rule: 'same_sender', sameAsset: sameAsset(invoice) };
    }
    // Two invoices from one sender and a third transfer: genuinely nobody's to decide.
    if (known.size > 1) return { kind: 'park', reason: 'ambiguous' };
  }

  // 3. The only invoice it could be for.
  const open = candidates.filter((c) => isOpen(c, now));
  if (open.length === 0) return { kind: 'park', reason: 'invoice_expired' };

  if (open.length === 1) {
    return { kind: 'credit', invoiceId: open[0]!.id, rule: 'sole_open', sameAsset: sameAsset(open[0]!) };
  }

  // 4. Nothing decides it.
  return { kind: 'park', reason: 'ambiguous' };
}

/**
 * A token as a comparable string: the contract where there is one, else the symbol, on the
 * chain. Case-folded, because two adapters may report the same contract in two cases and a
 * TRON address's case is significant only for its checksum, which is not what is compared.
 */
export function assetKeyOf(asset: {
  readonly chain: string;
  readonly symbol: string;
  readonly contract?: string | null | undefined;
}): string {
  const id = asset.contract && asset.contract.length > 0 ? asset.contract : `native:${asset.symbol}`;
  return `${asset.chain}:${id.toLowerCase()}`;
}

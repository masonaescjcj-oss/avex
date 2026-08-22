import { and, desc, eq, sql } from 'drizzle-orm';

import type { Database, Transaction } from '../db/client.js';
import { commissionLedger } from '../db/schema.js';
import { MAX_FEE_BPS } from './fee-plan-service.js';

/**
 * What a merchant owes us, and how it gets collected.
 *
 * On EVM the forwarder takes the commission in the same transaction that pays the merchant, so
 * there is nothing to bill. Pooled chains have no such transaction — the payer pays the
 * merchant's own wallet directly and we are not in the path — so the commission there can only
 * be a debt, recorded here and recovered from the merchant's next invoice on a chain where a cut
 * can be taken on chain.
 *
 * ## The ceiling, and why the recovery is not simply "take what is owed"
 *
 * `Forwarder.MAX_FEE_BPS` is 500 — five per cent — and it is enforced by the contract, not by
 * our policy. The comment in the contract says why: a forwarder that could be constructed to
 * take everything would make the immutability guarantee worthless, because the address would
 * commit to a number and the number could be 10000. So an invoice cannot recover more than 5% of
 * itself no matter how large the debt, and raising that ceiling would mean new bytecode, which
 * means every deposit address this system has ever derived changes.
 *
 * A $10 debt is therefore not recovered from the next $20 invoice. It is recovered from the next
 * few hundred dollars of volume on a fee-bearing chain — and if that volume never comes, it is
 * recovered by asking for it, which is what `RECOVERY_CREDIT_LIMIT_USD_MICROS` is for: past that
 * balance the merchant stops being able to open pooled invoices at all. Collection by refusing
 * new business is slower than collection by confiscation, and it is the only version of this
 * that does not require breaking the property the product is sold on.
 */

/**
 * The most a single invoice's fee may be raised to recover a balance, in basis points.
 *
 * Two per cent, on top of the merchant's own rate — so an account on 0.5% pays at most 2.5% on
 * an invoice that is recovering, comfortably inside the contract's 5%. The number is a judgement
 * rather than a constraint: a merchant who sees a quarter of a payment disappear into a balance
 * they had forgotten about closes their account, and a gateway's fee showing up as five times
 * the advertised rate is the kind of surprise that ends the relationship whatever the paperwork
 * says.
 */
export const RECOVERY_MAX_BPS = 200;

/**
 * How much a merchant may owe before pooled invoices stop being issued, in micro-dollars.
 *
 * $500. This is the actual enforcement — the fee raise only collects, and collects slowly. A
 * merchant taking TRON volume and never taking any other kind would otherwise accrue without
 * limit, and the first time anybody noticed would be when the number was too large to collect.
 */
export const RECOVERY_CREDIT_LIMIT_USD_MICROS = 500_000_000n;

export class LedgerError extends Error {
  constructor(
    readonly code: 'note_required' | 'zero_amount',
    message: string,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

export interface LedgerEntry {
  readonly id: string;
  readonly kind: string;
  readonly amountUsdMicros: bigint;
  readonly paymentId: string | null;
  readonly invoiceId: string | null;
  readonly note: string | null;
  readonly createdAt: Date;
}

export class CommissionLedger {
  constructor(private readonly db: Database) {}

  /**
   * The balance, in micro-dollars, signed as the merchant sees it.
   *
   * Negative means they owe us. Summed rather than stored, so it cannot disagree with the
   * entries that a merchant disputing it will be shown.
   */
  async balance(organizationId: string): Promise<bigint> {
    const [row] = await this.db
      .select({
        total: sql<string>`coalesce(sum(${commissionLedger.amountUsdMicros}), 0)::text`,
      })
      .from(commissionLedger)
      .where(eq(commissionLedger.organizationId, organizationId));
    return BigInt(row?.total ?? '0');
  }

  /** The statement, newest first. */
  async entries(
    organizationId: string,
    limit = 100,
  ): Promise<readonly LedgerEntry[]> {
    const rows = await this.db
      .select({
        id: commissionLedger.id,
        kind: commissionLedger.kind,
        amountUsdMicros: commissionLedger.amountUsdMicros,
        paymentId: commissionLedger.paymentId,
        invoiceId: commissionLedger.invoiceId,
        note: commissionLedger.note,
        createdAt: commissionLedger.createdAt,
      })
      .from(commissionLedger)
      .where(eq(commissionLedger.organizationId, organizationId))
      .orderBy(desc(commissionLedger.createdAt))
      .limit(limit);

    return rows.map((row) => ({ ...row, amountUsdMicros: BigInt(row.amountUsdMicros) }));
  }

  /**
   * Charge the commission on a payment we could not take a cut of on chain.
   *
   * Floored, mirroring `Forwarder._feeOn`, so that the off-chain rate and the on-chain one
   * produce the same figure for the same payment — a merchant comparing a TRON invoice with a
   * BSC one at the same price must not find them a micro-dollar apart with no explanation.
   *
   * Idempotent on (payment, kind) by a unique index rather than by checking first: a re-scanned
   * block range and a retried job both arrive here again, and a check-then-insert races itself.
   */
  async accrue(
    tx: Transaction | Database,
    input: {
      readonly organizationId: string;
      readonly paymentId: string;
      readonly invoiceId: string;
      readonly valueUsdMicros: bigint;
      readonly accruedFeeBps: number;
    },
  ): Promise<bigint> {
    if (input.accruedFeeBps <= 0 || input.valueUsdMicros <= 0n) return 0n;

    const commission = (input.valueUsdMicros * BigInt(input.accruedFeeBps)) / 10_000n;
    if (commission === 0n) return 0n;

    await tx
      .insert(commissionLedger)
      .values({
        organizationId: input.organizationId,
        kind: 'accrual',
        // Negative: the merchant owes this.
        amountUsdMicros: (-commission).toString(),
        paymentId: input.paymentId,
        invoiceId: input.invoiceId,
      })
      .onConflictDoNothing();

    return commission;
  }

  /**
   * Undo an accrual whose payment was reversed.
   *
   * A reorg can take a credited payment away, and a merchant must not be left owing commission
   * on a sale that did not happen. A compensating entry rather than a delete, because the
   * statement is the record and a line that vanishes is a line nobody can ask about.
   */
  async reverseAccrual(
    tx: Transaction | Database,
    input: {
      readonly organizationId: string;
      readonly paymentId: string;
    },
  ): Promise<bigint> {
    const [accrual] = await tx
      .select({ amountUsdMicros: commissionLedger.amountUsdMicros })
      .from(commissionLedger)
      .where(
        and(
          eq(commissionLedger.paymentId, input.paymentId),
          eq(commissionLedger.kind, 'accrual'),
        ),
      )
      .limit(1);
    if (!accrual) return 0n;

    const amount = -BigInt(accrual.amountUsdMicros);
    await tx
      .insert(commissionLedger)
      .values({
        organizationId: input.organizationId,
        kind: 'accrual_reversed',
        amountUsdMicros: amount.toString(),
        paymentId: input.paymentId,
        note: 'payment reversed by a reorg',
      })
      .onConflictDoNothing();
    return amount;
  }

  /**
   * Record what an on-chain fee raise actually collected.
   *
   * Written when the payment is credited rather than when the invoice was created, because the
   * two differ: `recovery_bps` is a rate committed to an address, and what it collects depends
   * on the amount the payer actually sent. An invoice quoted at $100 and paid $60 recovers 40%
   * less than planned, and the balance has to reflect what was taken rather than what was hoped
   * for.
   */
  async recover(
    tx: Transaction | Database,
    input: {
      readonly organizationId: string;
      readonly paymentId: string;
      readonly invoiceId: string;
      readonly valueUsdMicros: bigint;
      readonly recoveryBps: number;
    },
  ): Promise<bigint> {
    if (input.recoveryBps <= 0 || input.valueUsdMicros <= 0n) return 0n;

    const recovered = (input.valueUsdMicros * BigInt(input.recoveryBps)) / 10_000n;
    if (recovered === 0n) return 0n;

    await tx
      .insert(commissionLedger)
      .values({
        organizationId: input.organizationId,
        kind: 'recovery',
        amountUsdMicros: recovered.toString(),
        paymentId: input.paymentId,
        invoiceId: input.invoiceId,
      })
      .onConflictDoNothing();

    return recovered;
  }

  /**
   * A human entry: the merchant paid us directly, or an operator corrected the balance.
   *
   * A note is required on both. An unexplained movement in what a merchant owes is the one
   * thing this table exists to make impossible.
   */
  async record(input: {
    readonly organizationId: string;
    readonly kind: 'settlement' | 'adjustment';
    readonly amountUsdMicros: bigint;
    readonly staffId: string;
    readonly note: string;
  }): Promise<void> {
    if (input.amountUsdMicros === 0n) {
      throw new LedgerError('zero_amount', 'a ledger entry of zero says nothing');
    }
    if (input.note.trim() === '') {
      throw new LedgerError(
        'note_required',
        `a ${input.kind} needs a reason: it changes what a merchant owes`,
      );
    }

    await this.db.insert(commissionLedger).values({
      organizationId: input.organizationId,
      kind: input.kind,
      amountUsdMicros: input.amountUsdMicros.toString(),
      staffId: input.staffId,
      note: input.note.trim(),
    });
  }

  /**
   * Whether this merchant may still open an invoice on a chain that accrues.
   *
   * The real enforcement. The fee raise collects, but slowly and only from volume that happens
   * to arrive; without a limit a merchant could accrue indefinitely on the one chain where we
   * cannot take anything, and the first anybody would know is a number too large to collect.
   */
  async withinCreditLimit(organizationId: string): Promise<boolean> {
    const balance = await this.balance(organizationId);
    return balance > -RECOVERY_CREDIT_LIMIT_USD_MICROS;
  }
}

/**
 * How many basis points to add to an invoice's fee to recover an outstanding balance.
 *
 * Pure, so the arithmetic can be tested against every boundary that matters — and there are
 * three, all of which cost somebody money if they are wrong:
 *
 *   - the contract's ceiling, which a fee above reverts at deployment, leaving a funded address
 *     that cannot be swept;
 *   - `RECOVERY_MAX_BPS`, so a merchant's effective rate never becomes a surprise;
 *   - the debt itself, so an invoice never collects more than is owed and turns a balance
 *     positive — we would then owe the merchant, which is a refund nobody asked for.
 */
export function recoveryBpsFor(input: {
  /** Signed balance in micro-dollars. Negative means the merchant owes us. */
  readonly balanceUsdMicros: bigint;
  /** The merchant's own rate, which the recovery is added on top of. */
  readonly planFeeBps: number;
  /** What this invoice is worth, in micro-dollars. Zero for an open-amount invoice. */
  readonly invoiceValueUsdMicros: bigint;
}): number {
  if (input.balanceUsdMicros >= 0n) return 0;
  if (input.invoiceValueUsdMicros <= 0n) return 0;

  const owed = -input.balanceUsdMicros;

  /**
   * The rate that would collect exactly what is owed, rounded *down*.
   *
   * Down rather than up, so an invoice never over-collects by a rounding. The remainder stays
   * on the balance and is collected by the next one — which costs us a few micro-dollars of
   * float and cannot produce the case where we owe the merchant money back.
   */
  const exact = (owed * 10_000n) / input.invoiceValueUsdMicros;

  const headroom = Math.max(0, MAX_FEE_BPS - input.planFeeBps);
  const cap = Math.min(RECOVERY_MAX_BPS, headroom);
  if (cap === 0) return 0;

  return Number(exact > BigInt(cap) ? BigInt(cap) : exact);
}

import type { FeePayer } from '@avex/core';
import { and, count, eq, gte, isNotNull, isNull, lt, lte, sql } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { feePlans, invoices, payments } from '../db/schema.js';
import type { AuditService } from './audit.js';
import type { StaffRole } from './staff-rbac.js';

/**
 * What a merchant pays AVEX: a commission, and nothing else.
 *
 * There is no monthly fee, no seat price and no minimum. A merchant who processes
 * nothing pays nothing, and a merchant who processes a million dollars pays a
 * percentage of it. That is the entire pricing model, and it is worth saying why,
 * because the code is much smaller than the code it replaced and the difference is not
 * an oversight.
 *
 * A subscription and a commission are not two ways of charging for the same thing. A
 * subscription is a debt: it exists whether or not the merchant used the product, so
 * something has to raise it, chase it, tolerate lateness, and eventually decide what a
 * merchant who has not paid is still allowed to do. Every one of those is a mechanism
 * we would have to build, and a way for our billing to break a working checkout.
 *
 * A commission is not a debt. It is taken on chain, by the forwarder, out of the money
 * as it is swept — the deposit address itself commits to the split, so the cut is
 * collected in the same transaction that pays the merchant. There is no moment at which
 * a merchant owes us anything, so there is nothing to be late on and no state in which
 * we would be tempted to hold a payer's settlement hostage to our own invoice.
 *
 * What is left for this service to do is decide the rate: read it at invoice creation,
 * and move merchants along the published ladder as their volume changes.
 */

/**
 * The commission, in basis points, by monthly volume.
 *
 * These are the market's numbers, not ours. Cryptomus and Heleket both advertise
 * "from 0.4%", NOWPayments charges 0.5% on a same-coin settlement, and the card-shaped
 * processors sit at 1% or above — CoinGate and Coinbase Commerce at 1%, BitPay at 1-2%
 * plus $0.25, Stripe's USDC at 1.5% plus $0.30. A crypto-native gateway that charged
 * more than 0.5% would be choosing to lose on price.
 *
 * So the entry rate is 0.5% and volume earns its way down to 0.4%, which is where the
 * competitive floor is. Tiers are read from the volume a merchant actually processed
 * rather than negotiated one merchant at a time, because a published ladder is
 * something a merchant can plan against and a private rate is not.
 *
 * One thing worth saying plainly about the competitors' 0.4% figures: they are entry
 * teasers. Cryptomus starts new merchants at 2% and comes down with turnover. Ours
 * applies from the first invoice.
 */
export const FEE_TIERS: readonly { readonly fromUsdMicros: bigint; readonly bps: number }[] = [
  { fromUsdMicros: 250_000_000_000n, bps: 40 }, // $250k+/month
  { fromUsdMicros: 50_000_000_000n, bps: 45 }, //  $50k+/month
  { fromUsdMicros: 0n, bps: 50 }, //             everyone else
];

/** The rate a merchant pays before any volume history exists. */
export const DEFAULT_FEE_BPS = 50;

/**
 * Hard ceiling, mirroring `Forwarder.MAX_FEE_BPS`.
 *
 * A rate above this cannot be delivered on chain — the forwarder reverts — so a
 * negotiated rate that exceeded it would produce invoices that take a payment and then
 * cannot be swept.
 */
export const MAX_FEE_BPS = 500;

/** Months per volume period. One; the option exists so a change needs no migration. */
export const DEFAULT_PERIOD_MONTHS = 1;

/** The tier a given monthly volume falls into. */
export function feeBpsForVolume(usdMicros: bigint): number {
  for (const tier of FEE_TIERS) {
    if (usdMicros >= tier.fromUsdMicros) return tier.bps;
  }
  // Unreachable while the last tier starts at zero, and a cheap guard against someone
  // reordering the table and silently dropping the floor.
  return DEFAULT_FEE_BPS;
}

export class FeePlanError extends Error {
  constructor(
    readonly code: 'not_found' | 'fee_out_of_range',
    message: string,
  ) {
    super(message);
    this.name = 'FeePlanError';
  }
}

export interface FeePlanOptions {
  readonly periodMonths?: number;
  /**
   * Where commission is sent, per chain.
   *
   * Per chain because an address is chain-shaped: our BSC collector is not a valid TRON
   * address. A chain absent from this map cannot charge commission at all — `feeFor`
   * returns nothing rather than guessing, because a fee to a malformed address is a fee
   * that burns the merchant's money.
   */
  readonly feeCollectors?: Readonly<Record<string, string>>;
}

export class FeePlanService {
  private readonly periodMonths: number;
  private readonly feeCollectors: Readonly<Record<string, string>>;

  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    options: FeePlanOptions = {},
  ) {
    this.periodMonths = options.periodMonths ?? DEFAULT_PERIOD_MONTHS;
    this.feeCollectors = options.feeCollectors ?? {};
  }

  /**
   * The commission a new invoice for this merchant should carry, on this chain.
   *
   * Returns nothing — meaning no fee — in three cases, and each is deliberate. The
   * merchant's rate is zero, because someone negotiated that. We have no collector
   * address for the chain, because sending a fee to an address we cannot form would
   * burn it. Or there is no plan row at all, which is a gap in our own bookkeeping and
   * must not become a charge the merchant did not agree to.
   *
   * Read at invoice creation and then snapshotted onto the invoice. It must not be
   * consulted again at settlement: the deposit address commits to the fee, so a rate
   * that changed in between would derive an address nobody funded.
   */
  async feeFor(
    organizationId: string,
    chain: string,
  ): Promise<
    | {
        readonly feeDestination: string;
        readonly feeBps: number;
        /** The merchant's default. An individual invoice may still override it. */
        readonly feePayer: FeePayer;
      }
    | undefined
  > {
    const [plan] = await this.db
      .select({ feeBps: feePlans.feeBps, feePayer: feePlans.feePayer })
      .from(feePlans)
      .where(eq(feePlans.organizationId, organizationId))
      .limit(1);
    if (!plan || plan.feeBps === 0) return undefined;

    const feeDestination = this.feeCollectors[chain];
    if (!feeDestination) return undefined;

    // Clamped rather than trusted. The column has a check constraint, but this is the
    // value that reaches a constructor argument, and the forwarder reverts above the
    // ceiling — a revert here would mean a funded address we cannot deploy.
    return {
      feeDestination,
      feeBps: Math.min(plan.feeBps, MAX_FEE_BPS),
      feePayer: plan.feePayer,
    };
  }

  /**
   * Set who this merchant's invoices charge the commission to, by default.
   *
   * The merchant's own decision rather than a staff one, which is why this takes a user
   * and not a staff actor: it changes what their customers are asked to pay, not what we
   * are paid. Either way our cut is the same.
   *
   * Recorded in the audit trail because it changes the amount on every subsequent
   * invoice, and "why did our prices go up half a per cent last Tuesday" deserves an
   * answer that is not a guess.
   */
  async setFeePayer(
    organizationId: string,
    feePayer: FeePayer,
    userId: string | null,
  ): Promise<void> {
    const [updated] = await this.db
      .update(feePlans)
      .set({ feePayer })
      .where(eq(feePlans.organizationId, organizationId))
      .returning({ id: feePlans.id, previous: feePlans.feePayer });
    if (!updated) throw new FeePlanError('not_found', 'No fee plan for this merchant.');

    await this.audit.record({
      organizationId,
      userId,
      action: 'fee_plan.fee_payer_changed',
      targetType: 'fee_plan',
      targetId: updated.id,
      // Invoices already issued keep what they were created with — their amounts are
      // committed — so this only affects future ones.
      metadata: { from: updated.previous, to: feePayer },
    });
  }

  /**
   * Set a rate by hand, outside the ladder.
   *
   * Marks the plan as negotiated, which is what stops `closePeriods` from quietly
   * undoing it next month. Refused above the on-chain ceiling here as well as in the
   * database, so the caller gets an error naming the fee rather than a constraint
   * violation.
   */
  async setFeeBps(
    actor: { readonly staffId: string; readonly role: StaffRole },
    organizationId: string,
    feeBps: number,
    note: string,
  ): Promise<void> {
    if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_FEE_BPS) {
      throw new FeePlanError(
        'fee_out_of_range',
        `A fee of ${feeBps}bps is outside the 0-${MAX_FEE_BPS}bps the forwarder can deliver.`,
      );
    }

    const [updated] = await this.db
      .update(feePlans)
      .set({ feeBps, negotiatedFee: true })
      .where(eq(feePlans.organizationId, organizationId))
      .returning({ id: feePlans.id, previous: feePlans.feeBps });
    if (!updated) throw new FeePlanError('not_found', 'No fee plan for this merchant.');

    await this.audit.record({
      organizationId,
      staffId: actor.staffId,
      action: 'fee_plan.negotiated',
      targetType: 'fee_plan',
      targetId: updated.id,
      // The note is required by the route, and it is the only record of *why* this
      // merchant pays a different rate from the published ladder.
      metadata: { feeBps, note, role: actor.role },
    });
  }

  /**
   * What a merchant would pay per $1,000 at their current rate.
   *
   * Shown rather than left as basis points. "50 bps" is the unit the ladder is written
   * in; "$5.00 per $1,000" is the unit a merchant thinks in, and the two being the same
   * number expressed differently is exactly why one of them should be computed for them
   * rather than by them.
   */
  static feeExample(feeBps: number, perUsd = 1_000): number {
    return (perUsd * feeBps) / 10_000;
  }

  /**
   * What a merchant processed in a window, split by how trustworthy the figure is.
   *
   * The split is the point. `verified` comes from rates we set — the quote locked on the
   * invoice, or our own oracle. `declared` comes from a `fixed_rate` a merchant chose for
   * a token nobody else prices, which they have an obvious incentive to overstate now
   * that volume buys a cheaper rate. `unknown` is volume we could not price at all.
   *
   * Both verified and declared count towards the ladder, because refusing to count a
   * merchant's own token would penalise a legitimate use. But declared volume is returned
   * separately so that a merchant who climbed a rung entirely on self-declared rates is
   * visible to an operator rather than invisible. Prevention where it is cheap; detection
   * where it is not.
   */
  async assessedVolume(
    organizationId: string,
    window: { readonly from: Date; readonly to: Date },
  ): Promise<{
    readonly verifiedUsdMicros: bigint;
    readonly declaredUsdMicros: bigint;
    readonly unpricedPayments: number;
    readonly totalUsdMicros: bigint;
  }> {
    const rows = await this.db
      .select({
        source: payments.valueSource,
        total: sql<string>`coalesce(sum(${payments.valueUsdMicros}), 0)::text`,
        rows: count(),
      })
      .from(payments)
      .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
      .where(
        and(
          eq(invoices.organizationId, organizationId),
          /**
           * Test invoices are not volume, and this is the load-bearing reason test mode
           * is a column rather than a convention.
           *
           * The commission ladder reads this figure, so a merchant able to add test
           * volume could climb into a cheaper tier for free — choosing their own rate.
           * The filter belongs here rather than in a caller that might forget.
           */
          eq(invoices.mode, 'live'),
          // Reversed payments are not volume. A reorg that took a payment back must not
          // buy a merchant a cheaper rate for a month that did not happen.
          isNull(payments.reversedAt),
          gte(payments.creditedAt, window.from),
          /**
           * Half-open: `[from, to)`.
           *
           * One period's end is the next period's start, so a payment credited at
           * exactly that instant must land in one window and not both. Inclusive on
           * either side would count it twice and could buy a rung it did not earn.
           */
          lt(payments.creditedAt, window.to),
        ),
      )
      .groupBy(payments.valueSource);

    let verified = 0n;
    let declared = 0n;
    let unpriced = 0;

    for (const row of rows) {
      if (row.source === 'quote' || row.source === 'oracle') verified += BigInt(row.total);
      else if (row.source === 'merchant_rate') declared += BigInt(row.total);
      else unpriced += row.rows;
    }

    return {
      verifiedUsdMicros: verified,
      declaredUsdMicros: declared,
      unpricedPayments: unpriced,
      totalUsdMicros: verified + declared,
    };
  }

  /**
   * What an account has actually paid us, in dollars.
   *
   * Two figures, because they answer different questions and conflating them would
   * overstate the money we hold. `credited` is commission on payments we have seen and
   * credited: it is owed to us by the chain and will reach the collector when the invoice
   * is swept. `settled` is the part where that sweep has happened, so it is the figure
   * that should agree with the collector wallet.
   *
   * Both are estimates from `payments.value_usd_micros`, which is what the payment was
   * worth when it was credited. The commission itself is taken in token units on chain,
   * so its dollar value moves with the market afterwards — nothing here is a substitute
   * for reading the collector's own balance, and it is not presented as one.
   */
  async commissionEarned(
    filter: { readonly organizationId?: string; readonly from?: Date; readonly to?: Date } = {},
  ): Promise<{ readonly creditedUsdMicros: bigint; readonly settledUsdMicros: bigint }> {
    /**
     * Floored per payment, mirroring the contract.
     *
     * `Forwarder._feeOn` floors each invoice's cut individually, so summing first and
     * flooring once would overstate the total by up to a unit per payment — which is
     * exactly the kind of drift that makes a revenue figure impossible to reconcile
     * against a wallet.
     */
    const cut = sql<string>`coalesce(sum(floor(${payments.valueUsdMicros} * ${invoices.feeBps} / 10000)), 0)::text`;

    const conditions = [
      eq(invoices.mode, 'live'),
      isNull(payments.reversedAt),
      ...(filter.organizationId ? [eq(invoices.organizationId, filter.organizationId)] : []),
      ...(filter.from ? [gte(payments.creditedAt, filter.from)] : []),
      ...(filter.to ? [lt(payments.creditedAt, filter.to)] : []),
    ];

    const [credited] = await this.db
      .select({ total: cut })
      .from(payments)
      .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
      .where(and(...conditions));

    const [settled] = await this.db
      .select({ total: cut })
      .from(payments)
      .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
      .where(and(...conditions, isNotNull(invoices.settledAt)));

    return {
      creditedUsdMicros: BigInt(credited?.total ?? '0'),
      settledUsdMicros: BigInt(settled?.total ?? '0'),
    };
  }

  /**
   * The whole book: what every account pays, and what each has paid us.
   *
   * The company owner's view, and the reason it is one query rather than a loop over
   * accounts: "who are our biggest accounts and what are they on" is a single question,
   * and answering it per-account would make the panel slower the more customers we have.
   *
   * Accounts with no live volume are included with zeros rather than omitted. A merchant
   * who signed up and never traded is a fact about the business, and an owner scanning
   * this list is as likely to be looking for those as for the busy ones.
   */
  async book(now: Date = new Date()): Promise<{
    readonly creditedUsdMicros: string;
    readonly settledUsdMicros: string;
    readonly accounts: readonly {
      readonly organizationId: string;
      readonly feeBps: number;
      readonly negotiated: boolean;
      readonly feePayer: FeePayer;
      readonly volumeUsdMicros: string;
      readonly commissionUsdMicros: string;
      readonly periodEnd: string | null;
    }[];
  }> {
    const plans = await this.db.select().from(feePlans);

    const accounts = [];
    let credited = 0n;
    let settled = 0n;

    for (const plan of plans) {
      const periodStart = plan.currentPeriodStart ?? plan.createdAt;
      const volume = await this.assessedVolume(plan.organizationId, {
        from: periodStart,
        to: now,
      });
      // Lifetime, not this period: what an account has been worth is the figure an owner
      // is comparing accounts on, and a period-to-date number would rank whoever
      // happened to have a busy week.
      const earned = await this.commissionEarned({ organizationId: plan.organizationId });
      credited += earned.creditedUsdMicros;
      settled += earned.settledUsdMicros;

      accounts.push({
        organizationId: plan.organizationId,
        feeBps: plan.feeBps,
        negotiated: plan.negotiatedFee,
        feePayer: plan.feePayer,
        volumeUsdMicros: volume.totalUsdMicros.toString(),
        commissionUsdMicros: earned.creditedUsdMicros.toString(),
        periodEnd: plan.currentPeriodEnd?.toISOString() ?? null,
      });
    }

    // Biggest earner first: an owner opens this to see the top of the list.
    accounts.sort((left, right) =>
      BigInt(right.commissionUsdMicros) > BigInt(left.commissionUsdMicros) ? 1 : -1,
    );

    return {
      creditedUsdMicros: credited.toString(),
      settledUsdMicros: settled.toString(),
      accounts,
    };
  }

  /**
   * Give a merchant a fee plan, at the entry rate.
   *
   * Idempotent, because signup can be retried and two plans for one merchant would mean
   * two answers to "what do they pay". The unique index enforces it; this returns the
   * existing row rather than surfacing a constraint error to a signup form.
   */
  async ensureForOrganization(organizationId: string, now: Date = new Date()) {
    const [existing] = await this.db
      .select()
      .from(feePlans)
      .where(eq(feePlans.organizationId, organizationId))
      .limit(1);
    if (existing) return existing;

    const [created] = await this.db
      .insert(feePlans)
      .values({
        organizationId,
        currentPeriodStart: now,
        currentPeriodEnd: addMonths(now, this.periodMonths),
      })
      .returning();

    return created!;
  }

  /** The rate, the ladder, and this period's volume — for the merchant's own page. */
  async forOrganization(organizationId: string) {
    const [plan] = await this.db
      .select()
      .from(feePlans)
      .where(eq(feePlans.organizationId, organizationId))
      .limit(1);
    if (!plan) throw new FeePlanError('not_found', 'No fee plan for this merchant.');

    const periodStart = plan.currentPeriodStart ?? plan.createdAt;
    const volume = await this.assessedVolume(organizationId, { from: periodStart, to: new Date() });

    return {
      plan,
      /**
       * The rate, alongside the next rung and what it would take to reach it.
       *
       * Showing the next rung is the difference between a ladder a merchant can plan
       * against and a discount they discover after the fact.
       */
      commission: {
        feeBps: plan.feeBps,
        perThousandUsd: FeePlanService.feeExample(plan.feeBps),
        negotiated: plan.negotiatedFee,
        /**
         * Who their invoices charge it to, by default.
         *
         * Alongside the rate rather than buried in settings, because the two together are
         * the answer to "what does this cost me" — a merchant passing the fee on pays
         * nothing at all, and one absorbing it pays the full 0.5%.
         */
        feePayer: plan.feePayer,
        nextTier: nextTierFrom(plan.feeBps, plan.negotiatedFee),
      },
      /**
       * The whole ladder, entry rung first.
       *
       * Returned rather than left to the dashboard to hardcode. A published ladder that
       * each surface writes its own copy of is a ladder that will eventually disagree
       * with the rate actually charged, and the merchant is the one who finds out.
       */
      ladder: [...FEE_TIERS]
        .reverse()
        .map((tier) => ({ bps: tier.bps, fromUsdMicros: tier.fromUsdMicros.toString() })),
      /**
       * Volume so far in the period being measured.
       *
       * `wouldEarnBps` is explicitly about the volume so far. Volume only goes up within
       * a period, so a rate named here can only improve before the period closes — which
       * is why it is safe to show, and why it is named as a projection rather than as the
       * rate they are paying.
       */
      period: {
        start: periodStart,
        end: plan.currentPeriodEnd,
        processedUsdMicros: volume.totalUsdMicros.toString(),
        verifiedUsdMicros: volume.verifiedUsdMicros.toString(),
        declaredUsdMicros: volume.declaredUsdMicros.toString(),
        unpricedPayments: volume.unpricedPayments,
        wouldEarnBps: feeBpsForVolume(volume.totalUsdMicros),
      },
    };
  }

  /**
   * Close every period that has ended, move merchants to the tier their volume earned,
   * and open the next period.
   *
   * Run on a schedule, and safe to run twice: a plan whose period end is in the future
   * is not selected, so a second run in the same hour does nothing.
   *
   * Two properties are deliberate. It assesses only *closed* periods — a job run on day
   * two of a month would otherwise see almost no volume and push every merchant back to
   * the entry rate, raising the price of everyone it touched. And it applies in both
   * directions, because a rate earned by one busy month is not a rate the merchant keeps
   * forever; volume-based pricing that only ever ratchets down is a discount schedule
   * with a leak in it.
   *
   * A negotiated rate is left alone. Someone set it deliberately, and having the ladder
   * overwrite it the following month would make every negotiation temporary without
   * telling anyone.
   */
  async closePeriods(now: Date = new Date()): Promise<{
    readonly closed: number;
    readonly moved: number;
    readonly changes: readonly {
      readonly organizationId: string;
      readonly fromBps: number;
      readonly toBps: number;
      readonly volumeUsdMicros: string;
    }[];
  }> {
    const ending = await this.db
      .select()
      .from(feePlans)
      .where(lte(feePlans.currentPeriodEnd, now));

    const changes: {
      organizationId: string;
      fromBps: number;
      toBps: number;
      volumeUsdMicros: string;
    }[] = [];

    for (const plan of ending) {
      const closingEnd = plan.currentPeriodEnd ?? now;
      const closingStart = plan.currentPeriodStart ?? addMonths(closingEnd, -this.periodMonths);

      const volume = await this.assessedVolume(plan.organizationId, {
        from: closingStart,
        to: closingEnd,
      });
      const earned = plan.negotiatedFee ? plan.feeBps : feeBpsForVolume(volume.totalUsdMicros);

      await this.db
        .update(feePlans)
        .set({
          feeBps: earned,
          currentPeriodStart: closingEnd,
          currentPeriodEnd: addMonths(closingEnd, this.periodMonths),
        })
        .where(eq(feePlans.id, plan.id));

      if (earned === plan.feeBps) continue;

      await this.audit.record({
        organizationId: plan.organizationId,
        action: 'fee_plan.tier_changed',
        targetType: 'fee_plan',
        targetId: plan.id,
        metadata: {
          fromBps: plan.feeBps,
          toBps: earned,
          volumeUsdMicros: volume.totalUsdMicros.toString(),
          verifiedUsdMicros: volume.verifiedUsdMicros.toString(),
          declaredUsdMicros: volume.declaredUsdMicros.toString(),
          periodStart: closingStart.toISOString(),
          periodEnd: closingEnd.toISOString(),
          reason: 'volume tier',
        },
      });
      changes.push({
        organizationId: plan.organizationId,
        fromBps: plan.feeBps,
        toBps: earned,
        volumeUsdMicros: volume.totalUsdMicros.toString(),
      });

      /**
       * Recorded when a rung was bought mostly with rates the merchant set themselves.
       *
       * Only on a reduction: a merchant whose declared volume pushed them *up* a rung
       * has no incentive to have lied about it, and flagging that would bury the case
       * that matters under the case that does not.
       */
      if (
        earned < plan.feeBps &&
        volume.declaredUsdMicros > volume.verifiedUsdMicros
      ) {
        await this.audit.record({
          organizationId: plan.organizationId,
          action: 'fee_plan.tier_needs_review',
          targetType: 'fee_plan',
          targetId: plan.id,
          metadata: {
            verifiedUsdMicros: volume.verifiedUsdMicros.toString(),
            declaredUsdMicros: volume.declaredUsdMicros.toString(),
            unpricedPayments: volume.unpricedPayments,
            toBps: earned,
            reason:
              'the cheaper tier rests mostly on merchant-declared rates, which we ' +
              'cannot verify',
          },
        });
      }
    }

    return { closed: ending.length, moved: changes.length, changes };
  }
}

/**
 * The rung below a merchant's current rate, and the volume that reaches it.
 *
 * Null at the bottom rung, and null for a negotiated rate — the ladder does not apply to
 * those, so naming a threshold would promise a reduction that will not arrive.
 */
function nextTierFrom(
  feeBps: number,
  negotiated: boolean,
): { readonly bps: number; readonly fromUsdMicros: string } | null {
  if (negotiated) return null;

  // Tiers are declared cheapest-first, so the next one down is the last entry with a
  // lower rate than the current one.
  const better = FEE_TIERS.filter((tier) => tier.bps < feeBps);
  const next = better.at(-1);
  return next ? { bps: next.bps, fromUsdMicros: next.fromUsdMicros.toString() } : null;
}

/**
 * Add whole months, clamping the day of month.
 *
 * A plan whose period starts on the 31st must not skip February. `setMonth` would roll
 * over into March, giving that merchant an eleven-month year.
 */
function addMonths(from: Date, months: number): Date {
  const out = new Date(from.getTime());
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + months);

  const lastDay = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, lastDay));
  return out;
}

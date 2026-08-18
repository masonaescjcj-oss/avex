import { and, asc, count, desc, eq, gte, isNull, lt, lte, sql } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { invoices, organizations, payments, subscriptionCharges, subscriptions } from '../db/schema.js';
import type { AuditService } from './audit.js';
import type { StaffRole } from './staff-rbac.js';

/**
 * Platform billing: what a merchant pays AVEX to use the gateway.
 *
 * The shape of the product decision this encodes is worth stating, because the code
 * only makes sense alongside it. A merchant pays a flat monthly fee. Falling behind on
 * that fee does not stop their checkout the same hour — it starts a grace window, and
 * only when that expires are *new* invoices refused. Invoices already issued keep
 * working to the end, and money already received is still settled to the merchant.
 *
 * That last part is not generosity. A payer who has already sent funds is not party to
 * our billing dispute, and withholding a settlement to pressure a merchant would make
 * us the reason a stranger lost money. Every other lever — new invoices, the API, the
 * dashboard's write surface — is fair game; that one is not.
 */

/** $49.00 a month, in micro-dollars. */
export const DEFAULT_MONTHLY_PRICE_USD_MICROS = 49_000_000n;

/** A new merchant gets two weeks before the first charge. */
export const DEFAULT_TRIAL_DAYS = 14;

/**
 * Volume below which a period costs nothing: $1,500 in micro-dollars.
 *
 * The reason this exists is arithmetic. A flat $49 is 2.5% of a $2,000 month and 0.1% of
 * a $50,000 one, so a pure subscription charges the smallest merchants the most — the
 * opposite of what a gateway trying to grow wants. Making small volume free removes the
 * barrier for someone testing the product and only starts charging once the merchant is
 * plainly making money from it.
 */
export const DEFAULT_FREE_TIER_USD_MICROS = 1_500_000_000n;

/**
 * How long a late payment is tolerated before new invoices stop.
 *
 * Seven days rather than one, because the failure mode being defended against is a
 * merchant on holiday, not a merchant refusing to pay — and the cost of a week's grace
 * is one month's fee, while the cost of cutting a working checkout off too early is
 * their trust and their customers' failed payments.
 */
export const DEFAULT_GRACE_DAYS = 7;

/**
 * The percentage commission, in basis points, by monthly volume.
 *
 * These are the market's numbers, not ours. Cryptomus and Heleket both advertise
 * "from 0.4%", NOWPayments charges 0.5% on a same-coin settlement, and the
 * card-shaped processors sit at 1% or above — CoinGate and Coinbase Commerce at 1%,
 * BitPay at 1-2% plus $0.25, Stripe's USDC at 1.5% plus $0.30. A crypto-native
 * gateway that charged more than 0.5% would be choosing to lose on price.
 *
 * So the entry rate is 0.5% and volume earns its way down to 0.4%, which is where
 * the competitive floor is. Tiers are read from the volume a merchant actually
 * processed rather than negotiated one merchant at a time, because a published
 * ladder is something a merchant can plan against and a private rate is not.
 *
 * One thing worth saying plainly about the 0.4% figures: they are entry teasers.
 * Cryptomus starts new merchants at 2% and comes down with turnover. Ours applies
 * from the first invoice.
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
 * negotiated rate that exceeded it would produce invoices that take a payment and
 * then cannot be swept.
 */
export const MAX_FEE_BPS = 500;

/** The tier a given monthly volume falls into. */
export function feeBpsForVolume(usdMicros: bigint): number {
  for (const tier of FEE_TIERS) {
    if (usdMicros >= tier.fromUsdMicros) return tier.bps;
  }
  // Unreachable while the last tier starts at zero, and a cheap guard against
  // someone reordering the table and silently dropping the floor.
  return DEFAULT_FEE_BPS;
}

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'unpaid' | 'cancelled';

export class SubscriptionError extends Error {
  constructor(
    readonly code: 'not_found' | 'already_paid' | 'already_exists' | 'no_charge_due',
    message: string,
  ) {
    super(message);
    this.name = 'SubscriptionError';
  }
}

export interface SubscriptionOptions {
  readonly monthlyPriceUsdMicros?: bigint;
  readonly trialDays?: number;
  readonly graceDays?: number;
  readonly freeTierUsdMicros?: bigint;
  /**
   * Where commission is sent, per chain.
   *
   * Per chain because an address is chain-shaped: our BSC collector is not a valid
   * TRON address. A chain absent from this map cannot charge commission at all —
   * `feeFor` returns nothing rather than guessing, because a fee to a malformed
   * address is a fee that burns the merchant's money.
   */
  readonly feeCollectors?: Readonly<Record<string, string>>;
}

/** What the gateway needs to know before letting a merchant issue an invoice. */
export interface BillingVerdict {
  readonly mayIssueInvoices: boolean;
  readonly status: SubscriptionStatus;
  /** Present when refused, phrased for the merchant rather than for a log. */
  readonly reason: string | null;
  readonly currentPeriodEnd: Date | null;
  readonly graceEndsAt: Date | null;
  readonly amountDueUsdMicros: string;
}

export class SubscriptionService {
  private readonly price: bigint;
  private readonly trialDays: number;
  private readonly graceDays: number;
  private readonly freeTier: bigint;
  private readonly feeCollectors: Readonly<Record<string, string>>;

  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    options: SubscriptionOptions = {},
  ) {
    this.price = options.monthlyPriceUsdMicros ?? DEFAULT_MONTHLY_PRICE_USD_MICROS;
    this.trialDays = options.trialDays ?? DEFAULT_TRIAL_DAYS;
    this.graceDays = options.graceDays ?? DEFAULT_GRACE_DAYS;
    this.freeTier = options.freeTierUsdMicros ?? DEFAULT_FREE_TIER_USD_MICROS;
    this.feeCollectors = options.feeCollectors ?? {};
  }

  /**
   * The commission a new invoice for this merchant should carry, on this chain.
   *
   * Returns nothing — meaning no fee — in three cases, and each is deliberate. The
   * merchant's rate is zero, because someone negotiated that. We have no collector
   * address for the chain, because sending a fee to an address we cannot form would
   * burn it. Or there is no subscription row at all, which is a gap in our own
   * bookkeeping and must not become a charge the merchant did not agree to.
   *
   * Read at invoice creation and then snapshotted onto the invoice. It must not be
   * consulted again at settlement: the deposit address commits to the fee, so a rate
   * that changed in between would derive an address nobody funded.
   */
  async feeFor(
    organizationId: string,
    chain: string,
  ): Promise<{ readonly feeDestination: string; readonly feeBps: number } | undefined> {
    const [subscription] = await this.db
      .select({ feeBps: subscriptions.feeBps })
      .from(subscriptions)
      .where(eq(subscriptions.organizationId, organizationId))
      .limit(1);
    if (!subscription || subscription.feeBps === 0) return undefined;

    const feeDestination = this.feeCollectors[chain];
    if (!feeDestination) return undefined;

    // Clamped rather than trusted. The column has a check constraint, but this is the
    // value that reaches a constructor argument, and the forwarder reverts above the
    // ceiling — a revert here would mean a funded address we cannot deploy.
    return { feeDestination, feeBps: Math.min(subscription.feeBps, MAX_FEE_BPS) };
  }

  /**
   * Move merchants onto the tier their volume earns.
   *
   * Run alongside billing, on the period that just closed. Volume-based pricing that
   * a merchant has to ask for is a discount in name only, so the ladder applies
   * itself — and it applies in both directions, because a rate earned by one busy
   * month is not a rate the merchant keeps forever.
   *
   * A negotiated rate is left alone. Someone set it deliberately, and having the
   * ladder overwrite it the following month would make every negotiation temporary
   * without telling anyone.
   */
  async applyVolumeTiers(now: Date = new Date()): Promise<{
    readonly moved: number;
    readonly changes: readonly {
      readonly organizationId: string;
      readonly fromBps: number;
      readonly toBps: number;
    }[];
  }> {
    const rows = await this.db
      .select({
        id: subscriptions.id,
        organizationId: subscriptions.organizationId,
        feeBps: subscriptions.feeBps,
        negotiatedFee: subscriptions.negotiatedFee,
        periodStart: subscriptions.currentPeriodStart,
      })
      .from(subscriptions)
      .where(isNull(subscriptions.cancelledAt));

    const changes: { organizationId: string; fromBps: number; toBps: number }[] = [];

    for (const row of rows) {
      if (row.negotiatedFee) continue;

      const volume = await this.assessedVolume(row.organizationId, {
        from: row.periodStart ?? addDays(now, -31),
        to: now,
      });
      const earned = feeBpsForVolume(volume.totalUsdMicros);
      if (earned === row.feeBps) continue;

      await this.db
        .update(subscriptions)
        .set({ feeBps: earned })
        .where(eq(subscriptions.id, row.id));

      await this.audit.record({
        organizationId: row.organizationId,
        action: 'subscription.fee_tier_changed',
        targetType: 'subscription',
        targetId: row.id,
        metadata: {
          fromBps: row.feeBps,
          toBps: earned,
          volumeUsdMicros: volume.totalUsdMicros.toString(),
          reason: 'volume tier',
        },
      });
      changes.push({ organizationId: row.organizationId, fromBps: row.feeBps, toBps: earned });
    }

    return { moved: changes.length, changes };
  }

  /**
   * Set a rate by hand, outside the ladder.
   *
   * Marks the subscription as negotiated, which is what stops `applyVolumeTiers` from
   * quietly undoing it next month. Refused above the on-chain ceiling here as well as
   * in the database, so the caller gets an error naming the fee rather than a
   * constraint violation.
   */
  async setFeeBps(
    actor: { readonly staffId: string; readonly role: StaffRole },
    organizationId: string,
    feeBps: number,
    note: string,
  ): Promise<void> {
    if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_FEE_BPS) {
      throw new SubscriptionError(
        'not_found',
        `A fee of ${feeBps}bps is outside the 0-${MAX_FEE_BPS}bps the forwarder can deliver.`,
      );
    }

    const [updated] = await this.db
      .update(subscriptions)
      .set({ feeBps, negotiatedFee: true })
      .where(eq(subscriptions.organizationId, organizationId))
      .returning({ id: subscriptions.id, previous: subscriptions.feeBps });
    if (!updated) throw new SubscriptionError('not_found', 'No subscription for this merchant.');

    await this.audit.record({
      organizationId,
      staffId: actor.staffId,
      action: 'subscription.fee_negotiated',
      targetType: 'subscription',
      targetId: updated.id,
      // The note is required by the route, and it is the only record of *why* this
      // merchant pays a different rate from the published ladder.
      metadata: { feeBps, note, role: actor.role },
    });
  }

  /**
   * What a merchant would pay per $1,000 at their current rate.
   *
   * Shown rather than left as basis points. "50 bps" is the unit the ladder is
   * written in; "$5.00 per $1,000" is the unit a merchant thinks in, and the two
   * being the same number expressed differently is exactly why one of them should be
   * computed for them rather than by them.
   */
  static feeExample(feeBps: number, perUsd = 1_000): number {
    return (perUsd * feeBps) / 10_000;
  }

  /**
   * What a merchant processed in a window, split by how trustworthy the figure is.
   *
   * The split is the point. `verified` comes from rates we set — the quote locked on the
   * invoice, or our own oracle. `declared` comes from a `fixed_rate` a merchant chose
   * for a token nobody else prices, which they have an obvious incentive to understate
   * when a threshold is involved. `unknown` is volume we could not price at all.
   *
   * Both verified and declared count towards the free tier, because refusing to count a
   * merchant's own token would penalise a legitimate use. But declared volume is
   * returned separately so that a merchant sitting just under the threshold entirely on
   * self-declared rates is visible to an operator rather than invisible. Prevention
   * where it is cheap; detection where it is not.
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
          // Reversed payments are not volume. A reorg that took a payment back must not
          // keep a merchant above the threshold for a month that did not happen.
          isNull(payments.reversedAt),
          gte(payments.creditedAt, window.from),
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
   * Start a subscription for a new merchant, in trial.
   *
   * Idempotent, because signup can be retried and two subscriptions for one merchant
   * would mean two answers to "may they trade". The unique index enforces it; this
   * returns the existing row rather than surfacing a constraint error to a signup form.
   */
  async ensureForOrganization(organizationId: string, now: Date = new Date()) {
    const [existing] = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.organizationId, organizationId))
      .limit(1);
    if (existing) return existing;

    const trialEndsAt = addDays(now, this.trialDays);
    const [created] = await this.db
      .insert(subscriptions)
      .values({
        organizationId,
        status: 'trialing',
        priceUsdMicros: this.price.toString(),
        trialEndsAt,
        // The trial *is* the first period, so the first charge falls due when it ends
        // rather than immediately — otherwise "14 days free" bills on day one.
        currentPeriodStart: now,
        currentPeriodEnd: trialEndsAt,
      })
      .returning();

    return created!;
  }

  /** The subscription and its charges, for the merchant's own billing page. */
  async forOrganization(organizationId: string) {
    const [subscription] = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.organizationId, organizationId))
      .limit(1);
    if (!subscription) throw new SubscriptionError('not_found', 'No subscription for this merchant.');

    const charges = await this.db
      .select()
      .from(subscriptionCharges)
      .where(eq(subscriptionCharges.organizationId, organizationId))
      .orderBy(desc(subscriptionCharges.periodStart))
      .limit(24);

    /**
     * Where they stand against the free threshold, for the period in progress.
     *
     * Shown rather than left to be discovered at billing time. A merchant who is going
     * to be charged $49 this month should be able to see it coming while the month is
     * still running — and one who is comfortably free should not have to wonder.
     *
     * `willBeFree` is explicitly about the volume so far. Volume only goes up within a
     * period, so a `true` here can become `false` later; the naming says "on today's
     * figures", not "guaranteed".
     */
    const periodStart = subscription.currentPeriodStart ?? subscription.createdAt;
    const volume = await this.assessedVolume(organizationId, {
      from: periodStart,
      to: new Date(),
    });

    return {
      subscription,
      charges,
      verdict: verdictFor(subscription, charges),
      /**
       * The commission, alongside the next tier and what it would take to reach it.
       *
       * Showing the next rung is the difference between a ladder a merchant can plan
       * against and a discount they discover after the fact.
       */
      commission: {
        feeBps: subscription.feeBps,
        perThousandUsd: SubscriptionService.feeExample(subscription.feeBps),
        negotiated: subscription.negotiatedFee,
        nextTier: nextTierFrom(subscription.feeBps, subscription.negotiatedFee),
      },
      freeTier: {
        thresholdUsdMicros: this.freeTier.toString(),
        processedUsdMicros: volume.totalUsdMicros.toString(),
        verifiedUsdMicros: volume.verifiedUsdMicros.toString(),
        declaredUsdMicros: volume.declaredUsdMicros.toString(),
        unpricedPayments: volume.unpricedPayments,
        remainingUsdMicros: (
          volume.totalUsdMicros >= this.freeTier ? 0n : this.freeTier - volume.totalUsdMicros
        ).toString(),
        willBeFree: volume.totalUsdMicros < this.freeTier,
        periodStart,
      },
    };
  }

  /**
   * Whether this merchant may issue new invoices right now.
   *
   * Read on the invoice-creation path, and nowhere else. A merchant behind on payment
   * must still be able to sign in, read their invoices, and pay us — locking them out
   * of the dashboard would remove the only route back to being current.
   */
  async billingVerdict(organizationId: string, now: Date = new Date()): Promise<BillingVerdict> {
    const [subscription] = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.organizationId, organizationId))
      .limit(1);

    if (!subscription) {
      /**
       * No subscription row at all.
       *
       * This is a merchant created before billing existed, or by a path that forgot to
       * call `ensureForOrganization`. Allowed rather than refused: the correct response
       * to our own bookkeeping gap is not to stop someone's checkout.
       */
      return {
        mayIssueInvoices: true,
        status: 'active',
        reason: null,
        currentPeriodEnd: null,
        graceEndsAt: null,
        amountDueUsdMicros: '0',
      };
    }

    const due = await this.db
      .select()
      .from(subscriptionCharges)
      .where(
        and(
          eq(subscriptionCharges.subscriptionId, subscription.id),
          eq(subscriptionCharges.status, 'due'),
        ),
      );

    return verdictFor(subscription, due, now);
  }

  /**
   * Advance every subscription whose period has ended, creating the charge for the
   * period that just began.
   *
   * Run on a schedule. Safe to run twice: the unique index on
   * `(subscriptionId, periodStart)` means a retried run cannot double-charge, which is
   * the property that lets this be a plain interval job rather than a locked one.
   */
  async runBilling(now: Date = new Date()): Promise<{
    readonly charged: number;
    readonly freed: number;
    readonly markedPastDue: number;
    readonly markedUnpaid: number;
  }> {
    let charged = 0;
    let freed = 0;
    let markedPastDue = 0;
    let markedUnpaid = 0;

    const ending = await this.db
      .select()
      .from(subscriptions)
      .where(
        and(
          isNull(subscriptions.cancelledAt),
          lte(subscriptions.currentPeriodEnd, now),
        ),
      )
      .orderBy(asc(subscriptions.currentPeriodEnd));

    for (const subscription of ending) {
      const periodStart = subscription.currentPeriodEnd ?? now;
      const periodEnd = addMonths(periodStart, subscription.intervalMonths);

      if (subscription.cancelAtPeriodEnd) {
        await this.db
          .update(subscriptions)
          .set({ status: 'cancelled', cancelledAt: now, graceEndsAt: null })
          .where(eq(subscriptions.id, subscription.id));
        continue;
      }

      /**
       * Assess the period that just ended, not a trailing window.
       *
       * "You processed under the threshold during the month you are being billed for"
       * is a statement a merchant can check against their own records. A rolling
       * 30-day window at the moment the job happens to run is not.
       */
      const volume = await this.assessedVolume(subscription.organizationId, {
        from: subscription.currentPeriodStart ?? addDays(periodStart, -31),
        to: periodStart,
      });
      const free = volume.totalUsdMicros < this.freeTier;

      const inserted = await this.db
        .insert(subscriptionCharges)
        .values({
          subscriptionId: subscription.id,
          organizationId: subscription.organizationId,
          periodStart,
          periodEnd,
          // A zero-amount row rather than no row at all. "Why was this merchant not
          // billed in March" has an answer either way, and a missing period cannot
          // give one.
          amountUsdMicros: free ? '0' : subscription.priceUsdMicros,
          status: free ? 'free_tier' : 'due',
          paidAt: free ? now : null,
          note: free
            ? `free tier: $${(Number(volume.totalUsdMicros) / 1e6).toFixed(2)} processed ` +
              `(verified $${(Number(volume.verifiedUsdMicros) / 1e6).toFixed(2)}, ` +
              `declared $${(Number(volume.declaredUsdMicros) / 1e6).toFixed(2)})`
            : null,
        })
        .onConflictDoNothing({
          target: [subscriptionCharges.subscriptionId, subscriptionCharges.periodStart],
        })
        .returning({ id: subscriptionCharges.id });

      if (inserted.length > 0 && !free) charged += 1;
      if (inserted.length > 0 && free) freed += 1;

      if (free) {
        // Nothing is owed, so the subscription stays current and no grace starts.
        await this.db
          .update(subscriptions)
          .set({
            status: 'active',
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
            graceEndsAt: null,
          })
          .where(eq(subscriptions.id, subscription.id));

        // Recorded when the free month rested entirely on rates the merchant set
        // themselves, which is the one shape of this that deserves a second look.
        if (
          volume.declaredUsdMicros > 0n &&
          volume.verifiedUsdMicros < this.freeTier / 2n &&
          volume.declaredUsdMicros >= this.freeTier / 2n
        ) {
          await this.audit.record({
            organizationId: subscription.organizationId,
            action: 'subscription.free_tier_needs_review',
            targetType: 'subscription',
            targetId: subscription.id,
            metadata: {
              verifiedUsdMicros: volume.verifiedUsdMicros.toString(),
              declaredUsdMicros: volume.declaredUsdMicros.toString(),
              unpricedPayments: volume.unpricedPayments,
              reason:
                'free-tier eligibility rests mostly on merchant-declared rates, which we ' +
                'cannot verify',
            },
          });
        }
        continue;
      }

      // A charge exists and is unpaid, so the merchant is late from this moment. The
      // grace window starts now rather than at the previous period's end, so a
      // late-running billing job never shortens someone's grace.
      await this.db
        .update(subscriptions)
        .set({
          status: 'past_due',
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          graceEndsAt: addDays(now, this.graceDays),
        })
        .where(eq(subscriptions.id, subscription.id));
      markedPastDue += 1;
    }

    // Separately, anyone whose grace has now expired stops being able to issue.
    const expired = await this.db
      .update(subscriptions)
      .set({ status: 'unpaid' })
      .where(
        and(
          eq(subscriptions.status, 'past_due'),
          lte(subscriptions.graceEndsAt, now),
        ),
      )
      .returning({ id: subscriptions.id });
    markedUnpaid = expired.length;

    return { charged, freed, markedPastDue, markedUnpaid };
  }

  /**
   * Record a charge as paid, and bring the subscription current.
   *
   * `invoiceId` is the gateway invoice it was paid through — AVEX charging itself over
   * its own rails, so a break in the payment path shows up in our billing before a
   * merchant reports it. `externalReference` covers the cases that did not go through
   * the gateway at all.
   */
  async markChargePaid(
    chargeId: string,
    settlement: { readonly invoiceId?: string | null; readonly externalReference?: string | null },
    now: Date = new Date(),
  ): Promise<void> {
    const [charge] = await this.db
      .select()
      .from(subscriptionCharges)
      .where(eq(subscriptionCharges.id, chargeId))
      .limit(1);
    if (!charge) throw new SubscriptionError('not_found', 'No such charge.');
    if (charge.status !== 'due') {
      throw new SubscriptionError('already_paid', `That charge is already ${charge.status}.`);
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(subscriptionCharges)
        .set({
          status: 'paid',
          paidAt: now,
          invoiceId: settlement.invoiceId ?? null,
          externalReference: settlement.externalReference ?? null,
        })
        .where(eq(subscriptionCharges.id, chargeId));

      // Only clear the past-due state when nothing else is outstanding: a merchant who
      // pays one of three late months is still late.
      const [remaining] = await tx
        .select({ value: count() })
        .from(subscriptionCharges)
        .where(
          and(
            eq(subscriptionCharges.subscriptionId, charge.subscriptionId),
            eq(subscriptionCharges.status, 'due'),
          ),
        );

      if ((remaining?.value ?? 0) === 0) {
        await tx
          .update(subscriptions)
          .set({ status: 'active', graceEndsAt: null })
          .where(eq(subscriptions.id, charge.subscriptionId));
      }
    });

    await this.audit.record({
      organizationId: charge.organizationId,
      action: 'subscription.charge_paid',
      targetType: 'subscription_charge',
      targetId: chargeId,
      metadata: {
        amountUsdMicros: charge.amountUsdMicros,
        invoiceId: settlement.invoiceId ?? null,
        externalReference: settlement.externalReference ?? null,
      },
    });
  }

  /** Write off a charge. Staff only, and the reason is required, not optional. */
  async waiveCharge(
    actor: { readonly staffId: string; readonly role: StaffRole },
    chargeId: string,
    note: string,
    now: Date = new Date(),
  ): Promise<void> {
    const [charge] = await this.db
      .select()
      .from(subscriptionCharges)
      .where(eq(subscriptionCharges.id, chargeId))
      .limit(1);
    if (!charge) throw new SubscriptionError('not_found', 'No such charge.');
    if (charge.status !== 'due') {
      throw new SubscriptionError('already_paid', `That charge is already ${charge.status}.`);
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(subscriptionCharges)
        .set({ status: 'waived', waivedByStaffId: actor.staffId, note, paidAt: now })
        .where(eq(subscriptionCharges.id, chargeId));

      const [remaining] = await tx
        .select({ value: count() })
        .from(subscriptionCharges)
        .where(
          and(
            eq(subscriptionCharges.subscriptionId, charge.subscriptionId),
            eq(subscriptionCharges.status, 'due'),
          ),
        );
      if ((remaining?.value ?? 0) === 0) {
        await tx
          .update(subscriptions)
          .set({ status: 'active', graceEndsAt: null })
          .where(eq(subscriptions.id, charge.subscriptionId));
      }
    });

    await this.audit.record({
      staffId: actor.staffId,
      organizationId: charge.organizationId,
      action: 'subscription.charge_waived',
      targetType: 'subscription_charge',
      targetId: chargeId,
      metadata: { amountUsdMicros: charge.amountUsdMicros, note, actorRole: actor.role },
    });
  }

  /**
   * Schedule a cancellation for the end of the paid period.
   *
   * Not immediate. The merchant has paid through the period end, and cutting them off
   * the moment they click cancel would be taking a month's fee for nothing.
   */
  async cancelAtPeriodEnd(organizationId: string, userId: string | null): Promise<void> {
    const [subscription] = await this.db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(eq(subscriptions.organizationId, organizationId))
      .limit(1);
    if (!subscription) throw new SubscriptionError('not_found', 'No subscription for this merchant.');

    await this.db
      .update(subscriptions)
      .set({ cancelAtPeriodEnd: true })
      .where(eq(subscriptions.id, subscription.id));

    await this.audit.record({
      organizationId,
      userId,
      action: 'subscription.cancellation_scheduled',
      targetType: 'subscription',
      targetId: subscription.id,
    });
  }

  async resume(organizationId: string, userId: string | null): Promise<void> {
    const [subscription] = await this.db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(eq(subscriptions.organizationId, organizationId))
      .limit(1);
    if (!subscription) throw new SubscriptionError('not_found', 'No subscription for this merchant.');

    await this.db
      .update(subscriptions)
      .set({ cancelAtPeriodEnd: false })
      .where(eq(subscriptions.id, subscription.id));

    await this.audit.record({
      organizationId,
      userId,
      action: 'subscription.cancellation_withdrawn',
      targetType: 'subscription',
      targetId: subscription.id,
    });
  }

  /** Set a negotiated price. Staff only; applies from the next period, not this one. */
  async setPrice(
    actor: { readonly staffId: string; readonly role: StaffRole },
    organizationId: string,
    priceUsdMicros: bigint,
    note: string,
  ): Promise<void> {
    const [subscription] = await this.db
      .select({ id: subscriptions.id, previous: subscriptions.priceUsdMicros })
      .from(subscriptions)
      .where(eq(subscriptions.organizationId, organizationId))
      .limit(1);
    if (!subscription) throw new SubscriptionError('not_found', 'No subscription for this merchant.');

    await this.db
      .update(subscriptions)
      .set({ priceUsdMicros: priceUsdMicros.toString() })
      .where(eq(subscriptions.id, subscription.id));

    await this.audit.record({
      staffId: actor.staffId,
      organizationId,
      action: 'subscription.price_changed',
      targetType: 'subscription',
      targetId: subscription.id,
      // Charges already created keep the price they were created with, so this only
      // affects future periods — recorded so that is provable later.
      metadata: {
        from: subscription.previous,
        to: priceUsdMicros.toString(),
        note,
        actorRole: actor.role,
      },
    });
  }

  /** Merchants who owe money, for the admin panel's billing view. */
  async outstanding(limit = 100) {
    return this.db
      .select({
        organizationId: subscriptions.organizationId,
        organizationName: organizations.name,
        status: subscriptions.status,
        graceEndsAt: subscriptions.graceEndsAt,
        dueCharges: sql<number>`(
          select count(*)::int from ${subscriptionCharges} sc
          where sc.subscription_id = ${subscriptions}."id" and sc.status = 'due'
        )`,
        owedUsdMicros: sql<string>`coalesce((
          select sum(sc.amount_usd_micros) from ${subscriptionCharges} sc
          where sc.subscription_id = ${subscriptions}."id" and sc.status = 'due'
        ), 0)::text`,
      })
      .from(subscriptions)
      .innerJoin(organizations, eq(organizations.id, subscriptions.organizationId))
      .where(sql`${subscriptions.status} in ('past_due', 'unpaid')`)
      .orderBy(asc(subscriptions.graceEndsAt))
      .limit(Math.min(200, Math.max(1, limit)));
  }
}

/**
 * The verdict, derived rather than stored.
 *
 * Computing it from the row and its due charges means the answer cannot drift from the
 * facts — a stored boolean would eventually disagree with the charges it was supposed
 * to summarise, and the disagreement would be invisible.
 */
function verdictFor(
  subscription: typeof subscriptions.$inferSelect,
  dueCharges: readonly (typeof subscriptionCharges.$inferSelect)[],
  now: Date = new Date(),
): BillingVerdict {
  const outstanding = dueCharges.filter((charge) => charge.status === 'due');
  const owed = outstanding.reduce((sum, charge) => sum + BigInt(charge.amountUsdMicros), 0n);

  const base = {
    status: subscription.status,
    currentPeriodEnd: subscription.currentPeriodEnd,
    graceEndsAt: subscription.graceEndsAt,
    amountDueUsdMicros: owed.toString(),
  };

  if (subscription.status === 'cancelled') {
    return {
      ...base,
      mayIssueInvoices: false,
      reason:
        'This subscription has ended. Invoices already issued will still complete; ' +
        'restart the subscription to issue new ones.',
    };
  }

  // Grace expired, or the status says so. Either way, no new invoices.
  const graceExpired =
    subscription.graceEndsAt !== null && subscription.graceEndsAt.getTime() <= now.getTime();
  if (subscription.status === 'unpaid' || (subscription.status === 'past_due' && graceExpired)) {
    return {
      ...base,
      status: 'unpaid',
      mayIssueInvoices: false,
      reason:
        'Your subscription payment is overdue, so new invoices are paused. ' +
        'Invoices already issued will still complete and settle to you. ' +
        'Pay the outstanding amount to resume.',
    };
  }

  // Trialing, active, or past due inside grace: the gateway works.
  return { ...base, mayIssueInvoices: true, reason: null };
}

/**
 * The rung below a merchant's current rate, and the volume that reaches it.
 *
 * Null at the bottom rung, and null for a negotiated rate — the ladder does not apply
 * to those, so naming a threshold would promise a reduction that will not arrive.
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

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * Add whole months, clamping the day of month.
 *
 * A subscription started on the 31st must not skip February. `setMonth` would roll
 * over into March, quietly billing that merchant eleven times a year.
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

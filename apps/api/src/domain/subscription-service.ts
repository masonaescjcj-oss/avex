import { and, asc, count, desc, eq, isNull, lte, sql } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { organizations, subscriptionCharges, subscriptions } from '../db/schema.js';
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
 * How long a late payment is tolerated before new invoices stop.
 *
 * Seven days rather than one, because the failure mode being defended against is a
 * merchant on holiday, not a merchant refusing to pay — and the cost of a week's grace
 * is one month's fee, while the cost of cutting a working checkout off too early is
 * their trust and their customers' failed payments.
 */
export const DEFAULT_GRACE_DAYS = 7;

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

  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    options: SubscriptionOptions = {},
  ) {
    this.price = options.monthlyPriceUsdMicros ?? DEFAULT_MONTHLY_PRICE_USD_MICROS;
    this.trialDays = options.trialDays ?? DEFAULT_TRIAL_DAYS;
    this.graceDays = options.graceDays ?? DEFAULT_GRACE_DAYS;
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

    return { subscription, charges, verdict: verdictFor(subscription, charges) };
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
    readonly markedPastDue: number;
    readonly markedUnpaid: number;
  }> {
    let charged = 0;
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

      const inserted = await this.db
        .insert(subscriptionCharges)
        .values({
          subscriptionId: subscription.id,
          organizationId: subscription.organizationId,
          periodStart,
          periodEnd,
          amountUsdMicros: subscription.priceUsdMicros,
        })
        .onConflictDoNothing({
          target: [subscriptionCharges.subscriptionId, subscriptionCharges.periodStart],
        })
        .returning({ id: subscriptionCharges.id });

      if (inserted.length > 0) charged += 1;

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

    return { charged, markedPastDue, markedUnpaid };
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

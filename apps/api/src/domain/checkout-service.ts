import { fiatToTokenAmount, type PriceSymbol } from '@avex/core';
import { and, eq, isNull } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import {
  assets,
  checkoutSessions,
  invoices,
  merchantAssets,
  organizations,
  payoutAddresses,
} from '../db/schema.js';
import type { AuditService } from './audit.js';
import type { DepositAddressDeriver } from './deposit-address.js';
import { InvoiceCreationError, type InvoiceCreationService } from './invoice-creation.js';
import type { RateProvider } from './invoice-creation.js';
import type { SubscriptionService } from './subscription-service.js';

/**
 * The hosted checkout: a payment the merchant asked for, before the payer has chosen
 * how to pay it.
 *
 * The gap this fills is real and was blocking. A merchant knows the fiat amount; only
 * the payer knows which coin they hold. An invoice cannot exist until that is decided,
 * because the amount, the chain and the deposit address all follow from the asset — so
 * a merchant could either create one invoice per currency they might accept, or
 * something has to sit in between. This is that something.
 *
 * Everything on the payer-facing side of this service is reachable without credentials,
 * because a payer has none. That shapes what it may return: the amount, the currencies
 * on offer, and the address once chosen. Never the merchant's payout address, never
 * their other invoices, never anything keyed on an id a stranger could guess at.
 */

export class CheckoutError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'expired'
      | 'already_paid'
      | 'cancelled'
      | 'locked'
      | 'no_assets',
    message: string,
  ) {
    super(message);
    this.name = 'CheckoutError';
  }
}

/** One thing a payer can choose: an asset on a chain, with what it would cost them. */
export interface CheckoutOption {
  readonly assetId: string;
  readonly symbol: string;
  readonly name: string;
  readonly chain: string;
  readonly decimals: number;
  /** What they would send, in the asset's smallest unit, as a decimal string. */
  readonly amount: string;
  /** The rate used, so the figure can be checked rather than taken on trust. */
  readonly rateUsd: string | null;
  /** Null when we could not price it, which is why the option may be unavailable. */
  readonly available: boolean;
  readonly unavailableReason: string | null;
}

const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;

export class CheckoutService {
  constructor(
    private readonly db: Database,
    private readonly invoiceCreation: InvoiceCreationService,
    private readonly subscriptions: SubscriptionService,
    private readonly deriver: DepositAddressDeriver,
    private readonly rates: RateProvider,
    private readonly audit: AuditService,
  ) {}

  // ── merchant side ───────────────────────────────────────────────────────────

  /**
   * Open a session. Idempotent on the merchant's reference, like invoice creation.
   *
   * Two payment links for one order is worse than two invoices: a customer can be
   * shown either, and only one of them will ever be marked paid.
   */
  async create(
    organizationId: string,
    input: {
      readonly amountFiatMicros: bigint;
      readonly reference?: string | undefined;
      readonly description?: string | undefined;
      readonly successUrl?: string | undefined;
      readonly cancelUrl?: string | undefined;
      readonly ttlMs?: number | undefined;
    },
    actor: { readonly userId: string | null; readonly apiKeyId: string | null },
  ): Promise<{ readonly session: typeof checkoutSessions.$inferSelect; readonly created: boolean }> {
    if (input.reference) {
      const existing = await this.findByReference(organizationId, input.reference);
      if (existing) return { session: existing, created: false };
    }

    /**
     * Refused up front if the merchant cannot be paid at all.
     *
     * A session with no payable currency is a link that leads to an empty page, and a
     * payer who followed it has no way to know whose problem that is. Better to fail
     * where the merchant is looking.
     */
    const payable = await this.payableAssets(organizationId);
    if (payable.length === 0) {
      throw new CheckoutError(
        'no_assets',
        'No currency is payable yet. Enable at least one approved asset and add a payout ' +
          'address for its chain.',
      );
    }

    const expiresAt = new Date(Date.now() + (input.ttlMs ?? DEFAULT_SESSION_TTL_MS));
    const [created] = await this.db
      .insert(checkoutSessions)
      .values({
        organizationId,
        reference: input.reference ?? null,
        amountFiatMicros: input.amountFiatMicros.toString(),
        description: input.description ?? null,
        successUrl: input.successUrl ?? null,
        cancelUrl: input.cancelUrl ?? null,
        expiresAt,
      })
      .onConflictDoNothing()
      .returning();

    // A conflict means a concurrent retry won the race; theirs is as good as ours.
    if (!created) {
      const existing = input.reference
        ? await this.findByReference(organizationId, input.reference)
        : null;
      if (existing) return { session: existing, created: false };
      throw new CheckoutError('not_found', 'The checkout could not be created.');
    }

    await this.audit.record({
      organizationId,
      userId: actor.userId,
      apiKeyId: actor.apiKeyId,
      action: 'checkout.created',
      targetType: 'checkout_session',
      targetId: created.id,
      metadata: {
        amountFiatMicros: input.amountFiatMicros.toString(),
        reference: input.reference ?? null,
      },
    });

    return { session: created, created: true };
  }

  /** The merchant's own view, which may name their invoice. */
  async forMerchant(organizationId: string, sessionId: string) {
    const [row] = await this.db
      .select()
      .from(checkoutSessions)
      .where(
        and(eq(checkoutSessions.id, sessionId), eq(checkoutSessions.organizationId, organizationId)),
      )
      .limit(1);
    if (!row) throw new CheckoutError('not_found', 'No such checkout.');
    return row;
  }

  async cancel(organizationId: string, sessionId: string): Promise<void> {
    const session = await this.forMerchant(organizationId, sessionId);
    /**
     * A paid session cannot be cancelled.
     *
     * The money has arrived; withdrawing the session afterwards would leave a payer
     * who paid looking at a cancelled page, and the merchant with funds they believe
     * they refused.
     */
    if (session.status === 'paid') {
      throw new CheckoutError('already_paid', 'This checkout has already been paid.');
    }
    await this.db
      .update(checkoutSessions)
      .set({ status: 'cancelled' })
      .where(eq(checkoutSessions.id, sessionId));
  }

  // ── payer side, no credentials ──────────────────────────────────────────────

  /**
   * What a payer sees when they open the link.
   *
   * Returns the merchant's display name and nothing else about them. Every field here
   * is one a stranger holding the link is allowed to know, which is the test each
   * addition has to pass.
   */
  async publicView(sessionId: string, now: Date = new Date()) {
    const [row] = await this.db
      .select({ session: checkoutSessions, merchantName: organizations.name })
      .from(checkoutSessions)
      .innerJoin(organizations, eq(organizations.id, checkoutSessions.organizationId))
      .where(eq(checkoutSessions.id, sessionId))
      .limit(1);
    if (!row) throw new CheckoutError('not_found', 'No such checkout.');

    const session = await this.settleStatus(row.session, now);
    const invoice = session.invoiceId ? await this.publicInvoice(session.invoiceId) : null;

    return {
      id: session.id,
      merchantName: row.merchantName,
      description: session.description,
      amountFiatMicros: session.amountFiatMicros,
      status: session.status,
      expiresAt: session.expiresAt.toISOString(),
      /** Present once a currency has been chosen. This is what the payer pays to. */
      payment: invoice,
    };
  }

  /**
   * The currencies on offer, with what each would cost the payer.
   *
   * Computed per request rather than stored, because the amount depends on a live rate
   * and a stale list would quote a price we would not honour. An asset we cannot price
   * right now is returned as unavailable rather than omitted — a currency that silently
   * disappears reads as us not supporting it, which would be a lie.
   */
  async options(sessionId: string): Promise<readonly CheckoutOption[]> {
    const [session] = await this.db
      .select()
      .from(checkoutSessions)
      .where(eq(checkoutSessions.id, sessionId))
      .limit(1);
    if (!session) throw new CheckoutError('not_found', 'No such checkout.');

    const payable = await this.payableAssets(session.organizationId);
    const amountFiat = BigInt(session.amountFiatMicros);
    const options: CheckoutOption[] = [];

    for (const entry of payable) {
      const spread = BigInt(entry.spreadBps);
      let rate: bigint | null = null;
      let reason: string | null = null;

      if (entry.pricingMode === 'fixed_rate') {
        if (!entry.fixedRateScaled) {
          reason = 'The merchant has not set a rate for this currency yet.';
        } else if (entry.fixedRateValidUntil && entry.fixedRateValidUntil.getTime() <= Date.now()) {
          reason = "The merchant's rate for this currency has expired.";
        } else {
          // A merchant-set rate takes no spread: it is already the price they chose.
          rate = BigInt(entry.fixedRateScaled);
        }
      } else if (entry.pricingMode === 'token') {
        /**
         * Token pricing has no fiat amount to convert, so it cannot serve a session
         * denominated in dollars. Offered as unavailable with the reason, rather than
         * hidden, so a merchant who misconfigured it can see why.
         */
        reason = 'This currency is priced in token units and cannot serve a fiat checkout.';
      } else {
        try {
          const observed = await this.rates.requireRate(entry.symbol as PriceSymbol);
          rate = (observed.priceScaled * (10_000n - spread)) / 10_000n;
        } catch {
          reason = 'No trustworthy price for this currency right now.';
        }
      }

      options.push({
        assetId: entry.assetId,
        symbol: entry.symbol,
        name: entry.symbol,
        chain: entry.chain,
        decimals: entry.decimals,
        /**
         * Rounded up, so the merchant is never left short of the fiat figure.
         *
         * Reusing `fiatToTokenAmount` rather than open-coding the scaling. The naive
         * version divides the rate down to micro-dollar scale first, which truncates
         * a precise rate before it is used — for a sub-cent token that is real lost
         * precision, and in the direction that overcharges the payer.
         */
        amount:
          rate === null
            ? '0'
            : fiatToTokenAmount(
                amountFiat,
                { priceScaled: rate, observedAt: Date.now() },
                entry.decimals,
              ).toString(),
        rateUsd: rate === null ? null : rate.toString(),
        available: rate !== null,
        unavailableReason: reason,
      });
    }

    // Cheapest to confirm first is not knowable here, so order by symbol for a stable
    // list. The page orders networks by settlement cost, which it does know.
    return options.sort((left, right) => left.symbol.localeCompare(right.symbol));
  }

  /**
   * The payer picked a currency: create the invoice and point the session at it.
   *
   * Re-selecting the same asset returns the same invoice rather than opening another,
   * so a double-tap on a phone does not produce two addresses. Choosing a *different*
   * asset creates a new invoice and repoints the session; the old one is left alone
   * because payment matching is by address, and a payer who had already copied it and
   * sends anyway must still be credited.
   */
  async select(sessionId: string, assetId: string, ip?: string) {
    const [session] = await this.db
      .select()
      .from(checkoutSessions)
      .where(eq(checkoutSessions.id, sessionId))
      .limit(1);
    if (!session) throw new CheckoutError('not_found', 'No such checkout.');

    if (session.status === 'cancelled') {
      throw new CheckoutError('cancelled', 'This checkout was cancelled by the merchant.');
    }
    if (session.status === 'paid') {
      throw new CheckoutError('already_paid', 'This checkout has already been paid.');
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      throw new CheckoutError('expired', 'This checkout has expired. Ask the merchant for a new link.');
    }

    /**
     * Once money is on its way, the currency is fixed.
     *
     * The address a payer sent to belongs to one invoice. Letting them switch after
     * that would show them a different address while a transfer is in flight to the
     * first, which is how a payer ends up believing they paid and the merchant
     * believing they did not.
     */
    if (session.invoiceId) {
      const current = await this.invoiceRow(session.invoiceId);
      if (current && current.assetId === assetId) {
        return { invoice: await this.publicInvoice(current.id), changed: false };
      }
      if (current && BigInt(current.amountPaid) > 0n) {
        throw new CheckoutError(
          'locked',
          'A payment is already on its way for this checkout, so the currency can no ' +
            'longer be changed.',
        );
      }
    }

    /**
     * The invoice carries the session's own id as its reference.
     *
     * That makes invoice creation idempotent per session for free — but only for the
     * first currency chosen. A payer who switches needs a second invoice, so the
     * reference is suffixed with the asset. Two currencies, two references, two
     * invoices, and a retry of either converges.
     */
    const reference = `chk_${session.id}_${assetId}`;
    let created;
    try {
      created = await this.invoiceCreation.create(
        session.organizationId,
        {
          assetId,
          reference,
          amountFiatMicros: BigInt(session.amountFiatMicros),
          // The invoice must not outlive the session it belongs to.
          ttlMs: Math.max(60_000, session.expiresAt.getTime() - Date.now()),
        },
        { userId: null, apiKeyId: null, ...(ip === undefined ? {} : { ip }) },
      );
    } catch (error) {
      /**
       * A creation failure is the merchant's problem, not the payer's, so the payer is
       * told something they can act on — pick another currency — and the real cause is
       * recorded where the merchant will find it.
       *
       * Recording it here is not optional. Creation failed before writing anything, so
       * without this the specific reason exists only in the process that threw it, and
       * "a payer said the currency did not work" would be unanswerable.
       */
      if (error instanceof InvoiceCreationError) {
        await this.audit.record({
          organizationId: session.organizationId,
          action: 'checkout.selection_failed',
          targetType: 'checkout_session',
          targetId: session.id,
          metadata: { assetId, cause: error.code, detail: error.message },
        });
        throw new CheckoutError(
          'no_assets',
          'That currency cannot be used for this payment right now. Please choose another.',
        );
      }
      throw error;
    }

    await this.db
      .update(checkoutSessions)
      .set({
        invoiceId: created.invoice.id,
        status: 'selected',
        selectedAt: session.selectedAt ?? new Date(),
      })
      .where(eq(checkoutSessions.id, sessionId));

    return { invoice: await this.publicInvoice(created.invoice.id), changed: true };
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /**
   * Assets this merchant could actually be paid in.
   *
   * Three conditions, all necessary: the asset is approved, the merchant enabled it,
   * and there is a payout address on its chain. Offering a currency that fails any of
   * them would take a payment we could not deliver.
   */
  private async payableAssets(organizationId: string) {
    const rows = await this.db
      .select({
        assetId: assets.id,
        symbol: assets.symbol,
        chain: assets.chain,
        decimals: assets.decimals,
        pricingMode: merchantAssets.pricingMode,
        spreadBps: merchantAssets.spreadBps,
        fixedRateScaled: merchantAssets.fixedRateScaled,
        fixedRateValidUntil: merchantAssets.fixedRateValidUntil,
      })
      .from(merchantAssets)
      .innerJoin(assets, eq(assets.id, merchantAssets.assetId))
      .innerJoin(
        payoutAddresses,
        and(
          eq(payoutAddresses.organizationId, merchantAssets.organizationId),
          eq(payoutAddresses.chain, assets.chain),
          isNull(payoutAddresses.supersededAt),
        ),
      )
      .where(
        and(
          eq(merchantAssets.organizationId, organizationId),
          eq(merchantAssets.enabled, true),
          eq(assets.verdict, 'approved'),
        ),
      );

    // A chain this deployment has no deposit configuration for cannot be offered,
    // however well the merchant has set it up.
    const supported = new Set(this.deriver.supportedChains());
    return rows.filter((row) => supported.has(row.chain));
  }

  private async findByReference(organizationId: string, reference: string) {
    const [row] = await this.db
      .select()
      .from(checkoutSessions)
      .where(
        and(
          eq(checkoutSessions.organizationId, organizationId),
          eq(checkoutSessions.reference, reference),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  private async invoiceRow(invoiceId: string) {
    const [row] = await this.db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
    return row ?? null;
  }

  /** The invoice as a payer may see it: how to pay, and how it is going. */
  private async publicInvoice(invoiceId: string) {
    const [row] = await this.db
      .select({ invoice: invoices, symbol: assets.symbol, decimals: assets.decimals })
      .from(invoices)
      .innerJoin(assets, eq(assets.id, invoices.assetId))
      .where(eq(invoices.id, invoiceId))
      .limit(1);
    if (!row) return null;

    return {
      invoiceId: row.invoice.id,
      chain: row.invoice.chain,
      symbol: row.symbol,
      decimals: row.decimals,
      amountDue: row.invoice.amountDue,
      amountPaid: row.invoice.amountPaid,
      depositAddress: row.invoice.depositAddress,
      memo: row.invoice.memo,
      status: row.invoice.status,
      toleranceBps: row.invoice.toleranceBps,
      expiresAt: row.invoice.expiresAt.toISOString(),
      // Deliberately absent: payoutAddress, feeDestination, feeBps, organizationId.
      // A payer has no business knowing where the money goes afterwards or what we
      // charge for moving it.
    };
  }

  /**
   * Derive the session's status from its invoice and the clock.
   *
   * Written back when it changes, so the merchant's list is not a pile of rows that
   * each need re-deriving — but derived rather than trusted, because the invoice is
   * the source of truth for whether money arrived and a session row can be stale.
   */
  private async settleStatus(
    session: typeof checkoutSessions.$inferSelect,
    now: Date,
  ): Promise<typeof checkoutSessions.$inferSelect> {
    if (session.status === 'cancelled' || session.status === 'paid') return session;

    if (session.invoiceId) {
      const invoice = await this.invoiceRow(session.invoiceId);
      if (invoice && (invoice.status === 'paid' || invoice.status === 'overpaid')) {
        const [updated] = await this.db
          .update(checkoutSessions)
          .set({ status: 'paid', paidAt: invoice.paidAt ?? now })
          .where(eq(checkoutSessions.id, session.id))
          .returning();
        return updated ?? session;
      }
    }

    /**
     * Expiry does not apply once a currency has been chosen.
     *
     * The invoice has its own deadline, and it is the one the payer is watching. A
     * session that expired underneath a live invoice would tell a payer mid-transfer
     * that their payment window had closed while their money was still arriving.
     */
    if (session.status === 'open' && session.expiresAt.getTime() <= now.getTime()) {
      const [updated] = await this.db
        .update(checkoutSessions)
        .set({ status: 'expired' })
        .where(eq(checkoutSessions.id, session.id))
        .returning();
      return updated ?? session;
    }

    return session;
  }
}

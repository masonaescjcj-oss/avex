import { surchargeBps } from './commission-ledger.js';
import type { CommissionLedger } from './commission-ledger.js';
import {
  applyFeePayer,
  feeOnAmount,
  fiatToTokenAmount,
  type FeePayer,
  type PriceSymbol,
} from '@avex/core';
import { and, eq, isNull } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import {
  assets,
  checkoutSessions,
  invoices,
  merchantAssets,
  organizations,
  payments,
  payoutAddresses,
} from '../db/schema.js';
import type { AuditService } from './audit.js';
import type { FeePlanService } from './fee-plan-service.js';
import type { DepositAddressDeriver } from './deposit-address.js';
import { InvoiceCreationError, type InvoiceCreationService } from './invoice-creation.js';
import type { RateProvider } from './invoice-creation.js';

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
      | 'not_paid'
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
  /**
   * What they would send, in the asset's smallest unit, as a decimal string.
   *
   * Includes the commission when the merchant passes it on, because this is the figure
   * the payer is about to be asked for. A picker that quoted the price and a payment page
   * that then asked for half a per cent more would look like a bait and switch.
   */
  readonly amount: string;
  /**
   * The part of `amount` that is our commission, when the payer is the one paying it.
   *
   * Zero when the merchant absorbs it. The payer is told what they are charged and not
   * told what somebody else is charged, which is the line this whole field exists to draw.
   */
  readonly feeIncluded: string;
  /** The rate this commission is charged at, or zero. Shown alongside `feeIncluded`. */
  readonly feeBps: number;
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
    /**
     * Read to quote the payer the same amount the invoice will ask for.
     *
     * The options list is computed before any invoice exists, so it has to reach the fee
     * the way invoice creation does. Quoting from anywhere else would eventually disagree.
     */
    private readonly feePlans: FeePlanService,
    private readonly deriver: DepositAddressDeriver,
    private readonly rates: RateProvider,
    private readonly audit: AuditService,
    /**
     * The balance, so an option that would be refused is never offered.
     *
     * Optional, and absent means no limit — which matches every other service here and keeps a
     * checkout working in a deployment that does not bill.
     */
    private readonly ledger?: CommissionLedger | undefined,
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
      readonly mode?: 'test' | 'live' | undefined;
      /** Overrides the merchant's default for this checkout only. */
      readonly feePayer?: FeePayer | undefined;
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
        mode: input.mode ?? 'live',
        feePayer: input.feePayer ?? null,
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
      /**
       * Shown to the payer, because a test checkout that looks real is a trap.
       *
       * The address on a test invoice is not a valid address on any chain, so nothing
       * can be lost — but someone staring at a page that says nothing while their
       * wallet refuses the address deserves an explanation.
       */
      mode: session.mode,
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

    /**
     * The commission per chain, looked up once each.
     *
     * Per chain because a chain we hold no collector address for charges nothing, so two
     * rows in the same list can legitimately carry different fees — and a payer choosing
     * between them should see that in the amounts rather than discover it afterwards.
     */
    /**
     * The whole fee shape, not just `feeBps`.
     *
     * A pooled chain charges through `accruedFeeBps` with `feeBps` at zero, so a map holding
     * only the on-chain rate would quote a TRON option without the surcharge and then create an
     * invoice that has it — the payer shown one number and asked for another.
     */
    const fees = new Map<
      string,
      | {
          readonly feeBps: number;
          readonly accruedFeeBps: number;
          readonly recoveryBps: number;
          readonly feePayer: FeePayer;
        }
      | undefined
    >();
    const feeForChain = async (chain: string) => {
      if (!fees.has(chain)) fees.set(chain, await this.feePlans.feeFor(session.organizationId, chain));
      return fees.get(chain);
    };

    /**
     * Whether the merchant may still take payments on chains that accrue a balance.
     *
     * Checked once, here, rather than left to fail at `select`. An account past its limit would
     * otherwise show the payer a TRON option, take their tap, and answer 402 — a stranger's
     * checkout failing because of somebody else's account balance, with no explanation that
     * could be given to them without disclosing the merchant's billing state.
     */
    const canAccrue = this.ledger === undefined
      ? true
      : await this.ledger.withinCreditLimit(session.organizationId);
    /**
     * Reachable as of the pooled-invoice wiring, and mutation-tested.
     *
     * The reason it exists: an account past its limit would otherwise show the payer a TRON
     * option, take their tap, and answer 402 — a stranger meeting somebody else's billing
     * state, with no explanation that could be given without disclosing it.
     */

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

      /**
       * The price, rounded up so the merchant is never left short of the fiat figure.
       *
       * Reusing `fiatToTokenAmount` rather than open-coding the scaling. The naive
       * version divides the rate down to micro-dollar scale first, which truncates
       * a precise rate before it is used — for a sub-cent token that is real lost
       * precision, and in the direction that overcharges the payer.
       */
      const price =
        rate === null
          ? 0n
          : fiatToTokenAmount(
              amountFiat,
              { priceScaled: rate, observedAt: Date.now() },
              entry.decimals,
            );

      const fee = rate === null ? undefined : await feeForChain(entry.chain);

      /**
       * Offered as unavailable rather than hidden, like every other reason in this loop.
       *
       * The wording is deliberately about the currency and not about the merchant. Every other
       * reason here discloses a configuration gap, which is harmless; "this merchant owes their
       * gateway money" is not something a payer should be told, and it is not their problem.
       */
      if (rate !== null && (fee?.accruedFeeBps ?? 0) > 0 && !canAccrue) {
        rate = null;
        reason = 'This currency is temporarily unavailable. Please choose another.';
      }
      const surcharge = surchargeBps(fee);
      const charged = applyFeePayer(price, surcharge, fee?.feePayer ?? 'merchant');
      const passedOn = fee?.feePayer === 'payer';

      options.push({
        assetId: entry.assetId,
        symbol: entry.symbol,
        name: entry.symbol,
        chain: entry.chain,
        decimals: entry.decimals,
        amount: charged.amountDue.toString(),
        // The surcharge, not the whole commission: when the merchant absorbs it there is
        // nothing here for the payer to be told about.
        feeIncluded: passedOn ? charged.surcharge.toString() : '0',
        feeBps: passedOn ? surcharge : 0,
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
          /**
           * Inherited from the session, never re-derived.
           *
           * There is no credential to derive it from here — the payer has none — and
           * the mode was fixed when the merchant opened the session. A test session
           * that produced a live invoice would take real money on a rehearsal.
           */
          mode: session.mode,
          /**
           * Undefined, not `'merchant'`, when the session made no choice.
           *
           * Invoice creation reads the merchant's default in that case, which is what a
           * session that has been sitting open for an hour should get — a merchant who
           * changed their mind in between meant it to apply.
           */
          ...(session.feePayer ? { feePayer: session.feePayer } : {}),
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
      /**
       * Our commission, but only when the payer is the one paying it.
       *
       * The line this draws is the honest one: you are told what you are being charged,
       * and not told what somebody else is being charged. When the merchant absorbs the
       * commission it comes out of their settlement and is none of the payer's business;
       * when it has been added to what the payer must send, showing the total without the
       * breakdown would make our fee look like the merchant's price.
       */
      feeBps: row.invoice.feePayer === 'payer' ? row.invoice.feeBps : 0,
      feeIncluded:
        row.invoice.feePayer === 'payer'
          ? feeOnAmount(BigInt(row.invoice.amountDue), row.invoice.feeBps).toString()
          : '0',
      expiresAt: row.invoice.expiresAt.toISOString(),
      // Deliberately absent: payoutAddress, feeDestination, organizationId. A payer has no
      // business knowing where the money goes afterwards.
    };
  }

  /**
   * The receipt for a settled checkout: the record the payer keeps.
   *
   * Public, like the rest of the payer side — the link is the capability, and a receipt
   * a payer has to sign in for is a receipt they will not keep. It carries more than the
   * payment page does, because the two are read at different moments: the page answers
   * "what do I send and has it arrived", and this answers "what did I buy, when, for how
   * much, and how would I prove it".
   *
   * The transaction hashes are the proof and the reason this exists at all. Everything
   * else on here we assert; the hash is something the payer can check against a public
   * chain without trusting us.
   *
   * Refused while the bill is unpaid. A receipt for a payment that has not arrived is not
   * a receipt, and issuing one would give a payer a document saying they had paid.
   */
  async receipt(sessionId: string, now: Date = new Date()) {
    const [row] = await this.db
      .select({ session: checkoutSessions, merchantName: organizations.name })
      .from(checkoutSessions)
      .innerJoin(organizations, eq(organizations.id, checkoutSessions.organizationId))
      .where(eq(checkoutSessions.id, sessionId))
      .limit(1);
    if (!row) throw new CheckoutError('not_found', 'No such checkout.');

    const session = await this.settleStatus(row.session, now);
    if (!session.invoiceId) {
      throw new CheckoutError('not_paid', 'Nothing has been paid for this checkout yet.');
    }

    const [invoice] = await this.db
      .select({ invoice: invoices, symbol: assets.symbol, decimals: assets.decimals })
      .from(invoices)
      .innerJoin(assets, eq(assets.id, invoices.assetId))
      .where(eq(invoices.id, session.invoiceId))
      .limit(1);
    if (!invoice) throw new CheckoutError('not_found', 'No such checkout.');

    /**
     * `overpaid` gets a receipt too, and it says so.
     *
     * The money arrived — more of it than was asked for — so the payer is entitled to a
     * record, and the record has to name the discrepancy rather than print the invoice
     * amount as though that were what they sent. `underpaid` gets nothing: the bill is
     * not settled, and a document that looks like a receipt would be worse than none.
     */
    if (invoice.invoice.status !== 'paid' && invoice.invoice.status !== 'overpaid') {
      throw new CheckoutError(
        'not_paid',
        invoice.invoice.status === 'underpaid'
          ? 'This payment was short of the amount due, so it has no receipt yet.'
          : 'This payment has not completed yet, so it has no receipt yet.',
      );
    }

    const transfers = await this.db
      .select({
        txHash: payments.txHash,
        amount: payments.amount,
        blockNumber: payments.blockNumber,
        creditedAt: payments.creditedAt,
      })
      .from(payments)
      .where(and(eq(payments.invoiceId, invoice.invoice.id), isNull(payments.reversedAt)))
      .orderBy(payments.creditedAt);

    return {
      /**
       * Derived from the invoice id rather than counted.
       *
       * A sequential number would need a counter, and a counter shared across merchants
       * would tell each of them how many payments the others took. This is short enough
       * to read down a phone and unique because the id is.
       */
      number: `AVEX-${invoice.invoice.id.replace(/-/g, '').slice(0, 8).toUpperCase()}`,
      status: invoice.invoice.status,
      merchantName: row.merchantName,
      description: session.description,
      /** The merchant's own order id, so the payer can quote it back to them. */
      reference: session.reference,
      mode: invoice.invoice.mode,

      amountFiatMicros: session.amountFiatMicros,
      symbol: invoice.symbol,
      decimals: invoice.decimals,
      amountDue: invoice.invoice.amountDue,
      amountPaid: invoice.invoice.amountPaid,

      chain: invoice.invoice.chain,
      depositAddress: invoice.invoice.depositAddress,
      memo: invoice.invoice.memo,
      /** The hashes. The only thing here a payer can verify without trusting us. */
      transfers: transfers.map((transfer) => ({
        txHash: transfer.txHash,
        amount: transfer.amount,
        blockNumber: transfer.blockNumber,
        at: transfer.creditedAt.toISOString(),
      })),

      // The same disclosure rule as the payment page: shown when the payer paid it,
      // absent when the merchant absorbed it.
      feeBps: invoice.invoice.feePayer === 'payer' ? invoice.invoice.feeBps : 0,
      feeIncluded:
        invoice.invoice.feePayer === 'payer'
          ? feeOnAmount(BigInt(invoice.invoice.amountDue), invoice.invoice.feeBps).toString()
          : '0',

      issuedAt: invoice.invoice.createdAt.toISOString(),
      paidAt: (invoice.invoice.paidAt ?? invoice.invoice.createdAt).toISOString(),
      // Deliberately absent, as everywhere else on this side: the payout address, our
      // collector, and the merchant's id.
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

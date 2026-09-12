import type { ChainMinimums } from './chain-minimums.js';
import { formatUsdMicros } from './chain-minimums.js';
import { disclosedFees, surchargeBps } from './commission-ledger.js';
import type { CommissionLedger } from './commission-ledger.js';
import {
  applyFeePayer,
  ceilToGrid,
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
  depositWallets,
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

/**
 * The part of the Telegram bot service this needs, and no more.
 *
 * An interface rather than the class, so the checkout does not depend on how a bot is stored
 * or on Telegram's HTTP surface — and so a test can hand it two functions.
 */
export interface TelegramBotLink {
  connected(organizationId: string): Promise<{ readonly username: string } | null>;
  payLink(
    organizationId: string,
    invoice: {
      readonly title: string;
      readonly description: string;
      readonly payload: string;
      readonly stars: bigint;
    },
  ): Promise<string>;
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
  /**
   * What the chain charges to move it, in the asset's smallest unit.
   *
   * Always the payer's, and always shown: a merchant may absorb our commission as a courtesy,
   * but nobody can absorb what the transfer itself costs. Zero on the chains where the payer's
   * transfer reaches the merchant's own wallet and we send nothing — which is most of the
   * reason those chains are cheaper.
   */
  readonly networkFeeIncluded: string;
  /** The rate the network fee works out to on this invoice. Shown as its own line. */
  readonly networkFeeBps: number;
  /** The rate this commission is charged at, or zero. Shown alongside `feeIncluded`. */
  readonly feeBps: number;
  /** The rate used, so the figure can be checked rather than taken on trust. */
  readonly rateUsd: string | null;
  /** Null when we could not price it, which is why the option may be unavailable. */
  readonly available: boolean;
  readonly unavailableReason: string | null;
}

/**
 * Three hours, matching a pooled invoice's own life.
 *
 * The invoice a payer selects inside this session cannot outlive the session, so a one-hour
 * session would silently cut a three-hour invoice to whatever was left of the hour. The rate
 * is re-quoted when the payer picks a currency, not when the link is opened, so a long session
 * costs the merchant nothing until then.
 */
const DEFAULT_SESSION_TTL_MS = 3 * 60 * 60 * 1000;

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
    /**
     * The smallest order each chain can carry, so a network that would refuse is never offered.
     *
     * The same check invoice creation makes, reached from here for the same reason the fee is:
     * a payer must not be able to tap an option that then answers 422. Optional, and absent
     * means every network is offered — which is what happened before this existed.
     */
    private readonly minimums?: ChainMinimums | undefined,
    /**
     * The merchant's Telegram bot, where they asked us to run the Stars checkout.
     *
     * Optional, like the two above, and absent means Stars are simply not offered on this
     * page — which is the correct answer, not a degraded one: without a bot there is nothing
     * to ask for a pay link, so an option here would be one a payer could tap and not pay.
     */
    private readonly telegram?: TelegramBotLink | undefined,
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
      const found = await this.findByReference(organizationId, input.reference);
      if (found) {
        /**
         * Settled first, because a session's death is lazy: nothing sweeps these rows, so a
         * session whose deadline passed an hour ago is still `open` in the table until
         * somebody looks at it. Looking at it here is what makes the check below true.
         */
        const existing = await this.settleStatus(found, new Date());
        if (existing.status !== 'expired' && existing.status !== 'cancelled') {
          return { session: existing, created: false };
        }

        /**
         * Dead, so the order id is released and a new session opened for it.
         *
         * Returning the dead one is what a merchant hit: the customer's payment window had
         * closed, the shop sent them back to pay, and the link they were handed was the same
         * expired link — every time, for good. An order that cannot be paid is worse than two
         * links for one order, which is what the reference exists to prevent.
         */
        await this.releaseReference(existing.id);
      }
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
        'No currency is payable yet. Enable at least one approved asset and add one of your ' +
          'own wallets for its chain — or a payout address, where the chain has forwarders.',
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
      // The order id goes with it: a merchant who withdrew this checkout may well issue
      // another for the same order, and nothing dead should stand in the way.
      .set({ status: 'cancelled', referenceActive: false })
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
      /**
       * Where the merchant asked for the payer to go afterwards, and where a payer who gives
       * up should go. Both were accepted at creation, stored, and — until this line — read
       * by nothing: a payer whose payment had confirmed was told to close the tab while the
       * shop that sent them waited for a return that never came.
       */
      successUrl: session.successUrl,
      cancelUrl: session.cancelUrl,
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
      Promise<
        | {
            readonly feeBps: number;
            readonly accruedFeeBps: number;
            readonly recoveryBps: number;
            readonly networkFeeBps: number;
            readonly feePayer: FeePayer;
          }
        | undefined
      >
    >();
    /** Keyed by chain *and* model: a pooled invoice and a forwarder one have different floors. */
    const minimums = new Map<
      string,
      Promise<{ readonly ok: true } | { readonly ok: false; readonly minUsdMicros: bigint }>
    >();
    /**
     * The session's dollar figure goes in, and it has to.
     *
     * Two parts of the fee are a share of the invoice rather than a flat rate — the network fee
     * and any balance recovery — so a lookup without the amount answers a different question
     * from the one invoice creation asks a moment later. That is how the payer ends up shown
     * $20.00 and asked for $20.10, which reads as a scam rather than a rounding.
     */
    const where = await this.destinations(session.organizationId);

    /**
     * The promise is what is cached, not the answer.
     *
     * That is the whole difference between one lookup per chain and one per row. This map used
     * to hold resolved values, which is correct only while the rows are built one after
     * another: the moment they are built together, three USDT rows on BNB Chain all find the
     * map empty and all three fetch. Storing the in-flight promise makes the second and third
     * wait on the first.
     */
    const feeForChain = (chain: string) => {
      let pending = fees.get(chain);
      if (pending === undefined) {
        pending = this.feePlans.feeFor(session.organizationId, chain, amountFiat, {
          // The same decision invoice creation makes, so the quoted amount is the asked one.
          pooled: this.pooledOn(chain, where),
        });
        fees.set(chain, pending);
      }
      return pending;
    };

    /**
     * The same, for the smallest order a chain can carry.
     *
     * Worth more than the fee is, because of what is behind it: the minimum comes from a gas
     * snapshot, and a cold snapshot is two RPC calls to that chain's node. Unshared, a
     * checkout offering USDT, USDC and BNB on BNB Chain made six.
     */
    const minimumFor = (chain: string, pooled: boolean) => {
      const key = `${chain}:${pooled ? 'pooled' : 'forwarder'}`;
      let pending = minimums.get(key);
      if (pending === undefined) {
        pending = this.minimums
          ? this.minimums.verdict(chain, amountFiat, { pooled })
          : Promise.resolve({ ok: true as const });
        minimums.set(key, pending);
      }
      return pending;
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

    /**
     * Every row at once, rather than one after another.
     *
     * This was a sequential loop, and each pass awaited three things: a price, a fee, and the
     * chain's minimum — the last of which is two RPC calls to that chain's node on a cold
     * cache. A payer picking a currency therefore waited for the sum of every row rather than
     * the slowest one, which on a merchant taking eight currencies across four chains is the
     * difference between a page that appears and one somebody watches load.
     *
     * Safe to parallelise because nothing in a row depends on another row. The two shared
     * lookups — the fee and the minimum — are shared by promise above, so running the rows
     * together makes fewer requests rather than more.
     */
    const built = await Promise.all(payable.map(async (entry): Promise<CheckoutOption> => {
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

      /**
       * The chain's own coin needs a wallet of the merchant's own on that chain.
       *
       * A native transfer emits no event, so it is found by watching the balance of each
       * wallet we know about — which works for a handful of a merchant's wallets and not for
       * the thousands of per-invoice forwarder addresses a busy chain derives. So a native
       * invoice is only issued against a wallet, and invoice creation refuses the other case
       * with the same reasoning. Shown as unavailable rather than hidden, like every reason
       * in this loop: a currency that silently disappears reads as us not supporting it.
       */
      if (rate !== null && entry.kind === 'native' && !this.pooledOn(entry.chain, where)) {
        rate = null;
        reason = `Paying in ${entry.symbol} needs a wallet of the merchant's own on this network.`;
      }

      /**
       * A network too expensive to settle an order this small is shown, and shown as unavailable.
       *
       * Offered rather than hidden, like every other reason in this loop — a network that
       * silently disappears reads as us not supporting it. The wording says the cost is the
       * chain's rather than quoting our settlement bill: a payer choosing a network needs to
       * know which one to pick, not what our gas costs.
       */
      if (rate !== null && this.minimums) {
        const pooled = this.pooledOn(entry.chain, where);
        const verdict = await minimumFor(entry.chain, pooled);
        if (!verdict.ok) {
          rate = null;
          reason =
            verdict.minUsdMicros <= this.minimums.absoluteMinUsdMicros()
              ? `The smallest payment we take is ${formatUsdMicros(verdict.minUsdMicros)}.`
              : 'This network costs too much to settle an order this small. Choose another.';
        }
      }
      const surcharge = surchargeBps(fee);
      const charged = applyFeePayer(
        price,
        surcharge,
        fee?.feePayer ?? 'merchant',
        fee?.networkFeeBps ?? 0,
      );
      /**
       * What this option adds to the merchant's price, split the way the payer is shown it.
       *
       * No longer one question. A commission the merchant absorbs is none of the payer's
       * business; the cost of the transfer is added on every chain we settle on and has to be
       * shown whoever bears the commission.
       */
      const disclosed = disclosedFees(charged.amountDue, fee, fee?.feePayer ?? 'merchant');

      return {
        assetId: entry.assetId,
        symbol: entry.symbol,
        name: entry.symbol,
        chain: entry.chain,
        decimals: entry.decimals,
        /**
         * Rounded up to the token's grid — three decimals, up to five on a dear one — as the
         * invoice will be.
         *
         * The figure the payer compares against the invoice a moment later. Invoice creation
         * applies the same rounding to the same input, so the two agree to the digit — except
         * for the disambiguator a shared wallet adds, which the page explains as such.
         */
        amount: ceilToGrid(
          charged.amountDue,
          entry.decimals,
          rate === null ? null : Number(rate) / 1e18,
        ).toString(),
        // The surcharge, not the whole commission: when the merchant absorbs it there is
        // nothing here for the payer to be told about.
        feeIncluded: disclosed.commission.toString(),
        feeBps: disclosed.commissionBps,
        // And the cost of moving it, which is on every invoice on a chain we settle.
        networkFeeIncluded: disclosed.network.toString(),
        networkFeeBps: disclosed.networkBps,
        rateUsd: rate === null ? null : rate.toString(),
        available: rate !== null,
        unavailableReason: reason,
      };
    }));
    options.push(...built);

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
  /**
   * Which chains this merchant has somewhere for money to land on.
   *
   * Two ways, and either is enough. A wallet of their own means invoices are paid straight
   * into it, matched by amount, with no contract of ours involved — on any chain. A payout
   * address means a forwarder is derived to sweep into it, where the chain has forwarders.
   * The wallet wins when both exist, because it is the one that costs nobody any gas; the
   * same rule invoice creation applies, so what the payer is shown is what they will get.
   */
  private async destinations(organizationId: string): Promise<{
    readonly wallets: ReadonlySet<string>;
    readonly payouts: ReadonlySet<string>;
  }> {
    const [wallets, payouts] = await Promise.all([
      this.db
        .selectDistinct({ chain: depositWallets.chain })
        .from(depositWallets)
        .where(
          and(eq(depositWallets.organizationId, organizationId), isNull(depositWallets.retiredAt)),
        ),
      this.db
        .selectDistinct({ chain: payoutAddresses.chain })
        .from(payoutAddresses)
        .where(
          and(
            eq(payoutAddresses.organizationId, organizationId),
            isNull(payoutAddresses.supersededAt),
          ),
        ),
    ]);
    return {
      wallets: new Set(wallets.map((row) => row.chain)),
      payouts: new Set(payouts.map((row) => row.chain)),
    };
  }

  /** Whether an invoice on this chain would be paid into the merchant's own wallet. */
  private pooledOn(
    chain: string,
    where: { readonly wallets: ReadonlySet<string> },
  ): boolean {
    return this.deriver.isPooled(chain) || where.wallets.has(chain);
  }

  private async payableAssets(organizationId: string) {
    const rows = await this.db
      .select({
        assetId: assets.id,
        symbol: assets.symbol,
        chain: assets.chain,
        decimals: assets.decimals,
        // Whether it is the chain's own coin, which is watched differently and needs a wallet.
        kind: assets.kind,
        pricingMode: merchantAssets.pricingMode,
        spreadBps: merchantAssets.spreadBps,
        fixedRateScaled: merchantAssets.fixedRateScaled,
        fixedRateValidUntil: merchantAssets.fixedRateValidUntil,
      })
      .from(merchantAssets)
      .innerJoin(assets, eq(assets.id, merchantAssets.assetId))
      .where(
        and(
          eq(merchantAssets.organizationId, organizationId),
          eq(merchantAssets.enabled, true),
          eq(assets.verdict, 'approved'),
        ),
      );

    /**
     * Payable means: somewhere for the money to go, on a chain this build can credit.
     *
     * This used to be an inner join on payout addresses, which made a merchant's own wallet
     * on BNB Chain — and every TRON wallet — invisible to the checkout until they also added a
     * payout address they did not need. A wallet is a destination in its own right. A payout
     * address is one only where the chain has forwarders to sweep into it.
     */
    const where = await this.destinations(organizationId);
    const supported = new Set(this.deriver.supportedChains());
    const forwarders = new Set(this.deriver.forwarderChains());

    /**
     * Telegram Stars, and the one destination that is not an address.
     *
     * A connected bot is what makes Stars payable from this page, and it is the same kind of
     * fact as a wallet on a chain: somewhere the money can land that we can then point a payer
     * at. Without one the merchant can still take Stars — their own bot creates the Telegram
     * invoice and reports the charge — but not *here*, because this page has no bot to ask.
     */
    const bot = rows.some((row) => row.kind === 'stars')
      ? await this.telegram?.connected(organizationId)
      : null;

    return rows.filter((row) =>
      row.kind === 'stars'
        ? bot != null
        : supported.has(row.chain) &&
          (where.wallets.has(row.chain) ||
            this.deriver.isPooled(row.chain) ||
            (where.payouts.has(row.chain) && forwarders.has(row.chain))),
    );
  }

  /** The session still holding a merchant's order id, dead or alive; `create` decides which. */
  private async findByReference(organizationId: string, reference: string) {
    const [row] = await this.db
      .select()
      .from(checkoutSessions)
      .where(
        and(
          eq(checkoutSessions.organizationId, organizationId),
          eq(checkoutSessions.reference, reference),
          eq(checkoutSessions.referenceActive, true),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** Let go of the order id, so the next checkout for it is a new one. Never taken back. */
  private async releaseReference(sessionId: string): Promise<void> {
    await this.db
      .update(checkoutSessions)
      .set({ referenceActive: false })
      .where(eq(checkoutSessions.id, sessionId));
  }

  private async invoiceRow(invoiceId: string) {
    const [row] = await this.db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
    return row ?? null;
  }

  /** The invoice as a payer may see it: how to pay, and how it is going. */
  private async publicInvoice(invoiceId: string) {
    const [row] = await this.db
      .select({
        invoice: invoices,
        symbol: assets.symbol,
        decimals: assets.decimals,
        kind: assets.kind,
      })
      .from(invoices)
      .innerJoin(assets, eq(assets.id, invoices.assetId))
      .where(eq(invoices.id, invoiceId))
      .limit(1);
    if (!row) return null;

    /**
     * A Stars invoice is paid through Telegram, so the payer gets a link instead of an address.
     *
     * Asked for on every read rather than stored, and that is deliberate. Telegram's links are
     * short-lived and ours to re-create at will; a stale one saved in a column would send a
     * payer to a page that no longer works, with nothing on our side saying why. Asking again
     * costs one call on a screen the payer is already waiting on.
     *
     * A failure here is not fatal: the rest of the invoice is returned and the page says the
     * link could not be fetched, which is recoverable by reloading. Throwing would turn a bad
     * minute at Telegram into a checkout that cannot be opened at all.
     */
    let payLink: string | null = null;
    let payLinkError: string | null = null;
    if (row.kind === 'stars') {
      try {
        payLink = (await this.telegram?.payLink(row.invoice.organizationId, {
          title: 'Payment',
          description: `Order ${row.invoice.reference ?? row.invoice.id.slice(0, 8)}`,
          payload: row.invoice.depositAddress,
          stars: BigInt(row.invoice.amountDue),
        })) ?? null;
        if (payLink === null) payLinkError = 'This shop is not set up to take Stars here.';
      } catch {
        payLinkError = 'Telegram could not be reached just now. Reload to try again.';
      }
    }

    /**
     * Computed from the columns rather than from a live fee lookup.
     *
     * The invoice is what the payer is held to, and its rates were fixed when its deposit
     * address was derived. Re-reading the merchant's plan here would eventually show a payer a
     * breakdown that does not add up to the amount they were asked for.
     */
    const disclosedInvoice = disclosedFees(
      BigInt(row.invoice.amountDue),
      row.invoice,
      row.invoice.feePayer,
    );

    return {
      invoiceId: row.invoice.id,
      chain: row.invoice.chain,
      symbol: row.symbol,
      decimals: row.decimals,
      amountDue: row.invoice.amountDue,
      amountPaid: row.invoice.amountPaid,
      depositAddress: row.invoice.depositAddress,
      memo: row.invoice.memo,
      /**
       * How a Star payment is made: a link into Telegram, where an address would otherwise be.
       *
       * Null on every other currency, and the page reads it as the switch between the two
       * screens — there is no address to copy, no QR code, and no exact amount to match,
       * because Telegram charges the figure it was given.
       */
      payLink,
      payLinkError,
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
      feeBps: disclosedInvoice.commissionBps,
      feeIncluded: disclosedInvoice.commission.toString(),
      /**
       * And what the transfer costs, which is disclosed whoever bears the commission.
       *
       * Its own line rather than folded into the one above, because they answer different
       * questions: "what does this gateway charge" and "what does this chain charge". A payer
       * choosing between networks is choosing on the second.
       */
      networkFeeBps: disclosedInvoice.networkBps,
      networkFeeIncluded: disclosedInvoice.network.toString(),
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

    const disclosedReceipt = disclosedFees(
      BigInt(invoice.invoice.amountDue),
      invoice.invoice,
      invoice.invoice.feePayer,
    );

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
      feeBps: disclosedReceipt.commissionBps,
      feeIncluded: disclosedReceipt.commission.toString(),
      // The same two lines the payment page showed, so a receipt reconciles against it.
      networkFeeBps: disclosedReceipt.networkBps,
      networkFeeIncluded: disclosedReceipt.network.toString(),

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

      /**
       * A chosen session is over when its *invoice* is over.
       *
       * Not when the session's own clock runs out — that is the rule immediately below, and
       * it is deliberately the other way round: the invoice carries the deadline the payer is
       * actually watching, so a session must outlive its own expiry while money may still be
       * arriving. But once the invoice is dead there is nothing left to pay, and a row that
       * sits at `selected` for ever is a row still holding the merchant's order id — which is
       * how an order became impossible to pay again after one abandoned checkout.
       */
      if (invoice && (invoice.status === 'expired' || invoice.expiresAt.getTime() <= now.getTime())) {
        const [updated] = await this.db
          .update(checkoutSessions)
          .set({ status: 'expired', referenceActive: false })
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
        .set({ status: 'expired', referenceActive: false })
        .where(eq(checkoutSessions.id, session.id))
        .returning();
      return updated ?? session;
    }


    return session;
  }
}

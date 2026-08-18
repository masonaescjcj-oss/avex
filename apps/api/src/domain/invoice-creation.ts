import {
  DEFAULT_MAX_ROUNDING_BPS,
  DEFAULT_QUOTE_TTL_MS,
  QuoteInputError,
  createQuote,
  fiatToTokenAmount,
  tokenAmountToFiat,
  type Asset,
  type FeeSplit,
  type PriceSymbol,
  type PricingMode,
  type Rate,
} from '@avex/core';
import { and, eq, isNull } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { assets, invoices, merchantAssets, payoutAddresses, quotes } from '../db/schema.js';
import type { AuditService } from './audit.js';
import { DepositAddressError, type DepositAddressDeriver } from './deposit-address.js';
import type { SubscriptionService } from './subscription-service.js';

/**
 * Opening an invoice: the one thing this product exists to do.
 *
 * The ordering of the checks below is the design. Every one of them can refuse, and
 * they run cheapest-and-most-certain first, so a merchant who is behind on payment
 * hears about that rather than about a price source being down. Nothing is written
 * until every check has passed — a half-created invoice with a deposit address and no
 * amount is an address a payer could fund with nothing to match it against.
 *
 * The single most important property is that the deposit address is derived from the
 * fee, so the fee has to be decided before the address exists and stored beside it
 * afterwards. Re-reading a live fee at settlement would derive a different address
 * from the one a payer funded, and the money would sit in a forwarder nobody could
 * deploy. See the note on `invoices.fee_bps`.
 */

export class InvoiceCreationError extends Error {
  constructor(
    readonly code:
      | 'billing_blocked'
      | 'asset_unknown'
      | 'asset_disabled'
      | 'asset_unapproved'
      | 'fixed_rate_required'
      | 'fixed_rate_expired'
      | 'no_payout_address'
      | 'price_unavailable'
      | 'amount_invalid'
      | 'chain_unsupported'
      | 'not_configured',
    message: string,
  ) {
    super(message);
    this.name = 'InvoiceCreationError';
  }
}

export interface CreateInvoiceRequest {
  /** Which asset, by the id the merchant read from their own asset list. */
  readonly assetId: string;
  /** The merchant's own order identifier. Doubles as the idempotency key. */
  readonly reference?: string | undefined;
  /** For `fiat` and `fixed_rate` pricing, in micro-dollars. */
  readonly amountFiatMicros?: bigint | undefined;
  /** For `token` pricing, in the asset's smallest unit. */
  readonly amountToken?: bigint | undefined;
  readonly ttlMs?: number | undefined;
  /**
   * Test or live. Absent means live.
   *
   * Requested rather than assumed, because a dashboard session has no inherent mode —
   * a merchant testing from the dashboard has to be able to say so. An API key does
   * have one, and `resolveMode` below is what stops a request overriding it.
   */
  readonly mode?: 'test' | 'live' | undefined;
}

/**
 * The mode an object is created in, from the credential and the request together.
 *
 * The rule that matters is one-directional: a test key can only ever produce test
 * objects, whatever the request says. That is the whole security property of test mode —
 * a key a merchant pastes into a staging config, a CI job or a third-party integration
 * must not be able to take real money, even if the caller asks it to.
 *
 * A live key is the mirror: it produces live objects only. Letting it opt into test
 * would mean a bug in a merchant's code could silently stop charging their customers.
 *
 * A session may choose, defaulting to live, because a human in the dashboard is the one
 * party who legitimately does both.
 */
export function resolveMode(
  credential: { readonly kind: 'api_key'; readonly mode: 'test' | 'live' } | { readonly kind: 'session' },
  requested: 'test' | 'live' | undefined,
): 'test' | 'live' {
  if (credential.kind === 'api_key') return credential.mode;
  return requested ?? 'live';
}

export interface RateProvider {
  /**
   * A trustworthy USD rate, or a throw.
   *
   * Narrow on purpose: this service needs one method from the pricing engine, and
   * depending on the whole of it would make every test here stand up a circuit
   * breaker and three exchange clients.
   */
  requireRate(symbol: PriceSymbol): Promise<Rate>;
}

/**
 * The rail Telegram Stars ride on, in the `chain` column.
 *
 * Not a chain, and deliberately not in `SUPPORTED_CHAINS`. Stars paid to a bot land in
 * that bot's own Telegram balance: there is no address to derive, no transfer to watch and
 * nothing for us to sweep. Anything that treats this string as a chain will fail to find a
 * registry entry, which is the right failure.
 */
export const TELEGRAM_RAIL = 'telegram';

const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_TTL_MS = 60 * 1000;

export class InvoiceCreationService {
  constructor(
    private readonly db: Database,
    private readonly deriver: DepositAddressDeriver,
    private readonly subscriptions: SubscriptionService,
    private readonly rates: RateProvider,
    private readonly audit: AuditService,
  ) {}

  async create(
    organizationId: string,
    request: CreateInvoiceRequest,
    actor: { readonly userId: string | null; readonly apiKeyId: string | null; readonly ip?: string },
  ): Promise<{ readonly invoice: typeof invoices.$inferSelect; readonly created: boolean }> {
    /**
     * An existing invoice for this reference wins, before anything else happens.
     *
     * A merchant retrying "invoice for order #1234" after a timeout must get the same
     * invoice back rather than a second one with a second deposit address — otherwise
     * a dropped response turns into two addresses for one order and a payer funding
     * whichever they were shown last.
     *
     * Checked first because it is the cheapest possible answer, and re-checked after
     * the insert conflict below, which is what actually makes it safe against two
     * simultaneous requests.
     */
    if (request.reference) {
      const existing = await this.findByReference(organizationId, request.reference);
      if (existing) return { invoice: existing, created: false };
    }

    // 1. May this merchant trade at all? Cheapest check, and the one whose answer a
    //    merchant can act on without reading anything else.
    const verdict = await this.subscriptions.billingVerdict(organizationId);
    if (!verdict.mayIssueInvoices) {
      throw new InvoiceCreationError('billing_blocked', verdict.reason ?? 'Billing is not current.');
    }

    // 2. The asset, and this merchant's configuration for it.
    const config = await this.resolveAsset(organizationId, request.assetId);

    /**
     * 3. Where the money ends up.
     *
     * Captured now, so a later payout-address change cannot retarget an invoice a payer is
     * already looking at. Stars are the exception and it is structural: the customer pays
     * the merchant's own bot, so the funds are already where they are going and there is no
     * address for us to hold. The column records the rail rather than pretending otherwise.
     */
    const payoutAddress = config.stars
      ? 'telegram:bot'
      : await this.resolvePayoutAddress(organizationId, config.asset.chain);

    // 4. The rate, and from it the amount. `createQuote` is pure, so every rounding
    //    decision it makes is testable without a network.
    const quote = await this.buildQuote(config, request);

    /**
     * 5. The commission, decided before the address exists because it feeds the
     *    address. Zero and undefined both mean the merchant keeps everything.
     */
    /**
     * No commission on Stars, and this is a limit rather than a policy.
     *
     * A percentage is collectable because the forwarder splits it on the way out. Stars
     * never pass through anything we control, so there is nothing to split — charging for
     * them would mean invoicing the merchant separately for money we never touched.
     */
    const fee = config.stars
      ? undefined
      : await this.subscriptions.feeFor(organizationId, config.asset.chain);

    // 6. Write the quote, then derive the address from the id it was given, then the
    //    invoice. The id has to exist before the address can be derived from it.
    const [quoteRow] = await this.db
      .insert(quotes)
      .values({
        organizationId,
        chain: config.asset.chain,
        assetSymbol: config.asset.symbol,
        // Stars have no contract, and no chain to have one on.
        assetContract: 'contract' in config.asset ? config.asset.contract ?? null : null,
        assetDecimals: String(config.asset.decimals),
        mode: config.pricingMode,
        amountDue: quote.amountDue.toString(),
        marketRateScaled: quote.marketRate?.priceScaled.toString() ?? null,
        effectiveRateScaled: quote.effectiveRate?.priceScaled.toString() ?? null,
        spreadBps: String(config.spreadBps),
        amountFiatMicros: quote.amountFiatMicros?.toString() ?? null,
        sources: quote.sources,
        expiresAt: new Date(quote.expiresAt),
        consumedAt: new Date(),
      })
      .returning();

    const invoiceId = crypto.randomUUID();
    const mode = request.mode ?? 'live';

    /**
     * Stars carry a payload, not an address.
     *
     * The merchant's bot puts this string in `invoice_payload` when it calls Telegram's
     * `createInvoiceLink`, and sends it back when the payment succeeds. It is how a Stars
     * payment finds its invoice, doing the job a deposit address does everywhere else —
     * which is why it goes in the same column rather than a new one.
     */
    let target;
    if (config.stars) {
      target = { address: `${TELEGRAM_RAIL}:${invoiceId}`, memo: undefined };
    } else {
      try {
        target = this.deriver.derive({
          invoiceId,
          chain: config.asset.chain,
          payoutAddress,
          fee,
          mode,
        });
      } catch (error) {
        if (error instanceof DepositAddressError) {
          throw new InvoiceCreationError(error.code, error.message);
        }
        throw error;
      }
    }

    const [created] = await this.db
      .insert(invoices)
      .values({
        id: invoiceId,
        organizationId,
        assetId: config.asset.id,
        quoteId: quoteRow!.id,
        reference: request.reference ?? null,
        amountDue: quote.amountDue.toString(),
        mode,
        chain: config.asset.chain,
        depositAddress: target.address,
        memo: target.memo ?? null,
        payoutAddress,
        feeBps: fee?.feeBps ?? 0,
        feeDestination: fee?.feeDestination ?? null,
        toleranceBps: config.toleranceBps,
        expiresAt: new Date(quote.expiresAt),
      })
      .onConflictDoNothing()
      .returning();

    /**
     * A conflict means another request created this reference between our first look
     * and this insert. Return theirs rather than erroring: two concurrent retries of
     * one order should converge on one invoice, which is the whole point of keying on
     * the reference.
     */
    if (!created) {
      const existing = request.reference
        ? await this.findByReference(organizationId, request.reference)
        : null;
      if (existing) return { invoice: existing, created: false };
      throw new InvoiceCreationError('amount_invalid', 'The invoice could not be created.');
    }

    await this.audit.record({
      organizationId,
      userId: actor.userId,
      apiKeyId: actor.apiKeyId,
      action: 'invoice.created',
      targetType: 'invoice',
      targetId: created.id,
      metadata: {
        chain: config.asset.chain,
        assetSymbol: config.asset.symbol,
        amountDue: quote.amountDue.toString(),
        pricingMode: config.pricingMode,
        mode,
        // Recorded because it is the number a merchant is most likely to dispute
        // later, and it cannot be recovered from the address afterwards.
        feeBps: fee?.feeBps ?? 0,
        reference: request.reference ?? null,
      },
      ...(actor.ip === undefined ? {} : { ip: actor.ip }),
    });

    return { invoice: created, created: true };
  }

  private async findByReference(organizationId: string, reference: string) {
    const [row] = await this.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.organizationId, organizationId), eq(invoices.reference, reference)))
      .limit(1);
    return row ?? null;
  }

  /**
   * The asset and the merchant's settings for it, with every reason it might be
   * unusable stated separately.
   *
   * Separate codes rather than one "asset not available", because the four causes need
   * four different actions: pick another asset, enable this one, wait for review, or
   * set a rate. A single code would send every merchant to support.
   */
  private async resolveAsset(organizationId: string, assetId: string) {
    const [row] = await this.db
      .select({ asset: assets, config: merchantAssets })
      .from(assets)
      .leftJoin(
        merchantAssets,
        and(eq(merchantAssets.assetId, assets.id), eq(merchantAssets.organizationId, organizationId)),
      )
      .where(eq(assets.id, assetId))
      .limit(1);

    if (!row) throw new InvoiceCreationError('asset_unknown', 'No such asset.');

    /**
     * An asset submitted by another merchant reads as unknown rather than forbidden.
     *
     * Confirming that an id exists but belongs to someone else leaks the id space, and
     * a custom token's existence can itself be commercially sensitive.
     */
    if (
      row.asset.submittedByOrganizationId !== null &&
      row.asset.submittedByOrganizationId !== organizationId
    ) {
      throw new InvoiceCreationError('asset_unknown', 'No such asset.');
    }

    if (!row.config || !row.config.enabled) {
      throw new InvoiceCreationError(
        'asset_disabled',
        'This asset is not enabled for your account. Enable it before invoicing in it.',
      );
    }

    if (row.asset.verdict !== 'approved') {
      throw new InvoiceCreationError(
        'asset_unapproved',
        `This asset is ${row.asset.verdict} and cannot be invoiced in yet.`,
      );
    }

    /**
     * Telegram Stars are not a chain asset, and the type says so.
     *
     * `Asset.chain` is a `ChainId`, so widening it to hold `telegram` would put Stars in
     * front of every chain adapter, the settlement queue and the gas model — none of which
     * can do anything with them. The cast below is narrowed by this check rather than by
     * hope: a Stars asset never reaches this line.
     *
     * `kind` is what identifies the rail rather than `chain`, because a merchant could in
     * principle name the chain column anything and the kind comes from our own vetting.
     */
    const isStars = row.asset.kind === 'stars';
    if (isStars) {
      return {
        asset: {
          id: row.asset.id,
          chain: TELEGRAM_RAIL,
          symbol: row.asset.symbol,
          decimals: row.asset.decimals,
          kind: 'stars' as const,
        },
        pricingMode: row.config.pricingMode as PricingMode,
        spreadBps: row.config.spreadBps,
        toleranceBps: row.config.toleranceBps,
        fixedRateScaled: row.config.fixedRateScaled,
        fixedRateValidUntil: row.config.fixedRateValidUntil,
        requiresFixedRate: row.asset.requiresFixedRate,
        stars: true as const,
      };
    }

    const asset: Asset = {
      chain: row.asset.chain as Asset['chain'],
      symbol: row.asset.symbol,
      decimals: row.asset.decimals,
      kind: row.asset.kind as Asset['kind'],
      ...(row.asset.contract === null ? {} : { contract: row.asset.contract }),
    };

    return {
      asset: { ...asset, id: row.asset.id },
      pricingMode: row.config.pricingMode as PricingMode,
      spreadBps: row.config.spreadBps,
      toleranceBps: row.config.toleranceBps,
      fixedRateScaled: row.config.fixedRateScaled,
      fixedRateValidUntil: row.config.fixedRateValidUntil,
      requiresFixedRate: row.asset.requiresFixedRate,
      stars: false as const,
    };
  }

  /**
   * The payout address active for this chain, now.
   *
   * Captured onto the invoice rather than looked up at settlement. On EVM chains the
   * deposit address is a hash over it, so a merchant who rotates their wallet must not
   * find that invoices already funded now derive somewhere else.
   */
  private async resolvePayoutAddress(organizationId: string, chain: string): Promise<string> {
    const [row] = await this.db
      .select({ address: payoutAddresses.address })
      .from(payoutAddresses)
      .where(
        and(
          eq(payoutAddresses.organizationId, organizationId),
          eq(payoutAddresses.chain, chain),
          isNull(payoutAddresses.supersededAt),
        ),
      )
      .limit(1);

    if (!row) {
      throw new InvoiceCreationError(
        'no_payout_address',
        `Add a payout address for ${chain} before invoicing on it. Funds can only ever ` +
          'move to an address you configured.',
      );
    }
    return row.address;
  }

  /** Resolve a rate if the mode needs one, then let `createQuote` do the arithmetic. */
  private async buildQuote(
    config: Awaited<ReturnType<InvoiceCreationService['resolveAsset']>>,
    request: CreateInvoiceRequest,
  ) {
    const ttlMs = clampTtl(request.ttlMs);
    let rate: Rate | undefined;
    let sources: string[] = [];

    if (config.pricingMode === 'fiat') {
      /**
       * A market rate, or no invoice.
       *
       * Guessing here would misprice the invoice in a way nobody notices until the
       * merchant reconciles, which is strictly worse for them than being told to
       * retry. The pricing engine already refuses a rate it cannot corroborate across
       * sources; this just declines to work around that.
       */
      try {
        rate = await this.rates.requireRate(config.asset.symbol as PriceSymbol);
        sources = ['aggregate'];
      } catch (error) {
        throw new InvoiceCreationError(
          'price_unavailable',
          `No trustworthy ${config.asset.symbol} price right now, so this invoice cannot be ` +
            'priced. Try again shortly, or invoice in token units.',
        );
      }
    }

    if (config.pricingMode === 'fixed_rate') {
      if (!config.fixedRateScaled) {
        throw new InvoiceCreationError(
          'fixed_rate_required',
          'This asset is priced at a rate you set, and no rate is configured.',
        );
      }
      /**
       * An expired merchant rate is refused rather than reused.
       *
       * A fixed rate is a number nobody is watching the market against. Left to run,
       * it silently misprices every invoice — which is why the expiry is mandatory and
       * why passing it stops invoicing instead of logging a warning.
       */
      if (config.fixedRateValidUntil && config.fixedRateValidUntil.getTime() <= Date.now()) {
        throw new InvoiceCreationError(
          'fixed_rate_expired',
          'Your fixed rate for this asset has expired. Set a current one before invoicing.',
        );
      }
      rate = { priceScaled: BigInt(config.fixedRateScaled), observedAt: Date.now() };
      sources = ['merchant_rate'];
    }

    /**
     * Stars are priced here rather than through `createQuote`.
     *
     * Not a shortcut — `createQuote` takes a chain `Asset`, and Stars are not one. The
     * arithmetic it would apply is the same call this makes directly, so the two agree by
     * using the same function rather than by two implementations happening to match.
     *
     * `fixed_rate` is the only mode Stars can use, because nothing prices them. The rate
     * is the merchant's own, so it takes no spread — the same rule as any other
     * merchant-set rate.
     */
    if (config.stars) {
      if (request.amountFiatMicros === undefined) {
        throw new InvoiceCreationError(
          'amount_invalid',
          'Telegram Stars are priced in fiat. Send amountFiatMicros.',
        );
      }
      /**
       * A missing rate is already refused above, by the `fixed_rate` branch that runs
       * before this one. No second check here: dead code that claims to handle a case is
       * worse than no code, because a reader trusts it.
       */
      if (rate === undefined) {
        throw new InvoiceCreationError('fixed_rate_required', 'No Stars rate is configured.');
      }

      const amountDue = fiatToTokenAmount(request.amountFiatMicros, rate, config.asset.decimals);

      /**
       * The rounding guard `createQuote` applies, applied here too.
       *
       * Stars are whole units, and conversion rounds up so a merchant is never left short.
       * On an asset this coarse that is a real hazard rather than a rounding artefact: at
       * $0.015 a Star, a one-cent invoice rounds up to one Star and the payer is charged
       * 50% more than they owe. My first version guarded `amountDue <= 0n`, which can never
       * fire precisely *because* the conversion rounds up — it was the wrong end of the
       * problem.
       */
      const overhead =
        tokenAmountToFiat(amountDue, rate, config.asset.decimals) - request.amountFiatMicros;
      const allowed = (request.amountFiatMicros * BigInt(DEFAULT_MAX_ROUNDING_BPS)) / 10_000n;
      if (amountDue <= 0n || overhead > allowed) {
        throw new InvoiceCreationError(
          'amount_invalid',
          `Stars are too coarse to price $${(Number(request.amountFiatMicros) / 1e6).toFixed(2)} ` +
            'at your rate: rounding up to a whole Star would overcharge the payer. Invoice a ' +
            'larger amount, or lower your Stars rate.',
        );
      }

      return {
        id: crypto.randomUUID(),
        asset: config.asset,
        mode: 'fixed_rate' as const,
        amountDue,
        marketRate: null,
        effectiveRate: rate,
        spreadBps: 0,
        amountFiatMicros: request.amountFiatMicros,
        createdAt: Date.now(),
        expiresAt: Date.now() + ttlMs,
        sources,
      };
    }

    try {
      const quote = createQuote({
        id: crypto.randomUUID(),
        asset: config.asset as Asset,
        mode: config.pricingMode,
        spreadBps: config.spreadBps,
        ttlMs,
        ...(request.amountFiatMicros === undefined
          ? {}
          : { amountFiatMicros: request.amountFiatMicros }),
        ...(request.amountToken === undefined ? {} : { amountToken: request.amountToken }),
        ...(rate === undefined ? {} : { rate }),
      });
      return { ...quote, sources };
    } catch (error) {
      // `createQuote` refuses a zero amount, a mode/amount mismatch, and an asset too
      // coarse to express the requested value. All are the caller's problem, and its
      // messages already say which.
      if (error instanceof QuoteInputError) {
        throw new InvoiceCreationError('amount_invalid', error.message);
      }
      throw error;
    }
  }
}

function clampTtl(ttlMs: number | undefined): number {
  if (ttlMs === undefined) return DEFAULT_QUOTE_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.floor(ttlMs)));
}

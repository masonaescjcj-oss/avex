import type { CreditOutcome, IncomingPayment, PaymentSink } from '@avex/core';
import { addressKey, foldsAddressCase, requiredConfirmations } from '@avex/core';
import { and, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { assets, invoices, payments, unmatchedPayments } from '../db/schema.js';
import { LATE_PAYMENT_GRACE_MS, assetKeyOf, decidePooled } from './pooled-matching.js';
import type { CandidateInvoice, MatchRule, PriorPayment } from './pooled-matching.js';

/** Mirrors `paymentValueSourceEnum`; guarded by the schema drift test. */
export type PaymentValueSource = 'quote' | 'oracle' | 'merchant_rate' | 'unknown';
import type { AuditService } from './audit.js';
import type { CommissionLedger } from './commission-ledger.js';
import type { RecordUnmatchedInput, UnmatchedReason } from './reconciliation-service.js';
import type { WebhookService } from './webhook-service.js';

/**
 * Where a transfer that belongs to no invoice is put.
 *
 * The reconciliation service satisfies this; the sink only needs the one method, and taking the
 * service itself would hand the watcher process the powers to attach and resolve, which it has
 * no business holding.
 */
export interface UnmatchedQueue {
  record(input: RecordUnmatchedInput): Promise<void>;
}

type InvoiceRow = typeof invoices.$inferSelect;

/** How a transfer came to be credited, for the audit row and the merchant's callback. */
type CreditRule = MatchRule | 'address' | 'memo' | 'replay';

type Target =
  | {
      readonly kind: 'credit';
      readonly invoice: InvoiceRow;
      readonly rule: CreditRule;
      readonly sameAsset: boolean;
    }
  | { readonly kind: 'park'; readonly reason: UnmatchedReason };

/**
 * Credits observed transfers against invoices.
 *
 * Two rules shape everything here.
 *
 * A transfer is identified by where it happened — chain, transaction, position —
 * not by when it was noticed, and the database enforces that with a unique
 * constraint. Re-crediting is impossible rather than merely unlikely.
 *
 * And `amountPaid` is always recomputed from the surviving payment rows, never
 * incremented. A running total that only goes up cannot be corrected when a reorg
 * removes one of its contributions.
 *
 * A third, since shared wallets: nothing here ever stalls the watcher or loses a transfer. A
 * transfer that cannot be attributed is parked in the reconciliation queue and reported as
 * `unmatched`; one that is not yet final is reported as `deferred` so the watcher shows it
 * again; and the rules that decide between invoices live in `pooled-matching` where every
 * scenario is a test.
 */
export class DatabasePaymentSink implements PaymentSink {
  private unmatched: UnmatchedQueue | undefined;

  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly webhooks: WebhookService,
    /**
     * USD value of a token amount.
     *
     * Used for three things now: choosing how many confirmations to require, recording what
     * the payment was worth so platform billing can assess volume, and — when a payer sent the
     * wrong token to a shared wallet — working out how much of the invoiced token it was worth.
     * The second use is why the result is persisted rather than only consulted — see
     * `payments.valueUsdMicros`.
     */
    private readonly valueUsd: (payment: IncomingPayment) => number | Promise<number>,
    /**
     * Where the valuation came from, if the caller can say.
     *
     * Defaults to `unknown`, which counts as nothing towards a volume threshold and is
     * visible as such. A caller that knows better should say so — treating an
     * unpriceable payment as zero silently is bad, but treating it as verified would be
     * worse.
     */
    private readonly valueSource: (payment: IncomingPayment) => PaymentValueSource = () =>
      'unknown',
    /**
     * The commission ledger, optional so the watcher process can run without one.
     *
     * Optional rather than required because two processes construct this sink and only one of
     * them has any business writing to a merchant's balance. Absent, nothing accrues — which is
     * the safe direction: a missed accrual is revenue we have to ask for, while a double one is
     * a merchant billed twice for a sale they made once.
     */
    private readonly ledger?: CommissionLedger | undefined,
  ) {}

  /**
   * Where to put transfers nobody can be credited with.
   *
   * A setter rather than a constructor argument because the queue's own service needs this
   * sink for `recompute`, and one of the two has to be built first. Until it is set, an
   * unattributable transfer throws instead — never silently dropped, because every one is a
   * person who sent money.
   */
  parkUnmatchedIn(queue: UnmatchedQueue): void {
    this.unmatched = queue;
  }

  async credit(payment: IncomingPayment): Promise<CreditOutcome> {
    return this.process(payment, { seenAt: Date.now(), parkedId: null });
  }

  /**
   * Re-examine transfers parked at shared wallets.
   *
   * Invoices settle and expire after a transfer was parked, and what was ambiguous an hour ago
   * may now have one candidate. Each pending stray at a pooled address is decided again by the
   * same rules with the same clock, except that only invoices existing when it was first seen
   * are considered. Whatever is credited is marked attached, with the rule in the note, so an
   * operator reading the queue sees what happened and why.
   */
  async sweepParked(limit = 200): Promise<{ readonly examined: number; readonly credited: number }> {
    const rows = await this.db
      .select()
      .from(unmatchedPayments)
      .where(
        and(
          eq(unmatchedPayments.resolution, 'pending'),
          inArray(unmatchedPayments.reason, ['ambiguous', 'wrong_asset', 'invoice_expired']),
        ),
      )
      .orderBy(unmatchedPayments.seenAt)
      .limit(limit);

    let credited = 0;
    for (const row of rows) {
      if (row.assetId === null) continue;
      const [asset] = await this.db
        .select({
          symbol: assets.symbol,
          contract: assets.contract,
          decimals: assets.decimals,
          kind: assets.kind,
        })
        .from(assets)
        .where(eq(assets.id, row.assetId))
        .limit(1);
      if (!asset) continue;

      const payment: IncomingPayment = {
        chain: row.chain as IncomingPayment['chain'],
        txHash: row.txHash,
        transferIndex: row.transferIndex,
        to: row.toAddress,
        ...(row.fromAddress === null ? {} : { from: row.fromAddress }),
        asset: {
          symbol: asset.symbol,
          chain: row.chain as IncomingPayment['chain'],
          decimals: asset.decimals,
          kind: asset.kind as IncomingPayment['asset']['kind'],
          ...(asset.contract === null ? {} : { contract: asset.contract }),
        },
        amount: BigInt(row.amount),
        blockNumber: row.blockNumber,
        // It was final when it was parked; confirmations are not re-litigated here.
        confirmations: Number.MAX_SAFE_INTEGER,
      };

      try {
        const outcome = await this.process(payment, {
          seenAt: row.seenAt.getTime(),
          parkedId: row.id,
        });
        if (outcome === 'credited' || outcome === 'duplicate') credited += 1;
      } catch {
        // One stray must not stop the rest being looked at; it stays in the queue.
      }
    }
    return { examined: rows.length, credited };
  }

  private async process(
    payment: IncomingPayment,
    context: { readonly seenAt: number; readonly parkedId: string | null },
  ): Promise<CreditOutcome> {
    const target = await this.match(payment, context);
    if (target.kind === 'park') {
      if (context.parkedId === null) await this.park(payment, target.reason);
      return 'unmatched';
    }
    const { invoice } = target;

    /**
     * Valued once, before anything reads it.
     *
     * Three things need this figure — how many confirmations to require, what to record on the
     * payment row, and what commission to accrue — and it now involves a price lookup rather
     * than a constant, so calling it three times would be three lookups that can disagree with
     * each other inside one credit.
     */
    const valuation = await this.valuation(payment);
    const valueUsd = valuation.valueUsdMicros === null
      ? 0
      : Number(BigInt(valuation.valueUsdMicros)) / 1_000_000;

    const needed = requiredConfirmations(payment.chain, valueUsd);
    if (payment.confirmations < needed) {
      // Visible progress for the payer without releasing anything.
      if (invoice.status === 'pending') {
        await this.db
          .update(invoices)
          .set({ status: 'confirming' })
          .where(eq(invoices.id, invoice.id));
      }
      return 'deferred';
    }

    /**
     * What the transfer counts for, in the invoice's own token.
     *
     * The same as the amount when the payer sent the token invoiced. When they sent another —
     * USDC to a USDT invoice on a wallet that takes both — it is what the transfer was worth in
     * the invoiced token at the moment of crediting, so the invoice's total stays a sum in one
     * unit. No price for either side means no conversion, and the transfer is parked as
     * `wrong_asset` for the sweep to try again when the feed is back.
     */
    let creditedAmount: bigint | null = null;
    if (!target.sameAsset) {
      creditedAmount = await this.convert(payment, invoice, valuation.valueUsdMicros);
      if (creditedAmount === null) {
        if (context.parkedId === null) await this.park(payment, 'wrong_asset');
        return 'unmatched';
      }
    }

    const previousStatus = invoice.status;

    const inserted = await this.db
      .insert(payments)
      .values({
        invoiceId: invoice.id,
        chain: payment.chain,
        txHash: payment.txHash,
        transferIndex: payment.transferIndex,
        amount: payment.amount.toString(),
        creditedAmount: creditedAmount === null ? null : creditedAmount.toString(),
        assetSymbol: payment.asset.symbol,
        assetContract: payment.asset.contract ?? null,
        assetDecimals: payment.asset.decimals,
        blockNumber: payment.blockNumber,
        fromAddress: payment.from ?? null,
        ...valuation,
      })
      // The exactly-once guarantee, enforced by the database rather than by
      // remembering to check first.
      .onConflictDoNothing({
        target: [payments.chain, payments.txHash, payments.transferIndex],
      })
      .returning({ id: payments.id });

    if (inserted.length === 0) {
      // Already credited on an earlier pass. A parked copy of it can be closed all the same.
      if (context.parkedId !== null) await this.resolveParked(context.parkedId, invoice.id, target.rule);
      return 'duplicate';
    }

    /**
     * The commission, for the payments where the chain did not take it.
     *
     * Two entries, and only one of them can apply to any invoice. `accruedFeeBps` is non-zero
     * only on a pooled chain, where the payer paid the merchant's own wallet and nothing of
     * ours was in the path — so the commission becomes a debt. `recoveryBps` is non-zero only
     * on an invoice whose fee was raised to collect an earlier debt, and it records what the
     * raise actually collected rather than what it was expected to.
     *
     * After the payment row, deliberately. The unique key on that row is the exactly-once
     * guarantee for the whole of this method, so anything here runs only for a payment being
     * credited for the first time — and the ledger's own unique key on (payment, kind) makes
     * it idempotent again, because "billed twice for one sale" is the failure worth two
     * defences.
     *
     * A payment whose dollar value could not be determined accrues nothing. Guessing at a
     * commission from an unknown value would put a number a merchant cannot check into a
     * balance they are asked to pay.
     */
    if (this.ledger && valuation.valueUsdMicros !== null) {
      const valueUsdMicros = BigInt(valuation.valueUsdMicros);
      if (invoice.accruedFeeBps > 0) {
        await this.ledger.accrue(this.db, {
          organizationId: invoice.organizationId,
          paymentId: inserted[0]!.id,
          invoiceId: invoice.id,
          valueUsdMicros,
          accruedFeeBps: invoice.accruedFeeBps,
        });
      }
      if (invoice.recoveryBps > 0) {
        await this.ledger.recover(this.db, {
          organizationId: invoice.organizationId,
          paymentId: inserted[0]!.id,
          invoiceId: invoice.id,
          valueUsdMicros,
          recoveryBps: invoice.recoveryBps,
        });
      }
    }

    const status = await this.recompute(invoice.id);

    if (context.parkedId !== null) {
      await this.resolveParked(context.parkedId, invoice.id, target.rule);
    }

    await this.audit.record({
      organizationId: invoice.organizationId,
      action: context.parkedId === null ? 'payment.credited' : 'payment.auto_attached',
      targetType: 'invoice',
      targetId: invoice.id,
      metadata: {
        chain: payment.chain,
        txHash: payment.txHash,
        transferIndex: payment.transferIndex,
        amount: payment.amount.toString(),
        asset: payment.asset.symbol,
        ...(creditedAmount === null ? {} : { creditedAmount: creditedAmount.toString() }),
        rule: target.rule,
        blockNumber: payment.blockNumber,
        status,
      },
    });

    // Only on the transition, so a re-scan that changes nothing does not tell the
    // merchant the same news twice.
    if (status !== previousStatus) {
      await this.webhooks.enqueue(invoice.organizationId, `invoice.${status}`, {
        invoiceId: invoice.id,
        reference: invoice.reference,
        /**
         * The mode, and this field is load-bearing rather than informational.
         *
         * A receiver has to be able to refuse a test invoice against a live order,
         * because completing one means shipping goods against a simulated payment. Any
         * sane implementation defaults a missing field to `live` — so leaving it out
         * does not make the check cautious, it makes the check pass. Our own WooCommerce
         * plugin had exactly that hole until this line existed.
         */
        mode: invoice.mode,
        chain: invoice.chain,
        status,
        amountDue: invoice.amountDue,
        amountPaid: await this.amountPaid(invoice.id),
        /**
         * What was actually sent, when it was not the token invoiced. A merchant crediting a
         * customer's balance from `amountPaid` has the figure in the invoiced token; this says
         * the wallet received something else, in case their books care.
         */
        ...(target.sameAsset ? {} : { paidAsset: payment.asset.symbol, paidAmount: payment.amount.toString() }),
        txHash: payment.txHash,
      });
    }

    return 'credited';
  }

  /**
   * The recorded value of a payment, in micro-dollars, with its provenance.
   *
   * Integer micro-dollars from a float USD figure, rounded down. Rounding down means a
   * merchant is never pushed over a billing threshold by a rounding artefact — the
   * direction to be wrong in when the consequence is charging someone.
   */
  private async valuation(payment: IncomingPayment): Promise<{
    valueUsdMicros: string | null;
    valueSource: PaymentValueSource;
  }> {
    const source = this.valueSource(payment);
    let usd: number;
    try {
      usd = await this.valueUsd(payment);
    } catch {
      // A pricing failure must never stop a payment being credited. The merchant's
      // money has arrived; what it was worth in dollars is our bookkeeping problem.
      return { valueUsdMicros: null, valueSource: 'unknown' };
    }

    if (!Number.isFinite(usd) || usd < 0) return { valueUsdMicros: null, valueSource: 'unknown' };
    return { valueUsdMicros: BigInt(Math.floor(usd * 1_000_000)).toString(), valueSource: source };
  }

  /**
   * How much of the invoiced token a transfer in another token was worth.
   *
   * Both sides at the oracle's price now: the transfer's dollar value is already in hand, and
   * the invoiced token's unit price is asked for through the same function with a synthetic
   * one-token payment, so the two figures come from one source at one moment. Null when either
   * is unavailable or nonsensical — never a guess, because this number becomes `amount_paid`.
   */
  private async convert(
    payment: IncomingPayment,
    invoice: InvoiceRow,
    valueUsdMicros: string | null,
  ): Promise<bigint | null> {
    if (valueUsdMicros === null) return null;
    const [asset] = await this.db
      .select({
        symbol: assets.symbol,
        contract: assets.contract,
        decimals: assets.decimals,
        kind: assets.kind,
      })
      .from(assets)
      .where(eq(assets.id, invoice.assetId))
      .limit(1);
    if (!asset) return null;

    let unitUsd: number;
    try {
      unitUsd = await this.valueUsd({
        ...payment,
        asset: {
          symbol: asset.symbol,
          chain: payment.chain,
          decimals: asset.decimals,
          kind: asset.kind as IncomingPayment['asset']['kind'],
          ...(asset.contract === null ? {} : { contract: asset.contract }),
        },
        amount: 10n ** BigInt(asset.decimals),
      });
    } catch {
      return null;
    }
    if (!Number.isFinite(unitUsd) || unitUsd <= 0) return null;
    const unitMicros = BigInt(Math.round(unitUsd * 1_000_000));
    if (unitMicros <= 0n) return null;
    return (BigInt(valueUsdMicros) * 10n ** BigInt(asset.decimals)) / unitMicros;
  }

  async reverse(paymentKey: string, reason: string): Promise<void> {
    const [chain, txHash, transferIndexRaw] = paymentKey.split(':');
    const transferIndex = Number(transferIndexRaw);
    if (!chain || !txHash || !Number.isInteger(transferIndex)) {
      throw new Error(`malformed payment key: ${paymentKey}`);
    }

    const [row] = await this.db
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.chain, chain),
          eq(payments.txHash, txHash),
          eq(payments.transferIndex, transferIndex),
          isNull(payments.reversedAt),
        ),
      )
      .limit(1);
    if (!row) return;

    const [invoice] = await this.db
      .select()
      .from(invoices)
      .where(eq(invoices.id, row.invoiceId))
      .limit(1);

    await this.db
      .update(payments)
      // Marked, not deleted. During an incident, "what did we credit and then take
      // back" is the question being asked, and a deleted row cannot answer it.
      .set({ reversedAt: new Date(), reversedReason: reason })
      .where(eq(payments.id, row.id));

    const status = await this.recompute(row.invoiceId);

    if (invoice) {
      /**
       * The commission goes back with the payment.
       *
       * A reorg took the sale away, so a merchant left owing us a cut of it would be paying for
       * something that did not happen — and they would have no way to notice, because the
       * balance is a number in a panel rather than a line on an invoice. A compensating entry,
       * not a delete: the statement is the record, and a line that vanishes is one nobody can
       * ask about.
       *
       * Only the accrual is undone. A `recovery` on a reversed payment is a different problem —
       * the money was taken on chain by a forwarder we cannot un-deploy — and reversing the
       * ledger entry for it would say we had collected less than we did.
       */
      if (this.ledger) {
        await this.ledger.reverseAccrual(this.db, {
          organizationId: invoice.organizationId,
          paymentId: row.id,
        });
      }

      await this.audit.record({
        organizationId: invoice.organizationId,
        action: 'payment.reversed',
        targetType: 'invoice',
        targetId: invoice.id,
        metadata: { chain, txHash, transferIndex, reason, status },
      });

      // The merchant may already have shipped against a paid callback, so this is
      // the one webhook they most need.
      await this.webhooks.enqueue(invoice.organizationId, 'payment.reversed', {
        invoiceId: invoice.id,
        reference: invoice.reference,
        // Present on every invoice event, so a receiver never has to guess.
        mode: invoice.mode,
        chain,
        txHash,
        reason,
        status,
        amountPaid: await this.amountPaid(invoice.id),
      });
    }
  }

  private async match(
    payment: IncomingPayment,
    context: { readonly seenAt: number; readonly parkedId: string | null },
  ): Promise<Target> {
    // Shared-address chains identify an invoice by memo; everywhere else the
    // deposit address is unique to one invoice.
    if (payment.memo) {
      const [byMemo] = await this.db
        .select()
        .from(invoices)
        .where(and(eq(invoices.chain, payment.chain), eq(invoices.memo, payment.memo)))
        .limit(1);
      if (byMemo) return { kind: 'credit', invoice: byMemo, rule: 'memo', sameAsset: true };
    }

    /**
     * How the address is compared, and why it is not simply `=`.
     *
     * The watcher hands over `toChecksumAddress(...)`, and our own deriver stores the same
     * EIP-55 form, so an exact comparison happens to work today. It stops working the moment
     * a deposit address reaches this table in any other case — a shared-memo wallet typed in
     * by an operator, a row restored from an export, a chain adapter that reports lowercase —
     * and the failure is silent and total: a real transfer to a real invoice matches nothing
     * and goes to reconciliation as unmatched, which reads as the payer never sending it.
     *
     * So the case is folded on hex chains, on both sides rather than trusting either. What
     * this must *not* do is fold on a base58 chain: TRON addresses lose information when
     * lowercased, and two distinct valid ones can fold onto the same string — here that is a
     * payment credited to the wrong merchant's invoice, which is worse than not crediting it.
     * `addressKey` decides; the address book asks it the same question.
     */
    const key = addressKey(payment.chain, payment.to);
    const atAddress = and(
      eq(invoices.chain, payment.chain),
      foldsAddressCase(payment.chain)
        ? sql`lower(${invoices.depositAddress}) = ${key}`
        : eq(invoices.depositAddress, key),
    );

    /**
     * On a pooled invoice the address is not the identity; the exact amount is.
     *
     * Several open invoices share one of the merchant's own wallets, each asking for a slightly
     * different amount. Looking up by address alone — which is what every other model does and
     * what this method did — would return whichever row Postgres found first and credit a
     * stranger's payment to it. That is why this branch exists rather than a comment warning
     * about it.
     *
     * Decided by the rows at this address, not by the chain. It used to ask the registry
     * whether the *chain* was pooled, which made a merchant's own wallet on BNB Chain
     * impossible: the chain said unique, the address held three invoices, and the first row
     * found got the money. Every invoice at one address shares a model — a wallet is never
     * also a forwarder — so one row is enough to ask.
     */
    const [any] = await this.db
      .select({ addressModel: invoices.addressModel })
      .from(invoices)
      .where(atAddress)
      .limit(1);
    if (any === undefined) return { kind: 'park', reason: 'no_matching_address' };
    if (any.addressModel === 'pooled') {
      return this.matchPooled(payment, atAddress, context);
    }

    const [byAddress] = await this.db.select().from(invoices).where(atAddress).limit(1);
    if (!byAddress) return { kind: 'park', reason: 'no_matching_address' };
    if (byAddress.chain !== payment.chain) return { kind: 'park', reason: 'no_matching_address' };
    return { kind: 'credit', invoice: byAddress, rule: 'address', sameAsset: true };
  }

  /**
   * Which invoice a payment to a pooled wallet belongs to.
   *
   * The rules are in `pooled-matching`; this gathers what they need and acts on the answer.
   * What is gathered, and why each is needed:
   *
   *   - every invoice at the address that is open, or closed within the late-payment grace —
   *     the candidates, with their token so a payment in a different one can be recognised;
   *   - every payment credited at the address within the same grace, with its sender — so a
   *     second transfer from the same wallet goes with the first;
   *   - how many other transfers are parked at the address — because two strays and one open
   *     invoice is not "the only candidate", it is two claims on one invoice.
   */
  private async matchPooled(
    payment: IncomingPayment,
    atAddress: SQL | undefined,
    context: { readonly seenAt: number; readonly parkedId: string | null },
  ): Promise<Target> {
    /**
     * A transfer we have already credited belongs where we already credited it.
     *
     * Checked first, and only on this path, because the pooled rules below deliberately look at
     * *recent* invoices — so a re-scanned block range containing a payment that settled its
     * invoice long ago would find nothing, park a transfer we handled correctly weeks ago, and
     * put it in front of an operator as though it were a stranger's. On every other chain the
     * address lookup finds the settled invoice and the payment row's own unique key makes the
     * second credit a no-op; this restores that property here.
     */
    const [already] = await this.db
      .select({ invoiceId: payments.invoiceId })
      .from(payments)
      .where(
        and(
          eq(payments.chain, payment.chain),
          eq(payments.txHash, payment.txHash),
          eq(payments.transferIndex, payment.transferIndex),
        ),
      )
      .limit(1);
    if (already) {
      const [invoice] = await this.db
        .select()
        .from(invoices)
        .where(eq(invoices.id, already.invoiceId))
        .limit(1);
      if (invoice) return { kind: 'credit', invoice, rule: 'replay', sameAsset: true };
    }

    const now = Date.now();
    const graceStart = new Date(now - LATE_PAYMENT_GRACE_MS);

    const rows = await this.db
      .select({
        id: invoices.id,
        amountDue: invoices.amountDue,
        status: invoices.status,
        expiresAt: invoices.expiresAt,
        createdAt: invoices.createdAt,
        symbol: assets.symbol,
        contract: assets.contract,
        decimals: assets.decimals,
      })
      .from(invoices)
      .innerJoin(assets, eq(assets.id, invoices.assetId))
      .where(
        and(
          atAddress,
          or(inArray(invoices.status, ['pending', 'confirming']), gt(invoices.expiresAt, graceStart)),
        ),
      );

    const candidates: CandidateInvoice[] = rows.map((row) => ({
      id: row.id,
      amountDue: BigInt(row.amountDue),
      decimals: row.decimals,
      assetKey: assetKeyOf({ chain: payment.chain, symbol: row.symbol, contract: row.contract }),
      status: row.status,
      expiresAt: row.expiresAt.getTime(),
      createdAt: row.createdAt.getTime(),
    }));

    const priorRows = candidates.length === 0
      ? []
      : await this.db
          .select({
            invoiceId: payments.invoiceId,
            from: payments.fromAddress,
            creditedAt: payments.creditedAt,
          })
          .from(payments)
          .where(
            and(
              inArray(payments.invoiceId, candidates.map((c) => c.id)),
              isNull(payments.reversedAt),
              gt(payments.creditedAt, graceStart),
            ),
          );
    const priorPayments: PriorPayment[] = priorRows.map((row) => ({
      invoiceId: row.invoiceId,
      from: row.from,
      creditedAt: row.creditedAt.getTime(),
    }));

    const decision = decidePooled(
      {
        amount: payment.amount,
        decimals: payment.asset.decimals,
        assetKey: assetKeyOf(payment.asset),
        from: payment.from ?? null,
        seenAt: context.seenAt,
      },
      {
        now,
        candidates,
        priorPayments,
      },
    );

    if (decision.kind === 'park') return decision;

    const [invoice] = await this.db
      .select()
      .from(invoices)
      .where(eq(invoices.id, decision.invoiceId))
      .limit(1);
    if (!invoice) return { kind: 'park', reason: 'ambiguous' };
    return { kind: 'credit', invoice, rule: decision.rule, sameAsset: decision.sameAsset };
  }

  /** Put a transfer in the reconciliation queue, or refuse to lose it. */
  private async park(payment: IncomingPayment, reason: UnmatchedReason): Promise<void> {
    if (this.unmatched === undefined) throw new UnmatchedPaymentError(payment);

    const [asset] = await this.db
      .select({ id: assets.id })
      .from(assets)
      .where(
        and(
          eq(assets.chain, payment.chain),
          payment.asset.contract === undefined
            ? and(isNull(assets.contract), eq(assets.symbol, payment.asset.symbol))
            : sql`lower(${assets.contract}) = ${payment.asset.contract.toLowerCase()}`,
        ),
      )
      .limit(1);

    await this.unmatched.record({
      chain: payment.chain,
      txHash: payment.txHash,
      transferIndex: payment.transferIndex,
      amount: payment.amount,
      toAddress: payment.to,
      fromAddress: payment.from ?? null,
      contract: payment.asset.contract ?? null,
      assetId: asset?.id ?? null,
      memo: payment.memo ?? null,
      blockNumber: payment.blockNumber,
      reason,
    });
  }

  private async resolveParked(unmatchedId: string, invoiceId: string, rule: CreditRule): Promise<void> {
    await this.db
      .update(unmatchedPayments)
      .set({
        resolution: 'attached',
        attachedInvoiceId: invoiceId,
        resolvedAt: new Date(),
        note: `credited automatically: ${rule.replace(/_/g, ' ')}`,
      })
      .where(and(eq(unmatchedPayments.id, unmatchedId), eq(unmatchedPayments.resolution, 'pending')));
  }

  /**
   * What has been paid, in the invoice's own token.
   *
   * `credited_amount` where a payment was in another token, `amount` otherwise.
   */
  private async amountPaid(invoiceId: string): Promise<string> {
    const rows = await this.db
      .select({ amount: payments.amount, creditedAmount: payments.creditedAmount })
      .from(payments)
      .where(and(eq(payments.invoiceId, invoiceId), isNull(payments.reversedAt)));

    return rows
      .reduce((total, row) => total + BigInt(row.creditedAmount ?? row.amount), 0n)
      .toString();
  }

  /**
   * Recompute an invoice's paid total and status from its surviving payments.
   *
   * Summing rather than incrementing is what makes a reversal correct: after a
   * reorg the total has to be able to go down, and a counter that only rises
   * cannot.
   *
   * Public because reconciliation needs it too: an operator attaching an unmatched
   * transfer to an invoice must arrive at the same status the watcher would have.
   * Two implementations of the underpaid/overpaid boundary would be two places to
   * get the tolerance wrong.
   */
  async recompute(invoiceId: string): Promise<string> {
    const [invoice] = await this.db
      .select()
      .from(invoices)
      .where(eq(invoices.id, invoiceId))
      .limit(1);
    if (!invoice) return 'pending';

    const total = BigInt(await this.amountPaid(invoiceId));
    const due = BigInt(invoice.amountDue);
    const tolerance = (due * BigInt(invoice.toleranceBps)) / 10_000n;

    let status: 'pending' | 'confirming' | 'paid' | 'underpaid' | 'overpaid' | 'expired';
    if (total === 0n) {
      /**
       * Back to the start: whatever was seen has been taken back. An invoice that had
       * already expired stays expired — a reversal does not reopen it.
       */
      status = invoice.status === 'expired' ? 'expired' : 'pending';
    } else if (total < due - tolerance) {
      status = 'underpaid';
    } else if (total > due + tolerance) {
      status = 'overpaid';
    } else {
      status = 'paid';
    }

    await this.db
      .update(invoices)
      .set({
        amountPaid: total.toString(),
        status,
        // Recorded once, on the first time it was fully paid.
        paidAt: status === 'paid' && invoice.paidAt === null ? new Date() : invoice.paidAt,
      })
      .where(eq(invoices.id, invoiceId));

    return status;
  }
}

/**
 * Thrown only when no queue has been wired: a transfer nobody can be credited with must never
 * be dropped, and with nowhere to park it the only honest move is to fail loudly.
 */
export class UnmatchedPaymentError extends Error {
  constructor(readonly payment: IncomingPayment) {
    super(
      `no invoice matches ${payment.chain} transfer ${payment.txHash}:${payment.transferIndex} ` +
        `to ${payment.to}${payment.memo ? ` memo ${payment.memo}` : ''}`,
    );
    this.name = 'UnmatchedPaymentError';
  }
}

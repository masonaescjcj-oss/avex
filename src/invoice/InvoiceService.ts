import type { ChainAdapter } from '../chains/ChainAdapter.js';
import { requiredConfirmations } from '../chains/registry.js';
import type { SettlementQueue } from '../sweep/SettlementQueue.js';
import type {
  Asset,
  ChainId,
  IncomingPayment,
  Invoice,
  InvoiceStatus,
} from '../types.js';
import { paymentKey } from '../types.js';

export interface InvoiceStore {
  get(id: string): Promise<Invoice | null>;
  put(invoice: Invoice): Promise<void>;
  findByDepositAddress(chain: ChainId, address: string): Promise<Invoice | null>;
  findByMemo(chain: ChainId, memo: string): Promise<Invoice | null>;
  /** True if this exact transfer has already been credited. */
  hasPayment(key: string): Promise<boolean>;
  recordPayment(key: string, invoiceId: string, amount: bigint): Promise<void>;
  /** Undo a credited transfer, returning the invoice it belonged to. */
  removePayment(key: string): Promise<{ invoiceId: string; amount: bigint } | null>;
}

export interface CreateInvoiceInput {
  readonly id: string;
  readonly merchantId: string;
  readonly asset: Asset;
  readonly amountDue: bigint;
  readonly payoutAddress: string;
  readonly ttlMs: number;
  /** Defaults to 50 bps, which absorbs typical exchange withdrawal rounding. */
  readonly toleranceBps?: number;
}

export type InvoiceEvent =
  | { readonly kind: 'status'; readonly invoice: Invoice; readonly previous: InvoiceStatus }
  | { readonly kind: 'ignored'; readonly reason: string; readonly key: string };

const DEFAULT_TOLERANCE_BPS = 50;

/**
 * Invoice lifecycle: creation, payment matching, finalisation.
 *
 * Two properties matter more than anything else here.
 *
 * Idempotency: every observed transfer is keyed by `chain:txHash:transferIndex`
 * and credited at most once. Watchers re-scan overlapping ranges after restarts
 * and RPC providers replay logs, so a service that credits on every sighting
 * pays merchants twice.
 *
 * Reversibility: a confirmed transfer can vanish in a reorg. `reversePayment`
 * exists so that a credit can be withdrawn, which means `amountPaid` must always
 * be recomputable from recorded payments rather than treated as a running total
 * that only goes up.
 */
export class InvoiceService {
  constructor(
    private readonly store: InvoiceStore,
    private readonly adapters: ReadonlyMap<ChainId, ChainAdapter>,
    private readonly settlementQueue: SettlementQueue,
    /** Converts an on-chain amount to USD, for confirmation tiering. */
    private readonly valueUsd: (asset: Asset, amount: bigint) => number,
  ) {}

  async create(input: CreateInvoiceInput, now: number = Date.now()): Promise<Invoice> {
    const adapter = this.adapters.get(input.asset.chain);
    if (!adapter) throw new Error(`no adapter for chain ${input.asset.chain}`);
    if (input.amountDue <= 0n) throw new Error('amountDue must be positive');

    const target = await adapter.deriveDepositTarget({
      invoiceId: input.id,
      payoutAddress: input.payoutAddress,
      asset: input.asset,
    });

    const invoice: Invoice = {
      id: input.id,
      merchantId: input.merchantId,
      asset: input.asset,
      amountDue: input.amountDue,
      amountPaid: 0n,
      status: 'pending',
      payoutAddress: input.payoutAddress,
      depositAddress: target.address,
      ...(target.memo === undefined ? {} : { memo: target.memo }),
      toleranceBps: input.toleranceBps ?? DEFAULT_TOLERANCE_BPS,
      createdAt: now,
      expiresAt: now + input.ttlMs,
    };

    await this.store.put(invoice);
    return invoice;
  }

  /**
   * Apply an observed transfer. Safe to call repeatedly with the same payment.
   */
  async applyPayment(payment: IncomingPayment): Promise<InvoiceEvent> {
    const key = paymentKey(payment);

    if (await this.store.hasPayment(key)) {
      return { kind: 'ignored', reason: 'already credited', key };
    }

    const invoice = await this.match(payment);
    if (!invoice) {
      // Never guess. An unmatched transfer goes to operator reconciliation.
      return { kind: 'ignored', reason: 'no matching invoice', key };
    }

    if (payment.asset.contract !== invoice.asset.contract) {
      return { kind: 'ignored', reason: 'asset mismatch', key };
    }

    const needed = requiredConfirmations(
      payment.chain,
      this.valueUsd(payment.asset, payment.amount),
    );
    const previous = invoice.status;

    if (payment.confirmations < needed) {
      if (invoice.status === 'pending') {
        invoice.status = 'confirming';
        await this.store.put(invoice);
        return { kind: 'status', invoice, previous };
      }
      return { kind: 'ignored', reason: `awaiting ${needed} confirmations`, key };
    }

    await this.store.recordPayment(key, invoice.id, payment.amount);
    invoice.amountPaid += payment.amount;
    invoice.status = this.classify(invoice);
    await this.store.put(invoice);

    // Only a fully settled invoice releases funds to the merchant. Under- and
    // overpayments need a decision before money moves.
    if (invoice.status === 'paid') {
      this.settlementQueue.enqueue({
        invoiceId: invoice.id,
        depositAddress: invoice.depositAddress,
        payoutAddress: invoice.payoutAddress,
        asset: invoice.asset,
        amount: invoice.amountPaid,
      });
    }

    return { kind: 'status', invoice, previous };
  }

  /** Withdraw a credit whose transaction was reorganised out of the chain. */
  async reversePayment(key: string): Promise<InvoiceEvent> {
    const removed = await this.store.removePayment(key);
    if (!removed) return { kind: 'ignored', reason: 'no such credited payment', key };

    const invoice = await this.store.get(removed.invoiceId);
    if (!invoice) return { kind: 'ignored', reason: 'invoice vanished', key };

    const previous = invoice.status;
    invoice.amountPaid -= removed.amount;
    if (invoice.amountPaid < 0n) invoice.amountPaid = 0n;
    invoice.status = invoice.amountPaid === 0n ? 'pending' : this.classify(invoice);
    await this.store.put(invoice);

    return { kind: 'status', invoice, previous };
  }

  async expire(id: string, now: number = Date.now()): Promise<InvoiceEvent> {
    const invoice = await this.store.get(id);
    if (!invoice) return { kind: 'ignored', reason: 'no such invoice', key: id };
    if (now < invoice.expiresAt) {
      return { kind: 'ignored', reason: 'not yet expired', key: id };
    }
    if (invoice.status !== 'pending' && invoice.status !== 'confirming') {
      return { kind: 'ignored', reason: `status ${invoice.status} is terminal`, key: id };
    }

    const previous = invoice.status;
    invoice.status = 'expired';
    await this.store.put(invoice);
    return { kind: 'status', invoice, previous };
  }

  private async match(payment: IncomingPayment): Promise<Invoice | null> {
    const adapter = this.adapters.get(payment.chain);
    if (!adapter) return null;

    if (adapter.addressModel === 'shared-memo') {
      return payment.memo ? this.store.findByMemo(payment.chain, payment.memo) : null;
    }
    return this.store.findByDepositAddress(payment.chain, payment.to);
  }

  /**
   * Compare paid against due within tolerance.
   *
   * Exact equality is the wrong test: exchanges round withdrawal amounts and
   * some tokens take a fee on transfer, so a strictly equal check rejects
   * payments that were made in good faith.
   */
  private classify(invoice: Invoice): InvoiceStatus {
    const tolerance = (invoice.amountDue * BigInt(invoice.toleranceBps)) / 10_000n;
    if (invoice.amountPaid < invoice.amountDue - tolerance) return 'underpaid';
    if (invoice.amountPaid > invoice.amountDue + tolerance) return 'overpaid';
    return 'paid';
  }
}

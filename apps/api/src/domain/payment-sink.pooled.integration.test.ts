import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import { tronAddressFromEvmHex } from '@avex/core';
import type { Asset, IncomingPayment } from '@avex/core';
import { and, eq } from 'drizzle-orm';

import { createDatabase } from '../db/client.js';
import { assets, invoices, organizations, payments, unmatchedPayments } from '../db/schema.js';
import { AuditService } from './audit.js';
import { CONFIRMING_GRACE_MS, expireInvoices } from './invoice-expiry.js';
import { DatabasePaymentSink } from './payment-sink.js';
import { ReconciliationService } from './reconciliation-service.js';
import { WebhookService } from './webhook-service.js';

/**
 * Crediting a payment that arrived at a shared wallet, end to end.
 *
 * On every other chain the deposit address answers "whose payment is this". On a pooled chain it
 * does not — several of the merchant's invoices are open at one of their own addresses, and the
 * exact amount is what separates them. The rules are unit-tested in `pooled-matching.test.ts`;
 * this file is about what the sink does with a decision: which rows it writes, what it parks,
 * what it converts, and what the sweep and the expiry pass do afterwards.
 *
 * The case that matters most is still the one that must *not* be decided: two invoices open at
 * one address and a payment matching neither. There is nothing on the chain that says which it
 * was for, and crediting either is a coin flip with somebody's money — so it is parked, and
 * credited later only once the other invoice has been paid.
 */
const databaseUrl = process.env.DATABASE_URL;

const tronAddress = (): string => tronAddressFromEvmHex(`0x${randomBytes(20).toString('hex')}`);

const USDT: Asset = {
  symbol: 'USDT',
  chain: 'tron',
  decimals: 6,
  kind: 'trc20',
  contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
};

/** A second stablecoin on the same chain, for the wrong-token cases. Fixture, never curated. */
const USDC: Asset = {
  symbol: 'USDC',
  chain: 'tron',
  decimals: 6,
  kind: 'trc20',
  contract: 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8',
};

const PRICES: Record<string, number> = { USDT: 1, USDC: 1 };

describe('crediting a payment on a pooled chain', { skip: !databaseUrl }, () => {
  let database: ReturnType<typeof createDatabase> | undefined;
  const db = () => database!.db;
  let sink: DatabasePaymentSink;
  let webhooks: WebhookService;
  let orgId = '';
  let assetId = '';
  let usdcAssetId = '';

  before(async () => {
    database = createDatabase(databaseUrl!, { max: 4 });
    const audit = new AuditService(db());
    webhooks = new WebhookService(
      db(),
      // Never dispatched in these tests: crediting enqueues rows, it does not deliver them.
      { deliver: async () => ({ ok: true, status: 200 }) } as never,
      () => {},
    );
    /**
     * A price per symbol, so a payment in the wrong token can be converted. Dollar-pegged at one,
     * which keeps the arithmetic in the assertions readable.
     */
    sink = new DatabasePaymentSink(db(), audit, webhooks, (payment) => {
      const price = PRICES[payment.asset.symbol];
      if (price === undefined) throw new Error(`no price for ${payment.asset.symbol}`);
      return (Number(payment.amount) / 10 ** payment.asset.decimals) * price;
    });
    sink.parkUnmatchedIn(new ReconciliationService(db(), audit, sink));

    const unique = randomBytes(4).toString('hex');
    const [org] = await db()
      .insert(organizations)
      .values({ name: `Sink ${unique}`, slug: `sink-${unique}` })
      .returning({ id: organizations.id });
    orgId = org!.id;

    assetId = await ensureAsset(USDT, true);
    usdcAssetId = await ensureAsset(USDC, false);
  });

  after(async () => {
    await database?.close();
  });

  async function ensureAsset(asset: Asset, curated: boolean): Promise<string> {
    const [existing] = await db()
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.chain, asset.chain), eq(assets.contract, asset.contract!)))
      .limit(1);
    if (existing) return existing.id;
    const [created] = await db()
      .insert(assets)
      .values({
        chain: asset.chain,
        symbol: asset.symbol,
        contract: asset.contract!,
        decimals: asset.decimals,
        kind: asset.kind,
        curated,
        verdict: 'approved',
      })
      .returning({ id: assets.id });
    return created!.id;
  }

  async function openInvoice(
    address: string,
    amountDue: bigint,
    over: Partial<typeof invoices.$inferInsert> = {},
  ): Promise<string> {
    const [row] = await db()
      .insert(invoices)
      .values({
        organizationId: orgId,
        assetId,
        reference: `sink-${randomBytes(5).toString('hex')}`,
        chain: 'tron',
        amountDue: amountDue.toString(),
        amountPaid: '0',
        depositAddress: address,
        payoutAddress: address,
        addressModel: 'pooled',
        status: 'pending',
        mode: 'live',
        // Zero, so an amount that is not exact is visible as underpaid or overpaid rather than
        // absorbed by the default tolerance.
        toleranceBps: 0,
        feeBps: 0,
        expiresAt: new Date(Date.now() + 3_600_000),
        ...over,
      })
      .returning({ id: invoices.id });
    return row!.id;
  }

  let transfer = 0;
  function payment(to: string, amount: bigint, over: Partial<IncomingPayment> = {}): IncomingPayment {
    transfer += 1;
    return {
      chain: 'tron',
      txHash: `0x${randomBytes(32).toString('hex')}`,
      transferIndex: transfer,
      to,
      asset: USDT,
      amount,
      blockNumber: 1000 + transfer,
      // Far past TRON's 19, so matching is what is being tested.
      confirmations: 40,
      ...over,
    };
  }

  const invoiceRow = async (id: string) => {
    const [row] = await db().select().from(invoices).where(eq(invoices.id, id));
    return row!;
  };
  const statusOf = async (id: string): Promise<string> => (await invoiceRow(id)).status;
  const parkedFor = async (p: IncomingPayment) => {
    const [row] = await db()
      .select()
      .from(unmatchedPayments)
      .where(and(eq(unmatchedPayments.txHash, p.txHash), eq(unmatchedPayments.transferIndex, p.transferIndex)));
    return row ?? null;
  };

  test('the exact amount picks its invoice out of several at one address', async () => {
    /**
     * The ordinary case. Three invoices for the same price at the same wallet, differing only
     * in the disambiguator — which is exactly the state the allocator creates.
     */
    const wallet = tronAddress();
    const first = await openInvoice(wallet, 20_001_000n);
    const second = await openInvoice(wallet, 20_002_000n);
    const third = await openInvoice(wallet, 20_003_000n);

    assert.equal(await sink.credit(payment(wallet, 20_002_000n)), 'credited');

    assert.equal(await statusOf(second), 'paid');
    assert.equal(await statusOf(first), 'pending', 'the neighbours must be untouched');
    assert.equal(await statusOf(third), 'pending');
  });

  test('a wrong amount is credited when only one invoice is open there', async () => {
    /**
     * The payer sent the round number — their exchange truncated it, or they typed $20.00
     * because that is the price. One invoice is open at this wallet, so there is no ambiguity
     * about whose payment it is, and refusing it would leave a real payment looking like no
     * payment. Recorded as underpaid, with the shortfall kept — and the merchant is told the
     * amount that arrived, which is what they credit their customer with.
     */
    const wallet = tronAddress();
    const only = await openInvoice(wallet, 20_001_000n);

    assert.equal(await sink.credit(payment(wallet, 20_000_000n)), 'credited');

    const row = await invoiceRow(only);
    assert.equal(row.status, 'underpaid');
    assert.equal(row.amountPaid, '20000000');
  });

  test('an overpayment to a lone invoice is credited too', async () => {
    const wallet = tronAddress();
    const only = await openInvoice(wallet, 20_001_000n);

    await sink.credit(payment(wallet, 25_000_000n));

    assert.equal(await statusOf(only), 'overpaid');
  });

  test('a wrong amount with two invoices open is parked, not guessed', async () => {
    /**
     * The whole reason the design needs a queue. Two payers, one wallet, and a transfer
     * matching neither invoice: nothing on the chain says which of them sent it. Crediting
     * either would be a coin flip, so it is parked — as a row an operator can see, with the
     * sender recorded, not as a log line — and neither invoice moves.
     */
    const wallet = tronAddress();
    const first = await openInvoice(wallet, 20_001_000n);
    const second = await openInvoice(wallet, 20_002_000n);
    const stray = payment(wallet, 20_000_000n, { from: 'TPayerWalletAddressXXXXXXXXXXXXXXX' });

    assert.equal(await sink.credit(stray), 'unmatched');

    assert.equal(await statusOf(first), 'pending', 'neither invoice may move');
    assert.equal(await statusOf(second), 'pending');
    const parked = await parkedFor(stray);
    assert.ok(parked, 'the transfer is in the reconciliation queue');
    assert.equal(parked.reason, 'ambiguous');
    assert.equal(parked.resolution, 'pending');
    assert.equal(parked.fromAddress, stray.from);
    assert.equal(parked.assetId, assetId, 'the token is recorded so the sweep can value it');
  });

  test('the same rules hold on an EVM chain, decided by the row rather than the chain', async () => {
    /**
     * The generalisation. The sink used to ask the registry whether the *chain* was pooled,
     * which made a merchant's wallet on BNB Chain impossible to credit correctly: the chain said
     * unique, three invoices sat at one address, and the first row found got the money. Now the
     * row says what it is, so BNB Chain carries a wallet with three invoices — matched by amount
     * — beside a forwarder address with one, matched by address, and each is right.
     */
    const [bscAsset] = await db()
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.chain, 'bsc'), eq(assets.symbol, 'USDT'), eq(assets.curated, true)))
      .limit(1);
    assert.ok(bscAsset, 'the curated catalogue has USDT on BNB Chain');

    const wallet = `0x${randomBytes(20).toString('hex')}`;
    const forwarder = `0x${randomBytes(20).toString('hex')}`;
    const insert = async (address: string, amountDue: bigint, model: 'pooled' | 'unique') => {
      const [row] = await db()
        .insert(invoices)
        .values({
          organizationId: orgId,
          assetId: bscAsset!.id,
          reference: `bsc-${randomBytes(5).toString('hex')}`,
          chain: 'bsc',
          amountDue: amountDue.toString(),
          amountPaid: '0',
          depositAddress: address,
          payoutAddress: address,
          addressModel: model,
          status: 'pending',
          mode: 'live',
          toleranceBps: 0,
          feeBps: 0,
          expiresAt: new Date(Date.now() + 3_600_000),
        })
        .returning({ id: invoices.id });
      return row!.id;
    };
    const one = 10n ** 18n;
    const first = await insert(wallet, 20n * one + 10n ** 15n, 'pooled'); // 20.001
    const second = await insert(wallet, 20n * one + 2n * 10n ** 15n, 'pooled'); // 20.002
    const third = await insert(wallet, 20n * one + 3n * 10n ** 15n, 'pooled'); // 20.003
    const derived = await insert(forwarder, 20n * one, 'unique');

    const bscUsdt = { ...USDT, chain: 'bsc' as const, decimals: 18 };
    const pay = (to: string, amount: bigint) => ({
      ...payment(to, amount),
      chain: 'bsc' as const,
      asset: bscUsdt,
    });

    // The exact amount picks its row out of the three at the wallet.
    await sink.credit(pay(wallet, 20n * one + 2n * 10n ** 15n));
    assert.equal(await statusOf(second), 'paid');
    assert.equal(await statusOf(first), 'pending');
    assert.equal(await statusOf(third), 'pending');

    // A wrong amount with two still open is nobody's until an operator says so.
    const stray = pay(wallet, 20n * one);
    assert.equal(await sink.credit(stray), 'unmatched');
    assert.equal((await parkedFor(stray))?.reason, 'ambiguous');

    // And the forwarder invoice on the same chain is still matched by address, any amount.
    await sink.credit(pay(forwarder, 20n * one + 12345n));
    assert.equal(await statusOf(derived), 'overpaid');
  });

  test('a payment to a pooled wallet with nothing recent is parked for a person', async () => {
    /**
     * A payer whose invoice expired days ago. Still their money, and still a human's problem:
     * crediting an invoice that old automatically would let a transfer arriving long after
     * reopen an order the merchant has already closed.
     */
    const wallet = tronAddress();
    await openInvoice(wallet, 20_007_000n, {
      status: 'expired',
      expiresAt: new Date(Date.now() - 3 * 24 * 3_600_000),
    });

    const stray = payment(wallet, 20_007_000n);
    assert.equal(await sink.credit(stray), 'unmatched');
    assert.equal((await parkedFor(stray))?.reason, 'invoice_expired');
  });

  test('a late payer who sent the exact amount is credited to the invoice that expired', async () => {
    /**
     * The invoice lapsed an hour ago; the pool kept its number reserved for the day, so nothing
     * else at this wallet asks for 20.004. The money is that payer's and that merchant's, and
     * the merchant hears `invoice.paid` for an order they may have to reopen — which is the
     * truth, and better than the money sitting in a queue.
     */
    const wallet = tronAddress();
    const late = await openInvoice(wallet, 20_004_000n, {
      status: 'expired',
      expiresAt: new Date(Date.now() - 3_600_000),
    });
    const other = await openInvoice(wallet, 20_005_000n);

    assert.equal(await sink.credit(payment(wallet, 20_004_000n)), 'credited');
    assert.equal(await statusOf(late), 'paid');
    assert.equal(await statusOf(other), 'pending');
  });

  test('a paid invoice keeps claiming its amount for a day', async () => {
    /**
     * Once an invoice is paid its number stays reserved for a day, so a second transfer for that
     * exact amount is still *its* payment — a payer who paid twice, which the merchant refunds —
     * and is never credited to the other invoice open on the wallet.
     */
    const wallet = tronAddress();
    const done = await openInvoice(wallet, 20_008_000n, { status: 'paid', amountPaid: '20008000' });
    const stillOpen = await openInvoice(wallet, 20_009_000n);

    const second = payment(wallet, 20_008_000n);
    assert.equal(await sink.credit(second), 'credited');
    const [row] = await db().select({ invoiceId: payments.invoiceId }).from(payments).where(eq(payments.txHash, second.txHash));
    assert.equal(row!.invoiceId, done, 'the second payment lands on the paid invoice');
    assert.equal(await statusOf(stillOpen), 'pending', 'the other invoice must not be touched');
  });

  test('the right amount in the wrong token is credited by value', async () => {
    /**
     * The payer chose USDT and sent USDC to the same wallet. The number identifies the invoice;
     * the value settles it. The payment row keeps what actually arrived, and `credited_amount`
     * carries what it was worth in the invoiced token, so `amount_paid` stays a sum in one unit.
     */
    const wallet = tronAddress();
    const first = await openInvoice(wallet, 20_001_000n);
    const second = await openInvoice(wallet, 20_002_000n);

    const inUsdc = payment(wallet, 20_002_000n, { asset: USDC });
    assert.equal(await sink.credit(inUsdc), 'credited');

    const row = await invoiceRow(second);
    assert.equal(row.status, 'paid');
    assert.equal(row.amountPaid, '20002000');
    assert.equal(await statusOf(first), 'pending');

    const [recorded] = await db().select().from(payments).where(eq(payments.txHash, inUsdc.txHash));
    assert.equal(recorded!.assetSymbol, 'USDC');
    assert.equal(recorded!.amount, '20002000', 'what arrived');
    assert.equal(recorded!.creditedAmount, '20002000', 'what it was worth in USDT');
  });

  test('the wrong token with one invoice open is credited to it, by value', async () => {
    const wallet = tronAddress();
    const only = await openInvoice(wallet, 20_001_000n);

    assert.equal(await sink.credit(payment(wallet, 20_000_000n, { asset: USDC })), 'credited');
    const row = await invoiceRow(only);
    assert.equal(row.status, 'underpaid');
    assert.equal(row.amountPaid, '20000000');
  });

  test('a top-up from the wallet that underpaid an invoice goes with the first', async () => {
    /**
     * A's payer sent too little while A was the only invoice, so it was credited as underpaid.
     * B opens. The same wallet now sends the rest: it belongs with A, not with B — though B
     * is the only invoice still open.
     */
    const wallet = tronAddress();
    const a = await openInvoice(wallet, 20_001_000n);
    const payer = 'TPayerWalletAddressYYYYYYYYYYYYYYYY';

    await sink.credit(payment(wallet, 15_000_000n, { from: payer }));
    assert.equal(await statusOf(a), 'underpaid');
    const b = await openInvoice(wallet, 20_002_000n);

    assert.equal(await sink.credit(payment(wallet, 5_001_000n, { from: payer })), 'credited');
    assert.equal(await statusOf(a), 'paid');
    assert.equal(await statusOf(b), 'pending');
  });

  test('a comment names the invoice, even when another one asks for the exact amount', async () => {
    /**
     * TON is the one chain where the payer says which invoice they are paying, and this is
     * why that is better than any amount rule: the comment is read before the amount, so it
     * decides even against an invoice whose figure matches exactly. Two invoices on one
     * wallet, a transfer for B's amount carrying A's comment — it is A's, because A's payer
     * is the one who was shown that comment.
     *
     * The sink's memo branch predates TON being watchable at all; nothing had ever written a
     * memo onto a pooled row, so nothing exercised it against amount matching.
     */
    const wallet = tronAddress();
    /**
     * Unique per run, because the memo column is uniquely indexed for exactly the reason
     * this test is about: two invoices with one comment could not be told apart. A fixed
     * fixture passed the first time and collided with itself on the second.
     */
    const memo = `AVEX-${randomBytes(6).toString('hex').toUpperCase()}`;
    const a = await openInvoice(wallet, 20_001_000n, { memo });
    const b = await openInvoice(wallet, 20_002_000n);

    const outcome = await sink.credit(payment(wallet, 20_002_000n, { memo }));

    assert.equal(outcome, 'credited');
    assert.equal(await statusOf(a), 'overpaid', 'the comment won, and A was overpaid');
    assert.equal(await statusOf(b), 'pending', 'B is still waiting for its own payer');
  });

  test('a comment nobody issued falls through to the amount rules', async () => {
    /**
     * A payer who typed something of their own into the comment field, or an exchange that
     * put a reference of its own there. The memo matches no invoice, so it is ignored and
     * the exact amount decides — rather than the payment being parked because a field
     * nobody asked them to fill in was filled in wrongly.
     */
    const wallet = tronAddress();
    const only = await openInvoice(wallet, 20_001_000n);

    const outcome = await sink.credit(
      payment(wallet, 20_001_000n, { memo: 'order 55 for mum' }),
    );

    assert.equal(outcome, 'credited');
    assert.equal(await statusOf(only), 'paid');
  });

  test('a payment with no comment at all is still credited by its amount', async () => {
    // The fallback that makes a forgotten comment a matched payment rather than a lost one.
    const wallet = tronAddress();
    const only = await openInvoice(wallet, 20_001_000n, {
      memo: `AVEX-${randomBytes(6).toString('hex').toUpperCase()}`,
    });

    assert.equal(await sink.credit(payment(wallet, 20_001_000n)), 'credited');
    assert.equal(await statusOf(only), 'paid');
  });

  test('a repeat customer whose earlier invoice is settled is paying the new one', async () => {
    /**
     * The merchant's own report. One wallet paid invoice A a cent over; three hours later it
     * paid new invoice B, a cent over again, on an otherwise idle wallet — and the money went
     * to A, an order already settled, because "same sender" outranked "only invoice open".
     * A settled invoice is not something anybody tops up.
     */
    const wallet = tronAddress();
    const a = await openInvoice(wallet, 911_000n);
    const payer = 'TPayerWalletAddressYYYYYYYYYYYYYYYY';

    await sink.credit(payment(wallet, 921_000n, { from: payer }));
    assert.equal(await statusOf(a), 'overpaid');
    const b = await openInvoice(wallet, 1_012_000n);

    assert.equal(await sink.credit(payment(wallet, 1_022_000n, { from: payer })), 'credited');
    assert.equal(await statusOf(b), 'overpaid');
    assert.equal((await invoiceRow(b)).amountPaid, '1022000');
    assert.equal((await invoiceRow(a)).amountPaid, '921000', 'A is left exactly as it was');
  });

  test('a transfer not yet final is deferred, and the invoice shows it coming', async () => {
    /**
     * The sink says `deferred` rather than pretending; the watcher holds its cursor and shows
     * the transfer again. Nothing is written except the visible progress for the payer.
     */
    const wallet = tronAddress();
    const only = await openInvoice(wallet, 20_001_000n);
    const early = payment(wallet, 20_001_000n, { confirmations: 1 });

    assert.equal(await sink.credit(early), 'deferred');
    assert.equal(await statusOf(only), 'confirming');
    assert.equal((await db().select().from(payments).where(eq(payments.txHash, early.txHash))).length, 0);

    assert.equal(await sink.credit({ ...early, confirmations: 40 }), 'credited');
    assert.equal(await statusOf(only), 'paid');
  });

  test('once the other invoice is paid exactly, the sweep credits the survivor with the stray', async () => {
    /**
     * The merchant's scenario. Two invoices open, one payer types the amount wrong: parked. The
     * other payer pays exactly. Now the wrongly-typed transfer has one invoice it could be for —
     * one that existed when it arrived — and the sweep credits it there, marks the queue row
     * attached, and says which rule did it.
     */
    const wallet = tronAddress();
    const a = await openInvoice(wallet, 20_001_000n);
    const b = await openInvoice(wallet, 20_002_000n);

    const stray = payment(wallet, 19_500_000n);
    assert.equal(await sink.credit(stray), 'unmatched');
    assert.equal((await sink.sweepParked()).credited, 0, 'still two candidates');

    await sink.credit(payment(wallet, 20_001_000n));
    assert.equal(await statusOf(a), 'paid');

    const swept = await sink.sweepParked();
    assert.ok(swept.credited >= 1);
    assert.equal(await statusOf(b), 'underpaid');
    assert.equal((await invoiceRow(b)).amountPaid, '19500000');

    const parked = await parkedFor(stray);
    assert.equal(parked?.resolution, 'attached');
    assert.equal(parked?.attachedInvoiceId, b);
    assert.match(parked?.note ?? '', /sole open/);
  });

  test('the sweep leaves a stray alone when a fresh invoice is the only thing open', async () => {
    /**
     * Both original invoices expired unpaid; a new invoice was then issued on the wallet. It
     * cannot be what the stray's payer was paying, however alone it is, and the stray stays for
     * a person.
     */
    const wallet = tronAddress();
    await openInvoice(wallet, 20_001_000n);
    await openInvoice(wallet, 20_002_000n);
    const stray = payment(wallet, 19_500_000n);
    assert.equal(await sink.credit(stray), 'unmatched');

    await db()
      .update(invoices)
      .set({ status: 'expired', expiresAt: new Date(Date.now() - 2 * 3_600_000) })
      .where(eq(invoices.depositAddress, wallet));
    const fresh = await openInvoice(wallet, 20_003_000n);

    await sink.sweepParked();
    assert.equal((await parkedFor(stray))?.resolution, 'pending');
    assert.equal(await statusOf(fresh), 'pending');
  });
});

describe('closing invoices whose time has run out', { skip: !databaseUrl }, () => {
  let database: ReturnType<typeof createDatabase> | undefined;
  const db = () => database!.db;
  let webhooks: WebhookService;
  let orgId = '';
  let assetId = '';

  before(async () => {
    database = createDatabase(databaseUrl!, { max: 2 });
    webhooks = new WebhookService(db(), { deliver: async () => ({ ok: true, status: 200 }) } as never, () => {});
    const unique = randomBytes(4).toString('hex');
    const [org] = await db()
      .insert(organizations)
      .values({ name: `Expiry ${unique}`, slug: `expiry-${unique}` })
      .returning({ id: organizations.id });
    orgId = org!.id;
    const [usdt] = await db()
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.chain, 'tron'), eq(assets.contract, USDT.contract!)))
      .limit(1);
    assetId = usdt!.id;
  });

  after(async () => {
    await database?.close();
  });

  async function invoiceWith(status: 'pending' | 'confirming' | 'paid', expiresAt: Date): Promise<string> {
    const address = tronAddress();
    const [row] = await db()
      .insert(invoices)
      .values({
        organizationId: orgId,
        assetId,
        reference: `exp-${randomBytes(5).toString('hex')}`,
        chain: 'tron',
        amountDue: '20001000',
        amountPaid: '0',
        depositAddress: address,
        payoutAddress: address,
        addressModel: 'pooled',
        status,
        mode: 'live',
        toleranceBps: 0,
        feeBps: 0,
        expiresAt,
      })
      .returning({ id: invoices.id });
    return row!.id;
  }
  const statusOf = async (id: string) =>
    (await db().select({ status: invoices.status }).from(invoices).where(eq(invoices.id, id)))[0]!.status;
  const referenceActiveOf = async (id: string) =>
    (
      await db()
        .select({ active: invoices.referenceActive })
        .from(invoices)
        .where(eq(invoices.id, id))
    )[0]!.active;

  test('a pending invoice past its deadline is expired; one still inside it is not', async () => {
    const past = await invoiceWith('pending', new Date(Date.now() - 60_000));
    const live = await invoiceWith('pending', new Date(Date.now() + 3_600_000));

    const expired = await expireInvoices(db(), webhooks);
    assert.ok(expired >= 1);
    assert.equal(await statusOf(past), 'expired');
    assert.equal(await statusOf(live), 'pending');
  });

  test('expiry releases the merchant’s reference, and never takes it back', async () => {
    /**
     * The order can be invoiced again once its invoice has died — which is what lets a shop
     * send a customer back to pay after their window closed. The flag is separate from the
     * status because it must not come back on: an expired invoice can still be credited by a
     * late payment, and a `paid` row re-claiming a reference a newer invoice already holds is
     * a unique-index collision on the path that records somebody's money.
     */
    const past = await invoiceWith('pending', new Date(Date.now() - 60_000));
    const live = await invoiceWith('pending', new Date(Date.now() + 3_600_000));

    await expireInvoices(db(), webhooks);
    assert.equal(await referenceActiveOf(past), false);
    assert.equal(await referenceActiveOf(live), true, 'a live invoice keeps its reference');

    // The late credit, as the sink writes it.
    await db().update(invoices).set({ status: 'paid' }).where(eq(invoices.id, past));
    assert.equal(await referenceActiveOf(past), false, 'being paid does not re-claim it');
  });

  test('a confirming invoice is given a day past its deadline before it is given up on', async () => {
    /**
     * Money was seen and is waiting for the chain. Expiring it in that window would make the
     * credit that follows land on an expired invoice; a day later, the transfer was reorganised
     * out and never came back.
     */
    const waiting = await invoiceWith('confirming', new Date(Date.now() - 3_600_000));
    const abandoned = await invoiceWith('confirming', new Date(Date.now() - CONFIRMING_GRACE_MS - 60_000));
    const paid = await invoiceWith('paid', new Date(Date.now() - 3_600_000));

    await expireInvoices(db(), webhooks);
    assert.equal(await statusOf(waiting), 'confirming');
    assert.equal(await statusOf(abandoned), 'expired');
    assert.equal(await statusOf(paid), 'paid', 'a settled invoice is never touched');
  });
});

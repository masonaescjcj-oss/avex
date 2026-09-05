import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import { tronAddressFromEvmHex } from '@avex/core';
import type { Asset, IncomingPayment } from '@avex/core';
import { and, eq } from 'drizzle-orm';

import { createDatabase } from '../db/client.js';
import { assets, invoices, organizations } from '../db/schema.js';
import { AuditService } from './audit.js';
import { DatabasePaymentSink, UnmatchedPaymentError } from './payment-sink.js';
import { WebhookService } from './webhook-service.js';

/**
 * Crediting a payment that arrived at a shared wallet.
 *
 * On every other chain the deposit address answers "whose payment is this". On a pooled chain it
 * does not — several of the merchant's invoices are open at one of their own addresses, and the
 * exact amount is what separates them. So this file is about the three cases the amount produces
 * and about which of them may be decided without a human.
 *
 * The case that matters most is the one that must *not* be decided: two invoices open at one
 * address and a payment matching neither. There is nothing on the chain that says which it was
 * for, and crediting either is a coin flip with somebody's money.
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

describe('crediting a payment on a pooled chain', { skip: !databaseUrl }, () => {
  let database: ReturnType<typeof createDatabase> | undefined;
  const db = () => database!.db;
  let sink: DatabasePaymentSink;
  let orgId = '';
  let assetId = '';

  before(async () => {
    database = createDatabase(databaseUrl!, { max: 4 });
    const audit = new AuditService(db());
    const webhooks = new WebhookService(
      db(),
      // Never dispatched in these tests: crediting enqueues rows, it does not deliver them.
      { deliver: async () => ({ ok: true, status: 200 }) } as never,
      () => {},
    );
    /**
     * Confirmations reported as satisfied by valuing every payment at zero.
     *
     * TRON needs 19, and this file is about matching rather than about finality. A payment held
     * as `confirming` would leave every assertion below testing the same thing.
     */
    sink = new DatabasePaymentSink(db(), audit, webhooks, () => 0);

    const unique = randomBytes(4).toString('hex');
    const [org] = await db()
      .insert(organizations)
      .values({ name: `Sink ${unique}`, slug: `sink-${unique}` })
      .returning({ id: organizations.id });
    orgId = org!.id;

    const [existing] = await db()
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.chain, 'tron'), eq(assets.symbol, 'USDT'), eq(assets.curated, true)))
      .limit(1);
    if (existing) {
      assetId = existing.id;
    } else {
      const [created] = await db()
        .insert(assets)
        .values({
          chain: 'tron',
          symbol: 'USDT',
          contract: USDT.contract!,
          decimals: 6,
          kind: 'trc20',
          curated: true,
          verdict: 'approved',
        })
        .returning({ id: assets.id });
      assetId = created!.id;
    }
  });

  after(async () => {
    await database?.close();
  });

  async function openInvoice(address: string, amountDue: bigint): Promise<string> {
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
      })
      .returning({ id: invoices.id });
    return row!.id;
  }

  let transfer = 0;
  function payment(to: string, amount: bigint): IncomingPayment {
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
    };
  }

  const statusOf = async (id: string): Promise<string> => {
    const [row] = await db()
      .select({ status: invoices.status, amountPaid: invoices.amountPaid })
      .from(invoices)
      .where(eq(invoices.id, id));
    return row!.status;
  };

  test('the exact amount picks its invoice out of several at one address', async () => {
    /**
     * The ordinary case. Three invoices for the same price at the same wallet, differing only
     * in the disambiguator — which is exactly the state the allocator creates.
     */
    const wallet = tronAddress();
    const first = await openInvoice(wallet, 20_000_001n);
    const second = await openInvoice(wallet, 20_000_002n);
    const third = await openInvoice(wallet, 20_000_003n);

    await sink.credit(payment(wallet, 20_000_002n));

    assert.equal(await statusOf(second), 'paid');
    assert.equal(await statusOf(first), 'pending', 'the neighbours must be untouched');
    assert.equal(await statusOf(third), 'pending');
  });

  test('a wrong amount is credited when only one invoice is open there', async () => {
    /**
     * The payer sent the round number — their exchange truncated it, or they typed $20.00
     * because that is the price. One invoice is open at this wallet, so there is no ambiguity
     * about whose payment it is, and refusing it would leave a real payment looking like no
     * payment. Recorded as underpaid, with the shortfall kept.
     */
    const wallet = tronAddress();
    const only = await openInvoice(wallet, 20_000_004n);

    await sink.credit(payment(wallet, 20_000_000n));

    assert.equal(await statusOf(only), 'underpaid');
  });

  test('an overpayment to a lone invoice is credited too', async () => {
    const wallet = tronAddress();
    const only = await openInvoice(wallet, 20_000_004n);

    await sink.credit(payment(wallet, 25_000_000n));

    assert.equal(await statusOf(only), 'overpaid');
  });

  test('a wrong amount with two invoices open is refused, not guessed', async () => {
    /**
     * The whole reason the design needs an admin queue. Two payers, one wallet, and a transfer
     * matching neither invoice: nothing on the chain says which of them sent it. Crediting
     * either would be a coin flip, so this raises `UnmatchedPaymentError` — which is what puts
     * it in front of an operator, where the payer's support ticket can be matched to it.
     */
    const wallet = tronAddress();
    const first = await openInvoice(wallet, 20_000_005n);
    const second = await openInvoice(wallet, 20_000_006n);

    await assert.rejects(
      sink.credit(payment(wallet, 20_000_000n)),
      (error: unknown) => error instanceof UnmatchedPaymentError,
    );

    assert.equal(await statusOf(first), 'pending', 'neither invoice may move');
    assert.equal(await statusOf(second), 'pending');
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
    const first = await insert(wallet, 20n * one + 10n ** 16n, 'pooled'); // 20.01
    const second = await insert(wallet, 20n * one + 2n * 10n ** 16n, 'pooled'); // 20.02
    const third = await insert(wallet, 20n * one + 3n * 10n ** 16n, 'pooled'); // 20.03
    const derived = await insert(forwarder, 20n * one, 'unique');

    const bscUsdt = { ...USDT, chain: 'bsc' as const, decimals: 18 };
    const pay = (to: string, amount: bigint) => ({
      ...payment(to, amount),
      chain: 'bsc' as const,
      asset: bscUsdt,
    });

    // The exact amount picks its row out of the three at the wallet.
    await sink.credit(pay(wallet, 20n * one + 2n * 10n ** 16n));
    assert.equal(await statusOf(second), 'paid');
    assert.equal(await statusOf(first), 'pending');
    assert.equal(await statusOf(third), 'pending');

    // A wrong amount with two still open is nobody's until an operator says so.
    await assert.rejects(
      sink.credit(pay(wallet, 20n * one)),
      (error: unknown) => error instanceof UnmatchedPaymentError,
    );

    // And the forwarder invoice on the same chain is still matched by address, any amount.
    await sink.credit(pay(forwarder, 20n * one + 12345n));
    assert.equal(await statusOf(derived), 'overpaid');
  });

  test('a payment to a pooled wallet with nothing open is refused', async () => {
    /**
     * Most often a payer whose invoice expired while they were away. Still their money, and
     * still a human's problem: crediting an expired invoice automatically would let a transfer
     * arriving days later reopen an order the merchant has already closed.
     */
    const wallet = tronAddress();
    const expired = await openInvoice(wallet, 20_000_007n);
    await db().update(invoices).set({ status: 'expired' }).where(eq(invoices.id, expired));

    await assert.rejects(
      sink.credit(payment(wallet, 20_000_007n)),
      (error: unknown) => error instanceof UnmatchedPaymentError,
    );
  });

  test('a paid invoice does not keep claiming its amount', async () => {
    /**
     * Once an invoice is settled its amount is released back to the allocator, so a second
     * payment for that same amount is no longer *its* payment. Two invoices at one wallet, the
     * first already paid: a transfer for the paid invoice's amount must not be credited to it a
     * second time, and must not be credited to the other one either.
     */
    const wallet = tronAddress();
    const done = await openInvoice(wallet, 20_000_008n);
    const stillOpen = await openInvoice(wallet, 20_000_009n);
    await db().update(invoices).set({ status: 'paid' }).where(eq(invoices.id, done));

    /**
     * One invoice remains open here, so rule two applies and the payment is credited to it as a
     * wrong-amount payment. That is the correct outcome and worth asserting rather than
     * assuming: it is the merchant's own wallet, one order is outstanding, and a human would
     * reach the same conclusion.
     */
    await sink.credit(payment(wallet, 20_000_008n));
    assert.equal(await statusOf(stillOpen), 'underpaid');
    assert.equal(await statusOf(done), 'paid', 'the settled invoice must not be touched');
  });
});

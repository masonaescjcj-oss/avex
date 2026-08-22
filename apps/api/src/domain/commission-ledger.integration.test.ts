import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import { tronAddressFromEvmHex } from '@avex/core';
import type { Asset, IncomingPayment } from '@avex/core';
import { and, eq } from 'drizzle-orm';

import { createDatabase } from '../db/client.js';
import { assets, invoices, organizations, payments } from '../db/schema.js';
import { AuditService } from './audit.js';
import { CommissionLedger } from './commission-ledger.js';
import { DatabasePaymentSink } from './payment-sink.js';
import { WebhookService } from './webhook-service.js';

/**
 * The commission on a chain that takes nothing, and how it comes back.
 *
 * The whole cycle, against the real database: a payment on a pooled chain leaves the merchant
 * owing 0.5% of it, and a later invoice on a chain that *can* take a cut collects some of it.
 * Both halves are money, and both are invisible in the ordinary case — a balance is a number in
 * a panel rather than a line on a bill — so they are asserted rather than assumed.
 */
const databaseUrl = process.env.DATABASE_URL;

const USDT_TRON: Asset = {
  symbol: 'USDT',
  chain: 'tron',
  decimals: 6,
  kind: 'trc20',
  contract: 'TWKxbjHnf3EY3mZvYUcaLLxLBnMhqUXsQ4',
};

const USDT_BSC: Asset = {
  symbol: 'USDT',
  chain: 'bsc',
  decimals: 18,
  kind: 'erc20',
  contract: '0x00000000000000000000000000000000000a0b0c2',
};

describe('the commission ledger, end to end', { skip: !databaseUrl }, () => {
  let database: ReturnType<typeof createDatabase> | undefined;
  const db = () => database!.db;
  let ledger: CommissionLedger;
  let sink: DatabasePaymentSink;
  let orgId = '';
  const assetFor = new Map<string, string>();

  before(async () => {
    database = createDatabase(databaseUrl!, { max: 4 });
    ledger = new CommissionLedger(db());
    const audit = new AuditService(db());
    const webhooks = new WebhookService(
      db(),
      { deliver: async () => ({ ok: true, status: 200 }) } as never,
      () => {},
    );
    /**
     * Every payment valued at a dollar per whole token, so the arithmetic in the assertions is
     * legible: a 20-token payment is worth $20. A real price source here would make every
     * expected figure depend on the market.
     */
    sink = new DatabasePaymentSink(
      db(),
      audit,
      webhooks,
      (payment) => Number(payment.amount) / 10 ** payment.asset.decimals,
      () => 'oracle',
      ledger,
    );

    const unique = randomBytes(4).toString('hex');
    const [org] = await db()
      .insert(organizations)
      .values({ name: `Ledger ${unique}`, slug: `ledger-${unique}` })
      .returning({ id: organizations.id });
    orgId = org!.id;

    /**
     * Found by contract, and never marked curated.
     *
     * `curated` decides whether a row appears in the admin catalogue as one whose issuer we have
     * checked. A fixture claiming it shows up there with a null issuer, which broke the
     * catalogue test in a suite that had nothing to do with this one.
     */
    for (const asset of [USDT_TRON, USDT_BSC]) {
      const [existing] = await db()
        .select({ id: assets.id })
        .from(assets)
        .where(and(eq(assets.chain, asset.chain), eq(assets.contract, asset.contract!)))
        .limit(1);
      if (existing) {
        assetFor.set(asset.chain, existing.id);
        continue;
      }
      const [created] = await db()
        .insert(assets)
        .values({
          chain: asset.chain,
          symbol: asset.symbol,
          contract: asset.contract!,
          decimals: asset.decimals,
          kind: asset.kind,
          curated: false,
          verdict: 'approved',
        })
        .returning({ id: assets.id });
      assetFor.set(asset.chain, created!.id);
    }
  });

  after(async () => {
    await database?.close();
  });

  let nth = 0;
  async function openInvoice(input: {
    readonly asset: Asset;
    readonly address: string;
    readonly amountDue: bigint;
    readonly accruedFeeBps?: number;
    readonly feeBps?: number;
    readonly recoveryBps?: number;
  }): Promise<string> {
    const [row] = await db()
      .insert(invoices)
      .values({
        organizationId: orgId,
        assetId: assetFor.get(input.asset.chain)!,
        reference: `led-${randomBytes(5).toString('hex')}`,
        chain: input.asset.chain,
        amountDue: input.amountDue.toString(),
        amountPaid: '0',
        depositAddress: input.address,
        payoutAddress: input.address,
        status: 'pending',
        mode: 'live',
        toleranceBps: 0,
        feeBps: input.feeBps ?? 0,
        // Required by `invoices_fee_has_destination` whenever a fee is charged on chain.
        feeDestination: (input.feeBps ?? 0) > 0 ? input.address : null,
        accruedFeeBps: input.accruedFeeBps ?? 0,
        recoveryBps: input.recoveryBps ?? 0,
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning({ id: invoices.id });
    return row!.id;
  }

  function payment(asset: Asset, to: string, amount: bigint): IncomingPayment {
    nth += 1;
    return {
      chain: asset.chain,
      txHash: `0x${randomBytes(32).toString('hex')}`,
      transferIndex: nth,
      to,
      asset,
      amount,
      blockNumber: 5000 + nth,
      confirmations: 99,
    };
  }

  test('a pooled payment leaves the merchant owing the commission', async () => {
    const wallet = tronAddressFromEvmHex(`0x${randomBytes(20).toString('hex')}`);
    await openInvoice({
      asset: USDT_TRON,
      address: wallet,
      amountDue: 20_000_001n,
      accruedFeeBps: 50,
    });

    const before = await ledger.balance(orgId);
    await sink.credit(payment(USDT_TRON, wallet, 20_000_001n));
    const after = await ledger.balance(orgId);

    // 0.5% of $20.000001, floored: 100_000 micro-dollars, and the balance goes *down*.
    assert.equal(before - after, 100_000n);
    assert.ok(after < 0n, 'the balance is negative: the merchant owes us');
  });

  test('crediting the same payment twice does not bill twice', async () => {
    /**
     * A re-scanned block range, a retried job, a reorg that restores what it removed: the same
     * transfer arrives here again, and the merchant must not be charged for one sale twice. Two
     * defences — the payment row's own unique key, and the ledger's on (payment, kind) — and this
     * asserts the outcome rather than either mechanism.
     */
    const wallet = tronAddressFromEvmHex(`0x${randomBytes(20).toString('hex')}`);
    await openInvoice({
      asset: USDT_TRON,
      address: wallet,
      amountDue: 30_000_001n,
      accruedFeeBps: 50,
    });
    const incoming = payment(USDT_TRON, wallet, 30_000_001n);

    const before = await ledger.balance(orgId);
    await sink.credit(incoming);
    const once = await ledger.balance(orgId);
    /**
     * The second credit must be a no-op rather than an error.
     *
     * Note what it is exercising: by now the invoice is `paid`, so the pooled rules — which look
     * at open invoices — find nothing, and without the already-credited check this raises
     * `UnmatchedPaymentError` and a correctly handled payment lands in an operator's queue.
     */
    await sink.credit(incoming);
    const twice = await ledger.balance(orgId);

    assert.equal(before - once, 150_000n);
    assert.equal(once, twice, 'the second credit must move nothing');
  });

  test('a reversed payment gives the commission back', async () => {
    /**
     * A reorg took the sale away. A merchant left owing a cut of it would be paying for
     * something that did not happen, and would have no way to notice.
     */
    const wallet = tronAddressFromEvmHex(`0x${randomBytes(20).toString('hex')}`);
    await openInvoice({
      asset: USDT_TRON,
      address: wallet,
      amountDue: 40_000_001n,
      accruedFeeBps: 50,
    });
    const incoming = payment(USDT_TRON, wallet, 40_000_001n);

    const before = await ledger.balance(orgId);
    await sink.credit(incoming);
    assert.equal(before - (await ledger.balance(orgId)), 200_000n);

    await sink.reverse(
      `${incoming.chain}:${incoming.txHash}:${incoming.transferIndex}`,
      'reorg',
    );
    assert.equal(await ledger.balance(orgId), before, 'the balance returns to where it was');
  });

  test('an invoice on a fee-bearing chain collects what its raised fee took', async () => {
    /**
     * The other half. `recovery_bps` is committed to the deposit address, and what it collects
     * depends on what the payer actually sent — so the entry is written from the payment, not
     * from the plan. Here a $100 payment at 200bps of recovery returns $2 to the balance.
     */
    /**
     * A fresh forwarder address per run. `invoices_chain_deposit_key` is unique on (chain,
     * deposit_address) for EVM chains — correctly, since the address *is* the invoice there —
     * so a fixed one passes once and then collides with its own row forever.
     */
    const forwarder = `0xAbC${randomBytes(18).toString('hex').slice(0, 35).padEnd(35, '0')}`;
    await openInvoice({
      asset: USDT_BSC,
      address: forwarder,
      amountDue: 100_000_000_000_000_000_000n,
      feeBps: 250,
      recoveryBps: 200,
    });

    const before = await ledger.balance(orgId);
    await sink.credit(payment(USDT_BSC, forwarder, 100_000_000_000_000_000_000n));
    const after = await ledger.balance(orgId);

    assert.equal(after - before, 2_000_000n, '2% of $100, credited back to the merchant');
  });

  test('an underpaid recovery invoice collects less, not the planned amount', async () => {
    /**
     * The reason the entry is written at credit time. An invoice quoted at $100 that is paid $60
     * recovers 40% less, and a balance that recorded the plan would show money we never took.
     */
    const forwarder = `0xAbC${randomBytes(18).toString('hex').slice(0, 35).padEnd(35, '0')}`;
    await openInvoice({
      asset: USDT_BSC,
      address: forwarder,
      amountDue: 100_000_000_000_000_000_000n,
      feeBps: 250,
      recoveryBps: 200,
    });

    const before = await ledger.balance(orgId);
    await sink.credit(payment(USDT_BSC, forwarder, 60_000_000_000_000_000_000n));
    assert.equal((await ledger.balance(orgId)) - before, 1_200_000n, '2% of $60');
  });

  test('a human entry needs a reason', async () => {
    await assert.rejects(
      ledger.record({
        organizationId: orgId,
        kind: 'settlement',
        amountUsdMicros: 1_000_000n,
        staffId: randomBytes(16).toString('hex'),
        note: '   ',
      }),
      /needs a reason/,
    );
  });

  test('the credit limit closes pooled invoicing, and only when it is passed', async () => {
    const [org] = await db()
      .insert(organizations)
      .values({
        name: `Limit ${randomBytes(4).toString('hex')}`,
        slug: `limit-${randomBytes(4).toString('hex')}`,
      })
      .returning({ id: organizations.id });
    const limited = org!.id;

    assert.equal(await ledger.withinCreditLimit(limited), true);

    /**
     * $499 owed is inside the limit and $501 is not — asserted either side of the boundary
     * rather than at one point, because an off-by-one here either lets a merchant accrue past
     * the ceiling or refuses business from one who is inside it.
     */
    await db()
      .insert((await import('../db/schema.js')).commissionLedger)
      .values({
        organizationId: limited,
        kind: 'adjustment',
        amountUsdMicros: (-499_000_000n).toString(),
        note: 'test fixture',
      });
    assert.equal(await ledger.withinCreditLimit(limited), true);

    await db()
      .insert((await import('../db/schema.js')).commissionLedger)
      .values({
        organizationId: limited,
        kind: 'adjustment',
        amountUsdMicros: (-2_000_000n).toString(),
        note: 'test fixture',
      });
    assert.equal(await ledger.withinCreditLimit(limited), false);
  });

  test('a payment whose value is unknown accrues nothing', async () => {
    /**
     * Pricing can fail, and the sink credits the payment anyway — the merchant's money arrived,
     * and what it was worth is our bookkeeping problem. What must not happen is a commission
     * computed from a value nobody could determine: the merchant would be billed a number they
     * cannot check.
     */
    const audit = new AuditService(db());
    const webhooks = new WebhookService(
      db(),
      { deliver: async () => ({ ok: true, status: 200 }) } as never,
      () => {},
    );
    const blind = new DatabasePaymentSink(
      db(),
      audit,
      webhooks,
      () => {
        throw new Error('no price');
      },
      () => 'unknown',
      ledger,
    );

    const wallet = tronAddressFromEvmHex(`0x${randomBytes(20).toString('hex')}`);
    const invoiceId = await openInvoice({
      asset: USDT_TRON,
      address: wallet,
      amountDue: 50_000_001n,
      accruedFeeBps: 50,
    });

    const before = await ledger.balance(orgId);
    await blind.credit(payment(USDT_TRON, wallet, 50_000_001n));
    assert.equal(await ledger.balance(orgId), before, 'no accrual from an unknown value');

    // And the payment itself was still credited, which is the point.
    const rows = await db().select().from(payments).where(eq(payments.invoiceId, invoiceId));
    assert.equal(rows.length, 1);
  });
});

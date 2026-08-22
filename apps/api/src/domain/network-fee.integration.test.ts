import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import { tronAddressFromEvmHex } from '@avex/core';
import type { ChainId, GasSnapshot } from '@avex/core';
import { eq } from 'drizzle-orm';

import { createDatabase, schema } from '../db/client.js';
import { AuditService } from './audit.js';
import { ChainMinimums } from './chain-minimums.js';
import { CheckoutService } from './checkout-service.js';
import { CommissionLedger } from './commission-ledger.js';
import { DepositAddressDeriver } from './deposit-address.js';
import { FeePlanService } from './fee-plan-service.js';
import type { GasOracle } from './gas-oracle.js';
import { InvoiceCreationError, InvoiceCreationService } from './invoice-creation.js';
import { WalletPoolService } from './wallet-pool-service.js';

/**
 * The payer pays for the transfer: a $20 order is issued for $20.10.
 *
 * The arithmetic is tested where it lives — `FeePolicy.networkFeeBps` and `applyFeePayer` — so
 * what is left here is the part no unit test can see: that the charge survives the whole path
 * with the same value at every stop. Three things have to line up, and each of them has failed
 * in this codebase before.
 *
 * The address has to commit to it. The deposit address is a hash over the forwarder's
 * constructor arguments, one of which is the fee rate, so an invoice that asks for the extra ten
 * cents without putting the rate in the address would hand the extra to the merchant and leave
 * our gas wallet paying — a surcharge that moves money from a payer to a merchant.
 *
 * The checkout has to quote what invoice creation will charge. The two computed the surcharge
 * separately once and disagreed by exactly this kind of margin, which shows a payer $20.00 and
 * then asks them for $20.10 — indistinguishable from a scam.
 *
 * And it has to be excluded from revenue, because it is a reimbursement of gas rather than a
 * margin. Counted as income, the business would look more profitable the more expensive the
 * chains became.
 */
const databaseUrl = process.env.DATABASE_URL;

const FACTORY = '0x00000000000000000000000000000000000f4c70';
const CREATION_CODE = '0x60806040523480156100115760006000fd5b50';
const FEE_COLLECTOR = '0x3333333333333333333333333333333333333333';

/** 0.1 gwei with BNB at $600: 400,000 gas is 2.4 cents, which is 12bps of a $20 invoice. */
const BSC_SNAPSHOT: GasSnapshot = {
  chain: 'bsc',
  nativePriceUsd: 600,
  feePerGasWei: 100_000_000n,
  observedAt: 0,
};

/** A gas oracle with no network in it, and a switch so a probe failure can be tested too. */
class StubOracle implements GasOracle {
  up = true;
  asked: ChainId[] = [];

  async snapshot(chain: ChainId): Promise<GasSnapshot | null> {
    this.asked.push(chain);
    if (!this.up) return null;
    return chain === 'bsc' ? BSC_SNAPSHOT : null;
  }
}

describe('charging the payer for the transfer', { skip: databaseUrl ? false : 'DATABASE_URL is not set' }, () => {
  let database: ReturnType<typeof createDatabase> | undefined;
  const db = () => database!.db;
  let oracle: StubOracle;
  let feePlans: FeePlanService;
  let invoices: InvoiceCreationService;
  let checkouts: CheckoutService;
  let deriver: DepositAddressDeriver;
  let orgId: string;
  let userId: string;
  let bscAssetId: string;
  let tronAssetId: string;

  /** A dollar rate for every symbol, so an amount is a straight conversion. */
  const rates = {
    async requireRate() {
      return { priceScaled: 10n ** 18n, observedAt: Date.now() };
    },
  };

  before(async () => {
    database = createDatabase(databaseUrl!, { max: 4 });
    const audit = new AuditService(db());
    oracle = new StubOracle();

    feePlans = new FeePlanService(db(), audit, {
      feeCollectors: { bsc: FEE_COLLECTOR },
      ledger: new CommissionLedger(db()),
      gas: oracle,
    });

    deriver = new DepositAddressDeriver(
      {
        evm: { bsc: { factory: FACTORY, forwarderCreationCode: CREATION_CODE } },
        shared: {},
        pooled: ['tron'],
      },
      'network-fee-suite-memo-secret',
    );

    const pool = new WalletPoolService(db());
    const minimums = new ChainMinimums(oracle);
    invoices = new InvoiceCreationService(
      db(),
      deriver,
      feePlans,
      rates,
      audit,
      new CommissionLedger(db()),
      pool,
      minimums,
    );
    checkouts = new CheckoutService(
      db(),
      invoices,
      feePlans,
      deriver,
      rates,
      audit,
      undefined,
      minimums,
    );

    const unique = randomBytes(5).toString('hex');
    const [org] = await db()
      .insert(schema.organizations)
      .values({ name: `Net ${unique}`, slug: `net-${unique}` })
      .returning({ id: schema.organizations.id });
    orgId = org!.id;

    const [user] = await db()
      .insert(schema.users)
      .values({ email: `net-${unique}@example.test`, passwordHash: 'x' })
      .returning({ id: schema.users.id });
    userId = user!.id;
    await db()
      .insert(schema.memberships)
      .values({ organizationId: orgId, userId, role: 'owner' });

    await feePlans.ensureForOrganization(orgId);

    bscAssetId = await enableAsset('bsc', 18);
    tronAssetId = await enableAsset('tron', 6);

    await db().insert(schema.payoutAddresses).values([
      {
        organizationId: orgId,
        chain: 'bsc',
        address: `0x${randomBytes(20).toString('hex')}`,
        createdByUserId: userId,
      },
      /**
       * TRON needs one too, even though nothing ever moves to it.
       *
       * A pooled invoice's funds arrive in the merchant's own deposit wallet and stay there, so
       * this column is a record of where the money was meant to go rather than an instruction —
       * and invoice creation still refuses without it, which is the right refusal: an invoice
       * whose payout address is unknown is one nobody could reconcile.
       */
      {
        organizationId: orgId,
        chain: 'tron',
        address: tronAddressFromEvmHex(`0x${randomBytes(20).toString('hex')}`),
        createdByUserId: userId,
      },
    ]);
    await pool.register({
      organizationId: orgId,
      chain: 'tron',
      address: tronAddressFromEvmHex(`0x${randomBytes(20).toString('hex')}`),
    });
  });

  after(async () => {
    await database?.close();
  });

  async function enableAsset(chain: string, decimals: number): Promise<string> {
    const [asset] = await db()
      .insert(schema.assets)
      .values({
        chain,
        symbol: 'USDT',
        contract:
          chain === 'tron'
            ? tronAddressFromEvmHex(`0x${randomBytes(20).toString('hex')}`)
            : `0x${randomBytes(20).toString('hex')}`,
        decimals,
        kind: 'erc20',
        verdict: 'approved',
        probedAt: new Date(),
      })
      .returning({ id: schema.assets.id });

    await db().insert(schema.merchantAssets).values({
      organizationId: orgId,
      assetId: asset!.id,
      enabled: true,
      pricingMode: 'fiat',
      toleranceBps: 50,
      /**
       * No spread, so the token amount is the dollar amount and every figure below is readable.
       *
       * The default is fifty basis points, which would make a $20 order 20.1005 USDT before any
       * fee is applied — and then a test asserting "the payer is asked for 2.4 cents more than
       * the price" would be asserting against the spread as well as the surcharge.
       */
      spreadBps: 0,
    });
    return asset!.id;
  }

  const actor = () => ({ userId, apiKeyId: null });

  /** $20, in micro-dollars. */
  const TWENTY = 20_000_000n;

  async function createInvoice(assetId: string, reference: string) {
    const { invoice } = await invoices.create(
      orgId,
      { assetId, reference, amountFiatMicros: TWENTY },
      actor(),
    );
    return invoice;
  }

  test('a $20 invoice asks for the settlement cost on top', async () => {
    const invoice = await createInvoice(bscAssetId, `net-${randomBytes(4).toString('hex')}`);

    /**
     * 12 basis points of network fee on top of the 50 the merchant's plan charges.
     *
     * The plan's own 50bps is absorbed by the merchant here — nobody set `feePayer` — so the
     * whole of the difference between $20 and what is asked for is the transfer.
     */
    assert.equal(invoice.networkFeeBps, 12);
    assert.equal(invoice.feeBps, 62, 'the plan rate plus the transfer, in one on-chain split');
    assert.equal(invoice.feePayer, 'merchant', 'the *commission* is still the merchant’s');

    /**
     * 12 basis points of $20 is 2.4 cents, and the commission is not in this figure.
     *
     * Which is the point of the whole exercise: the merchant absorbs their 50bps out of the
     * settlement, and the payer covers the 2.4 cents it costs to send that settlement.
     */
    const surcharge = BigInt(invoice.amountDue) - 20n * 10n ** 18n;
    assert.ok(surcharge > 20_000_000_000_000_000n, `expected over 2 cents, got ${surcharge}`);
    assert.ok(surcharge < 30_000_000_000_000_000n, `expected under 3 cents, got ${surcharge}`);
  });

  test('the deposit address commits to the fee that includes it', async () => {
    /**
     * Which is what makes the surcharge reach us rather than the merchant. The forwarder splits
     * `feeBps` of whatever arrives; the address is a hash over that rate, so an address derived
     * for 50bps cannot deliver 62 and the money would sit in a contract nobody can deploy.
     */
    const invoice = await createInvoice(bscAssetId, `addr-${randomBytes(4).toString('hex')}`);

    const withNetworkFee = deriver.derive({
      invoiceId: invoice.id,
      chain: 'bsc',
      payoutAddress: invoice.payoutAddress,
      fee: { feeDestination: FEE_COLLECTOR, feeBps: invoice.feeBps },
      mode: 'live',
    });
    const withoutIt = deriver.derive({
      invoiceId: invoice.id,
      chain: 'bsc',
      payoutAddress: invoice.payoutAddress,
      fee: { feeDestination: FEE_COLLECTOR, feeBps: invoice.feeBps - invoice.networkFeeBps },
      mode: 'live',
    });

    assert.equal(invoice.depositAddress.toLowerCase(), withNetworkFee.address.toLowerCase());
    assert.notEqual(
      withNetworkFee.address.toLowerCase(),
      withoutIt.address.toLowerCase(),
      'the two rates must be two addresses, or the commitment means nothing',
    );
  });

  test('the checkout quotes the amount the invoice will ask for', async () => {
    /**
     * The drift guard. These are two code paths computing one number, and the failure mode is a
     * payer shown one figure and charged another.
     */
    const { session } = await checkouts.create(orgId, { amountFiatMicros: TWENTY }, actor());
    const options = await checkouts.options(session.id);
    const offered = options.find((option) => option.chain === 'bsc');
    assert.ok(offered, 'BSC must be on offer');
    assert.equal(offered.available, true);

    const { invoice } = await checkouts.select(session.id, bscAssetId);
    assert.ok(invoice, 'the selection must produce an invoice');
    assert.equal(offered.amount, invoice.amountDue, 'quoted, then charged, the same');

    // And the two disclosed lines add up to what was added to the price.
    assert.equal(offered.networkFeeBps, 12);
    assert.equal(offered.feeBps, 0, 'the merchant absorbs their commission here');
    assert.equal(
      BigInt(invoice.networkFeeIncluded) + BigInt(invoice.feeIncluded),
      BigInt(invoice.amountDue) - 20n * 10n ** 18n,
      'the breakdown must sum to the surcharge',
    );
  });

  test('a pooled chain charges nothing for a transfer it does not make', async () => {
    /**
     * TRON's deposit address is one of the merchant's own wallets, so the payer's transfer is
     * the only transaction there is. The commission is still billed — as a balance — but there
     * is no gas to reimburse, and the cheap chain is visibly cheaper to the payer.
     */
    const invoice = await createInvoice(tronAssetId, `tron-${randomBytes(4).toString('hex')}`);

    assert.equal(invoice.networkFeeBps, 0);
    assert.equal(invoice.feeBps, 0, 'nothing is taken on chain');
    assert.equal(invoice.accruedFeeBps, 50, 'and the commission is billed instead');
  });

  test('a gas probe that fails costs the merchant nothing and the payer nothing', async () => {
    /**
     * The failure direction that matters. This runs inside the request that opens an invoice, so
     * an unreachable node must not fail the sale — we absorb the gas, exactly as we did before
     * any of this existed.
     */
    oracle.up = false;
    try {
      const invoice = await createInvoice(bscAssetId, `down-${randomBytes(4).toString('hex')}`);
      assert.equal(invoice.networkFeeBps, 0);
      assert.equal(invoice.feeBps, 50, 'the plan rate alone');
      assert.equal(BigInt(invoice.amountDue), 20n * 10n ** 18n, 'and the payer is asked the price');
    } finally {
      oracle.up = true;
    }
  });

  test('an order too small to carry its own settlement is refused', async () => {
    /**
     * The floor, enforced for the first time. A $2 order on BNB Chain recovers its 2.4 cents
     * from the payer and earns a penny of commission — which is fine until the chain is three
     * times dearer when we come to settle, and then the penny is all there is against seven
     * cents of gas.
     *
     * Refused rather than quietly repriced: the merchant asked for a $2 invoice, and turning it
     * into a $12 one without saying so would be worse than saying no.
     */
    await assert.rejects(
      invoices.create(
        orgId,
        { assetId: bscAssetId, reference: `min-${randomBytes(4).toString('hex')}`, amountFiatMicros: 2_000_000n },
        actor(),
      ),
      (error: unknown) =>
        error instanceof InvoiceCreationError &&
        error.code === 'amount_below_minimum' &&
        // The figure has to be in the message: "too small" without a number is unactionable.
        /\$12\.00/.test(error.message) &&
        /TRON/.test(error.message),
    );
  });

  test('the same order on a chain that settles directly is fine', async () => {
    /**
     * Which is the answer the refusal above points at, and the reason the floor is per chain
     * rather than a number in the pricing page. On TRON the payer's transfer lands in the
     * merchant's own wallet: there is no settlement, so there is nothing a small order could
     * fail to carry.
     */
    const invoice = await invoices.create(
      orgId,
      { assetId: tronAssetId, reference: `small-${randomBytes(4).toString('hex')}`, amountFiatMicros: 2_000_000n },
      actor(),
    );
    assert.equal(invoice.created, true);
    assert.equal(invoice.invoice.networkFeeBps, 0);
  });

  test('a payer is never offered a network that would refuse them', async () => {
    /**
     * The two checks are the same check, reached from two places, and this is what would break
     * if they drifted: a payer taps BNB Chain, and the invoice creation behind the tap answers
     * 422. They would have no idea what they did wrong, because they did nothing wrong.
     */
    const { session } = await checkouts.create(orgId, { amountFiatMicros: 2_000_000n }, actor());
    const options = await checkouts.options(session.id);

    const bsc = options.find((option) => option.chain === 'bsc');
    assert.ok(bsc);
    assert.equal(bsc.available, false);
    assert.match(bsc.unavailableReason ?? '', /costs too much to settle/);

    // Shown rather than hidden, and the cheap chain is still there to be picked.
    const tron = options.find((option) => option.chain === 'tron');
    assert.ok(tron);
    assert.equal(tron.available, true);
  });

  test('a gas probe that fails refuses nothing either', async () => {
    /**
     * The same direction as the fee: an unreachable RPC endpoint must not turn into a floor
     * nobody can clear. We take the order and carry the risk, because the alternative is a
     * third party's bad minute closing a merchant's shop.
     */
    oracle.up = false;
    try {
      const invoice = await invoices.create(
        orgId,
        { assetId: bscAssetId, reference: `blind-${randomBytes(4).toString('hex')}`, amountFiatMicros: 2_000_000n },
        actor(),
      );
      assert.equal(invoice.created, true);
      assert.equal(invoice.invoice.networkFeeBps, 0);
    } finally {
      oracle.up = true;
    }
  });

  test('the network fee is not counted as commission earned', async () => {
    /**
     * It reimburses the gas wallet for a transaction we are about to send. Counted as revenue,
     * every gas spike would look like a good quarter.
     */
    const invoice = await createInvoice(bscAssetId, `rev-${randomBytes(4).toString('hex')}`);

    await db().insert(schema.payments).values({
      invoiceId: invoice.id,
      chain: 'bsc',
      txHash: `0x${randomBytes(32).toString('hex')}`,
      transferIndex: 0,
      amount: invoice.amountDue,
      // $20.024 of value, which is what the payer sent.
      valueUsdMicros: '20024000',
      valueSource: 'quote',
      blockNumber: 1,
    });

    const earned = await feePlans.commissionEarned({ organizationId: orgId });

    /**
     * 50 basis points of $20.024 is about ten cents. The whole 62 would be about 12.4, so the
     * assertion is that the figure is the commission and not the total.
     */
    assert.ok(earned.creditedUsdMicros >= 100_000n, `expected ~10c, got ${earned.creditedUsdMicros}`);
    assert.ok(earned.creditedUsdMicros < 110_000n, `expected ~10c, got ${earned.creditedUsdMicros}`);
  });
});

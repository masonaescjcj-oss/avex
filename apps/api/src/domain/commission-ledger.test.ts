import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  disclosedFees,
  payerFeeBps,
  RECOVERY_MAX_BPS,
  recoveryBpsFor,
  surchargeBps,
} from './commission-ledger.js';
import { MAX_FEE_BPS } from './fee-plan-service.js';

/**
 * How much of a balance one invoice may collect.
 *
 * The rule as it was asked for was "if they are $10 down and pay $20 on BEP-20, take our $10".
 * That is 5000 basis points, and it cannot happen: `Forwarder.MAX_FEE_BPS` is 500, enforced by
 * the contract rather than by our policy, and the contract says why — a forwarder that could be
 * constructed to take everything would make the immutability guarantee worthless, because the
 * address would commit to a number and the number could be 10000. So a large balance is
 * collected over several invoices, and the enforcement that actually gets us paid is the credit
 * limit that stops new pooled invoices.
 *
 * These are the three ceilings, each of which costs somebody money if it is wrong.
 */
describe('sizing a balance recovery', () => {
  const PLAN = 50; // 0.5%, the standard rate.

  test('nothing is recovered from an account in good standing', () => {
    for (const balance of [0n, 1_000_000n, 999_999_999n]) {
      assert.equal(
        recoveryBpsFor({
          balanceUsdMicros: balance,
          planFeeBps: PLAN,
          invoiceValueUsdMicros: 20_000_000n,
        }),
        0,
      );
    }
  });

  test('a small balance is collected in full from one invoice', () => {
    /**
     * $0.02 owed against a $20 invoice: 10 basis points collects exactly that, which is inside
     * every cap. This is the ordinary case — a merchant taking a mix of chains never accumulates
     * more than a few cents before an EVM invoice clears it.
     */
    const bps = recoveryBpsFor({
      balanceUsdMicros: -20_000n,
      planFeeBps: PLAN,
      invoiceValueUsdMicros: 20_000_000n,
    });
    assert.equal(bps, 10);
    // And it collects what was owed, not more.
    assert.equal((20_000_000n * BigInt(bps)) / 10_000n, 20_000n);
  });

  test('the ask in the original design is capped, and by a long way', () => {
    /**
     * $10 owed, a $20 invoice. Taking it would be 5000bps — ten times what the contract permits
     * and twenty-five times what we would charge. The invoice collects 2% and the rest stays on
     * the balance.
     */
    const bps = recoveryBpsFor({
      balanceUsdMicros: -10_000_000n,
      planFeeBps: PLAN,
      invoiceValueUsdMicros: 20_000_000n,
    });
    assert.equal(bps, RECOVERY_MAX_BPS);
    assert.equal((20_000_000n * BigInt(bps)) / 10_000n, 400_000n, '40 cents of the $10');
    assert.ok(PLAN + bps <= MAX_FEE_BPS, 'and still inside what the forwarder will deploy');
  });

  test('the contract ceiling wins over our own cap', () => {
    /**
     * A merchant on a negotiated 4% has only 1% of headroom before the forwarder reverts, so the
     * recovery is 100bps rather than 200 — and a merchant already at the ceiling recovers
     * nothing at all, because an invoice that cannot be deployed collects less than one that
     * charges the plain rate.
     */
    assert.equal(
      recoveryBpsFor({
        balanceUsdMicros: -10_000_000n,
        planFeeBps: 400,
        invoiceValueUsdMicros: 20_000_000n,
      }),
      100,
    );
    assert.equal(
      recoveryBpsFor({
        balanceUsdMicros: -10_000_000n,
        planFeeBps: MAX_FEE_BPS,
        invoiceValueUsdMicros: 20_000_000n,
      }),
      0,
    );
  });

  test('a recovery never turns the balance positive', () => {
    /**
     * Rounded down, so an invoice can under-collect by a few micro-dollars but never over-
     * collect. Over-collecting would mean we owe the merchant money — a refund nobody asked for,
     * on a balance they were not watching.
     */
    for (const owed of [1n, 7n, 99n, 12_345n, 1_000_001n]) {
      const bps = recoveryBpsFor({
        balanceUsdMicros: -owed,
        planFeeBps: PLAN,
        invoiceValueUsdMicros: 20_000_000n,
      });
      const collected = (20_000_000n * BigInt(bps)) / 10_000n;
      assert.ok(collected <= owed, `collected ${collected} against ${owed} owed`);
    }
  });

  test('an invoice with no dollar value recovers nothing', () => {
    /**
     * An invoice priced in token units has no fiat figure at creation. A recovery is a fraction
     * of a dollar amount, so there is nothing to take a fraction of — and inventing a conversion
     * here would put a figure on the invoice that the merchant would never be shown.
     */
    assert.equal(
      recoveryBpsFor({
        balanceUsdMicros: -10_000_000n,
        planFeeBps: PLAN,
        invoiceValueUsdMicros: 0n,
      }),
      0,
    );
  });

  test('a tiny invoice against a large balance still only gives what it can', () => {
    // A $1 invoice at 2% collects two cents. The point is that it terminates at the cap rather
    // than producing an enormous rate for a small invoice.
    const bps = recoveryBpsFor({
      balanceUsdMicros: -500_000_000n,
      planFeeBps: PLAN,
      invoiceValueUsdMicros: 1_000_000n,
    });
    assert.equal(bps, RECOVERY_MAX_BPS);
    assert.equal((1_000_000n * BigInt(bps)) / 10_000n, 20_000n);
  });
});

/**
 * What the payer is told, and what it adds up to.
 *
 * Three rates now share one invoice — the commission, a balance recovery, and the cost of the
 * transfer — and they are charged to different people. Getting the split wrong does not fail
 * loudly: it produces a checkout whose lines do not sum to its total, which a payer reads as a
 * scam rather than as arithmetic.
 */
describe('disclosing the fee to the payer', () => {
  const AMOUNT = 20_100_502n; // A $20 order grossed up for fifty basis points.

  test('the commission is what we charge for the service, and nothing else', () => {
    /**
     * `surchargeBps` is the figure the commission is grossed up by, so both the recovery and the
     * network fee have to be out of it. The recovery is the merchant repaying their own balance;
     * the network fee is charged to the payer by a separate rule that does not ask who bears the
     * commission.
     */
    assert.equal(surchargeBps({ feeBps: 50 }), 50);
    assert.equal(surchargeBps({ feeBps: 120, recoveryBps: 70 }), 50);
    assert.equal(surchargeBps({ feeBps: 100, networkFeeBps: 50 }), 50);
    assert.equal(surchargeBps({ feeBps: 170, recoveryBps: 70, networkFeeBps: 50 }), 50);
    // A pooled chain takes nothing on chain and still bills the commission.
    assert.equal(surchargeBps({ feeBps: 0, accruedFeeBps: 50 }), 50);
  });

  test('the network fee reaches the payer whether or not the commission does', () => {
    const fee = { feeBps: 100, networkFeeBps: 50 };
    assert.equal(payerFeeBps(fee, 'merchant'), 50, 'the transfer, and not the commission');
    assert.equal(payerFeeBps(fee, 'payer'), 100, 'both');
  });

  test('the two disclosed lines sum to the surcharge, exactly', () => {
    /**
     * The property that matters. Flooring each line against the amount separately can lose a
     * unit, and a breakdown that does not add up to the total is worse than no breakdown — so
     * the commission is computed as the remainder rather than on its own.
     */
    for (const feePayer of ['merchant', 'payer']) {
      for (const networkFeeBps of [0, 1, 7, 50, 199]) {
        const shown = disclosedFees(AMOUNT, { feeBps: 50 + networkFeeBps, networkFeeBps }, feePayer);
        assert.equal(
          shown.commission + shown.network,
          shown.total,
          `${feePayer} at ${networkFeeBps}bps`,
        );
        assert.ok(shown.commission >= 0n, 'no line is ever negative');
      }
    }
  });

  test('a merchant absorbing the commission discloses only the transfer', () => {
    const shown = disclosedFees(AMOUNT, { feeBps: 100, networkFeeBps: 50 }, 'merchant');
    assert.equal(shown.commissionBps, 0);
    assert.equal(shown.commission, 0n);
    assert.equal(shown.networkBps, 50);
    assert.ok(shown.network > 0n);
  });

  test('a pooled chain discloses the commission and no transfer cost', () => {
    // The payer's transfer went to the merchant's own wallet: there is nothing to move, so
    // there is nothing to charge for moving, and the cheap chain looks cheaper.
    const shown = disclosedFees(AMOUNT, { feeBps: 0, accruedFeeBps: 50 }, 'payer');
    assert.equal(shown.networkBps, 0);
    assert.equal(shown.network, 0n);
    assert.equal(shown.commissionBps, 50);
    assert.ok(shown.commission > 0n);
  });

  test('an invoice with no fee at all discloses nothing', () => {
    const shown = disclosedFees(AMOUNT, undefined, 'payer');
    assert.deepEqual(
      { total: shown.total, commission: shown.commission, network: shown.network },
      { total: 0n, commission: 0n, network: 0n },
    );
  });
});

describe('the headroom three charges have to share', () => {
  test('the network fee is taken before the recovery, not after it', () => {
    /**
     * The order is a decision, and this is where it is enforced. All three rates live under the
     * forwarder's 5% ceiling, and the network fee is money leaving our gas wallet for *this*
     * payment while the balance can be collected from the next invoice. So the recovery is the
     * one that gives way.
     */
    const owed = -500_000_000n; // $500 — more than any one invoice can recover.
    const withoutNetwork = recoveryBpsFor({
      balanceUsdMicros: owed,
      planFeeBps: 450,
      invoiceValueUsdMicros: 20_000_000n,
    });
    const withNetwork = recoveryBpsFor({
      balanceUsdMicros: owed,
      planFeeBps: 450,
      invoiceValueUsdMicros: 20_000_000n,
      networkFeeBps: 30,
    });

    assert.equal(withoutNetwork, 50, 'the ceiling leaves fifty of the merchant’s 4.5%');
    assert.equal(withNetwork, 20, 'and the transfer takes thirty of them first');
    assert.ok(450 + 30 + withNetwork <= MAX_FEE_BPS, 'the total still fits the contract');
  });

  test('a network fee that fills the headroom leaves the recovery at nothing', () => {
    // Nothing is collected rather than an address deriving a fee the forwarder would revert on.
    assert.equal(
      recoveryBpsFor({
        balanceUsdMicros: -500_000_000n,
        planFeeBps: 300,
        invoiceValueUsdMicros: 20_000_000n,
        networkFeeBps: 200,
      }),
      0,
    );
  });
});

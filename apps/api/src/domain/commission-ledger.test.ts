import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { RECOVERY_MAX_BPS, recoveryBpsFor } from './commission-ledger.js';
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

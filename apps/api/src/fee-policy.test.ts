import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_FEE_POLICY } from '@avex/core';

import { loadEnv } from './env.js';
import { feePolicy, feePolicyConfig } from './fee-policy.js';

const base = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/avex',
};

test('an unconfigured deployment behaves exactly as the compiled defaults did', () => {
  /**
   * The whole point of making these configurable is that nobody who has not asked for a
   * different floor gets one. A default that drifted from `DEFAULT_FEE_POLICY` would change
   * the minimum invoice on every deployment that never mentioned it.
   */
  const config = feePolicyConfig(loadEnv({ ...base }));
  assert.deepEqual(config, DEFAULT_FEE_POLICY);
});

test('the floor where nothing settles is the configured dollar figure', () => {
  /**
   * TRON and TON: the payer's transfer lands in the merchant's own wallet, so there is no
   * settlement cost and this number is the entire minimum. Lowering it is how a real payment
   * gets tested for pennies.
   */
  const config = feePolicyConfig(loadEnv({ ...base, MIN_INVOICE_USD: '0.05' }));
  assert.equal(config.absoluteMinUsd, 0.05);
  // And nothing else moved with it.
  assert.equal(config.targetFeeRatio, DEFAULT_FEE_POLICY.targetFeeRatio);
  assert.deepEqual(config.deferAboveUsd, DEFAULT_FEE_POLICY.deferAboveUsd);
});

test('the ratio moves the floor on a chain that costs something to settle', () => {
  /**
   * With the dollar floor out of the way. `minInvoiceUsd` is the *higher* of the two, so at
   * a ratio this permissive the default fifty cents is what binds — which is correct
   * behaviour and would leave this test measuring the wrong number.
   */
  const cheap = feePolicy(
    loadEnv({ ...base, MIN_INVOICE_FEE_RATIO: '0.5', MIN_INVOICE_USD: '0' }),
  );
  const strict = feePolicy(loadEnv({ ...base }));
  const snapshot = {
    chain: 'bsc' as const,
    feePerGasWei: 100_000_000n,
    nativePriceUsd: 600,
    observedAt: 0,
  };

  /**
   * Stated as the relationship rather than as two numbers: what matters is that raising the
   * ratio lowers the floor, and by the factor it was raised by. Pinning the dollar figures
   * would make this a test of BNB's gas schedule.
   */
  const strictFloor = strict.minInvoiceUsd(snapshot);
  const cheapFloor = cheap.minInvoiceUsd(snapshot);
  assert.ok(cheapFloor < strictFloor, `${cheapFloor} should be under ${strictFloor}`);
  assert.ok(
    Math.abs(strictFloor / cheapFloor - 0.5 / 0.004) < 0.01,
    `the floor should scale with the ratio: ${strictFloor} vs ${cheapFloor}`,
  );
});

test('a ratio above one is refused', () => {
  // It is a share of the invoice. Above 1 the "minimum" is below the cost of settling, which
  // is not a lower floor but an invoice that loses money on purpose.
  assert.throws(() => loadEnv({ ...base, MIN_INVOICE_FEE_RATIO: '2' }));
  assert.throws(() => loadEnv({ ...base, MIN_INVOICE_FEE_RATIO: '0' }));
  // Zero dollars is allowed: on a chain that settles for free there is nothing to recover.
  assert.equal(feePolicyConfig(loadEnv({ ...base, MIN_INVOICE_USD: '0' })).absoluteMinUsd, 0);
});

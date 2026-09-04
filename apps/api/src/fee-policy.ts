import { DEFAULT_FEE_POLICY, FeePolicy } from '@avex/core';
import type { FeePolicyConfig } from '@avex/core';

import type { Env } from './env.js';

/**
 * The one fee policy this deployment runs, built from its configuration.
 *
 * Two of the policy's numbers decide the smallest invoice a chain will take, and both were
 * constants compiled into three separate `new FeePolicy(DEFAULT_FEE_POLICY)` calls — the
 * minimum check, the commission service and the settlement runner each building their own.
 * Changing the floor to send one real fifty-cent payment through meant editing the library
 * and redeploying, which is not a thing anybody should have to do to test a payment.
 *
 * So they are configuration, defaulting to exactly what the constants were. An unset
 * deployment behaves as it did.
 *
 * ## What these actually control, because it is easy to set the wrong one
 *
 * `MIN_INVOICE_FEE_RATIO` is the floor on the chains where we pay to move the money — the
 * EVM chains. The minimum there is `settlement cost ÷ ratio`, so at the default 0.004 a
 * settlement costing two and a half cents needs a $6 invoice. It is a margin, not a
 * threshold: the fee is fixed when the invoice is created and the gas is paid later, and the
 * ratio is what decides how much dearer the chain may get in between before the order is a
 * loss. Raising it towards 1 makes small EVM invoices possible and makes each one a bet on
 * gas — fine on a testnet or for a single real transfer you are watching, wrong to leave.
 *
 * `MIN_INVOICE_USD` is the floor everywhere else, and on TRON and TON it is the only one:
 * the payer's transfer lands in the merchant's own wallet, nothing of ours moves afterwards,
 * and there is no cost to recover. Which is why a small payment belongs on TRON — and why
 * nothing needs lowering to test one there.
 */
export function feePolicyConfig(env: Env): FeePolicyConfig {
  return {
    ...DEFAULT_FEE_POLICY,
    absoluteMinUsd: env.MIN_INVOICE_USD,
    targetFeeRatio: env.MIN_INVOICE_FEE_RATIO,
  };
}

/** The policy itself. Built once per process and shared, so nothing can disagree. */
export function feePolicy(env: Env): FeePolicy {
  return new FeePolicy(feePolicyConfig(env));
}

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { GasSnapshot } from '../types.js';
import { DEFAULT_FEE_POLICY, FeePolicy } from './FeePolicy.js';

const policy = new FeePolicy();

function ethereumAt(gwei: number, ethUsd = 2000): GasSnapshot {
  return {
    chain: 'ethereum',
    nativePriceUsd: ethUsd,
    feePerGasWei: BigInt(Math.round(gwei * 1e9)),
    observedAt: 0,
  };
}

test('Ethereum settlement cost tracks live gas', () => {
  // 95k gas at 0.047 gwei with ETH at $2000 — the quiet-market case. The gas figure is measured
  // against the compiled contracts, not chosen; see contracts/test/settlement-gas.test.mjs. It
  // was 400k until a deposit address stopped deploying a full copy of the forwarder.
  const cheap = policy.settlementCostUsd(ethereumAt(0.047));
  assert.ok(Math.abs(cheap.usd - 0.00893) < 0.0002, `expected ~$0.0089, got $${cheap.usd}`);

  // The same settlement during a spike.
  const spike = policy.settlementCostUsd(ethereumAt(9));
  assert.ok(Math.abs(spike.usd - 1.71) < 0.01, `expected ~$1.71, got $${spike.usd}`);
});

test('minimum invoice size rises automatically with gas', () => {
  // This is the property that lets Ethereum stay enabled: no operator has to
  // notice a spike and flip a switch.
  const cheapMin = policy.minInvoiceUsd(ethereumAt(0.047));
  const spikeMin = policy.minInvoiceUsd(ethereumAt(9));

  /**
   * About $2.23 at the quiet end, which is two hundred and fifty times the 0.89 cents it costs.
   *
   * That multiple is the whole content of `targetFeeRatio`, and it is not a margin on the gas:
   * the payer already covers the gas. It is the margin on the *forecast* — the fee is fixed when
   * the invoice is created and the settlement is paid later, so the commission has to absorb a
   * chain that got dearer in between. At 0.4% and a doubling that lands on two hundred and
   * fifty, and this is where it is spent.
   *
   * Stated as a range because both directions are product facts. Much lower and a chain starts
   * accepting orders whose commission cannot absorb an ordinary doubling; much higher and the
   * floor is doing something other than what its derivation says.
   */
  assert.ok(
    cheapMin > 1.5 && cheapMin < 3.5,
    `expected $1.50-$3.50 at 0.047 gwei, got $${cheapMin}`,
  );

  /**
   * And in the hundreds during a spike: at 9 gwei a settlement is $1.71, so an order that can
   * absorb one going wrong is a large order. The answer for a small one is TRON, which the
   * payer is shown.
   */
  assert.ok(spikeMin > 400, `expected over $400 at 9 gwei, got $${spikeMin}`);
});

test('a small invoice is withdrawn from checkout during a spike', () => {
  // Comfortably above the quiet-market floor of about $2.23 and far below the $427 a 9-gwei
  // Ethereum needs, so this tests the behaviour rather than a boundary.
  const invoiceUsd = 50;

  const cheap = policy.availability(ethereumAt(0.047), invoiceUsd);
  assert.equal(cheap.available, true);

  const spike = policy.availability(ethereumAt(9), invoiceUsd);
  assert.equal(spike.available, false);
  assert.match(spike.reason ?? '', /exceeds/);
});

test('settlement defers when the chain is expensive and proceeds when it is not', () => {
  assert.equal(policy.shouldSettleNow(ethereumAt(0.047)), true);
  assert.equal(policy.shouldSettleNow(ethereumAt(9)), false);
});

test('TON settles for free and carries only the absolute floor', () => {
  const snapshot: GasSnapshot = {
    chain: 'ton',
    nativePriceUsd: 3,
    observedAt: 0,
  };
  assert.equal(policy.settlementCostUsd(snapshot).usd, 0);
  assert.equal(policy.minInvoiceUsd(snapshot), DEFAULT_FEE_POLICY.absoluteMinUsd);
});

test('TRON settles for nothing, because nothing is sent', () => {
  /**
   * This test has been three things, and the history is the point.
   *
   * It first asserted that delegated energy made a TRON settlement free. That was wrong: we
   * were sending a transaction, and staked TRX buys a finite daily allowance rather than an
   * unlimited supply, so the cost was real and the zero made the minimum invoice on this chain
   * zero too. It then asserted a price for that energy, from one of three supply models.
   *
   * Now it asserts zero again — and this time it is true for a different reason. TRON is a
   * pooled chain: the deposit addresses are the merchant's own, so the payer's transfer is the
   * only transaction and we send nothing at all. A zero that follows from there being no
   * transaction is not the same claim as a zero that follows from having prepaid for one.
   */
  const snapshot: GasSnapshot = { chain: 'tron', nativePriceUsd: 0.3, observedAt: 0 };
  const policy = new FeePolicy();

  const cost = policy.settlementCostUsd(snapshot);
  assert.equal(cost.usd, 0);
  assert.equal(policy.minInvoiceUsd(snapshot), DEFAULT_FEE_POLICY.absoluteMinUsd);

  // And no live gas figure is needed to say so, which is the observable difference: the old
  // burn path threw without `sunPerEnergy`.
  assert.doesNotThrow(() => policy.settlementCostUsd(snapshot));
});

test('checkout ranking puts the cheapest chain first and drops the unaffordable', () => {
  const snapshots: GasSnapshot[] = [
    ethereumAt(9),
    { chain: 'ton', nativePriceUsd: 3, observedAt: 0 },
    { chain: 'bsc', nativePriceUsd: 600, feePerGasWei: 1_000_000_000n, observedAt: 0 },
  ];

  const ranked = policy.rankForCheckout(snapshots, 20);

  assert.equal(ranked[0]?.chain, 'ton', 'TON settles for free and should lead');
  assert.ok(
    !ranked.some((entry) => entry.chain === 'ethereum'),
    'Ethereum at 9 gwei must not be offered for a $20 invoice',
  );
});

/**
 * Charging the payer for the transfer, which is the whole of "a $20 invoice becomes $20.10".
 *
 * The figure has to be a rate rather than a cent amount, and that is forced rather than
 * preferred: the deposit address is a hash over the forwarder's constructor arguments and the
 * fee rate is one of them, so what is charged is fixed the moment the address exists. These
 * tests are about the conversion, and about the two places it must not go wrong — rounding
 * against us, and a small invoice turning a fixed cost into an outrageous percentage.
 */

const bscAt = (gwei: number, bnbUsd = 600): GasSnapshot => ({
  chain: 'bsc',
  nativePriceUsd: bnbUsd,
  feePerGasWei: BigInt(Math.round(gwei * 1e9)),
  observedAt: 0,
});

const usd = (dollars: number): bigint => BigInt(Math.round(dollars * 1_000_000));

test('the network fee is the settlement cost as a share of the invoice', () => {
  /**
   * BSC at 0.1 gwei: 95,000 gas is 0.0000095 BNB, which at $600 is 0.57 cents. On a $20 invoice
   * that is 3 basis points, so the payer is asked for $20.006 and the merchant keeps $20.
   */
  const snapshot = bscAt(0.1);
  assert.ok(Math.abs(policy.settlementCostUsd(snapshot).usd - 0.0057) < 0.0002);
  assert.equal(policy.networkFeeBps(snapshot, usd(20)), 3);

  // The same cost on a bigger order is a smaller share of it — the point of a rate. It bottoms
  // out at one basis point rather than nothing, because the rounding is upward and the cost is
  // never actually zero.
  assert.equal(policy.networkFeeBps(snapshot, usd(200)), 1);
  assert.equal(policy.networkFeeBps(snapshot, usd(2000)), 1);
});

test('the rounding goes against us, never against the payer', () => {
  /**
   * 0.57 cents of $50 is 1.14 basis points. Rounded down it would be 1, and we would be short a
   * fraction of a cent on every invoice on the chain — a real loss that scales with volume,
   * against at most one micro-dollar of overcharge on one payment.
   */
  const bps = policy.networkFeeBps(bscAt(0.1), usd(50));
  assert.equal(bps, 2);
  assert.ok((bps * 50) / 10_000 >= 0.0057, 'the charge must cover the cost, not approach it');
});

test('a fixed cost on a tiny invoice is capped rather than passed on', () => {
  /**
   * 0.57 cents of ten cents is 570 basis points. Uncapped that would be 5.7% of the payment —
   * and the arithmetic would not stop there, because nothing about a fixed cost gets smaller.
   * The cap is what keeps this from reaching a payer; the answer to an invoice that small is a
   * different chain, which `minInvoiceUsd` already says.
   */
  assert.equal(policy.networkFeeBps(bscAt(0.1), usd(0.1)), DEFAULT_FEE_POLICY.networkFeeMaxBps);
  // A dollar is 57bps — high, and under the cap, which is why the floor exists separately.
  assert.equal(policy.networkFeeBps(bscAt(0.1), usd(1)), 57);

  // And the cap is well inside the forwarder's own 5%, so it can never be the thing that
  // makes an address undeployable.
  assert.ok(DEFAULT_FEE_POLICY.networkFeeMaxBps < 500);
});

test('nothing is charged on a chain we send no transaction on', () => {
  /**
   * TON's shared wallet and TRON's pool of the merchant's own addresses both receive the payer's
   * transfer directly. There is no settlement, so there is nothing to pass on — and the payer
   * seeing the cheap chain as cheaper is the outcome, not a side effect.
   */
  assert.equal(policy.networkFeeBps({ chain: 'ton', nativePriceUsd: 3, observedAt: 0 }, usd(20)), 0);
  assert.equal(policy.networkFeeBps({ chain: 'tron', nativePriceUsd: 0.1, observedAt: 0 }, usd(20)), 0);
});

test('an invoice with no dollar value is charged nothing', () => {
  // A token-priced invoice: the merchant asked for 20 USDT, not for $20. A share of a figure
  // invented here is not one we could explain to either party afterwards.
  assert.equal(policy.networkFeeBps(bscAt(0.1), 0n), 0);
  assert.equal(policy.networkFeeBps(bscAt(0.1), -1n), 0);
});

test('the charge tracks a gas spike up to the cap, and back down', () => {
  // The property that makes this worth doing at all: nobody has to notice.
  const quiet = policy.networkFeeBps(bscAt(0.1), usd(100));
  const busy = policy.networkFeeBps(bscAt(3), usd(100));

  assert.ok(busy > quiet, `expected the busy figure to be higher, got ${busy} vs ${quiet}`);
  assert.equal(busy, 18, '3 gwei is 17 cents a settlement, and 18bps of a $100 order');

  // Far enough up and the cap takes over: $2.85 of a $100 order would be 285bps.
  assert.equal(policy.networkFeeBps(bscAt(50), usd(100)), DEFAULT_FEE_POLICY.networkFeeMaxBps);

  // And it is a snapshot, not a ratchet: the quiet figure comes back when the chain does.
  assert.equal(policy.networkFeeBps(bscAt(0.1), usd(100)), quiet);
});

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
  // 150k gas at 0.047 gwei with ETH at $2000 — the quiet-market case.
  const cheap = policy.settlementCostUsd(ethereumAt(0.047));
  assert.ok(Math.abs(cheap.usd - 0.0141) < 0.0005, `expected ~$0.0141, got $${cheap.usd}`);

  // The same settlement during a spike.
  const spike = policy.settlementCostUsd(ethereumAt(9));
  assert.ok(Math.abs(spike.usd - 2.7) < 0.01, `expected ~$2.70, got $${spike.usd}`);
});

test('minimum invoice size rises automatically with gas', () => {
  // This is the property that lets Ethereum stay enabled: no operator has to
  // notice a spike and flip a switch.
  const cheapMin = policy.minInvoiceUsd(ethereumAt(0.047));
  const spikeMin = policy.minInvoiceUsd(ethereumAt(9));

  assert.ok(cheapMin < 2, `expected under $2 at 0.047 gwei, got $${cheapMin}`);
  assert.ok(spikeMin > 250, `expected over $250 at 9 gwei, got $${spikeMin}`);
});

test('a small invoice is withdrawn from checkout during a spike', () => {
  const invoiceUsd = 20;

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

test('TRON costs nothing per transfer under energy delegation', () => {
  const snapshot: GasSnapshot = {
    chain: 'tron',
    nativePriceUsd: 0.3,
    sunPerEnergy: 420,
    observedAt: 0,
  };

  const delegated = new FeePolicy({ ...DEFAULT_FEE_POLICY, tronEnergyDelegation: true });
  assert.equal(delegated.settlementCostUsd(snapshot).usd, 0);

  // Without delegation the burn is real, and the minimum invoice reflects it.
  const burning = new FeePolicy({ ...DEFAULT_FEE_POLICY, tronEnergyDelegation: false });
  const cost = burning.settlementCostUsd(snapshot);
  assert.ok(cost.usd > 0, 'burning energy must cost something');
  assert.ok(burning.minInvoiceUsd(snapshot) > delegated.minInvoiceUsd(snapshot));
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

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
  // 400k gas at 0.047 gwei with ETH at $2000 — the quiet-market case. The gas
  // figure is measured against the compiled forwarder, not chosen; see
  // contracts/test/settlement-gas.test.mjs.
  const cheap = policy.settlementCostUsd(ethereumAt(0.047));
  assert.ok(Math.abs(cheap.usd - 0.0376) < 0.0005, `expected ~$0.0376, got $${cheap.usd}`);

  // The same settlement during a spike.
  const spike = policy.settlementCostUsd(ethereumAt(9));
  assert.ok(Math.abs(spike.usd - 7.2) < 0.01, `expected ~$7.20, got $${spike.usd}`);
});

test('minimum invoice size rises automatically with gas', () => {
  // This is the property that lets Ethereum stay enabled: no operator has to
  // notice a spike and flip a switch.
  const cheapMin = policy.minInvoiceUsd(ethereumAt(0.047));
  const spikeMin = policy.minInvoiceUsd(ethereumAt(9));

  /**
   * $3.76 at the quiet end, not the $2 an earlier 150,000-gas estimate implied.
   *
   * The bound is stated as a range rather than a ceiling because both directions
   * are product facts worth catching. Above ~$5 and Ethereum stops being usable for
   * ordinary payments even in a calm market, which is an argument for the cheaper
   * chains rather than for a smaller constant. Below ~$2 and the estimate has
   * drifted back down towards a figure the bytecode does not support.
   */
  assert.ok(
    cheapMin > 2 && cheapMin < 5,
    `expected $2-$5 at 0.047 gwei, got $${cheapMin}`,
  );
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

test('TRON settlement is never free, whatever the energy comes from', () => {
  /**
   * This test used to assert the opposite — that delegated energy costs nothing — and that
   * assertion is why the bug survived. Staked TRX yields a finite daily allowance, so a
   * settlement spends a scarce thing whether or not TRX is burned for it. Zero is the one
   * answer that is definitely wrong: it makes the minimum-invoice figure zero too, and every
   * dust invoice on TRON then looks profitable.
   */
  const snapshot: GasSnapshot = {
    chain: 'tron',
    nativePriceUsd: 0.3,
    sunPerEnergy: 420,
    observedAt: 0,
  };

  const burning = new FeePolicy({ ...DEFAULT_FEE_POLICY, tronEnergy: { source: 'burn' } });
  const rented = new FeePolicy({
    ...DEFAULT_FEE_POLICY,
    tronEnergy: { source: 'rented', sunPerEnergy: 42 },
  });
  const staked = new FeePolicy({
    ...DEFAULT_FEE_POLICY,
    tronEnergy: { source: 'staked', sunPerEnergy: 20 },
  });

  for (const [name, policy] of [
    ['burn', burning],
    ['rented', rented],
    ['staked', staked],
  ] as const) {
    assert.ok(policy.settlementCostUsd(snapshot).usd > 0, `${name} must cost something`);
  }

  /**
   * And the ordering is the whole point of the field: a cheaper energy source lowers the cost
   * and therefore the smallest invoice we can take on TRON. If this ordering ever inverts,
   * the arithmetic is wrong rather than the configuration.
   */
  assert.ok(rented.settlementCostUsd(snapshot).usd < burning.settlementCostUsd(snapshot).usd);
  assert.ok(staked.settlementCostUsd(snapshot).usd < rented.settlementCostUsd(snapshot).usd);
  assert.ok(staked.minInvoiceUsd(snapshot) < burning.minInvoiceUsd(snapshot));
});

test('TRON with a burned-energy price missing is an error, not a free settlement', () => {
  /**
   * The snapshot is the live source for the burn price. If it arrives without one — a probe
   * that failed, a stub in a test — the only safe answer is to refuse: a substituted default
   * would put a made-up number underneath a merchant's minimum invoice.
   */
  const noPrice: GasSnapshot = { chain: 'tron', nativePriceUsd: 0.3, observedAt: 0 };
  const burning = new FeePolicy({ ...DEFAULT_FEE_POLICY, tronEnergy: { source: 'burn' } });
  assert.throws(() => burning.settlementCostUsd(noPrice), /sunPerEnergy required/);

  // A stated price needs no snapshot, which is the point of stating it.
  const rented = new FeePolicy({
    ...DEFAULT_FEE_POLICY,
    tronEnergy: { source: 'rented', sunPerEnergy: 42 },
  });
  assert.ok(rented.settlementCostUsd(noPrice).usd > 0);
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

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_FEE_POLICY, FeePolicy } from '@avex/core';

/**
 * The native price behind every gas figure, and why a stub for it is dangerous.
 *
 * The watcher passed `async () => 0` as its price oracle for a long time, and while nothing
 * settled that was merely untidy. It stopped being untidy the moment the settlement queue
 * started running in the same process: every gas cost is a native amount multiplied by a price,
 * so a price of zero makes every settlement free, and free is always below the threshold that
 * decides whether to wait for a cheaper block.
 *
 * The first test is that arithmetic, stated as a fact rather than a worry. The second is a guard
 * on the wiring, because the first cannot see it — a unit test of `FeePolicy` passes whatever
 * the watcher happens to pass in.
 */

const here = dirname(fileURLToPath(import.meta.url));

describe('the gas model needs a real native price', () => {
  test('a zero price makes the most expensive chain look free', () => {
    /**
     * 500 gwei on Ethereum — a price nobody would settle at — costs nothing if ETH is worth
     * nothing. And `shouldSettleNow` compares a cost against a dollar threshold, so a cost of
     * zero passes every threshold there is.
     */
    const policy = new FeePolicy(DEFAULT_FEE_POLICY);
    const absurd = {
      chain: 'ethereum' as const,
      nativePriceUsd: 0,
      feePerGasWei: 500_000_000_000n,
      observedAt: 0,
    };

    assert.equal(policy.settlementCostUsd(absurd).usd, 0);
    assert.equal(
      policy.shouldSettleNow(absurd),
      true,
      'a zeroed price turns the whole deferral mechanism off without disabling it',
    );

    // With a real price, the same snapshot is refused: 95,000 gas at 500 gwei is 0.0475 ETH,
    // which at $500 is about $24 for one settlement.
    const real = { ...absurd, nativePriceUsd: 500 };
    assert.ok(policy.settlementCostUsd(real).usd > 20, `expected over $20, got ${policy.settlementCostUsd(real).usd}`);
    assert.equal(policy.shouldSettleNow(real), false);
  });

  test('the watcher does not stub the price oracle', () => {
    /**
     * A source guard, which is unusual and earns its place here.
     *
     * What went wrong was not a wrong number but a placeholder that outlived the reason it was
     * acceptable — and no behavioural test can see it, because the adapters are constructed
     * inside a process entry point that starts polling on import. This reads the file instead.
     *
     * The pattern it looks for is a price function returning a literal zero, in any spacing.
     *
     * The source, not the build: tests run from `dist`, and the compiled JavaScript is not what a
     * reviewer edits — a guard that read it would pass on a file nobody looks at.
     */
    const source = readFileSync(join(here, '..', '..', 'src', 'watcher.ts'), 'utf8');
    assert.ok(
      !/nativePriceUsd:\s*(async)?\s*\(\s*\)\s*=>\s*0/.test(source),
      'watcher.ts is passing a zeroed native price; every settlement would look free',
    );
    // And it is reaching the price service, which is the only thing that should answer this.
    assert.match(source, /nativePriceUsd:.*prices\.nativePriceUsd/s);
  });
});

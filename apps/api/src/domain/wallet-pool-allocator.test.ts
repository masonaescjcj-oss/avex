import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  DISAMBIGUATOR_TICKS,
  MIN_DECIMALS_FOR_POOL,
  WalletPoolError,
  chooseAmount,
  chooseWallet,
  disambiguatorPlan,
} from './wallet-pool-allocator.js';
import type { WalletLoad } from './wallet-pool-allocator.js';

const wallet = (address: string, ...openAmounts: bigint[]): WalletLoad => ({
  id: `id-${address}`,
  address,
  openAmounts,
});

describe('choosing a wallet', () => {
  test('an idle wallet is preferred to a busy one', () => {
    /**
     * The rule that makes a wrong amount recoverable. A wallet with one open invoice can
     * absorb a payment for the wrong amount — there is only one invoice it could be for. A
     * wallet with two cannot, and needs a human. So idle wallets go first.
     */
    const pool = [wallet('TBusy', 20_000_001n), wallet('TIdle')];
    assert.equal(chooseWallet(pool).address, 'TIdle');
    // And the order the rows arrive in must not change the answer.
    assert.equal(chooseWallet([...pool].reverse()).address, 'TIdle');
  });

  test('when every wallet is busy, the least busy wins', () => {
    const pool = [
      wallet('TThree', 1n, 2n, 3n),
      wallet('TOne', 1n),
      wallet('TTwo', 1n, 2n),
    ];
    assert.equal(chooseWallet(pool).address, 'TOne');
  });

  test('a tie is broken deterministically, not by row order', () => {
    const a = wallet('TAaa', 1n);
    const b = wallet('TBbb', 1n);
    assert.equal(chooseWallet([a, b]).address, 'TAaa');
    assert.equal(chooseWallet([b, a]).address, 'TAaa');
  });

  test('an empty pool is a named error, not a crash', () => {
    /**
     * It is a merchant configuration problem — they have registered no wallet — and the
     * checkout has to say so. An undefined dereference three frames later would be reported
     * as an internal error and looked for in our code.
     */
    assert.throws(() => chooseWallet([]), (error: unknown) => {
      assert.ok(error instanceof WalletPoolError);
      assert.equal(error.code, 'pool_empty');
      return true;
    });
  });
});

describe('where the nudge goes, for one token', () => {
  test('a stablecoin is nudged in cents', () => {
    /**
     * The whole reason the plan exists. On USDT the coarse step must be a hundredth of a token,
     * because that is what a payer reads as "a few cents" and types without error — 20.05, not
     * 20.004137. The finest step is two digits beneath it, so the amount never needs more than
     * four decimals.
     */
    const plan = disambiguatorPlan({ decimals: 6, unitPriceUsd: 1 });
    assert.equal(plan.coarseDecimals, 2);
    assert.equal(plan.unit, 100n, 'the fine step on a 6-decimal token is 0.0001');
    assert.equal(plan.max, 99_900n, 'at most 0.0999 added — under a tenth of a dollar');
  });

  test('a dear token is nudged in fractions worth about a cent', () => {
    /**
     * "Cents" is a dollar idea and the amount is in tokens. A hundredth of an ETH is thirty
     * dollars, which is not a nudge but a robbery — so the step follows the price. Two decimals
     * past the price's magnitude: on ETH at $3000 the coarse step is a millionth, about a third
     * of a cent, and the payer is still asked for at most a few cents more.
     */
    const eth = disambiguatorPlan({ decimals: 18, unitPriceUsd: 3000 });
    assert.equal(eth.coarseDecimals, 6);
    // 0.000001 ETH × 999 at the fine tier, in wei.
    assert.equal(eth.max, 999n * 10n ** 10n);

    const bnb = disambiguatorPlan({ decimals: 18, unitPriceUsd: 600 });
    assert.equal(bnb.coarseDecimals, 5);
  });

  test('a cheap token is never nudged coarser than a hundredth', () => {
    // TRX at ten cents: the formula would say one decimal, which is a whole cent per step and
    // ten times too coarse. Clamped at two.
    assert.equal(disambiguatorPlan({ decimals: 6, unitPriceUsd: 0.1 }).coarseDecimals, 2);
  });

  test('with no price, the nudge lives four decimals inside the token', () => {
    /**
     * A token-priced invoice — "send 20 USDT" — has no dollar figure to reason from. Falling
     * back to four decimals inside the token's precision lands on cents for the six-decimal
     * stablecoins that are nearly all such invoices, and is harmlessly fine for anything else,
     * where the payer copies the amount rather than typing it.
     */
    assert.equal(disambiguatorPlan({ decimals: 6 }).coarseDecimals, 2);
    assert.equal(disambiguatorPlan({ decimals: 6, unitPriceUsd: null }).coarseDecimals, 2);
    assert.equal(disambiguatorPlan({ decimals: 18 }).coarseDecimals, 14);
  });

  test('the step never runs out of decimals beneath it', () => {
    // Two tiers below the coarse digit are always needed, so the coarse digit is capped at
    // decimals minus two however cheap the token.
    assert.equal(disambiguatorPlan({ decimals: 4, unitPriceUsd: 1 }).coarseDecimals, 2);
    assert.equal(disambiguatorPlan({ decimals: 5, unitPriceUsd: 0.001 }).coarseDecimals, 2);
  });

  test('a coarse token is refused, because the offset would be a surcharge', () => {
    /**
     * On a two-decimal token the coarse step is a whole unit — a $20 invoice becoming $29.
     * There is no version of this scheme that works there, so the merchant is told rather than
     * charged.
     */
    assert.equal(MIN_DECIMALS_FOR_POOL, 4);
    for (const decimals of [0, 2, 3]) {
      assert.throws(
        () => disambiguatorPlan({ decimals, unitPriceUsd: 1 }),
        (error: unknown) => {
          assert.ok(error instanceof WalletPoolError);
          assert.equal(error.code, 'decimals_too_few');
          return true;
        },
        `${decimals} decimals`,
      );
    }
  });
});

describe('choosing the amount that identifies an invoice', () => {
  const BASE = 20_000_000n; // $20.000000 in a 6-decimal token.
  const usdt = { decimals: 6, unitPriceUsd: 1 };
  const plan = disambiguatorPlan(usdt);

  test('the payer is always asked for more than the price, never less', () => {
    /**
     * The direction is the point. A merchant who charged $20 must not be paid $19.99 because
     * of a mechanism of ours, so the disambiguator is added. The most it can add on a
     * stablecoin is 0.0999 — under a tenth of a dollar.
     */
    for (let i = 0; i < 200; i++) {
      const amount = chooseAmount({ ...usdt, base: BASE, taken: [] });
      assert.ok(amount > BASE, `${amount} must exceed the price`);
      assert.ok(amount - BASE <= plan.max);
    }
  });

  test('the first nine invoices at one price on one wallet are whole cents', () => {
    /**
     * What the payer sees: 20.05, 20.03 — the amounts a person types without error. The
     * finer tiers exist for capacity and are reached only once the cents are spoken for.
     */
    const taken: bigint[] = [];
    for (let i = 0; i < 9; i++) {
      const amount = chooseAmount({ ...usdt, base: BASE, taken });
      assert.equal((amount - BASE) % 10_000n, 0n, `${amount} should be a whole cent`);
      taken.push(amount);
    }
    // The tenth cannot be a whole cent: all nine are open. It moves to a tenth of one.
    const tenth = chooseAmount({ ...usdt, base: BASE, taken });
    assert.notEqual((tenth - BASE) % 10_000n, 0n);
    assert.equal((tenth - BASE) % 1_000n, 0n, `${tenth} should be a whole tenth of a cent`);
  });

  test('the amount is never round, so a truncated payment cannot hit another invoice', () => {
    /**
     * The failure this prevents is the one the design is most exposed to: a payer withdraws
     * from an exchange that truncates to two decimals, so $20.05 arrives as $20.00. If any
     * open invoice were allowed to ask for exactly $20.00, that payment would be credited to a
     * stranger's invoice — correctly, by the amount rule, and wrongly in fact. Because the
     * offset can never be zero, no open invoice ever asks for the round number.
     */
    for (let i = 0; i < 200; i++) {
      assert.notEqual(chooseAmount({ ...usdt, base: BASE, taken: [] }), BASE);
    }
  });

  test('an amount already open on the wallet is never handed out twice', () => {
    /**
     * Exhaustive rather than sampled: every offset but one is taken, so the only acceptable
     * answer is that one. A random probe that gave up would return a duplicate, which is the
     * state no reconciliation rule can untangle.
     */
    const taken: bigint[] = [];
    for (let tick = 1; tick <= DISAMBIGUATOR_TICKS; tick++) {
      if (tick !== 7) taken.push(BASE + BigInt(tick) * plan.unit);
    }
    assert.equal(chooseAmount({ ...usdt, base: BASE, taken }), BASE + 7n * plan.unit);
  });

  test('a full window on one wallet is refused rather than duplicated', () => {
    const taken: bigint[] = [];
    for (let tick = 1; tick <= DISAMBIGUATOR_TICKS; tick++) {
      taken.push(BASE + BigInt(tick) * plan.unit);
    }
    assert.throws(() => chooseAmount({ ...usdt, base: BASE, taken }), (error: unknown) => {
      assert.ok(error instanceof WalletPoolError);
      assert.equal(error.code, 'pool_exhausted');
      return true;
    });
  });

  test('amounts open at other prices do not shrink this price’s window', () => {
    /**
     * A wallet holding thousands of open invoices for other amounts must not make this one
     * unfulfillable: the collision that matters is only with amounts inside this invoice's own
     * window. Getting this wrong would make a busy wallet reject new invoices for no reason.
     */
    const taken = [50_000_001n, 50_000_002n, 1n, 19_999_999n, BASE + plan.max + plan.unit];
    const amount = chooseAmount({ ...usdt, base: BASE, taken });
    assert.ok(amount > BASE && amount - BASE <= plan.max);
  });

  test('an open amount that is not on the grid is not mistaken for a taken offset', () => {
    // An invoice from before this scheme, or one on another grid: BASE + 1 unit is inside the
    // window but is no multiple of the step, so it collides with nothing here.
    const amount = chooseAmount({ ...usdt, base: BASE, taken: [BASE + 1n], random: () => 0 });
    assert.equal(amount, BASE + 10_000n, 'the first whole cent is still free');
  });

  test('a random source stuck on one value still terminates, on the next free offset', () => {
    /**
     * The random path is what runs in production and it cannot be the only path. A source
     * that always offers the first candidate must still land on a free one when the first is
     * taken, inside invoice creation, rather than spin — a request that never returns is
     * worse than any error.
     */
    const stuck = () => 0;
    const amount = chooseAmount({ ...usdt, base: BASE, taken: [BASE + 10_000n], random: stuck });
    assert.equal(amount, BASE + 20_000n, 'the next whole cent');
  });

  test('the injected random source picks within the roundest tier', () => {
    // Nine whole-cent offsets; half-way through them is the fifth.
    const amount = chooseAmount({ ...usdt, base: BASE, taken: [], random: () => 0.5 });
    assert.equal(amount, BASE + 50_000n, '20.05');
  });

  test('the same rule on a dear token stays under a few cents', () => {
    // 0.5 ETH at $3000, in wei. Whatever is added must be worth under a dime.
    const base = 5n * 10n ** 17n;
    const amount = chooseAmount({ base, decimals: 18, unitPriceUsd: 3000, taken: [] });
    const addedUsd = (Number(amount - base) / 1e18) * 3000;
    assert.ok(addedUsd > 0 && addedUsd < 0.1, `added $${addedUsd}`);
  });
});

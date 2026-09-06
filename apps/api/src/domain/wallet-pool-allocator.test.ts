import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  DISAMBIGUATOR_TICKS,
  MAX_TICK_USD,
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

  test('busyness is the count of open invoices, not of reserved amounts', () => {
    /**
     * A wallet whose last three invoices were paid still reserves their amounts for a day, so a
     * late payer finds their invoice. That must not make it look busy: reserved numbers are
     * not candidates for a wrong-amount payment, open invoices are.
     */
    const reservedOnly: WalletLoad = { ...wallet('TQuiet', 1n, 2n, 3n), openCount: 0 };
    const oneOpen: WalletLoad = { ...wallet('TLive', 4n), openCount: 1 };
    assert.equal(chooseWallet([oneOpen, reservedOnly]).address, 'TQuiet');
  });

  test('among equally idle wallets, the one quiet longest is chosen', () => {
    /**
     * The gap between an old invoice and a new one on the same address is what keeps a late
     * payment for the old one from landing beside the new one. Spreading invoices to the wallet
     * that has been unused longest makes that gap as wide as the pool allows, and a wallet
     * that has never been used is the widest gap of all.
     */
    const justUsed: WalletLoad = { ...wallet('TAaa'), lastInvoiceAt: 1_000_000 };
    const quietForHours: WalletLoad = { ...wallet('TBbb'), lastInvoiceAt: 1_000 };
    const never: WalletLoad = { ...wallet('TCcc'), lastInvoiceAt: null };
    assert.equal(chooseWallet([justUsed, quietForHours]).address, 'TBbb');
    assert.equal(chooseWallet([justUsed, quietForHours, never]).address, 'TCcc');
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
  test('the step is the third decimal on a stablecoin', () => {
    /**
     * The whole reason the plan exists: a payer is never asked for more than three decimals of
     * a stablecoin, so the nudge that tells invoices apart lives in the last of them — a tenth
     * of a cent; 999 of them before a wallet runs out of amounts for one price.
     */
    const usdt = disambiguatorPlan({ decimals: 6, unitPriceUsd: 1 });
    assert.equal(usdt.unit, 1_000n, '0.001 USDT in smallest units');
    assert.equal(usdt.decimals, 3);
    assert.equal(usdt.ticks, DISAMBIGUATOR_TICKS);
    assert.equal(usdt.max, 999_000n, 'at most 0.999 added');
  });

  test('a dear token is nudged in its fifth decimal, so a step is under a dime', () => {
    /**
     * The merchant's rule. Three decimals of BNB would make every step sixty cents; five make
     * it six tenths of a cent. The grid comes from the price, not from a list of tickers.
     */
    const bnb = disambiguatorPlan({ decimals: 18, unitPriceUsd: 600 });
    assert.equal(bnb.decimals, 5);
    assert.equal(bnb.unit, 10n ** 13n, '0.00001 of an 18-decimal token');
    const eth = disambiguatorPlan({ decimals: 18, unitPriceUsd: 3_000 });
    assert.equal(eth.decimals, 5);
  });

  test('with no price the grid is three decimals', () => {
    assert.equal(disambiguatorPlan({ decimals: 6 }).unit, 1_000n);
    assert.equal(disambiguatorPlan({ decimals: 18, unitPriceUsd: null }).unit, 10n ** 15n);
  });

  test('a token with fewer than three decimals steps in its own smallest unit', () => {
    // Two decimals: the step is a cent, which is still a nudge on a stablecoin.
    const plan = disambiguatorPlan({ decimals: 2, unitPriceUsd: 1 });
    assert.equal(plan.unit, 1n);
    assert.equal(plan.decimals, 2);
  });

  test('a coarse token is refused, because the offset would be a surcharge', () => {
    /**
     * On a one-decimal token the step is a tenth of a token; on a zero-decimal one a whole
     * token. There is no version of this scheme that works there, so the merchant is told
     * rather than charged.
     */
    assert.equal(MIN_DECIMALS_FOR_POOL, 2);
    for (const decimals of [0, 1]) {
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

  test('a token so dear that even the fifth decimal is real money is refused', () => {
    /**
     * At five decimals a $60,000 token steps in sixty cents, which is fine. A token worth a
     * million dollars would step in ten — not a rounding anybody agreed to — so that token
     * cannot be paid into a shared wallet. Nothing listed is near this; the line exists so that
     * nothing quietly crosses it.
     */
    assert.equal(MAX_TICK_USD, 5);
    assert.doesNotThrow(() => disambiguatorPlan({ decimals: 18, unitPriceUsd: 3_000 }));
    assert.doesNotThrow(() => disambiguatorPlan({ decimals: 8, unitPriceUsd: 60_000 }));
    assert.throws(
      () => disambiguatorPlan({ decimals: 8, unitPriceUsd: 1_000_000 }),
      (error: unknown) => {
        assert.ok(error instanceof WalletPoolError);
        assert.equal(error.code, 'tick_too_dear');
        return true;
      },
    );
  });
});

describe('choosing the amount that identifies an invoice', () => {
  const BASE = 20_000_000n; // $20.000000 in a 6-decimal token.
  const usdt = { decimals: 6, unitPriceUsd: 1 };
  const plan = disambiguatorPlan(usdt);

  test('the payer is always asked for more than the price, never less', () => {
    /**
     * The direction is the point. A merchant who charged $20 must not be paid $19.99 because
     * of a mechanism of ours, so the disambiguator is added.
     */
    const amount = chooseAmount({ ...usdt, base: BASE, taken: [] });
    assert.ok(amount > BASE, `${amount} must exceed the price`);
    assert.ok(amount - BASE <= plan.max);
  });

  test('the first invoice at a price asks for one step more, and the next for two', () => {
    /**
     * What the payer sees: 20.001, then 20.002. The smallest free step, so the surcharge is the
     * least it can be — on a dear token every step is money — and so the amount is predictable
     * enough to explain to a merchant reading their own wallet.
     */
    const first = chooseAmount({ ...usdt, base: BASE, taken: [] });
    assert.equal(first, 20_001_000n, '20.001');
    const second = chooseAmount({ ...usdt, base: BASE, taken: [first] });
    assert.equal(second, 20_002_000n, '20.002');
  });

  test('the amount never has more than three decimals, whatever the token has', () => {
    /**
     * The rule the merchant asked for. A quote at eighteen decimals — 25.253529057985269131 —
     * is rounded up to the grid before the step is added, so the payer is asked for 25.255 and
     * not for a number nobody can type.
     */
    const eighteen = 25_253_529_057_985_269_131n;
    const amount = chooseAmount({ base: eighteen, decimals: 18, unitPriceUsd: 1, taken: [] });
    assert.equal(amount, 25_255_000_000_000_000_000n, '25.254 rounded up, plus one step');
    assert.equal(amount % 10n ** 15n, 0n, 'nothing below the third decimal');
    assert.ok(amount > eighteen, 'and never below the price');
  });

  test('the amount is never round, so a truncated payment cannot hit another invoice', () => {
    /**
     * The failure this prevents is the one the design is most exposed to: a payer withdraws
     * from an exchange that truncates to two decimals, so $20.001 arrives as $20.00. If any
     * open invoice were allowed to ask for exactly $20.00, that payment would be credited to a
     * stranger's invoice — correctly, by the amount rule, and wrongly in fact. Because the
     * offset can never be zero, no open invoice ever asks for the round number.
     */
    for (let i = 0; i < 20; i++) {
      const taken = Array.from({ length: i }, (_, tick) => BASE + BigInt(tick + 1) * plan.unit);
      assert.notEqual(chooseAmount({ ...usdt, base: BASE, taken }), BASE);
    }
  });

  test('an amount already reserved on the wallet is never handed out twice', () => {
    /**
     * Exhaustive rather than sampled: every offset but one is taken, so the only acceptable
     * answer is that one. Returning a duplicate would create the state no reconciliation rule
     * can untangle.
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

  test('amounts reserved at other prices do not shrink this price’s window', () => {
    /**
     * A wallet holding thousands of invoices for other amounts must not make this one
     * unfulfillable: the collision that matters is only with amounts inside this invoice's own
     * window. Getting this wrong would make a busy wallet reject new invoices for no reason.
     */
    const taken = [50_000_001n, 50_000_002n, 1n, 19_999_999n, BASE + plan.max + plan.unit];
    const amount = chooseAmount({ ...usdt, base: BASE, taken });
    assert.equal(amount, BASE + plan.unit);
  });

  test('a reserved amount that is not on the grid is not mistaken for a taken step', () => {
    // An invoice from before this scheme: BASE + 1 unit is inside the window but is no
    // multiple of the step, so it collides with nothing here.
    const amount = chooseAmount({ ...usdt, base: BASE, taken: [BASE + 1n] });
    assert.equal(amount, BASE + plan.unit, 'the first step is still free');
  });

  test('two prices a fraction apart cannot be issued the same amount', () => {
    /**
     * Invoice A charges 20.0000 and is issued 20.002. Invoice B charges 20.0012 — a different
     * price, rounded up to 20.002 — and must not be issued 20.002 too. The taken amounts are
     * compared after B's own rounding, so the collision is seen.
     */
    const a = chooseAmount({ ...usdt, base: BASE, taken: [BASE + plan.unit] }); // 20.002
    assert.equal(a, 20_002_000n);
    const b = chooseAmount({ ...usdt, base: 20_001_200n, taken: [BASE + plan.unit, a] });
    assert.equal(b, 20_003_000n, 'the next free step above 20.002');
  });

  test('the same rule on a dear token costs the payer one step of the fifth decimal', () => {
    // 0.5 ETH at $3000, in wei. One hundred-thousandth added, and no more: three cents.
    const base = 5n * 10n ** 17n;
    const amount = chooseAmount({ base, decimals: 18, unitPriceUsd: 3000, taken: [] });
    assert.equal(amount, base + 10n ** 13n, '0.50001 ETH');
    const addedUsd = (Number(amount - base) / 1e18) * 3000;
    assert.ok(addedUsd > 0.029 && addedUsd < 0.031, `added $${addedUsd}`);
  });
});

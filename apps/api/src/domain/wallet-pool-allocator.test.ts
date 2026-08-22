import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  DISAMBIGUATOR_MAX,
  DISAMBIGUATOR_MIN,
  WalletPoolError,
  chooseAmount,
  chooseWallet,
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

describe('choosing the amount that identifies an invoice', () => {
  const BASE = 20_000_000n; // $20.000000 in a 6-decimal token.

  test('the payer is always asked for more than the price, never less', () => {
    /**
     * The direction is the point. A merchant who charged $20 must not be paid $19.99 because
     * of a mechanism of ours, so the disambiguator is added. The most it can add on a
     * six-decimal token is 0.009999 — under a cent.
     */
    for (let i = 0; i < 200; i++) {
      const amount = chooseAmount({ base: BASE, decimals: 6, taken: [] });
      assert.ok(amount > BASE, `${amount} must exceed the price`);
      assert.ok(amount - BASE >= DISAMBIGUATOR_MIN);
      assert.ok(amount - BASE <= DISAMBIGUATOR_MAX);
    }
  });

  test('the amount is never round, so a truncated payment cannot hit another invoice', () => {
    /**
     * The failure this prevents is the one the design is most exposed to: a payer withdraws
     * from an exchange that truncates to two decimals, so $20.004212 arrives as $20.00. If
     * any open invoice were allowed to ask for exactly $20.00, that payment would be credited
     * to a stranger's invoice — correctly, by the amount rule, and wrongly in fact. Because
     * the offset can never be zero, no open invoice ever asks for the round number.
     */
    for (let i = 0; i < 200; i++) {
      assert.notEqual(chooseAmount({ base: BASE, decimals: 6, taken: [] }), BASE);
    }
  });

  test('an amount already open on the wallet is never handed out twice', () => {
    /**
     * Exhaustive rather than sampled: every offset but one is taken, so the only acceptable
     * answer is that one. A random probe that gave up would return a duplicate, which is the
     * state no reconciliation rule can untangle.
     */
    const taken: bigint[] = [];
    for (let offset = DISAMBIGUATOR_MIN; offset <= DISAMBIGUATOR_MAX; offset++) {
      if (offset !== 7n) taken.push(BASE + offset);
    }
    assert.equal(chooseAmount({ base: BASE, decimals: 6, taken }), BASE + 7n);
  });

  test('a full window on one wallet is refused rather than duplicated', () => {
    const taken: bigint[] = [];
    for (let offset = DISAMBIGUATOR_MIN; offset <= DISAMBIGUATOR_MAX; offset++) {
      taken.push(BASE + offset);
    }
    assert.throws(() => chooseAmount({ base: BASE, decimals: 6, taken }), (error: unknown) => {
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
    const taken = [50_000_001n, 50_000_002n, 1n, 19_999_999n, BASE + DISAMBIGUATOR_MAX + 1n];
    const amount = chooseAmount({ base: BASE, decimals: 6, taken });
    assert.ok(amount > BASE && amount - BASE <= DISAMBIGUATOR_MAX);
  });

  test('a coarse token is refused, because the offset would be a surcharge', () => {
    /**
     * On a two-decimal token the smallest usable offsets are whole cents and the largest is
     * 99 units — a $20 invoice becoming $119. There is no version of this scheme that works
     * there, so the merchant is told rather than charged.
     */
    assert.throws(() => chooseAmount({ base: 2000n, decimals: 2, taken: [] }), (error: unknown) => {
      assert.ok(error instanceof WalletPoolError);
      assert.equal(error.code, 'decimals_too_few');
      return true;
    });
    // Six is the floor, and it is allowed.
    assert.ok(chooseAmount({ base: BASE, decimals: 6, taken: [] }) > BASE);
  });

  test('a random source stuck on one value still terminates', () => {
    /**
     * The random path is what runs in production and it cannot be the only path. A source
     * that returns the same offset every time — a stub, a broken PRNG — would spin forever
     * against a window where that offset is taken, inside invoice creation, which is a request
     * that never returns rather than an error anybody sees.
     */
    const stuck = () => 0; // Always offers offset 1.
    const amount = chooseAmount({
      base: BASE,
      decimals: 6,
      taken: [BASE + 1n],
      random: stuck,
    });
    assert.equal(amount, BASE + 2n, 'must fall back to a scan and take the next free offset');
  });

  test('the injected random source is respected when it offers something free', () => {
    // Half-way through the span, so the assertion names a specific offset rather than a range.
    const amount = chooseAmount({ base: BASE, decimals: 6, taken: [], random: () => 0.5 });
    assert.equal(amount, BASE + 5000n);
  });
});

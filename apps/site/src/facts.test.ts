import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { SUPPORTED_CHAINS, type CuratedAsset } from '@avex/core';

import { LADDER, SIGNATURE_WINDOW_SECONDS, chainRows, percentOf, roundUsd, split } from './facts.js';

/**
 * The facts the site states.
 *
 * A marketing page is the one surface nobody tests against reality, which makes it the
 * surface where a claim quietly stops being true. Every figure the page shows is derived
 * here, and these tests are what stop the derivation drifting from the product — the
 * separate suite that compares the *page* against the API's own constants lives in
 * `test/claims.test.mjs`.
 */

describe('what the site says you can accept', () => {
  test('every supported chain appears, with its native asset', () => {
    /**
     * A chain missing from this table is a chain a reader concludes we do not support, which
     * is the same commercial outcome as not supporting it. And a row with no native asset is
     * a chain that cannot pay anyone, so an empty string there would be a visible hole.
     */
    const rows = chainRows();
    assert.equal(rows.length, SUPPORTED_CHAINS.length);

    for (const chain of SUPPORTED_CHAINS) {
      const row = rows.find((entry) => entry.chain === chain);
      assert.ok(row, `${chain} is missing from the site`);
      assert.ok(row!.native.length > 0, `${chain} shows no native asset`);
    }
  });

  test('a chain reads by its own name, not our identifier', () => {
    // "bsc" is what our database calls it. Nobody outside this codebase does.
    const rows = chainRows();
    assert.equal(rows.find((row) => row.chain === 'bsc')?.label, 'BNB Chain');
    assert.equal(rows.find((row) => row.chain === 'ton')?.label, 'TON');
  });

  test('the chains most readers came for are first', () => {
    /**
     * Ordered by the stablecoin volume each chain actually carries rather than
     * alphabetically. Alphabetical would put BNB Chain above TRON, and TRON is the one a
     * reader scanning for "can I take USDT" is looking for.
     */
    const order = chainRows().map((row) => row.chain);
    assert.equal(order[0], 'tron');
    assert.ok(order.indexOf('tron') < order.indexOf('polygon'));
  });

  test('a bridged stablecoin is labelled and a native one is not', () => {
    /**
     * "USDT on BNB Chain" is Binance-Peg BSC-USD, not a Tether issuance. Saying so on the
     * marketing page rather than only in the dashboard is the harder version of the claim,
     * and the right one: a merchant chooses what to accept before they ever sign up.
     */
    const rows = chainRows();
    const bsc = rows.find((row) => row.chain === 'bsc')!;
    assert.ok(bsc.stablecoins.every((coin) => coin.issuer === 'bridged'));

    const tron = rows.find((row) => row.chain === 'tron')!;
    assert.equal(tron.stablecoins.find((coin) => coin.symbol === 'USDT')?.issuer, 'native');
  });

  test('stablecoins are ordered predictably inside a chain', () => {
    // So the table does not reshuffle when the curated list is reordered.
    const rows = chainRows();
    for (const row of rows) {
      const symbols = row.stablecoins.map((coin) => coin.symbol);
      assert.deepEqual(symbols, [...symbols].sort());
    }
  });

  test('a chain carrying only its native asset still gets a row', () => {
    /**
     * Not a hypothetical: a new chain arrives with its gas asset before any stablecoin is
     * verified on it, and dropping it from the table would mean the site under-reports the
     * product for exactly as long as that takes.
     */
    const rows = chainRows([
      { symbol: 'SOL', chain: 'solana', decimals: 9, kind: 'native', note: 'x', issuer: 'native', source: { url: 'https://example.test/', checkedOn: '2026-08-18' } },
    ] as unknown as readonly CuratedAsset[]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.native, 'SOL');
    assert.deepEqual(rows[0]!.stablecoins, []);
  });
});

describe('what the site says it costs', () => {
  test('the ladder runs from the entry rate downwards', () => {
    // Entry first, because that is the rate a reader will be on. A table that opened with
    // 0.4% would be quoting a price almost nobody starts at.
    assert.deepEqual(
      LADDER.map((rung) => rung.bps),
      [50, 45, 40],
    );
    assert.equal(LADDER[0]!.fromUsdMicros, 0n);
  });

  test('the worked example is computed, not typed', () => {
    /**
     * $100 is the figure everyone checks the arithmetic on, and arithmetic done by hand in
     * the HTML is the first thing to go stale after a repricing.
     */
    assert.deepEqual(split(100, 50), { fee: '$0.50', net: '$99.50' });
    assert.deepEqual(split(1000, 45), { fee: '$4.50', net: '$995.50' });
    assert.deepEqual(split(100, 40), { fee: '$0.40', net: '$99.60' });
  });

  test('the split floors the fee, exactly as the contract does', () => {
    /**
     * `Forwarder._feeOn` rounds down, which favours the merchant. A marketing page rounding
     * the other way would be quoting a fee a fraction higher than the one taken — small,
     * and the kind of small that reads as dishonest when somebody notices.
     */
    assert.equal(split(0.001, 50).fee, '$0.00');
    // 0.5% of $19.99 is $0.09995, which floors to nine and a half cents, not ten.
    assert.equal(split(19.99, 50).fee, '$0.09');
  });

  test('a rate reads without trailing zeros', () => {
    assert.equal(percentOf(50), '0.5%');
    assert.equal(percentOf(45), '0.45%');
    assert.equal(percentOf(40), '0.4%');
    assert.equal(percentOf(500), '5%');
    assert.equal(percentOf(0), '0%');
  });

  test('thresholds read as round money', () => {
    // "$50,000 a month" is the sentence. "50000000000 micro-dollars" is our unit.
    assert.equal(roundUsd(50_000_000_000n), '$50,000');
    assert.equal(roundUsd(250_000_000_000n), '$250,000');
    assert.equal(roundUsd(0n), '$0');
  });

  test('the signature window the docs quote is a real number of seconds', () => {
    // Quoted in the webhook example, where being wrong would have integrators rejecting
    // deliveries we consider valid.
    assert.equal(SIGNATURE_WINDOW_SECONDS, 300);
  });
});

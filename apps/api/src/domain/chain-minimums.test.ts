import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { DEFAULT_FEE_POLICY, FeePolicy } from '@avex/core';
import type { ChainId, GasSnapshot } from '@avex/core';

import { ChainMinimums, formatUsdMicros } from './chain-minimums.js';
import type { GasOracle } from './gas-oracle.js';

/**
 * The floor under an invoice, and the four answers it can give.
 *
 * This is the check that had been computed and never called: `FeePolicy.minInvoiceUsd` has
 * derived a floor from live gas since the beginning, and nothing in the product asked it. So
 * what is tested here is mostly that the wiring says no when it should — and, more importantly,
 * that it says yes in every case where saying no would cost a merchant a sale for no reason.
 */

const oracleOf = (snapshot: GasSnapshot | null): GasOracle => ({
  async snapshot() {
    return snapshot;
  },
});

const usd = (dollars: number): bigint => BigInt(Math.round(dollars * 1_000_000));

/** BSC at 0.1 gwei with BNB at $600: 400,000 gas is 2.4 cents. */
const BSC: GasSnapshot = {
  chain: 'bsc',
  nativePriceUsd: 600,
  feePerGasWei: 100_000_000n,
  observedAt: 0,
};

describe('the smallest order a chain can carry', () => {
  test('the floor is the settlement cost over the target ratio', async () => {
    /**
     * 2.4 cents at a ratio of 0.002 is $12, and the multiple is the point: it is not a margin
     * on the gas — the payer covers that — but on the *forecast*, because the fee is fixed when
     * the invoice is created and the gas is paid when it settles.
     */
    const minimums = new ChainMinimums(oracleOf(BSC));
    assert.equal(await minimums.minInvoiceUsdMicros('bsc'), usd(12));
    assert.equal(DEFAULT_FEE_POLICY.targetFeeRatio, 0.002, 'and this is where that comes from');
  });

  test('the floor is quoted to the cent, upwards', async () => {
    /**
     * It goes into a sentence a merchant reads. A minimum of $11.997341 is not one anybody can
     * act on, and rounding it down would print a figure that fails the check it came from.
     */
    const odd: GasSnapshot = { ...BSC, feePerGasWei: 99_999_999n };
    const minimums = new ChainMinimums(oracleOf(odd));
    const floor = (await minimums.minInvoiceUsdMicros('bsc'))!;

    assert.equal(floor % 10_000n, 0n, 'a whole number of cents');
    const policy = new FeePolicy(DEFAULT_FEE_POLICY);
    assert.ok(
      Number(floor) / 1e6 >= policy.minInvoiceUsd(odd),
      'the quoted figure must itself pass',
    );
  });

  test('a chain that settles directly has no floor at all', async () => {
    /**
     * TRON's pooled wallets and TON's shared one receive the payer's transfer and nothing of
     * ours moves afterwards. There is no settlement whose cost could exceed anything — so the
     * cheap chains are the ones a fifty-cent order can use, which is what they are for.
     */
    const minimums = new ChainMinimums(oracleOf(BSC));
    assert.equal(await minimums.minInvoiceUsdMicros('tron'), null);
    assert.equal(await minimums.minInvoiceUsdMicros('ton'), null);
    assert.deepEqual(await minimums.verdict('tron', usd(0.5)), { ok: true });
  });

  test('Telegram Stars are not a chain and are not judged as one', async () => {
    // There is no gas: the customer pays the merchant's own bot. A throw here would make the
    // rail unusable, and a floor would be a floor on nothing.
    const minimums = new ChainMinimums(oracleOf(BSC));
    assert.equal(await minimums.minInvoiceUsdMicros('telegram'), null);
    assert.deepEqual(await minimums.verdict('telegram', usd(1)), { ok: true });
  });

  test('a probe that failed refuses nothing', async () => {
    /**
     * The direction that matters most here. This runs inside the request that opens an invoice,
     * so a floor that appeared when an RPC endpoint went down would stop every merchant selling
     * — to protect us from a risk we would rather carry.
     */
    const minimums = new ChainMinimums(oracleOf(null));
    assert.equal(await minimums.minInvoiceUsdMicros('bsc'), null);
    assert.deepEqual(await minimums.verdict('bsc', usd(1)), { ok: true });
  });

  test('an order below the floor is refused, and told what the floor is', async () => {
    const minimums = new ChainMinimums(oracleOf(BSC));

    const refused = await minimums.verdict('bsc', usd(2));
    assert.equal(refused.ok, false);
    assert.equal(refused.ok === false && refused.minUsdMicros, usd(12));

    // And the boundary itself passes, rather than being off by a cent.
    assert.deepEqual(await minimums.verdict('bsc', usd(12)), { ok: true });
    assert.deepEqual(await minimums.verdict('bsc', usd(12.01)), { ok: true });
    assert.equal((await minimums.verdict('bsc', usd(11.99))).ok, false);
  });

  test('an invoice with no dollar value is not judged against a dollar figure', async () => {
    /**
     * A token-priced invoice: the merchant asked for 20 USDT, not for $20. Refusing it against
     * a conversion invented here would refuse an order on a number the merchant was never
     * shown — and the same rule already governs the recovery and the network fee.
     */
    const minimums = new ChainMinimums(oracleOf(BSC));
    assert.deepEqual(await minimums.verdict('bsc', null), { ok: true });
    assert.deepEqual(await minimums.verdict('bsc', undefined), { ok: true });
    assert.deepEqual(await minimums.verdict('bsc', 0n), { ok: true });
  });

  test('a chain whose gas is nearly free still has the absolute floor', async () => {
    // Below which the order is not worth the machinery whatever the chain costs.
    const free: GasSnapshot = { ...BSC, feePerGasWei: 1n };
    const minimums = new ChainMinimums(oracleOf(free));
    assert.equal(
      await minimums.minInvoiceUsdMicros('bsc'),
      usd(DEFAULT_FEE_POLICY.absoluteMinUsd),
    );
  });

  test('the floor rises with gas, without anybody deciding it should', async () => {
    // The property the whole derivation exists for: no operator has to notice a spike.
    const busy: GasSnapshot = { ...BSC, feePerGasWei: 3_000_000_000n }; // 3 gwei
    const quiet = (await new ChainMinimums(oracleOf(BSC)).minInvoiceUsdMicros('bsc'))!;
    const spike = (await new ChainMinimums(oracleOf(busy)).minInvoiceUsdMicros('bsc'))!;

    assert.ok(spike > quiet * 20n, `expected a spike to bite: ${quiet} → ${spike}`);
  });

  test('the oracle is asked for the chain in question, and only for chains that settle', async () => {
    const asked: ChainId[] = [];
    const minimums = new ChainMinimums({
      async snapshot(chain) {
        asked.push(chain);
        return BSC;
      },
    });

    await minimums.verdict('bsc', usd(20));
    await minimums.verdict('tron', usd(20));
    assert.deepEqual(asked, ['bsc'], 'nothing is probed for a chain with no settlement');
  });

  test('dollars are printed the way a person reads them', () => {
    assert.equal(formatUsdMicros(usd(12)), '$12.00');
    assert.equal(formatUsdMicros(usd(0.5)), '$0.50');
    assert.equal(formatUsdMicros(usd(1234.5)), '$1234.50');
  });
});

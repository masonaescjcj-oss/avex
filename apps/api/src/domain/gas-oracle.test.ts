import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { ChainId } from '@avex/core';

import { RpcGasOracle } from './gas-oracle.js';

/**
 * The gas probe that sits in front of an invoice, and the two things it must never do.
 *
 * It must not fail an invoice, and it must not make one RPC call per invoice. Both are
 * consequences of where it runs: inside the request that opens an invoice, on the path that
 * takes money. What it is protecting is a few cents of gas; what it would break is the sale.
 */

/** A node that answers, and counts how often it was asked. */
function fakeRpc(answers: Record<string, string> | (() => never)) {
  const calls: string[] = [];
  return {
    calls,
    forChain(_chain: ChainId) {
      return {
        async request<T>(method: string): Promise<T> {
          calls.push(method);
          if (typeof answers === 'function') answers();
          const value = (answers as Record<string, string>)[method];
          if (value === undefined) throw new Error(`unsupported method ${method}`);
          return value as unknown as T;
        },
      };
    },
  };
}

const prices = { nativePriceUsd: async () => 600 };

const NODE = { eth_gasPrice: '0x5f5e100', eth_maxPriorityFeePerGas: '0x0' }; // 0.1 gwei

describe('probing gas for a new invoice', () => {
  test('a snapshot carries the price and the fee per gas', async () => {
    const rpc = fakeRpc(NODE);
    const snapshot = await new RpcGasOracle(rpc, prices).snapshot('bsc', 1_000);

    assert.equal(snapshot?.chain, 'bsc');
    assert.equal(snapshot?.feePerGasWei, 100_000_000n);
    assert.equal(snapshot?.nativePriceUsd, 600);
    assert.equal(snapshot?.observedAt, 1_000);
  });

  test('the priority fee is optional, because some chains reject the method', async () => {
    // Pre-1559 chains have no such call, and `eth_gasPrice` there already includes everything a
    // transaction pays. Treating the refusal as fatal would leave those chains with no figure.
    const rpc = fakeRpc({ eth_gasPrice: '0x5f5e100' });
    const snapshot = await new RpcGasOracle(rpc, prices).snapshot('bsc', 1_000);
    assert.equal(snapshot?.feePerGasWei, 100_000_000n);
  });

  test('a second invoice inside the window costs no calls', async () => {
    /**
     * Thirty seconds of cache. The figure it feeds is a percentage rounded up to a basis point,
     * so a price that moved inside the window changes a typical charge by a fraction of a cent —
     * against a third-party round trip in front of every checkout.
     */
    const rpc = fakeRpc(NODE);
    const oracle = new RpcGasOracle(rpc, prices);

    await oracle.snapshot('bsc', 1_000);
    const calls = rpc.calls.length;
    await oracle.snapshot('bsc', 20_000);
    assert.equal(rpc.calls.length, calls, 'served from the cache');

    await oracle.snapshot('bsc', 60_000);
    assert.ok(rpc.calls.length > calls, 'and re-probed once it is stale');
  });

  test('a chain we send no transaction on is refused without asking', async () => {
    /**
     * TRON's pooled wallets and TON's shared one receive the payer's transfer directly, so there
     * is no settlement to price. Answering null rather than a zero-cost snapshot keeps the
     * honest reading, and the caller's rule — no snapshot, no surcharge — gives the right charge
     * of nothing.
     */
    const rpc = fakeRpc(NODE);
    const oracle = new RpcGasOracle(rpc, prices);

    assert.equal(await oracle.snapshot('tron'), null);
    assert.equal(await oracle.snapshot('ton'), null);
    assert.deepEqual(rpc.calls, [], 'and no node was troubled about it');
  });

  test('an unreachable node answers null, not an exception', async () => {
    /**
     * The property the whole module exists for. A throw here would surface as a failed invoice,
     * which means an RPC provider having a bad minute stops a merchant selling — to protect a
     * few cents of gas we would rather absorb.
     */
    const warnings: string[] = [];
    const oracle = new RpcGasOracle(
      fakeRpc(() => {
        throw new Error('econnrefused');
      }),
      prices,
      (message) => warnings.push(message),
    );

    assert.equal(await oracle.snapshot('bsc'), null);
    assert.ok(warnings.some((line) => /econnrefused/.test(line)), 'and it is not silent');
  });

  test('a price feed that refuses is the same as an unreachable node', async () => {
    // A snapshot without a native price cannot be turned into dollars, and half a snapshot is
    // worse than none: it would be a cost figure computed against a zero price.
    const oracle = new RpcGasOracle(fakeRpc(NODE), {
      async nativePriceUsd() {
        throw new Error('no trustworthy price');
      },
    });
    assert.equal(await oracle.snapshot('bsc'), null);
  });

  test('a recent snapshot outlives the node that produced it, briefly', async () => {
    /**
     * The alternative on a flaky endpoint is a charge that appears and disappears between two
     * invoices a minute apart — which a merchant reading their own numbers cannot explain, and
     * which two payers comparing the same order would see differently.
     */
    let up = true;
    const oracle = new RpcGasOracle(
      {
        forChain() {
          return {
            async request<T>(method: string): Promise<T> {
              if (!up) throw new Error('down');
              const value = NODE[method as keyof typeof NODE];
              if (value === undefined) throw new Error('unsupported');
              return value as unknown as T;
            },
          };
        },
      },
      prices,
    );

    await oracle.snapshot('bsc', 1_000);
    up = false;

    assert.ok(await oracle.snapshot('bsc', 120_000), 'two minutes on, still usable');
    assert.equal(
      await oracle.snapshot('bsc', 20 * 60 * 1_000),
      null,
      'twenty minutes on it is no longer evidence about the chain',
    );
  });
});

import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

import type { Asset } from '../../types.js';
import { TronAdapter } from './TronAdapter.js';
import { normalizeTronAddress, tronAddressToEvmHex } from './address.js';

/**
 * Watching TRON, against a hand-written responder rather than a node.
 *
 * A test that needs a TRON node is a test that does not run, and the thing under test here is
 * not the chain — it is the address boundary. TRC-20 is ERC-20 with a different address
 * encoding, so the filter goes out in hex and the recipients come back in hex, while everything
 * this system stores and compares is Base58Check. Get that wrong and the adapter finds no
 * payments at all: no error, no log line, and a chain that looks quiet.
 */

/**
 * Tether's real TRC-20 contract, and three fixture addresses with valid checksums.
 *
 * The fixtures are Base58Check over deliberately repetitive bodies — 0x11…, 0x22…, 0x33… — so
 * they are obviously not somebody's wallet, and so they are stable. Invented by hand they were
 * *not* valid, and the codec refused them: which is the codec doing its job, and worth
 * remembering before writing a TRON address into a fixture again.
 */
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const WALLET = 'TBXSw8fM4jpQkGc6zZjsVABFpVN7UvXPdV';
const STRANGER = 'TD5gsCwxykWsLN9aPrq2TAfNjByuZKYp4E';

const USDT: Asset = {
  symbol: 'USDT',
  chain: 'tron',
  decimals: 6,
  kind: 'trc20',
  contract: USDT_CONTRACT,
};

/** A `Transfer` log, in the shape TRON's JSON-RPC returns. */
function transferLog(input: {
  readonly contract?: string;
  readonly to: string;
  readonly amount: bigint;
  readonly block: number;
  readonly logIndex?: number;
  readonly txHash?: string;
}): unknown {
  const pad = (hex: string): string => hex.replace(/^0x/, '').padStart(64, '0');
  return {
    address: tronAddressToEvmHex(input.contract ?? USDT_CONTRACT),
    topics: [
      // keccak256('Transfer(address,address,uint256)')
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      `0x${pad(tronAddressToEvmHex(STRANGER))}`,
      `0x${pad(tronAddressToEvmHex(input.to))}`,
    ],
    data: `0x${input.amount.toString(16)}`,
    blockNumber: `0x${input.block.toString(16)}`,
    transactionHash: input.txHash ?? `0x${'ab'.repeat(32)}`,
    logIndex: `0x${(input.logIndex ?? 0).toString(16)}`,
  };
}

/**
 * A responder, and a record of what it was asked.
 *
 * The requests matter as much as the answers: a poll that asked for the wrong address form
 * would return an empty list from a real node, and a test that only checked the outcome could
 * not tell that apart from a quiet chain.
 */
function responder(input: { readonly head: number; readonly logs: readonly unknown[] }) {
  const calls: { method: string; params: unknown[] }[] = [];

  const fetchMock = mock.fn(async (_url: string, init?: { body?: string }) => {
    const request = JSON.parse(init?.body ?? '{}') as { method: string; params: unknown[] };
    calls.push({ method: request.method, params: request.params });

    const result =
      request.method === 'eth_blockNumber'
        ? `0x${input.head.toString(16)}`
        : request.method === 'eth_getLogs'
          ? input.logs
          : null;

    return {
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result }),
    } as unknown as Response;
  });

  return { calls, fetchMock };
}

function adapterWith(options: {
  readonly head: number;
  readonly logs: readonly unknown[];
  readonly known?: readonly string[];
  readonly assets?: readonly Asset[];
}) {
  const { calls, fetchMock } = responder({ head: options.head, logs: options.logs });
  const known = new Set((options.known ?? [WALLET]).map((address) => normalizeTronAddress(address)));

  const adapter = new TronAdapter(
    {
      chain: 'tron',
      rpcUrl: 'https://api.trongrid.io/jsonrpc',
      acceptedAssets: options.assets ?? [USDT],
      pollRange: 200,
    },
    { nativePriceUsd: async () => 0.3 },
    {
      lookup: async (address) => (known.has(address) ? 'invoice-1' : null),
    },
  );

  return { adapter, calls, fetchMock };
}

describe('watching TRON', () => {
  test('a transfer to a watched wallet is found, and reported in Base58Check', async (t) => {
    const { adapter, calls, fetchMock } = adapterWith({
      head: 1000,
      logs: [transferLog({ to: WALLET, amount: 20_000_123n, block: 995 })],
    });
    t.mock.method(globalThis, 'fetch', fetchMock);

    const result = await adapter.poll('990');

    assert.equal(result.payments.length, 1);
    const payment = result.payments[0]!;
    /**
     * Base58Check, not hex. This is what makes the payment comparable to the address the
     * merchant registered and the invoice stored — and what makes it readable in a support
     * conversation.
     */
    assert.equal(payment.to, WALLET);
    assert.equal(payment.amount, 20_000_123n);
    assert.equal(payment.asset.symbol, 'USDT');
    assert.equal(payment.blockNumber, 995);
    assert.equal(payment.confirmations, 6, 'head 1000 minus block 995, inclusive');
    assert.equal(result.cursor, '1000');

    /**
     * And the filter went out in hex.
     *
     * A node given a `T…` address in `eth_getLogs` returns nothing rather than an error, so
     * without this assertion the passing case above could be a coincidence of the fake.
     */
    const getLogs = calls.find((call) => call.method === 'eth_getLogs');
    const filter = getLogs!.params[0] as { address: string[]; fromBlock: string; toBlock: string };
    assert.deepEqual(filter.address, [tronAddressToEvmHex(USDT_CONTRACT).toLowerCase()]);
    assert.equal(filter.fromBlock, '0x3df', 'from the cursor plus one');
    assert.equal(filter.toBlock, '0x3e8');
  });

  test('a transfer to an address nobody owns is ignored', async (t) => {
    const { adapter, fetchMock } = adapterWith({
      head: 1000,
      logs: [transferLog({ to: STRANGER, amount: 5_000_000n, block: 999 })],
    });
    t.mock.method(globalThis, 'fetch', fetchMock);

    const result = await adapter.poll('990');
    assert.deepEqual(result.payments, []);
    assert.equal(result.cursor, '1000', 'and the cursor still advances');
  });

  test('a transfer of a token we do not accept is dropped, not guessed at', async (t) => {
    /**
     * The expensive mistake this prevents. Deploying a TRC-20 called USDT costs a few cents, so
     * a log from an unwatched contract reaching an invoice would credit a merchant in a
     * worthless clone. Dropped rather than attributed to whichever asset was nearest.
     */
    const clone = 'TEdvoHEatmDKvTh3o9vBRB9Vdtbhn4QFhy';
    const { adapter, fetchMock } = adapterWith({
      head: 1000,
      logs: [transferLog({ contract: clone, to: WALLET, amount: 999_000_000n, block: 999 })],
    });
    t.mock.method(globalThis, 'fetch', fetchMock);

    assert.deepEqual((await adapter.poll('990')).payments, []);
  });

  test('one filter covers every accepted contract', async (t) => {
    /**
     * One request per poll rather than one per token. Merchants can submit contracts, so the
     * catalogue grows without anybody deciding to grow it — and a poll every few seconds times a
     * few hundred tokens is a rate limit, then a ban, then payments going unnoticed.
     */
    const second: Asset = { ...USDT, symbol: 'USDD', contract: STRANGER };
    const { adapter, calls, fetchMock } = adapterWith({
      head: 1000,
      logs: [],
      assets: [USDT, second],
    });
    t.mock.method(globalThis, 'fetch', fetchMock);

    await adapter.poll('990');
    const getLogs = calls.filter((call) => call.method === 'eth_getLogs');
    assert.equal(getLogs.length, 1);
    assert.equal((getLogs[0]!.params[0] as { address: string[] }).address.length, 2);
  });

  test('a malformed contract in the catalogue is skipped, not fatal', async (t) => {
    /**
     * The catalogue is partly merchant-submitted. One bad row must not stop the chain being
     * watched, because that would turn somebody's data-entry mistake into every other
     * merchant's payments going unnoticed.
     */
    const broken: Asset = { ...USDT, symbol: 'BAD', contract: 'not-an-address' };
    const { adapter, calls, fetchMock } = adapterWith({
      head: 1000,
      logs: [transferLog({ to: WALLET, amount: 1n, block: 999 })],
      assets: [broken, USDT],
    });
    t.mock.method(globalThis, 'fetch', fetchMock);

    const result = await adapter.poll('990');
    assert.equal(result.payments.length, 1, 'the good contract is still watched');
    const filter = calls.find((c) => c.method === 'eth_getLogs')!.params[0] as {
      address: string[];
    };
    assert.equal(filter.address.length, 1);
  });

  test('a catalogue with nothing watchable makes no request and still advances', async (t) => {
    /**
     * A native-only catalogue: an incoming TRX transfer emits no log, so a filter would find
     * nothing however it were written. The cursor still moves, because those blocks *have* been
     * examined and rescanning them forever would be a watcher that never catches up.
     */
    const trx: Asset = { symbol: 'TRX', chain: 'tron', decimals: 6, kind: 'native' };
    const { adapter, calls, fetchMock } = adapterWith({ head: 1000, logs: [], assets: [trx] });
    t.mock.method(globalThis, 'fetch', fetchMock);

    const result = await adapter.poll('990');
    assert.deepEqual(result.payments, []);
    assert.equal(result.cursor, '1000');
    assert.equal(calls.filter((call) => call.method === 'eth_getLogs').length, 0);
  });

  test('a poll range longer than the gap stops at the head', async (t) => {
    const { adapter, calls, fetchMock } = adapterWith({ head: 100, logs: [] });
    t.mock.method(globalThis, 'fetch', fetchMock);

    await adapter.poll('98');
    const filter = calls.find((c) => c.method === 'eth_getLogs')!.params[0] as {
      fromBlock: string;
      toBlock: string;
    };
    assert.equal(filter.fromBlock, '0x63');
    assert.equal(filter.toBlock, '0x64', 'never past the head, whatever the range allows');
  });

  test('a first poll starts at the head rather than at genesis', async (t) => {
    /**
     * A null cursor is a chain nobody has watched yet. Starting from block zero would scan
     * years of history looking for payments to addresses that did not exist, and would take
     * long enough that the payments happening meanwhile went unnoticed.
     */
    const { adapter, calls, fetchMock } = adapterWith({ head: 70_000_000, logs: [] });
    t.mock.method(globalThis, 'fetch', fetchMock);

    const result = await adapter.poll(null);
    assert.equal(result.cursor, '70000000');

    // Exactly the head block, not a range reaching back to it.
    const filter = calls.find((call) => call.method === 'eth_getLogs')!.params[0] as {
      fromBlock: string;
      toBlock: string;
    };
    assert.equal(filter.fromBlock, filter.toBlock);
    assert.equal(Number(BigInt(filter.fromBlock)), 70_000_000);
  });

  test('nothing here settles, and it says so rather than pretending', async () => {
    const { adapter } = adapterWith({ head: 1, logs: [] });

    // Null, not an error: the funds are already where they were going, so there is nothing to
    // broadcast — and null is what the settlement queue reads as "skip this chain".
    assert.equal(await adapter.prepareSettlement([]), null);

    // And an address cannot be derived on this chain at all.
    await assert.rejects(
      adapter.deriveDepositTarget({
        invoiceId: 'i1',
        payoutAddress: WALLET,
        asset: USDT,
      }),
      /wallet pool/,
    );
  });

  test('the gas snapshot carries a price and no energy figure', async () => {
    /**
     * There is no settlement transaction, so there is no energy to price. An earlier version of
     * this chain's cost model reported a settlement as free while still sending one; the fix was
     * a design with no transaction in it, and this is what that looks like at the seam.
     */
    const { adapter } = adapterWith({ head: 1, logs: [] });
    const snapshot = await adapter.probeGas();
    assert.equal(snapshot.chain, 'tron');
    assert.equal(snapshot.nativePriceUsd, 0.3);
    assert.equal(snapshot.sunPerEnergy, undefined);
  });

  test('an RPC error is raised, not swallowed into an empty poll', async (t) => {
    /**
     * The failure mode that matters: a poll that answers "no payments" when it could not ask is
     * indistinguishable from a quiet chain, and the watcher would advance its cursor past blocks
     * it never saw.
     */
    const fetchMock = mock.fn(
      async () =>
        ({
          ok: true,
          json: async () => ({ jsonrpc: '2.0', id: 1, error: { message: 'rate limited' } }),
        }) as unknown as Response,
    );
    t.mock.method(globalThis, 'fetch', fetchMock);

    const adapter = new TronAdapter(
      { chain: 'tron', rpcUrl: 'https://example.test', acceptedAssets: [USDT], pollRange: 10 },
      { nativePriceUsd: async () => 0.3 },
      { lookup: async () => null },
    );

    await assert.rejects(adapter.poll('1'), /rate limited/);
  });
});

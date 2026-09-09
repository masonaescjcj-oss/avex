import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

import type { Asset } from '../types.js';
import { NATIVE_TRANSFER_INDEX, NativeTransferScanner } from './native-transfers.js';
import { toChecksumAddress } from './evm/create2.js';

/**
 * Finding payments in a chain's own coin, against a hand-written node.
 *
 * The thing under test is a trade: a cheap question every poll, and an expensive one only
 * when the cheap one says yes. Both halves can fail quietly. Ask the cheap question wrong and
 * no native payment is ever seen — which is the state this module was written to end, where
 * BNB, ETH, POL and TRX were approved, listed, enabled by a merchant, paid by a customer, and
 * credited to nobody. Ask the expensive one wrong and somebody else's transaction is credited
 * to the merchant.
 *
 * So the requests are asserted as well as the results.
 */

const WALLET = toChecksumAddress(`0x${'11'.repeat(20)}`);
const OTHER = toChecksumAddress(`0x${'22'.repeat(20)}`);
const STRANGER = toChecksumAddress(`0x${'33'.repeat(20)}`);

const BNB: Asset = { symbol: 'BNB', chain: 'bsc', decimals: 18, kind: 'native' };

interface Tx {
  readonly hash: string;
  readonly to: string;
  readonly from?: string;
  readonly value: string;
  readonly block: number;
}

const tx = (input: Tx): unknown => ({
  hash: input.hash,
  from: input.from ?? STRANGER.toLowerCase(),
  to: input.to.toLowerCase(),
  value: input.value,
  blockNumber: `0x${input.block.toString(16)}`,
});

/**
 * A node, and a record of what it was asked.
 *
 * Faithful about two things the real one does and a careless fake would not: the request body
 * is a JSON-RPC array and the response has to be an array with matching ids, and a block
 * contains only the transactions that are really in it.
 */
function node(input: {
  readonly balances: Readonly<Record<string, string>>;
  readonly transactions?: readonly unknown[];
  readonly receipts?: Readonly<Record<string, { status?: string } | null>>;
  readonly status?: number;
  readonly unbatched?: boolean;
  /** HTTP 403 on receipts and nothing else, which is what publicnode does. */
  readonly refuseReceipts?: boolean;
  /** A block read that fails, to prove the baseline survives it. */
  readonly failBlocks?: boolean;
}) {
  const calls: { method: string; params: unknown[] }[] = [];

  const fetchMock = mock.fn(async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '[]') as {
      id: number;
      method: string;
      params: unknown[];
    }[];
    for (const entry of body) calls.push({ method: entry.method, params: entry.params });

    if (input.status !== undefined) {
      return { ok: false, status: input.status } as unknown as Response;
    }
    if (input.refuseReceipts === true && body.some((entry) => entry.method === 'eth_getTransactionReceipt')) {
      return { ok: false, status: 403 } as unknown as Response;
    }
    if (input.failBlocks === true && body.some((entry) => entry.method === 'eth_getBlockByNumber')) {
      return { ok: false, status: 500 } as unknown as Response;
    }
    if (input.unbatched === true) {
      // What a provider that refuses arrays answers with: one object, not a list.
      return {
        ok: true,
        json: async () => ({ jsonrpc: '2.0', id: 1, error: { message: 'batch not supported' } }),
      } as unknown as Response;
    }

    return {
      ok: true,
      json: async () =>
        body.map((entry) => ({
          jsonrpc: '2.0',
          id: entry.id,
          result:
            entry.method === 'eth_getBalance'
              ? (input.balances[(entry.params[0] as string).toLowerCase()] ?? '0x0')
              : entry.method === 'eth_getBlockByNumber'
                ? {
                    transactions: (input.transactions ?? []).filter(
                      (candidate) =>
                        (candidate as { blockNumber?: string }).blockNumber ===
                        (entry.params[0] as string),
                    ),
                  }
                : entry.method === 'eth_getTransactionReceipt'
                  ? (input.receipts?.[entry.params[0] as string] ?? { status: '0x1' })
                  : null,
        })),
    } as unknown as Response;
  });

  return { calls, fetchMock };
}

function scannerWith(options: {
  readonly maxBlocksPerScan?: number;
  readonly maxAddresses?: number;
  readonly maxBatch?: number;
} = {}) {
  const warnings: string[] = [];
  const scanner = new NativeTransferScanner({
    rpc: {
      url: 'https://bsc.example',
      chain: 'bsc',
      ...(options.maxBatch === undefined ? {} : { maxBatch: options.maxBatch }),
    },
    toRpcHex: (stored) =>
      /^0x[0-9a-fA-F]{40}$/.test(stored.trim()) ? stored.trim().toLowerCase() : null,
    toStored: (hex) => toChecksumAddress(hex),
    ...(options.maxBlocksPerScan === undefined
      ? {}
      : { maxBlocksPerScan: options.maxBlocksPerScan }),
    ...(options.maxAddresses === undefined ? {} : { maxAddresses: options.maxAddresses }),
    warn: (message) => warnings.push(message),
  });
  return { scanner, warnings };
}

const request = (over: Partial<Parameters<NativeTransferScanner['scan']>[0]> = {}) => ({
  asset: BNB,
  watched: [WALLET],
  from: 996,
  to: 1000,
  head: 1000,
  ...over,
});

describe('finding a payment in the chain’s own coin', () => {
  test('the first poll takes a baseline and credits nothing', async (t) => {
    /**
     * The comparison needs a previous balance, and it cannot be fetched: `eth_getBalance` at
     * an old block is an archive request, which public nodes refuse. So the first look
     * records and says so — correct, because a wallet is watched from the moment an invoice
     * opens on it and the invoice always precedes the payment.
     */
    const { calls, fetchMock } = node({ balances: { [WALLET.toLowerCase()]: '0xde0b6b3a7640000' } });
    t.mock.method(global, 'fetch', fetchMock);
    const { scanner, warnings } = scannerWith();

    assert.deepEqual(await scanner.scan(request()), []);
    assert.equal(calls.filter((call) => call.method === 'eth_getBalance').length, 1);
    assert.equal(calls.some((call) => call.method === 'eth_getBlockByNumber'), false);
    assert.match(warnings[0]!, /baseline/);
  });

  test('a balance that rose is attributed to the transaction that raised it', async (t) => {
    const hash = `0x${'ab'.repeat(32)}`;
    const first = node({ balances: { [WALLET.toLowerCase()]: '0x0' } });
    t.mock.method(global, 'fetch', first.fetchMock);
    const { scanner } = scannerWith();
    await scanner.scan(request());

    const second = node({
      balances: { [WALLET.toLowerCase()]: '0xde0b6b3a7640000' },
      transactions: [tx({ hash, to: WALLET, value: '0xde0b6b3a7640000', block: 999 })],
    });
    t.mock.method(global, 'fetch', second.fetchMock);
    const payments = await scanner.scan(request());

    assert.equal(payments.length, 1);
    const [payment] = payments;
    assert.equal(payment!.to, WALLET, 'checksummed, as the address book stores it');
    assert.equal(payment!.from, STRANGER);
    assert.equal(payment!.amount, 1_000_000_000_000_000_000n);
    assert.equal(payment!.asset.symbol, 'BNB');
    assert.equal(payment!.txHash, hash);
    assert.equal(payment!.blockNumber, 999);
    assert.equal(payment!.confirmations, 2);
    assert.equal(payment!.transferIndex, NATIVE_TRANSFER_INDEX);
    // Five blocks in the window, each read once, and one receipt for the one candidate.
    assert.equal(second.calls.filter((call) => call.method === 'eth_getBlockByNumber').length, 5);
    assert.equal(second.calls.filter((call) => call.method === 'eth_getTransactionReceipt').length, 1);
  });

  test('a quiet wallet costs one balance call and no blocks', async (t) => {
    // The whole point of the trade: the expensive half runs on the polls that have something.
    const first = node({ balances: { [WALLET.toLowerCase()]: '0x64' } });
    t.mock.method(global, 'fetch', first.fetchMock);
    const { scanner } = scannerWith();
    await scanner.scan(request());

    const second = node({ balances: { [WALLET.toLowerCase()]: '0x64' } });
    t.mock.method(global, 'fetch', second.fetchMock);
    assert.deepEqual(await scanner.scan(request()), []);
    assert.deepEqual(second.calls.map((call) => call.method), ['eth_getBalance']);
  });

  test('a balance that fell is not a payment', async (t) => {
    // The merchant spent from the wallet. Nothing arrived, and the new baseline is the point.
    const first = node({ balances: { [WALLET.toLowerCase()]: '0x64' } });
    t.mock.method(global, 'fetch', first.fetchMock);
    const { scanner } = scannerWith();
    await scanner.scan(request());

    const second = node({ balances: { [WALLET.toLowerCase()]: '0x32' } });
    t.mock.method(global, 'fetch', second.fetchMock);
    assert.deepEqual(await scanner.scan(request()), []);
    assert.equal(second.calls.some((call) => call.method === 'eth_getBlockByNumber'), false);
  });

  test('a transaction to somebody else’s wallet in the same block is not ours', async (t) => {
    const first = node({ balances: { [WALLET.toLowerCase()]: '0x0' } });
    t.mock.method(global, 'fetch', first.fetchMock);
    const { scanner } = scannerWith();
    await scanner.scan(request());

    const second = node({
      balances: { [WALLET.toLowerCase()]: '0x64' },
      transactions: [
        tx({ hash: `0x${'aa'.repeat(32)}`, to: WALLET, value: '0x64', block: 1000 }),
        tx({ hash: `0x${'bb'.repeat(32)}`, to: OTHER, value: '0xffff', block: 1000 }),
      ],
    });
    t.mock.method(global, 'fetch', second.fetchMock);
    const payments = await scanner.scan(request());

    assert.equal(payments.length, 1);
    assert.equal(payments[0]!.amount, 100n);
  });

  test('a reverted transaction moved nothing', async (t) => {
    const hash = `0x${'cc'.repeat(32)}`;
    const first = node({ balances: { [WALLET.toLowerCase()]: '0x0' } });
    t.mock.method(global, 'fetch', first.fetchMock);
    const { scanner } = scannerWith();
    await scanner.scan(request());

    const second = node({
      balances: { [WALLET.toLowerCase()]: '0x64' },
      transactions: [tx({ hash, to: WALLET, value: '0x64', block: 1000 })],
      receipts: { [hash]: { status: '0x0' } },
    });
    t.mock.method(global, 'fetch', second.fetchMock);
    assert.deepEqual(await scanner.scan(request()), []);
  });

  test('a receipt with no status at all is taken as success, because TRON sends none', async (t) => {
    /**
     * TRON's Ethereum-compatible RPC answers a plain transfer's receipt without a status
     * field. Comparing it to `0x1` would refuse every TRX payment there is.
     */
    const hash = `0x${'dd'.repeat(32)}`;
    const first = node({ balances: { [WALLET.toLowerCase()]: '0x0' } });
    t.mock.method(global, 'fetch', first.fetchMock);
    const { scanner } = scannerWith();
    await scanner.scan(request());

    const second = node({
      balances: { [WALLET.toLowerCase()]: '0x64' },
      transactions: [tx({ hash, to: WALLET, value: '0x64', block: 1000 })],
      receipts: { [hash]: {} },
    });
    t.mock.method(global, 'fetch', second.fetchMock);
    assert.equal((await scanner.scan(request())).length, 1);
  });

  test('a rise no transaction accounts for is reported, not passed over', async (t) => {
    /**
     * A contract sent it — an exchange paying out through a batching contract — so the value
     * moved in an internal call that appears in no transaction's `to` and in no log. Only a
     * tracing API would show it. The money is really in the wallet, so silence here would be
     * the exact failure this module exists to end.
     */
    const first = node({ balances: { [WALLET.toLowerCase()]: '0x0' } });
    t.mock.method(global, 'fetch', first.fetchMock);
    const { scanner, warnings } = scannerWith();
    await scanner.scan(request());

    const second = node({ balances: { [WALLET.toLowerCase()]: '0x64' }, transactions: [] });
    t.mock.method(global, 'fetch', second.fetchMock);
    assert.deepEqual(await scanner.scan(request()), []);

    const reported = warnings.find((message) => message.includes('no transaction'));
    assert.ok(reported, `expected a warning, got ${JSON.stringify(warnings)}`);
    assert.match(reported, /--credit-tx/);
  });

  test('a window wider than one scan reads the newest end and says so', async (t) => {
    const first = node({ balances: { [WALLET.toLowerCase()]: '0x0' } });
    t.mock.method(global, 'fetch', first.fetchMock);
    const { scanner, warnings } = scannerWith({ maxBlocksPerScan: 2 });
    await scanner.scan(request());

    const second = node({ balances: { [WALLET.toLowerCase()]: '0x64' }, transactions: [] });
    t.mock.method(global, 'fetch', second.fetchMock);
    await scanner.scan(request({ from: 900, to: 1000 }));

    assert.equal(second.calls.filter((call) => call.method === 'eth_getBlockByNumber').length, 2);
    const heights = second.calls
      .filter((call) => call.method === 'eth_getBlockByNumber')
      .map((call) => Number(BigInt(call.params[0] as string)));
    assert.deepEqual(heights, [999, 1000], 'the newest end, where a fresh payment is');
    assert.ok(warnings.some((message) => message.includes('wider than')));
  });

  test('too many addresses to probe is refused rather than attempted', async (t) => {
    /**
     * A forwarder chain has one deposit address per invoice and could have thousands of
     * them; probing those every five seconds is not a thing to do. Invoice creation refuses a
     * native invoice on a forwarder address for the same reason, so the two ends agree.
     */
    const { calls, fetchMock } = node({ balances: {} });
    t.mock.method(global, 'fetch', fetchMock);
    const { scanner, warnings } = scannerWith({ maxAddresses: 2 });

    const many = [WALLET, OTHER, STRANGER];
    assert.deepEqual(await scanner.scan(request({ watched: many })), []);
    assert.deepEqual(calls, [], 'nothing was asked');
    assert.match(warnings[0]!, /own wallet/);
  });

  test('an unparseable address is skipped, not fatal', async (t) => {
    // One bad row must not stop a chain being watched for everybody else.
    const { calls, fetchMock } = node({ balances: { [WALLET.toLowerCase()]: '0x64' } });
    t.mock.method(global, 'fetch', fetchMock);
    const { scanner } = scannerWith();

    await scanner.scan(request({ watched: ['not-an-address', WALLET] }));
    assert.equal(calls.filter((call) => call.method === 'eth_getBalance').length, 1);
  });

  test('nothing watched asks nothing', async (t) => {
    const { calls, fetchMock } = node({ balances: {} });
    t.mock.method(global, 'fetch', fetchMock);
    const { scanner } = scannerWith();

    assert.deepEqual(await scanner.scan(request({ watched: [] })), []);
    assert.deepEqual(calls, []);
  });

  test('an endpoint that refuses batches says so as itself', async (t) => {
    // Rather than as "cannot read property of undefined", because the fix is configuration.
    const { fetchMock } = node({ balances: {}, unbatched: true });
    t.mock.method(global, 'fetch', fetchMock);
    const { scanner } = scannerWith();

    await assert.rejects(scanner.scan(request()), /batched responses/);
  });

  test('a refused request is raised, not swallowed into an empty poll', async (t) => {
    const { fetchMock } = node({ balances: {}, status: 429 });
    t.mock.method(global, 'fetch', fetchMock);
    const { scanner } = scannerWith();

    await assert.rejects(scanner.scan(request()), /HTTP 429/);
  });

  test('where receipts are refused, the balance that moved is the confirmation', async (t) => {
    /**
     * publicnode answers `eth_getTransactionReceipt` with a 403, for a transaction three
     * blocks old, batched or not. So the rise itself is the proof: when the transactions
     * addressed to the wallet add up to exactly what it gained, every one of them moved its
     * money and nothing else did.
     */
    const hash = `0x${'ee'.repeat(32)}`;
    const first = node({ balances: { [WALLET.toLowerCase()]: '0x0' } });
    t.mock.method(global, 'fetch', first.fetchMock);
    const { scanner, warnings } = scannerWith();
    await scanner.scan(request({ from: 995, to: 995 }));

    const second = node({
      balances: { [WALLET.toLowerCase()]: '0x64' },
      transactions: [tx({ hash, to: WALLET, value: '0x64', block: 1000 })],
      receipts: { [hash]: null },
      refuseReceipts: true,
    });
    t.mock.method(global, 'fetch', second.fetchMock);
    const payments = await scanner.scan(request());

    assert.equal(payments.length, 1, 'credited on the balance, with no receipt');
    assert.equal(payments[0]!.amount, 100n);
    assert.ok(warnings.some((message) => message.includes('will not serve transaction receipts')));
  });

  test('and nothing is credited when the transactions do not account for the rise', async (t) => {
    /**
     * The difference is a reverted transfer, gas the wallet spent itself, or a contract's
     * internal call, and none of those can be told apart without a receipt. Crediting the
     * part that is visible would be crediting on a guess.
     */
    const hash = `0x${'ff'.repeat(32)}`;
    const first = node({ balances: { [WALLET.toLowerCase()]: '0x0' } });
    t.mock.method(global, 'fetch', first.fetchMock);
    const { scanner, warnings } = scannerWith();
    await scanner.scan(request({ from: 995, to: 995 }));

    const second = node({
      // Rose by 200, but only a transfer of 100 is visible.
      balances: { [WALLET.toLowerCase()]: '0xc8' },
      transactions: [tx({ hash, to: WALLET, value: '0x64', block: 1000 })],
      refuseReceipts: true,
    });
    t.mock.method(global, 'fetch', second.fetchMock);

    assert.deepEqual(await scanner.scan(request()), []);
    const reported = warnings.find((message) => message.includes('account for'));
    assert.ok(reported, `expected a warning, got ${JSON.stringify(warnings)}`);
    assert.match(reported, /--credit-tx/);
  });

  test('a refused receipt is asked for once, not once a payment', async (t) => {
    const hash = `0x${'11'.repeat(32)}`;
    const first = node({ balances: { [WALLET.toLowerCase()]: '0x0' } });
    t.mock.method(global, 'fetch', first.fetchMock);
    const { scanner } = scannerWith();
    await scanner.scan(request({ from: 995, to: 995 }));

    const second = node({
      balances: { [WALLET.toLowerCase()]: '0x64' },
      transactions: [tx({ hash, to: WALLET, value: '0x64', block: 1000 })],
      refuseReceipts: true,
    });
    t.mock.method(global, 'fetch', second.fetchMock);
    await scanner.scan(request());

    const third = node({
      balances: { [WALLET.toLowerCase()]: '0xc8' },
      transactions: [tx({ hash: `0x${'22'.repeat(32)}`, to: WALLET, value: '0x64', block: 1000 })],
      refuseReceipts: true,
    });
    t.mock.method(global, 'fetch', third.fetchMock);
    await scanner.scan(request({ from: 1000, to: 1000 }));

    assert.equal(
      third.calls.some((call) => call.method === 'eth_getTransactionReceipt'),
      false,
      'the endpoint said no once and is not asked again',
    );
  });

  test('a failure in the expensive half leaves the baseline, so the next poll retries', async (t) => {
    /**
     * The bug this property closes. The baseline used to advance before the blocks were read,
     * so a refused request or a dropped connection left a baseline that already included the
     * payment — and the retry found a balance that had not moved. One transient error, one
     * payment gone. Nothing is written now until the poll has finished.
     */
    const hash = `0x${'33'.repeat(32)}`;
    const first = node({ balances: { [WALLET.toLowerCase()]: '0x0' } });
    t.mock.method(global, 'fetch', first.fetchMock);
    const { scanner } = scannerWith();
    await scanner.scan(request({ from: 995, to: 995 }));

    // The blocks cannot be read this time.
    const broken = node({ balances: { [WALLET.toLowerCase()]: '0x64' }, failBlocks: true });
    t.mock.method(global, 'fetch', broken.fetchMock);
    await assert.rejects(scanner.scan(request()));

    // The same rise, now readable: the payment is still found.
    const recovered = node({
      balances: { [WALLET.toLowerCase()]: '0x64' },
      transactions: [tx({ hash, to: WALLET, value: '0x64', block: 1000 })],
    });
    t.mock.method(global, 'fetch', recovered.fetchMock);
    const payments = await scanner.scan(request());

    assert.equal(payments.length, 1, 'the retry sees the rise the failed poll did not commit');
    assert.equal(payments[0]!.txHash, hash);
  });

  test('balance calls are batched, not sent one at a time', async (t) => {
    /**
     * A hundred wallets is the pool's limit, and a hundred round trips every five seconds is
     * a rate limit and then a ban. One request carries them.
     */
    const wallets = Array.from({ length: 12 }, (_, index) =>
      toChecksumAddress(`0x${String(index + 1).padStart(2, '0').repeat(20)}`),
    );
    const { fetchMock } = node({ balances: {} });
    t.mock.method(global, 'fetch', fetchMock);
    const { scanner } = scannerWith({ maxBatch: 10 });

    await scanner.scan(request({ watched: wallets }));
    // Twelve balances over a batch of ten: two requests, not twelve.
    assert.equal(fetchMock.mock.callCount(), 2);
  });
});

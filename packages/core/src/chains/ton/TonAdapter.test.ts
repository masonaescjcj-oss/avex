import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

import type { Asset } from '../../types.js';
import { TonAdapter } from './TonAdapter.js';
import { TonApi } from './TonApi.js';
import { normalizeTonAddress, tonAddressRaw } from './address.js';

/**
 * Watching TON, against a hand-written indexer rather than toncenter.
 *
 * Three things here fail silently when they are wrong, and each is a lost payment:
 *
 *   - **Where the comment is.** On a native transfer it is the message body; on a jetton
 *     transfer it is inside the forward payload. Read the wrong one and every payment arrives
 *     unnamed, to be matched by amount or parked.
 *   - **Which address is ours.** The indexer answers in raw form and a merchant registers the
 *     friendly one. Compared literally, nothing ever matches.
 *   - **What a native payment is.** Every jetton payment also delivers a one-nanoton
 *     `jetton_notify` to the wallet. Counted as TON, it puts a speck of dust against an open
 *     invoice each time somebody pays in USDT.
 *
 * So the requests are asserted as well as the results.
 */

/** Tether's real jetton master, as the asset registry holds it. */
const USDT_MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';

/**
 * The same contract as the indexer answers with: raw, and in upper case.
 *
 * The case is the fixture's whole point. These were lower case at first, the tests passed,
 * and against toncenter every USDT payment was ignored — the registry holds the friendly
 * form, the response is upper-case raw, and a string comparison of the two matches nothing
 * with no error at all. A fixture that does not spell things the way the real service does is
 * a fixture that agrees with the code instead of checking it.
 */
const USDT_MASTER_RAW = tonAddressRaw(USDT_MASTER).toUpperCase().replace('0X', '0');

/** A wallet and a stranger, raw and upper case, as the indexer reports them. */
const WALLET_RAW = '0:852443F8599FE6A5DA34FE43049AC4E0BEB3071BB2BFB56635EA9421287C283A';
const STRANGER_RAW = '0:0862EFDF28831234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234';
const OTHER_RAW = '0:1111111111111111111111111111111111111111111111111111111111111111';

/** The same wallet as it is stored and shown: friendly, non-bounceable. */
const WALLET = normalizeTonAddress(WALLET_RAW);
const STRANGER = normalizeTonAddress(STRANGER_RAW);

const UNKNOWN_MASTER_RAW = '0:2222222222222222222222222222222222222222222222222222222222222222';

const USDT: Asset = {
  symbol: 'USDT',
  chain: 'ton',
  decimals: 6,
  kind: 'jetton',
  contract: USDT_MASTER,
};
const TON: Asset = { symbol: 'TON', chain: 'ton', decimals: 9, kind: 'native' };

const comment = (text: string): unknown => ({ '@type': 'text_comment', comment: text });

function jettonTransfer(input: {
  readonly amount: string;
  readonly hash?: string;
  readonly now?: number;
  readonly master?: string;
  readonly destination?: string;
  readonly source?: string;
  readonly memo?: string;
  readonly aborted?: boolean;
}): unknown {
  return {
    query_id: '0',
    source: input.source ?? STRANGER_RAW,
    destination: input.destination ?? WALLET_RAW,
    amount: input.amount,
    jetton_master: input.master ?? USDT_MASTER_RAW,
    transaction_hash: input.hash ?? Buffer.from('a'.repeat(32)).toString('base64'),
    transaction_lt: '102304732000005',
    transaction_now: input.now ?? 1_700_000_100,
    transaction_aborted: input.aborted ?? false,
    decoded_forward_payload: input.memo === undefined ? null : comment(input.memo),
  };
}

function transaction(input: {
  readonly value: string;
  readonly hash?: string;
  readonly now?: number;
  readonly source?: string;
  readonly destination?: string;
  readonly memo?: string;
  readonly body?: unknown;
  readonly aborted?: boolean;
  readonly destroyed?: boolean;
  /** What the sender asked for if the account could not accept it. */
  readonly bounce?: boolean;
  /** Whether this message is itself a bounce coming back. */
  readonly bounced?: boolean;
}): unknown {
  return {
    hash: input.hash ?? Buffer.from('b'.repeat(32)).toString('base64'),
    lt: '102304961000003',
    now: input.now ?? 1_700_000_100,
    mc_block_seqno: 91_563_667,
    description: {
      aborted: input.aborted ?? false,
      destroyed: input.destroyed ?? false,
      credit_ph: { credit: input.value },
    },
    in_msg: {
      source: input.source ?? STRANGER_RAW,
      destination: input.destination ?? WALLET_RAW,
      value: input.value,
      /**
       * Non-bounceable by default, because that is what wallets send to a `UQ` address —
       * which is the form the checkout displays, precisely so a transfer cannot come back.
       */
      bounce: input.bounce ?? false,
      bounced: input.bounced ?? false,
      message_content: {
        decoded:
          input.body !== undefined
            ? input.body
            : input.memo === undefined
              ? null
              : comment(input.memo),
      },
    },
  };
}

/**
 * The indexer, and a record of what it was asked.
 *
 * The query matters as much as the answer: asking about the friendly form of an address, or
 * omitting `direction=in`, returns something plausible and wrong.
 */
function indexer(input: {
  readonly utime: number;
  readonly jettons?: readonly unknown[];
  readonly transactions?: readonly unknown[];
  readonly status?: number;
}) {
  const calls: {
    path: string;
    params: Record<string, string>;
    headers: Record<string, string>;
  }[] = [];

  const fetchMock = mock.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/api\/v3\//, '');
    calls.push({
      path,
      params: Object.fromEntries(parsed.searchParams),
      headers: init?.headers ?? {},
    });

    if (input.status !== undefined) {
      return { ok: false, status: input.status } as unknown as Response;
    }

    const body =
      path === 'masterchainInfo'
        ? { last: { seqno: 91_563_441, root_hash: 'root', gen_utime: String(input.utime) } }
        : path === 'jetton/transfers'
          ? { jetton_transfers: paged(input.jettons ?? [], parsed) }
          : path === 'transactions'
            ? { transactions: paged(input.transactions ?? [], parsed) }
            : {};

    return { ok: true, json: async () => body } as unknown as Response;
  });

  return { calls, fetchMock };
}

/** Honour `limit`/`offset` so paging is exercised rather than assumed. */
function paged(rows: readonly unknown[], url: URL): readonly unknown[] {
  const limit = Number(url.searchParams.get('limit') ?? '100');
  const offset = Number(url.searchParams.get('offset') ?? '0');
  return rows.slice(offset, offset + limit);
}

function adapterWith(options: {
  readonly utime: number;
  readonly jettons?: readonly unknown[];
  readonly transactions?: readonly unknown[];
  readonly watched?: readonly string[];
  readonly assets?: readonly Asset[];
  readonly pageSize?: number;
  readonly maxPages?: number;
  readonly status?: number;
  readonly apiKey?: string;
}) {
  const { calls, fetchMock } = indexer({
    utime: options.utime,
    ...(options.jettons === undefined ? {} : { jettons: options.jettons }),
    ...(options.transactions === undefined ? {} : { transactions: options.transactions }),
    ...(options.status === undefined ? {} : { status: options.status }),
  });
  const known = new Set(options.watched ?? [WALLET]);
  const warnings: string[] = [];

  const adapter = new TonAdapter(
    {
      acceptedAssets: options.assets ?? [USDT],
      ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
      ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
      warn: (message) => warnings.push(message),
    },
    new TonApi({
      apiUrl: 'https://toncenter.example/api/v3',
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    }),
    {
      lookup: async (address) => (known.has(address) ? 'invoice-1' : null),
      watched: async () => [...known],
    },
    { nativePriceUsd: async () => 5 },
  );

  return { adapter, calls, fetchMock, warnings };
}

describe('watching TON', () => {
  test('a jetton payment is credited with its comment, to the wallet as stored', async (t) => {
    /**
     * The case the whole chain exists for: USDT on TON, with the comment that names the
     * invoice. The indexer answers in raw form and the merchant registered the friendly one,
     * so the address has to cross that boundary before anything compares it.
     */
    const { adapter, calls, fetchMock } = adapterWith({
      utime: 1_700_000_200,
      jettons: [jettonTransfer({ amount: '1012000', memo: 'AVEX-7f3c9a', now: 1_700_000_150 })],
    });
    t.mock.method(global, 'fetch', fetchMock);

    const result = await adapter.poll('1700000100');

    assert.equal(result.payments.length, 1);
    const [payment] = result.payments;
    assert.equal(payment!.to, WALLET, 'the friendly form, as the merchant registered it');
    assert.equal(payment!.from, STRANGER);
    assert.equal(payment!.memo, 'AVEX-7f3c9a');
    assert.equal(payment!.amount, 1_012_000n);
    assert.equal(payment!.asset.symbol, 'USDT');
    assert.equal(payment!.blockNumber, 1_700_000_150);
    assert.equal(payment!.confirmations, 1, 'committed is final on TON');
    assert.equal(result.cursor, '1700000200');

    // Asked about the owner in raw form, incoming only, over the window.
    const query = calls.find((call) => call.path === 'jetton/transfers');
    /**
     * The friendly form, because that is the only one this index keys on. Given raw — the
     * form it answers with — it returns an empty list and a 200, which reads as a wallet
     * nobody has paid.
     */
    assert.equal(query?.params['owner_address'], WALLET);
    assert.equal(query?.params['direction'], 'in');
    assert.equal(query?.params['start_utime'], '1700000101');
    assert.equal(query?.params['end_utime'], '1700000200');
    assert.equal(query?.params['sort'], 'asc', 'ascending, so offset paging is stable');
  });

  test('a jetton payment without a comment is still credited', async (t) => {
    /**
     * The comment names the invoice; its absence does not make the money not have arrived.
     * The payment is handed over unnamed and the pooled amount rules take it from there,
     * which is the same generosity every other shared-wallet chain has.
     */
    const { adapter, fetchMock } = adapterWith({
      utime: 1_700_000_200,
      jettons: [jettonTransfer({ amount: '500000' })],
    });
    t.mock.method(global, 'fetch', fetchMock);

    const result = await adapter.poll('1700000100');
    assert.equal(result.payments.length, 1);
    assert.equal(result.payments[0]!.memo, undefined);
    assert.equal(result.payments[0]!.amount, 500_000n);
  });

  test('a jetton we do not accept is ignored', async (t) => {
    // Minting a jetton called USDT costs a few cents.
    const { adapter, fetchMock } = adapterWith({
      utime: 1_700_000_200,
      jettons: [jettonTransfer({ amount: '9999000000', master: UNKNOWN_MASTER_RAW })],
    });
    t.mock.method(global, 'fetch', fetchMock);

    assert.deepEqual((await adapter.poll('1700000100')).payments, []);
  });

  test('an aborted transaction moved nothing', async (t) => {
    const { adapter, fetchMock } = adapterWith({
      utime: 1_700_000_200,
      jettons: [jettonTransfer({ amount: '1000000', aborted: true })],
    });
    t.mock.method(global, 'fetch', fetchMock);

    assert.deepEqual((await adapter.poll('1700000100')).payments, []);
  });

  test('a transfer to somebody else’s wallet is not ours', async (t) => {
    // The indexer was asked for one owner's incoming transfers; checked again anyway.
    const { adapter, fetchMock } = adapterWith({
      utime: 1_700_000_200,
      jettons: [jettonTransfer({ amount: '1000000', destination: OTHER_RAW })],
    });
    t.mock.method(global, 'fetch', fetchMock);

    assert.deepEqual((await adapter.poll('1700000100')).payments, []);
  });

  test('two transfers in one transaction get different identities', async (t) => {
    /**
     * A sender paying two of our wallets at once. The payment sink dedupes on the transaction
     * plus the transfer index, so a shared index would silently drop the second payment.
     */
    const hash = Buffer.from('c'.repeat(32)).toString('base64');
    const { adapter, fetchMock } = adapterWith({
      utime: 1_700_000_200,
      jettons: [
        jettonTransfer({ amount: '1000000', hash }),
        jettonTransfer({ amount: '2000000', hash }),
      ],
    });
    t.mock.method(global, 'fetch', fetchMock);

    const result = await adapter.poll('1700000100');
    assert.equal(result.payments.length, 2);
    const indices = result.payments.map((payment) => payment.transferIndex);
    assert.equal(new Set(indices).size, 2, `two identities expected, got ${indices.join(',')}`);
    assert.equal(indices.includes(0), false, 'and never zero, which a native credit uses');
    assert.equal(new Set(result.payments.map((payment) => payment.txHash)).size, 1);
  });

  test('the transaction hash is hex, not base64', async (t) => {
    // Base64 carries `+`, `/` and `=`, which make a hash awkward in a URL, a log line and the
    // sink's identity key. Hex is also what an explorer takes.
    const { adapter, fetchMock } = adapterWith({
      utime: 1_700_000_200,
      jettons: [jettonTransfer({ amount: '1000000', hash: 'Bv28N8gvSQQuwVkGGuBPqJ7m7QMJb+AzaaftBDIdu78=' })],
    });
    t.mock.method(global, 'fetch', fetchMock);

    const result = await adapter.poll('1700000100');
    assert.match(result.payments[0]!.txHash, /^[0-9a-f]{64}$/);
  });

  test('native TON is credited, with its comment', async (t) => {
    const { adapter, calls, fetchMock } = adapterWith({
      utime: 1_700_000_200,
      assets: [TON],
      transactions: [transaction({ value: '23451200000', memo: 'AVEX-2b81ff' })],
    });
    t.mock.method(global, 'fetch', fetchMock);

    const result = await adapter.poll('1700000100');
    assert.equal(result.payments.length, 1);
    assert.equal(result.payments[0]!.amount, 23_451_200_000n);
    assert.equal(result.payments[0]!.asset.symbol, 'TON');
    assert.equal(result.payments[0]!.memo, 'AVEX-2b81ff');
    assert.equal(result.payments[0]!.transferIndex, 0);
    // No jetton accepted, so the jetton index was not consulted at all.
    assert.equal(calls.some((call) => call.path === 'jetton/transfers'), false);
    assert.equal(calls.find((call) => call.path === 'transactions')?.params['account'], WALLET);
  });

  test('a payment into a wallet with no code deployed is credited', async (t) => {
    /**
     * The bug that cost a merchant two real payments, reproduced from the transaction toncenter
     * actually returned for one of them.
     *
     * A TON wallet that has never *sent* anything has no code deployed. Paying into it produces
     * a transaction marked `aborted`, because the compute phase had nothing to run — and the
     * money lands anyway, in the credit phase, which happens first. `credit_ph` says so: the
     * full 0.733 TON.
     *
     * This adapter skipped every `aborted` row, so every payment into a fresh wallet was
     * invisible. That is the wallet every new merchant has, and the invoice sat at `pending`
     * with the money sitting in their account.
     */
    const { adapter, fetchMock } = adapterWith({
      utime: 1_789_241_100,
      assets: [TON],
      transactions: [
        {
          hash: 'LuI/NPOEITFpHeuVLYkDPonBtHGOctyZKUBK1v5J3Vc=',
          lt: '103057265000031',
          now: 1_789_241_018,
          description: {
            type: 'ord',
            aborted: true,
            destroyed: false,
            credit_first: true,
            storage_ph: { storage_fees_collected: '98', status_change: 'unchanged' },
            credit_ph: { credit: '733000000' },
            compute_ph: { skipped: true, reason: 'no_state' },
          },
          in_msg: {
            source: STRANGER_RAW,
            destination: WALLET_RAW,
            value: '733000000',
            bounce: false,
            bounced: false,
            message_content: { decoded: comment('AVEX-74DBECA32398') },
          },
        },
      ],
    });
    t.mock.method(global, 'fetch', fetchMock);

    const result = await adapter.poll('1789241000');
    assert.equal(result.payments.length, 1, 'aborted is about the compute phase, not the money');
    assert.equal(result.payments[0]!.amount, 733_000_000n);
    assert.equal(result.payments[0]!.memo, 'AVEX-74DBECA32398');
  });

  test('a bounceable transfer the account could not accept is not credited', async (t) => {
    /**
     * The other half, and why `aborted` cannot simply be ignored either. If the sender set
     * `bounce: true` and the transaction aborted, the action phase sends the value back minus
     * fees — so the payer has their money and we must not say they paid.
     */
    const { adapter, fetchMock } = adapterWith({
      utime: 1_700_000_200,
      assets: [TON],
      transactions: [
        transaction({ value: '5000000000', memo: 'AVEX-bounced', aborted: true, bounce: true }),
      ],
    });
    t.mock.method(global, 'fetch', fetchMock);

    assert.equal((await adapter.poll('1700000100')).payments.length, 0);
  });

  test('a bounce arriving is a refund, not a payment', async (t) => {
    // Somebody else's transfer coming back through our wallet. It carries value and a source
    // and looks like a payment in every other respect.
    const { adapter, fetchMock } = adapterWith({
      utime: 1_700_000_200,
      assets: [TON],
      transactions: [transaction({ value: '5000000000', bounced: true, body: { '@type': 'empty_cell' } })],
    });
    t.mock.method(global, 'fetch', fetchMock);

    assert.equal((await adapter.poll('1700000100')).payments.length, 0);
  });

  test('an account destroyed in the same transaction keeps nothing', async (t) => {
    const { adapter, fetchMock } = adapterWith({
      utime: 1_700_000_200,
      assets: [TON],
      transactions: [transaction({ value: '5000000000', memo: 'AVEX-gone', destroyed: true })],
    });
    t.mock.method(global, 'fetch', fetchMock);

    assert.equal((await adapter.poll('1700000100')).payments.length, 0);
  });

  test('a jetton notification is not a nanoton of TON', async (t) => {
    /**
     * The exclusion that stops every USDT payment also crediting a speck of dust. A jetton
     * transfer delivers a `jetton_notify` message to the owner's wallet with one nanoton
     * attached; on a pooled wallet the sole open invoice would take it as an underpayment.
     */
    const { adapter, fetchMock } = adapterWith({
      utime: 1_700_000_200,
      assets: [TON],
      transactions: [
        transaction({ value: '1', body: { '@type': 'jetton_notify', query_id: '17' } }),
        transaction({ value: '5000000000', hash: Buffer.from('d'.repeat(32)).toString('base64') }),
      ],
    });
    t.mock.method(global, 'fetch', fetchMock);

    const result = await adapter.poll('1700000100');
    assert.equal(result.payments.length, 1, 'the real transfer, not the notification');
    assert.equal(result.payments[0]!.amount, 5_000_000_000n);
  });

  test('an empty body is a plain transfer and counts', async (t) => {
    const { adapter, fetchMock } = adapterWith({
      utime: 1_700_000_200,
      assets: [TON],
      transactions: [transaction({ value: '1000000000', body: { '@type': 'empty_cell' } })],
    });
    t.mock.method(global, 'fetch', fetchMock);

    assert.equal((await adapter.poll('1700000100')).payments.length, 1);
  });

  test('a zero-value message is not a payment', async (t) => {
    const { adapter, fetchMock } = adapterWith({
      utime: 1_700_000_200,
      assets: [TON],
      transactions: [transaction({ value: '0' })],
    });
    t.mock.method(global, 'fetch', fetchMock);

    assert.deepEqual((await adapter.poll('1700000100')).payments, []);
  });

  test('both currencies on one wallet are watched', async (t) => {
    const { adapter, calls, fetchMock } = adapterWith({
      utime: 1_700_000_200,
      assets: [USDT, TON],
      jettons: [jettonTransfer({ amount: '1000000' })],
      transactions: [transaction({ value: '2000000000' })],
    });
    t.mock.method(global, 'fetch', fetchMock);

    const result = await adapter.poll('1700000100');
    assert.deepEqual(
      result.payments.map((payment) => payment.asset.symbol).sort(),
      ['TON', 'USDT'],
    );
    assert.ok(calls.some((call) => call.path === 'jetton/transfers'));
    assert.ok(calls.some((call) => call.path === 'transactions'));
  });

  test('with nothing watched the indexer is asked only for the head', async (t) => {
    const { adapter, calls, fetchMock } = adapterWith({ utime: 1_700_000_200, watched: [] });
    t.mock.method(global, 'fetch', fetchMock);

    const result = await adapter.poll('1700000100');
    assert.deepEqual(result.payments, []);
    assert.equal(result.cursor, '1700000200');
    assert.deepEqual(calls.map((call) => call.path), ['masterchainInfo']);
  });

  test('a cursor already at the head advances nothing', async (t) => {
    const { adapter, fetchMock } = adapterWith({ utime: 1_700_000_200 });
    t.mock.method(global, 'fetch', fetchMock);

    const result = await adapter.poll('1700000200');
    assert.deepEqual(result.payments, []);
    assert.equal(result.cursor, '1700000200');
  });

  test('a window wider than the pages allowed is reported, not passed over silently', async (t) => {
    const many = Array.from({ length: 6 }, (_, index) =>
      jettonTransfer({ amount: '1000', hash: Buffer.from(String(index).repeat(32)).toString('base64') }),
    );
    const { adapter, fetchMock, warnings } = adapterWith({
      utime: 1_700_000_200,
      pageSize: 2,
      maxPages: 2,
      jettons: many,
    });
    t.mock.method(global, 'fetch', fetchMock);

    const result = await adapter.poll('1700000100');
    assert.equal(result.payments.length, 4, 'two pages of two');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /were not read/);
  });

  test('a refused request is raised, not swallowed into an empty poll', async (t) => {
    // 429 is the one that will happen: the anonymous rate limit is about a request a second.
    const { adapter, fetchMock } = adapterWith({ utime: 1_700_000_200, status: 429 });
    t.mock.method(global, 'fetch', fetchMock);

    await assert.rejects(adapter.poll('1700000100'), /HTTP 429/);
  });

  test('the API key is sent when there is one', async (t) => {
    // Without it toncenter allows about a request a second, which a poll over a few wallets
    // exceeds — so a key that is configured and not sent looks like a rate-limited chain.
    const { adapter, calls, fetchMock } = adapterWith({ utime: 1_700_000_200, apiKey: 'secret-key' });
    t.mock.method(global, 'fetch', fetchMock);
    await adapter.poll('1700000199');

    assert.equal(calls[0]?.headers['X-API-Key'], 'secret-key');
  });

  test('and no key header is sent when there is none', async (t) => {
    const { adapter, calls, fetchMock } = adapterWith({ utime: 1_700_000_200 });
    t.mock.method(global, 'fetch', fetchMock);
    await adapter.poll('1700000199');

    assert.deepEqual(calls[0]?.headers, {});
  });

  test('nothing here derives an address and nothing here settles', async () => {
    const { adapter } = adapterWith({ utime: 1_700_000_200 });

    await assert.rejects(
      adapter.deriveDepositTarget({ invoiceId: 'inv-1', payoutAddress: WALLET, asset: USDT }),
      /wallet pool/,
    );
    assert.equal(await adapter.prepareSettlement([]), null);
  });

  test('the block source refuses to pretend a timestamp is a block', async (t) => {
    /**
     * The scale here is a transaction's unix time, so "the block at 1700000200" is not a
     * thing. Returning null would be read by the watcher as a rolled-back block and start a
     * rewind; throwing says why instead. Never called while the registry says this chain has
     * no reorgs.
     */
    const { fetchMock } = indexer({ utime: 1_700_000_200 });
    t.mock.method(global, 'fetch', fetchMock);
    const api = new TonApi({ apiUrl: 'https://toncenter.example/api/v3' });

    const head = await api.head();
    assert.equal(head.number, 1_700_000_200);
    assert.equal(head.hash, 'root');
    await assert.rejects(api.blockAt(1_700_000_200), /not a block height/);
  });

  // ── recovering a transfer the watcher never saw ─────────────────────────────

  test('a transaction can be credited by its hash alone', async (t) => {
    /**
     * How the two lost payments were recovered, and how any future one is.
     *
     * The destination comes from the transaction rather than from a wallet an operator names,
     * so a replay cannot credit the wrong account by mistyping one — and the wallet still has
     * to be in the address book, so a hash belonging to somebody else does nothing.
     */
    const { adapter, calls, fetchMock } = adapterWith({
      utime: 1_789_241_100,
      assets: [TON],
      transactions: [
        transaction({ value: '733000000', memo: 'AVEX-74DBECA32398', aborted: true }),
      ],
    });
    t.mock.method(global, 'fetch', fetchMock);

    const payments = await adapter.paymentsForHash('LuI/NPOEITFpHeuVLYkDPonBtHGOctyZKUBK1v5J3Vc=', TON);
    assert.equal(payments.length, 1);
    assert.equal(payments[0]!.amount, 733_000_000n);
    assert.equal(payments[0]!.memo, 'AVEX-74DBECA32398');
    assert.equal(payments[0]!.to, WALLET);
    // Asked for by hash, not by account: a replay does not need to know whose wallet it was.
    const asked = calls.find((call) => call.path === 'transactions');
    assert.equal(asked?.params['hash'], 'LuI/NPOEITFpHeuVLYkDPonBtHGOctyZKUBK1v5J3Vc=');
    assert.equal(asked?.params['account'], undefined);
  });

  test('a hash paying a wallet we do not watch credits nothing', async (t) => {
    const { adapter, fetchMock } = adapterWith({
      utime: 1_789_241_100,
      assets: [TON],
      watched: [],
      transactions: [transaction({ value: '733000000', memo: 'AVEX-74DBECA32398' })],
    });
    t.mock.method(global, 'fetch', fetchMock);

    assert.deepEqual(await adapter.paymentsForHash('whatever', TON), []);
  });

  test('replaying reuses the landing rule rather than a second copy of it', async (t) => {
    /**
     * A bounceable transfer that aborted went back to the sender. A recovery tool that decided
     * for itself which transfers landed would be a second place for the mistake that cost the
     * two payments in the first place — so it calls the same function, and this proves it.
     */
    const { adapter, fetchMock } = adapterWith({
      utime: 1_789_241_100,
      assets: [TON],
      transactions: [
        transaction({ value: '733000000', memo: 'AVEX-gone-back', aborted: true, bounce: true }),
      ],
    });
    t.mock.method(global, 'fetch', fetchMock);

    assert.deepEqual(await adapter.paymentsForHash('any-hash', TON), []);
  });
});

import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

import type { Asset } from '../../types.js';
import { base58Encode } from '../base58.js';
import { SolanaAdapter } from './SolanaAdapter.js';
import { SolanaRpc } from './SolanaRpc.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, associatedTokenAccount } from './ata.js';

/**
 * Watching Solana, against a hand-written responder rather than a node.
 *
 * What is under test is not the chain. It is the three-step question this adapter has to ask
 * — which token account belongs to this wallet, which transactions touched it, what moved in
 * them — and every step of it fails silently when it is wrong. Ask about the wallet instead
 * of its token account and no SPL payment is ever seen; read the balance delta off the wrong
 * account index and somebody else's transfer is credited to the merchant. Neither raises
 * anything; both look exactly like a chain nobody is paying on.
 *
 * So the requests are asserted as well as the results.
 */

/** A valid 32-byte address, from a byte repeated: obviously a fixture, and stable. */
const address = (byte: number): string => base58Encode(new Uint8Array(32).fill(byte));

const WALLET = address(0x11);
const OTHER_WALLET = address(0x12);
const STRANGER = address(0x22);
const STRANGER_USDT_ACCOUNT = address(0x44);

/** The real mints, which also proves the address codec accepts what the registry holds. */
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const UNKNOWN_MINT = address(0x55);

/**
 * The accounts a payer's transfer actually reaches, derived exactly as the adapter derives
 * them. Written this way rather than as fixtures of their own so that a derivation that
 * changed would fail `ata.test.ts` against mainnet instead of quietly agreeing with itself
 * here.
 */
const WALLET_USDT_ACCOUNT = associatedTokenAccount(WALLET, USDT_MINT);
const WALLET_USDC_ACCOUNT = associatedTokenAccount(WALLET, USDC_MINT);

const USDT: Asset = {
  symbol: 'USDT',
  chain: 'solana',
  decimals: 6,
  kind: 'spl',
  contract: USDT_MINT,
};
const USDC: Asset = { ...USDT, symbol: 'USDC', contract: USDC_MINT };
const SOL: Asset = { symbol: 'SOL', chain: 'solana', decimals: 9, kind: 'native' };

interface Balance {
  readonly index: number;
  readonly mint: string;
  readonly owner?: string;
  readonly amount: string;
}

const balance = (input: Balance): unknown => ({
  accountIndex: input.index,
  mint: input.mint,
  ...(input.owner === undefined ? {} : { owner: input.owner }),
  uiTokenAmount: { amount: input.amount, decimals: 6, uiAmount: null, uiAmountString: input.amount },
});

/** A transaction, in the shape `getTransaction` returns with `jsonParsed`. */
function transaction(input: {
  readonly slot: number;
  readonly accounts: readonly (string | { readonly pubkey: string; readonly signer: boolean })[];
  readonly loaded?: { readonly writable?: readonly string[]; readonly readonly?: readonly string[] };
  readonly pre?: readonly Balance[];
  readonly post?: readonly Balance[];
  readonly preBalances?: readonly number[];
  readonly postBalances?: readonly number[];
  readonly err?: unknown;
}): unknown {
  return {
    slot: input.slot,
    blockTime: 1_700_000_000,
    transaction: {
      message: {
        accountKeys: input.accounts.map((account) =>
          typeof account === 'string'
            ? { pubkey: account, signer: false, writable: true, source: 'transaction' }
            : { ...account, writable: true, source: 'transaction' },
        ),
      },
      signatures: ['sig'],
    },
    meta: {
      err: input.err ?? null,
      fee: 5000,
      preBalances: input.preBalances ?? input.accounts.map(() => 1_000_000),
      postBalances: input.postBalances ?? input.accounts.map(() => 1_000_000),
      preTokenBalances: (input.pre ?? []).map(balance),
      postTokenBalances: (input.post ?? []).map(balance),
      ...(input.loaded === undefined ? {} : { loadedAddresses: input.loaded }),
    },
  };
}

const signature = (input: { readonly signature: string; readonly slot: number; readonly err?: unknown }) => ({
  signature: input.signature,
  slot: input.slot,
  err: input.err ?? null,
  memo: null,
  confirmationStatus: 'finalized',
});

/**
 * A responder over the batched JSON-RPC, and a record of what it was asked.
 *
 * Faithful about batching on purpose: the request body is an array and the response has to be
 * an array whose ids match, because matching by position instead is the bug that pairs one
 * account's signatures with another account's address.
 */
function responder(input: {
  readonly head: number;
  readonly tokenAccounts?: Readonly<Record<string, readonly string[]>>;
  readonly signatures?: Readonly<Record<string, readonly unknown[]>>;
  readonly transactions?: Readonly<Record<string, unknown>>;
  /** Methods this endpoint answers with HTTP 403, the way publicnode does. */
  readonly refuse?: readonly string[];
  /** The token program that owns every mint, or null for an endpoint that will not say. */
  readonly mintProgram?: string | null;
}) {
  const calls: { method: string; params: unknown[] }[] = [];

  const fetchMock = mock.fn(async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '[]') as {
      id: number;
      method: string;
      params: unknown[];
    }[];

    if (body.some((request) => input.refuse?.includes(request.method))) {
      for (const request of body) calls.push({ method: request.method, params: request.params });
      return { ok: false, status: 403 } as unknown as Response;
    }

    const results = body.map((request) => {
      calls.push({ method: request.method, params: request.params });

      switch (request.method) {
        case 'getSlot':
          return input.head;
        case 'getAccountInfo': {
          const owner = input.mintProgram === undefined ? TOKEN_PROGRAM_ID : input.mintProgram;
          return { context: { slot: input.head }, value: owner === null ? {} : { owner } };
        }
        case 'getLatestBlockhash':
          return { context: { slot: input.head }, value: { blockhash: 'hash' } };
        case 'getTokenAccountsByOwner': {
          const owner = request.params[0] as string;
          const { mint } = request.params[1] as { mint: string };
          const accounts = input.tokenAccounts?.[`${owner}|${mint}`] ?? [];
          return { context: { slot: input.head }, value: accounts.map((pubkey) => ({ pubkey })) };
        }
        case 'getSignaturesForAddress': {
          const account = request.params[0] as string;
          return input.signatures?.[account] ?? [];
        }
        case 'getTransaction':
          return input.transactions?.[request.params[0] as string] ?? null;
        default:
          return null;
      }
    });

    return {
      ok: true,
      json: async () => results.map((result, index) => ({ jsonrpc: '2.0', id: body[index]!.id, result })),
    } as unknown as Response;
  });

  return { calls, fetchMock };
}

function adapterWith(options: {
  readonly head: number;
  readonly tokenAccounts?: Readonly<Record<string, readonly string[]>>;
  readonly signatures?: Readonly<Record<string, readonly unknown[]>>;
  readonly transactions?: Readonly<Record<string, unknown>>;
  readonly watched?: readonly string[];
  readonly assets?: readonly Asset[];
  readonly confirmationLag?: number;
  readonly maxTransactionsPerPoll?: number;
  readonly signaturePageSize?: number;
  readonly maxSignaturePages?: number;
  readonly refuse?: readonly string[];
  readonly mintProgram?: string | null;
}) {
  const { calls, fetchMock } = responder({
    head: options.head,
    ...(options.tokenAccounts === undefined ? {} : { tokenAccounts: options.tokenAccounts }),
    ...(options.signatures === undefined ? {} : { signatures: options.signatures }),
    ...(options.transactions === undefined ? {} : { transactions: options.transactions }),
    ...(options.refuse === undefined ? {} : { refuse: options.refuse }),
    ...(options.mintProgram === undefined ? {} : { mintProgram: options.mintProgram }),
  });
  const known = new Set(options.watched ?? [WALLET]);
  const warnings: string[] = [];

  const adapter = new SolanaAdapter(
    {
      acceptedAssets: options.assets ?? [USDT],
      ...(options.confirmationLag === undefined ? {} : { confirmationLag: options.confirmationLag }),
      ...(options.maxTransactionsPerPoll === undefined
        ? {}
        : { maxTransactionsPerPoll: options.maxTransactionsPerPoll }),
      ...(options.signaturePageSize === undefined ? {} : { signaturePageSize: options.signaturePageSize }),
      ...(options.maxSignaturePages === undefined ? {} : { maxSignaturePages: options.maxSignaturePages }),
      warn: (message) => warnings.push(message),
    },
    new SolanaRpc({ url: 'https://solana.example' }),
    {
      lookup: async (candidate) => (known.has(candidate) ? 'invoice-1' : null),
      watched: async () => [...known],
    },
    { nativePriceUsd: async () => 150 },
  );

  return { adapter, calls, fetchMock, warnings };
}

describe('watching Solana', () => {
  test('an SPL transfer to the wallet is found through the wallet’s token account', async (t) => {
    /**
     * The whole shape of the thing, in one case. The payer sent USDT to the token account the
     * merchant's wallet owns — never to the wallet address — so the adapter has to find that
     * account first and ask about it, then read the amount off the balance delta.
     */
    const { adapter, calls, fetchMock } = adapterWith({
      head: 200,
      confirmationLag: 31,
      tokenAccounts: { [`${WALLET}|${USDT_MINT}`]: [WALLET_USDT_ACCOUNT] },
      signatures: { [WALLET_USDT_ACCOUNT]: [signature({ signature: 'sig-a', slot: 120 })] },
      transactions: {
        'sig-a': transaction({
          slot: 120,
          accounts: [{ pubkey: STRANGER, signer: true }, STRANGER_USDT_ACCOUNT, WALLET_USDT_ACCOUNT],
          pre: [
            { index: 1, mint: USDT_MINT, owner: STRANGER, amount: '5000000' },
            { index: 2, mint: USDT_MINT, owner: WALLET, amount: '0' },
          ],
          post: [
            { index: 1, mint: USDT_MINT, owner: STRANGER, amount: '3988000' },
            { index: 2, mint: USDT_MINT, owner: WALLET, amount: '1012000' },
          ],
        }),
      },
    });
    t.mock.method(global, 'fetch', fetchMock);

    const result = await adapter.poll('119');

    assert.equal(result.payments.length, 1);
    const [payment] = result.payments;
    assert.equal(payment!.to, WALLET, 'credited to the wallet, not to its token account');
    assert.equal(payment!.from, STRANGER, 'and the sender is the owner of the account it left');
    assert.equal(payment!.amount, 1_012_000n);
    assert.equal(payment!.asset.symbol, 'USDT');
    assert.equal(payment!.txHash, 'sig-a');
    assert.equal(payment!.blockNumber, 120);
    // 200 - 120 + 1: past the 32 the chain asks for, so the sink credits on first sight.
    assert.equal(payment!.confirmations, 81);
    assert.equal(result.cursor, '169', 'the cursor stops at the head less the lag');

    // The token account was asked about; the wallet address was not, since SOL is not accepted.
    const asked = calls
      .filter((call) => call.method === 'getSignaturesForAddress')
      .map((call) => call.params[0]);
    assert.deepEqual(asked, [WALLET_USDT_ACCOUNT]);
    // The address was derived. The chain was asked which program owns the mint, because that
    // is part of the derivation, and asked for any *other* account holding it as breadth.
    assert.ok(calls.some((call) => call.method === 'getAccountInfo'));
  });

  test('a token account, once found, is not looked up again', async (t) => {
    // One call per wallet per mint per poll is the cost this cache removes.
    const options = {
      head: 200,
      confirmationLag: 31,
      tokenAccounts: { [`${WALLET}|${USDT_MINT}`]: [WALLET_USDT_ACCOUNT] },
      signatures: { [WALLET_USDT_ACCOUNT]: [] },
    } as const;
    const { adapter, calls, fetchMock } = adapterWith(options);
    t.mock.method(global, 'fetch', fetchMock);

    await adapter.poll('100');
    await adapter.poll('120');

    const discoveries = calls.filter((call) => call.method === 'getTokenAccountsByOwner');
    assert.equal(discoveries.length, 1, 'asked once per wallet and mint, not once per poll');
    const programs = calls.filter((call) => call.method === 'getAccountInfo');
    assert.equal(programs.length, 1, 'and a mint’s program is learnt once');
  });

  test('a wallet that has never held the token is watched anyway, and its first payment is seen', async (t) => {
    /**
     * The case that decided the design. A wallet with no USDT account has nothing for
     * `getTokenAccountsByOwner` to return, and the account is created by the very transaction
     * that pays it — so an adapter that waited to be told the address would watch nothing
     * until after the payment it was supposed to see, and the cursor would be past it.
     * Deriving the address means it is already being asked about.
     */
    const { adapter, calls, fetchMock } = adapterWith({
      head: 200,
      confirmationLag: 31,
      tokenAccounts: {},
      signatures: { [WALLET_USDT_ACCOUNT]: [signature({ signature: 'sig-first', slot: 120 })] },
      transactions: {
        'sig-first': transaction({
          slot: 120,
          accounts: [{ pubkey: STRANGER, signer: true }, WALLET_USDT_ACCOUNT],
          // No `pre` entry at all: the account did not exist before this transaction.
          post: [{ index: 1, mint: USDT_MINT, owner: WALLET, amount: '500000' }],
        }),
      },
    });
    t.mock.method(global, 'fetch', fetchMock);

    const result = await adapter.poll('119');
    assert.equal(result.payments.length, 1, 'the payment that created the account is found');
    assert.equal(result.payments[0]!.amount, 500_000n);
    const asked = calls
      .filter((call) => call.method === 'getSignaturesForAddress')
      .map((call) => call.params[0]);
    assert.deepEqual(asked, [WALLET_USDT_ACCOUNT], 'the derived address, before it existed');
  });

  test('an endpoint that will not list token accounts is said once and worked around', async (t) => {
    /**
     * publicnode's free Solana endpoint answers `getTokenAccountsByOwner` with HTTP 403. That
     * used to take the whole poll down. It adds breadth — an account the wallet holds the
     * mint in that is not the associated one — and a payer never pays those, so its absence
     * is a warning and the poll goes on.
     */
    const { adapter, fetchMock, warnings } = adapterWith({
      head: 200,
      confirmationLag: 31,
      refuse: ['getTokenAccountsByOwner'],
      signatures: { [WALLET_USDT_ACCOUNT]: [signature({ signature: 'sig-a', slot: 120 })] },
      transactions: {
        'sig-a': transaction({
          slot: 120,
          accounts: [{ pubkey: STRANGER, signer: true }, WALLET_USDT_ACCOUNT],
          pre: [{ index: 1, mint: USDT_MINT, owner: WALLET, amount: '0' }],
          post: [{ index: 1, mint: USDT_MINT, owner: WALLET, amount: '750000' }],
        }),
      },
    });
    t.mock.method(global, 'fetch', fetchMock);

    const first = await adapter.poll('119');
    assert.equal(first.payments.length, 1, 'the payment is still found');
    await adapter.poll('169');
    assert.equal(warnings.length, 1, 'and the refusal is said once, not once a poll');
    assert.match(warnings[0]!, /associated token accounts only/);
  });

  test('when the mint’s program cannot be read, both programs’ addresses are watched', async (t) => {
    /**
     * The token program is part of the derivation, so guessing it wrong means watching an
     * address that can never receive anything. Covering both costs one signature query and
     * no correctness.
     */
    const { adapter, calls, fetchMock } = adapterWith({
      head: 200,
      confirmationLag: 31,
      mintProgram: null,
      signatures: {},
    });
    t.mock.method(global, 'fetch', fetchMock);

    await adapter.poll('119');
    const asked = new Set(
      calls.filter((call) => call.method === 'getSignaturesForAddress').map((call) => call.params[0]),
    );
    assert.deepEqual(
      asked,
      new Set([
        associatedTokenAccount(WALLET, USDT_MINT, TOKEN_PROGRAM_ID),
        associatedTokenAccount(WALLET, USDT_MINT, TOKEN_2022_PROGRAM_ID),
      ]),
    );
  });

  test('a transfer of a mint we do not accept is ignored', async (t) => {
    // Creating a mint that calls itself USDC costs almost nothing.
    const { adapter, fetchMock } = adapterWith({
      head: 200,
      confirmationLag: 31,
      tokenAccounts: { [`${WALLET}|${USDT_MINT}`]: [WALLET_USDT_ACCOUNT] },
      signatures: { [WALLET_USDT_ACCOUNT]: [signature({ signature: 'sig-a', slot: 120 })] },
      transactions: {
        'sig-a': transaction({
          slot: 120,
          accounts: [{ pubkey: STRANGER, signer: true }, WALLET_USDT_ACCOUNT],
          pre: [{ index: 1, mint: UNKNOWN_MINT, owner: WALLET, amount: '0' }],
          post: [{ index: 1, mint: UNKNOWN_MINT, owner: WALLET, amount: '9999000000' }],
        }),
      },
    });
    t.mock.method(global, 'fetch', fetchMock);

    const result = await adapter.poll('119');
    assert.deepEqual(result.payments, []);
  });

  test('a transfer to somebody else’s wallet in the same transaction is not ours', async (t) => {
    /**
     * One transaction can credit two token accounts. Only the one our wallet owns is a payment
     * to us, and the owner is what says so — not the position in the balance list.
     */
    const { adapter, fetchMock } = adapterWith({
      head: 200,
      confirmationLag: 31,
      tokenAccounts: { [`${WALLET}|${USDT_MINT}`]: [WALLET_USDT_ACCOUNT] },
      signatures: { [WALLET_USDT_ACCOUNT]: [signature({ signature: 'sig-a', slot: 120 })] },
      transactions: {
        'sig-a': transaction({
          slot: 120,
          accounts: [
            { pubkey: STRANGER, signer: true },
            STRANGER_USDT_ACCOUNT,
            WALLET_USDT_ACCOUNT,
            WALLET_USDC_ACCOUNT,
          ],
          pre: [
            { index: 2, mint: USDT_MINT, owner: WALLET, amount: '0' },
            { index: 3, mint: USDT_MINT, owner: OTHER_WALLET, amount: '0' },
          ],
          post: [
            { index: 2, mint: USDT_MINT, owner: WALLET, amount: '1000000' },
            { index: 3, mint: USDT_MINT, owner: OTHER_WALLET, amount: '7000000' },
          ],
        }),
      },
    });
    t.mock.method(global, 'fetch', fetchMock);

    const result = await adapter.poll('119');
    assert.equal(result.payments.length, 1);
    assert.equal(result.payments[0]!.to, WALLET);
    assert.equal(result.payments[0]!.amount, 1_000_000n);
  });

  test('a transaction the wallet signed itself is not a payment to it', async (t) => {
    /**
     * A merchant swapping SOL for USDT in their own wallet raises their own token balance.
     * Credited, it would invent revenue — and on a pooled chain the sole open invoice takes
     * whatever arrives, so it would land on somebody's order.
     */
    const { adapter, fetchMock } = adapterWith({
      head: 200,
      confirmationLag: 31,
      tokenAccounts: { [`${WALLET}|${USDT_MINT}`]: [WALLET_USDT_ACCOUNT] },
      signatures: { [WALLET_USDT_ACCOUNT]: [signature({ signature: 'sig-a', slot: 120 })] },
      transactions: {
        'sig-a': transaction({
          slot: 120,
          accounts: [{ pubkey: WALLET, signer: true }, WALLET_USDT_ACCOUNT],
          pre: [{ index: 1, mint: USDT_MINT, owner: WALLET, amount: '0' }],
          post: [{ index: 1, mint: USDT_MINT, owner: WALLET, amount: '4000000' }],
        }),
      },
    });
    t.mock.method(global, 'fetch', fetchMock);

    const result = await adapter.poll('119');
    assert.deepEqual(result.payments, []);
  });

  test('a failed transaction is never even fetched', async (t) => {
    // It moved nothing, whatever its instructions said, and a `getTransaction` to confirm
    // that is a request per failure on a busy account.
    const { adapter, calls, fetchMock } = adapterWith({
      head: 200,
      confirmationLag: 31,
      tokenAccounts: { [`${WALLET}|${USDT_MINT}`]: [WALLET_USDT_ACCOUNT] },
      signatures: {
        [WALLET_USDT_ACCOUNT]: [
          signature({ signature: 'sig-a', slot: 120, err: { InstructionError: [0, 'Custom'] } }),
        ],
      },
    });
    t.mock.method(global, 'fetch', fetchMock);

    const result = await adapter.poll('119');
    assert.deepEqual(result.payments, []);
    assert.equal(calls.some((call) => call.method === 'getTransaction'), false);
  });

  test('native SOL arriving at the wallet is credited, and the wallet is what is asked about', async (t) => {
    // Lamports move to the wallet itself, so for SOL the wallet is its own account to watch.
    const { adapter, calls, fetchMock } = adapterWith({
      head: 200,
      confirmationLag: 31,
      assets: [SOL],
      signatures: { [WALLET]: [signature({ signature: 'sig-sol', slot: 130 })] },
      transactions: {
        'sig-sol': transaction({
          slot: 130,
          accounts: [{ pubkey: STRANGER, signer: true }, WALLET],
          preBalances: [5_000_000_000, 1_000_000_000],
          postBalances: [4_499_995_000, 1_500_000_000],
        }),
      },
    });
    t.mock.method(global, 'fetch', fetchMock);

    const result = await adapter.poll('119');

    assert.equal(result.payments.length, 1);
    assert.equal(result.payments[0]!.to, WALLET);
    assert.equal(result.payments[0]!.amount, 500_000_000n);
    assert.equal(result.payments[0]!.asset.symbol, 'SOL');
    assert.equal(result.payments[0]!.from, STRANGER);
    const asked = calls
      .filter((call) => call.method === 'getSignaturesForAddress')
      .map((call) => call.params[0]);
    assert.deepEqual(asked, [WALLET]);
    // No mint accepted, so nothing was looked up by mint either.
    assert.equal(calls.some((call) => call.method === 'getTokenAccountsByOwner'), false);
  });

  test('lamports leaving the wallet are not a payment to it', async (t) => {
    const { adapter, fetchMock } = adapterWith({
      head: 200,
      confirmationLag: 31,
      assets: [SOL],
      signatures: { [WALLET]: [signature({ signature: 'sig-out', slot: 130 })] },
      transactions: {
        'sig-out': transaction({
          slot: 130,
          accounts: [{ pubkey: WALLET, signer: true }, STRANGER],
          preBalances: [1_000_000_000, 0],
          postBalances: [499_995_000, 500_000_000],
        }),
      },
    });
    t.mock.method(global, 'fetch', fetchMock);

    assert.deepEqual((await adapter.poll('119')).payments, []);
  });

  test('addresses a lookup table supplied are counted after the static keys', async (t) => {
    /**
     * The balance arrays are indexed over the static keys *then* the loaded ones. Getting that
     * order wrong shifts every index by however many static keys there are, which reads
     * somebody else's balance change as the merchant's — and raises nothing.
     */
    const { adapter, fetchMock } = adapterWith({
      head: 200,
      confirmationLag: 31,
      tokenAccounts: { [`${WALLET}|${USDT_MINT}`]: [WALLET_USDT_ACCOUNT] },
      signatures: { [WALLET_USDT_ACCOUNT]: [signature({ signature: 'sig-v0', slot: 140 })] },
      transactions: {
        'sig-v0': transaction({
          slot: 140,
          accounts: [{ pubkey: STRANGER, signer: true }],
          loaded: { writable: [STRANGER_USDT_ACCOUNT, WALLET_USDT_ACCOUNT] },
          // Index 2 is the second loaded address: our token account.
          pre: [{ index: 2, mint: USDT_MINT, amount: '0' }],
          post: [{ index: 2, mint: USDT_MINT, amount: '2500000' }],
          preBalances: [1, 1, 1],
          postBalances: [1, 1, 1],
        }),
      },
    });
    t.mock.method(global, 'fetch', fetchMock);

    const result = await adapter.poll('139');
    assert.equal(result.payments.length, 1, 'the owner came from the account, not from the entry');
    assert.equal(result.payments[0]!.to, WALLET);
    assert.equal(result.payments[0]!.amount, 2_500_000n);
  });

  test('a transfer outside the slot range is left for the poll that covers it', async (t) => {
    const { adapter, fetchMock } = adapterWith({
      head: 200,
      confirmationLag: 31,
      tokenAccounts: { [`${WALLET}|${USDT_MINT}`]: [WALLET_USDT_ACCOUNT] },
      signatures: {
        [WALLET_USDT_ACCOUNT]: [
          // Above the head less the lag: not final enough to present yet.
          signature({ signature: 'too-new', slot: 195 }),
          // Below the cursor: credited on an earlier poll.
          signature({ signature: 'too-old', slot: 100 }),
        ],
      },
      transactions: {},
    });
    t.mock.method(global, 'fetch', fetchMock);

    const result = await adapter.poll('119');
    assert.deepEqual(result.payments, []);
    assert.equal(result.cursor, '169');
  });

  test('with nothing watched the node is asked only for the head', async (t) => {
    // The ordinary case for a merchant with no Solana wallet: one request per poll.
    const { adapter, calls, fetchMock } = adapterWith({ head: 200, confirmationLag: 31, watched: [] });
    t.mock.method(global, 'fetch', fetchMock);

    const result = await adapter.poll('100');
    assert.deepEqual(result.payments, []);
    assert.equal(result.cursor, '169');
    assert.deepEqual(calls.map((call) => call.method), ['getSlot']);
  });

  test('a cursor already past the head advances nothing', async (t) => {
    const { adapter, fetchMock } = adapterWith({ head: 200, confirmationLag: 31 });
    t.mock.method(global, 'fetch', fetchMock);

    const result = await adapter.poll('180');
    assert.deepEqual(result.payments, []);
    assert.equal(result.cursor, '180');
  });

  test('a poll with more transactions than its bound stops at a slot boundary', async (t) => {
    /**
     * Two transactions in slot 121 and one in 120, with a bound of two. Cutting after the
     * second would move the cursor past a transaction in the same slot, so the cut is the slot
     * boundary and the cursor is the slot — the next poll starts after it.
     */
    const { adapter, fetchMock, warnings } = adapterWith({
      head: 200,
      confirmationLag: 31,
      maxTransactionsPerPoll: 2,
      tokenAccounts: { [`${WALLET}|${USDT_MINT}`]: [WALLET_USDT_ACCOUNT] },
      signatures: {
        [WALLET_USDT_ACCOUNT]: [
          signature({ signature: 'sig-c', slot: 122 }),
          signature({ signature: 'sig-b2', slot: 121 }),
          signature({ signature: 'sig-b1', slot: 121 }),
          signature({ signature: 'sig-a', slot: 120 }),
        ],
      },
      transactions: {
        'sig-a': transaction({
          slot: 120,
          accounts: [{ pubkey: STRANGER, signer: true }, WALLET_USDT_ACCOUNT],
          pre: [{ index: 1, mint: USDT_MINT, owner: WALLET, amount: '0' }],
          post: [{ index: 1, mint: USDT_MINT, owner: WALLET, amount: '1000000' }],
        }),
        'sig-b1': transaction({
          slot: 121,
          accounts: [{ pubkey: STRANGER, signer: true }, WALLET_USDT_ACCOUNT],
          pre: [{ index: 1, mint: USDT_MINT, owner: WALLET, amount: '1000000' }],
          post: [{ index: 1, mint: USDT_MINT, owner: WALLET, amount: '2000000' }],
        }),
        'sig-b2': transaction({
          slot: 121,
          accounts: [{ pubkey: STRANGER, signer: true }, WALLET_USDT_ACCOUNT],
          pre: [{ index: 1, mint: USDT_MINT, owner: WALLET, amount: '2000000' }],
          post: [{ index: 1, mint: USDT_MINT, owner: WALLET, amount: '3000000' }],
        }),
      },
    });
    t.mock.method(global, 'fetch', fetchMock);

    const result = await adapter.poll('119');
    assert.equal(result.cursor, '121', 'the whole of slot 121, and no further');
    assert.equal(result.payments.length, 3, 'both transactions in the boundary slot were read');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /continuing next poll/);
  });

  test('a gap wider than the pages allowed is reported, not passed over silently', async (t) => {
    /**
     * The one case where slots go unread: a wallet with more history in the gap than the page
     * cap allows. It is said out loud because those slots will not be visited again.
     */
    const page = [signature({ signature: 'a', slot: 168 }), signature({ signature: 'b', slot: 167 })];
    const { adapter, fetchMock, warnings } = adapterWith({
      head: 200,
      confirmationLag: 31,
      signaturePageSize: 2,
      maxSignaturePages: 1,
      assets: [SOL],
      signatures: { [WALLET]: page },
      transactions: {},
    });
    t.mock.method(global, 'fetch', fetchMock);

    await adapter.poll('100');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /were not read/);
  });

  test('nothing here derives an address and nothing here settles', async () => {
    const { adapter } = adapterWith({ head: 200 });

    await assert.rejects(
      adapter.deriveDepositTarget({
        invoiceId: 'inv-1',
        payoutAddress: WALLET,
        asset: USDT,
      }),
      /wallet pool/,
    );
    assert.equal(await adapter.prepareSettlement([]), null);
  });

  test('the gas snapshot carries a real SOL price and no fee to estimate', async () => {
    const { adapter } = adapterWith({ head: 200 });
    const snapshot = await adapter.probeGas();
    assert.equal(snapshot.chain, 'solana');
    assert.equal(snapshot.nativePriceUsd, 150);
  });

  test('two mints on one wallet are both watched', async (t) => {
    const { adapter, calls, fetchMock } = adapterWith({
      head: 200,
      confirmationLag: 31,
      assets: [USDT, USDC],
      tokenAccounts: {
        [`${WALLET}|${USDT_MINT}`]: [WALLET_USDT_ACCOUNT],
        [`${WALLET}|${USDC_MINT}`]: [WALLET_USDC_ACCOUNT],
      },
      signatures: { [WALLET_USDT_ACCOUNT]: [], [WALLET_USDC_ACCOUNT]: [] },
    });
    t.mock.method(global, 'fetch', fetchMock);

    await adapter.poll('119');
    const asked = new Set(
      calls.filter((call) => call.method === 'getSignaturesForAddress').map((call) => call.params[0]),
    );
    assert.deepEqual(asked, new Set([WALLET_USDT_ACCOUNT, WALLET_USDC_ACCOUNT]));
  });
});

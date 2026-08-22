import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import { normalizeTronAddress, tronAddressFromEvmHex, tronAddressToHex } from '@avex/core';
import { and, eq } from 'drizzle-orm';

import { createDatabase } from '../db/client.js';
import { assets, invoices, organizations } from '../db/schema.js';
import { DatabaseAddressBook } from './address-book.js';

/**
 * Whether a transfer belongs to one of our invoices, on both kinds of chain.
 *
 * The address book folded every address to lowercase, which is right on EVM — hex is
 * case-insensitive, we store EIP-55 mixed case, an RPC log returns lowercase, and comparing
 * them literally would mean no payment on any EVM chain is ever recognised.
 *
 * It is wrong on TRON, and the wrongness is the expensive kind. A `T…` address is Base58Check
 * over an alphabet holding both `A` and `a`; folding it produces a string that is not an
 * address, and two distinct valid addresses can fold onto the same one. In this lookup that
 * is somebody else's payment credited to this invoice.
 *
 * Both directions are asserted here because a fix that only stopped folding would break the
 * EVM case that needed it.
 */
const databaseUrl = process.env.DATABASE_URL;

/**
 * Tether's own TRC-20 contract, as the asset's contract address and the payout address.
 *
 * A real address, whose Base58Check form is checked against an independent implementation in
 * `packages/core/src/chains/tron/address.test.ts` rather than being invented here.
 */
const TRON_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

/**
 * Deposit addresses are generated per run, because `invoices_chain_deposit_key` is unique on
 * (chain, deposit_address) — a fixed pair would pass once and then collide with its own row
 * from the previous run forever.
 *
 * The TRON ones come from this repository's own codec, which is acceptable here and would not
 * be in the codec's own tests: what is under test in this file is the *lookup*, and the codec
 * is verified separately against vectors from outside it.
 */
function evmDeposit(): string {
  return `0xAbC${randomBytes(18).toString('hex').slice(0, 35).padEnd(35, '0')}`;
}

function tronDeposit(): string {
  return tronAddressFromEvmHex(`0x${randomBytes(20).toString('hex')}`);
}

describe('the address book, across address encodings', { skip: !databaseUrl }, () => {
  let database: ReturnType<typeof createDatabase> | undefined;
  const db = () => database!.db;
  let orgId = '';
  const assetFor = new Map<string, string>();

  before(async () => {
    database = createDatabase(databaseUrl!, { max: 2 });
    const unique = randomBytes(4).toString('hex');

    const [org] = await db()
      .insert(organizations)
      .values({ name: `Book ${unique}`, slug: `book-${unique}` })
      .returning({ id: organizations.id });
    orgId = org!.id;

    /**
     * One asset per chain, found or created.
     *
     * Matched on `curated` as well as symbol and chain: a development database that has run
     * the admin suites holds many uncurated rows claiming to be USDT, and picking one of
     * those would tie this test to a stranger's fixture.
     */
    for (const [chain, contract] of [
      ['bsc', '0x55d398326f99059ff775485246999027b3197955'],
      ['tron', TRON_CONTRACT],
    ] as const) {
      const [existing] = await db()
        .select({ id: assets.id })
        .from(assets)
        .where(
          and(eq(assets.chain, chain), eq(assets.symbol, 'USDT'), eq(assets.curated, true)),
        )
        .limit(1);
      if (existing) {
        assetFor.set(chain, existing.id);
        continue;
      }
      const [created] = await db()
        .insert(assets)
        .values({
          chain,
          symbol: 'USDT',
          contract,
          decimals: 6,
          kind: chain === 'tron' ? 'trc20' : 'erc20',
          curated: true,
          verdict: 'approved',
        })
        .returning({ id: assets.id });
      assetFor.set(chain, created!.id);
    }
  });

  after(async () => {
    await database?.close();
  });

  async function openInvoice(chain: 'bsc' | 'tron', depositAddress: string): Promise<string> {
    const [row] = await db()
      .insert(invoices)
      .values({
        organizationId: orgId,
        assetId: assetFor.get(chain)!,
        reference: `book-${randomBytes(5).toString('hex')}`,
        chain,
        amountDue: '1000000',
        amountPaid: '0',
        depositAddress,
        payoutAddress: chain === 'tron' ? TRON_CONTRACT : '0xAbC0000000000000000000000000000000000001',
        status: 'pending',
        mode: 'live',
        toleranceBps: 0,
        feeBps: 0,
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning({ id: invoices.id });
    return row!.id;
  }

  test('an EVM address is found whatever case the chain reports it in', async () => {
    const deposit = evmDeposit();
    const id = await openInvoice('bsc', deposit);
    const book = new DatabaseAddressBook(db(), 'bsc');

    assert.equal(await book.lookup(deposit), id);
    assert.equal(await book.lookup(deposit.toLowerCase()), id);
    assert.equal(await book.lookup(deposit.toUpperCase().replace('0X', '0x')), id);
  });

  test('a TRON address is found by either of its two on-chain forms', async () => {
    /**
     * The reconciliation the fold used to provide, done without corrupting the address:
     * TronGrid returns the 21-byte hex on some endpoints and the Base58Check string on
     * others, and both have to reach the same invoice.
     */
    const deposit = tronDeposit();
    const id = await openInvoice('tron', deposit);
    const book = new DatabaseAddressBook(db(), 'tron');

    assert.equal(await book.lookup(deposit), id);
    assert.equal(await book.lookup(tronAddressToHex(deposit)), id);
    assert.equal(await book.lookup(normalizeTronAddress(deposit)), id);
  });

  test('a case-folded TRON address matches nothing', async () => {
    /**
     * The assertion that would have failed before this change, and the one that matters: a
     * lowercased base58 string is not this address and must not resolve to this invoice.
     * Under the old unconditional `lower()` on both sides it resolved perfectly.
     */
    const deposit = tronDeposit();
    await openInvoice('tron', deposit);
    const book = new DatabaseAddressBook(db(), 'tron');

    assert.equal(await book.lookup(deposit.toLowerCase()), null);
    assert.equal(await book.lookup(deposit.toUpperCase()), null);
  });

  test('an address nobody owns is a miss, not an error', async () => {
    const book = new DatabaseAddressBook(db(), 'tron');
    // Unparseable, and a valid-but-unknown address. Neither may throw: the watcher calls this
    // with whatever the chain reported, and "not ours" is an answer rather than a failure.
    assert.equal(await book.lookup('nonsense'), null);
    assert.equal(await book.lookup(`41${'00'.repeat(20)}`), null);
  });
});

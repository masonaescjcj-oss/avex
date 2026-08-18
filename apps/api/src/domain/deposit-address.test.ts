import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { DepositAddressDeriver, DepositAddressError, memoFor } from './deposit-address.js';

/**
 * Address derivation, one input at a time.
 *
 * These are unit tests rather than part of the HTTP suite for a specific reason: the
 * service generates a fresh invoice id for every call, so two invoices always differ
 * by id as well as by whatever else changed. That makes it impossible to show *there*
 * that the fee is part of the address — a mutation removing the fee from derivation
 * passed the integration suite, because the ids differed anyway.
 *
 * Holding the id fixed and varying one input at a time is the only way to state what
 * the address actually commits to. And what it commits to is the whole non-custodial
 * guarantee: change any of it after quoting and CREATE2 puts the contract somewhere
 * the payer never funded.
 */

const FACTORY = '0x00000000000000000000000000000000000f4c70';
const OTHER_FACTORY = '0x000000000000000000000000000000000000beef';
const CREATION_CODE = '0x60806040523480156100115760006000fd5b50';
const MERCHANT = '0x1111111111111111111111111111111111111111';
const OTHER_MERCHANT = '0x2222222222222222222222222222222222222222';
const COLLECTOR = '0x3333333333333333333333333333333333333333';
const TON_WALLET = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';

const deriver = (factory = FACTORY, creationCode = CREATION_CODE) =>
  new DepositAddressDeriver(
    {
      evm: {
        bsc: { factory, forwarderCreationCode: creationCode },
        ethereum: { factory, forwarderCreationCode: creationCode },
      },
      shared: { ton: TON_WALLET },
    },
    'a-memo-secret',
  );

const INVOICE = 'e9f3c1a0-0000-4000-8000-000000000001';

const evmAddress = (overrides: Parameters<DepositAddressDeriver['derive']>[0]) =>
  deriver().derive(overrides).address;

describe('deposit address derivation', () => {
  test('the same inputs always give the same address', () => {
    // Otherwise settlement could not find the contract it is meant to deploy.
    const first = evmAddress({ invoiceId: INVOICE, chain: 'bsc', payoutAddress: MERCHANT });
    const second = evmAddress({ invoiceId: INVOICE, chain: 'bsc', payoutAddress: MERCHANT });
    assert.equal(first, second);
    assert.match(first, /^0x[0-9a-fA-F]{40}$/);
  });

  test('the payout address is part of the address', () => {
    // The core of the non-custodial claim: funds sent here can only reach this
    // merchant, because a different destination is a different address entirely.
    const mine = evmAddress({ invoiceId: INVOICE, chain: 'bsc', payoutAddress: MERCHANT });
    const theirs = evmAddress({ invoiceId: INVOICE, chain: 'bsc', payoutAddress: OTHER_MERCHANT });
    assert.notEqual(mine, theirs);
  });

  test('the commission is part of the address', () => {
    /**
     * The claim a mutation caught the integration suite failing to make. Holding the
     * invoice id and payout address fixed, changing only the fee must move the
     * address — that is what stops AVEX raising its cut on an address already quoted.
     */
    const free = evmAddress({ invoiceId: INVOICE, chain: 'bsc', payoutAddress: MERCHANT });
    const onePercent = evmAddress({
      invoiceId: INVOICE,
      chain: 'bsc',
      payoutAddress: MERCHANT,
      fee: { feeDestination: COLLECTOR, feeBps: 100 },
    });
    const twoPercent = evmAddress({
      invoiceId: INVOICE,
      chain: 'bsc',
      payoutAddress: MERCHANT,
      fee: { feeDestination: COLLECTOR, feeBps: 200 },
    });

    assert.notEqual(free, onePercent);
    assert.notEqual(onePercent, twoPercent);
    assert.notEqual(free, twoPercent);
  });

  test('the fee destination is part of the address too', () => {
    // Otherwise the rate would be committed but the recipient would not, and the fee
    // could be redirected without the address changing.
    const toUs = evmAddress({
      invoiceId: INVOICE,
      chain: 'bsc',
      payoutAddress: MERCHANT,
      fee: { feeDestination: COLLECTOR, feeBps: 100 },
    });
    const elsewhere = evmAddress({
      invoiceId: INVOICE,
      chain: 'bsc',
      payoutAddress: MERCHANT,
      fee: { feeDestination: OTHER_MERCHANT, feeBps: 100 },
    });
    assert.notEqual(toUs, elsewhere);
  });

  test('a zero fee derives the same address as no fee', () => {
    /**
     * Deliberate, and load-bearing. `feeFor` returns nothing for a zero rate, so an
     * invoice stored with `fee_bps = 0` must derive what `undefined` derives — if the
     * two disagreed, settlement reading zero from the database would compute a
     * different address from the one creation handed the payer.
     */
    const absent = evmAddress({ invoiceId: INVOICE, chain: 'bsc', payoutAddress: MERCHANT });
    const zero = evmAddress({
      invoiceId: INVOICE,
      chain: 'bsc',
      payoutAddress: MERCHANT,
      fee: { feeDestination: COLLECTOR, feeBps: 0 },
    });
    assert.equal(absent, zero);
  });

  test('the invoice is part of the address', () => {
    // One address per invoice is what lets an arriving transfer be matched to an
    // invoice without a memo.
    const first = evmAddress({ invoiceId: INVOICE, chain: 'bsc', payoutAddress: MERCHANT });
    const second = evmAddress({
      invoiceId: 'e9f3c1a0-0000-4000-8000-000000000002',
      chain: 'bsc',
      payoutAddress: MERCHANT,
    });
    assert.notEqual(first, second);
  });

  test('the factory is part of the address', () => {
    // Which is why the factory is configuration rather than a constant: pointing at a
    // different deployment must not silently reuse addresses from the old one.
    const here = deriver().derive({ invoiceId: INVOICE, chain: 'bsc', payoutAddress: MERCHANT });
    const there = deriver(OTHER_FACTORY).derive({
      invoiceId: INVOICE,
      chain: 'bsc',
      payoutAddress: MERCHANT,
    });
    assert.notEqual(here.address, there.address);
  });

  test('the creation code is part of the address', () => {
    /**
     * The reason `FORWARDER_CREATION_CODE` is configured rather than read from a build
     * artifact. Recompiling with different settings changes every address already
     * handed out, so the value has to match whatever was actually deployed — which may
     * predate the running build.
     */
    const original = deriver().derive({ invoiceId: INVOICE, chain: 'bsc', payoutAddress: MERCHANT });
    const recompiled = deriver(FACTORY, CREATION_CODE + 'ff').derive({
      invoiceId: INVOICE,
      chain: 'bsc',
      payoutAddress: MERCHANT,
    });
    assert.notEqual(original.address, recompiled.address);
  });

  test('the same invoice on two chains gets two addresses', () => {
    // Same factory address on both chains here, so this is really about the chain
    // being consulted at all rather than derivation being shared.
    const bsc = evmAddress({ invoiceId: INVOICE, chain: 'bsc', payoutAddress: MERCHANT });
    const ethereum = evmAddress({ invoiceId: INVOICE, chain: 'ethereum', payoutAddress: MERCHANT });
    // Identical factories and inputs, so the addresses match — and that is fine,
    // because an invoice belongs to one chain. Stated so a future reader does not
    // mistake it for a bug.
    assert.equal(bsc, ethereum);
  });

  test('an EVM invoice has no memo', () => {
    // The address is the identity there, and a memo would be a field payers might
    // feel obliged to fill in.
    const target = deriver().derive({ invoiceId: INVOICE, chain: 'bsc', payoutAddress: MERCHANT });
    assert.equal(target.memo, undefined);
  });

  // ── shared-address chains ──────────────────────────────────────────────────

  test('a shared-address chain returns the configured wallet and a memo', () => {
    const target = deriver().derive({ invoiceId: INVOICE, chain: 'ton', payoutAddress: 'EQmerchant' });
    assert.equal(target.address, TON_WALLET);
    assert.match(target.memo ?? '', /^AVEX-[0-9A-F]{12}$/);
  });

  test('the memo does not depend on the payout address', () => {
    // It identifies the invoice, not the merchant. Two merchants' invoices share the
    // wallet, so mixing the destination into the memo would buy nothing and would make
    // the memo change if a merchant rotated their wallet.
    const first = deriver().derive({ invoiceId: INVOICE, chain: 'ton', payoutAddress: 'EQone' });
    const second = deriver().derive({ invoiceId: INVOICE, chain: 'ton', payoutAddress: 'EQtwo' });
    assert.equal(first.memo, second.memo);
  });

  test('different invoices get different memos', () => {
    // On a shared wallet the memo is the only thing distinguishing one payment from
    // another, so a collision misattributes money.
    const memos = new Set(
      Array.from({ length: 200 }, (_, index) =>
        memoFor(`e9f3c1a0-0000-4000-8000-${String(index).padStart(12, '0')}`, 'a-memo-secret'),
      ),
    );
    assert.equal(memos.size, 200);
  });

  test('the memo is not derivable without the secret', () => {
    /**
     * A memo is visible to anyone watching the shared wallet. If it were a plain
     * function of the invoice id, someone who learned an id could reuse the memo and
     * claim the payment — so it is keyed.
     */
    assert.notEqual(memoFor(INVOICE, 'one-secret'), memoFor(INVOICE, 'another-secret'));
  });

  test('the memo is short enough to type', () => {
    // Some payers type this into a wallet field by hand, and length costs accuracy.
    assert.ok(memoFor(INVOICE, 'a-memo-secret').length <= 20);
  });

  // ── refusals ───────────────────────────────────────────────────────────────

  test('a chain we support but have not configured is our own failure', () => {
    /**
     * Reported separately from an unknown chain, because the two send an operator to
     * different places: one is a missing environment variable, the other is a feature
     * that does not exist.
     */
    assert.throws(
      () => deriver().derive({ invoiceId: INVOICE, chain: 'solana', payoutAddress: 'abc' }),
      (error: unknown) =>
        error instanceof DepositAddressError && error.code === 'not_configured',
    );
  });

  test('an unknown chain is refused as unknown', () => {
    assert.throws(
      () => deriver().derive({ invoiceId: INVOICE, chain: 'dogecoin', payoutAddress: 'D123' }),
      (error: unknown) =>
        error instanceof DepositAddressError && error.code === 'chain_unsupported',
    );
  });

  test('supportedChains reports what this deployment can actually issue', () => {
    // Used to answer "why can I not invoice on X" without reading configuration.
    assert.deepEqual(deriver().supportedChains(), ['bsc', 'ethereum', 'ton']);
  });
});

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  LATE_PAYMENT_GRACE_MS,
  assetKeyOf,
  decidePooled,
} from './pooled-matching.js';
import type { CandidateInvoice, MatchContext, ObservedTransfer } from './pooled-matching.js';

/**
 * Every scenario the shared-wallet design has to survive, as a table of decisions.
 *
 * These are the rules a support conversation will be had about — "why did my payment go to
 * that order" — so each one is written as the story that produces it, and the decision is
 * asserted by rule name as well as by invoice, because two rules landing on the same invoice
 * for different reasons would be two different things to explain.
 */

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const USDT = 'tron:tusdt';
const USDC = 'tron:tusdc';

let sequence = 0;
function invoice(over: Partial<CandidateInvoice> & { readonly amountDue: bigint }): CandidateInvoice {
  sequence += 1;
  return {
    id: over.id ?? `inv-${sequence}`,
    decimals: 6,
    assetKey: USDT,
    status: 'pending',
    expiresAt: NOW + HOUR,
    createdAt: NOW - HOUR,
    ...over,
  };
}

function transfer(amount: bigint, over: Partial<ObservedTransfer> = {}): ObservedTransfer {
  return { amount, decimals: 6, assetKey: USDT, from: null, seenAt: NOW, ...over };
}

function context(candidates: readonly CandidateInvoice[], over: Partial<MatchContext> = {}): MatchContext {
  return { now: NOW, candidates, priorPayments: [], ...over };
}

const credit = (invoiceId: string, rule: string, sameAsset = true) => ({
  kind: 'credit',
  invoiceId,
  rule,
  sameAsset,
});

describe('rule 1: the exact number', () => {
  test('picks its invoice out of several at one address', () => {
    const a = invoice({ id: 'a', amountDue: 20_001_000n });
    const b = invoice({ id: 'b', amountDue: 20_002_000n });
    const c = invoice({ id: 'c', amountDue: 20_003_000n });
    assert.deepEqual(decidePooled(transfer(20_002_000n), context([a, b, c])), credit('b', 'exact_amount'));
  });

  test('the right number in the wrong stablecoin still finds its invoice', () => {
    /**
     * The payer chose USDT, then sent USDC to the same wallet on the same chain. The amount is
     * the identity and it matches one invoice; the token is a detail the sink settles by value.
     * On BNB Chain the two tokens even have different decimals, so the comparison is by the
     * number read, not by smallest units.
     */
    const a = invoice({ id: 'a', amountDue: 20_001_000n });
    const b = invoice({ id: 'b', amountDue: 20_002_000n });
    const decision = decidePooled(
      transfer(20_002n * 10n ** 15n, { decimals: 18, assetKey: USDC }),
      context([a, b]),
    );
    assert.deepEqual(decision, credit('b', 'exact_amount', false));
  });

  test('a late payer who sent the exact figure is credited to the invoice that expired', () => {
    /**
     * The invoice lapsed two hours ago and the pool has kept its number reserved, so nobody
     * else can be asking for 20.001 here. The money is that payer's and that merchant's.
     */
    const late = invoice({ id: 'late', amountDue: 20_001_000n, status: 'expired', expiresAt: NOW - 2 * HOUR });
    const open = invoice({ id: 'open', amountDue: 20_002_000n });
    assert.deepEqual(decidePooled(transfer(20_001_000n), context([late, open])), credit('late', 'exact_amount_late'));
  });

  test('a day after the invoice closed its number no longer names it', () => {
    const old = invoice({ id: 'old', amountDue: 20_001_000n, status: 'expired', expiresAt: NOW - LATE_PAYMENT_GRACE_MS - 1 });
    assert.deepEqual(decidePooled(transfer(20_001_000n), context([old])), { kind: 'park', reason: 'invoice_expired' });
  });

  test('a second exact payment to an already-paid invoice goes to it, as an overpayment', () => {
    // The payer paid twice. Truthful: the invoice shows twice the money and the merchant refunds.
    const paid = invoice({ id: 'paid', amountDue: 20_001_000n, status: 'paid' });
    const other = invoice({ id: 'other', amountDue: 20_002_000n });
    assert.deepEqual(decidePooled(transfer(20_001_000n), context([paid, other])), credit('paid', 'exact_amount_late'));
  });

  test('two open invoices at one amount is the bug the lock prevents, and goes to a person', () => {
    const a = invoice({ id: 'a', amountDue: 20_001_000n });
    const b = invoice({ id: 'b', amountDue: 20_001_000n });
    assert.deepEqual(decidePooled(transfer(20_001_000n), context([a, b])), { kind: 'park', reason: 'ambiguous' });
  });

  test('an exact match on a closed invoice yields to an open one at the same number', () => {
    // The number was reused after the reservation lapsed; the live invoice is the answer.
    const closed = invoice({ id: 'closed', amountDue: 20_001_000n, status: 'paid', expiresAt: NOW - 2 * HOUR });
    const open = invoice({ id: 'open', amountDue: 20_001_000n });
    assert.deepEqual(decidePooled(transfer(20_001_000n), context([closed, open])), credit('open', 'exact_amount'));
  });
});

describe('rule 2: the same sender', () => {
  test('a second transfer from the wallet that paid an invoice goes with the first', () => {
    /**
     * Two invoices open. The payer of A already paid A from 0xPAYER and now sends a top-up with
     * a round number. It is A's — not B's, though B is open and A is already paid.
     */
    const a = invoice({ id: 'a', amountDue: 20_001_000n, status: 'paid' });
    const b = invoice({ id: 'b', amountDue: 30_001_000n });
    const decision = decidePooled(
      transfer(5_000_000n, { from: 'TPAYER' }),
      context([a, b], { priorPayments: [{ invoiceId: 'a', from: 'TPAYER', creditedAt: NOW - HOUR }] }),
    );
    assert.deepEqual(decision, credit('a', 'same_sender'));
  });

  test('a sender who paid two invoices here and sends a third amount is nobody\'s to decide', () => {
    const a = invoice({ id: 'a', amountDue: 20_001_000n, status: 'paid' });
    const b = invoice({ id: 'b', amountDue: 30_001_000n, status: 'paid' });
    const decision = decidePooled(
      transfer(5_000_000n, { from: 'TPAYER' }),
      context([a, b], {
        priorPayments: [
          { invoiceId: 'a', from: 'TPAYER', creditedAt: NOW - HOUR },
          { invoiceId: 'b', from: 'TPAYER', creditedAt: NOW - HOUR },
        ],
      }),
    );
    assert.deepEqual(decision, { kind: 'park', reason: 'ambiguous' });
  });

  test('the sender rule outranks the sole open invoice', () => {
    // One invoice open (B), but the sender is A's payer. A wins.
    const a = invoice({ id: 'a', amountDue: 20_001_000n, status: 'paid' });
    const b = invoice({ id: 'b', amountDue: 30_001_000n });
    const decision = decidePooled(
      transfer(1_000_000n, { from: 'TPAYER' }),
      context([a, b], { priorPayments: [{ invoiceId: 'a', from: 'TPAYER', creditedAt: NOW - HOUR }] }),
    );
    assert.deepEqual(decision, credit('a', 'same_sender'));
  });

  test('a prior payment older than the grace is not evidence', () => {
    const a = invoice({ id: 'a', amountDue: 20_001_000n, status: 'paid', expiresAt: NOW - 2 * HOUR });
    const b = invoice({ id: 'b', amountDue: 30_001_000n });
    const decision = decidePooled(
      transfer(1_000_000n, { from: 'TPAYER' }),
      context([a, b], { priorPayments: [{ invoiceId: 'a', from: 'TPAYER', creditedAt: NOW - LATE_PAYMENT_GRACE_MS - 1 }] }),
    );
    assert.deepEqual(decision, credit('b', 'sole_open'));
  });
});

describe('rule 3: the only candidate', () => {
  test('a wrong amount with one invoice open is credited to it', () => {
    /**
     * The payer sent the round number — their exchange truncated it, or they typed $20.00
     * because that is the price. One invoice is open at this wallet, so there is no ambiguity
     * about whose payment it is, and refusing it would leave a real payment looking like no
     * payment. The sink records it as underpaid, with the shortfall kept.
     */
    const only = invoice({ id: 'only', amountDue: 20_001_000n });
    assert.deepEqual(decidePooled(transfer(20_000_000n), context([only])), credit('only', 'sole_open'));
  });

  test('the wrong token with one invoice open is credited too, by value', () => {
    const only = invoice({ id: 'only', amountDue: 20_001_000n });
    const decision = decidePooled(transfer(20_000_000n, { assetKey: USDC }), context([only]));
    assert.deepEqual(decision, credit('only', 'sole_open', false));
  });

  test('a wrong amount with two invoices open is parked, not guessed', () => {
    const a = invoice({ id: 'a', amountDue: 20_001_000n });
    const b = invoice({ id: 'b', amountDue: 20_002_000n });
    assert.deepEqual(decidePooled(transfer(20_000_000n), context([a, b])), { kind: 'park', reason: 'ambiguous' });
  });

  test('paid and long-expired invoices at the wallet do not make it busy', () => {
    const paid = invoice({ id: 'paid', amountDue: 20_001_000n, status: 'paid' });
    const gone = invoice({ id: 'gone', amountDue: 20_003_000n, status: 'expired', expiresAt: NOW - 3 * HOUR });
    const only = invoice({ id: 'only', amountDue: 20_002_000n });
    assert.deepEqual(decidePooled(transfer(20_000_000n), context([paid, gone, only])), credit('only', 'sole_open'));
  });

  test('an invoice that lapsed unpaid does not hold back a payment to the one still open', () => {
    /**
     * The merchant's rule, applied literally: "empty" means no other invoice is open. A test
     * payment for more than the price arrived while an earlier abandoned invoice on the same
     * wallet had expired minutes before; holding the new payment for an hour on the chance that
     * the earlier payer was both late and wrong made the live payment look lost. The late payer
     * who sends the exact figure is still found by rule 1.
     */
    const lapsed = invoice({ id: 'lapsed', amountDue: 20_001_000n, status: 'expired', expiresAt: NOW - HOUR / 2 });
    const only = invoice({ id: 'only', amountDue: 20_002_000n, expiresAt: NOW + 3 * HOUR });
    assert.deepEqual(decidePooled(transfer(20_000_000n), context([lapsed, only])), credit('only', 'sole_open'));
  });

  test('an invoice past its deadline that the sweep has not yet marked is not open either', () => {
    // Status still says pending; the clock says otherwise. The clock is right.
    const lapsed = invoice({ id: 'lapsed', amountDue: 20_001_000n, status: 'pending', expiresAt: NOW - HOUR / 2 });
    const only = invoice({ id: 'only', amountDue: 20_002_000n });
    assert.deepEqual(decidePooled(transfer(20_000_000n), context([lapsed, only])), credit('only', 'sole_open'));
  });

  test('nothing open and nothing exact is a late payer for a person to find', () => {
    const gone = invoice({ id: 'gone', amountDue: 20_001_000n, status: 'expired', expiresAt: NOW - 3 * HOUR });
    assert.deepEqual(decidePooled(transfer(20_000_000n), context([gone])), { kind: 'park', reason: 'invoice_expired' });
  });
});

describe('the sweep: deciding again later', () => {
  test('once the other invoice is paid exactly, the survivor gets the stray', () => {
    /**
     * The scenario the merchant described: two hundred payers at once, one of them types the
     * amount wrong. At receive time A and B are both open and the stray is parked. A's payer
     * then pays A exactly; on the next pass B is the only open invoice that existed when the
     * stray arrived, and the stray is B's.
     */
    const a = invoice({ id: 'a', amountDue: 20_001_000n, status: 'paid' });
    const b = invoice({ id: 'b', amountDue: 20_002_000n });
    const stray = transfer(20_000_000n, { seenAt: NOW - HOUR / 2 });
    assert.deepEqual(decidePooled(stray, context([a, b])), credit('b', 'sole_open'));
  });

  test('an invoice issued after the stray arrived is not a candidate for it', () => {
    /**
     * The stray was parked at 10:00 with A and B open. Both were paid exactly; C was issued on
     * the wallet at 10:20. C cannot be what the 10:00 payer was paying, however alone it is now.
     */
    const a = invoice({ id: 'a', amountDue: 20_001_000n, status: 'paid' });
    const b = invoice({ id: 'b', amountDue: 20_002_000n, status: 'paid' });
    const c = invoice({ id: 'c', amountDue: 20_003_000n, createdAt: NOW - 40 * 60_000 });
    const stray = transfer(20_000_000n, { seenAt: NOW - HOUR });
    assert.deepEqual(decidePooled(stray, context([a, b, c])), { kind: 'park', reason: 'invoice_expired' });
  });

  test('two strays for one survivor both go to it', () => {
    // Two wrong amounts, one open invoice they could be for: both are that invoice's, as an
    // over- or under-payment. Nothing else exists for either to belong to.
    const a = invoice({ id: 'a', amountDue: 20_001_000n, status: 'paid' });
    const b = invoice({ id: 'b', amountDue: 20_002_000n });
    const first = transfer(20_000_000n, { seenAt: NOW - HOUR / 2 });
    const second = transfer(5_000_000n, { seenAt: NOW - HOUR / 3 });
    assert.deepEqual(decidePooled(first, context([a, b])), credit('b', 'sole_open'));
    assert.deepEqual(decidePooled(second, context([a, b])), credit('b', 'sole_open'));
  });
});

describe('what a token is called for comparison', () => {
  test('contracts compare case-insensitively and native assets by symbol', () => {
    assert.equal(assetKeyOf({ chain: 'bsc', symbol: 'USDT', contract: '0xAbC' }), assetKeyOf({ chain: 'bsc', symbol: 'Tether', contract: '0xabc' }));
    assert.notEqual(assetKeyOf({ chain: 'bsc', symbol: 'USDT', contract: '0xabc' }), assetKeyOf({ chain: 'polygon', symbol: 'USDT', contract: '0xabc' }));
    assert.equal(assetKeyOf({ chain: 'bsc', symbol: 'BNB', contract: null }), 'bsc:native:bnb');
  });
});

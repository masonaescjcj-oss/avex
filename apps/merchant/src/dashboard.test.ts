import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  assetStance,
  assetUrgency,
  balanceView,
  commissionLabel,
  commissionParts,
  feePayerChoices,
  groupAssetsByChain,
  keyMode,
  ladderRows,
  ledgerRows,
  setupSteps,
  statusView,
  tierProgressView,
  type AssetState,
} from './dashboard.js';

/**
 * The dashboard's decisions, tested away from the DOM.
 *
 * Each of these answers something a merchant acts on and a reader cannot verify by
 * looking at the page: is this account ready to take real money, does this status need
 * me, how far off a cheaper rate am I. Rendering can be eyeballed; these cannot.
 */

describe('invoice status', () => {
  test('paid and expired read as settled and closed', () => {
    assert.equal(statusView('paid').tone, 'good');
    assert.equal(statusView('paid').needsAttention, false);
    assert.equal(statusView('expired').tone, 'dead');
  });

  test('under- and overpayment are the two that need a human', () => {
    /**
     * The mapping a naive traffic light gets backwards. Green for paid and red for
     * expired is obvious; the two states that actually require work are the ones in the
     * middle, and both have real money against them.
     */
    for (const status of ['underpaid', 'overpaid']) {
      const view = statusView(status);
      assert.equal(view.needsAttention, true, status);
      assert.equal(view.tone, 'warn', status);
    }
    // And each says what to do, rather than only what happened.
    assert.match(statusView('underpaid').hint, /send the difference/);
    assert.match(statusView('overpaid').hint, /owe the payer/);
  });

  test('waiting states do not ask for attention', () => {
    // Otherwise every open invoice would sit in the list of things to deal with, and the
    // two that matter would be invisible among them.
    assert.equal(statusView('pending').needsAttention, false);
    assert.equal(statusView('confirming').needsAttention, false);
  });

  test('an unknown status is shown as itself, never guessed at', () => {
    /**
     * A future state rendered as "Paid" because it was the closest match is how goods get
     * shipped against a payment that did not complete. Showing the raw value is honest and
     * obviously unfinished.
     */
    const view = statusView('partially_refunded');
    assert.equal(view.label, 'partially_refunded');
    assert.equal(view.needsAttention, true);
    assert.match(view.hint, /does not recognise/);
  });

  test('an empty status does not render an empty label', () => {
    assert.equal(statusView('').label, 'Unknown');
  });
});

describe('setup checklist', () => {
  const base = {
    enabledAssets: 0,
    approvedEnabledAssets: 0,
    payoutChains: [],
    assetChains: [],
    webhookEndpoints: 0,
    liveKeys: 0,
  };

  const step = (input: Parameters<typeof setupSteps>[0], id: string) =>
    setupSteps(input).find((entry) => entry.id === id)!;

  test('a new account has nothing done', () => {
    assert.deepEqual(
      setupSteps(base).map((entry) => entry.done),
      [false, false, false, false],
    );
  });

  test('an enabled asset still in review does not count, and says why', () => {
    /**
     * The distinction a single "have you enabled anything" check would miss. A merchant
     * who submitted their own token and enabled it sees it in their list, so being told
     * "enable a currency" is confusing — the truthful message is that it is still in
     * review.
     */
    const entry = step({ ...base, enabledAssets: 1, approvedEnabledAssets: 0 }, 'assets');
    assert.equal(entry.done, false);
    assert.match(entry.why, /still in review/);
  });

  test('a payout address on one chain does not cover another', () => {
    /**
     * The half-configured account this exists to catch: USDT enabled on BSC and TON, a
     * BSC address added, and every TON invoice refused. "At least one payout address"
     * would call that finished.
     */
    const entry = step(
      {
        ...base,
        approvedEnabledAssets: 2,
        assetChains: ['bsc', 'ton'],
        payoutChains: ['bsc'],
      },
      'payouts',
    );
    assert.equal(entry.done, false);
    // And it names the chain, so the merchant does not have to work it out.
    assert.match(entry.why, /ton/);
  });

  test('every chain covered marks the step done', () => {
    const entry = step(
      {
        ...base,
        approvedEnabledAssets: 2,
        assetChains: ['bsc', 'ton'],
        payoutChains: ['ton', 'bsc'],
      },
      'payouts',
    );
    assert.equal(entry.done, true);
  });

  test('no assets means the payout step is not yet satisfiable', () => {
    // Vacuously "all covered" would tick a step the merchant has not done, and the
    // checklist would claim they were ready with nothing enabled.
    assert.equal(step({ ...base, payoutChains: ['bsc'] }, 'payouts').done, false);
  });

  test('a test key alone does not satisfy the live-key step', () => {
    // Test keys cannot take real money by design, so an account with only one is not
    // live however complete it looks.
    assert.equal(step({ ...base, liveKeys: 0 }, 'live-key').done, false);
    assert.equal(step({ ...base, liveKeys: 1 }, 'live-key').done, true);
  });

  test('a fully configured account has every step done', () => {
    const steps = setupSteps({
      enabledAssets: 1,
      approvedEnabledAssets: 1,
      assetChains: ['bsc'],
      payoutChains: ['bsc'],
      webhookEndpoints: 1,
      liveKeys: 1,
    });
    assert.ok(steps.every((entry) => entry.done));
  });

  test('the steps are in the order they block things', () => {
    // Nothing to invoice, then nowhere to settle, then nobody told, then no live key.
    assert.deepEqual(
      setupSteps(base).map((entry) => entry.id),
      ['assets', 'payouts', 'webhook', 'live-key'],
    );
  });
});

describe('tier progress', () => {
  const view = (
    processed: string,
    options: {
      readonly feeBps?: number;
      readonly wouldEarnBps?: number;
      readonly negotiated?: boolean;
      readonly nextTier?: { readonly bps: number; readonly fromUsdMicros: string } | null;
    } = {},
  ) =>
    tierProgressView({
      processedUsdMicros: processed,
      feeBps: options.feeBps ?? 50,
      wouldEarnBps: options.wouldEarnBps ?? 50,
      negotiated: options.negotiated ?? false,
      nextTier:
        options.nextTier === undefined
          ? { bps: 45, fromUsdMicros: '50000000000' }
          : options.nextTier,
    });

  test('a quiet period reports what would reach the next rung', () => {
    /**
     * The bar this replaced counted down towards a $49 bill: filling it was bad news, and
     * a merchant doing well watched it turn red. The same volume figure now means the
     * opposite, so the message has to point at the reward rather than at a threshold.
     */
    const result = view('10000000000');
    assert.equal(result.processedUsd, '$10,000.00');
    assert.equal(result.percent, 20);
    assert.equal(result.earned, false);
    assert.match(result.message, /\$40,000\.00 more this period reaches 0\.45%/);
  });

  test('a period that has already earned a rung says when it starts', () => {
    /**
     * Deliberately future-tense. The rate changes when the period closes, and a merchant
     * told "you are on 0.45%" who then reads 0.5% on their next invoice was misled.
     */
    const result = view('61000000000', { wouldEarnBps: 45 });
    assert.equal(result.earned, true);
    assert.equal(result.percent, 100);
    assert.match(result.message, /enough for 0\.45%/);
    assert.match(result.message, /when the period closes/);
  });

  test('the bottom rung promises nothing further', () => {
    // Naming a threshold below the floor would promise a reduction that cannot arrive.
    const result = view('400000000000', { feeBps: 40, wouldEarnBps: 40, nextTier: null });
    assert.equal(result.earned, false);
    assert.match(result.message, /lowest rate we publish/);
    assert.match(result.message, /0\.4%/);
  });

  test('a negotiated rate is not shown as progress towards a rung', () => {
    // The ladder does not apply to them, so a part-filled bar would be a promise we have
    // already decided not to keep.
    const result = view('1000000000', { feeBps: 25, negotiated: true, nextTier: null });
    assert.equal(result.percent, 100);
    assert.match(result.message, /your agreed rate/);
  });

  test('the bar never exceeds its track', () => {
    /**
     * Clamped in the model rather than in CSS, because the number is also read aloud —
     * "333 per cent of the way to your next rate" is not a sentence that helps anyone.
     */
    assert.equal(view('900000000000').percent, 100);
  });

  test('a zero target does not divide by zero', () => {
    assert.equal(view('100', { nextTier: { bps: 45, fromUsdMicros: '0' } }).percent, 100);
  });

  test('thousands are grouped and cents kept', () => {
    // A merchant checking a figure against their own books reads it digit by digit.
    assert.equal(view('1234567890').processedUsd, '$1,234.56');
  });

  test('a malformed figure reads as zero rather than NaN', () => {
    // The API sends strings; a bug upstream must not put "NaN" in front of a merchant.
    const result = view('not-a-number');
    assert.equal(result.processedUsd, '$0.00');
    assert.equal(result.percent, 0);
  });

  test('an enormous figure does not overflow', () => {
    // Micro-dollars beyond a double, which is why the arithmetic is in BigInt.
    const result = view('9007199254740993000000');
    assert.equal(result.percent, 100);
    assert.equal(result.processedUsd, '$9,007,199,254,740,993.00');
  });
});

describe('the published ladder', () => {
  const LADDER = [
    { bps: 50, fromUsdMicros: '0' },
    { bps: 45, fromUsdMicros: '50000000000' },
    { bps: 40, fromUsdMicros: '250000000000' },
  ];

  test('the entry rung reads as applying from the first payment', () => {
    // "over $0.00 a month" is technically true and tells a merchant nothing.
    const rows = ladderRows(LADDER, 50, false);
    assert.equal(rows[0]?.rate, '0.5%');
    assert.equal(rows[0]?.from, 'from your first payment');
    assert.equal(rows[1]?.from, 'over $50,000.00 a month');
  });

  test('the merchant\'s own rung is the only one marked', () => {
    const rows = ladderRows(LADDER, 45, false);
    assert.deepEqual(
      rows.map((row) => row.current),
      [false, true, false],
    );
  });

  test('a negotiated rate marks no rung, even when the number coincides', () => {
    /**
     * A merchant on an agreed 0.45% is not on the ladder's 0.45%: their rate will not move
     * when their volume does. Marking the rung would tell them the ladder applies.
     */
    const rows = ladderRows(LADDER, 45, true);
    assert.ok(rows.every((row) => !row.current));
  });
});

describe('what a merchant can do about a currency', () => {
  const approved = {
    verdict: 'approved',
    listed: true,
    enabled: true,
    requiresFixedRate: false,
    pricingMode: 'fiat',
    fixedRateValidUntil: null,
  };

  test('everything in place reads as accepting', () => {
    const stance = assetStance(approved, true);
    assert.equal(stance.state, 'accepting');
    assert.equal(stance.tone, 'good');
    assert.equal(stance.canToggle, true);
  });

  test('an available currency they have not turned on is theirs to act on', () => {
    const stance = assetStance({ ...approved, enabled: false }, true);
    assert.equal(stance.state, 'off');
    assert.equal(stance.canToggle, true);
    assert.match(stance.hint, /Turn it on/);
  });

  test('on with no payout address says invoices are refused', () => {
    /**
     * The state a merchant is most likely to be in without knowing: they enabled a
     * currency, they believe they are accepting it, and every invoice is being refused.
     */
    const stance = assetStance(approved, false);
    assert.equal(stance.state, 'needs_payout');
    assert.equal(stance.tone, 'warn');
    assert.match(stance.hint, /refused/);
  });

  test('a missing payout address beats a missing rate', () => {
    /**
     * Both refuse an invoice, but only one means the money would have nowhere to go. Naming
     * the rate first would have somebody set a rate and still be refused.
     */
    const stance = assetStance(
      { ...approved, requiresFixedRate: true, pricingMode: null },
      false,
    );
    assert.equal(stance.state, 'needs_payout');
  });

  test('a token nothing prices asks for the merchant own rate', () => {
    const stance = assetStance(
      { ...approved, requiresFixedRate: true, pricingMode: null },
      true,
    );
    assert.equal(stance.state, 'needs_rate');
    // The reason is unusual and merchants do not expect it, so it is spelled out.
    assert.match(stance.hint, /nothing on the market prices/i);
  });

  test('a lapsed rate is distinguished from an absent one', () => {
    /**
     * Different actions: one is "set a rate", the other is "renew the rate you set". A
     * merchant told the second when the first is true goes looking for a field they already
     * filled in.
     */
    const lapsed = assetStance(
      {
        ...approved,
        requiresFixedRate: true,
        pricingMode: 'fixed_rate',
        fixedRateValidUntil: '2020-01-01T00:00:00.000Z',
      },
      true,
    );
    assert.equal(lapsed.state, 'needs_rate');
    assert.match(lapsed.label, /lapsed/i);

    const current = assetStance(
      {
        ...approved,
        requiresFixedRate: true,
        pricingMode: 'fixed_rate',
        fixedRateValidUntil: '2030-01-01T00:00:00.000Z',
      },
      true,
    );
    assert.equal(current.state, 'accepting');
  });

  test('a rate that lapses on a priced asset is still a lapsed rate', () => {
    // A merchant may choose their own rate for an asset the market does price. If that rate
    // expires, invoices stop — so `requiresFixedRate` being false must not hide it.
    const stance = assetStance(
      {
        ...approved,
        requiresFixedRate: false,
        pricingMode: 'fixed_rate',
        fixedRateValidUntil: '2020-01-01T00:00:00.000Z',
      },
      true,
    );
    assert.equal(stance.state, 'needs_rate');
  });

  test('a contract in review is not something a switch can fix', () => {
    const stance = assetStance({ ...approved, verdict: 'review', enabled: false }, true);
    assert.equal(stance.state, 'in_review');
    assert.equal(stance.canToggle, false, 'a switch that cannot help reads as a broken page');
  });

  test('a currency we have stopped offering says it is us, not them', () => {
    /**
     * The state this whole function exists for. A merchant told only "unavailable" goes
     * looking at their own configuration, and there is nothing there to find.
     */
    const stance = assetStance({ ...approved, listed: false }, true);
    assert.equal(stance.state, 'withdrawn');
    assert.equal(stance.canToggle, false);
    assert.match(stance.hint, /AVEX is not accepting/);
    assert.match(stance.hint, /already open still complete/);
  });

  test('withdrawn outranks anything the merchant could change', () => {
    // Enabled, no payout address, and we have withdrawn it: telling them about the address
    // would send them to fix something that would not help.
    const stance = assetStance({ ...approved, listed: false }, false);
    assert.equal(stance.state, 'withdrawn');
  });

  test('a refused contract outranks everything, including our own withdrawal', () => {
    const stance = assetStance({ ...approved, verdict: 'blocked', listed: false }, false);
    assert.equal(stance.state, 'blocked');
  });

  test('an asset with no listed field is treated as offered', () => {
    // Absent, not false: an older API response that does not carry the field must not read
    // as every currency having been withdrawn.
    const { listed, ...withoutListed } = approved;
    void listed;
    assert.equal(assetStance(withoutListed, true).state, 'accepting');
  });
});

describe('ordering the currency list', () => {
  test('anything on but refusing invoices comes first', () => {
    /**
     * The only genuinely urgent case: the merchant believes they are accepting that
     * currency and they are not.
     */
    const order: AssetState[] = ['accepting', 'off', 'needs_payout', 'in_review', 'withdrawn', 'blocked'];
    const sorted = [...order].sort((left, right) => assetUrgency(left) - assetUrgency(right));
    assert.equal(sorted[0], 'needs_payout');
    assert.equal(sorted.at(-1), 'blocked');
  });

  test('currencies group by chain, and chains sort by name', () => {
    // By chain because that is how the decisions cluster: a payout address is per chain,
    // and so is our own readiness.
    const grouped = groupAssetsByChain(
      [
        { chain: 'ton', symbol: 'USDT' },
        { chain: 'bsc', symbol: 'USDT' },
        { chain: 'bsc', symbol: 'BNB' },
      ],
      () => 0,
    );
    assert.deepEqual(
      grouped.map((group) => group.chain),
      ['bsc', 'ton'],
    );
    // Within a chain, equal urgency falls back to the symbol so the order is stable.
    assert.deepEqual(
      grouped[0]!.assets.map((asset) => asset.symbol),
      ['BNB', 'USDT'],
    );
  });

  test('urgency wins over the alphabet inside a chain', () => {
    const grouped = groupAssetsByChain(
      [
        { chain: 'bsc', symbol: 'AAAA' },
        { chain: 'bsc', symbol: 'ZZZZ' },
      ],
      (asset) => (asset.symbol === 'ZZZZ' ? 0 : 1),
    );
    assert.deepEqual(
      grouped[0]!.assets.map((asset) => asset.symbol),
      ['ZZZZ', 'AAAA'],
    );
  });
});

describe('who pays the commission', () => {
  test('the choice is spelled out in what it does to a $100 order', () => {
    /**
     * Written as a worked figure rather than as a rule, because the rule reads the wrong
     * way round. "Your customer pays the fee" sounds like a separate bill; what actually
     * happens is the invoice asks for more, and only a number says that unambiguously.
     */
    const [absorb, pass] = feePayerChoices(50, 'merchant');
    assert.match(absorb!.detail, /sends \$100 and you receive \$99\.5/);
    assert.match(pass!.detail, /sends \$100\.5 and you receive \$100/);
    // And the payer is told, which is the part a merchant needs to know before choosing.
    assert.match(pass!.detail, /shown to them on the checkout/);
  });

  test('exactly one option is marked as the current one', () => {
    const choices = feePayerChoices(50, 'payer');
    assert.deepEqual(
      choices.map((choice) => choice.current),
      [false, true],
    );
  });

  test('at a zero commission passing it on is described as a no-op', () => {
    /**
     * Otherwise the option promises a surcharge we would not apply. A merchant on a waived
     * commission who switched this expecting their customers to cover something would find
     * nothing had changed and no explanation of why.
     */
    const [, pass] = feePayerChoices(0, 'merchant');
    assert.match(pass!.detail, /changes nothing/);
  });

  test('the rate follows the merchant own rung', () => {
    // 0.4% of $100 is 40 cents, not 50. A hardcoded example would be wrong for every
    // merchant who earned their way down the ladder.
    const [, pass] = feePayerChoices(40, 'merchant');
    assert.match(pass!.detail, /sends \$100\.4 and you receive \$100/);
  });
});

describe('commission', () => {
  test('basis points are shown as money too', () => {
    // 50 bps is the entry rate. "50 bps" makes a merchant do arithmetic to find out what
    // they are paying; "$5 per $1,000" does not.
    assert.equal(commissionLabel(50), '0.5% — $5 per $1,000');
    assert.equal(commissionLabel(45), '0.45% — $4.5 per $1,000');
    assert.equal(commissionLabel(40), '0.4% — $4 per $1,000');
  });

  test('a waived commission reads as zero, not as blank', () => {
    assert.equal(commissionLabel(0), '0% — $0 per $1,000');
  });

  test('the two halves are available separately', () => {
    /**
     * The overview shows them stacked rather than joined. At headline size the joined
     * string wraps onto two lines and shouts louder than the figure beside it, which is
     * the merchant's own volume — so the percentage is the headline and the money is the
     * explanation underneath.
     */
    assert.deepEqual(commissionParts(50), { percent: '0.5%', perThousand: '$5 per $1,000' });
    assert.deepEqual(commissionParts(45), { percent: '0.45%', perThousand: '$4.5 per $1,000' });
  });
});

describe('key mode', () => {
  test('the prefix decides, because that is what the API enforces', () => {
    assert.equal(keyMode('ak_test_abcd'), 'test');
    assert.equal(keyMode('ak_live_abcd'), 'live');
  });

  test('anything else is unknown rather than assumed live', () => {
    // Assuming live would mark a key as dangerous when it may not be; assuming test
    // would mark a dangerous key as safe. Neither is right, so neither is guessed.
    assert.equal(keyMode('sk_1234'), 'unknown');
    assert.equal(keyMode(''), 'unknown');
  });
});


/**
 * `formatUsdMicros`, as the page passes it.
 *
 * The real one lives in `@avex/ui-format` and is inlined into the page; duplicated here as a
 * two-decimal stand-in so these tests are about the wording and the sign, not about grouping.
 */
const usd = (micros: string): string => {
  const value = BigInt(micros);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 1_000_000n;
  const cents = (abs % 1_000_000n) / 10_000n;
  return `${negative ? '-' : ''}$${whole}.${cents.toString().padStart(2, '0')}`;
};

describe('the balance, as the panel shows it', () => {
  const base = {
    creditLimitUsdMicros: '500000000',
    canInvoiceOnAccruingChains: true,
    entryCount: 3,
    formatUsd: usd,
  };

  test('nothing owed says so, and says why there is usually nothing', () => {
    const view = balanceView({ ...base, balanceUsdMicros: '0' });
    assert.equal(view.tone, 'clear');
    assert.equal(view.headline, 'Nothing owed');
    // The reason matters more than the zero: a merchant should know a balance is not normal.
    assert.match(view.detail, /comes out of the payment itself/);
  });

  test('an ordinary balance explains itself rather than reading as a debt notice', () => {
    /**
     * The number a merchant sees here is negative, on a payments dashboard, next to their
     * money. Left unexplained that is a support ticket at best — so the headline names it and
     * the detail says the thing that actually matters: it clears itself, nothing is billed,
     * and no customer sees it.
     */
    const view = balanceView({ ...base, balanceUsdMicros: '-500000' });
    assert.equal(view.tone, 'owed');
    assert.equal(view.amount, '-$0.50');
    assert.match(view.headline, /Owed on TRON/);
    assert.match(view.detail, /clears itself/);
    assert.match(view.detail, /customers never see it/);
  });

  test('past the limit it says what is blocked and what to do', () => {
    /**
     * The one state that needs action, so it is the one state that names the action — and
     * names the alternative, because "take payments on another chain" is a thing they can do
     * today without paying us anything first.
     */
    const view = balanceView({
      ...base,
      balanceUsdMicros: '-501000000',
      canInvoiceOnAccruingChains: false,
    });
    assert.equal(view.tone, 'blocked');
    assert.match(view.headline, /paused/);
    assert.match(view.detail, /\$501\.00/, 'the amount owed, positive, in the sentence');
    assert.match(view.detail, /\$500\.00 limit/);
    assert.match(view.detail, /clear the balance as they are paid/);
  });

  test('the limit is reported from the API rather than assumed', () => {
    // Hard-coding $500 in the page would leave it disagreeing with the server the day the
    // limit changes, and the page is where a merchant would read it.
    const view = balanceView({
      ...base,
      balanceUsdMicros: '-9000000',
      canInvoiceOnAccruingChains: false,
      creditLimitUsdMicros: '8000000',
    });
    assert.match(view.detail, /\$8\.00 limit/);
  });

  test('an empty statement is flagged, so the panel can leave the table out', () => {
    assert.equal(balanceView({ ...base, balanceUsdMicros: '0', entryCount: 0 }).hasHistory, false);
    assert.equal(balanceView({ ...base, balanceUsdMicros: '0', entryCount: 1 }).hasHistory, true);
  });
});

describe('the balance statement', () => {
  test('each line says what it was, and the direction is not left to a minus sign', () => {
    /**
     * A column mixing `-$0.50` and `$0.50` is misread at a glance, and a statement is only
     * ever read at a glance. So the amount is the magnitude and `owed` carries the direction.
     */
    const rows = ledgerRows(
      [
        { kind: 'accrual', amountUsdMicros: '-500000', createdAt: '2026-08-01T00:00:00.000Z' },
        { kind: 'recovery', amountUsdMicros: '200000', createdAt: '2026-08-02T00:00:00.000Z' },
        { kind: 'settlement', amountUsdMicros: '300000', createdAt: '2026-08-03T00:00:00.000Z' },
      ],
      usd,
    );

    assert.deepEqual(
      rows.map((row) => [row.label, row.amount, row.owed]),
      [
        ['Commission on a TRON payment', '$0.50', true],
        ['Cleared by a later invoice', '$0.20', false],
        ['You paid us directly', '$0.30', false],
      ],
    );
  });

  test('a reversal is labelled as one, not as a mysterious credit', () => {
    const [row] = ledgerRows(
      [
        {
          kind: 'accrual_reversed',
          amountUsdMicros: '500000',
          createdAt: '2026-08-01T00:00:00.000Z',
        },
      ],
      usd,
    );
    assert.match(row!.label, /payment reversed/);
    assert.equal(row!.owed, false);
  });

  test('an unknown kind falls back to its name rather than to nothing', () => {
    // A kind added on the server before the page knows about it must still render a row: a
    // blank line in a statement is worse than an unfamiliar word.
    const [row] = ledgerRows(
      [{ kind: 'future_thing', amountUsdMicros: '-1', createdAt: '2026-08-01T00:00:00.000Z' }],
      usd,
    );
    assert.equal(row!.label, 'future_thing');
  });
});

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  commissionLabel,
  commissionParts,
  freeTierView,
  keyMode,
  setupSteps,
  statusView,
} from './dashboard.js';

/**
 * The dashboard's decisions, tested away from the DOM.
 *
 * Each of these answers something a merchant acts on and a reader cannot verify by
 * looking at the page: is this account ready to take real money, does this status need
 * me, how much free volume is left. Rendering can be eyeballed; these cannot.
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

describe('free tier', () => {
  const view = (processed: string, remaining: string, willBeFree: boolean) =>
    freeTierView({
      processedUsdMicros: processed,
      thresholdUsdMicros: '1500000000',
      remainingUsdMicros: remaining,
      willBeFree,
      monthlyPriceUsdMicros: '49000000',
    });

  test('a quiet period reports what is left', () => {
    const result = view('250000000', '1250000000', true);
    assert.equal(result.processedUsd, '$250.00');
    assert.equal(result.thresholdUsd, '$1,500.00');
    assert.equal(result.percent, 16);
    assert.match(result.message, /\$1,250\.00 of free volume left/);
  });

  test('over the allowance names the price instead', () => {
    const result = view('5000000000', '0', false);
    assert.equal(result.willBeFree, false);
    assert.match(result.message, /costs \$49\.00/);
  });

  test('the bar never exceeds its track', () => {
    /**
     * Clamped in the model rather than in CSS, because the number is also read aloud —
     * "333 per cent of your free allowance" is not a sentence that helps anyone.
     */
    assert.equal(view('5000000000', '0', false).percent, 100);
  });

  test('a zero threshold does not divide by zero', () => {
    const result = freeTierView({
      processedUsdMicros: '100',
      thresholdUsdMicros: '0',
      remainingUsdMicros: '0',
      willBeFree: false,
      monthlyPriceUsdMicros: '49000000',
    });
    assert.equal(result.percent, 0);
  });

  test('thousands are grouped and cents kept', () => {
    // A merchant checking a figure against their own books reads it digit by digit.
    assert.equal(view('1234567890', '265432110', true).processedUsd, '$1,234.56');
  });

  test('a malformed figure reads as zero rather than NaN', () => {
    // The API sends strings; a bug upstream must not put "NaN" in front of a merchant.
    const result = view('not-a-number', '', true);
    assert.equal(result.processedUsd, '$0.00');
    assert.equal(result.percent, 0);
  });

  test('an enormous figure does not overflow', () => {
    // Micro-dollars beyond a double, which is why the arithmetic is in BigInt.
    const result = freeTierView({
      processedUsdMicros: '9007199254740993000000',
      thresholdUsdMicros: '1500000000',
      remainingUsdMicros: '0',
      willBeFree: false,
      monthlyPriceUsdMicros: '49000000',
    });
    assert.equal(result.percent, 100);
    assert.equal(result.processedUsd, '$9,007,199,254,740,993.00');
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

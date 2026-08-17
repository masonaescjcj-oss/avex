import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Asset } from '../types.js';
import {
  DEFAULT_QUOTE_TTL_MS,
  DEFAULT_SPREAD_BPS,
  QuoteInputError,
  canOpenInvoice,
  createQuote,
  isQuoteExpired,
  quoteRemainingMs,
} from './quote.js';
import { fiatMicrosFromDecimalString, rateFromDecimalString } from './rate.js';

const NOW = 1_700_000_000_000;

const USDT: Asset = {
  symbol: 'USDT',
  chain: 'bsc',
  decimals: 18,
  kind: 'erc20',
  contract: '0x55d398326f99059fF775485246999027B3197955',
};

const WETH: Asset = { symbol: 'ETH', chain: 'ethereum', decimals: 18, kind: 'native' };

test('a fiat quote converts and applies the spread', () => {
  const quote = createQuote(
    {
      id: 'q_1',
      asset: USDT,
      mode: 'fiat',
      amountFiatMicros: fiatMicrosFromDecimalString('20'),
      rate: rateFromDecimalString('1', NOW),
      spreadBps: DEFAULT_SPREAD_BPS,
      ttlMs: DEFAULT_QUOTE_TTL_MS,
    },
    NOW,
  );

  assert.equal(quote.mode, 'fiat');
  // 50 bps means the payer sends slightly more than 20 whole tokens.
  assert.ok(quote.amountDue > 20_000_000_000_000_000_000n);
  assert.ok(quote.effectiveRate!.priceScaled < quote.marketRate!.priceScaled);
  assert.equal(quote.amountFiatMicros, fiatMicrosFromDecimalString('20'));
  assert.equal(quote.expiresAt, NOW + DEFAULT_QUOTE_TTL_MS);
});

test('a zero spread converts at the market rate exactly', () => {
  const quote = createQuote(
    {
      id: 'q_2',
      asset: USDT,
      mode: 'fiat',
      amountFiatMicros: fiatMicrosFromDecimalString('20'),
      rate: rateFromDecimalString('1', NOW),
      spreadBps: 0,
      ttlMs: DEFAULT_QUOTE_TTL_MS,
    },
    NOW,
  );

  assert.equal(quote.amountDue, 20_000_000_000_000_000_000n);
});

test('a token quote carries no rate risk at all', () => {
  // The payer is asked for an exact token amount, so nothing can move underneath
  // the invoice while it is open.
  const quote = createQuote(
    {
      id: 'q_3',
      asset: USDT,
      mode: 'token',
      amountToken: 20_000_000_000_000_000_000n,
      spreadBps: DEFAULT_SPREAD_BPS,
      ttlMs: DEFAULT_QUOTE_TTL_MS,
    },
    NOW,
  );

  assert.equal(quote.amountDue, 20_000_000_000_000_000_000n);
  assert.equal(quote.effectiveRate, null, 'nothing was converted');
  assert.equal(quote.spreadBps, 0, 'a spread on an unconverted amount is meaningless');
  assert.equal(quote.amountFiatMicros, null, 'no rate supplied, so no fiat value claimed');
});

test('a token quote records a fiat value when a rate is available', () => {
  const quote = createQuote(
    {
      id: 'q_4',
      asset: WETH,
      mode: 'token',
      amountToken: 10_000_000_000_000_000n, // 0.01 ETH
      rate: rateFromDecimalString('2000', NOW),
      spreadBps: 0,
      ttlMs: DEFAULT_QUOTE_TTL_MS,
    },
    NOW,
  );

  // Needed downstream for confirmation tiering, even though nothing was converted.
  assert.equal(quote.amountFiatMicros, fiatMicrosFromDecimalString('20'));
  assert.equal(quote.effectiveRate, null);
});

test('a fixed-rate quote uses the merchant rate without adding a spread', () => {
  // The merchant already chose the price they are selling at; layering a spread on
  // top would charge more than they configured.
  const merchantRate = rateFromDecimalString('0.25', NOW);
  const quote = createQuote(
    {
      id: 'q_5',
      asset: { ...USDT, symbol: 'MERCH', decimals: 6 },
      mode: 'fixed_rate',
      amountFiatMicros: fiatMicrosFromDecimalString('10'),
      rate: merchantRate,
      spreadBps: 200,
      ttlMs: DEFAULT_QUOTE_TTL_MS,
    },
    NOW,
  );

  assert.equal(quote.effectiveRate!.priceScaled, merchantRate.priceScaled);
  // $10 at $0.25 per token, 6 decimals: exactly 40 tokens.
  assert.equal(quote.amountDue, 40_000_000n);
});

test('fiat mode without a rate is refused rather than defaulted', () => {
  assert.throws(
    () =>
      createQuote(
        {
          id: 'q_6',
          asset: USDT,
          mode: 'fiat',
          amountFiatMicros: fiatMicrosFromDecimalString('20'),
          spreadBps: 0,
          ttlMs: DEFAULT_QUOTE_TTL_MS,
        },
        NOW,
      ),
    QuoteInputError,
  );
});

test('fixed_rate mode without the merchant rate is refused', () => {
  assert.throws(
    () =>
      createQuote(
        {
          id: 'q_7',
          asset: USDT,
          mode: 'fixed_rate',
          amountFiatMicros: fiatMicrosFromDecimalString('20'),
          spreadBps: 0,
          ttlMs: DEFAULT_QUOTE_TTL_MS,
        },
        NOW,
      ),
    /requires the merchant-configured rate/,
  );
});

test('non-positive and missing amounts are refused in every mode', () => {
  const shared = { asset: USDT, spreadBps: 0, ttlMs: DEFAULT_QUOTE_TTL_MS } as const;
  const rate = rateFromDecimalString('1', NOW);

  assert.throws(
    () => createQuote({ ...shared, id: 'a', mode: 'fiat', amountFiatMicros: 0n, rate }, NOW),
    QuoteInputError,
  );
  assert.throws(
    () => createQuote({ ...shared, id: 'b', mode: 'fiat', amountFiatMicros: -5n, rate }, NOW),
    QuoteInputError,
  );
  assert.throws(
    () => createQuote({ ...shared, id: 'c', mode: 'token', amountToken: 0n }, NOW),
    QuoteInputError,
  );
  assert.throws(() => createQuote({ ...shared, id: 'd', mode: 'token' }, NOW), QuoteInputError);
});

test('an asset too coarse-grained to express the price is refused', () => {
  // A $64,000 token with no decimals cannot represent a $1 invoice: rounding up
  // to one whole unit would ask the payer for $64,000. Rounding up protects the
  // merchant from being short, but it must never become an overcharge.
  assert.throws(
    () =>
      createQuote(
        {
          id: 'q_8',
          asset: { ...USDT, decimals: 0 },
          mode: 'fiat',
          amountFiatMicros: fiatMicrosFromDecimalString('1'),
          rate: rateFromDecimalString('64000', NOW),
          spreadBps: 0,
          ttlMs: DEFAULT_QUOTE_TTL_MS,
        },
        NOW,
      ),
    /granularity is too coarse/,
  );
});

test('ordinary rounding up is well within the overhead allowance', () => {
  // The same protection must not reject normal invoices: one wei of overhead on a
  // $20 invoice is nothing.
  const quote = createQuote(
    {
      id: 'q_8b',
      asset: WETH,
      mode: 'fiat',
      amountFiatMicros: fiatMicrosFromDecimalString('19.99'),
      rate: rateFromDecimalString('2000.37', NOW),
      spreadBps: DEFAULT_SPREAD_BPS,
      ttlMs: DEFAULT_QUOTE_TTL_MS,
    },
    NOW,
  );
  assert.ok(quote.amountDue > 0n);
});

test('the overhead allowance is configurable per quote', () => {
  const coarse = {
    id: 'q_8c',
    asset: { ...USDT, decimals: 2 },
    mode: 'fiat' as const,
    amountFiatMicros: fiatMicrosFromDecimalString('0.05'),
    rate: rateFromDecimalString('10', NOW),
    spreadBps: 0,
    ttlMs: DEFAULT_QUOTE_TTL_MS,
  };

  // $0.05 of a $10 token with 2 decimals is 0.005 tokens, rounded up to 0.01 —
  // double the invoice. Refused at the default 1% allowance.
  assert.throws(() => createQuote(coarse, NOW), /granularity is too coarse/);

  // A merchant who accepts that rounding can raise the allowance deliberately.
  const permitted = createQuote({ ...coarse, maxRoundingOverheadBps: 20_000 }, NOW);
  assert.equal(permitted.amountDue, 1n);
});

test('a non-positive ttl is refused', () => {
  assert.throws(
    () =>
      createQuote(
        {
          id: 'q_9',
          asset: USDT,
          mode: 'token',
          amountToken: 1n,
          spreadBps: 0,
          ttlMs: 0,
        },
        NOW,
      ),
    /ttlMs must be positive/,
  );
});

test('expiry stops new invoices at the boundary, not after it', () => {
  const quote = createQuote(
    {
      id: 'q_10',
      asset: USDT,
      mode: 'token',
      amountToken: 1n,
      spreadBps: 0,
      ttlMs: 60_000,
    },
    NOW,
  );

  assert.equal(isQuoteExpired(quote, NOW), false);
  assert.equal(isQuoteExpired(quote, NOW + 59_999), false);
  assert.equal(isQuoteExpired(quote, NOW + 60_000), true);

  assert.equal(canOpenInvoice(quote, NOW + 59_999), true);
  assert.equal(canOpenInvoice(quote, NOW + 60_000), false);

  assert.equal(quoteRemainingMs(quote, NOW), 60_000);
  assert.equal(quoteRemainingMs(quote, NOW + 90_000), 0, 'never reports negative time');
});

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';

import { PriceService } from '../PriceService.js';
import { rateFromDecimalString, rateToDecimalString } from '../rate.js';
import {
  ALL_PRICE_SOURCES,
  BinanceSource,
  BitstampSource,
  CoinGeckoSource,
  CoinbaseSource,
  KrakenSource,
  createPriceSources,
} from './index.js';
import type { PriceSymbol } from './types.js';

/**
 * The price sources, against the shapes the real services return.
 *
 * Every payload below was recorded from the live endpoint, because the failure this file exists
 * to prevent was invisible in a hand-written fixture: Binance kept answering `200` with a
 * perfectly well-formed body for a pair it had *stopped trading*, and the frozen figure inside
 * it was enough to make the checkout refuse a currency outright.
 */

/** Every symbol a merchant can invoice in. Kept literal so a new one fails this file first. */
const SYMBOLS: readonly PriceSymbol[] = ['ETH', 'BNB', 'POL', 'TRX', 'SOL', 'TON', 'USDT', 'USDC'];

/**
 * Sources required per symbol.
 *
 * `PRICE_MIN_SOURCES` is two, so two is not enough: two sources means any one of them having a
 * bad minute — a 429, a halt, a rate limit — takes the currency off the checkout. And two that
 * disagree cannot be told apart, since with no third opinion the median sits exactly between
 * them and both are equally far from it. Three is the smallest number that survives losing one.
 */
const MIN_SOURCES_PER_SYMBOL = 3;

describe('price source coverage', () => {
  const sources = createPriceSources(ALL_PRICE_SOURCES);

  for (const symbol of SYMBOLS) {
    test(`${symbol} is priced by at least ${MIN_SOURCES_PER_SYMBOL} sources`, () => {
      const supporting = sources.filter((source) => source.supports(symbol)).map((s) => s.name);
      assert.ok(
        supporting.length >= MIN_SOURCES_PER_SYMBOL,
        `${symbol} is priced only by ${supporting.join(', ') || 'nothing'}`,
      );
    });
  }
});

describe('Binance', () => {
  /**
   * TONUSDT as Binance served it on the day a merchant's checkout said TON had no trustworthy
   * price. `status` for the symbol was `BREAK` — trading halted — and the last trade behind
   * this `lastPrice` was over two months old. Note the empty book: that is the only thing in
   * the response that says so.
   */
  const HALTED = {
    symbol: 'TONUSDT',
    lastPrice: '1.60000000',
    bidPrice: '0.00000000',
    bidQty: '0.00000000',
    askPrice: '0.00000000',
    askQty: '0.00000000',
    volume: '4800378.41000000',
  };

  /** The same endpoint for a pair that is trading. */
  const TRADING = {
    symbol: 'ETHUSDT',
    lastPrice: '3025.41000000',
    bidPrice: '3025.40000000',
    bidQty: '12.30000000',
    askPrice: '3025.41000000',
    askQty: '4.10000000',
    volume: '210311.55100000',
  };

  let server: Server;
  let base: string;
  let body: unknown = TRADING;

  before(async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => server.close());

  test('a trading pair yields its last price', async () => {
    body = TRADING;
    const rate = await new BinanceSource(base).fetchUsdPrice('ETH');
    assert.equal(rateToDecimalString(rate, 2), '3025.41');
  });

  test('a halted market is refused, not reported as a price', async () => {
    body = HALTED;
    await assert.rejects(
      () => new BinanceSource(base).fetchUsdPrice('TON'),
      /not trading/,
      'a last price with no book behind it is weeks old and must not be quoted',
    );
  });

  test('the halted figure, had it been quoted, would have cost the merchant the currency', async () => {
    /**
     * This is the bug itself, reproduced. The frozen 1.60 was 16% away from where TON actually
     * traded. Two sources, one of them frozen: the median lands halfway between, *both* are
     * then further from it than the 200bps outlier tolerance, both are discarded, and the
     * checkout reports "no trustworthy price" — having had a perfectly good price all along.
     */
    const frozen = { ...HALTED, bidPrice: '1.59900000', askPrice: '1.60100000' };
    body = frozen;
    const poisoned = await new BinanceSource(base).fetchUsdPrice('TON');

    const service = new PriceService([
      { name: 'good', supports: () => true, fetchUsdPrice: async () => LIVE_TON },
      { name: 'frozen', supports: () => true, fetchUsdPrice: async () => poisoned },
    ]);

    const result = await service.getRate('TON');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'insufficient_sources');
  });

  test('a body without the price field fails rather than defaulting', async () => {
    body = { symbol: 'ETHUSDT', bidPrice: '1', askPrice: '1' };
    await assert.rejects(() => new BinanceSource(base).fetchUsdPrice('ETH'), /no price field/);
  });

  test('it does not price USDT, the asset every other pair is quoted in', () => {
    assert.equal(new BinanceSource().supports('USDT'), false);
  });
});

describe('the USD sources, on the payloads they really return', () => {
  /**
   * TON, recorded from all four within the same minute: CoinGecko 1.3790976, Kraken 1.3790,
   * Coinbase 1.37975, Bitstamp 1.38060. Four independent opinions inside 12bps — which is what
   * the merchant's checkout should have had, and now does.
   */
  const RESPONSES: Record<string, unknown> = {
    '/simple/price': { 'the-open-network': { usd: 1.3790976204793475 } },
    '/Ticker': { error: [], result: { TONUSD: { c: ['1.3790000', '206.25000'] } } },
    '/prices/TON-USD/spot': { data: { amount: '1.37975', base: 'TON', currency: 'USD' } },
    '/ticker/tonusd/': { last: '1.38060', bid: '1.37798', ask: '1.37898' },
  };

  let server: Server;
  let base: string;

  before(async () => {
    server = createServer((request, response) => {
      const path = (request.url ?? '').split('?')[0]!;
      const key = Object.keys(RESPONSES).find((prefix) => path.endsWith(prefix));
      response.writeHead(key ? 200 : 404, { 'content-type': 'application/json' });
      response.end(JSON.stringify(key ? RESPONSES[key] : { error: 'unknown path' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => server.close());

  test('all four agree on TON to within a few basis points', async () => {
    const sources = [
      new CoinGeckoSource(base),
      new KrakenSource(base),
      new CoinbaseSource(base),
      new BitstampSource(base),
    ];

    for (const source of sources) {
      assert.equal(source.supports('TON'), true, `${source.name} should price TON`);
    }

    const service = new PriceService(sources);
    const result = await service.getRate('TON');
    assert.ok(result.ok, result.ok === false ? result.detail : '');
    assert.equal(rateToDecimalString(result.rate, 4), '1.3794');
    assert.equal(result.sources.length, 4);
    assert.ok(result.dispersionBps <= 20, `${result.dispersionBps}bps apart`);
  });

  test('Kraken’s own pair naming does not have to match the one asked for', async () => {
    // It answers `XETHZUSD` for ETH and `TONUSD` for TON; the single entry is taken as given.
    const rate = await new KrakenSource(base).fetchUsdPrice('TON');
    assert.equal(rateToDecimalString(rate, 3), '1.379');
  });

  test('a symbol a source does not price is refused, never guessed at', async () => {
    // Binance quotes everything in USDT, so it cannot price USDT — and says so rather than
    // returning 1, which would be a made-up figure dressed as an observation.
    await assert.rejects(() => new BinanceSource(base).fetchUsdPrice('USDT'), /does not price/);
  });
});

/** TON at 1.3790976, as CoinGecko reported it in the same minute. */
const LIVE_TON = rateFromDecimalString('1.379097620479', Date.now());

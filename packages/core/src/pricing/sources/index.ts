import { rateFromDecimalString, type Rate } from '../rate.js';
import {
  PriceSourceError,
  UnsupportedSymbolError,
  fetchJson,
  type PriceSource,
  type PriceSymbol,
} from './types.js';

export * from './types.js';

/**
 * CoinGecko. The broadest coverage of the three, and the only one that prices
 * every asset we support, including the stablecoins themselves.
 */
export class CoinGeckoSource implements PriceSource {
  readonly name = 'coingecko';

  private static readonly IDS: Partial<Record<PriceSymbol, string>> = {
    ETH: 'ethereum',
    BNB: 'binancecoin',
    POL: 'polygon-ecosystem-token',
    TRX: 'tron',
    SOL: 'solana',
    TON: 'the-open-network',
    USDT: 'tether',
    USDC: 'usd-coin',
  };

  constructor(private readonly baseUrl = 'https://api.coingecko.com/api/v3') {}

  supports(symbol: PriceSymbol): boolean {
    return CoinGeckoSource.IDS[symbol] !== undefined;
  }

  async fetchUsdPrice(symbol: PriceSymbol, signal?: AbortSignal): Promise<Rate> {
    const id = CoinGeckoSource.IDS[symbol];
    if (!id) throw new UnsupportedSymbolError(this.name, symbol);

    const body = (await fetchJson(
      this.name,
      `${this.baseUrl}/simple/price?ids=${id}&vs_currencies=usd&precision=full`,
      signal,
    )) as Record<string, { usd?: number } | undefined>;

    const price = body[id]?.usd;
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
      throw new PriceSourceError(this.name, `no usable usd price for ${symbol}`);
    }

    // This source returns JSON numbers, so a float is unavoidable at the boundary.
    // Converting through a fixed-precision string immediately keeps the imprecision
    // from propagating into the integer arithmetic downstream.
    return rateFromDecimalString(price.toFixed(12), Date.now());
  }
}

/**
 * Binance spot. Fast and liquid, but every pair is quoted in USDT rather than
 * dollars, so its figures are USD *approximations* — sound for a major asset,
 * which is why it does not attempt to price USDT itself.
 */
export class BinanceSource implements PriceSource {
  readonly name = 'binance';

  private static readonly PAIRS: Partial<Record<PriceSymbol, string>> = {
    ETH: 'ETHUSDT',
    BNB: 'BNBUSDT',
    POL: 'POLUSDT',
    TRX: 'TRXUSDT',
    SOL: 'SOLUSDT',
    TON: 'TONUSDT',
    USDC: 'USDCUSDT',
  };

  constructor(private readonly baseUrl = 'https://api.binance.com/api/v3') {}

  supports(symbol: PriceSymbol): boolean {
    return BinanceSource.PAIRS[symbol] !== undefined;
  }

  async fetchUsdPrice(symbol: PriceSymbol, signal?: AbortSignal): Promise<Rate> {
    const pair = BinanceSource.PAIRS[symbol];
    if (!pair) throw new UnsupportedSymbolError(this.name, symbol);

    const body = (await fetchJson(
      this.name,
      `${this.baseUrl}/ticker/price?symbol=${pair}`,
      signal,
    )) as { price?: string };

    if (typeof body.price !== 'string') {
      throw new PriceSourceError(this.name, `no price field for ${pair}`);
    }
    // Already a decimal string — parsed straight into integer form.
    return rateFromDecimalString(body.price, Date.now());
  }
}

/**
 * Kraken. Included specifically because it quotes genuine USD pairs, including
 * USDT/USD — which is the one price a stablecoin gateway most wants a second
 * opinion on.
 */
export class KrakenSource implements PriceSource {
  readonly name = 'kraken';

  private static readonly PAIRS: Partial<Record<PriceSymbol, string>> = {
    ETH: 'XETHZUSD',
    SOL: 'SOLUSD',
    TRX: 'TRXUSD',
    USDT: 'USDTZUSD',
    USDC: 'USDCUSD',
  };

  constructor(private readonly baseUrl = 'https://api.kraken.com/0/public') {}

  supports(symbol: PriceSymbol): boolean {
    return KrakenSource.PAIRS[symbol] !== undefined;
  }

  async fetchUsdPrice(symbol: PriceSymbol, signal?: AbortSignal): Promise<Rate> {
    const pair = KrakenSource.PAIRS[symbol];
    if (!pair) throw new UnsupportedSymbolError(this.name, symbol);

    const body = (await fetchJson(
      this.name,
      `${this.baseUrl}/Ticker?pair=${pair}`,
      signal,
    )) as { error?: string[]; result?: Record<string, { c?: string[] }> };

    if (body.error && body.error.length > 0) {
      throw new PriceSourceError(this.name, body.error.join('; '));
    }

    // Kraken keys the result by its own canonical pair name, which does not always
    // match the one requested, so take the single entry rather than guessing.
    const entry = Object.values(body.result ?? {})[0];
    const last = entry?.c?.[0];
    if (typeof last !== 'string') {
      throw new PriceSourceError(this.name, `no last-trade price for ${pair}`);
    }
    return rateFromDecimalString(last, Date.now());
  }
}

export type PriceSourceName = 'coingecko' | 'binance' | 'kraken';

const FACTORIES: Record<PriceSourceName, () => PriceSource> = {
  coingecko: () => new CoinGeckoSource(),
  binance: () => new BinanceSource(),
  kraken: () => new KrakenSource(),
};

export const ALL_PRICE_SOURCES: readonly PriceSourceName[] = ['coingecko', 'binance', 'kraken'];

/**
 * Build the configured source set.
 *
 * Which sources are enabled is configuration, not code, because reachability
 * varies by deployment: an exchange that is unreachable from where the service
 * runs would fail every request and hold the circuit breaker open, blocking
 * invoices for a reason that has nothing to do with the market. Swapping one out
 * must not require a release.
 */
export function createPriceSources(names: readonly string[]): readonly PriceSource[] {
  const sources = names.map((name) => {
    const factory = FACTORIES[name as PriceSourceName];
    if (!factory) {
      throw new Error(
        `unknown price source "${name}"; known sources: ${ALL_PRICE_SOURCES.join(', ')}`,
      );
    }
    return factory();
  });

  if (sources.length === 0) throw new Error('at least one price source is required');
  return sources;
}

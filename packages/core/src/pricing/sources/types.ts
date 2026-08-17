import type { Rate } from '../rate.js';

/**
 * Canonical asset symbols the pricing engine knows about.
 *
 * Deliberately separate from any source's own naming: CoinGecko wants
 * `the-open-network`, Binance wants `TONUSDT`, Kraken wants `XETHZUSD`. Mapping
 * lives inside each source so the rest of the system speaks one vocabulary.
 */
export type PriceSymbol =
  | 'ETH'
  | 'BNB'
  | 'POL'
  | 'TRX'
  | 'SOL'
  | 'TON'
  | 'USDT'
  | 'USDC';

export interface PriceSource {
  readonly name: string;
  /** Symbols this source can price. Anything else is refused, not guessed at. */
  supports(symbol: PriceSymbol): boolean;
  /** USD price for one whole unit. Throws on failure; the aggregator records it. */
  fetchUsdPrice(symbol: PriceSymbol, signal?: AbortSignal): Promise<Rate>;
}

export class UnsupportedSymbolError extends Error {
  constructor(source: string, symbol: string) {
    super(`${source} does not price ${symbol}`);
    this.name = 'UnsupportedSymbolError';
  }
}

export class PriceSourceError extends Error {
  constructor(source: string, detail: string) {
    super(`${source}: ${detail}`);
    this.name = 'PriceSourceError';
  }
}

/** Per-source request timeout. A slow source must not hold up the others. */
export const SOURCE_TIMEOUT_MS = 4000;

export async function fetchJson(
  source: string,
  url: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(SOURCE_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetch(url, { signal: combined, headers: { accept: 'application/json' } });
  } catch (error) {
    throw new PriceSourceError(
      source,
      error instanceof Error ? error.message : 'request failed',
    );
  }

  if (!response.ok) throw new PriceSourceError(source, `HTTP ${response.status}`);
  return response.json();
}

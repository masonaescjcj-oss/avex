import type { PriceSymbol } from '@avex/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { formatRateUsd } from '../../domain/price-repository.js';
import { UnauthenticatedError } from '../principal.js';
import type { AppContext } from '../server.js';

const SYMBOLS = ['ETH', 'BNB', 'POL', 'TRX', 'SOL', 'TON', 'USDT', 'USDC'] as const;

const querySchema = z.object({
  symbols: z
    .string()
    .optional()
    .transform((value) =>
      value === undefined
        ? [...SYMBOLS]
        : value
            .split(',')
            .map((entry) => entry.trim().toUpperCase())
            .filter((entry): entry is PriceSymbol =>
              (SYMBOLS as readonly string[]).includes(entry),
            ),
    ),
});

export function registerPriceRoutes(app: FastifyInstance, context: AppContext): void {
  /**
   * Current rates, with the state of each asset's circuit breaker.
   *
   * Reports a suspended asset explicitly rather than omitting it or falling back
   * to a stale figure: a checkout that cannot price an asset needs to say so, and
   * an operator needs to see which feed is unhealthy.
   */
  app.get('/v1/prices', async (request, reply) => {
    if (!request.principal) throw new UnauthenticatedError();
    const { symbols } = querySchema.parse(request.query);

    const rows = await Promise.all(
      symbols.map(async (symbol) => {
        const result = await context.prices.getRate(symbol);

        if (!result.ok) {
          return {
            symbol,
            available: false as const,
            reason: result.reason,
            detail: result.detail,
            breaker: {
              state: result.breaker.state,
              consecutiveFailures: result.breaker.consecutiveFailures,
              retryAt:
                result.breaker.retryAt === null
                  ? null
                  : new Date(result.breaker.retryAt).toISOString(),
            },
            rejectedSources: result.rejected,
          };
        }

        return {
          symbol,
          available: true as const,
          usd: formatRateUsd(result.rate),
          observedAt: new Date(result.rate.observedAt).toISOString(),
          sources: result.sources,
          dispersionBps: result.dispersionBps,
          cached: result.cached,
        };
      }),
    );

    return reply.send({ data: rows });
  });

  /** Coverage map — which configured sources can price which asset. */
  app.get('/v1/prices/coverage', async (request, reply) => {
    if (!request.principal) throw new UnauthenticatedError();

    const coverage = context.prices.coverage();
    return reply.send({
      data: SYMBOLS.map((symbol) => ({
        symbol,
        sources: coverage.get(symbol) ?? [],
        // Below the aggregation minimum, this asset can never be priced. Better
        // surfaced here than discovered as a stream of failed quotes.
        sufficient: (coverage.get(symbol) ?? []).length >= context.minPriceSources,
      })),
      suspended: context.prices.suspendedSymbols(),
    });
  });
}

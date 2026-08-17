import {
  ContractProbe,
  DEFAULT_BREAKER,
  PriceService,
  createPriceSources,
} from '@avex/core';

import { createDatabase } from './db/client.js';
import { AuditService } from './domain/audit.js';
import { AssetService } from './domain/asset-service.js';
import { AuthService } from './domain/auth-service.js';
import { PayoutAddressService } from './domain/payout-service.js';
import { PriceTickWriter } from './domain/price-repository.js';
import { loadEnv } from './env.js';
import { buildServer } from './http/server.js';
import { JsonRpcCaller } from './rpc/json-rpc-caller.js';
import { ConsoleMailer } from './mailer.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const { db, close } = createDatabase(env.DATABASE_URL);

  const audit = new AuditService(db);
  const auth = new AuthService(db, audit, {
    sessionTtlMs: env.SESSION_TTL_HOURS * 60 * 60 * 1000,
    emailTokenTtlMs: env.EMAIL_TOKEN_TTL_MINUTES * 60 * 1000,
  });

  // Every observation is buffered and flushed, never awaited inline: storage
  // latency must not sit on the checkout path.
  // console rather than app.log: the writer is constructed before the server, and
  // capturing `app` here would be a use-before-initialisation waiting to happen.
  const tickWriter = new PriceTickWriter(db, 5_000, 5_000, (message) =>
    console.warn(message),
  );
  tickWriter.start();

  const prices = new PriceService(
    createPriceSources(env.PRICE_SOURCES),
    {
      aggregation: {
        minSources: env.PRICE_MIN_SOURCES,
        outlierToleranceBps: env.PRICE_OUTLIER_TOLERANCE_BPS,
        maxDispersionBps: env.PRICE_MAX_DISPERSION_BPS,
        maxStalenessMs: env.PRICE_MAX_STALENESS_MS,
      },
      breaker: DEFAULT_BREAKER,
      cacheTtlMs: env.PRICE_CACHE_TTL_MS,
    },
    (tick) => tickWriter.record(tick),
  );

  const pricedSymbols = [...prices.coverage().keys()];
  const assetService = new AssetService(
    db,
    audit,
    new ContractProbe(new JsonRpcCaller(env.EVM_RPC_URLS)),
    pricedSymbols,
  );

  const seeded = await assetService.seedCurated();

  const mailer = new ConsoleMailer(env.APP_URL);
  const payouts = new PayoutAddressService(db, audit, mailer);

  // Scheduled payout changes take effect on a timer rather than on the next
  // request, so a merchant who stops using the dashboard still gets the change
  // they asked for.
  const payoutWorker = setInterval(() => {
    void payouts
      .applyDueChanges()
      .then((count) => {
        if (count > 0) app.log.info({ count }, 'applied scheduled payout changes');
      })
      .catch((error: unknown) => app.log.error({ err: error }, 'payout worker failed'));
  }, 60_000);
  payoutWorker.unref();

  const app = buildServer({
    env,
    db,
    auth,
    audit,
    prices,
    assets: assetService,
    payouts,
    minPriceSources: env.PRICE_MIN_SOURCES,
    // Phase 6 replaces this with a real transport; the seam is what matters now.
    mailer,
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    // Flush buffered ticks before the pool goes away.
    await tickWriter.stop();
    await close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info({ seeded }, 'curated asset catalogue synchronised');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

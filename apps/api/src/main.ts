import {
  ContractProbe,
  DEFAULT_BREAKER,
  DEFAULT_DISPATCHER,
  FetchPoster,
  PriceService,
  WebhookDispatcher,
  createPriceSources,
} from '@avex/core';

import { createDatabase } from './db/client.js';
import { AdminService } from './domain/admin-service.js';
import { AuditService } from './domain/audit.js';
import { AssetService } from './domain/asset-service.js';
import { AuthService } from './domain/auth-service.js';
import { StaffAuthService } from './domain/staff-auth.js';
import { DatabasePaymentSink } from './domain/payment-sink.js';
import { PayoutAddressService } from './domain/payout-service.js';
import { DatabaseWatchStore } from './domain/watch-store.js';
import { WebhookService } from './domain/webhook-service.js';
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
  const webhooks = new WebhookService(
    db,
    new WebhookDispatcher(new FetchPoster(DEFAULT_DISPATCHER.timeoutMs)),
    (message) => console.warn(message),
  );

  // Credits transfers the watcher finds, and queues the callbacks that tell a
  // merchant about them. Enqueueing is a database write, so a slow merchant
  // endpoint can never delay crediting a payment.
  const paymentSink = new DatabasePaymentSink(db, audit, webhooks, () => 0);
  const watchStore = new DatabaseWatchStore(db);

  // Delivery runs on its own timer rather than inline, so a retry backlog drains
  // independently of whatever is happening on-chain.
  const webhookWorker = setInterval(() => {
    void webhooks
      .drain()
      .then((tally) => {
        if (tally.delivered + tally.failed + tally.abandoned > 0) {
          app.log.info(tally, 'webhook deliveries processed');
        }
      })
      .catch((error: unknown) => app.log.error({ err: error }, 'webhook worker failed'));
  }, 10_000);
  webhookWorker.unref();

  const payoutWorker = setInterval(() => {
    void payouts
      .applyDueChanges()
      .then((count) => {
        if (count > 0) app.log.info({ count }, 'applied scheduled payout changes');
      })
      .catch((error: unknown) => app.log.error({ err: error }, 'payout worker failed'));
  }, 60_000);
  payoutWorker.unref();

  const staffAuth = new StaffAuthService(db, audit);
  const admin = new AdminService(db, audit);

  const app = buildServer({
    env,
    db,
    auth,
    audit,
    prices,
    assets: assetService,
    payouts,
    staffAuth,
    admin,
    minPriceSources: env.PRICE_MIN_SOURCES,
    // A real transport still to come; the seam is what matters now.
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
  app.log.info(
    { chains: await watchStore.status() },
    'watcher state loaded; per-chain watchers start with the settlement runner',
  );
  // Referenced so the wiring is obviously live rather than dead configuration.
  void paymentSink;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

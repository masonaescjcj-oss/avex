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
import type { ChainId } from '@avex/core';
import {
  EVM_CHAIN_IDS,
  EvmChainSigner,
  LocalKeyProvider,
  evmChainId,
} from '@avex/core';

import { AdminService } from './domain/admin-service.js';
import { MerchantService } from './domain/merchant-service.js';
import { CheckoutService } from './domain/checkout-service.js';
import { DepositAddressDeriver } from './domain/deposit-address.js';
import { InvoiceCreationService } from './domain/invoice-creation.js';
import { SubscriptionService } from './domain/subscription-service.js';
import { AuditService } from './domain/audit.js';
import { AssetService } from './domain/asset-service.js';
import { AuthService } from './domain/auth-service.js';
import { StaffAuthService } from './domain/staff-auth.js';
import { DatabasePaymentSink } from './domain/payment-sink.js';
import { ReconciliationService } from './domain/reconciliation-service.js';
import { SettlementStore } from './domain/settlement-store.js';
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

  /**
   * Billing runs hourly rather than daily.
   *
   * Hourly means a period that ended is charged within the hour, so grace windows and
   * status changes are close to the truth whenever anyone looks. It is safe to run this
   * often because the unique index on (subscription, period start) makes a repeated run
   * a no-op rather than a double charge.
   */
  const billingWorker = setInterval(() => {
    void subscriptions
      .runBilling()
      .then((report) => {
        if (report.charged > 0 || report.markedUnpaid > 0) {
          app.log.info(report, 'billing run complete');
        }
      })
      .catch((error: unknown) => app.log.error({ err: error }, 'billing worker failed'));
  }, 60 * 60_000);
  billingWorker.unref();

  const payoutWorker = setInterval(() => {
    void payouts
      .applyDueChanges()
      .then((count) => {
        if (count > 0) app.log.info({ count }, 'applied scheduled payout changes');
      })
      .catch((error: unknown) => app.log.error({ err: error }, 'payout worker failed'));
  }, 60_000);
  payoutWorker.unref();

  const subscriptions = new SubscriptionService(db, audit, {
    feeCollectors: env.FEE_COLLECTORS,
  });

  /**
   * Address derivation, built from configuration alone.
   *
   * Every EVM chain shares one creation code because they run identical bytecode; the
   * factory address differs because each chain has its own deployment. A chain absent
   * from `FORWARDER_FACTORIES` simply cannot issue invoices, which is the safe
   * direction — a defaulted factory would hand payers addresses no CREATE2 produces.
   */
  const deriver = new DepositAddressDeriver(
    {
      evm: Object.fromEntries(
        Object.entries(env.FORWARDER_FACTORIES).map(([chain, factory]) => [
          chain,
          { factory, forwarderCreationCode: env.FORWARDER_CREATION_CODE },
        ]),
      ),
      shared: env.SHARED_DEPOSIT_WALLETS,
    },
    env.MEMO_SECRET,
  );

  const invoiceCreation = new InvoiceCreationService(
    db,
    deriver,
    subscriptions,
    // The pricing engine, narrowed to the one method invoice creation needs.
    { requireRate: (symbol) => prices.requireRate(symbol) },
    audit,
  );

  const staffAuth = new StaffAuthService(db, audit);
  const settlementStore = new SettlementStore(db);
  const reconciliation = new ReconciliationService(db, audit, paymentSink);
  const admin = new AdminService(db, audit, settlementStore, reconciliation);

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
    settlements: settlementStore,
    reconciliation,
    merchant: new MerchantService(db),
    invoiceCreation,
    checkouts: new CheckoutService(
      db,
      invoiceCreation,
      subscriptions,
      deriver,
      { requireRate: (symbol) => prices.requireRate(symbol) },
      audit,
    ),
    webhooks,
    subscriptions,
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

  /**
   * Settlement signers, one per configured EVM chain.
   *
   * Built here rather than lazily so a misconfigured key stops the process at startup.
   * The alternative — discovering it when the first settlement runs — means a merchant
   * has already been told their payment succeeded.
   *
   * When no key is configured the map is empty and the runner simply has nothing to
   * sign with: the gateway still accepts payments and credits invoices, it just does
   * not move funds out of forwarders. That is a deliberate, visible degradation rather
   * than a crash, because a missing settlement key must not stop the checkout.
   */
  const signers = new Map<string, EvmChainSigner>();
  if (env.SETTLEMENT_KEY_HEX) {
    const keys = new LocalKeyProvider(env.SETTLEMENT_KEY_HEX, { environment: env.NODE_ENV });

    for (const [chain, urls] of Object.entries(env.EVM_RPC_URLS)) {
      if (!(chain in EVM_CHAIN_IDS) || urls.length === 0) continue;

      // One caller per chain, reusing the endpoint pool's fallback and timeouts.
      const caller = new JsonRpcCaller({ [chain]: urls }, chain as ChainId);
      const signer = new EvmChainSigner(
        { call: (method, params) => caller.request(method, params) },
        keys,
        { chainId: evmChainId(chain), priorityFraction: env.SETTLEMENT_PRIORITY_FRACTION },
      );
      // Resolves the address, which is also the first proof the provider works.
      await signer.initialise();
      signers.set(chain, signer);
    }
  }

  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info({ seeded }, 'curated asset catalogue synchronised');
  app.log.info(
    { chains: await watchStore.status() },
    'watcher state loaded; per-chain watchers start with the settlement runner',
  );

  if (signers.size === 0) {
    app.log.warn(
      'no settlement signer is configured: payments will be credited but funds will not be ' +
        'swept out of forwarders. Set SETTLEMENT_KEY_HEX for development, or supply a ' +
        'KMS-backed KeyProvider in production.',
    );
  } else {
    for (const [chain, signer] of signers) {
      const [balance, nonce] = await Promise.all([signer.balanceWei(), signer.pendingNonce()]);
      app.log.info(
        { chain, address: signer.address, balanceWei: balance.toString(), nonce },
        'settlement signer ready',
      );
    }
  }

  // Referenced so the wiring is obviously live rather than dead configuration.
  void paymentSink;
  void settlementStore;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

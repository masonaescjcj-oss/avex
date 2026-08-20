
import { createDatabase } from './db/client.js';
import type { ChainId } from '@avex/core';
import {
  EVM_CHAIN_IDS,
  EvmChainSigner,
  LocalKeyProvider,
  evmChainId,
} from '@avex/core';

import { DatabaseWatchStore } from './domain/watch-store.js';
import { PriceTickWriter } from './domain/price-repository.js';
import { loadEnv } from './env.js';
import { compose } from './compose.js';
import { startJobTimers } from './jobs.js';
import { JsonRpcCaller } from './rpc/json-rpc-caller.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const { db, close, prepare } = createDatabase(env.DATABASE_URL, {
    prepare: env.DATABASE_PREPARE,
  });

  /**
   * Every observation is buffered and flushed, never awaited inline: storage latency must
   * not sit on the checkout path.
   *
   * console rather than app.log: the writer is constructed before the server, and capturing
   * `app` here would be a use-before-initialisation waiting to happen.
   */
  const tickWriter = new PriceTickWriter(db, 5_000, 5_000, (message) => console.warn(message));
  tickWriter.start();

  /**
   * The service graph, from the one place that defines it.
   *
   * `compose` is shared with the serverless entry point, so anything added there appears
   * here too — the alternative was two copies of a twenty-service wiring, where the second
   * is missing whatever was added last.
   */
  const { app, context } = compose({
    env,
    db,
    recordTick: (tick) => tickWriter.record(tick),
  });

  const seeded = await context.assets.seedCurated();

  /**
   * The jobs, on timers, unless a scheduler is driving them from outside.
   *
   * Started after the server so failures log through `app.log` rather than the console, and
   * stopped before it closes so a tick cannot fire against a pool that is going away.
   */
  const stopJobs = env.RUN_JOBS_IN_PROCESS
    ? startJobTimers(
        {
          db,
          webhooks: context.webhooks,
          feePlans: context.feePlans,
          payouts: context.payouts,
        },
        app.log,
      )
    : () => {};

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    stopJobs();
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
  /**
   * Said out loud, because a misdiagnosed pooler is otherwise invisible until the first
   * prepared statement fails — and that error names nothing in this codebase.
   */
  app.log.info(
    {
      preparedStatements: prepare,
      jobs: env.RUN_JOBS_IN_PROCESS ? 'in-process timers' : 'external scheduler',
      schedulerHook: env.CRON_SECRET === undefined ? 'closed' : 'open',
    },
    'database and scheduler configuration',
  );
  /**
   * The watcher's stored position, and an honest statement about what is driving it.
   *
   * Nothing, in this process. `Watcher` and `SettlementRunner` exist in @avex/core with
   * their own tests, and nothing here instantiates them — so payments are credited only by
   * the reconciliation path an operator triggers, and funds are not swept at all. The
   * previous version of this line said watchers "start with the settlement runner", which
   * read as a description of something happening.
   */
  const watchStore = new DatabaseWatchStore(db);
  app.log.info(
    { chains: await watchStore.status(), driver: 'none' },
    'watcher cursors loaded; no watcher loop runs in this process yet',
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
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

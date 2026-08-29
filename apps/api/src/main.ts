
import { createDatabase } from './db/client.js';
import { DatabaseWatchStore } from './domain/watch-store.js';
import { PriceTickWriter } from './domain/price-repository.js';
import { loadEnv } from './env.js';
import { compose } from './compose.js';
import { startJobTimers } from './jobs.js';

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
          walletChanges: context.walletChanges,
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
   * No settlement signer here, deliberately.
   *
   * This process does not settle — the watcher does, and it builds its own signers from
   * `startSettlement`. What used to be here was a signer per chain, constructed to read a
   * balance and a nonce for one startup log line and then discarded.
   *
   * Removing it takes the settlement key out of this process entirely, which is the point: the
   * key is a gas wallet somebody could drain, and two processes holding it is twice the surface
   * for a log line. The figure it produced is now reported continuously by the watcher's own
   * gas check, which alerts on it rather than printing it once at a moment nobody is reading.
   *
   * That is also why the unit files hand `SETTLEMENT_KEY_FILE` only to `avex-watcher`.
   */

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

  /**
   * Whether anything settles is the watcher's business, and it says so at its own startup.
   *
   * Named here anyway, because "the API is up" is the line an operator reads first and
   * "payments are credited but nothing is moved" is the state they most need not to assume
   * away. It is a fact about the deployment, not a complaint about this process.
   */
  app.log.info(
    { settles: env.SETTLEMENT_KEY_FILE !== undefined || env.SETTLEMENT_KEY_HEX !== undefined },
    'settlement runs in the watcher process, not this one',
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

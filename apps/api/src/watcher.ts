import {
  DEFAULT_BREAKER,
  DEFAULT_DISPATCHER,
  DEFAULT_WATCHER,
  EVM_CHAIN_IDS,
  EvmAdapter,
  FetchPoster,
  PriceService,
  TronAdapter,
  Watcher,
  WebhookDispatcher,
  SUPPORTED_CHAINS,
  chainConfig,
  createPriceSources,
} from '@avex/core';
import type { Asset, ChainAdapter, ChainId } from '@avex/core';

import { createDatabase } from './db/client.js';
import { JOB_LOCKS, withJobLock } from './db/lock.js';
import { DatabaseAddressBook } from './domain/address-book.js';
import { AssetService } from './domain/asset-service.js';
import { AuditService } from './domain/audit.js';
import { CommissionLedger } from './domain/commission-ledger.js';
import { DatabasePaymentSink } from './domain/payment-sink.js';
import { paymentValueSource, paymentValueUsd } from './domain/payment-valuation.js';
import { DatabaseWatchStore } from './domain/watch-store.js';
import { WebhookService } from './domain/webhook-service.js';
import { loadEnv } from './env.js';
import { JsonRpcCaller } from './rpc/json-rpc-caller.js';
import { startSettlement } from './settle/start.js';
import { DEFAULT_LOOP, runLoop } from './watch/loop.js';
import { watchableChains } from './watch/watchable-chains.js';
import type { LoopHandle } from './watch/loop.js';

/**
 * The chain watcher, as its own process.
 *
 * Separate from the API on purpose, and the reason is not tidiness. This is the only part of
 * the system that cannot be serverless: it holds a cursor per chain that has to advance
 * monotonically, it rewinds that cursor when a reorg is found, and it is the thing that
 * decides a payment happened. A runtime that scales to zero between requests can do none of
 * that — the cursor would be reloaded from the database on every invocation, which is
 * survivable, but two invocations overlapping would scan the same range twice and race each
 * other's cursor writes.
 *
 * So: one process, one lock, per chain. The lock is what makes "one process" true rather
 * than merely intended — two copies started by a deploy that forgot to stop the old one is
 * the ordinary way this goes wrong, and the second one skips instead of double-scanning.
 *
 * What this process does *not* do is serve HTTP. It shares the database with the API and
 * nothing else; a payment credited here reaches a merchant through the webhook rows it
 * writes, which the API's own scheduler drains.
 */

/** Throws if anything ever asks it to vet a contract. Nothing here does. */
const probeStub = {
  async probe(): Promise<never> {
    throw new Error('the watcher does not vet contracts');
  },
} as unknown as ConstructorParameters<typeof AssetService>[2];

async function main(): Promise<void> {
  const env = loadEnv();
  const { db, close, prepare } = createDatabase(env.DATABASE_URL, {
    prepare: env.DATABASE_PREPARE,
    // Two per chain is plenty: this process makes long, sequential passes rather than
    // serving concurrent requests, and connections are the scarce thing behind a pooler.
    max: 4,
  });

  const log = (message: string, data?: unknown): void => {
    console.log(JSON.stringify({ at: new Date().toISOString(), message, ...(data ?? {}) }));
  };

  const audit = new AuditService(db);
  const webhooks = new WebhookService(
    db,
    new WebhookDispatcher(new FetchPoster(DEFAULT_DISPATCHER.timeoutMs)),
    (message) => log('webhook warning', { detail: message }),
  );

  /**
   * The sink credits payments and queues the callbacks that announce them.
   *
   * It does not deliver them: enqueueing is a database write, so a merchant whose endpoint
   * is slow can never delay a payment being credited. Delivery is the API's job, on its own
   * clock.
   */
  /**
   * Prices, because this process is the one that decides what a payment was worth.
   *
   * It passed `() => 0` before, and that zero reached three decisions: how many confirmations to
   * wait for (value-scaled, so every payment took the shallow count), what to record as the
   * merchant's assessed volume (so the fee ladder could never move), and now the commission
   * accrued on chains where no cut is taken on chain (so the fee would never be charged). None
   * of the three failed visibly.
   *
   * Its own `PriceService` rather than a reader of `price_ticks`: those are written as an audit
   * aid and explicitly not a source of truth. Cached, so a busy block does not become one
   * outbound request per transfer.
   */
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
  );

  /**
   * The ledger, so a payment on a pooled chain charges the commission it agreed to.
   *
   * This process credits pooled payments, so this process is where the accrual has to happen —
   * the API never sees the transfer. It cannot recover a balance (that happens at invoice
   * creation) and it never needs to: an accrual is a write, not a decision.
   */
  const ledger = new CommissionLedger(db);

  const sink = new DatabasePaymentSink(
    db,
    audit,
    webhooks,
    paymentValueUsd(prices),
    paymentValueSource(),
    ledger,
  );
  const state = new DatabaseWatchStore(db);
  /**
   * The asset service, for reading the catalogue and nothing else.
   *
   * The probe is a stub that throws: this process never vets a contract, and passing a real
   * one would leave a prober wired up that could quietly make RPC calls nobody asked for.
   * Cast at this one line rather than by inventing a fake that satisfies the shape, so the
   * narrowness is visible here instead of hidden in a class.
   */
  const assetService = new AssetService(db, audit, probeStub, []);

  const chains = watchableChains(env);
  if (chains.length === 0) {
    /**
     * Exit rather than idle.
     *
     * A watcher process with nothing to watch looks identical to a healthy one from the
     * outside, and the deployment it belongs to would go on believing payments were being
     * detected. Failing at startup is the only version of this that gets noticed.
     */
    throw new Error(
      'no chain is watchable: needs EVM_RPC_URLS and FORWARDER_FACTORIES for at least one ' +
        'EVM chain',
    );
  }

  /**
   * The catalogue, read once at startup.
   *
   * Deliberately not re-read on every poll: `acceptedAssets` decides which contracts count
   * as payments, and a set that changes underneath a scan means the same block is interpreted
   * two different ways depending on when it was read. Adding a token is a restart, which is
   * cheap and obvious. Never auto-crediting an unknown contract is the whole point — a
   * worthless clone named USDT must not become revenue.
   */
  const catalogue = await assetService.catalogue();
  const acceptedFor = (chain: ChainId): readonly Asset[] =>
    catalogue
      .filter((row) => row.chain === chain && row.listed && row.verdict === 'approved')
      .map((row) => ({
        symbol: row.symbol,
        chain,
        decimals: row.decimals,
        kind: row.kind as Asset['kind'],
        ...(row.contract === null ? {} : { contract: row.contract }),
      }));

  const handles: LoopHandle[] = [];
  /**
   * The adapters, kept as they are built.
   *
   * Settlement needs the same one the watcher uses — it is what turns a batch of invoices into
   * a transaction — and building a second would mean two objects with two ideas of which
   * contracts count as payments.
   */
  const adapters = new Map<ChainId, ChainAdapter>();

  for (const chain of chains) {
    const urls = env.EVM_RPC_URLS[chain]!;
    const caller = new JsonRpcCaller({ [chain]: urls }, chain);

    const accepted = acceptedFor(chain);
    if (accepted.length === 0) {
      // Said rather than skipped silently: a chain with an RPC and a factory but no listed
      // asset will find nothing, forever, and look exactly like a quiet chain.
      log('chain has no listed approved asset; nothing to watch on it', { chain });
      continue;
    }

    /**
     * One adapter per address model, chosen from the registry rather than by chain name.
     *
     * A pooled chain has no forwarder factory and no signer to pass, so handing it the EVM
     * adapter would mean inventing both — and the first thing that would do is derive deposit
     * addresses nobody owns and then look for payments to them.
     */
    const pooled = chainConfig(chain).addressModel === 'pooled';
    const adapter = pooled
      ? new TronAdapter(
          {
            chain,
            rpcUrl: urls[0]!,
            acceptedAssets: accepted,
            pollRange: DEFAULT_WATCHER.maxBlocksPerPoll,
          },
          { nativePriceUsd: async () => 0 },
          new DatabaseAddressBook(db, chain),
        )
      : new EvmAdapter(
          {
            chain,
            rpcUrl: urls[0]!,
            create2: {
              factory: env.FORWARDER_FACTORIES[chain]!,
              implementation: env.FORWARDER_IMPLEMENTATIONS[chain]!,
            },
            acceptedAssets: accepted,
            pollRange: DEFAULT_WATCHER.maxBlocksPerPoll,
          },
          // Native price, for the gas model. Not consulted during a poll.
          { nativePriceUsd: async () => 0 },
          new DatabaseAddressBook(db, chain),
        );

    /**
     * Reorg depth from the chain's own configuration, not a constant.
     *
     * Polygon PoS is the reason: its reorgs are routinely deeper than anything on BNB Chain,
     * and a rewind that stops short leaves the divergent range credited — a merchant paid for
     * a payment that no longer exists, with nothing in the system that will ever notice.
     */
    const config = chainConfig(chain);
    const reorgDepth = config.confirmations.highValue;
    const watcher = new Watcher(
      chain,
      adapter,
      caller,
      state,
      sink,
      {
        reorgDepth,
        // Must be at least reorgDepth, and deeper is only memory.
        blockMemory: Math.max(reorgDepth * 2, DEFAULT_WATCHER.blockMemory),
        maxBlocksPerPoll: DEFAULT_WATCHER.maxBlocksPerPoll,
      },
      (message) => log('watcher', { chain, detail: message }),
    );

    log('watching', {
      chain,
      /**
       * A count, and the symbols only when there are few enough to read.
       *
       * The first version logged them all, and against a database with a few thousand
       * merchant-submitted tokens in it the startup line was twenty kilobytes of JSON —
       * which is not a log line, it is a denial of service against whoever has to read it.
       */
      assetCount: accepted.length,
      ...(accepted.length <= 20 ? { assets: accepted.map((asset) => asset.symbol) } : {}),
      reorgDepth,
      addressModel: chainConfig(chain).addressModel,
      /**
       * What settlement means on this chain, said every time.
       *
       * On an EVM chain "payments are being detected" and "funds are being moved" are two
       * different claims and only the first is true in this process. On a pooled chain there is
       * nothing to move at all — the payer already paid the merchant's wallet — so the line says
       * which of the two situations this is rather than one sentence covering both.
       */
      settlement: pooled ? 'nothing to settle: the payer paid the merchant directly' : 'not in this process',
    });

    adapters.set(chain, adapter);

    handles.push(
      runLoop(watcher, DEFAULT_LOOP, {
        onPoll: (outcome) => {
          // Only when something happened, except a reorg, which is always worth a line.
          if (outcome.credited > 0 || outcome.reversed > 0 || outcome.reorg) {
            log('poll', { ...outcome });
          }
        },
        onError: (error, consecutive) => {
          log('poll failed', {
            chain,
            consecutive,
            detail: error instanceof Error ? error.message : String(error),
          });
          void state.recordError(chain, error instanceof Error ? error.message : String(error));
        },
      }),
    );
  }

  /**
   * And settlement, in the same process, for every chain that has something to send.
   *
   * Here rather than in its own process for two reasons and one non-reason. The adapters, the
   * database pool and the price service are already built here, and a second process would
   * build a second copy of all three. And an operator running one gateway should be running one
   * background service, not two that have to be started in an order. The non-reason is
   * coupling: a settlement failure must not stop the chain being watched, which is why each
   * loop is separate and each one's errors are its own.
   *
   * Nothing runs at all without a settlement key, and that is said out loud rather than left to
   * be noticed — a deployment detecting payments and never moving them looks healthy from
   * every angle except the merchant's balance.
   */
  const settlementHandles = await startSettlement({
    env,
    db,
    prices,
    adapters,
    log,
  });
  handles.push(...settlementHandles);

  log('watcher started', {
    chains: handles.length - settlementHandles.length,
    settling: settlementHandles.length,
    preparedStatements: prepare,
  });

  const shutdown = async (signal: string): Promise<void> => {
    log('shutting down', { signal });
    // Sequential, and awaited: each stop waits for the poll in flight, and a poll abandoned
    // between crediting and saving its cursor is a payment credited twice on restart.
    for (const handle of handles) await handle.stop();
    await close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}


/**
 * One watcher, whatever the deploy does.
 *
 * The lock wraps `main` rather than each poll: this is a claim on the role, not on a pass.
 * A second copy — started by a deploy that did not stop the first, which is the ordinary way
 * this goes wrong — exits immediately rather than scanning the same ranges and racing the
 * cursor writes.
 */
async function once(): Promise<void> {
  const env = loadEnv();
  const { db, close } = createDatabase(env.DATABASE_URL, { prepare: env.DATABASE_PREPARE, max: 1 });
  const held = await withJobLock(db, JOB_LOCKS.chainWatcher, async () => {
    await main();
    // Held for the life of the process: `main` returns once the loops are running, so this
    // never resolves until shutdown, which exits.
    await new Promise<never>(() => {});
  });
  await close();

  if (!held.ran) {
    console.error('another watcher process holds the lock; exiting');
    process.exit(0);
  }
}

void once().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

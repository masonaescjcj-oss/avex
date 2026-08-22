import {
  DEFAULT_FEE_POLICY,
  DEFAULT_RUNNER,
  EVM_CHAIN_IDS,
  EvmChainSigner,
  FeePolicy,
  LocalKeyProvider,
  SettlementRunner,
  evmChainId,
} from '@avex/core';
import type { ChainAdapter, ChainId } from '@avex/core';

import type { Database } from '../db/client.js';
import { ChainMinimums } from '../domain/chain-minimums.js';
import { RpcGasOracle } from '../domain/gas-oracle.js';
import { SettlementSource } from '../domain/settlement-source.js';
import { SettlementStore } from '../domain/settlement-store.js';
import type { Env } from '../env.js';
import { JsonRpcCaller } from '../rpc/json-rpc-caller.js';
import { runLoop, type LoopHandle } from '../watch/loop.js';
import { SettlementCycle } from './cycle.js';

/**
 * Starting settlement, for every chain that has something to send.
 *
 * This is the wiring that did not exist. `SettlementQueue`, `SettlementRunner`,
 * `SettlementStore` and the EVM signer were all written and tested, and no entry point
 * constructed any of them — so a payment on an EVM chain was detected, credited, announced to
 * the merchant by webhook, and left at its deposit address. This file is what makes the money
 * move, and it is deliberately small: everything it does is choose the pieces and start a loop.
 *
 * ## Degrading rather than failing
 *
 * Without a settlement key nothing here runs, and that is the correct behaviour rather than a
 * gap: a missing key must not stop a checkout, and this process is also the watcher. What is not
 * acceptable is doing it quietly, so every reason for not settling a chain is logged as its own
 * line. A gateway that detects payments and never moves them looks healthy from every angle
 * except the merchant's balance.
 */

/** Seconds between passes. */
const SETTLE_INTERVAL_MS = 30_000;

export interface StartSettlementInput {
  readonly env: Env;
  readonly db: Database;
  /** For the native price behind every gas figure. `PriceService` satisfies it. */
  readonly prices: { nativePriceUsd(chain: ChainId): Promise<number> };
  /** The adapters the watcher already built, by chain. */
  readonly adapters: ReadonlyMap<ChainId, ChainAdapter>;
  readonly log: (message: string, data?: unknown) => void;
}

export async function startSettlement(input: StartSettlementInput): Promise<readonly LoopHandle[]> {
  const { env, db, adapters, log } = input;

  if (!env.SETTLEMENT_KEY_HEX) {
    log('not settling: no SETTLEMENT_KEY_HEX', {
      detail:
        'payments will be detected and credited, and funds will stay at their deposit ' +
        'addresses. Chains whose payer transfer reaches the merchant directly — TRON, TON — are ' +
        'unaffected: there is nothing to settle on them.',
    });
    return [];
  }

  /**
   * One key provider for every chain, and it refuses to exist in production.
   *
   * `LocalKeyProvider` throws when `NODE_ENV` is production unless explicitly overridden, and
   * that refusal is right: this key can move every merchant's funds out of a forwarder — only
   * ever to that merchant, but it also pays for the transaction, so a copy of it is a wallet
   * somebody else can drain. A KMS-backed provider is the production answer; this is the
   * testnet and staging one, and the error it throws names the difference.
   */
  const keys = new LocalKeyProvider(env.SETTLEMENT_KEY_HEX, { environment: env.NODE_ENV });

  const store = new SettlementStore(db);
  const source = new SettlementSource(db);
  const feePolicy = new FeePolicy(DEFAULT_FEE_POLICY);
  const handles: LoopHandle[] = [];

  for (const [chain, adapter] of adapters) {
    if (!SettlementSource.settles(chain)) {
      log('nothing to settle on this chain', {
        chain,
        detail: "the payer's transfer reaches the merchant's own wallet; no transaction of ours",
      });
      continue;
    }
    if (!(chain in EVM_CHAIN_IDS)) {
      /**
       * A chain that settles but has no chain id here cannot be signed for.
       *
       * Solana is the case: its settlement profile is real and its signer is not written. Said
       * rather than skipped, because the invoices are accruing either way.
       */
      log('cannot settle this chain: no signer implementation', { chain });
      continue;
    }

    const urls = env.EVM_RPC_URLS[chain] ?? [];
    if (urls.length === 0) {
      log('cannot settle this chain: no RPC endpoint', { chain });
      continue;
    }

    const caller = new JsonRpcCaller({ [chain]: urls }, chain);
    const signer = new EvmChainSigner(
      { call: (method, params) => caller.request(method, params) },
      keys,
      { chainId: evmChainId(chain), priorityFraction: env.SETTLEMENT_PRIORITY_FRACTION },
    );
    // Resolves the address, which is also the first proof the endpoint and the key both work.
    await signer.initialise();

    /**
     * Gas from the same cache the fee quoting uses.
     *
     * One source, so the figure an invoice was charged against and the fee its settlement is
     * sent at come from the same place. Two probes would disagree by a block, which is
     * harmless in isolation and exactly the kind of thing that makes a cost report impossible
     * to reconcile later.
     */
    const oracle = new RpcGasOracle(caller, input.prices, (message) =>
      log('gas oracle', { chain, detail: message }),
    );

    const runner = new SettlementRunner(chain, signer, feePolicy, DEFAULT_RUNNER, (message) =>
      log('settlement', { chain, detail: message }),
    );

    const cycle = new SettlementCycle({
      chain,
      adapter,
      runner,
      feePolicy,
      signer,
      source,
      store,
      gas: () => oracle.snapshot(chain),
      log: (message, data) => log(message, { chain, ...(data as object | undefined) }),
    });

    const started = await cycle.start();
    log('settling', {
      chain,
      wallet: signer.address,
      nonce: started.nonce,
      orphansPending: started.orphans,
      minimumInvoiceUsd: (await new ChainMinimums(oracle).minInvoiceUsdMicros(chain)) ?? null,
    });

    handles.push(
      runLoop(
        { poll: () => cycle.once() },
        { intervalMs: SETTLE_INTERVAL_MS, backoffMs: 5_000, maxBackoffMs: 5 * 60_000 },
        {
          onPoll: (report) => {
            // Only when something happened. A quiet chain should produce no lines at all.
            if (
              report.broadcast.length > 0 ||
              report.confirmed > 0 ||
              report.reverted > 0 ||
              report.replaced > 0
            ) {
              log('settlement pass', { ...report });
            }
          },
          onError: (error, consecutive) => {
            log('settlement pass failed', {
              chain,
              consecutive,
              detail: error instanceof Error ? error.message : String(error),
            });
          },
        },
      ),
    );
  }

  if (handles.length === 0) {
    log('settlement is configured but no chain is settling', {
      detail: 'a key was provided and nothing could use it; the lines above say why for each chain',
    });
  }

  return handles;
}

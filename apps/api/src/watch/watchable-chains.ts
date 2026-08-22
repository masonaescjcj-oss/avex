import { EVM_CHAIN_IDS, SUPPORTED_CHAINS, chainConfig } from '@avex/core';
import type { ChainId } from '@avex/core';

import type { loadEnv } from '../env.js';

/**
 * In its own module, not in `watcher.ts`.
 *
 * That file is a process entry point: importing it starts a watcher, takes an advisory lock
 * and never returns. A test that imported it to reach one pure function started the whole
 * process instead — so the function that decides whether a chain is watched at all lives here,
 * where it can be tested without side effects.
 */

/**
 * Which chains this build can actually watch.
 *
 * Two kinds now, and the requirements differ. An EVM chain needs a forwarder factory, because
 * the address it watches is a hash over that factory — without one the deposit addresses it
 * would be looking for do not exist. A pooled chain needs no factory at all: its addresses are
 * the merchants' own, read from the database.
 *
 * TRON's endpoint lives in `EVM_RPC_URLS` and that is not a mistake. A TRON node exposes an
 * Ethereum-compatible JSON-RPC, which is exactly what that variable holds and exactly how this
 * process talks to it; a second variable would be the same list under a second name.
 */
export function watchableChains(env: ReturnType<typeof loadEnv>): readonly ChainId[] {
  return Object.keys(env.EVM_RPC_URLS)
    .filter((chain): chain is ChainId => SUPPORTED_CHAINS.includes(chain as ChainId))
    .filter((chain) => (env.EVM_RPC_URLS[chain]?.length ?? 0) > 0)
    .filter((chain) => {
      if (chainConfig(chain).addressModel === 'pooled') return true;
      if (!(chain in EVM_CHAIN_IDS)) return false;
      return env.FORWARDER_FACTORIES[chain] !== undefined;
    });
}


import { EVM_CHAIN_IDS, SUPPORTED_CHAINS, chainConfig } from '@avex/core';
import type { AddressModel, ChainId } from '@avex/core';

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
 * The address models this build constructs an adapter for.
 *
 * Not every model in the registry: `shared-memo` is absent, which is the whole reason this
 * constant exists rather than being inlined into the filter below. `TonAdapter` is in
 * `@avex/core` and is a sketch — it polls one address it is never given, credits native TON
 * rather than jettons, and has no tests — so `watcher.ts` never builds one, and a TON invoice
 * would be a payment method that takes money and never reports it.
 *
 * Exported because the invoice side has to agree. `depositAddressConfig` filters shared-address
 * chains through this, so a chain that cannot be credited is not offered; adding `'shared-memo'`
 * here is what will turn TON on, in both places at once, and `deposit-address-agreement.test.ts`
 * is what holds the two together.
 */
export const CREDITABLE_ADDRESS_MODELS: readonly AddressModel[] = ['unique', 'pooled'];

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
      const model = chainConfig(chain).addressModel;
      if (!CREDITABLE_ADDRESS_MODELS.includes(model)) return false;
      if (model === 'pooled') return true;
      if (!(chain in EVM_CHAIN_IDS)) return false;
      return env.FORWARDER_FACTORIES[chain] !== undefined;
    });
}


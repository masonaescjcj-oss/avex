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
 * Which chains this deployment has an endpoint for, and where each one's came from.
 *
 * One function because two modules ask the question — this file, to decide what is watched,
 * and `depositAddressConfig`, to decide what is offered — and they must never answer it
 * differently. They did not disagree before only because the condition was short enough to
 * copy correctly.
 *
 * Two variables feed it. `EVM_RPC_URLS` holds every chain that speaks the Ethereum JSON-RPC,
 * TRON included, because a TRON node really does answer `eth_getLogs`. Solana speaks a
 * different vocabulary entirely, so its endpoint is named separately rather than being put
 * in a map that the gas oracle and the contract prober also read.
 */
export function chainEndpoints(
  env: ReturnType<typeof loadEnv>,
): Readonly<Partial<Record<ChainId, readonly string[]>>> {
  const endpoints: Partial<Record<ChainId, readonly string[]>> = {};
  for (const chain of SUPPORTED_CHAINS) {
    const urls = chain === 'solana' ? env.SOLANA_RPC_URLS : (env.EVM_RPC_URLS[chain] ?? []);
    if (urls.length > 0) endpoints[chain] = urls;
  }
  return endpoints;
}

/**
 * Which chains this build can actually watch.
 *
 * An RPC endpoint, and that is all. It used to take a forwarder factory as well on the EVM
 * chains, because the addresses watched there were hashes over that factory — without one,
 * nothing it looked for could exist. That stopped being true when a merchant's own wallets
 * began taking payments on every chain: those addresses come from the database, and a chain
 * with an RPC and no contract of ours has real invoices on it to be credited. The adapter
 * built for such a chain watches and does not derive or settle, which is exactly what it has.
 *
 * TRON's endpoint lives in `EVM_RPC_URLS` and that is not a mistake. A TRON node exposes an
 * Ethereum-compatible JSON-RPC, which is exactly what that variable holds and exactly how this
 * process talks to it; a second variable would be the same list under a second name.
 */
export function watchableChains(env: ReturnType<typeof loadEnv>): readonly ChainId[] {
  return (Object.keys(chainEndpoints(env)) as ChainId[]).filter((chain) => {
    const model = chainConfig(chain).addressModel;
    if (!CREDITABLE_ADDRESS_MODELS.includes(model)) return false;
    /**
     * An adapter this build can actually construct.
     *
     * Every pooled chain has one — `TronAdapter` for the chains that speak the Ethereum
     * JSON-RPC, `SolanaAdapter` for Solana — and a `unique` chain needs the EVM adapter's
     * CREATE2 derivation, which needs a chain id. What is excluded is `shared-memo`, above.
     */
    return model === 'pooled' || chain in EVM_CHAIN_IDS;
  });
}

/**
 * Whether a chain can derive per-invoice forwarder addresses, as opposed to only taking
 * payments into merchants' own wallets. Both halves of the contract pair, on an EVM chain.
 */
export function hasForwarders(env: ReturnType<typeof loadEnv>, chain: ChainId): boolean {
  return (
    chain in EVM_CHAIN_IDS &&
    env.FORWARDER_FACTORIES[chain] !== undefined &&
    env.FORWARDER_IMPLEMENTATIONS[chain] !== undefined
  );
}


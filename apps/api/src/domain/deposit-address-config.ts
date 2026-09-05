import { EVM_CHAIN_IDS, SUPPORTED_CHAINS, chainConfig } from '@avex/core';
import type { ChainId } from '@avex/core';

import type { DepositAddressConfig, EvmChainConfig } from './deposit-address.js';
import type { Env } from '../env.js';
import { CREDITABLE_ADDRESS_MODELS } from '../watch/watchable-chains.js';

/**
 * Which chains a merchant can be offered, from configuration alone.
 *
 * Extracted from `compose` so that one rule can be held against the watcher's: a chain that can
 * issue an invoice must be a chain a payment on it can be credited. Nothing enforced that, and
 * two chains were counter-examples — see `deposit-address-agreement.test.ts`, which is the
 * statement of the invariant rather than a description of the fix.
 *
 * ## Driven by the chain list, not by the configuration's keys
 *
 * The shape here is deliberate. Reading `Object.entries(env.FORWARDER_FACTORIES)` — which is what
 * this replaced — makes every key its own chain, so `FORWARDER_FACTORIES=solana=0x…`, or any
 * misspelling, became a chain on the checkout. Solana is `unique` in the registry and is not an
 * EVM chain, so it was offered with a CREATE2 address derived for a chain that has no CREATE2,
 * and `watchableChains` excluded it. A payer would have been given an address that cannot exist.
 *
 * Iterating the registry instead means a chain is offered because it is a chain, configured the
 * way its own address model requires. A key naming something else is ignored rather than
 * believed.
 */
export function depositAddressConfig(env: Env): DepositAddressConfig {
  const evm: Record<string, EvmChainConfig> = {};
  const shared: Record<string, string> = {};
  const pooled: ChainId[] = [];

  for (const chain of SUPPORTED_CHAINS) {
    const model = chainConfig(chain).addressModel;

    /**
     * A merchant's own wallets take payments on every chain this build watches.
     *
     * So every creditable chain with an endpoint is a pooled chain, whatever else it is:
     * BNB Chain is here with its forwarders *and* as a place a merchant's wallet works, and
     * which of the two an invoice uses is decided per merchant, from whether they registered
     * one. This is what makes a chain usable with no contract of ours deployed on it.
     */
    if (
      CREDITABLE_ADDRESS_MODELS.includes(model) &&
      (env.EVM_RPC_URLS[chain]?.length ?? 0) > 0 &&
      (model === 'pooled' || chain in EVM_CHAIN_IDS)
    ) {
      pooled.push(chain);
    }

    /**
     * Nothing this build cannot credit a payment on, whatever else is configured for it.
     *
     * TON is the case: `SHARED_DEPOSIT_WALLETS=ton=…` used to put it in front of payers while no
     * `TonAdapter` was ever constructed, so a transfer carrying the right memo would arrive in
     * the shared wallet and no invoice would ever be marked paid. Money that is not lost and
     * that nothing in the system would notice had arrived.
     */
    if (!CREDITABLE_ADDRESS_MODELS.includes(model)) continue;

    if (model === 'unique') {
      /**
       * Both halves, and an EVM chain to derive on.
       *
       * A factory with no logic address would derive from an empty string: valid hex, a real
       * address, and one nothing can ever settle. A chain that is `unique` but not EVM — Solana —
       * has no CREATE2 at all, so there is nothing to derive with either. Either way the chain is
       * left out, which is the safe direction a missing factory has always taken: it cannot issue
       * invoices rather than issuing unpayable ones.
       */
      const factory = env.FORWARDER_FACTORIES[chain];
      const implementation = env.FORWARDER_IMPLEMENTATIONS[chain];
      if (factory && implementation && chain in EVM_CHAIN_IDS) {
        evm[chain] = { factory, implementation };
      }
      continue;
    }

    if (model === 'shared-memo') {
      const wallet = env.SHARED_DEPOSIT_WALLETS[chain];
      if (wallet) shared[chain] = wallet;
      continue;
    }

    // A natively pooled chain — TRON — was added above with the others.
  }

  return { evm, shared, pooled: [...new Set(pooled)] };
}

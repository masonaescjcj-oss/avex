import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { SUPPORTED_CHAINS, chainConfig } from '@avex/core';

import { depositAddressConfig } from './deposit-address-config.js';
import { DepositAddressDeriver } from './deposit-address.js';
import type { Env } from '../env.js';
import { watchableChains } from '../watch/watchable-chains.js';

/**
 * One invariant, in one file: a chain that can issue an invoice is a chain a payment on it can
 * be credited.
 *
 * The two halves are decided in different modules from the same environment — `compose` builds
 * the deriver, `watcher.ts` builds the adapters — and nothing checked that they agreed. TON was
 * the case where they did not: setting `SHARED_DEPOSIT_WALLETS` put it in front of payers on the
 * checkout while `watchableChains` excluded it, because no `TonAdapter` is ever constructed. A
 * payer's transfer would arrive in the shared wallet with the right memo and no invoice would
 * ever be marked paid — money that is not lost and that nothing in the system will notice.
 *
 * The failure mode is why this is a test rather than a comment. Both sides read plausible on
 * their own; only holding them together shows the gap.
 */

const BASE: Env = {
  NODE_ENV: 'test',
  PORT: 3000,
  HOST: '127.0.0.1',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/avex',
  DATABASE_PREPARE: undefined,
  DIRECT_DATABASE_URL: undefined,
  CRON_SECRET: undefined,
  BUILD_STAMP_FILE: '/nonexistent/avex/build',
  MIN_INVOICE_USD: 0.5,
  MIN_INVOICE_FEE_RATIO: 0.004,
  RUN_JOBS_IN_PROCESS: true,
  APP_URL: 'https://avexpay.net',
  SESSION_TTL_HOURS: 336,
  EMAIL_TOKEN_TTL_MINUTES: 60,
  RATE_LIMIT_PER_MINUTE: 120,
  PRICE_SOURCES: ['coingecko', 'binance'],
  PRICE_MIN_SOURCES: 2,
  PRICE_OUTLIER_TOLERANCE_BPS: 200,
  PRICE_MAX_DISPERSION_BPS: 300,
  PRICE_MAX_STALENESS_MS: 120_000,
  PRICE_CACHE_TTL_MS: 10_000,
  PRICE_STALE_FALLBACK_MS: 90_000,
  SETTLEMENT_KEY_HEX: undefined,
  SETTLEMENT_PRIORITY_FRACTION: 0.1,
  FORWARDER_FACTORIES: {},
  FORWARDER_IMPLEMENTATIONS: {},
  SMTP_URL: undefined,
  MAIL_FROM: 'no-reply@avexpay.net',
  MAIL_FROM_NAME: 'AVEX Pay',
  OPERATOR_EMAIL: undefined,
  SHARED_DEPOSIT_WALLETS: {},
  FEE_COLLECTORS: {},
  TOKEN_ENCRYPTION_KEY: 'a-token-encryption-key-for-this-test',
  MEMO_SECRET: 'a-memo-secret-for-this-test',
  CHECKOUT_ORIGINS: [],
  DASHBOARD_ORIGINS: [],
  EVM_RPC_URLS: {},
  SOLANA_RPC_URLS: [],
  TON_API_URL: '',
  TON_API_KEY: undefined,
} as Env;

const env = (overrides: Partial<Env>): Env => ({ ...BASE, ...overrides });

/**
 * One chain's endpoint, in the variable that chain's endpoint belongs in.
 *
 * Which is the fact this file has to encode rather than assume: `EVM_RPC_URLS` for everything
 * that speaks the Ethereum JSON-RPC, TRON included, `SOLANA_RPC_URLS` for Solana, which speaks
 * its own, and `TON_API_URL` for TON, which is answered by an indexer rather than a node. A chain added later with no route into either variable has no endpoint, so
 * the tests below fail rather than quietly passing over it.
 */
const endpointFor = (chain: string): Partial<Env> =>
  chain === 'solana'
    ? { SOLANA_RPC_URLS: ['https://solana.example'] }
    : chain === 'ton'
      ? { TON_API_URL: 'https://toncenter.example/api/v3' }
      : { EVM_RPC_URLS: { [chain]: ['https://rpc.example'] } };

/** What a merchant can be offered, decided exactly as `compose` decides it. */
const offered = (source: Env): readonly string[] =>
  new DepositAddressDeriver(depositAddressConfig(source), source.MEMO_SECRET).supportedChains();

describe('the invoice side and the watcher agree', () => {
  test('every chain that can issue an invoice can also be watched', () => {
    /**
     * Every chain configured every way at once, so the check is over the whole surface rather
     * than over one example. A pooled chain needs no configuration of ours at all, which is why
     * TRON is here with only an endpoint.
     */
    const everything = env({
      EVM_RPC_URLS: Object.fromEntries(
        SUPPORTED_CHAINS.map((chain) => [chain, ['https://rpc.example']]),
      ),
      TON_API_URL: 'https://toncenter.example/api/v3',
      SOLANA_RPC_URLS: ['https://solana.example'],
      FORWARDER_FACTORIES: Object.fromEntries(
        SUPPORTED_CHAINS.map((chain) => [chain, '0x' + '11'.repeat(20)]),
      ),
      FORWARDER_IMPLEMENTATIONS: Object.fromEntries(
        SUPPORTED_CHAINS.map((chain) => [chain, '0x' + '22'.repeat(20)]),
      ),
      SHARED_DEPOSIT_WALLETS: Object.fromEntries(
        SUPPORTED_CHAINS.map((chain) => [chain, 'UQexample']),
      ),
    });

    const watched = new Set<string>(watchableChains(everything));
    const unwatchable = offered(everything).filter((chain) => !watched.has(chain));

    assert.deepEqual(
      unwatchable,
      [],
      `these chains would be offered to payers and never credited: ${unwatchable.join(', ')}`,
    );
  });

  test('TON is offered and watched once it has an indexer, and is pooled', () => {
    /**
     * This assertion used to be its own inverse: TON was excluded from both sides because no
     * adapter was ever constructed for it, and the test said so with a note that building the
     * thing was what would invert it. Built, so inverted.
     *
     * Pooled rather than shared: the wallet is the merchant's own, from their pool, and the
     * comment names the invoice on it. The old model put one wallet of *ours* in front of
     * every payer, which is custodial and is not this product.
     */
    const withTon = env({ TON_API_URL: 'https://toncenter.example/api/v3' });

    assert.equal(offered(withTon).includes('ton'), true);
    assert.equal(watchableChains(withTon).includes('ton'), true);
    assert.ok(depositAddressConfig(withTon).pooled?.includes('ton'));
    assert.equal(chainConfig('ton').addressModel, 'pooled');
  });

  test('TON without an indexer is offered nowhere, wallet or not', () => {
    // The endpoint is the floor under every chain: a payment nobody polls for is never credited.
    const silent = env({ SHARED_DEPOSIT_WALLETS: { ton: 'UQexample' } });
    assert.equal(offered(silent).includes('ton'), false);
    assert.equal(watchableChains(silent).includes('ton'), false);
  });

  test('no chain uses the shared-wallet model any more, so nothing is configured into it', () => {
    /**
     * TON was the only `shared-memo` chain and is now pooled, so `shared` is empty whatever is
     * configured. The branch that fills it is kept for a chain that may need it, and this is
     * the assertion that says it is currently unreachable rather than silently broken.
     */
    const everything = env({
      TON_API_URL: 'https://toncenter.example/api/v3',
      SHARED_DEPOSIT_WALLETS: Object.fromEntries(SUPPORTED_CHAINS.map((chain) => [chain, 'UQexample'])),
    });
    assert.deepEqual(depositAddressConfig(everything).shared, {});
  });

  test('an EVM chain missing either contract half has no forwarders, and is still offered', () => {
    /**
     * Two different facts, and this test used to conflate them. Half a contract pair means no
     * forwarder address can be derived, so a merchant with only a payout address there cannot be
     * invoiced — that half is unchanged. But a merchant's own wallet takes payments on the chain
     * regardless, so the chain is offered and watched; it is simply pooled-only.
     */
    const halfConfigured = env({
      EVM_RPC_URLS: { bsc: ['https://rpc.example'] },
      FORWARDER_FACTORIES: { bsc: '0x' + '11'.repeat(20) },
      // and no FORWARDER_IMPLEMENTATIONS
    });

    const config = depositAddressConfig(halfConfigured);
    assert.equal('bsc' in config.evm, false, 'half a pair derives nothing');
    assert.ok(config.pooled?.includes('bsc'), 'and wallets still work there');
    assert.equal(offered(halfConfigured).includes('bsc'), true);
    assert.equal(watchableChains(halfConfigured).includes('bsc'), true);
  });

  test('a chain with no endpoint is offered nowhere, wallets or not', () => {
    // The floor under all of it: a payment nobody polls for is a payment never credited.
    const silent = env({ EVM_RPC_URLS: {} });
    assert.deepEqual(offered(silent), []);
    assert.deepEqual([...watchableChains(silent)], []);
  });

  test('a pooled chain is offered with nothing configured but an endpoint', () => {
    /**
     * The other direction, and the reason this is not simply "offer nothing". TRON was silently
     * absent from every checkout once it became pooled, because a chain with no factory looked
     * like a chain with nothing set up.
     */
    const tron = SUPPORTED_CHAINS.filter((chain) => chainConfig(chain).addressModel === 'pooled');
    assert.ok(tron.length > 0, 'no pooled chain in the registry to check');

    for (const chain of tron) {
      const only = env(endpointFor(chain));
      assert.equal(offered(only).includes(chain), true, `${chain} must be offerable`);
      assert.equal(watchableChains(only).includes(chain), true, `${chain} must be watchable`);
    }
  });

  test('Solana takes its endpoint from its own variable, and only from there', () => {
    /**
     * Solana speaks its own RPC, so its endpoint cannot live in `EVM_RPC_URLS` — that map is
     * also read by the gas oracle and the contract prober, both of which would get an endpoint
     * that answers "method not found" to everything they ask. A key naming Solana in there is
     * therefore a typo, and is ignored rather than believed, which is the same rule
     * `SHARED_DEPOSIT_WALLETS` follows two tests down.
     */
    const proper = env({ SOLANA_RPC_URLS: ['https://solana.example'] });
    assert.equal(offered(proper).includes('solana'), true);
    assert.equal(watchableChains(proper).includes('solana'), true);

    const misplaced = env({ EVM_RPC_URLS: { solana: ['https://solana.example'] } });
    assert.equal(offered(misplaced).includes('solana'), false);
    assert.equal(watchableChains(misplaced).includes('solana'), false);
  });

  test('Solana is offered as a pooled chain, never as a derived one', () => {
    /**
     * The failure this replaced: Solana was `unique`, so a factory key naming it derived a
     * CREATE2 address for a chain that has no CREATE2 — a payer would have been handed an
     * address that cannot exist. It is pooled now, so a merchant's own wallet takes the
     * payment and nothing is derived. A factory configured for it must still change nothing.
     */
    const withFactory = env({
      SOLANA_RPC_URLS: ['https://solana.example'],
      FORWARDER_FACTORIES: { solana: '0x' + '11'.repeat(20) },
      FORWARDER_IMPLEMENTATIONS: { solana: '0x' + '22'.repeat(20) },
    });

    const config = depositAddressConfig(withFactory);
    assert.equal('solana' in config.evm, false, 'nothing to derive on Solana');
    assert.ok(config.pooled?.includes('solana'), 'and wallets work there');
  });

  test('a shared-address entry naming a chain that is not shared-address is dropped', () => {
    /**
     * `parsePairs` accepts any key, so this is reachable by typo. Left in the map it would hand
     * every TRON payer one wallet plus a memo TRC-20 cannot carry, and amount-matching would
     * then be asked to tell identical transfers apart.
     */
    const typo = env({
      EVM_RPC_URLS: { tron: ['https://api.trongrid.io/jsonrpc'] },
      SHARED_DEPOSIT_WALLETS: { tron: 'TExample' },
    });

    const config = depositAddressConfig(typo);
    assert.deepEqual(config.shared, {});
  });
});

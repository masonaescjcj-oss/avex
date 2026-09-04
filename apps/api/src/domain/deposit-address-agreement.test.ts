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
  MEMO_SECRET: 'a-memo-secret-for-this-test',
  CHECKOUT_ORIGINS: [],
  DASHBOARD_ORIGINS: [],
  EVM_RPC_URLS: {},
} as Env;

const env = (overrides: Partial<Env>): Env => ({ ...BASE, ...overrides });

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

  test('a configured TON wallet does not put TON on the checkout', () => {
    /**
     * The specific case, named, so that wiring a TON adapter later breaks this test and not the
     * gateway. When `TonAdapter` is real, `'shared-memo'` joins `CREDITABLE_ADDRESS_MODELS` and
     * this assertion is the one to invert — deliberately, having built the thing.
     */
    const withTon = env({
      EVM_RPC_URLS: { ton: ['https://toncenter.example'] },
      SHARED_DEPOSIT_WALLETS: { ton: 'UQexample' },
    });

    assert.equal(offered(withTon).includes('ton'), false);
    assert.equal(watchableChains(withTon).includes('ton'), false);
  });

  test('an EVM chain missing either contract half is offered by neither side', () => {
    const halfConfigured = env({
      EVM_RPC_URLS: { bsc: ['https://rpc.example'] },
      FORWARDER_FACTORIES: { bsc: '0x' + '11'.repeat(20) },
      // and no FORWARDER_IMPLEMENTATIONS
    });

    assert.equal(offered(halfConfigured).includes('bsc'), false);
  });

  test('a pooled chain is offered with nothing configured but an endpoint', () => {
    /**
     * The other direction, and the reason this is not simply "offer nothing". TRON was silently
     * absent from every checkout once it became pooled, because a chain with no factory looked
     * like a chain with nothing set up.
     */
    const tron = SUPPORTED_CHAINS.filter((chain) => chainConfig(chain).addressModel === 'pooled');
    assert.ok(tron.length > 0, 'no pooled chain in the registry to check');

    const pooled = env({ EVM_RPC_URLS: { tron: ['https://api.trongrid.io/jsonrpc'] } });

    for (const chain of tron) {
      assert.equal(offered(pooled).includes(chain), true, `${chain} must be offerable`);
      assert.equal(watchableChains(pooled).includes(chain), true, `${chain} must be watchable`);
    }
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

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { loadEnv } from '../env.js';
import { hasForwarders, watchableChains } from './watchable-chains.js';

/**
 * Which chains the watcher process will actually watch.
 *
 * A small function with an expensive failure mode: a chain missing from this list is a chain
 * whose payments are never seen, and the process starts, logs happily and stays quiet. TRON was
 * excluded by construction until the pooled model arrived — the filter required a forwarder
 * factory, which a pooled chain has no use for — so the exclusion looked exactly like a chain
 * nobody had configured.
 */
const BASE = {
  ...process.env,
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://unused',
  APP_URL: 'http://localhost',
  MEMO_SECRET: 'x'.repeat(32),
};

const env = (overrides: Record<string, string>) =>
  loadEnv({ ...BASE, ...overrides } as NodeJS.ProcessEnv);

describe('watchable chains', () => {
  test('a pooled chain needs an RPC endpoint and nothing else', () => {
    /**
     * No factory, because there is no forwarder: the deposit addresses are the merchants' own,
     * read from the database. Requiring one would be requiring configuration for a contract that
     * is never deployed.
     */
    const chains = watchableChains(
      env({ EVM_RPC_URLS: 'tron=https://api.trongrid.io/jsonrpc', FORWARDER_FACTORIES: '' }),
    );
    assert.deepEqual(chains, ['tron']);
  });

  test('an EVM chain without a factory is watched all the same', () => {
    /**
     * This used to be the other way round, and the reason was sound at the time: the address an
     * EVM watcher looked for was a hash over the factory, so without one it was watching for
     * addresses that could not exist. What changed is that merchants' own wallets now take
     * payments on every chain, and those addresses come from the database. A chain with an
     * endpoint and no contracts has real invoices on it — so it is watched, and only watched:
     * `hasForwarders` says whether it can also derive and settle.
     */
    const source = env({ EVM_RPC_URLS: 'bsc=https://bsc.example', FORWARDER_FACTORIES: '' });
    assert.deepEqual(watchableChains(source), ['bsc']);
    assert.equal(hasForwarders(source, 'bsc'), false);
  });

  test('forwarders need both contract halves, on an EVM chain', () => {
    const both = env({
      EVM_RPC_URLS: 'bsc=https://bsc.example',
      FORWARDER_FACTORIES: `bsc=0x${'11'.repeat(20)}`,
      FORWARDER_IMPLEMENTATIONS: `bsc=0x${'22'.repeat(20)}`,
    });
    assert.equal(hasForwarders(both, 'bsc'), true);
    // A factory with no logic address would derive from an empty string — a real address that
    // nothing can ever settle — so half a pair is no pair.
    const half = env({
      EVM_RPC_URLS: 'bsc=https://bsc.example',
      FORWARDER_FACTORIES: `bsc=0x${'11'.repeat(20)}`,
    });
    assert.equal(hasForwarders(half, 'bsc'), false);
    // TRON has no forwarders whatever is configured for it: nothing there is derived.
    assert.equal(hasForwarders(both, 'tron'), false);
  });

  test('an EVM chain with a factory is watched', () => {
    const chains = watchableChains(
      env({
        EVM_RPC_URLS: 'bsc=https://bsc.example',
        FORWARDER_FACTORIES: `bsc=0x${'11'.repeat(20)}`,
      }),
    );
    assert.deepEqual(chains, ['bsc']);
  });

  test('both kinds at once, each on its own terms', () => {
    const chains = watchableChains(
      env({
        EVM_RPC_URLS: 'bsc=https://bsc.example,tron=https://trongrid.example,polygon=https://poly.example',
        FORWARDER_FACTORIES: `bsc=0x${'11'.repeat(20)}`,
      }),
    );
    // Every chain with an endpoint. Polygon has no factory and is watched for merchants'
    // wallets; BSC has one and is watched for those and for forwarders; TRON has none to want.
    assert.deepEqual([...chains].sort(), ['bsc', 'polygon', 'tron']);
  });

  test('a chain this build has never heard of is ignored, not crashed on', () => {
    // The variable is free text in a deployment's environment. A typo must not stop the process.
    const chains = watchableChains(
      env({ EVM_RPC_URLS: 'trom=https://typo.example', FORWARDER_FACTORIES: '' }),
    );
    assert.deepEqual(chains, []);
  });

  test('an entry with no URL is ignored', () => {
    const chains = watchableChains(env({ EVM_RPC_URLS: 'tron=', FORWARDER_FACTORIES: '' }));
    assert.deepEqual(chains, []);
  });
});

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { loadEnv } from '../env.js';
import { watchableChains } from './watchable-chains.js';

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

  test('an EVM chain without a factory is not watched', () => {
    /**
     * And this is why the requirement exists. The address an EVM watcher looks for is a hash
     * over the factory, so without one it would be watching for addresses that cannot exist —
     * which is worse than not watching, because it looks like watching.
     */
    const chains = watchableChains(
      env({ EVM_RPC_URLS: 'bsc=https://bsc.example', FORWARDER_FACTORIES: '' }),
    );
    assert.deepEqual(chains, []);
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
    // Polygon has an endpoint but no factory, so it is left out; TRON needs no factory.
    assert.deepEqual([...chains].sort(), ['bsc', 'tron']);
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

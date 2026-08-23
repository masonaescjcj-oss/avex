import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { SignerError } from '@avex/core';

import type { Env } from '../env.js';
import { SettlementKeyError, settlementKeys } from './keys.js';

/**
 * Where the settlement key comes from, and every way that can go wrong.
 *
 * Worth its own file because until this existed there was exactly one way to supply a key — an
 * environment variable — and `LocalKeyProvider` refuses that in production. A deployment
 * following the documentation could not settle at all, and the symptom would have been a startup
 * line saying settlement was off on a host where everything else worked.
 */

/** A real key: the one the signer's own tests derive a known address from. */
const KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const ADDRESS = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'avex-keys-'));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const env = (overrides: Partial<Env>): Env =>
  ({
    NODE_ENV: 'production',
    SETTLEMENT_KEY_HEX: undefined,
    SETTLEMENT_KEY_FILE: undefined,
    ...overrides,
  }) as Env;

/** Write a key file and hand back its path. */
function keyFile(name: string, contents: string): string {
  const path = join(dir, name);
  writeFileSync(path, contents);
  chmodSync(path, 0o600);
  return path;
}

describe('the settlement key', () => {
  test('no key configured is not an error', async () => {
    /**
     * A deployment choice, not a failure: payments are still detected, credited and announced,
     * and the funds stay where they can only ever pay their own merchant. A throw here would
     * stop the checkout for a reason the checkout does not depend on.
     */
    assert.equal(settlementKeys(env({})), null);
  });

  test('a key file is accepted in production, and its address is the key’s', async () => {
    const loaded = settlementKeys(env({ SETTLEMENT_KEY_FILE: keyFile('plain', KEY) }));

    assert.ok(loaded);
    assert.equal(loaded.source, 'file');
    assert.equal(await loaded.keys.address(), ADDRESS);
  });

  test('a trailing newline is accepted', async () => {
    /**
     * A file a human made has one and a file `systemd-creds` made does not. Rejecting either
     * would surface as a hex-length error that says nothing about newlines, which is a bad hour
     * for whoever is deploying.
     */
    const loaded = settlementKeys(env({ SETTLEMENT_KEY_FILE: keyFile('newline', `${KEY}\n`) }));

    assert.ok(loaded);
    assert.equal(await loaded.keys.address(), ADDRESS);
  });

  test('an environment key is refused in production and says what to do instead', () => {
    assert.throws(
      () => settlementKeys(env({ SETTLEMENT_KEY_HEX: KEY })),
      (error: unknown) => {
        assert.ok(error instanceof SignerError);
        assert.match(String(error), /environment variable in production/);
        // The message has to name the way forward, or it is a dead end on a live deployment.
        assert.match(String(error), /SETTLEMENT_KEY_FILE|credential/);
        return true;
      },
    );
  });

  test('an environment key is fine outside production', async () => {
    const loaded = settlementKeys(env({ NODE_ENV: 'development', SETTLEMENT_KEY_HEX: KEY }));

    assert.ok(loaded);
    assert.equal(loaded.source, 'environment');
    assert.equal(await loaded.keys.address(), ADDRESS);
  });

  test('both configured is refused rather than one being preferred', () => {
    /**
     * Two keys means two intentions. Picking either quietly would settle from a wallet whose
     * balance nobody is watching, and the alarm would be on the other one.
     */
    assert.throws(
      () =>
        settlementKeys(
          env({ SETTLEMENT_KEY_HEX: KEY, SETTLEMENT_KEY_FILE: keyFile('both', KEY) }),
        ),
      SettlementKeyError,
    );
  });

  test('a missing key file throws, and names systemd', () => {
    assert.throws(
      () => settlementKeys(env({ SETTLEMENT_KEY_FILE: join(dir, 'absent') })),
      (error: unknown) => {
        assert.ok(error instanceof SettlementKeyError);
        assert.match(String(error), /CREDENTIALS_DIRECTORY/);
        return true;
      },
    );
  });

  test('a malformed key file throws without echoing the contents', () => {
    /**
     * The length, not the value. A key that is nearly right — a truncated paste — is the case
     * where an operator most wants to see what the file holds, and the one where a log line
     * holding it is worst.
     */
    const secretish = '0xdeadbeef';
    assert.throws(
      () => settlementKeys(env({ SETTLEMENT_KEY_FILE: keyFile('short', secretish) })),
      (error: unknown) => {
        assert.ok(error instanceof SettlementKeyError);
        assert.match(String(error), /10 characters after trimming/);
        assert.ok(!String(error).includes(secretish), 'the file contents must not be echoed');
        return true;
      },
    );
  });

  test('a key file holding something that is not hex at all throws', () => {
    assert.throws(
      () => settlementKeys(env({ SETTLEMENT_KEY_FILE: keyFile('prose', 'put the key here') })),
      SettlementKeyError,
    );
  });
});

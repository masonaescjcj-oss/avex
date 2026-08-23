import { readFileSync } from 'node:fs';

import { LocalKeyProvider } from '@avex/core';
import type { KeyProvider } from '@avex/core';

import type { Env } from '../env.js';

/**
 * Where the settlement key comes from, decided once.
 *
 * Two processes need a signer — the API builds one per chain for the admin panel's gas-balance
 * reading, the watcher builds one to settle with — and before this they each constructed a
 * `LocalKeyProvider` from `SETTLEMENT_KEY_HEX` inline. Which meant there was exactly one way to
 * supply a key, and it was the way `LocalKeyProvider` refuses in production. A deployment
 * following the documentation could not settle at all.
 *
 * ## What is actually at risk
 *
 * This key is the gas wallet and nothing else. A deposit address pays the destination written
 * into its own code — `flush` reads it with EXTCODECOPY and is deliberately callable by anyone —
 * so no key can redirect a merchant's money, and the fee collector is a separate address in
 * every clone. What a thief gets is the native balance and the ability to occupy nonces until
 * somebody notices settlements have stopped.
 *
 * That bounds the right amount of defence. Keep the balance to a few days of gas, alarm on it
 * (`OPERATOR_EMAIL`), and read the key from a credential rather than an environment variable.
 */

export interface SettlementKeys {
  readonly keys: KeyProvider;
  /** For the startup line, so an operator can see which path was taken. */
  readonly source: 'file' | 'environment';
}

export class SettlementKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettlementKeyError';
  }
}

const HEX_KEY = /^0x[0-9a-fA-F]{64}$/;

/**
 * The key, or null when this deployment is deliberately not settling.
 *
 * Null rather than a throw for the unconfigured case: a gateway with no settlement key still
 * takes payments, credits them and announces them, and that degradation is announced at startup
 * rather than being a crash. Every other failure here does throw — a key file that is missing or
 * malformed is a deployment that thinks it can settle and cannot, and discovering that on the
 * first settlement means a merchant has already been told their payment arrived.
 */
export function settlementKeys(env: Env): SettlementKeys | null {
  if (env.SETTLEMENT_KEY_FILE && env.SETTLEMENT_KEY_HEX) {
    /**
     * Refused rather than picking one. Two keys configured means two different intentions, and
     * silently preferring either would settle from a wallet somebody is not watching the balance
     * of.
     */
    throw new SettlementKeyError(
      'both SETTLEMENT_KEY_FILE and SETTLEMENT_KEY_HEX are set. Choose one: the file is the ' +
        'production path, the variable is for development.',
    );
  }

  if (env.SETTLEMENT_KEY_FILE) {
    const path = env.SETTLEMENT_KEY_FILE;
    let contents: string;
    try {
      contents = readFileSync(path, 'utf8');
    } catch (error) {
      throw new SettlementKeyError(
        `cannot read SETTLEMENT_KEY_FILE at ${path}: ${
          error instanceof Error ? error.message : String(error)
        }. Under systemd this is $CREDENTIALS_DIRECTORY/<name>, which exists only for a unit ` +
          'with a matching LoadCredential or LoadCredentialEncrypted.',
      );
    }

    /**
     * Trimmed, because a key file has a trailing newline whenever a human made it and does not
     * when `systemd-creds` did. Accepting both is the difference between working and a hex
     * length error that names nothing about newlines.
     */
    const hex = contents.trim();
    if (!HEX_KEY.test(hex)) {
      throw new SettlementKeyError(
        `SETTLEMENT_KEY_FILE at ${path} is not a 32-byte hex key with an 0x prefix. It holds ` +
          `${hex.length} characters after trimming. The contents are not echoed.`,
      );
    }

    return {
      keys: new LocalKeyProvider(hex, { environment: env.NODE_ENV, source: 'credential' }),
      source: 'file',
    };
  }

  if (env.SETTLEMENT_KEY_HEX) {
    // `LocalKeyProvider` is what refuses this in production, and its message says what to do.
    return {
      keys: new LocalKeyProvider(env.SETTLEMENT_KEY_HEX, {
        environment: env.NODE_ENV,
        source: 'environment',
      }),
      source: 'environment',
    };
  }

  return null;
}

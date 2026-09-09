import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  isTonAddress,
  normalizeTonAddress,
  parseTonAddress,
  tonAddressRaw,
  tonAddressesEqual,
} from './address.js';

/**
 * TON addresses, against real ones.
 *
 * The pair below is not invented: `EQCxE6…` is the USDT jetton master exactly as the asset
 * registry holds it, and the raw form is what toncenter reported for the same contract in a
 * live response. If the codec drifts, those two stop agreeing — and the failure that produces
 * is total and silent, because a jetton master we cannot convert is a jetton we never watch.
 */

/** Tether's USDT jetton master, from `assets/registry.ts`. */
const USDT_FRIENDLY = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';

/** The same contract, as toncenter reports it. */
const USDT_RAW = '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe';

/** A wallet, raw, from a live jetton transfer's `destination`. */
const WALLET_RAW = '0:852443f8599fe6a5da34fe43049ac4e0beb3071bb2bfb56635ea9421287c283a';

describe('TON addresses', () => {
  test('the registry’s jetton master and the indexer’s raw form are one address', () => {
    assert.equal(tonAddressRaw(USDT_FRIENDLY), USDT_RAW);
    assert.equal(tonAddressesEqual(USDT_FRIENDLY, USDT_RAW), true);
  });

  test('raw survives a round trip through the friendly form', () => {
    // Which is the trip every incoming transfer makes: raw from the indexer, friendly to
    // compare against what the merchant registered.
    assert.equal(tonAddressRaw(normalizeTonAddress(WALLET_RAW)), WALLET_RAW);
  });

  test('bounceable and non-bounceable are the same wallet', () => {
    /**
     * The flag says whether a failed transfer bounces back, not which account this is. A
     * merchant pastes whichever their wallet shows — `UQ…` for a personal wallet, `EQ…` in
     * most explorers — and a literal comparison of the two would make one wallet into two,
     * with every payment to it unmatched.
     */
    const friendly = normalizeTonAddress(USDT_FRIENDLY);
    assert.ok(friendly.startsWith('UQ'), `expected the canonical non-bounceable form, got ${friendly}`);
    assert.equal(parseTonAddress(USDT_FRIENDLY).bounceable, true, 'the input was bounceable');
    assert.equal(parseTonAddress(friendly).bounceable, false, 'the canonical form is not');
    assert.equal(tonAddressesEqual(USDT_FRIENDLY, friendly), true);
    // And the canonical form is a fixed point: normalising twice changes nothing.
    assert.equal(normalizeTonAddress(friendly), friendly);
  });

  test('a mistyped character is caught by the checksum', () => {
    /**
     * The one real protection a TON address has, and the reason the friendly form is what a
     * merchant is asked for. The raw form has no checksum at all, so a typo there is a valid
     * address nobody holds the key to.
     */
    const mistyped = `${USDT_FRIENDLY.slice(0, -1)}t`;
    assert.equal(isTonAddress(mistyped), false);
    assert.throws(() => parseTonAddress(mistyped), /bad checksum/);
  });

  test('both base64 alphabets are accepted, because both are in circulation', () => {
    // The friendly form is written base64url in some places and standard base64 in others;
    // `+`/`-` and `/`/`_` are the same bytes.
    const standard = USDT_FRIENDLY.replace(/-/g, '+').replace(/_/g, '/');
    assert.notEqual(standard, USDT_FRIENDLY, 'this fixture exercises the substitution');
    assert.equal(tonAddressRaw(standard), USDT_RAW);
  });

  test('a testnet address is refused rather than normalised', () => {
    /**
     * The test-only flag is a bit in the same byte, so a testnet address is otherwise a
     * perfectly well-formed one. Accepted into a mainnet gateway it would be a wallet no
     * mainnet payment can ever reach.
     */
    const parsed = parseTonAddress(USDT_FRIENDLY);
    assert.equal(parsed.testOnly, false);
    // Rebuild the same account with the test flag set, checksum included.
    const testnet = flagged(parsed.hash, 0x11 | 0x80, parsed.workchain);
    assert.equal(parseTonAddress(testnet).testOnly, true, 'it parses');
    assert.equal(isTonAddress(testnet), false, 'and is still refused');
  });

  test('the masterchain is a valid workchain, and is not workchain 255', () => {
    // -1 is encoded as 0xff, and reading it back as 255 would be a different chain entirely.
    const parsed = parseTonAddress(WALLET_RAW);
    const master = flagged(parsed.hash, 0x51, -1);
    assert.equal(parseTonAddress(master).workchain, -1);
    assert.equal(tonAddressRaw(master).startsWith('-1:'), true);
  });

  test('what is not an address', () => {
    for (const value of [
      '',
      '   ',
      'UQexample',
      '0:not-hex',
      // 31 bytes of account id.
      `0:${'ab'.repeat(31)}`,
      // An EVM address, which reaches this by a merchant picking the wrong chain.
      '0x1111111111111111111111111111111111111111',
    ]) {
      assert.equal(isTonAddress(value), false, JSON.stringify(value));
    }
  });
});

/** Build a friendly address from parts, so the tests can make one the codec must accept. */
function flagged(hash: Uint8Array, flags: number, workchain: number): string {
  const payload = new Uint8Array(34);
  payload[0] = flags;
  payload[1] = workchain === -1 ? 0xff : workchain & 0xff;
  payload.set(hash, 2);

  let crc = 0;
  for (const byte of payload) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) === 0 ? (crc << 1) & 0xffff : ((crc << 1) ^ 0x1021) & 0xffff;
    }
  }

  const out = new Uint8Array(36);
  out.set(payload);
  out[34] = (crc >> 8) & 0xff;
  out[35] = crc & 0xff;
  return Buffer.from(out).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

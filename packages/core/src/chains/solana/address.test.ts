import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { base58Encode } from '../base58.js';
import { isSolanaAddress, normalizeSolanaAddress, solanaAddressBytes } from './address.js';

/**
 * What a Solana address is, and the two mistakes that produce one that is not.
 *
 * There is no checksum to catch a typo, so nothing here can tell a merchant they mistyped a
 * character — only that the string is not 32 bytes. Which happens to be the mistake that
 * actually reaches this code: a transaction signature and a public key are both base58 noise
 * to a human, and the field they get pasted into is the one that decides where money goes.
 */

describe('Solana addresses', () => {
  test('the real mints in the asset registry are accepted', () => {
    // If these ever stopped parsing, the adapter would watch no mint at all and say nothing.
    for (const mint of [
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    ]) {
      assert.equal(isSolanaAddress(mint), true, mint);
      assert.equal(solanaAddressBytes(mint).length, 32);
    }
  });

  test('a transaction signature is refused, though it looks like an address', () => {
    // 64 bytes, base58, indistinguishable by eye from a public key.
    const signature = base58Encode(new Uint8Array(64).fill(7));
    assert.equal(isSolanaAddress(signature), false);
    assert.throws(() => solanaAddressBytes(signature), /64 bytes, not 32/);
  });

  test('an EVM address is refused', () => {
    // `0` is not in the base58 alphabet at all, so this fails at the first character.
    assert.equal(isSolanaAddress('0x' + '11'.repeat(20)), false);
  });

  test('the character count is not the byte count', () => {
    /**
     * Why the length regex it replaces was wrong. Base58 is not a power of two, so a 32-byte
     * key is 32 to 44 characters — and so are keys of 31 and 33 bytes, which that rule
     * accepted and Solana does not.
     */
    const short = base58Encode(new Uint8Array(31).fill(9));
    assert.ok(short.length >= 32 && short.length <= 44, 'inside the old rule’s range');
    assert.equal(isSolanaAddress(short), false, 'and still not an address');
  });

  test('leading zero bytes survive the round trip', () => {
    // A public key may begin with a zero byte, and a codec that drops it invents an address.
    const bytes = new Uint8Array(32).fill(3);
    bytes[0] = 0;
    const encoded = base58Encode(bytes);
    assert.ok(encoded.startsWith('1'));
    assert.deepEqual(solanaAddressBytes(encoded), bytes);
    assert.equal(normalizeSolanaAddress(encoded), encoded);
  });

  test('surrounding whitespace is tolerated, because a paste carries it', () => {
    const mint = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
    assert.equal(normalizeSolanaAddress(`  ${mint}\n`), mint);
  });

  test('an empty string is refused as itself', () => {
    assert.equal(isSolanaAddress(''), false);
    assert.throws(() => solanaAddressBytes('   '), /empty address/);
  });
});

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  base58Decode,
  base58Encode,
  isTronAddress,
  normalizeTronAddress,
  tronAddressFromEvmHex,
  tronAddressToEvmHex,
  tronAddressToHex,
  tronAddressesEqual,
} from './address.js';

/**
 * The vectors are on-chain facts, not values this implementation produced.
 *
 * `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` is Tether's TRC-20 contract, the highest-volume
 * stablecoin contract anywhere and the one already named in `assets/registry.ts`; its hex form
 * is what every TronGrid response carries. `T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb` is the
 * all-zero body, TRON's equivalent of the zero address. Both were checked against an
 * independent Base58Check implementation before being written down here — a codec tested only
 * against its own output is a codec that proves it is self-consistent and nothing else.
 */
const USDT_BASE58 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const USDT_HEX21 = '41a614f803b6fd780986a42c78ec9c7f77e6ded13c';
const USDT_EVM = '0xa614f803b6fd780986a42c78ec9c7f77e6ded13c';
const ZERO_BASE58 = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';

describe('base58', () => {
  test('round-trips arbitrary bytes', () => {
    for (let length = 0; length < 40; length++) {
      const input = new Uint8Array(length);
      for (let i = 0; i < length; i++) input[i] = (i * 31 + 7) & 0xff;
      assert.deepEqual(base58Decode(base58Encode(input)), input, `length ${length}`);
    }
  });

  test('leading zero bytes survive the round trip', () => {
    /**
     * They are not carried by the number, so they have to be re-added by hand — and a codec
     * that drops them decodes to a shorter array that still looks plausible. No TRON address
     * has one, which is exactly why this would go unnoticed.
     */
    const input = new Uint8Array([0, 0, 0, 1, 2, 3]);
    assert.equal(base58Encode(input).slice(0, 3), '111');
    assert.deepEqual(base58Decode(base58Encode(input)), input);
  });

  test('the excluded characters are rejected by name', () => {
    for (const char of ['0', 'O', 'I', 'l']) {
      assert.throws(() => base58Decode(`T${char}abc`), new RegExp(JSON.stringify(char)));
    }
  });
});

describe('tron addresses', () => {
  test('the known contract, in all three forms', () => {
    assert.equal(normalizeTronAddress(USDT_BASE58), USDT_BASE58);
    assert.equal(normalizeTronAddress(USDT_HEX21), USDT_BASE58);
    assert.equal(normalizeTronAddress(USDT_EVM), USDT_BASE58);

    assert.equal(tronAddressToHex(USDT_BASE58), USDT_HEX21);
    assert.equal(tronAddressToEvmHex(USDT_BASE58), USDT_EVM);
    assert.equal(tronAddressFromEvmHex(USDT_EVM), USDT_BASE58);
  });

  test('the all-zero body is a real address, and not a missing one', () => {
    /**
     * Worth its own case because `0x0` is how "unset" is spelled on EVM, and code that
     * treats a zero address as absent would treat this as absent too — while it is a live
     * address on chain that holds a balance.
     */
    assert.equal(normalizeTronAddress(`41${'00'.repeat(20)}`), ZERO_BASE58);
    assert.ok(isTronAddress(ZERO_BASE58));
  });

  test('a mistyped address is refused, not accepted as different bytes', () => {
    // One character changed. Base58Check exists for this, and the checksum must catch it.
    const typo = `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u`;
    assert.equal(isTronAddress(typo), false);
    assert.throws(() => normalizeTronAddress(typo), /bad checksum/);
  });

  test('an EVM address is not silently read as a TRON one', () => {
    /**
     * This one is deliberate rather than defensive. A 20-byte hex string *is* accepted and
     * given the TRON prefix, because that is what the CREATE2 derivation produces and it has
     * no other meaning. What must not be accepted is 21 bytes with the wrong prefix — that
     * is a different chain's address, or a mis-sliced buffer.
     */
    assert.throws(() => normalizeTronAddress(`42${'11'.repeat(20)}`), /prefix 0x42/);
    assert.throws(() => normalizeTronAddress(`0x${'11'.repeat(19)}`), /19 bytes/);
    assert.equal(isTronAddress(''), false);
    assert.equal(isTronAddress('not an address'), false);
  });

  test('lowercasing a TRON address destroys it', () => {
    /**
     * The reason this file exists, stated as a test.
     *
     * Both `lower()` in SQL and `toLowerCase()` in TypeScript are used across this codebase
     * to compare addresses, and on EVM that is correct — hex is case-insensitive. Base58 is
     * not: its alphabet holds `A` and `a`, `K` and `k`. The folded string is not an address
     * at all, so anything that stores or returns one has lost the information needed to build
     * a transaction, and two distinct addresses can fold onto each other — which, applied to
     * a deposit-address lookup, credits a payment to the wrong invoice.
     */
    assert.ok(isTronAddress(USDT_BASE58));
    assert.equal(isTronAddress(USDT_BASE58.toLowerCase()), false);
    assert.equal(tronAddressesEqual(USDT_BASE58, USDT_BASE58.toLowerCase()), false);
  });

  test('equality holds across forms and never throws', () => {
    assert.ok(tronAddressesEqual(USDT_BASE58, USDT_HEX21));
    assert.ok(tronAddressesEqual(USDT_HEX21, USDT_EVM));
    assert.ok(tronAddressesEqual(USDT_EVM.toUpperCase().replace('0X', '0x'), USDT_BASE58));
    // Hex *is* case-insensitive, so that last one holds; garbage is false, not an exception.
    assert.equal(tronAddressesEqual(USDT_BASE58, ZERO_BASE58), false);
    assert.equal(tronAddressesEqual('', USDT_BASE58), false);
    assert.equal(tronAddressesEqual('rubbish', 'rubbish'), false);
  });
});

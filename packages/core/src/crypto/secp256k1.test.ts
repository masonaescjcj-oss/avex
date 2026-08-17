import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hexToBytes } from '../chains/evm/rlp.js';
import {
  SigningError,
  addressFromPrivateKey,
  addressFromPublicKey,
  bigIntToBytes,
  bytesToBigInt,
  publicKeyFor,
  recoverAddress,
  signDigest,
  signatureFromDer,
  toChecksum,
} from './secp256k1.js';

/**
 * The keypair below is the canonical Ethereum test vector — private key
 * 0x4646...4646 from EIP-155's own worked example — so the address it derives to is
 * published rather than something this code produced.
 */
const KEY = hexToBytes('0x4646464646464646464646464646464646464646464646464646464646464646');
const ADDRESS = '0x9d8A62f656a8d1615C1294fd71e9CFb3E4855A4F';

test('the EIP-155 test key derives its published address', () => {
  assert.equal(addressFromPrivateKey(KEY), ADDRESS);
});

test('a public key derives the same address with or without its prefix', () => {
  const body = publicKeyFor(KEY);
  assert.equal(body.length, 64);

  const prefixed = new Uint8Array(65);
  prefixed[0] = 0x04;
  prefixed.set(body, 1);

  // Hashing the 0x04 prefix by mistake yields a plausible address for a key nobody
  // holds, so both forms must land on the same answer.
  assert.equal(addressFromPublicKey(body), ADDRESS);
  assert.equal(addressFromPublicKey(prefixed), ADDRESS);
});

test('a 65-byte key with the wrong prefix is refused', () => {
  const wrong = new Uint8Array(65);
  wrong[0] = 0x03;
  assert.throws(() => addressFromPublicKey(wrong), SigningError);
});

test('a signature recovers to the signing address', () => {
  const digest = hexToBytes('0x' + 'ab'.repeat(32));
  const signature = signDigest(digest, KEY);
  assert.equal(recoverAddress(digest, signature), ADDRESS);
});

test('signing is deterministic, as RFC 6979 requires', () => {
  // Two signatures over one digest must be identical. A differing nonce would mean
  // the library is using randomness, and reusing a random nonce leaks the key.
  const digest = hexToBytes('0x' + '11'.repeat(32));
  const first = signDigest(digest, KEY);
  const second = signDigest(digest, KEY);
  assert.deepEqual(first, second);
});

test('every signature is in the low-s form EIP-2 requires', () => {
  const half = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
  for (let i = 1; i < 24; i++) {
    const signature = signDigest(hexToBytes('0x' + i.toString(16).padStart(2, '0').repeat(32)), KEY);
    assert.ok(signature.s <= half, `s was high for digest ${i}`);
    assert.ok(signature.recovery === 0 || signature.recovery === 1);
  }
});

test('a digest of the wrong length is refused', () => {
  // Signing a 20-byte value as though it were a hash would produce a valid signature
  // over something that is not the transaction.
  assert.throws(() => signDigest(new Uint8Array(20), KEY), SigningError);
  assert.throws(() => signDigest(new Uint8Array(64), KEY), SigningError);
});

test('an out-of-range private key is refused rather than producing garbage', () => {
  const order = hexToBytes('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
  assert.throws(() => signDigest(new Uint8Array(32), new Uint8Array(32)), SigningError);
  assert.throws(() => signDigest(new Uint8Array(32).fill(1), order), SigningError);
  assert.throws(() => addressFromPrivateKey(new Uint8Array(31)), SigningError);
});

test('EIP-55 checksums match the specification examples', () => {
  for (const address of [
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
  ]) {
    assert.equal(toChecksum(address.toLowerCase()), address);
    // Idempotent: checksumming an already-checksummed address changes nothing.
    assert.equal(toChecksum(address), address);
  }
});

// ── external signers: DER, no recovery id, unnormalised s ────────────────────

/** Encode r and s the way a KMS would: SEQUENCE { INTEGER, INTEGER }. */
function der(r: bigint, s: bigint): Uint8Array {
  const integer = (value: bigint): number[] => {
    let bytes = [...bigIntToBytes(value, 32)];
    while (bytes.length > 1 && bytes[0] === 0 && bytes[1]! < 0x80) bytes = bytes.slice(1);
    // DER integers are signed, so a top bit set needs a 0x00 pad.
    if (bytes[0]! >= 0x80) bytes = [0x00, ...bytes];
    return [0x02, bytes.length, ...bytes];
  };
  const body = [...integer(r), ...integer(s)];
  return Uint8Array.from([0x30, body.length, ...body]);
}

test('a DER signature is normalised and given its recovery id', () => {
  const digest = hexToBytes('0x' + 'cd'.repeat(32));
  const expected = signDigest(digest, KEY);

  const recovered = signatureFromDer(der(expected.r, expected.s), digest, ADDRESS);
  assert.equal(recovered.r, expected.r);
  assert.equal(recovered.s, expected.s);
  // The recovery id is found by trying both and keeping the one that recovers to the
  // expected address, so it must agree with what signing produced directly.
  assert.equal(recovered.recovery, expected.recovery);
});

test('a high-s DER signature is flipped to its low-s twin', () => {
  /**
   * External signers do not enforce EIP-2. An unflipped high `s` is rejected by the
   * network, and only on broadcast — after the runner has advanced its nonce.
   */
  const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const digest = hexToBytes('0x' + '77'.repeat(32));
  const expected = signDigest(digest, KEY);

  const flipped = signatureFromDer(der(expected.r, order - expected.s), digest, ADDRESS);
  assert.equal(flipped.s, expected.s, 'the high twin should normalise back');
  assert.equal(recoverAddress(digest, flipped), ADDRESS);
});

test('a DER signature from the wrong key is refused, not silently accepted', () => {
  /**
   * The failure with no other symptom: a signer reconfigured to a different key still
   * returns a valid signature, and the transaction it produces is paid for by a
   * wallet we do not control.
   */
  const other = hexToBytes('0x' + '05'.repeat(32));
  const digest = hexToBytes('0x' + '42'.repeat(32));
  const signature = signDigest(digest, other);

  assert.throws(
    () => signatureFromDer(der(signature.r, signature.s), digest, ADDRESS),
    /does not recover to/,
  );
});

test('malformed DER is refused strictly', () => {
  const digest = hexToBytes('0x' + '42'.repeat(32));
  const valid = der(1n, 2n);

  for (const [label, bytes] of [
    ['not a sequence', Uint8Array.from([0x31, ...valid.subarray(1)])],
    ['truncated', valid.subarray(0, valid.length - 2)],
    ['trailing bytes', Uint8Array.from([...valid, 0x00])],
    ['zero components', der(0n, 0n)],
  ] as const) {
    assert.throws(() => signatureFromDer(bytes, digest, ADDRESS), SigningError, label);
  }
});

test('a redundant leading zero in DER is refused', () => {
  // Permissiveness on a signature path is how malleability bugs are born: two
  // encodings of one signature mean two valid transaction hashes.
  const padded = Uint8Array.from([0x30, 0x08, 0x02, 0x02, 0x00, 0x01, 0x02, 0x02, 0x00, 0x02]);
  assert.throws(() => signatureFromDer(padded, new Uint8Array(32), ADDRESS), SigningError);
});

test('big-endian conversion round-trips and refuses overflow', () => {
  assert.equal(bytesToBigInt(Uint8Array.of(0x01, 0x00)), 256n);
  assert.deepEqual(bigIntToBytes(256n, 2), Uint8Array.of(0x01, 0x00));
  assert.throws(() => bigIntToBytes(256n, 1), SigningError);
});

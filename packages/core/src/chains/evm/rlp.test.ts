import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RlpError, bytesToHex, hexToBytes, rlpEncode, rlpInt } from './rlp.js';

/**
 * Every expectation here comes from the Ethereum yellow paper's RLP appendix or the
 * canonical test vectors, not from running this implementation and recording what it
 * produced. A test written the second way passes forever and proves nothing.
 */

const encodeHex = (input: Parameters<typeof rlpEncode>[0]) => bytesToHex(rlpEncode(input));
const ascii = (text: string) => new TextEncoder().encode(text);

test('the specification examples encode exactly', () => {
  // "dog" → 0x83 'd' 'o' 'g'
  assert.equal(encodeHex(ascii('dog')), '0x83646f67');
  // ["cat", "dog"] → 0xc8 0x83 c a t 0x83 d o g
  assert.equal(encodeHex([ascii('cat'), ascii('dog')]), '0xc88363617483646f67');
  // The empty string and the empty list.
  assert.equal(encodeHex(new Uint8Array(0)), '0x80');
  assert.equal(encodeHex([]), '0xc0');
  // A single byte below 0x80 is itself, with no prefix.
  assert.equal(encodeHex(Uint8Array.of(0x0f)), '0x0f');
  // 0x80 needs a prefix, because it collides with the empty-string marker.
  assert.equal(encodeHex(Uint8Array.of(0x80)), '0x8180');
  // Two bytes.
  assert.equal(encodeHex(Uint8Array.of(0x04, 0x00)), '0x820400');
});

test('the 55-byte boundary switches to a length-of-length prefix', () => {
  // 55 bytes is the last short form: 0x80 + 55 = 0xb7.
  assert.equal(bytesToHex(rlpEncode(new Uint8Array(55))).slice(0, 4), '0xb7');
  // 56 bytes is the first long form: 0xb8, then one length byte, 0x38.
  assert.equal(bytesToHex(rlpEncode(new Uint8Array(56))).slice(0, 6), '0xb838');
  // 1024 bytes needs two length bytes: 0xb9 0x04 0x00.
  assert.equal(bytesToHex(rlpEncode(new Uint8Array(1024))).slice(0, 8), '0xb90400');
});

test('the specification long-string example encodes exactly', () => {
  const lorem = ascii('Lorem ipsum dolor sit amet, consectetur adipisicing elit');
  assert.equal(lorem.length, 56);
  assert.equal(encodeHex(lorem).slice(0, 6), '0xb838');
});

test('zero encodes as the empty string, not as a zero byte', () => {
  /**
   * The single most consequential RLP detail for this project. A transaction with
   * `value: 0` encoded as 0x00 rather than 0x hashes differently, so the signature
   * covers a transaction the network will not accept — and the failure surfaces only
   * on broadcast, after the settlement runner has advanced its nonce.
   */
  assert.equal(bytesToHex(rlpInt(0)), '0x');
  assert.equal(bytesToHex(rlpInt(0n)), '0x');
  assert.equal(encodeHex(rlpInt(0)), '0x80');
});

test('integers encode minimally, with no leading zeros', () => {
  assert.equal(bytesToHex(rlpInt(1)), '0x01');
  assert.equal(bytesToHex(rlpInt(127)), '0x7f');
  assert.equal(bytesToHex(rlpInt(128)), '0x80');
  assert.equal(bytesToHex(rlpInt(256)), '0x0100');
  assert.equal(bytesToHex(rlpInt(1024)), '0x0400');
  // An odd-digit hex value must be padded on the left, not the right.
  assert.equal(bytesToHex(rlpInt(0xabcn)), '0x0abc');
});

test('an integer wider than 64 bits survives intact', () => {
  // Gas figures in wei routinely exceed 2^64; a value that came back whole proves
  // nothing was routed through Number.
  const huge = 2n ** 200n + 12345n;
  assert.equal(BigInt(bytesToHex(rlpInt(huge))), huge);
});

test('a negative integer is refused', () => {
  assert.throws(() => rlpInt(-1), RlpError);
});

test('nested lists encode recursively', () => {
  // The specification's "set theoretical representation of three": [ [], [[]], [ [], [[]] ] ]
  assert.equal(encodeHex([[], [[]], [[], [[]]]]), '0xc7c0c1c0c3c0c1c0');
});

test('hex parsing is strict about length and alphabet', () => {
  assert.deepEqual(hexToBytes('0x'), new Uint8Array(0));
  assert.deepEqual(hexToBytes('0xff00'), Uint8Array.of(0xff, 0x00));
  assert.deepEqual(hexToBytes('ff00'), Uint8Array.of(0xff, 0x00));
  // Padding an odd-length string would silently shift every byte.
  assert.throws(() => hexToBytes('0xabc'), RlpError);
  assert.throws(() => hexToBytes('0xzz'), RlpError);
});

test('hex round-trips', () => {
  const bytes = Uint8Array.from({ length: 64 }, (_value, index) => (index * 7) % 256);
  assert.deepEqual(hexToBytes(bytesToHex(bytes)), bytes);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addressFromPrivateKey, recoverAddress, signDigest } from '../../crypto/secp256k1.js';
import { bytesToHex, hexToBytes } from './rlp.js';
import {
  TRANSACTION_TYPE,
  TransactionError,
  addressWord,
  serializeSigned,
  signingHash,
  signingPayload,
  word,
} from './transaction.js';
import type { Eip1559Transaction } from './transaction.js';

const KEY = hexToBytes('0x4646464646464646464646464646464646464646464646464646464646464646');
const SENDER = addressFromPrivateKey(KEY);

const base: Eip1559Transaction = {
  chainId: 56,
  nonce: 7,
  maxPriorityFeePerGas: 1_000_000_000n,
  maxFeePerGas: 3_000_000_000n,
  gasLimit: 120_000n,
  to: '0x55d398326f99059fF775485246999027B3197955',
  value: 0n,
  data: hexToBytes('0xa9059cbb'),
};

test('the signing payload begins with the type byte, outside the RLP', () => {
  /**
   * The detail that catches people out. A typed transaction hashed as bare RLP
   * produces a signature that recovers to a different address — the network accepts
   * it, and the gas is paid by a wallet nobody controls.
   */
  const payload = signingPayload(base);
  assert.equal(payload[0], TRANSACTION_TYPE);
  // 0xf8.. or 0xf9.. is an RLP list; the type byte must not be inside it.
  assert.ok(payload[1]! >= 0xc0, 'the byte after the type must open an RLP list');
});

test('a signed transaction recovers to the sender', () => {
  const signature = signDigest(signingHash(base), KEY);
  assert.equal(recoverAddress(signingHash(base), signature), SENDER);

  const { raw, hash } = serializeSigned(base, signature);
  assert.ok(raw.startsWith('0x02'), 'a type-2 transaction is prefixed 0x02');
  assert.equal(hash.length, 66);
});

test('the same transaction always serialises identically', () => {
  // Signing is deterministic, so the broadcast bytes must be too — otherwise a retry
  // produces a second transaction at the same nonce rather than the same one.
  const first = serializeSigned(base, signDigest(signingHash(base), KEY));
  const second = serializeSigned(base, signDigest(signingHash(base), KEY));
  assert.deepEqual(first, second);
});

test('changing any field changes the hash', () => {
  const original = bytesToHex(signingPayload(base));

  const variants: Eip1559Transaction[] = [
    { ...base, chainId: 137 },
    { ...base, nonce: 8 },
    { ...base, maxFeePerGas: 3_000_000_001n },
    { ...base, maxPriorityFeePerGas: 999_999_999n },
    { ...base, gasLimit: 120_001n },
    { ...base, to: '0x0000000000000000000000000000000000000001' },
    { ...base, value: 1n },
    { ...base, data: hexToBytes('0xa9059cbc') },
  ];

  for (const variant of variants) {
    assert.notEqual(bytesToHex(signingPayload(variant)), original);
  }
});

test('a zero value and empty data encode as empty strings', () => {
  /**
   * The RLP rule that matters most here. `value: 0` encoded as 0x00 rather than 0x
   * yields a different hash, so the signature covers a transaction the network refuses
   * — discovered on broadcast, after the runner has advanced its nonce.
   */
  const empty = signingPayload({ ...base, value: 0n, data: new Uint8Array(0) });
  const hex = bytesToHex(empty);
  // ...80 80 c0 at the tail: empty value, empty data, empty access list.
  assert.ok(hex.endsWith('8080c0'), `tail was ${hex.slice(-12)}`);
});

test('the access list is an empty list, not an empty string', () => {
  // 0xc0 is an empty list; 0x80 would be an empty string and hash differently.
  assert.ok(bytesToHex(signingPayload(base)).endsWith('c0'));
});

test('a contract deployment encodes an empty destination', () => {
  const deploy = signingPayload({ ...base, to: null });
  assert.ok(bytesToHex(deploy).includes('80'), 'a null destination is the empty string');
});

test('a tip above the fee ceiling is refused before signing', () => {
  /**
   * Refused here rather than by the node. A node's rejection arrives after the
   * settlement runner has already advanced its nonce, and every later settlement then
   * queues behind a gap that will never be filled.
   */
  assert.throws(
    () => signingHash({ ...base, maxPriorityFeePerGas: 4_000_000_000n }),
    TransactionError,
  );
});

test('nonsensical fields are refused', () => {
  for (const [label, transaction] of [
    ['zero chainId', { ...base, chainId: 0 }],
    ['negative nonce', { ...base, nonce: -1 }],
    ['fractional nonce', { ...base, nonce: 1.5 }],
    ['zero gas limit', { ...base, gasLimit: 0n }],
    ['negative value', { ...base, value: -1n }],
    ['short address', { ...base, to: '0x1234' }],
  ] as const) {
    assert.throws(() => signingHash(transaction), TransactionError, label);
  }
});

test('a recovery id outside 0 and 1 is refused', () => {
  const signature = signDigest(signingHash(base), KEY);
  assert.throws(() => serializeSigned(base, { ...signature, recovery: 2 }), TransactionError);
});

test('r and s are encoded minimally, with leading zeros stripped', () => {
  /**
   * RLP integers carry no leading zeros. A signature whose r happens to start with a
   * zero byte would, if padded to 32 bytes, produce a transaction most nodes reject
   * as non-canonical — and it only happens for roughly one signature in 256, which is
   * exactly often enough to be a mystery in production.
   */
  const small = { r: 1n, s: 2n, recovery: 0 };
  const { raw } = serializeSigned(base, small);
  // ...01 02 at the tail, not 32 padded bytes each.
  assert.ok(raw.endsWith('0102'), `tail was ${raw.slice(-8)}`);
});

test('call data words are left-padded to 32 bytes', () => {
  assert.equal(bytesToHex(word(1n)), `0x${'00'.repeat(31)}01`);
  assert.equal(
    bytesToHex(addressWord('0x55d398326f99059fF775485246999027B3197955')),
    `0x${'00'.repeat(12)}55d398326f99059ff775485246999027b3197955`,
  );
  assert.throws(() => word(new Uint8Array(33)), TransactionError);
});

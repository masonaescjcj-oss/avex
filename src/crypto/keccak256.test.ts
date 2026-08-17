import assert from 'node:assert/strict';
import { test } from 'node:test';

import { keccak256Hex } from './keccak256.js';

/**
 * Published Keccak-256 vectors. These guard against the most damaging possible
 * bug in this codebase: a hash that looks plausible but disagrees with the EVM,
 * which would hand payers deposit addresses that CREATE2 never produces.
 */
test('keccak256 matches known vectors', () => {
  assert.equal(
    keccak256Hex(''),
    '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
  );
  assert.equal(
    keccak256Hex('abc'),
    '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45',
  );
  assert.equal(
    keccak256Hex('hello'),
    '0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8',
  );
});

test('keccak256 is well-formed and injective across the rate boundary', () => {
  // 135, 136 and 137 bytes exercise the block just under, exactly at, and just
  // over the 136-byte sponge rate, where padding bugs hide.
  const digests = new Map<number, string>();
  for (const length of [1, 135, 136, 137, 271, 272, 273]) {
    const digest = keccak256Hex('a'.repeat(length));
    assert.match(digest, /^0x[0-9a-f]{64}$/, `malformed digest at length ${length}`);
    digests.set(length, digest);
  }

  const unique = new Set(digests.values());
  assert.equal(unique.size, digests.size, 'distinct inputs collided');
});

test('keccak256 is deterministic', () => {
  assert.equal(keccak256Hex('avex-pay'), keccak256Hex('avex-pay'));
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';

import { toHex } from './keccak256.js';
import { sha256, sha256d } from './sha256.js';

/**
 * Checked against two independent references, because one would not be enough.
 *
 * The published vectors catch a wrong constant table. Node's own implementation catches
 * everything else — padding at a block boundary, the 64-bit length field, the signed-integer
 * trap in the compression loop — across lengths chosen to land either side of every boundary
 * this code has.
 */

const hex = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('sha256', () => {
  test('the published vectors', () => {
    // FIPS 180-4 examples, plus the empty string, which exercises padding on its own.
    assert.equal(
      toHex(sha256(new Uint8Array(0))),
      '0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    assert.equal(
      toHex(sha256(hex('abc'))),
      '0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    assert.equal(
      toHex(sha256(hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))),
      '0x248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  test('agrees with node across every length that changes the padding', () => {
    /**
     * 55, 56, 63, 64, 65 are the ones that matter: 55 is the last length that fits its
     * length field in the same block, 56 is the first that does not, and 64 is exactly one
     * block. A `+ 1` where the spec says `+ 9` passes at 54 and fails at 55.
     */
    for (const length of [0, 1, 3, 54, 55, 56, 57, 63, 64, 65, 119, 120, 128, 200, 1000]) {
      const input = new Uint8Array(length);
      for (let i = 0; i < length; i++) input[i] = (i * 7 + 13) & 0xff;

      const expected = `0x${createHash('sha256').update(input).digest('hex')}`;
      assert.equal(toHex(sha256(input)), expected, `length ${length}`);
    }
  });

  test('sha256d is the digest of the digest', () => {
    const input = hex('avex');
    assert.deepEqual(sha256d(input), sha256(sha256(input)));
    assert.equal(
      toHex(sha256d(input)),
      `0x${createHash('sha256').update(createHash('sha256').update(input).digest()).digest('hex')}`,
    );
  });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { QrError, encodeQr, formatBits, reedSolomon } from './qr.js';

/**
 * What can and cannot be checked here.
 *
 * The deterministic parts — Reed-Solomon over GF(256), the BCH format bits, module
 * counts, the finder and timing patterns — are checked against the standard's own
 * published values, so an error in the arithmetic or the layout fails here.
 *
 * What these cannot establish is that a phone reads the result. A physical scan
 * test belongs in the checkout's own QA before this is shown to a payer.
 */

test('format bits match the standard published values', () => {
  // Level M with mask 0 is the canonical example: 0b101010000010010.
  assert.equal(formatBits(0), 0b101010000010010);
  // Every mask must produce a distinct 15-bit string.
  const all = new Set(Array.from({ length: 8 }, (_, mask) => formatBits(mask)));
  assert.equal(all.size, 8);
  for (const bits of all) assert.ok(bits <= 0x7fff);
});

test('Reed-Solomon reproduces a known codeword set', () => {
  // The standard's worked example: the message below with 10 EC codewords yields
  // these remainders. A wrong primitive polynomial or generator changes them.
  const data = new Uint8Array([
    0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec,
    0x11,
  ]);
  const ec = reedSolomon(data, 10);

  assert.equal(ec.length, 10);
  assert.deepEqual(
    Array.from(ec),
    [0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55],
  );
});

test('error correction length is respected', () => {
  for (const length of [10, 16, 18, 24, 26]) {
    assert.equal(reedSolomon(new Uint8Array([1, 2, 3, 4]), length).length, length);
  }
});

test('an EVM address encodes to a version 3 symbol', () => {
  // 42 characters is 4 mode bits + 8 length bits + 336 data + 4 terminator = 44
  // codewords, which is exactly version 3's capacity at level M.
  const code = encodeQr('0x55d398326f99059fF775485246999027B3197955');
  assert.equal(code.version, 3);
  assert.equal(code.size, 29, 'version 3 is 29 modules square');
});

test('module count follows the version formula', () => {
  for (const [text, size] of [
    ['short', 21],
    ['0x55d398326f99059fF775485246999027B3197955', 29],
    ['x'.repeat(60), 33],
  ] as const) {
    assert.equal(encodeQr(text).size, size, text.slice(0, 12));
  }
});

test('finder patterns are present in all three corners', () => {
  const code = encodeQr('0x55d398326f99059fF775485246999027B3197955');
  const { modules, size } = code;

  for (const [row, col] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ] as const) {
    // Outer ring dark, inner ring light, 3x3 core dark.
    assert.equal(modules[row]![col], true, 'outer corner');
    assert.equal(modules[row + 1]![col + 1], false, 'separator ring');
    assert.equal(modules[row + 3]![col + 3], true, 'core');
  }
});

test('timing patterns alternate', () => {
  const { modules, size } = encodeQr('0x55d398326f99059fF775485246999027B3197955');
  for (let i = 8; i < size - 8; i++) {
    assert.equal(modules[6]![i], i % 2 === 0, `horizontal timing at ${i}`);
    assert.equal(modules[i]![6], i % 2 === 0, `vertical timing at ${i}`);
  }
});

test('the dark module beside the lower-left finder is set', () => {
  const { modules, size } = encodeQr('test');
  assert.equal(modules[size - 8]![8], true);
});

test('the same input always produces the same symbol', () => {
  // Mask selection is by penalty score, so it must be deterministic — otherwise
  // two renders of one invoice would differ and look like a bug to a payer.
  const first = encodeQr('0x55d398326f99059fF775485246999027B3197955');
  const second = encodeQr('0x55d398326f99059fF775485246999027B3197955');
  assert.deepEqual(first.modules, second.modules);
});

test('different inputs produce different symbols', () => {
  const a = encodeQr('0x1111111111111111111111111111111111111111');
  const b = encodeQr('0x2222222222222222222222222222222222222222');
  assert.notDeepEqual(a.modules, b.modules);
});

test('dark and light are reasonably balanced', () => {
  // Heavy imbalance is what the penalty score exists to avoid, and a symbol far
  // from even is a sign masking was not applied.
  const code = encodeQr('0x55d398326f99059fF775485246999027B3197955');
  const dark = code.modules.flat().filter(Boolean).length;
  const ratio = dark / (code.size * code.size);
  assert.ok(ratio > 0.35 && ratio < 0.65, `dark ratio ${ratio.toFixed(2)} is skewed`);
});

test('a TON address and a payment URI both fit', () => {
  assert.ok(encodeQr('EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs').size > 0);
  assert.ok(
    encodeQr('ton://transfer/EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs?amount=20').size >
      0,
  );
});

test('oversized input is refused rather than silently truncated', () => {
  // Truncating would produce a scannable code pointing at the wrong address.
  assert.throws(() => encodeQr('x'.repeat(200)), QrError);
});

test('every row has exactly `size` modules', () => {
  const code = encodeQr('0x55d398326f99059fF775485246999027B3197955');
  assert.equal(code.modules.length, code.size);
  for (const row of code.modules) assert.equal(row.length, code.size);
});

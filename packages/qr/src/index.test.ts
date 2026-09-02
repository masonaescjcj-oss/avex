import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CAPACITY, QrError, TOTAL_CODEWORDS, encodeQr, formatBits, reedSolomon } from './index.js';

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
  // The canonical examples from the standard's format-information table.
  assert.equal(formatBits('M', 0), 0b101010000010010);
  assert.equal(formatBits('L', 0), 0b111011111000100);
  assert.equal(formatBits('L', 7), 0b110100101110110);
  assert.equal(formatBits('M', 7), 0b100101010100000);

  // Every level-and-mask pair must produce a distinct 15-bit string. A level that
  // shared its bits with another would be decoded with the wrong redundancy, which
  // reads as a corrupt symbol rather than as a wrong one.
  const all = new Set(
    (['L', 'M'] as const).flatMap((level) =>
      Array.from({ length: 8 }, (_, mask) => formatBits(level, mask)),
    ),
  );
  assert.equal(all.size, 16);
  for (const bits of all) assert.ok(bits <= 0x7fff);
});

test('both capacity tables add up to the version totals', () => {
  /**
   * The tables are transcribed from the standard, and a transcription error in one
   * number produces a symbol that is structurally valid and undecodable — a reader
   * would consume error correction codewords as data. Data plus error correction has
   * to come to exactly the version's total codeword count, which checks every row
   * without having to trust the row.
   */
  assert.equal(CAPACITY.length, 12, 'six versions at each of two levels');

  /**
   * The published table, restated here.
   *
   * A duplicate on purpose. The totals check below catches a row that does not add up,
   * but not a row that adds up wrongly — 136 data codewords in one block of 36 error
   * correction codewords comes to version 6's 172 exactly as the real two blocks of 18
   * do, and produces a symbol no reader can decode. Block counts come from the
   * standard's table and from nowhere else, so the only defence against a typo is a
   * second copy of it that the encoder does not read. What this cannot catch is the
   * same row misread twice; nothing short of an independent decoder can.
   */
  const PUBLISHED: readonly (readonly [string, number, number, number, number])[] = [
    ['M', 1, 16, 10, 1],
    ['M', 2, 28, 16, 1],
    ['M', 3, 44, 26, 1],
    ['M', 4, 64, 18, 2],
    ['M', 5, 86, 24, 2],
    ['M', 6, 108, 16, 4],
    ['L', 1, 19, 7, 1],
    ['L', 2, 34, 10, 1],
    ['L', 3, 55, 15, 1],
    ['L', 4, 80, 20, 1],
    ['L', 5, 108, 26, 1],
    ['L', 6, 136, 18, 2],
  ];
  for (const [level, version, dataCodewords, ecPerBlock, blocks] of PUBLISHED) {
    const row = CAPACITY.find((entry) => entry.level === level && entry.version === version);
    assert.deepEqual(
      row && { ...row },
      { level, version, dataCodewords, ecPerBlock, blocks },
      `version ${version} at level ${level}`,
    );
  }

  for (const row of CAPACITY) {
    assert.equal(
      row.dataCodewords + row.ecPerBlock * row.blocks,
      TOTAL_CODEWORDS[row.version - 1],
      `version ${row.version} at level ${row.level}`,
    );
    // Equal-sized blocks are the whole reason this encoder stops at version 6.
    assert.equal(row.dataCodewords % row.blocks, 0, `version ${row.version} splits evenly`);
  }

  // L holds more than M at every version, or the fall-back buys nothing.
  for (let version = 1; version <= 6; version++) {
    const at = (level: 'L' | 'M') =>
      CAPACITY.find((row) => row.level === level && row.version === version)!.dataCodewords;
    assert.ok(at('L') > at('M'), `version ${version}`);
  }
});

test('level M is used wherever it fits, and L only past it', () => {
  /**
   * The ordering, pinned. It is what makes adding level L a change to nothing that
   * already worked: every payload up to M's 108 bytes still comes out at M, byte for
   * byte as before, and only what M cannot hold falls to L.
   */
  // 106 bytes is the last payload version 6 holds at M: four mode bits, eight of
  // length and four of terminator take the other two codewords.
  assert.equal(encodeQr('x'.repeat(106)).level, 'M');
  assert.equal(encodeQr('x'.repeat(106)).version, 6);
  assert.equal(encodeQr('x'.repeat(107)).level, 'L');
  assert.equal(encodeQr('x'.repeat(107)).version, 6);
  assert.equal(encodeQr('x'.repeat(134)).level, 'L');

  // Small payloads are unaffected — a level chosen by payload size, not by preference.
  assert.equal(encodeQr('0x55d398326f99059fF775485246999027B3197955').level, 'M');
});

test('an authenticator enrolment URI fits', () => {
  /**
   * The one payload level M cannot hold. An `otpauth://` URI is 84 bytes before the
   * account address is in it, and the merchant dashboard has no other way to hand a
   * secret to a phone — so this failing means an enrolment page with no QR on it.
   */
  const uri =
    'otpauth://totp/AVEX%20Pay:merchant%40a-fairly-long-shop-name.example.com' +
    '?secret=H3FAVEP4E5NSWR5WJBB5JRAN3M6RB7SG&issuer=AVEX+Pay';
  assert.ok(uri.length > 106, 'the case being tested is a payload past level M');

  const code = encodeQr(uri);
  assert.equal(code.level, 'L');
  assert.equal(code.size, 41, 'version 6 is 41 modules square');
});

test('past the largest capacity it still refuses rather than truncating', () => {
  // 135 bytes is one past version 6 at level L, and the message has to name that real
  // figure — a caller told the limit is level M's would shorten to no purpose.
  assert.throws(
    () => encodeQr('x'.repeat(135)),
    (problem: unknown) => {
      assert.ok(problem instanceof QrError);
      assert.match(problem.message, /134 bytes/);
      return true;
    },
  );
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

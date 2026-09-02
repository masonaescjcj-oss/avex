/**
 * QR encoder — byte mode, versions 1 to 6, error correction level M or L.
 *
 * Written in-tree because a checkout without a working QR is not a checkout, and
 * the CSP on those pages forbids loading a library from a CDN. Scope is deliberately
 * narrow: every version in this range uses equal-sized error-correction blocks, so
 * the mixed-block interleaving that makes versions 7 and up fiddly never arises, and
 * neither does the version-information area they carry.
 *
 * Level M corrects roughly 15% damage and is the usual choice for a screen: a phone
 * camera reading a lit display needs less redundancy than a printed label, and the
 * higher a level, the smaller the modules for the same payload.
 *
 * Level L is the overflow. Level M tops out at 106 bytes of payload, which covers any
 * address or payment URI we produce — but not an `otpauth://` enrolment URI, which is
 * 84 bytes before the account's own address is in it. Rather than refuse to draw the
 * one QR a merchant setting up an authenticator needs, those fall to level L and its
 * 134. Nothing that fits at M is affected: the search tries M across every version
 * first, so every code this has ever produced comes out byte for byte the same.
 */

/** Data codewords, EC codewords per block, and block count, per version. */
interface VersionSpec {
  readonly version: number;
  readonly dataCodewords: number;
  readonly ecPerBlock: number;
  readonly blocks: number;
}

/** Level M: the default. */
const VERSIONS_M: readonly VersionSpec[] = [
  { version: 1, dataCodewords: 16, ecPerBlock: 10, blocks: 1 },
  { version: 2, dataCodewords: 28, ecPerBlock: 16, blocks: 1 },
  { version: 3, dataCodewords: 44, ecPerBlock: 26, blocks: 1 },
  { version: 4, dataCodewords: 64, ecPerBlock: 18, blocks: 2 },
  { version: 5, dataCodewords: 86, ecPerBlock: 24, blocks: 2 },
  { version: 6, dataCodewords: 108, ecPerBlock: 16, blocks: 4 },
];

/** Level L: more room, less redundancy. Only reached when nothing fits at M. */
const VERSIONS_L: readonly VersionSpec[] = [
  { version: 1, dataCodewords: 19, ecPerBlock: 7, blocks: 1 },
  { version: 2, dataCodewords: 34, ecPerBlock: 10, blocks: 1 },
  { version: 3, dataCodewords: 55, ecPerBlock: 15, blocks: 1 },
  { version: 4, dataCodewords: 80, ecPerBlock: 20, blocks: 1 },
  { version: 5, dataCodewords: 108, ecPerBlock: 26, blocks: 1 },
  { version: 6, dataCodewords: 136, ecPerBlock: 18, blocks: 2 },
];

/** Error correction level. Only the two the encoder implements. */
export type EcLevel = 'L' | 'M';

/**
 * The level's two bits, as the format information carries them.
 *
 * Not the same order as the levels read in: the standard numbers them L=01, M=00,
 * Q=11, H=10, and writing 00 for L would produce a code every reader decodes with the
 * wrong error correction — which is to say, does not decode at all.
 */
const LEVEL_BITS: Readonly<Record<EcLevel, number>> = { L: 0b01, M: 0b00 };

const TABLES: readonly (readonly [EcLevel, readonly VersionSpec[]])[] = [
  ['M', VERSIONS_M],
  ['L', VERSIONS_L],
];

/** Total codewords per version, which the two tables above must each add up to. */
export const TOTAL_CODEWORDS: readonly number[] = [26, 44, 70, 100, 134, 172];

/** Every row of both tables, flattened, so the totals above can be checked against them. */
export const CAPACITY: readonly (VersionSpec & { readonly level: EcLevel })[] = TABLES.flatMap(
  ([level, table]) => table.map((entry) => ({ ...entry, level })),
);

export class QrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QrError';
  }
}

// ── GF(256) arithmetic, for Reed-Solomon ──────────────────────────────────────

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(() => {
  let value = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = value;
    LOG[value] = i;
    value <<= 1;
    // The QR standard's primitive polynomial, x^8 + x^4 + x^3 + x^2 + 1.
    if (value & 0x100) value ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
})();

function gfMultiply(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

/** Generator polynomial of the given degree. */
function generatorPolynomial(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] = (next[j] ?? 0) ^ poly[j]!;
      next[j + 1] = (next[j + 1] ?? 0) ^ gfMultiply(poly[j]!, EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

export function reedSolomon(data: Uint8Array, ecLength: number): Uint8Array {
  const generator = generatorPolynomial(ecLength);
  const remainder = new Uint8Array(ecLength);

  for (const byte of data) {
    const factor = byte ^ (remainder[0] ?? 0);
    remainder.copyWithin(0, 1);
    remainder[ecLength - 1] = 0;
    for (let i = 0; i < ecLength; i++) {
      remainder[i] = (remainder[i] ?? 0) ^ gfMultiply(generator[i + 1]!, factor);
    }
  }
  return remainder;
}

// ── Bit assembly ──────────────────────────────────────────────────────────────

class BitWriter {
  private bits: number[] = [];

  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }

  get length(): number {
    return this.bits.length;
  }

  toCodewords(count: number): Uint8Array {
    // Terminator, then pad to a byte boundary.
    while (this.bits.length % 8 !== 0) this.bits.push(0);

    const bytes = new Uint8Array(count);
    for (let i = 0; i < this.bits.length / 8 && i < count; i++) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit++) byte = (byte << 1) | this.bits[i * 8 + bit]!;
      bytes[i] = byte;
    }

    // The standard's alternating pad bytes fill any remaining capacity.
    const PAD = [0xec, 0x11];
    for (let i = Math.ceil(this.bits.length / 8); i < count; i++) {
      bytes[i] = PAD[(i - Math.ceil(this.bits.length / 8)) % 2]!;
    }
    return bytes;
  }
}

interface Chosen extends VersionSpec {
  readonly level: EcLevel;
}

/**
 * The smallest code that holds the payload, at the strongest level that holds it.
 *
 * M is searched across every version before L is considered at all. That ordering is
 * deliberate: it keeps the redundancy up for everything that fits, and it means adding
 * L changed no code that already worked.
 */
function chooseVersion(byteLength: number): Chosen {
  // Mode indicator (4 bits) + character count (8) + data + terminator (4).
  const needed = Math.ceil((4 + 8 + byteLength * 8 + 4) / 8);
  for (const [level, table] of TABLES) {
    const found = table.find((entry) => entry.dataCodewords >= needed);
    if (found) return { ...found, level };
  }
  /** Capacity in bytes, which is what a caller counts, less the header and terminator. */
  const largest = VERSIONS_L[VERSIONS_L.length - 1]!.dataCodewords - 2;
  throw new QrError(
    `${byteLength} bytes exceeds the ${largest} bytes version 6 holds at level L; ` +
      'a larger version is not implemented',
  );
}

// ── Matrix construction ───────────────────────────────────────────────────────

/** -1 unset, 0 light, 1 dark. */
type Matrix = Int8Array[];

function blankMatrix(size: number): Matrix {
  return Array.from({ length: size }, () => new Int8Array(size).fill(-1));
}

function placeFinder(matrix: Matrix, row: number, col: number): void {
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const r = row + dr;
      const c = col + dc;
      if (r < 0 || c < 0 || r >= matrix.length || c >= matrix.length) continue;

      const inRing = dr === 0 || dr === 6 || dc === 0 || dc === 6;
      const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
      const inside = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
      matrix[r]![c] = inside && (inRing || inCore) ? 1 : 0;
    }
  }
}

function placeAlignment(matrix: Matrix, centre: number): void {
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      const outer = Math.max(Math.abs(dr), Math.abs(dc));
      matrix[centre + dr]![centre + dc] = outer === 1 ? 0 : 1;
    }
  }
}

function reserveFormatAreas(matrix: Matrix): void {
  const size = matrix.length;
  for (let i = 0; i < 9; i++) {
    if (matrix[8]![i] === -1) matrix[8]![i] = 0;
    if (matrix[i]![8] === -1) matrix[i]![8] = 0;
  }
  for (let i = 0; i < 8; i++) {
    if (matrix[8]![size - 1 - i] === -1) matrix[8]![size - 1 - i] = 0;
    if (matrix[size - 1 - i]![8] === -1) matrix[size - 1 - i]![8] = 0;
  }
}

function isFunctionModule(matrix: Matrix, row: number, col: number, size: number): boolean {
  // Everything already written during pattern placement is a function module.
  void matrix;
  void row;
  void col;
  void size;
  return false;
}

const MASKS: readonly ((row: number, col: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/**
 * Format information: two bits of EC level, three of mask, ten of BCH, XORed
 * with the standard's mask pattern.
 */
export function formatBits(level: EcLevel, maskIndex: number): number {
  const data = (LEVEL_BITS[level] << 3) | maskIndex;
  let bch = data << 10;
  for (let i = 4; i >= 0; i--) {
    if ((bch >>> (i + 10)) & 1) bch ^= 0x537 << i;
  }
  return ((data << 10) | (bch & 0x3ff)) ^ 0x5412;
}

function penalty(matrix: Matrix): number {
  const size = matrix.length;
  let score = 0;

  // Runs of five or more identical modules.
  for (let i = 0; i < size; i++) {
    for (const along of ['row', 'col'] as const) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        const current = along === 'row' ? matrix[i]![j] : matrix[j]![i];
        const previous = along === 'row' ? matrix[i]![j - 1] : matrix[j - 1]![i];
        if (current === previous) {
          run += 1;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  // Two-by-two blocks of one colour.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const value = matrix[r]![c];
      if (
        value === matrix[r]![c + 1] &&
        value === matrix[r + 1]![c] &&
        value === matrix[r + 1]![c + 1]
      ) {
        score += 3;
      }
    }
  }

  // Imbalance between dark and light.
  let dark = 0;
  for (const row of matrix) for (const value of row) if (value === 1) dark += 1;
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;

  return score;
}

export interface QrCode {
  readonly size: number;
  readonly version: number;
  /** Which error correction level held the payload. */
  readonly level: EcLevel;
  /** Row-major, true where dark. */
  readonly modules: readonly boolean[][];
}

export function encodeQr(text: string): QrCode {
  const bytes = new TextEncoder().encode(text);
  const spec = chooseVersion(bytes.length);
  const size = 17 + spec.version * 4;

  // Data bits: byte mode, then length, then the payload.
  const writer = new BitWriter();
  writer.push(0b0100, 4);
  writer.push(bytes.length, 8);
  for (const byte of bytes) writer.push(byte, 8);
  if (writer.length + 4 <= spec.dataCodewords * 8) writer.push(0, 4);

  const data = writer.toCodewords(spec.dataCodewords);

  // Split into equal blocks, compute EC for each, then interleave.
  const perBlock = spec.dataCodewords / spec.blocks;
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  for (let i = 0; i < spec.blocks; i++) {
    const block = data.slice(i * perBlock, (i + 1) * perBlock);
    dataBlocks.push(block);
    ecBlocks.push(reedSolomon(block, spec.ecPerBlock));
  }

  const interleaved: number[] = [];
  for (let i = 0; i < perBlock; i++) {
    for (const block of dataBlocks) interleaved.push(block[i]!);
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const block of ecBlocks) interleaved.push(block[i]!);
  }

  // Function patterns first, so data placement can skip them.
  const base = blankMatrix(size);
  placeFinder(base, 0, 0);
  placeFinder(base, 0, size - 7);
  placeFinder(base, size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    base[6]![i] = i % 2 === 0 ? 1 : 0;
    base[i]![6] = i % 2 === 0 ? 1 : 0;
  }
  if (spec.version >= 2) placeAlignment(base, size - 7);
  // The always-dark module beside the lower-left finder.
  base[size - 8]![8] = 1;
  reserveFormatAreas(base);

  const reserved = base.map((row) => row.slice());

  // Data in the standard's upward-then-downward column pairs.
  let bitIndex = 0;
  const allBits: number[] = [];
  for (const codeword of interleaved) {
    for (let i = 7; i >= 0; i--) allBits.push((codeword >>> i) & 1);
  }

  for (let right = size - 1; right >= 1; right -= 2) {
    const column = right === 6 ? right - 1 : right; // skip the timing column
    for (let step = 0; step < size; step++) {
      const upward = ((size - 1 - right) / 2) % 2 === 0;
      const row = upward ? size - 1 - step : step;
      for (const col of [column, column - 1]) {
        if (col < 0) continue;
        if (reserved[row]![col] !== -1) continue;
        base[row]![col] = (allBits[bitIndex++] ?? 0) as 0 | 1;
      }
    }
  }

  // Try every mask, keep the least penalised.
  let best: { matrix: Matrix; score: number; mask: number } | null = null;
  for (let mask = 0; mask < MASKS.length; mask++) {
    const candidate = base.map((row) => row.slice());
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (reserved[r]![c] !== -1) continue;
        if (MASKS[mask]!(r, c)) candidate[r]![c] = (candidate[r]![c] === 1 ? 0 : 1) as 0 | 1;
      }
    }
    writeFormat(candidate, spec.level, mask);

    const score = penalty(candidate);
    if (!best || score < best.score) best = { matrix: candidate, score, mask };
  }

  const chosen = best!.matrix;
  return {
    size,
    version: spec.version,
    level: spec.level,
    modules: chosen.map((row) => Array.from(row, (value) => value === 1)),
  };
}

function writeFormat(matrix: Matrix, level: EcLevel, mask: number): void {
  const size = matrix.length;
  const bits = formatBits(level, mask);

  for (let i = 0; i < 15; i++) {
    const bit = ((bits >>> i) & 1) as 0 | 1;

    // Copy beside the top-left finder.
    if (i < 6) matrix[8]![i] = bit;
    else if (i === 6) matrix[8]![7] = bit;
    else if (i === 7) matrix[8]![8] = bit;
    else if (i === 8) matrix[7]![8] = bit;
    else matrix[14 - i]![8] = bit;

    // And the split copy across the other two.
    if (i < 8) matrix[8]![size - 1 - i] = bit;
    else matrix[size - 15 + i]![8] = bit;
  }
}

void isFunctionModule;

/** Render to an SVG path string, one rect per dark module. */
export function qrToSvgPath(code: QrCode): string {
  const parts: string[] = [];
  for (let r = 0; r < code.size; r++) {
    for (let c = 0; c < code.size; c++) {
      if (code.modules[r]![c]) parts.push(`M${c} ${r}h1v1h-1z`);
    }
  }
  return parts.join('');
}

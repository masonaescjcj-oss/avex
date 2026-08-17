/**
 * Keccak-256, as used by Ethereum.
 *
 * Note this is the original Keccak padding (domain byte 0x01), not the NIST
 * SHA3-256 padding (0x06). Node's built-in `sha3-256` is the latter and produces
 * different digests — using it for address derivation would silently generate
 * deposit addresses that no on-chain CREATE2 ever matches.
 *
 * Implemented over BigInt lanes: clear enough to audit line by line, and fast
 * enough for what we hash here (addresses and short identifiers, never bulk data).
 */

const MASK64 = (1n << 64n) - 1n;
const ROUNDS = 24;
/** Keccak-256 rate: 1600 - 2*256 bits = 136 bytes. */
const RATE_BYTES = 136;

const ROUND_CONSTANTS: readonly bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

/** Rho rotation offsets, indexed as [x][y]; lane index is x + 5y. */
const ROTATION: readonly (readonly number[])[] = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

function rotl(lane: bigint, bits: number): bigint {
  if (bits === 0) return lane;
  const n = BigInt(bits);
  return ((lane << n) | (lane >> (64n - n))) & MASK64;
}

function permute(state: bigint[]): void {
  const b = new Array<bigint>(25).fill(0n);
  const c = new Array<bigint>(5).fill(0n);
  const d = new Array<bigint>(5).fill(0n);

  for (let round = 0; round < ROUNDS; round++) {
    // theta
    for (let x = 0; x < 5; x++) {
      c[x] = state[x]! ^ state[x + 5]! ^ state[x + 10]! ^ state[x + 15]! ^ state[x + 20]!;
    }
    for (let x = 0; x < 5; x++) {
      d[x] = c[(x + 4) % 5]! ^ rotl(c[(x + 1) % 5]!, 1);
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        state[x + 5 * y] = state[x + 5 * y]! ^ d[x]!;
      }
    }

    // rho and pi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(state[x + 5 * y]!, ROTATION[x]![y]!);
      }
    }

    // chi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        state[x + 5 * y] =
          b[x + 5 * y]! ^ (~b[((x + 1) % 5) + 5 * y]! & b[((x + 2) % 5) + 5 * y]!) & MASK64;
      }
    }

    // iota
    state[0] = state[0]! ^ ROUND_CONSTANTS[round]!;
  }
}

export function keccak256(input: Uint8Array): Uint8Array {
  // pad10*1 with the Keccak domain byte.
  const padLength = RATE_BYTES - (input.length % RATE_BYTES);
  const padded = new Uint8Array(input.length + padLength);
  padded.set(input);
  padded[input.length] = 0x01;
  padded[padded.length - 1] = (padded[padded.length - 1] ?? 0) | 0x80;

  const state = new Array<bigint>(25).fill(0n);

  for (let offset = 0; offset < padded.length; offset += RATE_BYTES) {
    for (let lane = 0; lane < RATE_BYTES / 8; lane++) {
      let value = 0n;
      // Lanes are little-endian.
      for (let byte = 7; byte >= 0; byte--) {
        value = (value << 8n) | BigInt(padded[offset + lane * 8 + byte] ?? 0);
      }
      state[lane] = state[lane]! ^ value;
    }
    permute(state);
  }

  const digest = new Uint8Array(32);
  for (let lane = 0; lane < 4; lane++) {
    let value = state[lane]!;
    for (let byte = 0; byte < 8; byte++) {
      digest[lane * 8 + byte] = Number(value & 0xffn);
      value >>= 8n;
    }
  }
  return digest;
}

export function toHex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error(`odd-length hex: ${hex}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function keccak256Hex(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return toHex(keccak256(bytes));
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

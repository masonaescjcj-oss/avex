import { sha256d } from '../../crypto/sha256.js';

/**
 * TRON addresses, in the two forms every TRON integration has to move between.
 *
 * A TRON address is 21 bytes: the constant `0x41`, then the same 20 bytes an EVM address is.
 * Users, block explorers and merchants see it Base58Check-encoded — `T…`, 34 characters.
 * Nodes and the TRC-20 contracts themselves use the raw hex. TronGrid returns whichever form
 * suits the endpoint, sometimes both in one response.
 *
 * Which is why this file exists rather than a pair of helpers next to their callers: the two
 * forms of the same address are not comparable as strings, and a system that stores one and
 * looks up the other finds nothing — a real payment to a real invoice, credited to no-one.
 *
 * ## Case is significant here, unlike on EVM
 *
 * An EVM address is hex, so `0xAB…` and `0xab…` are the same address and comparing them
 * case-insensitively is correct — which is what the rest of this codebase does, deliberately.
 * Base58 is not hex. Its alphabet contains both `A` and `a`, both `K` and `k`; it omits `0`,
 * `O`, `I` and `l` precisely so that a human cannot confuse the characters that remain. Fold
 * the case of a TRON address and you have destroyed information: the result is not a valid
 * address, and two distinct valid addresses can fold to the same string. Applied to a deposit
 * address lookup that is a payment credited to the wrong invoice.
 *
 * So: exact comparison for TRON, and `normalizeTronAddress` to get everything into one form
 * before it is stored, rather than a fold at the point of comparison.
 */

/** Bitcoin's alphabet, which TRON uses unchanged. No `0`, `O`, `I` or `l`. */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Reverse lookup, built once. A `Map` rather than `indexOf` per character. */
const INDEX = new Map<string, number>([...ALPHABET].map((char, i) => [char, i]));

/** The one-byte prefix that makes every mainnet TRON address start with `T`. */
export const TRON_ADDRESS_PREFIX = 0x41;

/** Bytes in a TRON address: the prefix plus the 20-byte body. */
const ADDRESS_BYTES = 21;

/** Base58Check appends the first four bytes of the double-SHA-256 of the payload. */
const CHECKSUM_BYTES = 4;

export function base58Encode(input: Uint8Array): string {
  if (input.length === 0) return '';

  /**
   * Base conversion through BigInt.
   *
   * The textbook version is repeated division over a byte array, which is faster and much
   * easier to get subtly wrong. These inputs are 25 bytes.
   */
  let value = 0n;
  for (const byte of input) value = value * 256n + BigInt(byte);

  let out = '';
  while (value > 0n) {
    out = ALPHABET[Number(value % 58n)]! + out;
    value /= 58n;
  }

  /**
   * Leading zero bytes are not carried by the number, so they are re-added as `1`s.
   *
   * No TRON address has one — the payload starts with 0x41 — but a codec that silently drops
   * them is a codec that cannot be reused, and this one is also how we will read TRC-20
   * contract addresses out of a config file.
   */
  for (const byte of input) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

export function base58Decode(input: string): Uint8Array {
  if (input.length === 0) return new Uint8Array(0);

  let value = 0n;
  for (const char of input) {
    const digit = INDEX.get(char);
    // Named in the message: `0`, `O`, `I` and `l` are the characters somebody typing an
    // address by hand will produce, and "invalid base58" alone does not say which one.
    if (digit === undefined) throw new Error(`not base58: ${JSON.stringify(char)} in ${input}`);
    value = value * 58n + BigInt(digit);
  }

  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value % 256n));
    value /= 256n;
  }

  for (const char of input) {
    if (char !== '1') break;
    bytes.unshift(0);
  }
  return new Uint8Array(bytes);
}

/** Strip an optional `0x`, and reject anything that is not clean hex. */
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error(`odd-length hex: ${hex}`);
  if (!/^[0-9a-fA-F]*$/.test(clean)) throw new Error(`not hex: ${hex}`);

  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The 21 raw bytes of an address, accepting any form we might be handed.
 *
 * Three forms are in circulation and all three arrive from somewhere real: Base58Check from
 * a merchant or an explorer, 21-byte hex from a TronGrid response, and 20-byte hex from
 * anything that has been through EVM-shaped tooling — the CREATE2 computation included,
 * which knows nothing about TRON's prefix.
 */
function addressBytes(address: string): Uint8Array {
  const trimmed = address.trim();
  if (trimmed === '') throw new Error('empty address');

  if (trimmed.startsWith('T')) {
    const decoded = base58Decode(trimmed);
    if (decoded.length !== ADDRESS_BYTES + CHECKSUM_BYTES) {
      throw new Error(`not a TRON address: ${trimmed} decodes to ${decoded.length} bytes`);
    }

    const payload = decoded.subarray(0, ADDRESS_BYTES);
    const checksum = decoded.subarray(ADDRESS_BYTES);
    const expected = sha256d(payload).subarray(0, CHECKSUM_BYTES);
    for (let i = 0; i < CHECKSUM_BYTES; i++) {
      /**
       * The checksum is the whole point of Base58Check and the reason a mistyped address is
       * a rejection rather than a loss. Refuse loudly: a payout address that fails here
       * would otherwise become 21 bytes of nonsense that funds are swept to, once.
       */
      if (checksum[i] !== expected[i]) throw new Error(`bad checksum: ${trimmed}`);
    }
    return payload;
  }

  const raw = hexToBytes(trimmed);
  if (raw.length === ADDRESS_BYTES) {
    if (raw[0] !== TRON_ADDRESS_PREFIX) {
      throw new Error(`not a TRON address: 21 bytes but prefix 0x${raw[0]!.toString(16)}`);
    }
    return raw;
  }
  if (raw.length === 20) {
    const out = new Uint8Array(ADDRESS_BYTES);
    out[0] = TRON_ADDRESS_PREFIX;
    out.set(raw, 1);
    return out;
  }
  throw new Error(`not a TRON address: ${raw.length} bytes`);
}

/** Canonical form for storage and comparison: Base58Check, exactly as a merchant sees it. */
export function normalizeTronAddress(address: string): string {
  const payload = addressBytes(address);
  const checksum = sha256d(payload).subarray(0, CHECKSUM_BYTES);
  const out = new Uint8Array(ADDRESS_BYTES + CHECKSUM_BYTES);
  out.set(payload);
  out.set(checksum, ADDRESS_BYTES);
  return base58Encode(out);
}

/** The 21-byte form, `41…`, which is what TronGrid and the node APIs take. */
export function tronAddressToHex(address: string): string {
  return bytesToHex(addressBytes(address));
}

/**
 * The 20-byte body as an EVM-shaped address, `0x…`.
 *
 * What the CREATE2 derivation and the TRC-20 ABI encoder need: TVM is EVM underneath, and
 * neither of them has ever heard of the `0x41` prefix.
 */
export function tronAddressToEvmHex(address: string): string {
  return `0x${bytesToHex(addressBytes(address).subarray(1))}`;
}

/** The Base58Check address for a 20-byte EVM-shaped address — the inverse of the above. */
export function tronAddressFromEvmHex(hex: string): string {
  const raw = hexToBytes(hex);
  if (raw.length !== 20) throw new Error(`not a 20-byte address: ${hex}`);
  return normalizeTronAddress(hex);
}

/** Whether this is a well-formed TRON address in any of the three accepted forms. */
export function isTronAddress(address: string): boolean {
  try {
    addressBytes(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Equality for TRON addresses, across forms.
 *
 * Exists so that no caller is tempted to reach for `toLowerCase()` — which is right for EVM
 * and silently wrong here. Two addresses are equal when their 21 bytes are equal, whatever
 * form each arrived in.
 */
export function tronAddressesEqual(left: string, right: string): boolean {
  try {
    return tronAddressToHex(left) === tronAddressToHex(right);
  } catch {
    return false;
  }
}

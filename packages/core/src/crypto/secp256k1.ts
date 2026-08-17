import { secp256k1 } from '@noble/curves/secp256k1.js';

import { keccak256 } from './keccak256.js';
import { bytesToHex, hexToBytes } from '../chains/evm/rlp.js';

/**
 * Signing for EVM chains.
 *
 * This module is a thin wrapper over an audited library and nothing more. Elliptic
 * curve arithmetic is the one part of this system that must not be written here: a
 * mistake in RLP produces a transaction the network rejects, which is loud, while a
 * mistake in scalar arithmetic or nonce generation leaks the private key, which is
 * silent and unrecoverable. The wrapper exists only to convert between the library's
 * shapes and Ethereum's.
 *
 * What it does add is the two conversions Ethereum needs and the library does not
 * do: deriving an address from a public key, and normalising a signature that
 * arrives from an external signer in DER form without a recovery id — which is
 * exactly what AWS KMS and most HSMs return.
 */

export class SigningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SigningError';
  }
}

export interface Signature {
  readonly r: bigint;
  readonly s: bigint;
  /** 0 or 1. Ethereum's `yParity` for typed transactions. */
  readonly recovery: number;
}

/** Half the curve order. An `s` above this is the malleable twin of a valid one. */
const HALF_ORDER = secp256k1.Point.Fn.ORDER / 2n;
const ORDER = secp256k1.Point.Fn.ORDER;

/**
 * Sign a 32-byte digest that has already been hashed.
 *
 * `prehash: false` is load-bearing. The digest passed in is a Keccak-256 hash of the
 * transaction; letting the library hash it again would sign the wrong thing, and the
 * resulting transaction would recover to an address nobody controls.
 */
export function signDigest(digest: Uint8Array, privateKey: Uint8Array): Signature {
  if (digest.length !== 32) throw new SigningError(`digest must be 32 bytes, got ${digest.length}`);
  assertPrivateKey(privateKey);

  const recovered = secp256k1.sign(digest, privateKey, { prehash: false, format: 'recovered' });
  // Recovered form is [recovery, r(32), s(32)].
  const recovery = recovered[0]!;
  const r = bytesToBigInt(recovered.subarray(1, 33));
  const s = bytesToBigInt(recovered.subarray(33, 65));

  // The library already produces the low-`s` form; assert it rather than assume it,
  // because a high `s` is rejected by EIP-2 and the failure would only appear on
  // broadcast, after the runner had already advanced its nonce.
  if (s > HALF_ORDER) throw new SigningError('signature has a high s value');
  return { r, s, recovery };
}

/** The uncompressed public key for a private key, without its 0x04 prefix. */
export function publicKeyFor(privateKey: Uint8Array): Uint8Array {
  assertPrivateKey(privateKey);
  return secp256k1.getPublicKey(privateKey, false).subarray(1);
}

/**
 * The checksummed address for a public key.
 *
 * Accepts either the 64-byte body or the 65-byte form with its 0x04 prefix, because
 * external signers disagree about which they return and silently hashing the prefix
 * byte would yield a plausible address for a key nobody holds.
 */
export function addressFromPublicKey(publicKey: Uint8Array): string {
  let body = publicKey;
  if (body.length === 65) {
    if (body[0] !== 0x04) throw new SigningError('65-byte public key is not uncompressed');
    body = body.subarray(1);
  }
  if (body.length !== 64) throw new SigningError(`public key must be 64 bytes, got ${body.length}`);

  return toChecksum(bytesToHex(keccak256(body).subarray(12)));
}

export function addressFromPrivateKey(privateKey: Uint8Array): string {
  return addressFromPublicKey(publicKeyFor(privateKey));
}

/**
 * Recover the address that produced a signature.
 *
 * Used to verify an external signer returned what we expected before broadcasting.
 * A KMS that has been reconfigured to a different key would otherwise be discovered
 * when the funds arrived somewhere unexpected.
 */
export function recoverAddress(digest: Uint8Array, signature: Signature): string {
  const compact = new Uint8Array(65);
  compact[0] = signature.recovery;
  compact.set(bigIntToBytes(signature.r, 32), 1);
  compact.set(bigIntToBytes(signature.s, 32), 33);

  /**
   * Recovery hands back a *compressed* key, which is 33 bytes and cannot be hashed
   * into an address. Decompressing through the curve point is the only correct route —
   * hashing the compressed form yields a plausible address for nothing at all.
   */
  const compressed = secp256k1.recoverPublicKey(compact, digest, { prehash: false });
  const point = secp256k1.Point.fromBytes(
    typeof compressed === 'string' ? hexToBytes(compressed) : compressed,
  );
  return addressFromPublicKey(point.toBytes(false));
}

/**
 * Normalise a DER signature from an external signer into Ethereum's form.
 *
 * External signers — AWS KMS, most HSMs — return DER and no recovery id, and they do
 * not enforce the low-`s` rule. Both gaps have to be closed here:
 *
 * `s` above half the curve order is flipped to `ORDER - s`, which is the same
 * signature in the only sense that matters and the only form EIP-2 permits.
 *
 * The recovery id is then found by trying both candidates and keeping the one that
 * recovers to the address we expect. Trying rather than deriving is not laziness: it
 * doubles as a check that the signer holds the key we think it does, which is worth
 * more than the microseconds it costs once per settlement.
 */
export function signatureFromDer(
  der: Uint8Array,
  digest: Uint8Array,
  expectedAddress: string,
): Signature {
  const { r, s } = decodeDer(der);
  const normalised = s > HALF_ORDER ? ORDER - s : s;
  const wanted = expectedAddress.toLowerCase();

  for (const recovery of [0, 1]) {
    const candidate: Signature = { r, s: normalised, recovery };
    try {
      if (recoverAddress(digest, candidate).toLowerCase() === wanted) return candidate;
    } catch {
      // An unrecoverable candidate is simply the wrong one.
    }
  }

  throw new SigningError(
    `signature does not recover to ${expectedAddress}; the signer may hold a different key`,
  );
}

/** EIP-55: the case of each hex digit encodes a checksum over the lowercase form. */
export function toChecksum(address: string): string {
  const body = address.toLowerCase().replace(/^0x/, '');
  const hash = keccak256(new TextEncoder().encode(body));

  let out = '0x';
  for (let i = 0; i < body.length; i++) {
    const nibble = i % 2 === 0 ? hash[i >> 1]! >> 4 : hash[i >> 1]! & 0x0f;
    const character = body[i]!;
    out += nibble >= 8 ? character.toUpperCase() : character;
  }
  return out;
}

function assertPrivateKey(key: Uint8Array): void {
  if (key.length !== 32) throw new SigningError(`private key must be 32 bytes, got ${key.length}`);
  const value = bytesToBigInt(key);
  // Zero and anything at or above the curve order are not valid scalars; some
  // libraries accept them and produce garbage rather than refusing.
  if (value === 0n || value >= ORDER) throw new SigningError('private key is out of range');
}

export function bytesToBigInt(bytes: Uint8Array): bigint {
  let out = 0n;
  for (const byte of bytes) out = (out << 8n) | BigInt(byte);
  return out;
}

export function bigIntToBytes(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let remaining = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  if (remaining !== 0n) throw new SigningError('value does not fit the requested length');
  return out;
}

/**
 * Minimal DER reader for `SEQUENCE { INTEGER r, INTEGER s }`.
 *
 * Deliberately strict. A permissive parser on a signature path is how signature
 * malleability bugs are born, and there is exactly one shape a signer should ever
 * send.
 */
function decodeDer(der: Uint8Array): { r: bigint; s: bigint } {
  let offset = 0;
  const byte = () => {
    if (offset >= der.length) throw new SigningError('DER signature ended early');
    return der[offset++]!;
  };

  if (byte() !== 0x30) throw new SigningError('DER signature is not a SEQUENCE');
  const sequenceLength = byte();
  if (sequenceLength !== der.length - 2) throw new SigningError('DER length does not match');

  const readInteger = (): bigint => {
    if (byte() !== 0x02) throw new SigningError('DER component is not an INTEGER');
    const length = byte();
    if (length === 0) throw new SigningError('DER INTEGER is empty');
    if (offset + length > der.length) throw new SigningError('DER INTEGER runs past the end');

    const slice = der.subarray(offset, offset + length);
    offset += length;
    // DER integers are signed, so a leading 0x00 pads a value whose top bit is set.
    if (slice[0] === 0x00 && slice.length > 1 && slice[1]! < 0x80) {
      throw new SigningError('DER INTEGER has a redundant leading zero');
    }
    if (slice[0]! >= 0x80) throw new SigningError('DER INTEGER is negative');
    return bytesToBigInt(slice);
  };

  const r = readInteger();
  const s = readInteger();
  if (offset !== der.length) throw new SigningError('DER signature has trailing bytes');
  if (r === 0n || r >= ORDER || s === 0n || s >= ORDER) {
    throw new SigningError('DER signature component is out of range');
  }
  return { r, s };
}

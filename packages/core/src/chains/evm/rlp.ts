/**
 * RLP encoding, the serialisation Ethereum transactions are built from.
 *
 * Hand-written, like the Keccak implementation next door, and for the same reason:
 * it is small, fully specified, and checkable against the published vectors, so a
 * dependency buys nothing but supply-chain surface on the one code path that signs
 * transactions moving merchant money.
 *
 * Signing itself is emphatically *not* hand-written — see `secp256k1.ts`, which
 * wraps an audited library. The line between the two is deliberate: getting RLP
 * wrong produces a transaction a node rejects, which is loud. Getting elliptic-curve
 * arithmetic subtly wrong leaks the private key, which is silent.
 */

export type RlpInput = Uint8Array | readonly RlpInput[];

export class RlpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RlpError';
  }
}

/**
 * Encode a byte string or nested list.
 *
 * The three cases of the specification, in order: a single byte below 0x80 is
 * itself; a short string carries a length prefix; a long string carries the length
 * of its length. Lists repeat the same shape with a different offset.
 */
export function rlpEncode(input: RlpInput): Uint8Array {
  if (input instanceof Uint8Array) {
    if (input.length === 1 && input[0]! < 0x80) return input;
    return concat(encodeLength(input.length, 0x80), input);
  }

  const payload = concat(...input.map(rlpEncode));
  return concat(encodeLength(payload.length, 0xc0), payload);
}

/**
 * A non-negative integer as its minimal big-endian form.
 *
 * Zero encodes to the *empty* string, not to a zero byte. This is the single most
 * common RLP mistake and it matters here: a transaction with `value: 0` encoded as
 * `0x00` rather than `0x` produces a different hash, so the signature covers a
 * transaction the network will not accept.
 */
export function rlpInt(value: bigint | number): Uint8Array {
  const big = typeof value === 'bigint' ? value : BigInt(value);
  if (big < 0n) throw new RlpError(`cannot encode a negative integer: ${big}`);
  if (big === 0n) return new Uint8Array(0);

  let hex = big.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  return hexToBytes(hex);
}

/** Strip a `0x` prefix and decode. Odd-length input is an error, not padded. */
export function hexToBytes(hex: string): Uint8Array {
  const body = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (body.length === 0) return new Uint8Array(0);
  if (body.length % 2 !== 0) throw new RlpError(`hex string has odd length: ${hex}`);
  if (!/^[0-9a-fA-F]+$/.test(body)) throw new RlpError(`not hex: ${hex}`);

  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '0x';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function encodeLength(length: number, offset: number): Uint8Array {
  if (length < 56) return Uint8Array.of(offset + length);

  const lengthBytes = rlpInt(BigInt(length));
  // The specification stops at eight length bytes, which no real payload approaches.
  if (lengthBytes.length > 8) throw new RlpError('payload is too long to encode');
  return concat(Uint8Array.of(offset + 55 + lengthBytes.length), lengthBytes);
}

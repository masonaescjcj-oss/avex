/**
 * Base58, once, for every chain that writes addresses with it.
 *
 * TRON wraps it in a checksum and a `0x41` prefix; Solana uses it bare, 32 bytes of public
 * key straight into the alphabet. The alphabet and the base conversion are the same in both
 * cases, so they live here rather than being written twice — the second copy is where the
 * two would drift, and a codec that drifts turns a real payment into a payment credited to
 * nobody.
 *
 * The alphabet is Bitcoin's: no `0`, no `O`, no `I`, no `l`, precisely so that a human
 * reading an address aloud cannot produce a different one. Which is also why case must never
 * be folded on a base58 chain — see `chains/address-key.ts`.
 */

/** Bitcoin's alphabet, which both TRON and Solana use unchanged. */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Reverse lookup, built once. A `Map` rather than `indexOf` per character. */
const INDEX = new Map<string, number>([...ALPHABET].map((char, i) => [char, i]));

export function base58Encode(input: Uint8Array): string {
  if (input.length === 0) return '';

  /**
   * Base conversion through BigInt.
   *
   * The textbook version is repeated division over a byte array, which is faster and much
   * easier to get subtly wrong. These inputs are 25 or 32 bytes.
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
   * No TRON address has one — the payload starts with 0x41 — but a Solana public key may,
   * and a codec that silently drops them is one that cannot be reused.
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

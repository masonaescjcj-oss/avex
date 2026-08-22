/**
 * SHA-256, FIPS 180-4.
 *
 * Here for one reason: TRON addresses are Base58Check, and Base58Check's checksum is the
 * first four bytes of `sha256(sha256(payload))`. Everything else in this package hashes with
 * Keccak-256, which is a different function — using it here would produce addresses that
 * look right, pass our own round-trip, and be rejected by every TRON node.
 *
 * Hand-rolled rather than `node:crypto`, for the same reason `keccak256.ts` is: this file is
 * reachable from code that gets inlined into a browser page, and a `node:` import there is a
 * build error rather than a fallback. It is also short enough to audit against the spec,
 * which matters more than speed for inputs that are never longer than 21 bytes.
 */

/** Fractional parts of the cube roots of the first 64 primes. FIPS 180-4 §4.2.2. */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Fractional parts of the square roots of the first 8 primes. FIPS 180-4 §5.3.3. */
const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

/**
 * Rotate right, forced back into 32 bits.
 *
 * `>>> 0` on the result, not for tidiness: `|` in JavaScript yields a *signed* 32-bit value,
 * so without it the accumulator drifts negative and every subsequent addition is wrong.
 */
function rotr(word: number, bits: number): number {
  return ((word >>> bits) | (word << (32 - bits))) >>> 0;
}

export function sha256(input: Uint8Array): Uint8Array {
  /**
   * Padding: the 0x80 marker, zeroes, then the length in bits as a 64-bit big-endian value.
   *
   * The length field is why this is `+ 9` and not `+ 1`: one byte for the marker and eight
   * for the length, rounded up to a whole 64-byte block.
   */
  const blocks = Math.ceil((input.length + 9) / 64);
  const padded = new Uint8Array(blocks * 64);
  padded.set(input);
  padded[input.length] = 0x80;

  /**
   * The bit length, written as 64 bits.
   *
   * Through a BigInt because the high word matters above 512 MiB of input, and getting it
   * wrong there would be a bug that only ever appears on the largest input anybody feeds it.
   */
  const bitLength = BigInt(input.length) * 8n;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Number((bitLength >> 32n) & 0xffffffffn));
  view.setUint32(padded.length - 4, Number(bitLength & 0xffffffffn));

  const h = new Uint32Array(H0);
  const w = new Uint32Array(64);

  for (let block = 0; block < blocks; block++) {
    const base = block * 64;
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(base + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!];

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }

  const digest = new Uint8Array(32);
  const out = new DataView(digest.buffer);
  for (let i = 0; i < 8; i++) out.setUint32(i * 4, h[i]!);
  return digest;
}

/** `sha256(sha256(x))`, which is the only form Base58Check ever needs. */
export function sha256d(input: Uint8Array): Uint8Array {
  return sha256(sha256(input));
}

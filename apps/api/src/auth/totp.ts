import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238) for two-factor authentication.
 *
 * Two-factor is not optional here. A merchant account controls where money is
 * sent; an attacker with only a password must not be able to change a payout
 * address. Implemented in-tree against the RFC's published vectors rather than
 * pulled in as a dependency, because an authentication primitive is exactly the
 * kind of code that should be readable and pinned.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

export function base32Decode(encoded: string): Uint8Array {
  const clean = encoded.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const char of clean) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value === -1) throw new Error(`invalid base32 character: ${char}`);
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export interface TotpOptions {
  /** Seconds per code. RFC default, and what every authenticator app assumes. */
  readonly stepSeconds?: number;
  readonly digits?: number;
}

const DEFAULT_STEP = 30;
const DEFAULT_DIGITS = 6;

/** Generate a new shared secret, base32-encoded for authenticator apps. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The code for a given counter value. Exposed for testing against RFC vectors. */
export function totpCodeAtCounter(
  secret: Uint8Array,
  counter: number,
  digits: number = DEFAULT_DIGITS,
): string {
  const message = Buffer.alloc(8);
  // Counter is a 64-bit big-endian integer. BigInt avoids the 2^32 wrap that a
  // 32-bit write would hit — not reachable with real timestamps, but the vectors
  // in RFC 6238 deliberately go past it.
  message.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac('sha1', Buffer.from(secret)).update(message).digest();

  // Dynamic truncation, RFC 4226 §5.4.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;

  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function totpCode(
  secretBase32: string,
  atSeconds: number = Math.floor(Date.now() / 1000),
  options: TotpOptions = {},
): string {
  const step = options.stepSeconds ?? DEFAULT_STEP;
  const digits = options.digits ?? DEFAULT_DIGITS;
  return totpCodeAtCounter(base32Decode(secretBase32), Math.floor(atSeconds / step), digits);
}

/**
 * Verify a submitted code, accepting one step of clock drift in each direction.
 *
 * A wider window would be friendlier and materially weaker: each extra step
 * multiplies the codes an attacker may guess. One step either side is the
 * standard compromise.
 */
export function verifyTotp(
  secretBase32: string,
  submitted: string,
  atSeconds: number = Math.floor(Date.now() / 1000),
  options: TotpOptions & { readonly windowSteps?: number } = {},
): boolean {
  const step = options.stepSeconds ?? DEFAULT_STEP;
  const digits = options.digits ?? DEFAULT_DIGITS;
  const window = options.windowSteps ?? 1;

  const cleaned = submitted.replace(/\s/g, '');
  if (cleaned.length !== digits) return false;

  const secret = base32Decode(secretBase32);
  const counter = Math.floor(atSeconds / step);
  const expectedBuffer = Buffer.from(cleaned, 'utf8');

  let matched = false;
  // Check every candidate rather than returning early, so the work done does not
  // depend on which step matched.
  for (let offset = -window; offset <= window; offset++) {
    const candidate = Buffer.from(totpCodeAtCounter(secret, counter + offset, digits), 'utf8');
    if (candidate.length === expectedBuffer.length && timingSafeEqual(candidate, expectedBuffer)) {
      matched = true;
    }
  }
  return matched;
}

/** `otpauth://` URI for authenticator QR codes. */
export function totpUri(secretBase32: string, accountEmail: string, issuer = 'AVEX Pay'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountEmail)}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(DEFAULT_DIGITS),
    period: String(DEFAULT_STEP),
  });
  return `otpauth://totp/${label}?${params}`;
}

/**
 * Single-use recovery codes, for the phone-lost case.
 *
 * Returned in plaintext exactly once; only hashes are stored. Without these,
 * mandatory two-factor turns a lost device into a support process that ends with
 * someone disabling two-factor over email — which is the same as not having it.
 */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(randomBytes(10)).slice(0, 16);
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
  });
}

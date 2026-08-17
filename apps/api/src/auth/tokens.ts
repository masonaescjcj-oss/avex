import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Opaque bearer credentials: session tokens, email verification tokens, API keys.
 *
 * The rule throughout: the database stores only a SHA-256 hash, never the token
 * itself. A leaked database dump then yields nothing usable — no session can be
 * resumed and no API key replayed. Tokens are high-entropy random values rather
 * than passwords, so a single fast hash is the right choice here; scrypt's
 * memory hardness protects low-entropy secrets and would only add latency to
 * every authenticated request.
 */

export interface IssuedToken {
  /** Shown to the caller exactly once. */
  readonly token: string;
  /** Stored. */
  readonly hash: string;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function issueToken(byteLength = 32): IssuedToken {
  const token = randomBytes(byteLength).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function tokenMatchesHash(token: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashToken(token), 'utf8');
  const expected = Buffer.from(storedHash, 'utf8');
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

export type ApiKeyMode = 'test' | 'live';

export interface IssuedApiKey extends IssuedToken {
  /**
   * Leading segment, stored in the clear so the dashboard can identify a key in
   * a list and an operator can match a log line to a key without possessing it.
   */
  readonly displayPrefix: string;
  readonly mode: ApiKeyMode;
}

/**
 * Issue an API key.
 *
 * The mode is part of the key text, so a test key pasted into production
 * configuration fails loudly instead of quietly moving real money. This is the
 * one place where a naming convention prevents a category of incident.
 */
export function issueApiKey(mode: ApiKeyMode): IssuedApiKey {
  const secret = randomBytes(24).toString('base64url');
  const token = `ak_${mode}_${secret}`;
  return {
    token,
    hash: hashToken(token),
    displayPrefix: token.slice(0, 12),
    mode,
  };
}

/** Read the mode out of a presented key without trusting the database. */
export function apiKeyMode(token: string): ApiKeyMode | null {
  if (token.startsWith('ak_test_')) return 'test';
  if (token.startsWith('ak_live_')) return 'live';
  return null;
}

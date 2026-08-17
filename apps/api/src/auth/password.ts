import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';

// `promisify` resolves to scrypt's three-argument overload, which drops the
// options we need to pass; the cast selects the four-argument form.
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/**
 * Password hashing with scrypt from Node's standard library.
 *
 * scrypt is memory-hard, which is the property that matters: it makes GPU and
 * ASIC cracking expensive in a way plain SHA-family hashing does not. Parameters
 * are stored inside the hash string so they can be raised later without
 * invalidating existing passwords — `needsRehash` reports which stored hashes
 * are behind current policy so they can be upgraded on next successful login.
 */

interface ScryptParams {
  readonly cost: number;
  readonly blockSize: number;
  readonly parallelism: number;
}

/** Current policy. Raise `cost` over time; verification stays backward compatible. */
export const CURRENT_PARAMS: ScryptParams = {
  cost: 1 << 15,
  blockSize: 8,
  parallelism: 1,
};

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

/** scrypt needs 128 * cost * blockSize bytes; Node's default cap sits right at it. */
function maxmemFor(params: ScryptParams): number {
  return 256 * params.cost * params.blockSize;
}

async function derive(
  password: string,
  salt: Buffer,
  params: ScryptParams,
): Promise<Buffer> {
  return scryptAsync(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N: params.cost,
    r: params.blockSize,
    p: params.parallelism,
    maxmem: maxmemFor(params),
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 10) throw new Error('password must be at least 10 characters');

  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, CURRENT_PARAMS);
  const { cost, blockSize, parallelism } = CURRENT_PARAMS;

  return [
    'scrypt',
    cost,
    blockSize,
    parallelism,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

interface ParsedHash {
  readonly params: ScryptParams;
  readonly salt: Buffer;
  readonly key: Buffer;
}

function parse(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;

  const cost = Number(parts[1]);
  const blockSize = Number(parts[2]);
  const parallelism = Number(parts[3]);
  if (![cost, blockSize, parallelism].every(Number.isSafeInteger)) return null;

  try {
    return {
      params: { cost, blockSize, parallelism },
      salt: Buffer.from(parts[4]!, 'base64url'),
      key: Buffer.from(parts[5]!, 'base64url'),
    };
  } catch {
    return null;
  }
}

/**
 * Verify a password. Returns false rather than throwing on a malformed stored
 * hash, so a corrupt row denies access instead of returning a 500 that leaks
 * which accounts have bad data.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed) return false;

  const candidate = await derive(password, parsed.salt, parsed.params);
  if (candidate.length !== parsed.key.length) return false;
  return timingSafeEqual(candidate, parsed.key);
}

/** True when a stored hash predates current policy and should be upgraded. */
export function needsRehash(stored: string): boolean {
  const parsed = parse(stored);
  if (!parsed) return true;
  return (
    parsed.params.cost < CURRENT_PARAMS.cost ||
    parsed.params.blockSize < CURRENT_PARAMS.blockSize ||
    parsed.params.parallelism < CURRENT_PARAMS.parallelism
  );
}

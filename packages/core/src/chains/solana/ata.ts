import { sha256 } from '../../crypto/sha256.js';
import { base58Decode, base58Encode } from '../base58.js';

/**
 * Where a payer's SPL tokens actually land: the associated token account.
 *
 * A merchant gives us one Solana address. A payer's wallet does not send tokens to it — it
 * sends them to a *different* public key, derived from the wallet, the mint and the token
 * program, which is the account that holds that wallet's balance of that one token. So the
 * watcher cannot ask the chain about the merchant's address; it has to know the derived one.
 *
 * ## Why this is derived here rather than asked for
 *
 * `getTokenAccountsByOwner` answers the same question in one request, and the first version
 * of the adapter used it. Two things were wrong with that. It is a request per wallet per
 * mint on every poll before the account exists, which is precisely the case that matters —
 * and the answer for a wallet that has never held the token is "none", so there is nothing
 * to watch until the first payment, which is the payment that would be missed. And it is
 * not a method every endpoint serves: publicnode's free Solana endpoint answers it with
 * HTTP 403, which took the whole poll down with it.
 *
 * Derived, the address is known before the account exists. The first payer's transfer creates
 * the account and credits it in one transaction, and the watcher is already asking about that
 * address, so it sees it.
 *
 * ## The unpleasant part: a program address must not be a public key
 *
 * The derivation is Solana's `findProgramAddress`, and its whole purpose is to produce an
 * address that *nobody can sign for*. That means the 32 bytes must not be a valid ed25519
 * curve point — if they were, someone could hold the private key to an account the program
 * believes only it controls. So the derivation hashes with a one-byte "bump", checks whether
 * the result decompresses to a curve point, and tries the next bump down if it does.
 *
 * Which is why there is field arithmetic in a payments repository. The check is the ed25519
 * decompression condition and nothing more: for the y this encodes, does x exist? Getting it
 * wrong does not produce a wrong answer occasionally — it produces a different address for
 * about one wallet in every few hundred, and a wrong address is a payment that arrives and
 * is never seen. `ata.test.ts` holds it against real mainnet accounts for that reason.
 */

/** The classic SPL Token program, which holds every curated mint here. */
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** Token-2022. A newer mint may be owned by this instead; the ATA derivation differs only here. */
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

/** Appended to every program-derived address, so a PDA can never collide with another hash. */
const PDA_MARKER = new TextEncoder().encode('ProgramDerivedAddress');

// ── the field ────────────────────────────────────────────────────────────────

/** 2²⁵⁵ − 19. */
const P = (1n << 255n) - 19n;

/** The curve constant, −121665/121666 mod p. */
const D = mod(-121665n * inverse(121666n));

function mod(value: bigint): bigint {
  const reduced = value % P;
  return reduced < 0n ? reduced + P : reduced;
}

function modPow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let factor = mod(base);
  let remaining = exponent;
  while (remaining > 0n) {
    if (remaining & 1n) result = (result * factor) % P;
    factor = (factor * factor) % P;
    remaining >>= 1n;
  }
  return result;
}

/** Fermat's little theorem, which is the shortest correct inverse for a prime modulus. */
function inverse(value: bigint): bigint {
  return modPow(value, P - 2n);
}

/**
 * Whether these 32 bytes decompress to a point on ed25519 — that is, whether they could be
 * somebody's public key.
 *
 * The compressed form is `y` little-endian with the sign of `x` in the top bit. The curve is
 * `−x² + y² = 1 + d·x²·y²`, so `x² = (y² − 1) / (d·y² + 1)`, and a point exists exactly when
 * that quotient has a square root. Whether it does is one Legendre symbol.
 */
export function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;

  let y = 0n;
  for (let i = 31; i >= 0; i--) {
    // The top bit of the last byte is the sign of x, not part of y.
    const byte = i === 31 ? bytes[i]! & 0x7f : bytes[i]!;
    y = (y << 8n) | BigInt(byte);
  }
  y = mod(y);

  const yy = mod(y * y);
  const u = mod(yy - 1n);
  const v = mod(D * yy + 1n);

  // No x at all unless the numerator vanishes with the denominator.
  if (v === 0n) return u === 0n;

  const xx = mod(u * inverse(v));
  // x = 0 is a point: y = ±1, the identity and its partner.
  if (xx === 0n) return true;
  return modPow(xx, (P - 1n) / 2n) === 1n;
}

// ── derivation ───────────────────────────────────────────────────────────────

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Solana's `findProgramAddress`: the first bump, counting down from 255, whose hash is not a
 * curve point.
 *
 * Counting down and not up, because that is what the runtime does and the addresses would
 * otherwise differ. A seed set with no valid bump is a mathematical near-impossibility and is
 * thrown on rather than returned as something plausible.
 */
export function findProgramAddress(
  seeds: readonly Uint8Array[],
  programId: string,
): string {
  const program = base58Decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const candidate = sha256(concat([...seeds, new Uint8Array([bump]), program, PDA_MARKER]));
    if (!isOnCurve(candidate)) return base58Encode(candidate);
  }
  throw new Error('no program address exists for these seeds');
}

/**
 * The account that holds `owner`'s balance of `mint`.
 *
 * `tokenProgram` is which token program owns the mint — the classic one for every curated
 * asset here, Token-2022 for some newer ones. It is part of the derivation, so the wrong one
 * gives a real-looking address that will never receive anything.
 */
export function associatedTokenAccount(
  owner: string,
  mint: string,
  tokenProgram: string = TOKEN_PROGRAM_ID,
): string {
  return findProgramAddress(
    [base58Decode(owner), base58Decode(tokenProgram), base58Decode(mint)],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

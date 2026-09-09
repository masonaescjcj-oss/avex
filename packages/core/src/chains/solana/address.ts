import { base58Decode, base58Encode } from '../base58.js';

/**
 * Solana addresses: 32 bytes, base58, no checksum and no prefix.
 *
 * Simpler than TRON's Base58Check and more dangerous for exactly that reason. There is no
 * checksum, so a mistyped address is very often still a *valid* address — one nobody holds
 * the key to. Nothing here can catch that; what it can catch is a string that is not 32
 * bytes, which is the mistake that comes from pasting a transaction signature (64 bytes) or
 * an EVM address into the wrong field. A signature and a public key are both base58 and both
 * look like noise, so length is the only thing that separates them.
 *
 * ## Why not the 32-to-44-character regex
 *
 * `PayoutAddressService` used one, and it accepts strings that are 31 or 33 bytes when
 * decoded — the character count and the byte count are not in step, because base58 is not a
 * power of two. Deciding by decoded length instead is the same check the runtime does, so a
 * wallet this accepts is one Solana would also accept.
 *
 * Case is significant and there is no canonical re-encoding to reach for: an address is
 * stored and compared exactly as given. See `chains/address-key.ts`, which is why `solana`
 * is not in the list of chains whose case may be folded.
 */

/** Bytes in a Solana public key. Ed25519, so always exactly this. */
const ADDRESS_BYTES = 32;

/** The 32 raw bytes, or a throw naming what was wrong with the string. */
export function solanaAddressBytes(address: string): Uint8Array {
  const trimmed = address.trim();
  if (trimmed === '') throw new Error('empty address');

  const decoded = base58Decode(trimmed);
  if (decoded.length !== ADDRESS_BYTES) {
    throw new Error(
      `not a Solana address: ${trimmed} decodes to ${decoded.length} bytes, not ${ADDRESS_BYTES}`,
    );
  }
  return decoded;
}

/** Whether this is a well-formed Solana address. */
export function isSolanaAddress(address: string): boolean {
  try {
    solanaAddressBytes(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * The address as it should be stored: decoded and re-encoded.
 *
 * A no-op for every well-formed address, which is the point — it proves the string survives
 * a round trip rather than trusting that it will. Leading zero bytes are the case that does
 * not survive a careless codec, and they are legal in a public key.
 */
export function normalizeSolanaAddress(address: string): string {
  return base58Encode(solanaAddressBytes(address));
}

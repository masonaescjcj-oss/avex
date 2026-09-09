/**
 * TON addresses, in the two forms every TON integration has to move between.
 *
 * An address is a workchain number and a 32-byte account id. It is written two ways and both
 * arrive from somewhere real:
 *
 *   - **Raw**: `0:3d2e…`, the workchain, a colon, and the id in hex. What toncenter returns
 *     in every field of every response.
 *   - **Friendly**: `UQAAAA…`, 48 characters of base64, which is the id wrapped with a flags
 *     byte, the workchain and a CRC. What a merchant copies out of their wallet, and the only
 *     form with a checksum — so it is the only form in which a typo is caught.
 *
 * The two are not comparable as strings, and a system that stores one and looks up the other
 * finds nothing: a real payment to a real invoice, credited to nobody. Which is why this is a
 * codec rather than a pair of helpers next to their callers.
 *
 * ## Bounceable and non-bounceable are one address
 *
 * The flags byte says whether a failed transfer bounces back to the sender: `0x11` bounceable,
 * written `EQ…`, and `0x51` not, written `UQ…`. Both encode the same workchain and the same
 * account id, so they are the same wallet, and a merchant may paste either — wallets show
 * `UQ…` for a personal wallet and explorers often show `EQ…` for the same one.
 *
 * So comparison must ignore the flag, and `normalizeTonAddress` produces one canonical form
 * for storage. If it did not, a merchant who registered `EQ…` and a payer's transfer reported
 * against `UQ…` would be two different wallets to us, and every payment would go unmatched.
 * The canonical form is non-bounceable, because these are wallets people are paid into.
 */

/** Bytes in the account id. */
const ACCOUNT_BYTES = 32;

/** Flags byte for a bounceable address, `EQ…`. */
const BOUNCEABLE = 0x11;

/** Flags byte for a non-bounceable address, `UQ…`. Our canonical form. */
const NON_BOUNCEABLE = 0x51;

/** Set on top of the flags byte for a testnet-only address, which we never accept. */
const TEST_ONLY = 0x80;

export interface TonAddress {
  /** 0 for the basechain, where every wallet lives; -1 is the masterchain. */
  readonly workchain: number;
  readonly hash: Uint8Array;
  readonly bounceable: boolean;
  readonly testOnly: boolean;
}

/**
 * CRC-16/XMODEM, which is what the friendly form's last two bytes are.
 *
 * The whole value of the friendly encoding: a mistyped character fails here rather than
 * becoming a valid address nobody holds the key to.
 */
function crc16(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) === 0 ? (crc << 1) & 0xffff : ((crc << 1) ^ 0x1021) & 0xffff;
    }
  }
  return crc;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`odd-length hex: ${hex}`);
  if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error(`not hex: ${hex}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Both base64 alphabets, because a friendly address is written in either. */
function fromBase64(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return new Uint8Array(Buffer.from(normalized, 'base64'));
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

/** The parts of an address, from either form, or a throw naming what was wrong. */
export function parseTonAddress(address: string): TonAddress {
  const trimmed = address.trim();
  if (trimmed === '') throw new Error('empty address');

  if (trimmed.includes(':')) {
    const [workchainPart, hashPart] = trimmed.split(':');
    const workchain = Number(workchainPart);
    if (!Number.isInteger(workchain)) throw new Error(`not a TON workchain: ${workchainPart}`);
    const hash = hexToBytes(hashPart ?? '');
    if (hash.length !== ACCOUNT_BYTES) {
      throw new Error(`not a TON address: ${hash.length} bytes of account id, not ${ACCOUNT_BYTES}`);
    }
    // Raw carries no flags, so it is taken as the canonical non-bounceable form.
    return { workchain, hash, bounceable: false, testOnly: false };
  }

  if (!/^[A-Za-z0-9+/\-_]{48}={0,2}$/.test(trimmed)) {
    throw new Error(`not a TON address: ${trimmed}`);
  }
  const decoded = fromBase64(trimmed);
  if (decoded.length !== 36) {
    throw new Error(`not a TON address: ${trimmed} decodes to ${decoded.length} bytes, not 36`);
  }

  const payload = decoded.subarray(0, 34);
  const checksum = (decoded[34]! << 8) | decoded[35]!;
  if (crc16(payload) !== checksum) throw new Error(`bad checksum: ${trimmed}`);

  let flags = payload[0]!;
  const testOnly = (flags & TEST_ONLY) !== 0;
  flags &= ~TEST_ONLY;
  if (flags !== BOUNCEABLE && flags !== NON_BOUNCEABLE) {
    throw new Error(`not a TON address: flags byte 0x${flags.toString(16)}`);
  }

  // 0xff is the masterchain, -1. Any other single byte is that workchain.
  const raw = payload[1]!;
  const workchain = raw === 0xff ? -1 : raw;

  return {
    workchain,
    hash: payload.subarray(2, 34),
    bounceable: flags === BOUNCEABLE,
    testOnly,
  };
}

/**
 * The friendly form, non-bounceable and mainnet: what is stored and what a payer is shown.
 *
 * One canonical string for one wallet, whichever of the four spellings arrived. The flag is
 * dropped rather than preserved because it is not part of *which* account this is, and
 * keeping it would make `EQ…` and `UQ…` two wallets in a lookup that has to treat them as
 * one.
 */
export function normalizeTonAddress(address: string): string {
  const parsed = parseTonAddress(address);
  const payload = new Uint8Array(34);
  payload[0] = NON_BOUNCEABLE;
  payload[1] = parsed.workchain === -1 ? 0xff : parsed.workchain & 0xff;
  payload.set(parsed.hash, 2);

  const out = new Uint8Array(36);
  out.set(payload);
  const checksum = crc16(payload);
  out[34] = (checksum >> 8) & 0xff;
  out[35] = checksum & 0xff;
  return toBase64Url(out);
}

/** The raw form, `0:hex`, which is what toncenter's query parameters and responses use. */
export function tonAddressRaw(address: string): string {
  const parsed = parseTonAddress(address);
  return `${parsed.workchain}:${bytesToHex(parsed.hash)}`;
}

/** Whether this is a well-formed TON address in any of its forms. */
export function isTonAddress(address: string): boolean {
  try {
    const parsed = parseTonAddress(address);
    // A testnet address in a mainnet gateway is a mistake worth refusing, not normalising.
    return !parsed.testOnly;
  } catch {
    return false;
  }
}

/**
 * Equality across forms.
 *
 * Exists so that no caller reaches for `===` on two strings that may be the same wallet
 * spelled two ways, and so that none reaches for `toLowerCase()`, which is right for hex and
 * destroys a base64 address.
 */
export function tonAddressesEqual(left: string, right: string): boolean {
  try {
    return normalizeTonAddress(left) === normalizeTonAddress(right);
  } catch {
    return false;
  }
}

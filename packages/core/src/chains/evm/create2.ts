import { concatBytes, fromHex, keccak256, toHex } from '../../crypto/keccak256.js';

export interface Create2Config {
  /** Deployed ForwarderFactory address for this chain. */
  readonly factory: string;
  /**
   * Compiled creation code of `Forwarder` (contracts/Forwarder.sol), without
   * constructor arguments. Obtain with `forge inspect Forwarder bytecode`.
   *
   * This must correspond to the exact factory deployed at `factory`, because the
   * address we hand a payer is a hash over this bytecode. A recompile with
   * different settings changes every derived address.
   */
  readonly forwarderCreationCode: string;
}

/** ABI encoding of a single `address` argument: 12 zero bytes then 20 address bytes. */
function encodeAddress(address: string): Uint8Array {
  const raw = fromHex(address);
  if (raw.length !== 20) throw new Error(`not a 20-byte address: ${address}`);
  return concatBytes(new Uint8Array(12), raw);
}

/**
 * ABI encoding of a `uint16`: right-aligned in a 32-byte word.
 *
 * The width matters. Solidity pads a `uint16` to 32 bytes in the constructor
 * arguments exactly as it pads an address, so encoding this as two bytes would
 * produce a different init code hash and therefore a different address — one the
 * factory would never derive, leaving any funds sent to it unreachable.
 */
function encodeUint16(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`not a uint16: ${value}`);
  }
  const word = new Uint8Array(32);
  word[30] = (value >> 8) & 0xff;
  word[31] = value & 0xff;
  return word;
}

/**
 * Highest fee the on-chain `Forwarder` will accept, mirroring `MAX_FEE_BPS`.
 *
 * Checked here as well as there so an over-large fee is a rejected invoice rather
 * than a deposit address that reverts when we try to deploy it — by which point a
 * payer has already sent funds to it.
 */
export const MAX_FEE_BPS = 500;

/** The fee split a forwarder is built with. Zero-fee is a negotiated 0% merchant. */
export interface ForwarderFee {
  readonly feeDestination: string;
  readonly feeBps: number;
}

/**
 * No fee: the address commits to the merchant receiving everything.
 *
 * `feeDestination` is the zero address, which the contract permits only because
 * `feeBps` is zero and the field is never read. Passing a real address with a zero
 * fee would derive a different (still correct) address, so the two sides must agree
 * on this convention as much as on the arithmetic.
 */
export const NO_FEE: ForwarderFee = {
  feeDestination: '0x0000000000000000000000000000000000000000',
  feeBps: 0,
};

/**
 * Salt for an invoice. Hashing the id gives a uniform 32-byte salt regardless of
 * id format, and makes the derivation reproducible from the invoice record alone.
 */
export function invoiceSalt(invoiceId: string): Uint8Array {
  return keccak256(new TextEncoder().encode(invoiceId));
}

/**
 * keccak256(creationCode ++ abi.encode(destination, feeDestination, feeBps)) —
 * matches `ForwarderFactory.initCode`.
 */
export function initCodeHash(
  config: Create2Config,
  destination: string,
  fee: ForwarderFee = NO_FEE,
): Uint8Array {
  assertFee(fee);
  return keccak256(
    concatBytes(
      fromHex(config.forwarderCreationCode),
      encodeAddress(destination),
      encodeAddress(fee.feeDestination),
      encodeUint16(fee.feeBps),
    ),
  );
}

function assertFee(fee: ForwarderFee): void {
  if (fee.feeBps > MAX_FEE_BPS) {
    throw new Error(`fee of ${fee.feeBps}bps exceeds the contract's ${MAX_FEE_BPS}bps ceiling`);
  }
  if (fee.feeBps > 0 && /^0x0{40}$/i.test(fee.feeDestination)) {
    // The contract reverts on this. Catching it here means a misconfiguration
    // surfaces when the invoice is created, not after a payer has funded an
    // address we cannot deploy.
    throw new Error('a non-zero fee needs a fee destination');
  }
}

/** Plain EIP-1014 address computation: keccak256(0xff ++ deployer ++ salt ++ initCodeHash)[12:]. */
export function create2Address(
  deployer: string,
  salt: Uint8Array,
  initCodeHashBytes: Uint8Array,
): string {
  if (salt.length !== 32) throw new Error(`salt must be 32 bytes, got ${salt.length}`);
  if (initCodeHashBytes.length !== 32) {
    throw new Error(`init code hash must be 32 bytes, got ${initCodeHashBytes.length}`);
  }
  const preimage = concatBytes(
    new Uint8Array([0xff]),
    fromHex(deployer),
    salt,
    initCodeHashBytes,
  );
  return toChecksumAddress(toHex(keccak256(preimage).slice(12)));
}

/**
 * The deposit address for (invoice, merchant payout address, fee split).
 *
 * Mirrors `ForwarderFactory.predict`. Because every constructor argument feeds the
 * init code hash, the resulting address is bound to all of them — which is what
 * lets us hand out an address before any contract exists at it and still promise
 * both that the funds can only reach the merchant and that our cut cannot grow
 * after the fact. A larger fee is a different address.
 *
 * The corollary is that settlement must be given the same fee it was quoted with.
 * Reading a current fee from configuration at sweep time would derive an address
 * nobody funded, so the fee belongs on the invoice record.
 */
export function predictForwarder(
  config: Create2Config,
  invoiceId: string,
  destination: string,
  fee: ForwarderFee = NO_FEE,
): string {
  return create2Address(
    config.factory,
    invoiceSalt(invoiceId),
    initCodeHash(config, destination, fee),
  );
}

/** EIP-55 mixed-case checksum encoding. */
export function toChecksumAddress(address: string): string {
  const lower = (address.startsWith('0x') ? address.slice(2) : address).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(lower)) throw new Error(`not an address: ${address}`);

  const hash = toHex(keccak256(new TextEncoder().encode(lower))).slice(2);
  let out = '0x';
  for (let i = 0; i < 40; i++) {
    const char = lower[i]!;
    out += Number.parseInt(hash[i]!, 16) >= 8 ? char.toUpperCase() : char;
  }
  return out;
}

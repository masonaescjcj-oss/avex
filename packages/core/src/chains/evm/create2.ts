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
 * Salt for an invoice. Hashing the id gives a uniform 32-byte salt regardless of
 * id format, and makes the derivation reproducible from the invoice record alone.
 */
export function invoiceSalt(invoiceId: string): Uint8Array {
  return keccak256(new TextEncoder().encode(invoiceId));
}

/** keccak256(creationCode ++ abi.encode(destination)) — matches the on-chain factory. */
export function initCodeHash(config: Create2Config, destination: string): Uint8Array {
  return keccak256(
    concatBytes(fromHex(config.forwarderCreationCode), encodeAddress(destination)),
  );
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
 * The deposit address for (invoice, merchant payout address).
 *
 * Mirrors `ForwarderFactory.predict`. Because `destination` feeds the init code
 * hash, the resulting address is bound to that destination — which is what lets
 * us hand out an address before any contract exists at it and still promise the
 * funds can only reach the merchant.
 */
export function predictForwarder(
  config: Create2Config,
  invoiceId: string,
  destination: string,
): string {
  return create2Address(
    config.factory,
    invoiceSalt(invoiceId),
    initCodeHash(config, destination),
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

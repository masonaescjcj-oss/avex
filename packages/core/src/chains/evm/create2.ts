import { concatBytes, fromHex, keccak256, toHex } from '../../crypto/keccak256.js';

export interface Create2Config {
  /** Deployed ForwarderFactory address for this chain. */
  readonly factory: string;
  /**
   * Deployed `ForwarderLogic` address for this chain — what every deposit address delegates to.
   *
   * This is the one value in a deposit address that is neither the invoice nor the merchant, and
   * it must be the logic the factory at `factory` was constructed with. A mismatch derives
   * addresses that factory will never settle, and the symptom is a payer funding an address
   * nothing can deploy.
   *
   * It replaced the compiled creation code this config used to carry. The parameters now sit in
   * 87 bytes of minimal proxy rather than in a full copy of the contract, which is what took a
   * settlement from 385,291 gas to a fraction of it — so what the address hashes over is this
   * address, not a build artifact.
   */
  readonly implementation: string;
}

/**
 * The EIP-1167 minimal proxy, either side of the implementation address.
 *
 * Canonical bytes, with one change: the length in the init prefix is `0x57` (87) rather than
 * `0x2d` (45), so the parameters appended after the runtime are deposited as part of the code.
 * That is what puts them in the hash CREATE2 takes, and therefore in the address.
 *
 *   3d       RETURNDATASIZE            0
 *   6057     PUSH1 87                  length
 *   80       DUP1
 *   600a     PUSH1 10                  offset of the runtime within this init code
 *   3d       RETURNDATASIZE            0
 *   39       CODECOPY                  memory[0..87] = code[10..97]
 *   81       DUP2
 *   f3       RETURN                    the 87 bytes become the deployed code
 *
 * Mirrors `ForwarderFactory.cloneInitCode`. The two are checked against each other by the
 * contract tests, which derive addresses with this code and settle them with that one.
 */
const PROXY_PREFIX = '0x3d605780600a3d3981f3363d3d373d3d3d363d73';
const PROXY_SUFFIX = '5af43d82803e903d91602b57fd5bf3';

/** Where the parameters start in a clone's code. `ForwarderLogic.ARGS_OFFSET`. */
export const CLONE_ARGS_OFFSET = 45;

function bare(hex: string): string {
  return (hex.startsWith('0x') ? hex.slice(2) : hex).toLowerCase();
}

function addressBytes(address: string, label: string): string {
  const raw = bare(address);
  if (!/^[0-9a-f]{40}$/.test(raw)) throw new Error(`not a 20-byte ${label}: ${address}`);
  return raw;
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
 * The exact bytes CREATE2 hashes: a minimal proxy with the parameters appended.
 *
 * Packed, not ABI-encoded, and the difference is the whole address. The previous version put
 * the parameters through `abi.encode`, which pads each one to 32 bytes; these are the raw 20,
 * 20 and 2. Padding them here would produce an address the factory never derives, and the
 * funds sent to it would be unreachable — so this function exists rather than being inlined,
 * and the contract tests settle addresses it produced.
 */
export function cloneInitCode(
  config: Create2Config,
  destination: string,
  fee: ForwarderFee = NO_FEE,
): Uint8Array {
  assertFee(fee);
  if (fee.feeBps > 0xffff) throw new Error(`not a uint16: ${fee.feeBps}`);

  const hex =
    bare(PROXY_PREFIX) +
    addressBytes(config.implementation, 'implementation') +
    PROXY_SUFFIX +
    addressBytes(destination, 'destination') +
    addressBytes(fee.feeDestination, 'fee destination') +
    fee.feeBps.toString(16).padStart(4, '0');

  const code = fromHex(`0x${hex}`);
  /**
   * 97 bytes, checked rather than assumed: 10 of init, 45 of runtime, 42 of parameters.
   *
   * A length that drifted would move where `ForwarderLogic.config` reads from, and it reads by
   * a constant offset. The failure would not be a revert — it would be a valid-looking address
   * assembled from the wrong bytes.
   */
  if (code.length !== 10 + CLONE_ARGS_OFFSET + 42) {
    throw new Error(`clone init code must be 97 bytes, got ${code.length}`);
  }
  return code;
}

/** keccak256 of the clone init code — matches `keccak256(ForwarderFactory.cloneInitCode(…))`. */
export function initCodeHash(
  config: Create2Config,
  destination: string,
  fee: ForwarderFee = NO_FEE,
): Uint8Array {
  return keccak256(cloneInitCode(config, destination, fee));
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
 * Mirrors `ForwarderFactory.predict`. Because all three parameters are appended to the code the
 * clone deposits, they feed the init code hash, and the resulting address is bound to every one
 * of them — which is what lets us hand out an address before any contract exists at it and still
 * promise both that the funds can only reach the merchant and that our cut cannot grow after the
 * fact. A larger fee is a different address.
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

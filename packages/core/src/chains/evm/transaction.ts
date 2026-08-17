import { keccak256 } from '../../crypto/keccak256.js';
import type { Signature } from '../../crypto/secp256k1.js';
import { bigIntToBytes } from '../../crypto/secp256k1.js';
import { bytesToHex, concat, hexToBytes, rlpEncode, rlpInt } from './rlp.js';
import type { RlpInput } from './rlp.js';

/**
 * EIP-1559 transactions — type 2, the only kind this gateway sends.
 *
 * Legacy and type-1 transactions are deliberately absent. Every chain the registry
 * supports has had 1559 for years, and supporting one format means one signing path
 * to get right instead of three, each with its own hashing rules.
 */

export class TransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransactionError';
  }
}

export interface Eip1559Transaction {
  readonly chainId: number;
  readonly nonce: number;
  /** The tip. Zero is valid on some chains and refused by most public mempools. */
  readonly maxPriorityFeePerGas: bigint;
  /** The ceiling on base fee plus tip. This is what `feePerGasWei` means elsewhere. */
  readonly maxFeePerGas: bigint;
  readonly gasLimit: bigint;
  /** Null is a contract deployment. The settlement path never does this. */
  readonly to: string | null;
  readonly value: bigint;
  readonly data: Uint8Array;
  readonly accessList?: readonly never[];
}

export const TRANSACTION_TYPE = 0x02;

/**
 * The bytes a signer signs: `0x02 || rlp([...fields])`, hashed.
 *
 * The type byte is outside the RLP payload, which is the detail that catches people
 * out — a typed transaction hashed as bare RLP produces a signature that recovers to
 * a different address, so the funds go to a wallet nobody holds and the transaction
 * still looks valid.
 */
export function signingPayload(transaction: Eip1559Transaction): Uint8Array {
  return concat(Uint8Array.of(TRANSACTION_TYPE), rlpEncode(unsignedFields(transaction)));
}

export function signingHash(transaction: Eip1559Transaction): Uint8Array {
  return keccak256(signingPayload(transaction));
}

/** The serialised signed transaction, ready to broadcast, and its hash. */
export function serializeSigned(
  transaction: Eip1559Transaction,
  signature: Signature,
): { readonly raw: string; readonly hash: string } {
  if (signature.recovery !== 0 && signature.recovery !== 1) {
    throw new TransactionError(`recovery must be 0 or 1, got ${signature.recovery}`);
  }

  const fields: RlpInput[] = [
    ...unsignedFields(transaction),
    // `yParity`, then r and s with leading zeros stripped — RLP integers are minimal.
    rlpInt(BigInt(signature.recovery)),
    rlpInt(signature.r),
    rlpInt(signature.s),
  ];

  const encoded = concat(Uint8Array.of(TRANSACTION_TYPE), rlpEncode(fields));
  return { raw: bytesToHex(encoded), hash: bytesToHex(keccak256(encoded)) };
}

function unsignedFields(transaction: Eip1559Transaction): RlpInput[] {
  assertValid(transaction);

  return [
    rlpInt(BigInt(transaction.chainId)),
    rlpInt(BigInt(transaction.nonce)),
    rlpInt(transaction.maxPriorityFeePerGas),
    rlpInt(transaction.maxFeePerGas),
    rlpInt(transaction.gasLimit),
    transaction.to === null ? new Uint8Array(0) : addressBytes(transaction.to),
    rlpInt(transaction.value),
    transaction.data,
    // An empty access list is an empty RLP list, not an empty string.
    [],
  ];
}

function addressBytes(address: string): Uint8Array {
  const bytes = hexToBytes(address);
  if (bytes.length !== 20) {
    throw new TransactionError(`address must be 20 bytes, got ${bytes.length}: ${address}`);
  }
  return bytes;
}

function assertValid(transaction: Eip1559Transaction): void {
  const { chainId, nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas, value } = transaction;

  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new TransactionError(`chainId must be a positive integer, got ${chainId}`);
  }
  if (!Number.isInteger(nonce) || nonce < 0) {
    throw new TransactionError(`nonce must be a non-negative integer, got ${nonce}`);
  }
  for (const [name, amount] of [
    ['gasLimit', gasLimit],
    ['maxFeePerGas', maxFeePerGas],
    ['maxPriorityFeePerGas', maxPriorityFeePerGas],
    ['value', value],
  ] as const) {
    if (amount < 0n) throw new TransactionError(`${name} cannot be negative`);
  }
  if (gasLimit === 0n) throw new TransactionError('gasLimit cannot be zero');

  /**
   * The tip cannot exceed the ceiling.
   *
   * Refused here rather than left to the node, because a node's rejection arrives
   * after the settlement runner has already advanced its nonce — and every later
   * settlement then sits behind a gap that will never be filled.
   */
  if (maxPriorityFeePerGas > maxFeePerGas) {
    throw new TransactionError(
      `maxPriorityFeePerGas (${maxPriorityFeePerGas}) exceeds maxFeePerGas (${maxFeePerGas})`,
    );
  }
}

/** The four-byte selector for a function signature, e.g. `flush(address)`. */
export function selectorFor(signature: string): Uint8Array {
  return keccak256(new TextEncoder().encode(signature)).subarray(0, 4);
}

/** Encode a 32-byte word, for hand-assembling call data. */
export function word(value: bigint | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.length > 32) throw new TransactionError('word is longer than 32 bytes');
    const out = new Uint8Array(32);
    out.set(value, 32 - value.length);
    return out;
  }
  return bigIntToBytes(value, 32);
}

/** An address as a left-padded 32-byte word, for call data. */
export function addressWord(address: string): Uint8Array {
  return word(addressBytes(address));
}

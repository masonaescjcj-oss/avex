import { serializeSigned, signingHash } from '../chains/evm/transaction.js';
import type { Eip1559Transaction } from '../chains/evm/transaction.js';
import { hexToBytes } from '../chains/evm/rlp.js';
import {
  addressFromPrivateKey,
  recoverAddress,
  signDigest,
  signatureFromDer,
  toChecksum,
} from '../crypto/secp256k1.js';
import type { Signature } from '../crypto/secp256k1.js';
import type { ChainSigner } from './SettlementRunner.js';

/**
 * A `ChainSigner` for EVM chains.
 *
 * The key never appears in this class. It sits behind a `KeyProvider`, which has one
 * job — turn a 32-byte digest into a signature — so the production implementation can
 * be a KMS that holds material this process cannot read, and the local one can be a
 * raw key for development, without either leaking into the other's code path.
 *
 * The signer's own contribution is the part a KMS cannot do: building the EIP-1559
 * payload, and refusing to broadcast anything that does not recover to the address it
 * claims to be signing for.
 */

export interface KeyProvider {
  /** Checksummed address the key controls. Read once and asserted against, not trusted. */
  address(): Promise<string>;
  /** Sign a 32-byte digest. Nothing else about the transaction is visible here. */
  signDigest(digest: Uint8Array): Promise<Signature>;
}

/**
 * The JSON-RPC calls the signer needs. Narrower than a general client on purpose:
 * this is the one component that can move money, and it should not be able to do
 * anything else.
 */
export interface SigningRpc {
  call(method: string, params: readonly unknown[]): Promise<unknown>;
}

export class SignerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignerError';
  }
}

/**
 * A key held in this process, and a refusal about where it came from.
 *
 * ## What this key can and cannot do
 *
 * Worth stating precisely, because the earlier version of this comment implied more than the
 * contracts allow and sent operators looking for a KMS they may not be able to buy.
 *
 * It **cannot move a merchant's money anywhere but to that merchant.** A deposit address is a
 * clone whose payout destination, fee destination and fee rate are bytes of its own code, and
 * `flush` reads them with EXTCODECOPY from `address(this)`. Nothing about the destination comes
 * from the caller, `flush` is deliberately callable by anyone, and the factory cannot redirect
 * it either. So a stolen key buys no access to customer funds and none to the fee collector,
 * which is its own address in every clone.
 *
 * What it is, is the **gas wallet**. A thief can drain its native balance and can spend nonces
 * to keep our own settlements from confirming until somebody notices. That is the whole loss,
 * and it bounds the defence that is proportionate: keep the balance small, alarm on it, and the
 * exposure is a few days of gas rather than a merchant's takings.
 *
 * ## Why `source` and not a boolean
 *
 * The refusal below is about how the key reached this process, not about the fact that it is in
 * memory — every local signer holds it in memory, including a well-run one.
 *
 * An `environment` key is exposed in ways a file is not: it is in `/proc/<pid>/environ` for the
 * life of the process, in any core dump, in the unit file or `EnvironmentFile` that set it, in
 * whatever backup copies that file, and in the shell history of whoever exported it to try
 * something. A `credential` key is a path the process opens once — with systemd's
 * `LoadCredentialEncrypted` it is encrypted at rest and decrypted into a tmpfs visible only to
 * that unit's mount namespace.
 *
 * Neither is a KMS, and this class does not pretend to be one. A KMS never hands the key over
 * at all: it signs a digest on request, so the key cannot be exfiltrated and access to it is
 * revocable and logged. `DerKeyProvider` below is the seam for one.
 */
export class LocalKeyProvider implements KeyProvider {
  private readonly key: Uint8Array;
  private readonly derived: string;

  constructor(
    privateKeyHex: string,
    options: {
      readonly environment: string;
      /**
       * How the key reached this process. `environment` is refused in production.
       *
       * Defaults to `environment`, so a caller that says nothing gets the strict answer.
       */
      readonly source?: 'environment' | 'credential';
    } = { environment: 'production' },
  ) {
    if (options.environment === 'production' && (options.source ?? 'environment') === 'environment') {
      throw new SignerError(
        'refusing a settlement key from an environment variable in production: it stays in ' +
          '/proc/<pid>/environ, in core dumps, and in whatever set it. Put the key in a file ' +
          'and pass source: "credential" — systemd LoadCredentialEncrypted is the intended ' +
          'shape — or supply a DerKeyProvider backed by a KMS.',
      );
    }

    this.key = hexToBytes(privateKeyHex);
    if (this.key.length !== 32) {
      throw new SignerError(`settlement key must be 32 bytes, got ${this.key.length}`);
    }
    this.derived = addressFromPrivateKey(this.key);
  }

  async address(): Promise<string> {
    return this.derived;
  }

  async signDigest(digest: Uint8Array): Promise<Signature> {
    return signDigest(digest, this.key);
  }
}

/**
 * A key held by an external signer that returns DER and no recovery id.
 *
 * This is the shape of every KMS and HSM worth using: AWS KMS `Sign`, GCP KMS,
 * PKCS#11. The caller supplies the raw sign call and the address the key is known to
 * control; everything awkward about the format — normalising a high `s`, finding the
 * recovery id — is handled by `signatureFromDer`, which also verifies the result
 * recovers to that address.
 */
export class DerKeyProvider implements KeyProvider {
  constructor(
    private readonly knownAddress: string,
    private readonly sign: (digest: Uint8Array) => Promise<Uint8Array>,
  ) {}

  async address(): Promise<string> {
    return toChecksum(this.knownAddress);
  }

  async signDigest(digest: Uint8Array): Promise<Signature> {
    return signatureFromDer(await this.sign(digest), digest, await this.address());
  }
}

export interface EvmChainSignerConfig {
  readonly chainId: number;
  /**
   * Tip above the base fee, as a fraction of the fee ceiling the runner asked for.
   *
   * The runner reasons in a single total fee per gas, which is what determines cost;
   * the split between base fee and tip is a mempool concern and belongs here.
   */
  readonly priorityFraction?: number;
}

export class EvmChainSigner implements ChainSigner {
  /** Populated by `initialise`, which must run before anything is broadcast. */
  #address: string | null = null;

  constructor(
    private readonly rpc: SigningRpc,
    private readonly keys: KeyProvider,
    private readonly config: EvmChainSignerConfig,
  ) {}

  /**
   * Read the signing address once, up front.
   *
   * Separate from the constructor because it is asynchronous, and separate from the
   * first broadcast because a misconfigured KMS should stop the process at startup
   * rather than be discovered by a settlement that fails halfway.
   */
  async initialise(): Promise<string> {
    this.#address ??= toChecksum(await this.keys.address());
    return this.#address;
  }

  get address(): string {
    if (this.#address === null) {
      throw new SignerError('signer was used before initialise() resolved its address');
    }
    return this.#address;
  }

  async pendingNonce(): Promise<number> {
    // `pending` rather than `latest`: a transaction of ours already in the mempool
    // occupies its nonce, and reusing it would silently replace our own settlement.
    const hex = await this.rpc.call('eth_getTransactionCount', [this.address, 'pending']);
    return Number(BigInt(asHex(hex, 'eth_getTransactionCount')));
  }

  async balanceWei(): Promise<bigint> {
    return BigInt(asHex(await this.rpc.call('eth_getBalance', [this.address, 'latest']), 'eth_getBalance'));
  }

  async broadcast(tx: {
    readonly nonce: number;
    readonly to: string;
    readonly data: string;
    readonly gasLimit: bigint;
    readonly feePerGasWei: bigint;
  }): Promise<{ readonly hash: string }> {
    const fraction = this.config.priorityFraction ?? 0.1;
    if (!(fraction >= 0 && fraction <= 1)) {
      throw new SignerError(`priorityFraction must be between 0 and 1, got ${fraction}`);
    }

    // Integer arithmetic: the tip is a fraction of the ceiling in basis points, so
    // there is no float anywhere near a fee.
    const bps = BigInt(Math.round(fraction * 10_000));
    const transaction: Eip1559Transaction = {
      chainId: this.config.chainId,
      nonce: tx.nonce,
      maxFeePerGas: tx.feePerGasWei,
      maxPriorityFeePerGas: (tx.feePerGasWei * bps) / 10_000n,
      gasLimit: tx.gasLimit,
      to: tx.to,
      value: 0n,
      data: hexToBytes(tx.data),
    };

    const digest = signingHash(transaction);
    const signature = await this.keys.signDigest(digest);

    /**
     * Verify before broadcasting, every time.
     *
     * This catches the failure that has no other symptom: an external signer
     * reconfigured to a different key still returns a valid signature, and the
     * transaction it produces is accepted by the network and paid for by a wallet we
     * do not control. Recovery costs microseconds; discovering it any other way costs
     * the whole settlement.
     */
    const recovered = recoverAddress(digest, signature);
    if (recovered.toLowerCase() !== this.address.toLowerCase()) {
      throw new SignerError(
        `signature recovered to ${recovered} but this signer is ${this.address}; refusing to broadcast`,
      );
    }

    const { raw, hash } = serializeSigned(transaction, signature);
    const returned = asHex(
      await this.rpc.call('eth_sendRawTransaction', [raw]),
      'eth_sendRawTransaction',
    );

    // A node that reports a different hash than the one we computed means our
    // serialisation and its parsing disagree, and the transaction we are about to
    // record as in-flight is not the one on the network.
    if (returned.toLowerCase() !== hash.toLowerCase()) {
      throw new SignerError(`node returned hash ${returned} but the signed transaction is ${hash}`);
    }
    return { hash };
  }

  async receipt(hash: string): Promise<{
    readonly status: 'success' | 'reverted';
    readonly gasUsed: bigint;
    readonly feePerGasWei: bigint;
  } | null> {
    const result = await this.rpc.call('eth_getTransactionReceipt', [hash]);
    if (result === null || result === undefined) return null;

    const receipt = result as Record<string, unknown>;
    const status = asHex(receipt.status, 'receipt.status');
    return {
      status: BigInt(status) === 1n ? 'success' : 'reverted',
      gasUsed: BigInt(asHex(receipt.gasUsed, 'receipt.gasUsed')),
      // `effectiveGasPrice` is what was actually paid, which on a 1559 chain is below
      // the ceiling whenever the base fee was lower than assumed. Using the ceiling
      // would overstate every settlement's cost and eat the spend cap early.
      feePerGasWei: BigInt(asHex(receipt.effectiveGasPrice, 'receipt.effectiveGasPrice')),
    };
  }
}

function asHex(value: unknown, source: string): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]*$/.test(value)) {
    throw new SignerError(`${source} returned ${JSON.stringify(value)}, expected a hex quantity`);
  }
  return value === '0x' ? '0x0' : value;
}

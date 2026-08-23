import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hexToBytes } from '../chains/evm/rlp.js';
import { addressFromPrivateKey, signDigest } from '../crypto/secp256k1.js';
import { DerKeyProvider, EvmChainSigner, LocalKeyProvider, SignerError } from './EvmChainSigner.js';
import type { KeyProvider, SigningRpc } from './EvmChainSigner.js';

const KEY_HEX = '0x4646464646464646464646464646464646464646464646464646464646464646';
const ADDRESS = addressFromPrivateKey(hexToBytes(KEY_HEX));

/** An RPC that answers from a script and records what it was asked. */
function fakeRpc(answers: Record<string, unknown | ((params: readonly unknown[]) => unknown)>) {
  const calls: { method: string; params: readonly unknown[] }[] = [];
  const rpc: SigningRpc = {
    async call(method, params) {
      calls.push({ method, params });
      const answer = answers[method];
      if (answer === undefined) throw new Error(`unexpected call: ${method}`);
      return typeof answer === 'function' ? answer(params) : answer;
    },
  };
  return { rpc, calls };
}

const localKeys = () => new LocalKeyProvider(KEY_HEX, { environment: 'test' });

const broadcastable = () =>
  fakeRpc({
    eth_getTransactionCount: '0x5',
    eth_getBalance: '0xde0b6b3a7640000',
    // Echo back the hash of whatever we were handed, which is what a node does.
    eth_sendRawTransaction: () => null,
  });

// ── the local provider's refusal ─────────────────────────────────────────────

test('a key in process memory is refused in production', () => {
  /**
   * The control is in the constructor, not in documentation. A warning in a README is
   * not a control; a process that fails to start is.
   */
  assert.throws(
    () => new LocalKeyProvider(KEY_HEX, { environment: 'production' }),
    /refusing a settlement key from an environment variable in production/,
  );
});

test('an unstated source is treated as an environment variable', () => {
  /**
   * The default has to be the strict answer, because the caller that forgets to say is exactly
   * the caller reading the key from wherever was easiest.
   */
  assert.throws(() => new LocalKeyProvider(KEY_HEX, { environment: 'production' }), SignerError);
});

test('a key delivered as a credential is allowed in production', () => {
  /**
   * Allowed because the refusal is about the exposure of an environment variable, not about the
   * key being in memory — every local signer holds it in memory. A file the process opens once
   * is not in `/proc/<pid>/environ`, not in the unit that started it, and under
   * `LoadCredentialEncrypted` not in plaintext on disk either.
   */
  const provider = new LocalKeyProvider(KEY_HEX, {
    environment: 'production',
    source: 'credential',
  });
  assert.ok(provider);
});

test('a key of the wrong length is refused', () => {
  assert.throws(() => new LocalKeyProvider('0x1234', { environment: 'test' }), SignerError);
});

test('the local provider derives the published address for the test key', async () => {
  assert.equal(await localKeys().address(), ADDRESS);
});

// ── initialisation ───────────────────────────────────────────────────────────

test('using the signer before initialise resolves is an error, not a wrong address', async () => {
  /**
   * The address is read asynchronously from the provider, so it cannot be available in
   * the constructor. Returning a placeholder would be far worse than throwing: it
   * would be used to build a transaction and the funds would go elsewhere.
   */
  const { rpc } = broadcastable();
  const signer = new EvmChainSigner(rpc, localKeys(), { chainId: 56 });
  assert.throws(() => signer.address, /before initialise/);

  await signer.initialise();
  assert.equal(signer.address, ADDRESS);
});

// ── nonce and balance ────────────────────────────────────────────────────────

test('the nonce comes from the pending state, not the latest block', async () => {
  /**
   * A transaction of ours already in the mempool occupies its nonce. Asking for
   * `latest` would hand back that same nonce and the next settlement would silently
   * replace the previous one instead of following it.
   */
  const { rpc, calls } = broadcastable();
  const signer = new EvmChainSigner(rpc, localKeys(), { chainId: 56 });
  await signer.initialise();

  assert.equal(await signer.pendingNonce(), 5);
  const call = calls.find((entry) => entry.method === 'eth_getTransactionCount');
  assert.equal(call?.params[1], 'pending');
});

test('a balance wider than a double survives', async () => {
  const huge = '0x' + (10n ** 30n).toString(16);
  const { rpc } = fakeRpc({ eth_getBalance: huge });
  const signer = new EvmChainSigner(rpc, localKeys(), { chainId: 56 });
  await signer.initialise();

  assert.equal(await signer.balanceWei(), 10n ** 30n);
});

test('a non-hex answer is refused rather than becoming NaN', async () => {
  const { rpc } = fakeRpc({ eth_getBalance: 'not-hex' });
  const signer = new EvmChainSigner(rpc, localKeys(), { chainId: 56 });
  await signer.initialise();

  await assert.rejects(() => signer.balanceWei(), SignerError);
});

// ── broadcasting ─────────────────────────────────────────────────────────────

const tx = {
  nonce: 5,
  to: '0x55d398326f99059fF775485246999027B3197955',
  data: '0xa9059cbb',
  gasLimit: 120_000n,
  feePerGasWei: 3_000_000_000n,
};

/** An RPC that returns the hash of the transaction it was given, as a node does. */
function honestNode() {
  let raw: string | null = null;
  const rpc: SigningRpc = {
    async call(method, params) {
      if (method === 'eth_sendRawTransaction') {
        raw = params[0] as string;
        // Recompute the hash the way a node would: keccak of the raw bytes.
        const { keccak256 } = await import('../crypto/keccak256.js');
        const { bytesToHex } = await import('../chains/evm/rlp.js');
        return bytesToHex(keccak256(hexToBytes(raw)));
      }
      throw new Error(`unexpected call: ${method}`);
    },
  };
  return { rpc, raw: () => raw };
}

test('a broadcast signs a type-2 transaction and returns the node hash', async () => {
  const node = honestNode();
  const signer = new EvmChainSigner(node.rpc, localKeys(), { chainId: 56 });
  await signer.initialise();

  const { hash } = await signer.broadcast(tx);
  assert.match(hash, /^0x[0-9a-f]{64}$/);
  assert.ok(node.raw()?.startsWith('0x02'), 'must be an EIP-1559 transaction');
});

test('the tip is a fraction of the ceiling, computed in integers', async () => {
  const node = honestNode();
  const signer = new EvmChainSigner(node.rpc, localKeys(), { chainId: 1, priorityFraction: 0.25 });
  await signer.initialise();
  await signer.broadcast(tx);

  const { createTxFromRLP } = await import('@ethereumjs/tx');
  const parsed = createTxFromRLP(hexToBytes(node.raw()!));
  // Narrowed by type, because the union covers legacy transactions that have no
  // 1559 fields — and asserting we produced a type-2 is part of the point.
  assert.equal(parsed.type, 2);
  const fees = parsed as unknown as { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  assert.equal(fees.maxFeePerGas, 3_000_000_000n);
  assert.equal(fees.maxPriorityFeePerGas, 750_000_000n);
  // And the sender is us, recovered independently.
  assert.equal(parsed.getSenderAddress().toString().toLowerCase(), ADDRESS.toLowerCase());
});

test('a nonsensical priority fraction is refused', async () => {
  const node = honestNode();
  const signer = new EvmChainSigner(node.rpc, localKeys(), { chainId: 56, priorityFraction: 1.5 });
  await signer.initialise();

  await assert.rejects(() => signer.broadcast(tx), /priorityFraction/);
});

test('a signature from the wrong key is caught before broadcast', async () => {
  /**
   * The failure with no other symptom. A signer reconfigured to a different key still
   * returns a valid signature; the network accepts the transaction and a wallet we do
   * not control pays for it. Recovery costs microseconds once per settlement.
   */
  const wrongKey = hexToBytes(`0x${'07'.repeat(32)}`);
  const impostor: KeyProvider = {
    async address() {
      return ADDRESS;
    },
    async signDigest(digest) {
      return signDigest(digest, wrongKey);
    },
  };

  const node = honestNode();
  const signer = new EvmChainSigner(node.rpc, impostor, { chainId: 56 });
  await signer.initialise();

  await assert.rejects(() => signer.broadcast(tx), /refusing to broadcast/);
  assert.equal(node.raw(), null, 'nothing should have reached the node');
});

test('a node reporting a different hash is treated as a disagreement, not a success', async () => {
  /**
   * If our serialisation and the node's parsing disagree, the transaction we are about
   * to record as in-flight is not the one on the network — so every later receipt
   * lookup would miss and the settlement would appear pending forever.
   */
  const { rpc } = fakeRpc({ eth_sendRawTransaction: `0x${'ab'.repeat(32)}` });
  const signer = new EvmChainSigner(rpc, localKeys(), { chainId: 56 });
  await signer.initialise();

  await assert.rejects(() => signer.broadcast(tx), /node returned hash/);
});

// ── receipts ─────────────────────────────────────────────────────────────────

test('a pending transaction has no receipt', async () => {
  const { rpc } = fakeRpc({ eth_getTransactionReceipt: null });
  const signer = new EvmChainSigner(rpc, localKeys(), { chainId: 56 });
  await signer.initialise();

  assert.equal(await signer.receipt(`0x${'11'.repeat(32)}`), null);
});

test('a receipt reports the effective price paid, not the ceiling we offered', async () => {
  /**
   * On a 1559 chain the price actually paid is below the ceiling whenever the base fee
   * was lower than assumed. Recording the ceiling would overstate every settlement and
   * exhaust the rolling spend cap early, deferring settlements that were affordable.
   */
  const { rpc } = fakeRpc({
    eth_getTransactionReceipt: { status: '0x1', gasUsed: '0x1d4c0', effectiveGasPrice: '0x3b9aca00' },
  });
  const signer = new EvmChainSigner(rpc, localKeys(), { chainId: 56 });
  await signer.initialise();

  const receipt = await signer.receipt(`0x${'11'.repeat(32)}`);
  assert.equal(receipt?.status, 'success');
  assert.equal(receipt?.gasUsed, 120_000n);
  assert.equal(receipt?.feePerGasWei, 1_000_000_000n);
});

test('a reverted receipt is reported as reverted', async () => {
  const { rpc } = fakeRpc({
    eth_getTransactionReceipt: { status: '0x0', gasUsed: '0x5208', effectiveGasPrice: '0x1' },
  });
  const signer = new EvmChainSigner(rpc, localKeys(), { chainId: 56 });
  await signer.initialise();

  assert.equal((await signer.receipt(`0x${'11'.repeat(32)}`))?.status, 'reverted');
});

// ── the external-signer provider ─────────────────────────────────────────────

test('a DER-returning signer works through the same interface', async () => {
  /**
   * This is the shape of AWS KMS, GCP KMS and PKCS#11: DER out, no recovery id, no
   * low-`s` guarantee. If this path works, a KMS can be dropped in without the signer
   * above knowing anything changed.
   */
  const key = hexToBytes(KEY_HEX);
  const provider = new DerKeyProvider(ADDRESS, async (digest) => {
    const signature = signDigest(digest, key);
    const encode = (value: bigint) => {
      let bytes = [...Buffer.from(value.toString(16).padStart(64, '0'), 'hex')];
      while (bytes.length > 1 && bytes[0] === 0 && bytes[1]! < 0x80) bytes = bytes.slice(1);
      if (bytes[0]! >= 0x80) bytes = [0x00, ...bytes];
      return [0x02, bytes.length, ...bytes];
    };
    const body = [...encode(signature.r), ...encode(signature.s)];
    return Uint8Array.from([0x30, body.length, ...body]);
  });

  const node = honestNode();
  // Chain id 1 so @ethereumjs's default Common accepts the bytes back; the chain-id
  // field itself is pinned in transaction.test.ts.
  const signer = new EvmChainSigner(node.rpc, provider, { chainId: 1 });
  await signer.initialise();
  await signer.broadcast(tx);

  const { createTxFromRLP } = await import('@ethereumjs/tx');
  const parsed = createTxFromRLP(hexToBytes(node.raw()!));
  assert.equal(parsed.getSenderAddress().toString().toLowerCase(), ADDRESS.toLowerCase());
});

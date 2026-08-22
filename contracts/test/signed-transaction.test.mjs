import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Common, Hardfork, Mainnet } from '@ethereumjs/common';
import { createAccount, createAddressFromString, hexToBytes } from '@ethereumjs/util';
import { createTxFromRLP } from '@ethereumjs/tx';
import { createVM, runTx } from '@ethereumjs/vm';

/**
 * Transactions this project signs, executed on a real EVM.
 *
 * Every other test of the signing path checks our own arithmetic against published
 * vectors, which proves the bytes are what the specification says. This one proves
 * something different and stronger: that an independent EVM implementation parses
 * those bytes, recovers the sender we intended, and runs the call.
 *
 * That distinction is the whole point. A signing bug that is self-consistent passes
 * every vector test and still produces a transaction whose gas is paid by a wallet we
 * do not control — because the address the network recovers is not the address we
 * think we are signing for. Only a second implementation can catch that.
 */

const here = dirname(fileURLToPath(import.meta.url));
const { artifacts } = JSON.parse(
  readFileSync(join(here, '..', 'artifacts', 'contracts.json'), 'utf8'),
);

const OPERATOR_KEY = '0x4646464646464646464646464646464646464646464646464646464646464646';
const BASE_FEE = 10n;
const CHAIN_ID = 1;

describe('signed transactions on a real EVM', () => {
  let core;
  let vm;
  let operator;

  before(async () => {
    core = await import('../../packages/core/dist/index.js');
    vm = await createVM({ common: new Common({ chain: Mainnet, hardfork: Hardfork.Cancun }) });

    operator = core.addressFromPrivateKey(hexToBytes(OPERATOR_KEY));
    await vm.stateManager.putAccount(
      createAddressFromString(operator.toLowerCase()),
      createAccount({ nonce: 0n, balance: 10n ** 20n }),
    );
  });

  /** Sign with our own code, then hand the raw bytes to the VM to parse and run. */
  async function signAndRun(overrides = {}) {
    const account = await vm.stateManager.getAccount(
      createAddressFromString(operator.toLowerCase()),
    );

    const transaction = {
      chainId: CHAIN_ID,
      nonce: Number(account.nonce),
      maxPriorityFeePerGas: 1n,
      maxFeePerGas: BASE_FEE * 4n,
      gasLimit: 500_000n,
      value: 0n,
      data: new Uint8Array(0),
      ...overrides,
    };

    const digest = core.signingHash(transaction);
    const signature = core.signDigest(digest, hexToBytes(OPERATOR_KEY));
    const { raw, hash } = core.serializeSigned(transaction, signature);

    // Parsed by @ethereumjs, not by us. If our serialisation is wrong, this throws.
    const parsed = createTxFromRLP(hexToBytes(raw), {
      common: new Common({ chain: Mainnet, hardfork: Hardfork.Cancun }),
    });

    return {
      parsed,
      ourHash: hash,
      result: await runTx(vm, { tx: parsed, skipBalance: true, skipBlockGasLimitValidation: true }),
    };
  }

  test('an independent EVM recovers the sender we signed as', async () => {
    /**
     * The assertion that matters. Our address derivation and our signature both feed
     * into this, and a mistake in either produces a different sender here while every
     * self-consistent test still passes.
     */
    const { parsed } = await signAndRun({ to: '0x' + '11'.repeat(20) });
    assert.equal(parsed.getSenderAddress().toString().toLowerCase(), operator.toLowerCase());
  });

  test('the transaction hash we compute matches the one the EVM computes', async () => {
    // We record this hash as in-flight and later look up its receipt by it. If it
    // disagreed with the network's, the settlement would appear permanently pending.
    const { parsed, ourHash } = await signAndRun({ to: '0x' + '22'.repeat(20) });
    assert.equal(`0x${Buffer.from(parsed.hash()).toString('hex')}`, ourHash.toLowerCase());
  });

  test('the fields survive the round trip exactly', async () => {
    const { parsed } = await signAndRun({
      to: '0x' + '33'.repeat(20),
      gasLimit: 123_456n,
      maxFeePerGas: 77n,
      maxPriorityFeePerGas: 11n,
      value: 0n,
    });

    assert.equal(parsed.type, 2, 'must be an EIP-1559 transaction');
    assert.equal(parsed.chainId, BigInt(CHAIN_ID));
    assert.equal(parsed.gasLimit, 123_456n);
    assert.equal(parsed.maxFeePerGas, 77n);
    assert.equal(parsed.maxPriorityFeePerGas, 11n);
    assert.equal(parsed.value, 0n);
    assert.equal(parsed.accessList.length, 0);
  });

  test('a signed deployment actually deploys, and a signed call actually runs', async () => {
    /**
     * End to end through the real contracts: deploy the forwarder factory with a
     * transaction we signed, then call it with another. If the encoding were wrong in
     * a way the parser tolerated, the call would revert or hit the wrong selector.
     */
    /**
     * The logic contract first, because the factory takes its address.
     *
     * Also signed, rather than injected into the state — the point of this suite is that our
     * own encoder produces transactions a real client would accept, and a deployment with a
     * constructor argument is the case where a padding mistake would show.
     */
    const logic = await signAndRun({
      to: null,
      data: hexToBytes(`0x${artifacts.ForwarderLogic.creationCode.replace(/^0x/, '')}`),
      gasLimit: 3_000_000n,
    });
    assert.equal(logic.result.execResult.exceptionError, undefined);
    const logicAddress = logic.result.createdAddress;
    assert.ok(logicAddress, 'the logic deployment should produce an address');

    const factory = artifacts.ForwarderFactory;
    const deployment = await signAndRun({
      to: null,
      data: hexToBytes(
        `0x${factory.creationCode.replace(/^0x/, '')}` +
          logicAddress.toString().replace('0x', '').padStart(64, '0'),
      ),
      gasLimit: 3_000_000n,
    });

    assert.equal(deployment.result.execResult.exceptionError, undefined);
    const factoryAddress = deployment.result.createdAddress;
    assert.ok(factoryAddress, 'the deployment should produce an address');

    // Now call `predict` on it with a second signed transaction. A zero fee, which
    // still occupies its two words in the calldata.
    const salt = new Uint8Array(32).fill(9);
    const destination = '0x' + '44'.repeat(20);
    const zeroAddress = `0x${'00'.repeat(20)}`;
    const selector = core.selectorFor('predict(bytes32,address,address,uint16)');
    const call = await signAndRun({
      to: factoryAddress.toString(),
      data: new Uint8Array([
        ...selector,
        ...core.word(salt),
        ...core.addressWord(destination),
        ...core.addressWord(zeroAddress),
        ...core.word(new Uint8Array(32)),
      ]),
    });

    assert.equal(call.result.execResult.exceptionError, undefined, 'the call must not revert');
    const returned = call.result.execResult.returnValue;
    assert.equal(returned.length, 32, 'predict returns one address word');

    // And the address it returns matches what we derive off-chain — the guarantee the
    // whole non-custodial model rests on, now reached through a signed transaction.
    const onChain = `0x${Buffer.from(returned.subarray(12)).toString('hex')}`;
    const offChain = core.create2Address(
      factoryAddress.toString(),
      salt,
      core.initCodeHash(
        { factory: factoryAddress.toString(), implementation: logicAddress.toString() },
        destination,
      ),
    );
    assert.equal(onChain.toLowerCase(), offChain.toLowerCase());
  });

  test('the nonce advances, so a second transaction is not a replacement', async () => {
    const before = await vm.stateManager.getAccount(
      createAddressFromString(operator.toLowerCase()),
    );
    await signAndRun({ to: '0x' + '55'.repeat(20) });
    const after = await vm.stateManager.getAccount(
      createAddressFromString(operator.toLowerCase()),
    );

    assert.equal(after.nonce, before.nonce + 1n);
  });
});

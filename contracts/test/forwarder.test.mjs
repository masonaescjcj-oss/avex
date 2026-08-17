import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Common, Hardfork, Mainnet } from '@ethereumjs/common';
import {
  bytesToHex,
  createAccount,
  createAddressFromPrivateKey,
  createAddressFromString,
  hexToBytes,
} from '@ethereumjs/util';
import { createVM, runTx } from '@ethereumjs/vm';
import { createLegacyTx } from '@ethereumjs/tx';

import { predictForwarder } from '../../packages/core/dist/index.js';

/**
 * Executes the contracts on a real EVM.
 *
 * This is the test the non-custodial claim rests on. Everything else about
 * deposit addresses is arithmetic that has already been checked against the
 * EIP-1014 vectors; what has not been checked until here is that the init code
 * this repository *composes* off-chain is byte-for-byte what solc and the EVM
 * actually use. If those disagree, every address handed to a payer is one no
 * CREATE2 will ever produce, and the funds sent there are unreachable.
 *
 * Runs in-process, so it needs no testnet, no key and no funds — which means it
 * runs in CI on every commit rather than once, by hand, before a deploy.
 */

const here = dirname(fileURLToPath(import.meta.url));
const { artifacts } = JSON.parse(
  readFileSync(join(here, '..', 'artifacts', 'contracts.json'), 'utf8'),
);

const DEPLOYER_KEY = hexToBytes(
  '0x4646464646464646464646464646464646464646464646464646464646464646',
);

/** Above the genesis block's base fee, which a zero gas price would fall below. */
const BASE_FEE = 10n;

const MERCHANT = '0x1111111111111111111111111111111111111111';
const OTHER_MERCHANT = '0x2222222222222222222222222222222222222222';

/** Selector for a signature, computed the same way the application does. */
function selector(signature) {
  // Reuses the audited implementation rather than a second one written for tests.
  return keccakHex(signature).slice(0, 10);
}

let keccakHex;

function word(value) {
  return value.toString(16).padStart(64, '0');
}

function addressWord(address) {
  return address.toLowerCase().replace('0x', '').padStart(64, '0');
}

describe('Forwarder on a real EVM', () => {
  let vm;
  let deployer;
  let nonce = 0n;
  let factoryAddress;
  let core;

  before(async () => {
    core = await import('../../packages/core/dist/index.js');
    keccakHex = (text) => core.keccak256Hex(text);

    const common = new Common({ chain: Mainnet, hardfork: Hardfork.Cancun });
    vm = await createVM({ common });

    deployer = createAddressFromPrivateKey(DEPLOYER_KEY);
    await vm.stateManager.putAccount(
      deployer,
      createAccount({ nonce: 0n, balance: 10n ** 22n }),
    );
  });

  /** Deploy a contract and return its address. */
  async function deploy(creationCode, constructorArgsHex = '') {
    const tx = createLegacyTx(
      {
        nonce: nonce++,
        gasPrice: BASE_FEE,
        gasLimit: 10_000_000n,
        data: hexToBytes(creationCode + constructorArgsHex),
        value: 0n,
      },
      { common: vm.common },
    ).sign(DEPLOYER_KEY);

    const result = await runTx(vm, { tx, skipBalance: true, skipBlockGasLimitValidation: true });
    assert.equal(result.execResult.exceptionError, undefined, 'deployment reverted');
    return result.createdAddress;
  }

  async function call(to, dataHex, { from = deployer } = {}) {
    const tx = createLegacyTx(
      {
        nonce: nonce++,
        gasPrice: BASE_FEE,
        gasLimit: 10_000_000n,
        to: to.toString(),
        data: hexToBytes(dataHex),
        value: 0n,
      },
      { common: vm.common },
    ).sign(DEPLOYER_KEY);

    const result = await runTx(vm, { tx, skipBalance: true, skipBlockGasLimitValidation: true });
    return result.execResult;
  }

  test('the factory deploys', async () => {
    const address = await deploy(artifacts.ForwarderFactory.creationCode);
    assert.ok(address, 'factory should have an address');
    factoryAddress = address;
  });

  test('the off-chain address matches what the contract predicts', async () => {
    // The claim under test. `predictForwarder` composes init code as
    // creationCode ++ abi.encode(destination) and hashes it; the factory does the
    // same inside the EVM. A mismatch means every published address is wrong.
    const invoiceId = 'inv_01HQZX3E7K';

    const offChain = predictForwarder(
      {
        factory: factoryAddress.toString(),
        forwarderCreationCode: artifacts.Forwarder.creationCode,
      },
      invoiceId,
      MERCHANT,
    );

    const salt = core.keccak256Hex(invoiceId).slice(2);
    const result = await call(
      factoryAddress,
      selector('predict(bytes32,address)') + salt + addressWord(MERCHANT),
    );

    const onChain = `0x${bytesToHex(result.returnValue).slice(-40)}`;
    assert.equal(
      offChain.toLowerCase(),
      onChain.toLowerCase(),
      'off-chain derivation disagrees with the on-chain factory',
    );
  });

  test('deploying at the predicted address produces exactly that address', async () => {
    // predict() agreeing with our arithmetic is necessary but not sufficient: the
    // EVM must also place the contract there when CREATE2 actually runs.
    const invoiceId = 'inv_deploy_check';
    const predicted = predictForwarder(
      {
        factory: factoryAddress.toString(),
        forwarderCreationCode: artifacts.Forwarder.creationCode,
      },
      invoiceId,
      MERCHANT,
    );

    const salt = core.keccak256Hex(invoiceId).slice(2);
    await call(
      factoryAddress,
      selector('deploy(bytes32,address)') + salt + addressWord(MERCHANT),
    );

    const code = await vm.stateManager.getCode(createAddressFromString(predicted.toLowerCase()));
    assert.ok(code.length > 0, `no contract deployed at the predicted address ${predicted}`);
  });

  test('the deployed forwarder is bound to its merchant and no other', async () => {
    const invoiceId = 'inv_binding_check';
    const predicted = predictForwarder(
      {
        factory: factoryAddress.toString(),
        forwarderCreationCode: artifacts.Forwarder.creationCode,
      },
      invoiceId,
      MERCHANT,
    );

    const salt = core.keccak256Hex(invoiceId).slice(2);
    await call(factoryAddress, selector('deploy(bytes32,address)') + salt + addressWord(MERCHANT));

    const result = await call(
      createAddressFromString(predicted.toLowerCase()),
      selector('destination()'),
    );
    const stored = `0x${bytesToHex(result.returnValue).slice(-40)}`;

    // Immutable, set in the constructor, and part of the init code hash — so this
    // value is what the address itself commits to.
    assert.equal(stored.toLowerCase(), MERCHANT.toLowerCase());
  });

  test('the same invoice for a different merchant yields a different address', async () => {
    // Because the destination feeds the init code hash, an address cannot be
    // re-pointed after being handed out. This is the guarantee, stated as a test.
    const config = {
      factory: factoryAddress.toString(),
      forwarderCreationCode: artifacts.Forwarder.creationCode,
    };

    const forMerchant = predictForwarder(config, 'inv_same', MERCHANT);
    const forOther = predictForwarder(config, 'inv_same', OTHER_MERCHANT);
    assert.notEqual(forMerchant, forOther);

    // And the EVM agrees, not just our arithmetic.
    const salt = core.keccak256Hex('inv_same').slice(2);
    const predictedOther = await call(
      factoryAddress,
      selector('predict(bytes32,address)') + salt + addressWord(OTHER_MERCHANT),
    );
    assert.equal(
      `0x${bytesToHex(predictedOther.returnValue).slice(-40)}`.toLowerCase(),
      forOther.toLowerCase(),
    );
  });

  test('tokens sent to a predicted address reach the merchant', async () => {
    // The end-to-end path: an address is published before any code exists at it,
    // a payer sends tokens, and one transaction deploys the forwarder and forwards
    // the balance.
    const token = await deploy(
      artifacts.MockERC20.creationCode,
      // ("USDT", 18, feeBps 0) — dynamic string, so offset first.
      word(96n) + word(18n) + word(0n) + word(4n) + Buffer.from('USDT').toString('hex').padEnd(64, '0'),
    );

    const invoiceId = 'inv_settlement';
    const config = {
      factory: factoryAddress.toString(),
      forwarderCreationCode: artifacts.Forwarder.creationCode,
    };
    const depositAddress = predictForwarder(config, invoiceId, MERCHANT);

    // Nothing is deployed there yet — exactly the state a payer sends into.
    const before_ = await vm.stateManager.getCode(
      createAddressFromString(depositAddress.toLowerCase()),
    );
    assert.equal(before_.length, 0, 'the address must be empty when published');

    const amount = 20n * 10n ** 18n;
    await call(
      token,
      selector('mint(address,uint256)') + addressWord(depositAddress) + word(amount),
    );

    // Settle: deploy and flush in one transaction.
    const salt = core.keccak256Hex(invoiceId).slice(2);
    const settlement =
      selector('settleBatch((bytes32,address,address)[])') +
      word(32n) + // offset to the array
      word(1n) + // one element
      salt +
      addressWord(MERCHANT) +
      addressWord(token.toString());

    const result = await call(factoryAddress, settlement);
    assert.equal(result.exceptionError, undefined, 'settlement reverted');

    const merchantBalance = await call(
      token,
      selector('balanceOf(address)') + addressWord(MERCHANT),
    );
    assert.equal(
      BigInt(bytesToHex(merchantBalance.returnValue)),
      amount,
      'the merchant should have received the full amount',
    );

    const leftover = await call(
      token,
      selector('balanceOf(address)') + addressWord(depositAddress),
    );
    assert.equal(BigInt(bytesToHex(leftover.returnValue)), 0n, 'nothing should be left behind');
  });

  test('a batch settles several invoices in one transaction', async () => {
    // What makes deferred settlement worth it: the fixed cost is paid once.
    const token = await deploy(
      artifacts.MockERC20.creationCode,
      word(96n) + word(6n) + word(0n) + word(4n) + Buffer.from('USDC').toString('hex').padEnd(64, '0'),
    );

    const config = {
      factory: factoryAddress.toString(),
      forwarderCreationCode: artifacts.Forwarder.creationCode,
    };
    const invoices = ['batch_a', 'batch_b', 'batch_c'];
    const amount = 5n * 10n ** 6n;

    for (const invoiceId of invoices) {
      const address = predictForwarder(config, invoiceId, MERCHANT);
      await call(token, selector('mint(address,uint256)') + addressWord(address) + word(amount));
    }

    let elements = '';
    for (const invoiceId of invoices) {
      elements +=
        core.keccak256Hex(invoiceId).slice(2) + addressWord(MERCHANT) + addressWord(token.toString());
    }

    const result = await call(
      factoryAddress,
      selector('settleBatch((bytes32,address,address)[])') +
        word(32n) +
        word(BigInt(invoices.length)) +
        elements,
    );
    assert.equal(result.exceptionError, undefined, 'batch settlement reverted');

    const balance = await call(token, selector('balanceOf(address)') + addressWord(MERCHANT));
    assert.equal(BigInt(bytesToHex(balance.returnValue)), amount * BigInt(invoices.length));
  });

  test('a fee-on-transfer token delivers less than was sent', async () => {
    // Confirms the hazard the vetting probe looks for is real, against a token
    // that genuinely takes a cut rather than a stub that reports one.
    const token = await deploy(
      artifacts.MockERC20.creationCode,
      // 100 bps fee.
      word(96n) + word(18n) + word(100n) + word(4n) + Buffer.from('FEET').toString('hex').padEnd(64, '0'),
    );

    const config = {
      factory: factoryAddress.toString(),
      forwarderCreationCode: artifacts.Forwarder.creationCode,
    };
    const depositAddress = predictForwarder(config, 'inv_fee', MERCHANT);

    const amount = 100n * 10n ** 18n;
    await call(
      token,
      selector('mint(address,uint256)') + addressWord(depositAddress) + word(amount),
    );

    const salt = core.keccak256Hex('inv_fee').slice(2);
    await call(
      factoryAddress,
      selector('settleBatch((bytes32,address,address)[])') +
        word(32n) +
        word(1n) +
        salt +
        addressWord(MERCHANT) +
        addressWord(token.toString()),
    );

    const balance = await call(token, selector('balanceOf(address)') + addressWord(MERCHANT));
    const received = BigInt(bytesToHex(balance.returnValue));

    // 1% short. An invoice tolerance below this would read every payment as
    // underpaid — which is why the probe measures the fee and the reviewer records it.
    assert.equal(received, (amount * 9900n) / 10_000n);
    assert.ok(received < amount);
  });

  test('native value sent before deployment is forwarded on deployment', async () => {
    const config = {
      factory: factoryAddress.toString(),
      forwarderCreationCode: artifacts.Forwarder.creationCode,
    };
    const depositAddress = predictForwarder(config, 'inv_native', MERCHANT);
    const target = createAddressFromString(depositAddress.toLowerCase());

    // Fund the empty address directly, as a payer sending the native asset would.
    const value = 3n * 10n ** 18n;
    await vm.stateManager.putAccount(target, createAccount({ nonce: 0n, balance: value }));

    const merchantBefore =
      (await vm.stateManager.getAccount(createAddressFromString(MERCHANT.toLowerCase())))
        ?.balance ?? 0n;

    const salt = core.keccak256Hex('inv_native').slice(2);
    const result = await call(
      factoryAddress,
      selector('deploy(bytes32,address)') + salt + addressWord(MERCHANT),
    );
    assert.equal(result.exceptionError, undefined, 'deployment reverted');

    const merchantAfter =
      (await vm.stateManager.getAccount(createAddressFromString(MERCHANT.toLowerCase())))
        ?.balance ?? 0n;

    // The constructor sweeps whatever was waiting, so a payer who sent before
    // deployment is not stranded.
    assert.equal(merchantAfter - merchantBefore, value);
  });

  test('the artifacts record the exact compiler settings', () => {
    // The deposit address is a hash over this bytecode, so a recompile with
    // different settings changes every address already handed out. The settings
    // travel with the artifact so that change is visible in review.
    const manifest = JSON.parse(
      readFileSync(join(here, '..', 'artifacts', 'contracts.json'), 'utf8'),
    );
    assert.match(manifest.solcVersion, /^0\.8\./);
    assert.equal(manifest.settings.optimizer.enabled, true);
    assert.equal(manifest.settings.optimizer.runs, 200);
    assert.equal(manifest.settings.evmVersion, 'cancun');
  });
});

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
/** Where a percentage fee goes. AVEX's own address, on this chain. */
const FEE_COLLECTOR = '0x3333333333333333333333333333333333333333';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** No fee: the merchant receives everything the forwarder holds. */
const NO_FEE = { feeDestination: ZERO_ADDRESS, feeBps: 0 };

const PREDICT = 'predict(bytes32,address,address,uint16)';
const DEPLOY = 'deploy(bytes32,address,address,uint16)';
const SETTLE_BATCH = 'settleBatch((bytes32,address,address,uint16,address)[])';

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

/**
 * Calldata builders, so the ABI is written once.
 *
 * The struct is five static words in a fixed order and the encoding carries no
 * field names, so transposing `feeDestination` and `token` would silently send a
 * merchant's balance to the wrong place rather than fail to decode. One definition
 * is one place for that to be wrong.
 */
function predictCall(invoiceId, destination, fee = NO_FEE) {
  return (
    selector(PREDICT) +
    keccakHex(invoiceId).slice(2) +
    addressWord(destination) +
    addressWord(fee.feeDestination) +
    word(BigInt(fee.feeBps))
  );
}

function deployCall(invoiceId, destination, fee = NO_FEE) {
  return (
    selector(DEPLOY) +
    keccakHex(invoiceId).slice(2) +
    addressWord(destination) +
    addressWord(fee.feeDestination) +
    word(BigInt(fee.feeBps))
  );
}

function settleBatchCall(items) {
  let elements = '';
  for (const item of items) {
    const fee = item.fee ?? NO_FEE;
    elements +=
      keccakHex(item.invoiceId).slice(2) +
      addressWord(item.destination) +
      addressWord(fee.feeDestination) +
      word(BigInt(fee.feeBps)) +
      addressWord(item.token ?? ZERO_ADDRESS);
  }
  return selector(SETTLE_BATCH) + word(32n) + word(BigInt(items.length)) + elements;
}

/** The address the application would publish for these parameters. */
function offChainAddress(factoryAddress, invoiceId, destination, fee = NO_FEE) {
  return predictForwarder(
    {
      factory: factoryAddress.toString(),
      forwarderCreationCode: artifacts.Forwarder.creationCode,
    },
    invoiceId,
    destination,
    fee,
  );
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

    const offChain = offChainAddress(factoryAddress, invoiceId, MERCHANT);

    const result = await call(
      factoryAddress,
      predictCall(invoiceId, MERCHANT),
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
    const predicted = offChainAddress(factoryAddress, invoiceId, MERCHANT);

    await call(
      factoryAddress,
      deployCall(invoiceId, MERCHANT),
    );

    const code = await vm.stateManager.getCode(createAddressFromString(predicted.toLowerCase()));
    assert.ok(code.length > 0, `no contract deployed at the predicted address ${predicted}`);
  });

  test('the deployed forwarder is bound to its merchant and no other', async () => {
    const invoiceId = 'inv_binding_check';
    const predicted = offChainAddress(factoryAddress, invoiceId, MERCHANT);

    await call(factoryAddress, deployCall(invoiceId, MERCHANT));

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

    const forMerchant = offChainAddress(factoryAddress, 'inv_same', MERCHANT);
    const forOther = offChainAddress(factoryAddress, 'inv_same', OTHER_MERCHANT);
    assert.notEqual(forMerchant, forOther);

    // And the EVM agrees, not just our arithmetic.
    const predictedOther = await call(
      factoryAddress,
      predictCall('inv_same', OTHER_MERCHANT),
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
    const depositAddress = offChainAddress(factoryAddress, invoiceId, MERCHANT);

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
    const result = await call(
      factoryAddress,
      settleBatchCall([{ invoiceId, destination: MERCHANT, token: token.toString() }]),
    );
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

    const invoices = ['batch_a', 'batch_b', 'batch_c'];
    const amount = 5n * 10n ** 6n;

    for (const invoiceId of invoices) {
      const address = offChainAddress(factoryAddress, invoiceId, MERCHANT);
      await call(token, selector('mint(address,uint256)') + addressWord(address) + word(amount));
    }

    const result = await call(
      factoryAddress,
      settleBatchCall(
        invoices.map((invoiceId) => ({
          invoiceId,
          destination: MERCHANT,
          token: token.toString(),
        })),
      ),
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

    const depositAddress = offChainAddress(factoryAddress, 'inv_fee', MERCHANT);

    const amount = 100n * 10n ** 18n;
    await call(
      token,
      selector('mint(address,uint256)') + addressWord(depositAddress) + word(amount),
    );

    await call(
      factoryAddress,
      settleBatchCall([
        { invoiceId: 'inv_fee', destination: MERCHANT, token: token.toString() },
      ]),
    );

    const balance = await call(token, selector('balanceOf(address)') + addressWord(MERCHANT));
    const received = BigInt(bytesToHex(balance.returnValue));

    // 1% short. An invoice tolerance below this would read every payment as
    // underpaid — which is why the probe measures the fee and the reviewer records it.
    assert.equal(received, (amount * 9900n) / 10_000n);
    assert.ok(received < amount);
  });

  test('native value sent before deployment is forwarded on deployment', async () => {
    const depositAddress = offChainAddress(factoryAddress, 'inv_native', MERCHANT);
    const target = createAddressFromString(depositAddress.toLowerCase());

    // Fund the empty address directly, as a payer sending the native asset would.
    const value = 3n * 10n ** 18n;
    await vm.stateManager.putAccount(target, createAccount({ nonce: 0n, balance: value }));

    const merchantBefore =
      (await vm.stateManager.getAccount(createAddressFromString(MERCHANT.toLowerCase())))
        ?.balance ?? 0n;

    const result = await call(factoryAddress, deployCall('inv_native', MERCHANT));
    assert.equal(result.exceptionError, undefined, 'deployment reverted');

    const merchantAfter =
      (await vm.stateManager.getAccount(createAddressFromString(MERCHANT.toLowerCase())))
        ?.balance ?? 0n;

    // The constructor sweeps whatever was waiting, so a payer who sent before
    // deployment is not stranded.
    assert.equal(merchantAfter - merchantBefore, value);
  });

  // ── the fee split ─────────────────────────────────────────────────────────
  //
  // A percentage fee is the only way to charge in proportion to what a merchant
  // actually processes, and the non-custodial design means money never passes
  // through an account of ours to take it from. Splitting inside the forwarder is
  // the answer, and it only holds if the split is part of the address.

  async function tokenBalance(token, holder) {
    const result = await call(token, selector('balanceOf(address)') + addressWord(holder));
    return BigInt(bytesToHex(result.returnValue));
  }

  async function nativeBalance(address) {
    const account = await vm.stateManager.getAccount(
      createAddressFromString(address.toLowerCase()),
    );
    return account?.balance ?? 0n;
  }

  /** A plain 18-decimal token that takes no cut of its own. */
  async function plainToken(symbol) {
    return deploy(
      artifacts.MockERC20.creationCode,
      word(96n) +
        word(18n) +
        word(0n) +
        word(4n) +
        Buffer.from(symbol).toString('hex').padEnd(64, '0'),
    );
  }

  test('a fee changes the deposit address, so it cannot be raised after quoting', async () => {
    /**
     * The guarantee the whole design rests on, now covering the fee as well as the
     * destination. If AVEX decided to take 2% from an address quoted at 1%, CREATE2
     * would put that contract somewhere else entirely — not at the address the
     * payer funded. There is no version of this we could do quietly.
     */
    const free = offChainAddress(factoryAddress, 'inv_fee_bind', MERCHANT);
    const onePercent = offChainAddress(factoryAddress, 'inv_fee_bind', MERCHANT, {
      feeDestination: FEE_COLLECTOR,
      feeBps: 100,
    });
    const twoPercent = offChainAddress(factoryAddress, 'inv_fee_bind', MERCHANT, {
      feeDestination: FEE_COLLECTOR,
      feeBps: 200,
    });

    assert.notEqual(free, onePercent, 'a fee must change the address');
    assert.notEqual(onePercent, twoPercent, 'a different rate must change the address');

    // And the EVM agrees with our arithmetic, which is the part that matters.
    const result = await call(
      factoryAddress,
      predictCall('inv_fee_bind', MERCHANT, { feeDestination: FEE_COLLECTOR, feeBps: 100 }),
    );
    assert.equal(
      `0x${bytesToHex(result.returnValue).slice(-40)}`.toLowerCase(),
      onePercent.toLowerCase(),
    );
  });

  test('sending the fee to a different collector changes the address too', async () => {
    // Otherwise the rate would be committed but the recipient would not, and the
    // fee could be redirected without changing the address the payer was given.
    const toUs = offChainAddress(factoryAddress, 'inv_collector', MERCHANT, {
      feeDestination: FEE_COLLECTOR,
      feeBps: 100,
    });
    const toSomeoneElse = offChainAddress(factoryAddress, 'inv_collector', MERCHANT, {
      feeDestination: OTHER_MERCHANT,
      feeBps: 100,
    });
    assert.notEqual(toUs, toSomeoneElse);
  });

  test('a token settlement splits the fee and the merchant gets the rest', async () => {
    const token = await plainToken('USDT');
    const fee = { feeDestination: FEE_COLLECTOR, feeBps: 100 }; // 1%
    const depositAddress = offChainAddress(factoryAddress, 'inv_split', MERCHANT, fee);

    const amount = 1_000n * 10n ** 18n;
    await call(
      token,
      selector('mint(address,uint256)') + addressWord(depositAddress) + word(amount),
    );

    const merchantBefore = await tokenBalance(token, MERCHANT);
    const collectorBefore = await tokenBalance(token, FEE_COLLECTOR);

    const result = await call(
      factoryAddress,
      settleBatchCall([
        { invoiceId: 'inv_split', destination: MERCHANT, token: token.toString(), fee },
      ]),
    );
    assert.equal(result.exceptionError, undefined, 'settlement reverted');

    const collected = (await tokenBalance(token, FEE_COLLECTOR)) - collectorBefore;
    const paid = (await tokenBalance(token, MERCHANT)) - merchantBefore;

    assert.equal(collected, amount / 100n, 'the collector should have 1%');
    assert.equal(paid, amount - amount / 100n, 'the merchant should have the other 99%');
    // Conservation, asserted rather than assumed: nothing was created or burned.
    assert.equal(collected + paid, amount);
    assert.equal(await tokenBalance(token, depositAddress), 0n, 'nothing left behind');
  });

  test('a zero fee moves the whole balance and touches no collector', async () => {
    // The common case — a subscription-only merchant. Worth its own test because a
    // fee of zero must not cost an extra transfer, and must not send a zero-value
    // transfer to the zero address.
    const token = await plainToken('ZERO');
    const depositAddress = offChainAddress(factoryAddress, 'inv_nofee', MERCHANT);

    const amount = 42n * 10n ** 18n;
    await call(
      token,
      selector('mint(address,uint256)') + addressWord(depositAddress) + word(amount),
    );
    const before = await tokenBalance(token, MERCHANT);

    await call(
      factoryAddress,
      settleBatchCall([
        { invoiceId: 'inv_nofee', destination: MERCHANT, token: token.toString() },
      ]),
    );

    assert.equal((await tokenBalance(token, MERCHANT)) - before, amount);
    assert.equal(await tokenBalance(token, ZERO_ADDRESS), 0n, 'nothing sent to the zero address');
  });

  test('the fee rounds down, so the remainder falls to the merchant', async () => {
    /**
     * An amount chosen so the fee does not divide evenly: 1% of 999 wei-equivalent
     * units is 9.99. We take 9 and the merchant gets 990 — never the other way.
     * "We round our own cut in our favour" is indefensible however small the number.
     */
    const token = await plainToken('ODD');
    const fee = { feeDestination: FEE_COLLECTOR, feeBps: 100 };
    const depositAddress = offChainAddress(factoryAddress, 'inv_round', MERCHANT, fee);

    const amount = 999n;
    await call(
      token,
      selector('mint(address,uint256)') + addressWord(depositAddress) + word(amount),
    );
    const merchantBefore = await tokenBalance(token, MERCHANT);
    const collectorBefore = await tokenBalance(token, FEE_COLLECTOR);

    await call(
      factoryAddress,
      settleBatchCall([
        { invoiceId: 'inv_round', destination: MERCHANT, token: token.toString(), fee },
      ]),
    );

    assert.equal((await tokenBalance(token, FEE_COLLECTOR)) - collectorBefore, 9n);
    assert.equal((await tokenBalance(token, MERCHANT)) - merchantBefore, 990n);
    // And no dust is stranded, which is what "send everything remaining" buys.
    assert.equal(await tokenBalance(token, depositAddress), 0n);
  });

  test('a fee smaller than one unit is not charged at all', async () => {
    // 1% of 50 units rounds to zero. The merchant receives everything and the
    // settlement still succeeds — a fee that rounds away must not revert.
    const token = await plainToken('TINY');
    const fee = { feeDestination: FEE_COLLECTOR, feeBps: 100 };
    const depositAddress = offChainAddress(factoryAddress, 'inv_tiny', MERCHANT, fee);

    await call(token, selector('mint(address,uint256)') + addressWord(depositAddress) + word(50n));
    const merchantBefore = await tokenBalance(token, MERCHANT);
    const collectorBefore = await tokenBalance(token, FEE_COLLECTOR);

    const result = await call(
      factoryAddress,
      settleBatchCall([
        { invoiceId: 'inv_tiny', destination: MERCHANT, token: token.toString(), fee },
      ]),
    );
    assert.equal(result.exceptionError, undefined, 'settlement reverted');

    assert.equal((await tokenBalance(token, FEE_COLLECTOR)) - collectorBefore, 0n);
    assert.equal((await tokenBalance(token, MERCHANT)) - merchantBefore, 50n);
  });

  test('a native settlement splits the fee', async () => {
    const fee = { feeDestination: FEE_COLLECTOR, feeBps: 250 }; // 2.5%
    const depositAddress = offChainAddress(factoryAddress, 'inv_native_fee', MERCHANT, fee);

    const value = 400n * 10n ** 18n;
    await vm.stateManager.putAccount(
      createAddressFromString(depositAddress.toLowerCase()),
      createAccount({ nonce: 0n, balance: value }),
    );

    const merchantBefore = await nativeBalance(MERCHANT);
    const collectorBefore = await nativeBalance(FEE_COLLECTOR);

    const result = await call(factoryAddress, deployCall('inv_native_fee', MERCHANT, fee));
    assert.equal(result.exceptionError, undefined, 'deployment reverted');

    const collected = (await nativeBalance(FEE_COLLECTOR)) - collectorBefore;
    const paid = (await nativeBalance(MERCHANT)) - merchantBefore;

    assert.equal(collected, (value * 250n) / 10_000n);
    assert.equal(collected + paid, value, 'the whole balance moved');
    assert.equal(await nativeBalance(depositAddress), 0n, 'nothing left in the forwarder');
  });

  test('a fee above the contract ceiling cannot be deployed', async () => {
    /**
     * `MAX_FEE_BPS` is what stops the immutability guarantee from being hollow. The
     * address committing to a number is only reassuring if the number cannot be
     * 10000, so the ceiling lives in the code rather than in our policy.
     */
    const tooHigh = { feeDestination: FEE_COLLECTOR, feeBps: 501 };
    const result = await call(factoryAddress, deployCall('inv_greedy', MERCHANT, tooHigh));
    assert.ok(result.exceptionError, 'deploying a 5.01% forwarder should revert');

    // 5% exactly is the boundary and is allowed.
    const atCeiling = { feeDestination: FEE_COLLECTOR, feeBps: 500 };
    const ok = await call(factoryAddress, deployCall('inv_ceiling', MERCHANT, atCeiling));
    assert.equal(ok.exceptionError, undefined, '5% exactly should be accepted');
  });

  test('the off-chain side refuses a fee the contract would reject', async () => {
    /**
     * Caught before an address is published, not after. A forwarder that reverts on
     * deployment is worse than a rejected invoice: by then a payer has funded an
     * address whose contract cannot be created, and the funds are unreachable.
     */
    assert.throws(
      () =>
        offChainAddress(factoryAddress, 'inv_greedy', MERCHANT, {
          feeDestination: FEE_COLLECTOR,
          feeBps: 501,
        }),
      /exceeds the contract's 500bps ceiling/,
    );

    assert.throws(
      () =>
        offChainAddress(factoryAddress, 'inv_burn', MERCHANT, {
          feeDestination: ZERO_ADDRESS,
          feeBps: 100,
        }),
      /needs a fee destination/,
    );
  });

  test('a non-zero fee with nowhere to send it is refused on chain as well', async () => {
    // Belt and braces: the off-chain guard above is the one that fires in practice,
    // but the contract must not rely on being called correctly.
    const result = await call(
      factoryAddress,
      deployCall('inv_burn_chain', MERCHANT, { feeDestination: ZERO_ADDRESS, feeBps: 100 }),
    );
    assert.ok(result.exceptionError, 'a fee to the zero address should revert');
  });

  test('a batch can mix fee-bearing and free invoices', async () => {
    /**
     * The realistic shape once both pricing models exist side by side: some
     * merchants on a subscription, some on a percentage, settled in one
     * transaction. The fee travels per invoice rather than per batch, so a mixed
     * batch must not apply one invoice's fee to another's funds.
     */
    const token = await plainToken('MIXED');
    const fee = { feeDestination: FEE_COLLECTOR, feeBps: 100 };
    const amount = 1_000n * 10n ** 18n;

    const paying = offChainAddress(factoryAddress, 'mix_paying', MERCHANT, fee);
    const freeRide = offChainAddress(factoryAddress, 'mix_free', OTHER_MERCHANT);
    for (const address of [paying, freeRide]) {
      await call(token, selector('mint(address,uint256)') + addressWord(address) + word(amount));
    }

    const collectorBefore = await tokenBalance(token, FEE_COLLECTOR);
    const merchantBefore = await tokenBalance(token, MERCHANT);
    const otherBefore = await tokenBalance(token, OTHER_MERCHANT);

    const result = await call(
      factoryAddress,
      settleBatchCall([
        { invoiceId: 'mix_paying', destination: MERCHANT, token: token.toString(), fee },
        { invoiceId: 'mix_free', destination: OTHER_MERCHANT, token: token.toString() },
      ]),
    );
    assert.equal(result.exceptionError, undefined, 'mixed batch reverted');

    // Exactly one invoice's worth of fee, from the invoice that carried one.
    assert.equal((await tokenBalance(token, FEE_COLLECTOR)) - collectorBefore, amount / 100n);
    assert.equal((await tokenBalance(token, MERCHANT)) - merchantBefore, amount - amount / 100n);
    assert.equal(
      (await tokenBalance(token, OTHER_MERCHANT)) - otherBefore,
      amount,
      'the subscription merchant should be untouched by the other invoice\'s fee',
    );
  });

  test('a fee-on-transfer token still leaves nothing stranded', async () => {
    /**
     * Two fees interacting: the token takes 1% of every transfer, and we take 1% of
     * the balance. Sending `balance - fee` to the merchant would revert here,
     * because the fee transfer cost more than `fee`. Re-reading the balance is what
     * makes this work — and what guarantees the forwarder ends up empty.
     */
    const token = await deploy(
      artifacts.MockERC20.creationCode,
      word(96n) +
        word(18n) +
        word(100n) +
        word(4n) +
        Buffer.from('FEE2').toString('hex').padEnd(64, '0'),
    );
    const fee = { feeDestination: FEE_COLLECTOR, feeBps: 100 };
    const depositAddress = offChainAddress(factoryAddress, 'inv_double_fee', MERCHANT, fee);

    const amount = 1_000n * 10n ** 18n;
    await call(
      token,
      selector('mint(address,uint256)') + addressWord(depositAddress) + word(amount),
    );

    const result = await call(
      factoryAddress,
      settleBatchCall([
        { invoiceId: 'inv_double_fee', destination: MERCHANT, token: token.toString(), fee },
      ]),
    );
    assert.equal(result.exceptionError, undefined, 'settlement reverted on a fee-on-transfer token');
    assert.equal(
      await tokenBalance(token, depositAddress),
      0n,
      'the forwarder must end empty even when the token takes its own cut',
    );
  });

  test('the forwarder reports the fee it was built with', async () => {
    // A merchant can read these off the chain and check them against what they were
    // quoted, without trusting our dashboard to tell them the truth.
    const fee = { feeDestination: FEE_COLLECTOR, feeBps: 175 };
    const predicted = offChainAddress(factoryAddress, 'inv_readback', MERCHANT, fee);
    await call(factoryAddress, deployCall('inv_readback', MERCHANT, fee));

    const target = createAddressFromString(predicted.toLowerCase());
    const bps = await call(target, selector('feeBps()'));
    const collector = await call(target, selector('feeDestination()'));
    const destination = await call(target, selector('destination()'));

    assert.equal(BigInt(bytesToHex(bps.returnValue)), 175n);
    assert.equal(
      `0x${bytesToHex(collector.returnValue).slice(-40)}`.toLowerCase(),
      FEE_COLLECTOR.toLowerCase(),
    );
    assert.equal(
      `0x${bytesToHex(destination.returnValue).slice(-40)}`.toLowerCase(),
      MERCHANT.toLowerCase(),
    );
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

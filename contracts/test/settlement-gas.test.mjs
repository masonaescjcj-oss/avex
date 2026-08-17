import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Common, Hardfork, Mainnet } from '@ethereumjs/common';
import {
  createAccount,
  createAddressFromPrivateKey,
  createAddressFromString,
  hexToBytes,
} from '@ethereumjs/util';
import { createVM, runTx } from '@ethereumjs/vm';
import { createLegacyTx } from '@ethereumjs/tx';

/**
 * Measures settlement gas against the compiled contract, and pins the registry's
 * cost model to it.
 *
 * `FeePolicy.settlementCostUsd` decides whether moving a merchant's funds is worth
 * doing yet, using `gasDeployAndFlushToken` from the chain registry. That number is
 * a claim about the bytecode in this repository, and nothing but this test connects
 * the two — so an estimate can drift from reality with every green build. It did:
 * the figure was 150,000 while the contract cost more than twice that, which makes
 * every settlement look cheaper than it is and quietly spends our own margin.
 *
 * The assertions bound the estimate from both sides. Too low and we settle when it
 * is not economic; too high and we refuse settlements that are. Neither is a
 * rounding error — on Ethereum at 20 gwei, being 200,000 gas out is roughly $12 an
 * invoice.
 */

const here = dirname(fileURLToPath(import.meta.url));
const { artifacts } = JSON.parse(
  readFileSync(join(here, '..', 'artifacts', 'contracts.json'), 'utf8'),
);

const DEPLOYER_KEY = hexToBytes(
  '0x4646464646464646464646464646464646464646464646464646464646464646',
);
const BASE_FEE = 10n;
const FEE_COLLECTOR = '0x3333333333333333333333333333333333333333';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Headroom allowed over the measured figure.
 *
 * Some is necessary: a real chain has warm/cold access patterns we do not model,
 * and a token whose `transfer` writes more state than the mock. Too much and the
 * estimate stops being a measurement.
 */
const MAX_OVERESTIMATE = 1.6;

const word = (value) => value.toString(16).padStart(64, '0');
const addressWord = (address) => address.toLowerCase().replace('0x', '').padStart(64, '0');

describe('settlement gas matches the registry cost model', () => {
  let vm;
  let core;
  let nonce = 0n;
  let factory;
  let registry;

  before(async () => {
    core = await import('../../packages/core/dist/index.js');
    registry = core.chainConfig('bsc').settlement;

    const common = new Common({ chain: Mainnet, hardfork: Hardfork.Cancun });
    vm = await createVM({ common });
    await vm.stateManager.putAccount(
      createAddressFromPrivateKey(DEPLOYER_KEY),
      createAccount({ nonce: 0n, balance: 10n ** 24n }),
    );

    factory = (await run({ data: artifacts.ForwarderFactory.creationCode })).createdAddress;
  });

  const selector = (signature) => core.keccak256Hex(signature).slice(0, 10);

  async function run({ to, data, value = 0n }) {
    const tx = createLegacyTx(
      {
        nonce: nonce++,
        gasPrice: BASE_FEE,
        gasLimit: 30_000_000n,
        ...(to ? { to } : {}),
        data: hexToBytes(data),
        value,
      },
      { common: vm.common },
    ).sign(DEPLOYER_KEY);

    const result = await runTx(vm, { tx, skipBalance: true, skipBlockGasLimitValidation: true });
    assert.equal(
      result.execResult.exceptionError,
      undefined,
      `transaction reverted: ${result.execResult.exceptionError?.error}`,
    );
    return result;
  }

  async function deployToken(symbol) {
    const result = await run({
      data:
        artifacts.MockERC20.creationCode +
        word(96n) +
        word(18n) +
        word(0n) +
        word(4n) +
        Buffer.from(symbol).toString('hex').padEnd(64, '0'),
    });
    return result.createdAddress.toString();
  }

  function settleData(items) {
    let elements = '';
    for (const item of items) {
      elements +=
        core.keccak256Hex(item.invoiceId).slice(2) +
        addressWord(item.destination) +
        addressWord(item.feeDestination ?? ZERO_ADDRESS) +
        word(BigInt(item.feeBps ?? 0)) +
        addressWord(item.token ?? ZERO_ADDRESS);
    }
    return (
      selector('settleBatch((bytes32,address,address,uint16,address)[])') +
      word(32n) +
      word(BigInt(items.length)) +
      elements
    );
  }

  /**
   * A distinct merchant per invoice.
   *
   * A batch pays many different merchants, so each payout account is cold. Reusing
   * one address would warm it after the first invoice and understate the cost by
   * 2,500 gas an invoice — small, but in the direction that flatters us.
   */
  const merchantFor = (tag, index) =>
    `0x${(BigInt('0x1111111111111111111111111111111111111111') + BigInt(index + 1) * 65_536n + BigInt(tag) * 16n).toString(16).padStart(40, '0')}`;

  async function fund(items, token) {
    for (const item of items) {
      const address = core.predictForwarder(
        {
          factory: factory.toString(),
          forwarderCreationCode: artifacts.Forwarder.creationCode,
        },
        item.invoiceId,
        item.destination,
        item.feeBps ? { feeDestination: item.feeDestination, feeBps: item.feeBps } : undefined,
      );

      if (token) {
        await run({
          to: token,
          data: selector('mint(address,uint256)') + addressWord(address) + word(10n ** 20n),
        });
      } else {
        const target = createAddressFromString(address.toLowerCase());
        const existing = await vm.stateManager.getAccount(target);
        await vm.stateManager.putAccount(
          target,
          createAccount({
            nonce: existing?.nonce ?? 0n,
            balance: (existing?.balance ?? 0n) + 10n ** 18n,
            // Preserve any deployed code: the second pass measures a flush of an
            // already-deployed forwarder, which needs its code left in place.
            ...(existing ? { codeHash: existing.codeHash, storageRoot: existing.storageRoot } : {}),
          }),
        );
      }
    }
  }

  /**
   * Marginal gas for one more invoice in a batch.
   *
   * The difference between a batch of three and a batch of two, so the 21,000-gas
   * transaction floor and the calldata for the first two elements fall out. That
   * difference is what a per-invoice constant should hold, because the fixed part
   * is paid once however large the batch.
   */
  async function marginalGas({ tag, fee, native, redeploy }) {
    const token = native ? null : await deployToken(`GAS${tag}`);
    const results = [];

    for (const count of [2, 3]) {
      const items = [];
      for (let index = 0; index < count; index += 1) {
        items.push({
          invoiceId: `gas_${tag}_${count}_${index}`,
          destination: merchantFor(tag, index + count * 8),
          token: token ?? ZERO_ADDRESS,
          ...(fee ? { feeDestination: FEE_COLLECTOR, feeBps: fee } : {}),
        });
      }

      await fund(items, token);
      if (redeploy) {
        // Deploy first, then fund and sweep again — so the measured pass is a flush
        // of a contract that already exists, which is what `gasFlushNative` means.
        await run({ to: factory.toString(), data: settleData(items) });
        await fund(items, token);
      }

      const result = await run({ to: factory.toString(), data: settleData(items) });
      results.push(result.totalGasSpent ?? result.execResult.executionGasUsed);
    }

    return Number(results[1] - results[0]);
  }

  test('deploy-and-flush of a token costs what the registry says', async () => {
    const measured = await marginalGas({ tag: 1, fee: 0, native: false });
    const estimate = registry.gasDeployAndFlushToken;

    assert.ok(
      measured <= estimate,
      `settling a token invoice costs ${measured} gas but the registry budgets ` +
        `${estimate}; FeePolicy is under-pricing settlement by ` +
        `${(measured / estimate).toFixed(2)}x`,
    );
    assert.ok(
      estimate <= measured * MAX_OVERESTIMATE,
      `the registry budgets ${estimate} gas for a ${measured}-gas settlement, which ` +
        'would refuse settlements that are in fact economic',
    );
  });

  test('the fee split does not materially change the cost', async () => {
    /**
     * The reason one constant can cover both pricing models. If a percentage fee
     * cost meaningfully more to settle, the registry would need to price the two
     * separately and `settlementCostUsd` would need to know which invoice it was
     * looking at.
     */
    const free = await marginalGas({ tag: 2, fee: 0, native: false });
    const withFee = await marginalGas({ tag: 3, fee: 100, native: false });

    /**
     * A band, not a direction. The fee-bearing case does strictly more work, but it
     * also spends more gas overall, which raises the EIP-3529 refund cap and can
     * leave the *net* figure slightly lower. Asserting `withFee > free` would be
     * asserting a refund-accounting artefact rather than the cost of a transfer.
     */
    assert.ok(
      Math.abs(withFee - free) < 40_000,
      `a fee split moves the per-invoice cost by ${withFee - free} gas (free ${free}, ` +
        `with fee ${withFee}), which is enough to need its own line in the cost model ` +
        'rather than sharing one estimate',
    );
    assert.ok(
      withFee <= registry.gasDeployAndFlushToken,
      `a fee-bearing settlement costs ${withFee} gas, over the registry's ` +
        `${registry.gasDeployAndFlushToken}`,
    );
  });

  test('flushing an already-deployed forwarder costs what the registry says', async () => {
    // The cheap case: no CREATE2, no code deposit. Worth its own figure because it
    // is an order of magnitude less than a deploy, and pricing it as a deploy would
    // defer sweeps that cost almost nothing.
    const measured = await marginalGas({ tag: 4, fee: 0, native: true, redeploy: true });
    const estimate = registry.gasFlushNative;

    assert.ok(
      measured <= estimate,
      `flushing native from a deployed forwarder costs ${measured} gas, over the ` +
        `registry's ${estimate}`,
    );

    /**
     * An absolute allowance rather than a ratio.
     *
     * The measurement sweeps to a payout account that already exists, because the
     * same account received the first pass. On a real chain the first sweep to a
     * given merchant creates that account, which is 25,000 gas this harness never
     * pays — so the estimate is deliberately above what is measured here, and a
     * percentage band would reject the very headroom that makes it correct.
     */
    const COLD_ACCOUNT_CREATION = 25_000;
    assert.ok(
      estimate <= measured + COLD_ACCOUNT_CREATION + 5_000,
      `the registry budgets ${estimate} gas for a ${measured}-gas flush, which is ` +
        'more headroom than a cold payout account can explain',
    );
  });

  test('every EVM chain shares the same measured figures', () => {
    /**
     * Ethereum, Polygon and BSC run identical bytecode, so their gas costs are
     * identical — what differs is the price of gas, which comes from a live
     * snapshot rather than from here. Three chains diverging in this table would
     * mean one of them had been edited by hand.
     */
    for (const chain of ['ethereum', 'polygon', 'bsc']) {
      const profile = core.chainConfig(chain).settlement;
      assert.equal(profile.kind, 'evm');
      assert.equal(profile.gasDeployAndFlushToken, registry.gasDeployAndFlushToken, chain);
      assert.equal(profile.gasFlushNative, registry.gasFlushNative, chain);
    }
  });
});

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
import { createLegacyTx } from '@ethereumjs/tx';
import { createVM, runTx } from '@ethereumjs/vm';

/**
 * The whole payment loop, on a real EVM.
 *
 * Every piece has been tested on its own; this is the one test that runs them
 * together in the order a real payment does:
 *
 *   derive a deposit address → payer sends tokens to it → the watcher detects and
 *   credits → the settlement runner broadcasts → the merchant's wallet increases
 *
 * That sequence is Phase 4's exit criterion. Running it in-process means the
 * criterion is checked on every commit, not once against a testnet — and the only
 * thing separating this from BNB Chain is which RPC endpoint the adapter points at.
 */

const here = dirname(fileURLToPath(import.meta.url));
const { artifacts } = JSON.parse(
  readFileSync(join(here, '..', 'artifacts', 'contracts.json'), 'utf8'),
);

const OPERATOR_KEY = hexToBytes(
  '0x4646464646464646464646464646464646464646464646464646464646464646',
);
const BASE_FEE = 10n;
const MERCHANT = '0x1111111111111111111111111111111111111111';

const word = (value) => value.toString(16).padStart(64, '0');
const addressWord = (address) => address.toLowerCase().replace('0x', '').padStart(64, '0');

describe('the full payment loop', () => {
  let core;
  let vm;
  let operator;
  let nonce = 0n;
  let factory;
  let logic;
  let token;

  const selector = (signature) => core.keccak256Hex(signature).slice(0, 10);

  before(async () => {
    core = await import('../../packages/core/dist/index.js');

    vm = await createVM({ common: new Common({ chain: Mainnet, hardfork: Hardfork.Cancun }) });
    operator = createAddressFromPrivateKey(OPERATOR_KEY);
    await vm.stateManager.putAccount(
      operator,
      createAccount({ nonce: 0n, balance: 10n ** 22n }),
    );

    // The logic first: the factory names it in every clone it builds.
    logic = await deploy(artifacts.ForwarderLogic.creationCode);
    factory = await deploy(
      artifacts.ForwarderFactory.creationCode,
      logic.toString().replace('0x', '').padStart(64, '0'),
    );
    token = await deploy(
      artifacts.MockERC20.creationCode,
      word(96n) + word(18n) + word(0n) + word(4n) + Buffer.from('USDT').toString('hex').padEnd(64, '0'),
    );
  });

  async function send({ to, data, gasLimit = 9_000_000n, feePerGasWei = BASE_FEE }) {
    const tx = createLegacyTx(
      {
        nonce: nonce++,
        gasPrice: feePerGasWei,
        gasLimit,
        data: hexToBytes(data),
        value: 0n,
        ...(to ? { to } : {}),
      },
      { common: vm.common },
    ).sign(OPERATOR_KEY);

    return runTx(vm, { tx, skipBalance: true, skipBlockGasLimitValidation: true });
  }

  async function deploy(creationCode, args = '') {
    const result = await send({ data: creationCode + args });
    assert.equal(result.execResult.exceptionError, undefined, 'deployment reverted');
    return result.createdAddress;
  }

  async function balanceOf(address) {
    const result = await send({
      to: token.toString(),
      data: selector('balanceOf(address)') + addressWord(address),
    });
    return BigInt(bytesToHex(result.execResult.returnValue));
  }

  test('a payment reaches the merchant wallet end to end', async () => {
    const invoiceId = 'inv_full_loop';
    const amount = 20n * 10n ** 18n;

    // ── 1. Derive the deposit address, before anything exists at it ────────────
    const create2 = {
      factory: factory.toString(),
      implementation: logic.toString(),
    };
    const depositAddress = core.predictForwarder(create2, invoiceId, MERCHANT);

    const codeBefore = await vm.stateManager.getCode(
      createAddressFromString(depositAddress.toLowerCase()),
    );
    assert.equal(codeBefore.length, 0, 'the published address must start empty');

    // ── 2. The payer sends tokens there ───────────────────────────────────────
    await send({
      to: token.toString(),
      data: selector('mint(address,uint256)') + addressWord(depositAddress) + word(amount),
    });
    assert.equal(await balanceOf(depositAddress), amount);

    // ── 3. The watcher detects and credits it ─────────────────────────────────
    const asset = {
      symbol: 'USDT',
      chain: 'bsc',
      decimals: 18,
      kind: 'erc20',
      contract: token.toString(),
    };
    const observed = {
      chain: 'bsc',
      txHash: '0xpayment',
      transferIndex: 0,
      to: depositAddress,
      asset,
      amount,
      blockNumber: 100,
      confirmations: 30,
    };

    const credited = [];
    const chainState = new Map([[100, '0x100']]);
    const blocks = {
      async head() {
        return { number: 100, hash: '0x100' };
      },
      async blockAt(number) {
        const hash = chainState.get(number);
        return hash ? { number, hash } : null;
      },
    };

    let cursor = null;
    let scannedTo = null;
    let remembered = [];
    const store = {
      async loadCursor() {
        return { cursor, scannedTo };
      },
      async saveCursor(_chain, next, to) {
        cursor = next;
        scannedTo = to;
      },
      async recordError() {},
      async recentBlocks() {
        return [...remembered].sort((a, b) => b.number - a.number);
      },
      async rememberBlocks(_chain, refs) {
        for (const ref of refs) {
          remembered = remembered.filter((block) => block.number !== ref.number);
          remembered.push(ref);
        }
      },
      async forgetBlocksAbove(_chain, number) {
        remembered = remembered.filter((block) => block.number <= number);
      },
      async creditedAbove() {
        return [];
      },
    };

    let polled = false;
    const adapter = {
      chain: 'bsc',
      addressModel: 'unique',
      async deriveDepositTarget() {
        return { address: depositAddress };
      },
      async probeGas() {
        return { chain: 'bsc', nativePriceUsd: 600, feePerGasWei: BASE_FEE, observedAt: Date.now() };
      },
      async poll() {
        const payments = polled ? [] : [observed];
        polled = true;
        return { payments, cursor: '100' };
      },
      async settle() {
        return [];
      },
    };

    const watcher = new core.Watcher(
      'bsc',
      adapter,
      blocks,
      store,
      {
        async credit(payment) {
          credited.push(payment);
        },
        async reverse() {},
      },
      { reorgDepth: 3, blockMemory: 8, maxBlocksPerPoll: 100 },
    );

    const outcome = await watcher.poll();
    assert.equal(outcome.credited, 1, 'the watcher should credit the transfer');
    assert.equal(credited[0].amount, amount);

    // ── 4. The settlement runner broadcasts, paying gas from its own account ──
    const signer = {
      address: operator.toString(),
      async pendingNonce() {
        return Number(nonce);
      },
      async balanceWei() {
        const account = await vm.stateManager.getAccount(operator);
        return account?.balance ?? 0n;
      },
      async broadcast(tx) {
        const result = await send({
          to: tx.to,
          data: tx.data,
          gasLimit: tx.gasLimit,
          feePerGasWei: tx.feePerGasWei,
        });
        assert.equal(result.execResult.exceptionError, undefined, 'settlement reverted');
        return { hash: `0x${bytesToHex(result.receipt.bitvector).slice(2, 10)}${tx.nonce}` };
      },
      async receipt() {
        // Mined in the same call above, so it is final immediately here.
        return { status: 'success', gasUsed: 150_000n, feePerGasWei: BASE_FEE };
      },
    };

    const runner = new core.SettlementRunner(
      'bsc',
      signer,
      new core.FeePolicy(),
      core.DEFAULT_RUNNER,
    );
    await runner.start();

    const settleData = core.encodeSettleBatch([
      {
        salt: core.invoiceSalt(invoiceId),
        destination: MERCHANT,
        token: token.toString(),
      },
    ]);

    const result = await runner.settle(
      [
        {
          invoiceId,
          depositAddress,
          payoutAddress: MERCHANT,
          asset,
          amount,
        },
      ],
      { to: factory.toString(), data: settleData, gasLimit: 900_000n },
      await adapter.probeGas(),
    );

    assert.ok(result.ok, `settlement was refused: ${result.ok ? '' : result.detail}`);

    // ── 5. The merchant has the funds, and nothing is left behind ─────────────
    assert.equal(
      await balanceOf(MERCHANT),
      amount,
      'the merchant should hold the full invoice amount',
    );
    assert.equal(
      await balanceOf(depositAddress),
      0n,
      'the deposit address should be emptied',
    );

    // And the forwarder that now exists is bound to this merchant alone.
    const destination = await send({
      to: depositAddress,
      data: selector('destination()'),
    });
    assert.equal(
      `0x${bytesToHex(destination.execResult.returnValue).slice(-40)}`.toLowerCase(),
      MERCHANT.toLowerCase(),
    );
  });

  test('a second invoice for the same merchant settles independently', async () => {
    // Confirms nothing about the first settlement leaked state into the next one —
    // a forwarder is per invoice, not per merchant.
    const create2 = {
      factory: factory.toString(),
      implementation: logic.toString(),
    };
    const invoiceId = 'inv_second';
    const amount = 7n * 10n ** 18n;
    const depositAddress = core.predictForwarder(create2, invoiceId, MERCHANT);

    const before_ = await balanceOf(MERCHANT);

    await send({
      to: token.toString(),
      data: selector('mint(address,uint256)') + addressWord(depositAddress) + word(amount),
    });

    await send({
      to: factory.toString(),
      data: core.encodeSettleBatch([
        { salt: core.invoiceSalt(invoiceId), destination: MERCHANT, token: token.toString() },
      ]),
    });

    assert.equal(await balanceOf(MERCHANT), before_ + amount);
  });
});

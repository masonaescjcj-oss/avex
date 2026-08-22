import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Common, Hardfork, Mainnet } from '@ethereumjs/common';
import { createTxFromRLP } from '@ethereumjs/tx';
import { createAccount, createAddressFromPrivateKey, bytesToHex, hexToBytes } from '@ethereumjs/util';
import { createVM, runTx } from '@ethereumjs/vm';

/**
 * `contracts/deploy.mjs`, run for real against an EVM behind a fake JSON-RPC node.
 *
 * This script's failure mode is spending an operator's money and publishing addresses nothing
 * can settle. Reading it is not enough: what has to be true is that the transactions it signs
 * are accepted, that the second deployment gets the first one's address as a constructor
 * argument, and that the self-check at the end compares two things that are actually derived
 * independently — one by the deployed bytecode, one by this repository.
 *
 * So the node here is a real `@ethereumjs/vm` with a real state trie, reached over HTTP by the
 * real script in a child process. Nothing about the deployment path is stubbed; what is faked is
 * only the chain's plumbing — `eth_estimateGas` answers a constant, and blocks do not exist.
 *
 * Chain id 1 for the happy path, because that is what the mainnet `Common` reports and the
 * script refuses to sign for a chain the endpoint disagrees with. That refusal gets its own
 * test: it is the one that stops a transaction being signed for the wrong network, where it is
 * valid and replayable by anyone who sees it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'deploy.mjs');

const DEPLOYER_KEY = '0x4646464646464646464646464646464646464646464646464646464646464646';

describe('the deployment script', () => {
  let vm;
  let server;
  let url;
  const receipts = new Map();
  /**
   * When set, `predict` comes back with one byte changed.
   *
   * The stand-in for the situation the self-check exists for: a factory deployed from bytecode
   * this build did not produce. There is no way to reach that state honestly inside one test
   * run — both sides read the same artifact — so the disagreement is injected at the only place
   * it would be observed.
   */
  let corruptPredict = false;

  before(async () => {
    const common = new Common({ chain: Mainnet, hardfork: Hardfork.Cancun });
    vm = await createVM({ common });

    const deployer = createAddressFromPrivateKey(hexToBytes(DEPLOYER_KEY));
    await vm.stateManager.putAccount(
      deployer,
      createAccount({ nonce: 0n, balance: 10n ** 22n }),
    );

    server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', async () => {
        const { id, method, params } = JSON.parse(body);
        let result;
        try {
          result = await handle(method, params);
        } catch (error) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ jsonrpc: '2.0', id, error: { message: String(error) } }));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
      });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  async function handle(method, params) {
    switch (method) {
      case 'eth_chainId':
        return '0x1';
      case 'eth_gasPrice':
        // A tenth of a gwei, which is what BNB Chain charges on a quiet day.
        return `0x${(100_000_000n).toString(16)}`;
      case 'eth_maxPriorityFeePerGas':
        return '0x0';
      case 'eth_estimateGas':
        /**
         * A constant, and the only genuinely faked answer here.
         *
         * The VM has no block context to estimate against, and what this test is for is the
         * signing and the self-check rather than the estimate. Three million is generous
         * enough for either contract, which is also what the script's headroom is for.
         */
        return `0x${(3_000_000n).toString(16)}`;
      case 'eth_getBalance': {
        const account = await vm.stateManager.getAccount(
          createAddressFromPrivateKey(hexToBytes(DEPLOYER_KEY)),
        );
        return `0x${(account?.balance ?? 0n).toString(16)}`;
      }
      case 'eth_getTransactionCount': {
        const account = await vm.stateManager.getAccount(
          createAddressFromPrivateKey(hexToBytes(DEPLOYER_KEY)),
        );
        return `0x${(account?.nonce ?? 0n).toString(16)}`;
      }
      case 'eth_sendRawTransaction': {
        const tx = createTxFromRLP(hexToBytes(params[0]), { common: vm.common });
        const result = await runTx(vm, {
          tx,
          skipBalance: true,
          skipBlockGasLimitValidation: true,
        });
        const hash = bytesToHex(tx.hash());
        receipts.set(hash, {
          status: result.execResult.exceptionError ? '0x0' : '0x1',
          gasUsed: `0x${(result.totalGasSpent ?? 0n).toString(16)}`,
          contractAddress: result.createdAddress ? result.createdAddress.toString() : null,
        });
        return hash;
      }
      case 'eth_getTransactionReceipt':
        return receipts.get(params[0]) ?? null;
      case 'eth_call': {
        /**
         * Run the call and return what it returned.
         *
         * `runCall` rather than a signed transaction, so this does not consume the deployer's
         * nonce — the script has already read it and counts locally from there.
         */
        const { createAddressFromString } = await import('@ethereumjs/util');
        const outcome = await vm.evm.runCall({
          to: createAddressFromString(params[0].to.toLowerCase()),
          data: hexToBytes(params[0].data),
          gasLimit: 10_000_000n,
          caller: createAddressFromPrivateKey(hexToBytes(DEPLOYER_KEY)),
        });
        const returned = bytesToHex(outcome.execResult.returnValue);
        if (!corruptPredict) return returned;
        return `${returned.slice(0, -2)}${returned.endsWith('ff') ? '00' : 'ff'}`;
      }
      default:
        throw new Error(`unsupported method ${method}`);
    }
  }

  /** Run the script and collect what an operator would see. */
  function run(args, env = {}) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [script, ...args], {
        env: { ...process.env, RPC_URL: url, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  }

  test('a dry run reports the cost and sends nothing', async () => {
    const outcome = await run(['--chain', 'ethereum', '--dry-run']);

    assert.equal(outcome.code, 0, outcome.stderr);
    assert.match(outcome.stdout, /dry run: nothing was sent/);
    assert.match(outcome.stdout, /gas price\s+0\.1000 gwei/);
    assert.equal(receipts.size, 0, 'a dry run must not broadcast');
  });

  test('it deploys both contracts and the addresses agree with this build', async () => {
    /**
     * The whole point. A pass means the deployed factory and `predictForwarder` in this
     * repository derive the same deposit address from the same inputs — which is what every
     * published address depends on, and what a mismatched logic address would silently break.
     */
    const outcome = await run(['--chain', 'ethereum'], { DEPLOY_KEY_HEX: DEPLOYER_KEY });

    assert.equal(outcome.code, 0, outcome.stderr || outcome.stdout);
    assert.match(outcome.stdout, /self-check\s+on-chain and off-chain derivation agree/);

    const factory = /FORWARDER_FACTORIES=ethereum=(0x[0-9a-fA-F]{40})/.exec(outcome.stdout)?.[1];
    const logic = /FORWARDER_IMPLEMENTATIONS=ethereum=(0x[0-9a-fA-F]{40})/.exec(outcome.stdout)?.[1];
    assert.ok(factory, `no factory address in output:\n${outcome.stdout}`);
    assert.ok(logic, 'no logic address in output');
    assert.notEqual(factory.toLowerCase(), logic.toLowerCase());

    // Both are contracts, on the chain, with code at them.
    const { createAddressFromString } = await import('@ethereumjs/util');
    for (const address of [factory, logic]) {
      const code = await vm.stateManager.getCode(createAddressFromString(address.toLowerCase()));
      assert.ok(code.length > 0, `no code deployed at ${address}`);
    }

    /**
     * And the factory knows its logic — the constructor argument arrived.
     *
     * Passing it as an unpadded address, or padding it wrongly, produces a factory whose
     * `implementation` is a truncated value. Every clone it builds would then delegate to
     * nothing, which no test of the off-chain derivation would notice because the derivation
     * would agree with the factory about the wrong address.
     */
    const core = await import('../../packages/core/dist/index.js');
    const stored = await handle('eth_call', [
      { to: factory, data: core.keccak256Hex('implementation()').slice(0, 10) },
      'latest',
    ]);
    assert.equal(`0x${stored.slice(-40)}`.toLowerCase(), logic.toLowerCase());
  });

  test('it refuses to sign for a chain the endpoint disagrees with', async () => {
    /**
     * The endpoint reports chain 1; `--chain bsc` is 56. A transaction signed for 56 and
     * broadcast to 1 would be rejected, which is harmless — but the reverse, signing for the
     * chain the flag names while the money is somewhere else, is how a deployment ends up on a
     * network nobody meant to touch. Either way the two have to agree before a key is used.
     */
    const outcome = await run(['--chain', 'bsc'], { DEPLOY_KEY_HEX: DEPLOYER_KEY });

    assert.equal(outcome.code, 1);
    assert.match(outcome.stderr, /RPC_URL is chain 1, but --chain bsc is 56/);
  });

  test('a factory that disagrees about addresses stops the run', async () => {
    /**
     * The guard's own test, and the reason the script does not simply print and exit.
     *
     * A factory deployed from different bytecode derives different deposit addresses. Every
     * invoice would then publish an address that factory will never settle: the payment
     * confirms, the funds arrive, and nothing can move them — with no error anywhere, because
     * both halves are internally consistent. So a mismatch is a refusal to print the
     * configuration at all.
     */
    corruptPredict = true;
    try {
      const outcome = await run(['--chain', 'ethereum'], { DEPLOY_KEY_HEX: DEPLOYER_KEY });

      assert.equal(outcome.code, 1);
      assert.match(outcome.stderr, /disagree about deposit addresses/);
      assert.doesNotMatch(
        outcome.stdout,
        /FORWARDER_FACTORIES=/,
        'a mismatch must not print configuration somebody could paste',
      );
    } finally {
      corruptPredict = false;
    }
  });

  test('it refuses a chain it has no id for', async () => {
    // Rather than defaulting to one. TRON has no forwarder and no chain id here, and a
    // deployment aimed at it would be a transaction signed for whatever came first in a table.
    const outcome = await run(['--chain', 'tron'], { DEPLOY_KEY_HEX: DEPLOYER_KEY });
    assert.equal(outcome.code, 1);
    assert.match(outcome.stderr, /--chain must be one of/);
  });
});

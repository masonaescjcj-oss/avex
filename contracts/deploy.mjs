/**
 * Deploy the two contracts to one chain, and prove the addresses agree before saying so.
 *
 * Usage:
 *   DEPLOY_KEY_HEX=0x… RPC_URL=https://… node contracts/deploy.mjs --chain bsc [--dry-run]
 *
 * ## What this exists to prevent
 *
 * Every deposit address this gateway ever hands out is a hash over the factory address and the
 * logic address. If the pair written into `FORWARDER_FACTORIES` and `FORWARDER_IMPLEMENTATIONS`
 * is not the pair actually deployed — a redeploy nobody noticed, a copy-paste from another
 * chain, a logic address belonging to a different factory — then every published address is one
 * the factory will never settle. Payers fund them, the money arrives, and nothing can move it.
 *
 * There is no recovery from that and no error message either: the addresses are valid, the
 * transfers confirm, and the only symptom is that settlement finds no code and deploys a clone
 * that turns out to be empty. So the last thing this script does before printing the
 * configuration is ask the deployed factory to predict an address and compare it with what the
 * application would derive. A disagreement is a refusal to print, not a warning.
 *
 * ## Why the key is passed in the environment and not read from a store
 *
 * This is an operator's one-off action, not a service. The key deploys two contracts that hold
 * nothing and control nothing — the factory cannot redirect a funded address, and the logic has
 * no admin — so a deploy key is not a settlement key and does not need the same handling. The
 * settlement key is a separate matter and `LocalKeyProvider` refuses to hold one in production
 * for exactly the reasons that do not apply here.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const core = await import('../packages/core/dist/index.js');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};

const chain = option('chain');
const dryRun = flag('dry-run');
const rpcUrl = process.env.RPC_URL;
const keyHex = process.env.DEPLOY_KEY_HEX;

if (!chain || !(chain in core.EVM_CHAIN_IDS)) {
  fail(
    `--chain must be one of ${Object.keys(core.EVM_CHAIN_IDS).join(', ')}\n` +
      'The chain id is written into every signed transaction, so it is named explicitly rather\n' +
      'than taken from the node — a transaction signed for the wrong chain is a valid\n' +
      'transaction on that chain, replayable by anyone who sees it.',
  );
}
if (!rpcUrl) fail('RPC_URL is required');
if (!dryRun && !keyHex) fail('DEPLOY_KEY_HEX is required (or pass --dry-run)');

const artifacts = JSON.parse(
  readFileSync(join(here, 'artifacts', 'contracts.json'), 'utf8'),
).artifacts;
for (const name of ['ForwarderLogic', 'ForwarderFactory']) {
  if (!artifacts[name]) fail(`${name} is missing from the artifacts; run node contracts/compile.mjs`);
}

let rpcId = 0;
async function rpc(method, params) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  if (!response.ok) fail(`${method}: HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) fail(`${method}: ${body.error.message}`);
  return body.result;
}

// ── the chain is the one that was asked for ──────────────────────────────────

const expectedChainId = core.evmChainId(chain);
const reportedChainId = Number(BigInt(await rpc('eth_chainId', [])));
if (reportedChainId !== expectedChainId) {
  fail(
    `RPC_URL is chain ${reportedChainId}, but --chain ${chain} is ${expectedChainId}.\n` +
      'Refusing to deploy: the endpoint and the flag disagree about which chain this is.',
  );
}

const gasPrice = BigInt(await rpc('eth_gasPrice', []));
const priority = await rpc('eth_maxPriorityFeePerGas', []).catch(() => '0x0');
const feePerGas = gasPrice + BigInt(priority);

/**
 * Deliberately generous, and the reason is asymmetric.
 *
 * An over-estimate costs nothing on an EIP-1559 chain: the unused gas is not paid for. An
 * under-estimate reverts a deployment half way and burns the fee for nothing — and the second
 * deployment takes the logic address of the first, so a failed run has to be started over.
 */
const GAS_HEADROOM_BPS = 12_000n;

const logicGas = (BigInt(await estimate(artifacts.ForwarderLogic.creationCode)) * GAS_HEADROOM_BPS) / 10_000n;

console.log(`chain            ${chain} (id ${expectedChainId})`);
console.log(`gas price        ${formatGwei(feePerGas)} gwei`);
console.log(`logic gas        ~${logicGas}`);

if (dryRun) {
  /**
   * The factory's gas cannot be estimated yet: its constructor takes the logic address, and
   * that address does not exist until the first deployment. Its bytecode is a similar size, so
   * the plan doubles the figure rather than pretending to know.
   */
  const total = logicGas * 2n * feePerGas;
  console.log(`\nestimated total  ${formatEther(total)} native token (both deployments)`);
  console.log('\ndry run: nothing was sent.');
  process.exit(0);
}

// ── deploy ───────────────────────────────────────────────────────────────────

const key = hexToBytes(keyHex);
if (key.length !== 32) fail(`DEPLOY_KEY_HEX must be 32 bytes, got ${key.length}`);
const deployer = core.addressFromPrivateKey(key);

const balance = BigInt(await rpc('eth_getBalance', [deployer, 'latest']));
const needed = logicGas * 2n * feePerGas;
console.log(`deployer         ${deployer}`);
console.log(`balance          ${formatEther(balance)}`);
if (balance < needed) {
  fail(
    `balance is ${formatEther(balance)} but the two deployments need about ` +
      `${formatEther(needed)}. Fund ${deployer} and run again.`,
  );
}

let nonce = Number(BigInt(await rpc('eth_getTransactionCount', [deployer, 'pending'])));

const logic = await deploy('ForwarderLogic', artifacts.ForwarderLogic.creationCode, logicGas);
const factoryGas =
  (BigInt(
    await estimate(artifacts.ForwarderFactory.creationCode + addressArgument(logic)),
  ) *
    GAS_HEADROOM_BPS) /
  10_000n;
const factory = await deploy(
  'ForwarderFactory',
  artifacts.ForwarderFactory.creationCode + addressArgument(logic),
  factoryGas,
);

// ── the check that matters ───────────────────────────────────────────────────

/**
 * Ask the deployed factory where a deposit address would be, and compare.
 *
 * An arbitrary invoice id and merchant, with a fee, so every field of the clone's appended
 * arguments takes part. If this matches, the off-chain derivation and the deployed bytecode
 * agree about every byte of the init code — which is the whole property the product rests on.
 */
const probe = {
  invoiceId: 'deploy-selfcheck',
  merchant: '0x1111111111111111111111111111111111111111',
  fee: { feeDestination: '0x3333333333333333333333333333333333333333', feeBps: 53 },
};

const predicted = await callPredict(factory, probe);
const offChain = core.predictForwarder(
  { factory, implementation: logic },
  probe.invoiceId,
  probe.merchant,
  probe.fee,
);

if (predicted.toLowerCase() !== offChain.toLowerCase()) {
  fail(
    'the deployed factory and this build disagree about deposit addresses:\n' +
      `  on chain  ${predicted}\n` +
      `  off chain ${offChain}\n` +
      'Do not use these addresses. Every invoice would take payments to an address the\n' +
      'factory will never settle. Recompile from the commit that produced the deployment,\n' +
      'or redeploy from this one.',
  );
}

console.log('\nself-check       on-chain and off-chain derivation agree');
console.log('\nConfiguration for this chain:\n');
console.log(`  FORWARDER_FACTORIES=${chain}=${factory}`);
console.log(`  FORWARDER_IMPLEMENTATIONS=${chain}=${logic}`);
console.log(
  '\nBoth are part of every deposit address. Changing either one changes every address\n' +
    'this gateway has published, so record them alongside the commit that produced them.',
);

// ── helpers ──────────────────────────────────────────────────────────────────

async function estimate(data) {
  const from = keyHex ? core.addressFromPrivateKey(hexToBytes(keyHex)) : undefined;
  return rpc('eth_estimateGas', [{ ...(from ? { from } : {}), data: prefixed(data) }]);
}

async function deploy(name, data, gasLimit) {
  const transaction = {
    chainId: expectedChainId,
    nonce: nonce++,
    maxFeePerGas: feePerGas,
    // A tenth of the ceiling, matching `SETTLEMENT_PRIORITY_FRACTION`'s default.
    maxPriorityFeePerGas: feePerGas / 10n,
    gasLimit,
    /**
     * No recipient: that is what makes this a deployment rather than a call.
     *
     * The serializer encodes an absent `to` as an empty RLP string, which is the one place a
     * deployment differs from every other transaction this codebase signs.
     */
    to: null,
    value: 0n,
    data: hexToBytes(prefixed(data)),
  };

  const digest = core.signingHash(transaction);
  const signature = core.signDigest(digest, key);
  const { raw, hash } = core.serializeSigned(transaction, signature);

  const returned = await rpc('eth_sendRawTransaction', [raw]);
  if (returned.toLowerCase() !== hash.toLowerCase()) {
    fail(`node returned hash ${returned} but the signed transaction is ${hash}`);
  }
  console.log(`\n${name}\n  tx             ${hash}`);

  const receipt = await waitForReceipt(hash);
  if (BigInt(receipt.status) !== 1n) fail(`${name} deployment reverted`);
  const address = core.toChecksumAddress(receipt.contractAddress);
  console.log(`  address        ${address}`);
  console.log(`  gas used       ${BigInt(receipt.gasUsed)}`);
  return address;
}

async function waitForReceipt(hash) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const receipt = await rpc('eth_getTransactionReceipt', [hash]);
    if (receipt) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  fail(`no receipt for ${hash} after four minutes; check the explorer before retrying`);
}

async function callPredict(factoryAddress, probe) {
  const selector = core.keccak256Hex('predict(bytes32,address,address,uint16)').slice(0, 10);
  const data =
    selector +
    core.keccak256Hex(probe.invoiceId).slice(2) +
    word20(probe.merchant) +
    word20(probe.fee.feeDestination) +
    BigInt(probe.fee.feeBps).toString(16).padStart(64, '0');

  const result = await rpc('eth_call', [{ to: factoryAddress, data }, 'latest']);
  return core.toChecksumAddress(`0x${result.slice(-40)}`);
}

function word20(address) {
  return address.toLowerCase().replace('0x', '').padStart(64, '0');
}

function addressArgument(address) {
  return word20(address);
}

function prefixed(hex) {
  return hex.startsWith('0x') ? hex : `0x${hex}`;
}

function hexToBytes(hex) {
  const bare = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(bare.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(bare.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

function formatGwei(wei) {
  return (Number(wei / 1_000n) / 1e6).toFixed(4);
}

function formatEther(wei) {
  return (Number(wei / 10n ** 9n) / 1e9).toFixed(9);
}

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

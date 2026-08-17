/**
 * Compile the contracts and write their artifacts.
 *
 * Uses solc-js rather than Foundry so the toolchain is one `npm install` and
 * works anywhere Node does — which matters because the off-chain deposit address
 * is a hash over this bytecode, so producing it must be reproducible on any
 * machine and in CI.
 *
 * Usage: node contracts/compile.mjs [outputDir]
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import solc from 'solc';

const here = dirname(fileURLToPath(import.meta.url));
const outputDir = process.argv[2] ?? join(here, 'artifacts');

const SOURCES = ['Forwarder.sol', 'TransferProbe.sol', 'test/MockERC20.sol'];

const input = {
  language: 'Solidity',
  sources: Object.fromEntries(
    SOURCES.map((file) => [file, { content: readFileSync(join(here, file), 'utf8') }]),
  ),
  settings: {
    // Pinned so the bytecode — and therefore every derived deposit address — is
    // reproducible. Changing either value changes every address we have handed out.
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'cancun',
    outputSelection: {
      '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] },
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));

const errors = (output.errors ?? []).filter((entry) => entry.severity === 'error');
if (errors.length > 0) {
  for (const error of errors) console.error(error.formattedMessage);
  process.exit(1);
}
for (const warning of output.errors ?? []) {
  console.warn(warning.formattedMessage.trim());
}

mkdirSync(outputDir, { recursive: true });

const artifacts = {};
for (const [file, contracts] of Object.entries(output.contracts)) {
  for (const [name, contract] of Object.entries(contracts)) {
    artifacts[name] = {
      abi: contract.abi,
      /** Init code: what CREATE2 hashes, before constructor arguments. */
      creationCode: `0x${contract.evm.bytecode.object}`,
      deployedCode: `0x${contract.evm.deployedBytecode.object}`,
      source: file,
    };
    console.log(
      `${name.padEnd(20)} creation ${contract.evm.bytecode.object.length / 2} bytes` +
        `  runtime ${contract.evm.deployedBytecode.object.length / 2} bytes`,
    );
  }
}

writeFileSync(
  join(outputDir, 'contracts.json'),
  `${JSON.stringify({ solcVersion: solc.version(), settings: input.settings, artifacts }, null, 2)}\n`,
);

console.log(`\nwrote ${join(outputDir, 'contracts.json')}`);

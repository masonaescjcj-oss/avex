import assert from 'node:assert/strict';
import { test } from 'node:test';

import { keccak256 } from '../../crypto/keccak256.js';
import {
  create2Address,
  invoiceSalt,
  predictForwarder,
  toChecksumAddress,
  type Create2Config,
} from './create2.js';

test('toChecksumAddress matches EIP-55 vectors', () => {
  const vectors = [
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
  ];
  for (const expected of vectors) {
    assert.equal(toChecksumAddress(expected.toLowerCase()), expected);
  }
});

test('create2Address matches EIP-1014 vectors', () => {
  const zeroSalt = new Uint8Array(32);
  const initCodeHashOfZeroByte = keccak256(new Uint8Array([0x00]));

  assert.equal(
    create2Address(
      '0x0000000000000000000000000000000000000000',
      zeroSalt,
      initCodeHashOfZeroByte,
    ),
    '0x4D1A2e2bB4F88F0250f26Ffff098B0b30B26BF38',
  );

  assert.equal(
    create2Address(
      '0xdeadbeef00000000000000000000000000000000',
      zeroSalt,
      initCodeHashOfZeroByte,
    ),
    '0xB928f69Bb1D91Cd65274e3c79d8986362984fDA3',
  );
});

test('deposit addresses are deterministic and bound to the payout address', () => {
  // Placeholder creation code — the real value comes from compiling Forwarder.sol.
  const config: Create2Config = {
    factory: '0x00000000000000000000000000000000000000f0',
    forwarderCreationCode: '0x60806040523480156100115760006000fd5b',
  };
  const merchantA = '0x1111111111111111111111111111111111111111';
  const merchantB = '0x2222222222222222222222222222222222222222';

  const first = predictForwarder(config, 'inv_abc', merchantA);

  // Determinism: a retried derivation must never strand a payer at a forgotten address.
  assert.equal(predictForwarder(config, 'inv_abc', merchantA), first);

  // Distinct invoices get distinct addresses.
  assert.notEqual(predictForwarder(config, 'inv_def', merchantA), first);

  // The payout address is part of the init code hash, so changing the merchant
  // changes the deposit address. This is the non-custodial guarantee: an address
  // cannot be re-pointed at a different destination after the fact.
  assert.notEqual(predictForwarder(config, 'inv_abc', merchantB), first);
});

test('invoiceSalt produces a 32-byte salt for any id shape', () => {
  for (const id of ['a', 'inv_0001', 'x'.repeat(500)]) {
    assert.equal(invoiceSalt(id).length, 32);
  }
});

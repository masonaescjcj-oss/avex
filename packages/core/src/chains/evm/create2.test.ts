import assert from 'node:assert/strict';
import { test } from 'node:test';

import { keccak256, toHex } from '../../crypto/keccak256.js';
import {
  CLONE_ARGS_OFFSET,
  cloneInitCode,
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
  const config: Create2Config = {
    factory: '0x00000000000000000000000000000000000000f0',
    implementation: '0x00000000000000000000000000000000000000e1',
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

test('the clone is 97 bytes of init code, and every parameter is in them', () => {
  /**
   * The bytes themselves, because everything else in this file depends on them being right and
   * because a payer's funds are unreachable if they are not. 10 of init prefix, 45 of EIP-1167
   * runtime naming the implementation, then the three parameters packed — 20, 20 and 2.
   *
   * Packed rather than ABI-encoded, which is the change that took a settlement from 385,291 gas
   * to a fraction of it: the parameters used to be constructor arguments padded to 32 bytes each
   * and the code they configured was a full copy of the contract.
   */
  const config: Create2Config = {
    factory: '0x00000000000000000000000000000000000000f0',
    implementation: '0xEEeeEEeeEEeeEEeeEEeeEEeeEEeeEEeeEEeeEEee',
  };
  const code = toHex(
    cloneInitCode(config, '0x1111111111111111111111111111111111111111', {
      feeDestination: '0x2222222222222222222222222222222222222222',
      feeBps: 62,
    }),
  );

  assert.equal(
    code,
    '0x3d605780600a3d3981f3363d3d373d3d3d363d73' +
      'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' +
      '5af43d82803e903d91602b57fd5bf3' +
      '1111111111111111111111111111111111111111' +
      '2222222222222222222222222222222222222222' +
      '003e',
  );

  // 87 is the length the init prefix promises to return, and 45 is where the logic reads the
  // parameters from. Both are in the bytes above, as `6057` and by construction.
  assert.equal((code.length - 2) / 2, 97);
  assert.equal(CLONE_ARGS_OFFSET, 45);
});

test('a fee above the contract ceiling is refused before an address exists', () => {
  // The contract reverts above 5%, so an address derived for more could take a payment and
  // never be settleable. Refused here, where it is still an invoice we have not issued.
  const config: Create2Config = {
    factory: '0x00000000000000000000000000000000000000f0',
    implementation: '0x00000000000000000000000000000000000000e1',
  };
  assert.throws(
    () =>
      cloneInitCode(config, '0x1111111111111111111111111111111111111111', {
        feeDestination: '0x2222222222222222222222222222222222222222',
        feeBps: 501,
      }),
    /exceeds the contract's 500bps ceiling/,
  );
});

test('invoiceSalt produces a 32-byte salt for any id shape', () => {
  for (const id of ['a', 'inv_0001', 'x'.repeat(500)]) {
    assert.equal(invoiceSalt(id).length, 32);
  }
});

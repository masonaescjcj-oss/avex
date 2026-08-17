import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toHex } from '../crypto/keccak256.js';
import {
  AbiError,
  CONTROL_SELECTORS,
  PROXY_SLOTS,
  SELECTORS,
  bytecodeContainsSelector,
  decodeString,
  decodeUint8,
  decodeUint256,
  encodeAddress,
  encodeCall,
  encodeUint256,
  selector,
  slotHoldsAddress,
} from './abi.js';

test('selectors match the published ERC-20 values', () => {
  // These are widely documented; a mismatch means keccak or the signature text is
  // wrong, and every probe call would hit the fallback function instead.
  assert.equal(SELECTORS.balanceOf, '0x70a08231');
  assert.equal(SELECTORS.transfer, '0xa9059cbb');
  assert.equal(SELECTORS.decimals, '0x313ce567');
  assert.equal(SELECTORS.symbol, '0x95d89b41');
  assert.equal(SELECTORS.name, '0x06fdde03');
  assert.equal(SELECTORS.totalSupply, '0x18160ddd');
  assert.equal(SELECTORS.allowance, '0xdd62ed3e');
});

test('a selector is four bytes of hex', () => {
  assert.match(selector('someFunction(uint256)'), /^0x[0-9a-f]{8}$/);
});

test('proxy slots match the EIP-1967 constants', () => {
  // Derived as keccak256(label) - 1. Getting the decrement wrong would read an
  // unrelated slot and report every proxy as a plain contract.
  assert.equal(
    PROXY_SLOTS.implementation,
    '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  );
  assert.equal(
    PROXY_SLOTS.admin,
    '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
  );
});

test('encodeAddress right-aligns into one word', () => {
  const encoded = toHex(encodeAddress('0x1111111111111111111111111111111111111111'));
  assert.equal(
    encoded,
    '0x0000000000000000000000001111111111111111111111111111111111111111',
  );
});

test('encodeAddress rejects anything that is not 20 bytes', () => {
  assert.throws(() => encodeAddress('0x1234'), AbiError);
});

test('encodeUint256 handles zero, small and maximum values', () => {
  assert.equal(toHex(encodeUint256(0n)), `0x${'00'.repeat(32)}`);
  assert.equal(
    toHex(encodeUint256(255n)),
    '0x00000000000000000000000000000000000000000000000000000000000000ff',
  );
  assert.equal(toHex(encodeUint256(2n ** 256n - 1n)), `0x${'ff'.repeat(32)}`);
  assert.throws(() => encodeUint256(-1n), AbiError);
});

test('encodeCall composes a selector with its arguments', () => {
  const data = encodeCall(SELECTORS.transfer, [
    encodeAddress('0x2222222222222222222222222222222222222222'),
    encodeUint256(1000n),
  ]);

  assert.ok(data.startsWith('0xa9059cbb'));
  // Selector plus two 32-byte words.
  assert.equal(data.length, 10 + 128);
});

test('decodeUint256 reads a full word', () => {
  assert.equal(
    decodeUint256('0x00000000000000000000000000000000000000000000000000000000000003e8'),
    1000n,
  );
  assert.equal(decodeUint256(`0x${'ff'.repeat(32)}`), 2n ** 256n - 1n);
  assert.throws(() => decodeUint256('0x1234'), AbiError);
});

test('decodeUint8 accepts a byte and refuses a larger value', () => {
  assert.equal(
    decodeUint8('0x0000000000000000000000000000000000000000000000000000000000000012'),
    18,
  );
  assert.throws(() => decodeUint8(`0x${'ff'.repeat(32)}`), AbiError);
});

test('decodeString reads the modern dynamic encoding', () => {
  // offset 0x20, length 4, "USDT" padded.
  const data =
    '0x0000000000000000000000000000000000000000000000000000000000000020' +
    '0000000000000000000000000000000000000000000000000000000000000004' +
    '5553445400000000000000000000000000000000000000000000000000000000';
  assert.equal(decodeString(data), 'USDT');
});

test('decodeString reads the legacy bytes32 form', () => {
  // Tokens predating the finalised text spec — MKR being the known case — return a
  // raw padded word. Rejecting them over their age would be the wrong outcome.
  const data = '0x4d4b520000000000000000000000000000000000000000000000000000000000';
  assert.equal(decodeString(data), 'MKR');
});

test('decodeString handles an empty string', () => {
  const data =
    '0x0000000000000000000000000000000000000000000000000000000000000020' +
    '0000000000000000000000000000000000000000000000000000000000000000';
  assert.equal(decodeString(data), '');
});

test('decodeString refuses empty return data', () => {
  assert.throws(() => decodeString('0x'), AbiError);
});

test('slotHoldsAddress distinguishes an empty slot from a populated one', () => {
  assert.equal(slotHoldsAddress(`0x${'00'.repeat(32)}`), false);
  assert.equal(
    slotHoldsAddress('0x0000000000000000000000001111111111111111111111111111111111111111'),
    true,
  );
  // Bits above the low 20 bytes are not an address and must not count.
  assert.equal(
    slotHoldsAddress('0x1111111111110000000000000000000000000000000000000000000000000000'),
    false,
  );
});

test('bytecodeContainsSelector finds a selector regardless of case or prefix', () => {
  const bytecode = '0x6080604052806370a08231600052';
  assert.equal(bytecodeContainsSelector(bytecode, SELECTORS.balanceOf), true);
  assert.equal(bytecodeContainsSelector(bytecode, '70A08231'), true);
  assert.equal(bytecodeContainsSelector(bytecode, SELECTORS.transfer), false);
});

test('control selectors cover the powers a stablecoin issuer typically holds', () => {
  // USDT and USDC both carry these; the point is disclosure, not disqualification.
  for (const signature of ['pause()', 'blacklist(address)', 'mint(address,uint256)']) {
    assert.match(CONTROL_SELECTORS[signature]!, /^0x[0-9a-f]{8}$/, signature);
  }
});

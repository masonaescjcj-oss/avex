import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  totpCode,
  totpCodeAtCounter,
  totpUri,
  verifyTotp,
} from './totp.js';

/** The RFC 6238 SHA-1 test seed, ASCII "12345678901234567890". */
const RFC_SECRET = new TextEncoder().encode('12345678901234567890');
const STEP = 30;

test('totp matches the RFC 6238 test vectors', () => {
  const vectors: readonly [time: number, code: string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  for (const [time, expected] of vectors) {
    const counter = Math.floor(time / STEP);
    assert.equal(
      totpCodeAtCounter(RFC_SECRET, counter, 8),
      expected,
      `mismatch at T=${time}`,
    );
  }
});

test('base32 round-trips and matches a known encoding', () => {
  // RFC 4648 §10.
  assert.equal(base32Encode(new TextEncoder().encode('foobar')), 'MZXW6YTBOI');
  assert.equal(base32Encode(new TextEncoder().encode('f')), 'MY');

  for (const input of ['', 'a', 'ab', 'abc', 'abcd', 'abcde', 'the quick brown fox']) {
    const bytes = new TextEncoder().encode(input);
    const decoded = base32Decode(base32Encode(bytes));
    assert.deepEqual(Array.from(decoded).slice(0, bytes.length), Array.from(bytes), input);
  }
});

test('base32Decode rejects characters outside the alphabet', () => {
  assert.throws(() => base32Decode('MZXW6YTB!'), /invalid base32/);
});

test('verifyTotp accepts one step of drift in each direction and rejects two', () => {
  const secret = generateTotpSecret();
  const now = 1_700_000_000;

  assert.equal(verifyTotp(secret, totpCode(secret, now), now), true, 'current step');
  assert.equal(verifyTotp(secret, totpCode(secret, now - STEP), now), true, 'one step behind');
  assert.equal(verifyTotp(secret, totpCode(secret, now + STEP), now), true, 'one step ahead');

  // Two steps out must fail: every additional accepted step multiplies the codes
  // an attacker may guess.
  assert.equal(verifyTotp(secret, totpCode(secret, now - 2 * STEP), now), false);
  assert.equal(verifyTotp(secret, totpCode(secret, now + 2 * STEP), now), false);
});

test('verifyTotp rejects malformed and wrong-length input without throwing', () => {
  const secret = generateTotpSecret();
  for (const submitted of ['', '12345', '1234567', 'abcdef']) {
    assert.equal(verifyTotp(secret, submitted, 1_700_000_000), false, submitted);
  }
});

test('verifyTotp tolerates whitespace in submitted codes', () => {
  const secret = generateTotpSecret();
  const now = 1_700_000_000;
  const code = totpCode(secret, now);
  assert.equal(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, now), true);
});

test('a code from a different secret is rejected', () => {
  const now = 1_700_000_000;
  assert.equal(verifyTotp(generateTotpSecret(), totpCode(generateTotpSecret(), now), now), false);
});

test('totpUri carries the parameters an authenticator app needs', () => {
  const secret = generateTotpSecret();
  const uri = totpUri(secret, 'merchant@example.com');

  assert.ok(uri.startsWith('otpauth://totp/'));
  const params = new URL(uri).searchParams;
  assert.equal(params.get('secret'), secret);
  assert.equal(params.get('algorithm'), 'SHA1');
  assert.equal(params.get('digits'), '6');
  assert.equal(params.get('period'), '30');
});

test('recovery codes are distinct and consistently formatted', () => {
  const codes = generateRecoveryCodes(10);
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10, 'recovery codes collided');
  for (const code of codes) {
    assert.match(code, /^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  }
});

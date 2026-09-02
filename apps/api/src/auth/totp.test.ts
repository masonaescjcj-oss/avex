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
  assert.equal(params.get('issuer'), 'AVEX Pay');
  // The account address belongs in the label, or an authenticator lists two accounts
  // under one name and the person enrolling cannot tell which is which.
  assert.ok(uri.includes(encodeURIComponent('merchant@example.com')), uri);

  /**
   * And nothing else. Spelling out the defaults is 34 bytes, and this URI has to fit a
   * QR: the encoder stops at version 6, so a longer URI means a merchant with no QR to
   * scan. Anything added here has to be paid for out of that budget.
   */
  assert.deepEqual([...params.keys()].sort(), ['issuer', 'secret']);
});

test('an enrolment URI fits the QR encoder for a realistic address', () => {
  /**
   * The budget, pinned. 134 bytes is what QR version 6 holds at error correction level
   * L, which is the largest symbol `@avex/qr` produces — past it the security page has
   * no QR on it and a merchant is typing 32 base32 characters by hand.
   *
   * Checked here rather than in the page because this is where the length is decided.
   */
  const secret = generateTotpSecret();
  for (const email of [
    'admin@avexpay.net',
    'merchant@a-fairly-long-shop-name.example.com',
  ]) {
    const uri = totpUri(secret, email);
    assert.ok(
      Buffer.byteLength(uri, 'utf8') <= 134,
      `${email} produces ${Buffer.byteLength(uri, 'utf8')} bytes: ${uri}`,
    );
  }
});

test('recovery codes are distinct and consistently formatted', () => {
  const codes = generateRecoveryCodes(10);
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10, 'recovery codes collided');
  for (const code of codes) {
    assert.match(code, /^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  }
});

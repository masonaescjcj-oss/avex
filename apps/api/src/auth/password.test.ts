import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CURRENT_PARAMS, hashPassword, needsRehash, verifyPassword } from './password.js';

test('a hashed password verifies and a wrong one does not', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.equal(await verifyPassword('correct horse battery', hash), true);
  assert.equal(await verifyPassword('correct horse batteru', hash), false);
  assert.equal(await verifyPassword('', hash), false);
});

test('the same password hashes differently every time', async () => {
  const [a, b] = await Promise.all([
    hashPassword('same password twice'),
    hashPassword('same password twice'),
  ]);
  // Distinct salts, so identical passwords do not produce identical hashes and a
  // dump cannot reveal which accounts share one.
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('same password twice', a), true);
  assert.equal(await verifyPassword('same password twice', b), true);
});

test('the stored format records its parameters', async () => {
  const hash = await hashPassword('a sufficiently long password');
  const [scheme, cost, blockSize, parallelism] = hash.split('$');

  assert.equal(scheme, 'scrypt');
  assert.equal(Number(cost), CURRENT_PARAMS.cost);
  assert.equal(Number(blockSize), CURRENT_PARAMS.blockSize);
  assert.equal(Number(parallelism), CURRENT_PARAMS.parallelism);
});

test('short passwords are rejected at hash time', async () => {
  await assert.rejects(() => hashPassword('short'), /at least 10 characters/);
});

test('a corrupt stored hash denies access instead of throwing', async () => {
  for (const stored of [
    '',
    'not-a-hash',
    'scrypt$1$2$3',
    'bcrypt$32768$8$1$c2FsdA$aGFzaA',
    'scrypt$abc$8$1$c2FsdA$aGFzaA',
  ]) {
    assert.equal(await verifyPassword('any password at all', stored), false, stored);
  }
});

test('unicode passwords normalise so the same typed password keeps working', async () => {
  // U+00E9 versus e + U+0301 — visually identical, different bytes.
  const composed = 'passwordé-long-enough';
  const decomposed = 'passwordé-long-enough';

  const hash = await hashPassword(composed);
  assert.equal(await verifyPassword(decomposed, hash), true);
});

test('needsRehash flags hashes weaker than current policy', async () => {
  const current = await hashPassword('a sufficiently long password');
  assert.equal(needsRehash(current), false);

  const weaker = current.replace(`$${CURRENT_PARAMS.cost}$`, '$16384$');
  assert.equal(needsRehash(weaker), true);
  assert.equal(needsRehash('garbage'), true);
});

test('a hash made with weaker parameters still verifies', async () => {
  // Verification must stay backward compatible, or raising the cost would lock
  // every existing user out.
  const stored = [
    'scrypt',
    16384,
    8,
    1,
    Buffer.from('0123456789abcdef').toString('base64url'),
    // Derived below rather than hardcoded, so the test does not encode a value
    // that depends on the platform's scrypt.
    '',
  ];
  const { scryptSync } = await import('node:crypto');
  const key = scryptSync('legacy password ok', Buffer.from('0123456789abcdef'), 32, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 256 * 16384 * 8,
  });
  stored[5] = key.toString('base64url');

  assert.equal(await verifyPassword('legacy password ok', stored.join('$')), true);
  assert.equal(await verifyPassword('wrong password here', stored.join('$')), false);
});

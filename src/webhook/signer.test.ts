import assert from 'node:assert/strict';
import { test } from 'node:test';

import { signWebhook, verifyWebhook } from './signer.js';

const SECRET = 'whsec_test_do_not_use';

test('a freshly signed webhook verifies', () => {
  const now = 1_700_000_000;
  const { header, body } = signWebhook(SECRET, { event: 'invoice.paid', id: 'inv_1' }, now);
  assert.deepEqual(verifyWebhook(SECRET, header, body, now), { valid: true });
});

test('a tampered body is rejected', () => {
  const now = 1_700_000_000;
  const { header } = signWebhook(SECRET, { event: 'invoice.paid', amount: '10' }, now);
  const forged = JSON.stringify({ event: 'invoice.paid', amount: '10000' });

  const result = verifyWebhook(SECRET, header, forged, now);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'signature mismatch');
});

test('the wrong secret is rejected', () => {
  const now = 1_700_000_000;
  const { header, body } = signWebhook(SECRET, { event: 'invoice.paid' }, now);
  assert.equal(verifyWebhook('whsec_other', header, body, now).valid, false);
});

test('a replayed webhook falls outside the window', () => {
  const signedAt = 1_700_000_000;
  const { header, body } = signWebhook(SECRET, { event: 'invoice.paid' }, signedAt);

  // Inside the window.
  assert.equal(verifyWebhook(SECRET, header, body, signedAt + 299).valid, true);

  // Replayed an hour later: the signature is genuine, the timestamp is not.
  const replayed = verifyWebhook(SECRET, header, body, signedAt + 3600);
  assert.equal(replayed.valid, false);
  assert.equal(replayed.reason, 'timestamp outside replay window');
});

test('malformed headers are rejected rather than throwing', () => {
  for (const header of ['', 'garbage', 't=abc,v1=deadbeef', 'v1=deadbeef']) {
    const result = verifyWebhook(SECRET, header, '{}', 1_700_000_000);
    assert.equal(result.valid, false, `header ${JSON.stringify(header)} should be invalid`);
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apiKeyMode, hashToken, issueApiKey, issueToken, tokenMatchesHash } from './tokens.js';

test('an issued token verifies against its stored hash', () => {
  const { token, hash } = issueToken();
  assert.equal(tokenMatchesHash(token, hash), true);
  assert.equal(tokenMatchesHash(`${token}x`, hash), false);
});

test('the stored hash does not contain the token', () => {
  // The whole point: a database dump must yield nothing replayable.
  const { token, hash } = issueToken();
  assert.ok(!hash.includes(token));
  assert.match(hash, /^[0-9a-f]{64}$/);
});

test('tokens are unique across many issuances', () => {
  const tokens = new Set(Array.from({ length: 500 }, () => issueToken().token));
  assert.equal(tokens.size, 500);
});

test('tokenMatchesHash rejects malformed stored hashes without throwing', () => {
  const { token } = issueToken();
  for (const stored of ['', 'short', 'z'.repeat(64)]) {
    assert.equal(tokenMatchesHash(token, stored), false, stored);
  }
});

test('an api key carries its mode in the key text', () => {
  // A test key pasted into production configuration must fail loudly rather than
  // quietly move real money.
  const test_ = issueApiKey('test');
  const live = issueApiKey('live');

  assert.ok(test_.token.startsWith('ak_test_'));
  assert.ok(live.token.startsWith('ak_live_'));
  assert.equal(apiKeyMode(test_.token), 'test');
  assert.equal(apiKeyMode(live.token), 'live');
  assert.equal(apiKeyMode('sk_live_whatever'), null);
});

test('the api key display prefix identifies a key without revealing it', () => {
  const key = issueApiKey('live');
  assert.equal(key.displayPrefix, key.token.slice(0, 12));
  assert.ok(key.token.length > key.displayPrefix.length + 16);
  assert.equal(key.hash, hashToken(key.token));
});

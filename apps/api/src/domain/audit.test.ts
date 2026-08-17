import assert from 'node:assert/strict';
import { test } from 'node:test';

import { redact } from './audit.js';

test('credential-shaped fields never reach the audit log', () => {
  // Callers pass whole request bodies when recording a change; a single careless
  // spread would otherwise write a plaintext password into a table kept forever.
  const cleaned = redact({
    email: 'merchant@example.com',
    password: 'super secret value',
    totpSecret: 'JBSWY3DPEHPK3PXP',
    apiKey: 'ak_live_abc',
  }) as Record<string, unknown>;

  assert.equal(cleaned.email, 'merchant@example.com');
  assert.equal(cleaned.password, '[redacted]');
  assert.equal(cleaned.totpSecret, '[redacted]');
  assert.equal(cleaned.apiKey, '[redacted]');
});

test('redaction reaches nested objects and arrays', () => {
  const cleaned = redact({
    before: { payoutAddress: '0xAAA', secret: 'leak me' },
    members: [{ email: 'a@b.c', password: 'nope' }],
  }) as Record<string, Record<string, unknown>>;

  assert.equal(cleaned.before!.payoutAddress, '0xAAA');
  assert.equal(cleaned.before!.secret, '[redacted]');
  assert.equal((cleaned.members as unknown as Record<string, unknown>[])[0]!.password, '[redacted]');
});

test('redaction passes primitives and null through unchanged', () => {
  assert.equal(redact(null), null);
  assert.equal(redact('plain'), 'plain');
  assert.equal(redact(42), 42);
  assert.equal(redact(true), true);
});

test('deeply nested structures terminate instead of recursing forever', () => {
  const cyclic: Record<string, unknown> = { name: 'root' };
  cyclic.self = cyclic;
  assert.doesNotThrow(() => redact(cyclic));
});

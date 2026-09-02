import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildServer } from './server.js';
import { loadEnv } from '../env.js';

/**
 * What a 500 tells the person who has to fix it.
 *
 * This is the one error whose cause is never in the response — by design, since the
 * inside of a failure is not the caller's business. Which leaves whoever is debugging
 * holding "Something went wrong on our side" and nothing to search for, and an afternoon
 * went that way: a dashboard reported it from an unnamed request, and finding which of
 * eight calls had failed meant reading the whole journal.
 *
 * So the reply carries the request id that is on the log line. These tests hold the two
 * properties that makes it worth anything: it is there at all, and it differs per
 * request, because a constant would be a reference that identifies nothing.
 */

/** Every service the server wires, answering anything, harmlessly. */
const stub = new Proxy({}, { get: () => new Proxy(() => {}, { get: () => () => {} }) }) as never;

function serverThatFails() {
  const env = loadEnv({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/avex',
    // No stamp: this suite is about the error body, and /health is tested elsewhere.
    BUILD_STAMP_FILE: '/nonexistent/avex/build',
  });

  return buildServer({
    ledger: stub,
    walletPool: stub,
    walletChanges: stub,
    env,
    db: stub,
    /**
     * Session resolution throws, which is the shape of the real failure: something
     * unexpected on the way into a request, before any route logic. A database that has
     * gone away arrives exactly here.
     */
    auth: {
      resolveSession: () => {
        throw new Error('the database is not there');
      },
    } as never,
    audit: stub,
    mailer: stub,
    prices: stub,
    assets: stub,
    payouts: stub,
    invites: stub,
    memberships: stub,
    staffAuth: stub,
    admin: stub,
    settlements: stub,
    reconciliation: stub,
    merchant: stub,
    webhooks: stub,
    feePlans: stub,
    invoiceCreation: stub,
    checkouts: stub,
    minPriceSources: 2,
  });
}

test('a 500 says nothing about the cause and everything about where to find it', async () => {
  const app = serverThatFails();
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/organizations',
      headers: { authorization: 'Bearer anything' },
    });

    assert.equal(response.statusCode, 500);
    const body = response.json();
    assert.equal(body.error, 'internal_error');
    assert.equal(body.message, 'Something went wrong on our side.');
    assert.match(String(body.requestId), /^\S+$/, 'a 500 with no reference is unsearchable');

    // And nothing about what actually broke: the message must not carry the exception.
    assert.doesNotMatch(JSON.stringify(body), /database is not there/);
  } finally {
    await app.close();
  }
});

test('the reference identifies one request rather than all of them', async () => {
  const app = serverThatFails();
  try {
    const ids = [];
    for (let i = 0; i < 2; i++) {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/organizations',
        headers: { authorization: 'Bearer anything' },
      });
      ids.push(response.json().requestId);
    }
    assert.notEqual(ids[0], ids[1], 'a constant reference is not a reference');
  } finally {
    await app.close();
  }
});

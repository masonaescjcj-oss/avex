import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';

import { TonApi } from './TonApi.js';

/**
 * The pacing, against a real server that counts and refuses.
 *
 * This exists because of a live failure, not a hypothetical one: a merchant's TON payment was
 * never seen, and the watcher log said `ton api masterchainInfo: HTTP 429` and `ton api
 * jetton/transfers: HTTP 429`. toncenter's anonymous allowance is about one request a second
 * and a single poll is three of them back to back, so two were refused every round and the
 * poll failed every round. Nothing was wrong with the adapter, the wallet, or the payment.
 */

interface Handled {
  readonly path: string;
  readonly at: number;
}

describe('TonApi rate limiting', () => {
  let server: Server;
  let base: string;
  let handled: Handled[] = [];
  /** How many of the next requests to refuse, and with what `Retry-After`. */
  let refuse = 0;
  let retryAfter: string | null = null;
  /** Answered instead of 200 when set, for refusals that are not about rate. */
  let failWith: number | null = null;

  before(async () => {
    server = createServer((request, response) => {
      handled.push({ path: (request.url ?? '').split('?')[0]!, at: Date.now() });
      if (refuse > 0) {
        refuse -= 1;
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (retryAfter !== null) headers['retry-after'] = retryAfter;
        response.writeHead(429, headers);
        response.end(JSON.stringify({ error: 'rate limit' }));
        return;
      }
      if (failWith !== null) {
        response.writeHead(failWith, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'no' }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => server.close());

  const fresh = (): void => {
    handled = [];
    refuse = 0;
    retryAfter = null;
    failWith = null;
  };

  test('requests are spaced, so a poll does not refuse itself', async () => {
    fresh();
    const api = new TonApi({ apiUrl: base, minIntervalMs: 60 });

    // The three calls one poll makes, issued exactly as the adapter issues them.
    await api.get('masterchainInfo', {});
    await api.get('jetton/transfers', { owner_address: 'UQ' });
    await api.get('transactions', { account: 'UQ' });

    assert.equal(handled.length, 3);
    for (let i = 1; i < handled.length; i++) {
      const gap = handled[i]!.at - handled[i - 1]!.at;
      assert.ok(gap >= 55, `request ${i} came ${gap}ms after the last, under the 60ms floor`);
    }
  });

  test('concurrent callers queue rather than burst', async () => {
    /**
     * The property the pacing actually needs. Spacing sequential calls is easy; what breaks a
     * rate limit is two of them starting at once, which is what `Promise.all` over a
     * merchant's wallets would do if anything above ever did that.
     */
    fresh();
    const api = new TonApi({ apiUrl: base, minIntervalMs: 60 });

    await Promise.all([
      api.get('masterchainInfo', {}),
      api.get('masterchainInfo', {}),
      api.get('masterchainInfo', {}),
    ]);

    assert.equal(handled.length, 3);
    const span = handled[2]!.at - handled[0]!.at;
    assert.ok(span >= 110, `three requests in ${span}ms is a burst, not a queue`);
  });

  test('a refusal is waited out, not passed up as a failed poll', async () => {
    fresh();
    refuse = 2;
    const warnings: string[] = [];
    const api = new TonApi({
      apiUrl: base,
      minIntervalMs: 10,
      warn: (message) => warnings.push(message),
    });

    const body = await api.get<{ ok: boolean }>('masterchainInfo', {});
    assert.deepEqual(body, { ok: true });
    assert.equal(handled.length, 3, 'two refusals and the answer');
    assert.equal(warnings.length, 2);
    assert.match(warnings[0]!, /rate limited/);
  });

  test('the server’s own Retry-After is honoured', async () => {
    fresh();
    refuse = 1;
    retryAfter = '1';
    const api = new TonApi({ apiUrl: base, minIntervalMs: 10 });

    const started = Date.now();
    await api.get('masterchainInfo', {});
    const took = Date.now() - started;
    assert.ok(took >= 900, `waited ${took}ms, ignoring a one-second Retry-After`);
  });

  test('a refusal that will not stop fails the poll, so the cursor stays put', async () => {
    /**
     * Failing is the correct end of the road, and harmless: the poll throws before returning
     * a cursor, so the same window is read again next round and nothing is missed. What is
     * not harmless is failing on the *first* refusal, which is what used to happen.
     */
    fresh();
    refuse = 99;
    const api = new TonApi({ apiUrl: base, minIntervalMs: 10, maxRetries: 2 });

    await assert.rejects(() => api.get('masterchainInfo', {}), /HTTP 429/);
    assert.equal(handled.length, 3, 'the first try and two retries');
  });

  test('a refusal that is not about rate is raised at once', async () => {
    // A 422 is a request that is wrong, and will be just as wrong a second later. Retrying it
    // spends the allowance the next real request needs.
    fresh();
    failWith = 422;
    const api = new TonApi({ apiUrl: base, minIntervalMs: 10 });

    await assert.rejects(() => api.get('jetton/transfers', { owner_address: 'nonsense' }), /HTTP 422/);
    assert.equal(handled.length, 1, 'tried once');
  });

  test('the default pace follows whether a key is configured', () => {
    /**
     * The two regimes are an order of magnitude apart and the wrong default is expensive in
     * both directions: anonymous-fast means every poll is refused, keyed-slow means a
     * merchant with ten wallets waits minutes to learn they were paid.
     */
    const anonymous = new TonApi({ apiUrl: base }) as unknown as { minIntervalMs: number };
    const keyed = new TonApi({ apiUrl: base, apiKey: 'k' }) as unknown as { minIntervalMs: number };
    assert.ok(anonymous.minIntervalMs >= 1000, `anonymous paced at ${anonymous.minIntervalMs}ms`);
    assert.ok(keyed.minIntervalMs < anonymous.minIntervalMs / 5, 'a key must buy real speed');
  });
});

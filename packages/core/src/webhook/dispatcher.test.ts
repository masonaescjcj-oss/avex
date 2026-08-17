import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_DISPATCHER,
  WebhookDispatcher,
  backoffMs,
  shouldRetry,
  type HttpPoster,
  type PendingDelivery,
} from './dispatcher.js';
import { verifyWebhook } from './signer.js';

const NOW = 1_700_000_000_000;
const SECRET = 'whsec_test_value';

function delivery(overrides: Partial<PendingDelivery> = {}): PendingDelivery {
  return {
    id: 'evt_1',
    url: 'https://merchant.example.com/hooks',
    secret: SECRET,
    event: 'invoice.paid',
    payload: { invoiceId: 'inv_1', amount: '20000000' },
    idempotencyKey: 'idem_abc',
    attempts: 0,
    ...overrides,
  };
}

/** Records what was posted and answers however the test dictates. */
class FakePoster implements HttpPoster {
  readonly posts: { url: string; body: string; headers: Record<string, string> }[] = [];

  constructor(private readonly respond: (attempt: number) => number | Error) {}

  async post(url: string, body: string, headers: Readonly<Record<string, string>>) {
    this.posts.push({ url, body, headers: { ...headers } });
    const answer = this.respond(this.posts.length);
    if (answer instanceof Error) throw answer;
    return { statusCode: answer };
  }
}

test('a 200 marks the delivery delivered and stops', async () => {
  const poster = new FakePoster(() => 200);
  const outcome = await new WebhookDispatcher(poster).deliver(delivery(), NOW);

  assert.equal(outcome.status, 'delivered');
  assert.equal(outcome.attempts, 1);
  assert.equal(outcome.nextAttemptAt, null);
});

test('any 2xx counts as delivered', async () => {
  for (const status of [200, 201, 202, 204]) {
    const outcome = await new WebhookDispatcher(new FakePoster(() => status)).deliver(
      delivery(),
      NOW,
    );
    assert.equal(outcome.status, 'delivered', `status ${status}`);
  }
});

test('the payload is signed so the merchant can verify it', async () => {
  const poster = new FakePoster(() => 200);
  await new WebhookDispatcher(poster).deliver(delivery(), NOW);

  const post = poster.posts[0]!;
  const header = post.headers['avex-signature']!;

  assert.equal(
    verifyWebhook(SECRET, header, post.body, Math.floor(NOW / 1000)).valid,
    true,
  );
  // And a different secret must not verify.
  assert.equal(
    verifyWebhook('whsec_other', header, post.body, Math.floor(NOW / 1000)).valid,
    false,
  );
});

test('every attempt carries the same idempotency key', async () => {
  // Retries make duplicates inevitable — the merchant may have processed a
  // response we never received — so they must be able to recognise one.
  const poster = new FakePoster(() => 500);
  const dispatcher = new WebhookDispatcher(poster);

  await dispatcher.deliver(delivery({ attempts: 0 }), NOW);
  await dispatcher.deliver(delivery({ attempts: 1 }), NOW);

  const keys = poster.posts.map((post) => post.headers['avex-idempotency-key']);
  assert.deepEqual(keys, ['idem_abc', 'idem_abc']);
  // The attempt number changes, so a merchant can tell a retry from the original.
  assert.deepEqual(
    poster.posts.map((post) => post.headers['avex-attempt']),
    ['1', '2'],
  );
});

test('a 500 is retried with a future attempt time', async () => {
  const poster = new FakePoster(() => 500);
  const outcome = await new WebhookDispatcher(poster).deliver(delivery(), NOW);

  assert.equal(outcome.status, 'pending');
  assert.equal(outcome.statusCode, 500);
  assert.ok(outcome.nextAttemptAt !== null && outcome.nextAttemptAt > NOW);
});

test('a network failure is retried', async () => {
  const poster = new FakePoster(() => new Error('ECONNREFUSED'));
  const outcome = await new WebhookDispatcher(poster).deliver(delivery(), NOW);

  assert.equal(outcome.status, 'pending');
  assert.equal(outcome.statusCode, null);
  assert.match(outcome.error!, /ECONNREFUSED/);
});

test('a 4xx fails immediately instead of retrying for hours', async () => {
  // A wrong URL or a rejected signature is the merchant's configuration, and
  // retrying only delays them finding out.
  for (const status of [400, 401, 403, 404, 410, 422]) {
    const outcome = await new WebhookDispatcher(new FakePoster(() => status)).deliver(
      delivery(),
      NOW,
    );
    assert.equal(outcome.status, 'failed', `status ${status}`);
    assert.equal(outcome.nextAttemptAt, null, `status ${status}`);
  }
});

test('408 and 429 are retried, since both ask to be', async () => {
  for (const status of [408, 429]) {
    const outcome = await new WebhookDispatcher(new FakePoster(() => status)).deliver(
      delivery(),
      NOW,
    );
    assert.equal(outcome.status, 'pending', `status ${status}`);
  }
});

test('shouldRetry draws the line where the fault lies', () => {
  assert.equal(shouldRetry(null), true, 'a network failure is transient');
  assert.equal(shouldRetry(500), true);
  assert.equal(shouldRetry(503), true);
  assert.equal(shouldRetry(408), true);
  assert.equal(shouldRetry(429), true);
  assert.equal(shouldRetry(400), false);
  assert.equal(shouldRetry(404), false);
});

test('a delivery is abandoned rather than dropped once attempts run out', async () => {
  // A merchant who never received a paid callback has a real problem; it must be
  // visible to an operator, not silently discarded.
  const outcome = await new WebhookDispatcher(new FakePoster(() => 500)).deliver(
    delivery({ attempts: DEFAULT_DISPATCHER.maxAttempts - 1 }),
    NOW,
  );

  assert.equal(outcome.status, 'abandoned');
  assert.equal(outcome.attempts, DEFAULT_DISPATCHER.maxAttempts);
  assert.equal(outcome.nextAttemptAt, null);
  assert.match(outcome.error!, /gave up after/);
});

test('backoff grows and then stops growing', () => {
  const config = { ...DEFAULT_DISPATCHER, baseDelayMs: 1000, maxDelayMs: 60_000 };
  // Fixed jitter, so the growth itself is what is being measured.
  const noJitter = () => 1;

  assert.equal(backoffMs(1, config, noJitter), 1000);
  assert.equal(backoffMs(2, config, noJitter), 2000);
  assert.equal(backoffMs(3, config, noJitter), 4000);
  assert.equal(backoffMs(8, config, noJitter), 60_000, 'capped');
  assert.equal(backoffMs(20, config, noJitter), 60_000, 'still capped');
});

test('backoff is jittered so a backlog does not stampede on recovery', () => {
  // Without jitter, every delivery queued during an outage retries at the same
  // instant and knocks the recovering endpoint over again.
  const delays = new Set(
    Array.from({ length: 50 }, () => backoffMs(4, DEFAULT_DISPATCHER)),
  );
  assert.ok(delays.size > 10, `expected spread, got ${delays.size} distinct values`);

  // And it stays within the interval rather than wandering.
  const capped = Math.min(DEFAULT_DISPATCHER.baseDelayMs * 8, DEFAULT_DISPATCHER.maxDelayMs);
  for (const delay of delays) {
    assert.ok(delay >= capped / 2 && delay <= capped, `${delay} outside the interval`);
  }
});

test('the event name and body reach the endpoint', async () => {
  const poster = new FakePoster(() => 200);
  await new WebhookDispatcher(poster).deliver(delivery(), NOW);

  const post = poster.posts[0]!;
  assert.equal(post.headers['avex-event'], 'invoice.paid');
  assert.equal(post.headers['content-type'], 'application/json');

  const body = JSON.parse(post.body);
  assert.equal(body.event, 'invoice.paid');
  assert.equal(body.invoiceId, 'inv_1');
  // Amounts stay strings end to end; JSON numbers cannot hold an 18-decimal value.
  assert.equal(typeof body.amount, 'string');
});

test('a successful retry after failures still ends delivered', async () => {
  const poster = new FakePoster((attempt) => (attempt < 3 ? 500 : 200));
  const dispatcher = new WebhookDispatcher(poster);

  let current = delivery();
  let outcome = await dispatcher.deliver(current, NOW);
  assert.equal(outcome.status, 'pending');

  current = { ...current, attempts: outcome.attempts };
  outcome = await dispatcher.deliver(current, NOW);
  assert.equal(outcome.status, 'pending');

  current = { ...current, attempts: outcome.attempts };
  outcome = await dispatcher.deliver(current, NOW);
  assert.equal(outcome.status, 'delivered');
  assert.equal(outcome.attempts, 3);
});

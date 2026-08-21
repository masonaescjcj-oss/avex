import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import { ContractProbe, DEFAULT_AGGREGATION, DEFAULT_BREAKER, PriceService, WebhookDispatcher } from '@avex/core';
import type { PriceSource } from '@avex/core';
import type { FastifyInstance } from 'fastify';

import { createDatabase, looksPooled } from '../db/client.js';
import { AdminService } from '../domain/admin-service.js';
import { AssetService } from '../domain/asset-service.js';
import { AuditService } from '../domain/audit.js';
import { AuthService } from '../domain/auth-service.js';
import { CheckoutService } from '../domain/checkout-service.js';
import { DepositAddressDeriver } from '../domain/deposit-address.js';
import { FeePlanService } from '../domain/fee-plan-service.js';
import { InviteService } from '../domain/invite-service.js';
import { InvoiceCreationService } from '../domain/invoice-creation.js';
import { MembershipService } from '../domain/membership-service.js';
import { MerchantService } from '../domain/merchant-service.js';
import { PayoutAddressService } from '../domain/payout-service.js';
import { ReconciliationService } from '../domain/reconciliation-service.js';
import { SettlementStore } from '../domain/settlement-store.js';
import { StaffAuthService } from '../domain/staff-auth.js';
import { WebhookService } from '../domain/webhook-service.js';
import { loadEnv } from '../env.js';
import { JOB_NAMES } from '../jobs.js';
import { ConsoleMailer } from '../mailer.js';
import { buildServer } from './server.js';

/**
 * The hook a scheduler calls when there is no process to hold timers in.
 *
 * It exists so the background jobs can run on a deployment that scales to zero, and it is
 * the only route on this server authenticated by a shared secret rather than by a session
 * or a scoped key. That makes it the weakest credential here, so what it can do is one
 * thing and the tests below are mostly about the door rather than the room.
 */
const databaseUrl = process.env.DATABASE_URL;

const FACTORY = '0x00000000000000000000000000000000000f4c70';
const CREATION_CODE = '0x60806040523480156100115760006000fd5b50';
const TON_WALLET = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
const SECRET = `cron-${'x'.repeat(30)}`;

const offlineCaller = {
  async getCode(): Promise<string> {
    throw new Error('offline');
  },
  async call(): Promise<string> {
    throw new Error('offline');
  },
  async getStorageAt(): Promise<string> {
    throw new Error('offline');
  },
};

const source = (name: string): PriceSource => ({
  name,
  supports: () => true,
  async fetchUsdPrice() {
    return { priceScaled: 10n ** 18n, observedAt: Date.now() };
  },
});

/** Build a server with or without a configured secret. */
function boot(
  secret: string | undefined,
  extra: Record<string, string> = {},
): {
  app: FastifyInstance;
  close: () => Promise<void>;
} {
  const env = loadEnv({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl!,
    RATE_LIMIT_PER_MINUTE: '10000',
    ...(secret === undefined ? {} : { CRON_SECRET: secret }),
    ...extra,
  });

  const database = createDatabase(env.DATABASE_URL);
  const db = database.db;
  const audit = new AuditService(db);
  const mailer = new ConsoleMailer(env.APP_URL, () => {});
  const prices = new PriceService([source('a'), source('b')], {
    aggregation: DEFAULT_AGGREGATION,
    breaker: DEFAULT_BREAKER,
    cacheTtlMs: 0,
  });
  const feePlans = new FeePlanService(db, audit, { feeCollectors: {} });
  const deriver = new DepositAddressDeriver(
    {
      evm: { bsc: { factory: FACTORY, forwarderCreationCode: CREATION_CODE } },
      shared: { ton: TON_WALLET },
    },
    'jobs-suite-memo-secret',
  );
  const rates = { requireRate: (symbol: never) => prices.requireRate(symbol) };
  const invoiceCreation = new InvoiceCreationService(db, deriver, feePlans, rates, audit);
  const settlements = new SettlementStore(db);
  const reconciliation = new ReconciliationService(db, audit, {
    async recompute() {
      throw new Error('not exercised here');
    },
  });

  const app = buildServer({
    env,
    db,
    audit,
    mailer,
    prices,
    minPriceSources: DEFAULT_AGGREGATION.minSources,
    assets: new AssetService(db, audit, new ContractProbe(offlineCaller), ['USDT']),
    payouts: new PayoutAddressService(db, audit, mailer),
    invites: new InviteService(db, audit),
    memberships: new MembershipService(db, audit, mailer),
    auth: new AuthService(db, audit, { sessionTtlMs: 3_600_000, emailTokenTtlMs: 3_600_000 }),
    staffAuth: new StaffAuthService(db, audit),
    settlements,
    reconciliation,
    admin: new AdminService(db, audit, settlements, reconciliation),
    merchant: new MerchantService(db),
    webhooks: new WebhookService(
      db,
      new WebhookDispatcher({
        async post() {
          return { statusCode: 200 };
        },
      }),
    ),
    feePlans,
    invoiceCreation,
    checkouts: new CheckoutService(db, invoiceCreation, feePlans, deriver, rates, audit),
  });

  return {
    app,
    close: async () => {
      await app.close();
      await database.close();
    },
  };
}

describe('the scheduler hook', { skip: databaseUrl ? false : 'DATABASE_URL not set' }, () => {
  let app: FastifyInstance;
  let close: () => Promise<void>;

  before(async () => {
    ({ app, close } = boot(SECRET));
    await app.ready();
  });

  after(async () => {
    await close?.();
  });

  const call = (headers: Record<string, string> = {}, query = '') =>
    app.inject({ method: 'POST', url: `/internal/jobs${query}`, headers });

  test('the right secret runs every job and reports each one', async () => {
    const response = await call({ 'x-cron-secret': SECRET });
    assert.equal(response.statusCode, 200, response.body);

    const names = response.json().jobs.map((job: { job: string }) => job.job);
    assert.deepEqual(names, [...JOB_NAMES]);
    // Each reports whether it ran, because "another copy had the lock" is not a failure and
    // must not read as one.
    for (const job of response.json().jobs) {
      assert.equal(typeof job.ran, 'boolean');
    }
  });

  test('one job can be asked for by name', async () => {
    // A scheduler with three entries at three different intervals, which is the arrangement
    // the intervals in `jobs.ts` describe.
    const response = await call({ 'x-cron-secret': SECRET }, '?job=payouts');
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(
      response.json().jobs.map((job: { job: string }) => job.job),
      ['payouts'],
    );
  });

  test('a job nobody has is a 400 that names the ones that exist', async () => {
    // The mistake is a typo in a cron entry, and the fix is knowing what to type instead.
    const response = await call({ 'x-cron-secret': SECRET }, '?job=sweep');
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error, 'unknown_job');
    for (const name of JOB_NAMES) {
      assert.match(response.json().message, new RegExp(name));
    }
  });

  test('no secret, a wrong secret, and a prefix of the right one are all refused', async () => {
    /**
     * The prefix case is the one worth writing down: the comparison is constant-time, so a
     * near-miss must be as unhelpful as a wild guess. It is a thin channel over the
     * internet, but this secret gates the webhook queue and the entire defence is that it
     * cannot be guessed.
     */
    for (const headers of [
      {},
      { 'x-cron-secret': 'wrong' },
      { 'x-cron-secret': SECRET.slice(0, -1) },
      { 'x-cron-secret': `${SECRET}x` },
      { 'x-cron-secret': '' },
    ]) {
      const response = await call(headers);
      assert.equal(response.statusCode, 403, JSON.stringify({ headers, body: response.body }));
      assert.equal(response.json().error, 'forbidden');
    }
  });

  test('the hook does not accept a session or an API key instead', async () => {
    /**
     * It is deliberately outside the principal model — a cron entry is not a user — which
     * means an ordinary `Authorization` header must not open it. Otherwise any signed-in
     * merchant could drain the webhook queue at whatever rate they liked.
     */
    const response = await call({ authorization: 'Bearer anything-at-all' });
    assert.equal(response.statusCode, 403, response.body);
  });
});

describe('the scheduler hook, unconfigured', {
  skip: databaseUrl ? false : 'DATABASE_URL not set',
}, () => {
  test('with no secret set the route does not exist at all', async () => {
    /**
     * 404 rather than 403, and the difference is the point: a deployment that drives its
     * jobs with timers has no use for this route, and answering "forbidden" would advertise
     * that a secret exists to be guessed. Nothing is reachable, so nothing is described.
     */
    const { app, close } = boot(undefined);
    await app.ready();

    for (const headers of [{}, { 'x-cron-secret': SECRET }]) {
      const response = await app.inject({ method: 'POST', url: '/internal/jobs', headers });
      assert.equal(response.statusCode, 404, response.body);
      assert.equal(response.json().error, 'not_found');
    }
    await close();
  });
});

describe('pooled connection strings', () => {
  test('a transaction pooler is recognised, and a direct connection is not', () => {
    /**
     * Prepared statements have to be off through a transaction-mode pooler, which hands each
     * statement whichever backend is free — so one prepared on the first connection is
     * unknown on the next, and the error names nothing in this codebase.
     *
     * Guessing wrong towards "pooled" costs prepared statements. Guessing wrong the other
     * way produces that error, so the markers here are narrow on purpose.
     */
    assert.equal(looksPooled('postgres://u:p@aws-0-eu-west-1.pooler.supabase.com:6543/postgres'), true);
    assert.equal(looksPooled('postgres://u:p@db.example.supabase.co:5432/postgres'), false);
    assert.equal(looksPooled('postgres://postgres:postgres@localhost:5455/avex'), false);
    // The port alone is enough: a self-hosted Supavisor will not be on their hostname.
    assert.equal(looksPooled('postgres://u:p@10.0.0.5:6543/postgres'), true);
  });

  test('nonsense is treated as a direct connection rather than throwing', () => {
    // This runs at startup, before anything has validated the string as a URL. Throwing
    // here would replace a clear connection error with a confusing parse error.
    assert.equal(looksPooled('not a url'), false);
    assert.equal(looksPooled(''), false);
  });
});

describe('cross-origin access to the authenticated routes', {
  skip: databaseUrl ? false : 'DATABASE_URL not set',
}, () => {
  /**
   * Needed only when the dashboard is served from a different origin than the API, which is
   * what a static host in front of a serverless API means. Every test here is about the
   * boundary rather than the feature: this is the one hook that decides whether another
   * website's JavaScript may talk to an API that takes credentials.
   */
  const ALLOWED = 'https://avexpay.net';
  const ALSO = 'https://dash.avexpay.net';

  test('a named origin is allowed, and told so per origin', async () => {
    const { app, close } = boot(undefined, { DASHBOARD_ORIGINS: `${ALLOWED},${ALSO}` });
    await app.ready();

    for (const origin of [ALLOWED, ALSO]) {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/organizations',
        headers: { origin },
      });
      assert.equal(response.headers['access-control-allow-origin'], origin);
      /**
       * `Vary: origin`, or a cache keyed on the URL alone serves one origin's header to
       * another — which turns a correct allowlist into a wildcard at the CDN.
       */
      assert.match(String(response.headers['vary']), /origin/i);
      // Never allowed: the token is set by the page, and allowing credentials would invite a
      // browser to attach cookies a future deployment might set.
      assert.equal(response.headers['access-control-allow-credentials'], undefined);
    }
    await close();
  });

  test('an origin nobody named gets no header at all', async () => {
    /**
     * Absence is the enforcement. A 403 would be indistinguishable, to the page, from the API
     * being down — and the browser blocks the request either way.
     */
    const { app, close } = boot(undefined, { DASHBOARD_ORIGINS: ALLOWED });
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/organizations',
      headers: { origin: 'https://attacker.example' },
    });
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    await close();
  });

  test('a preflight is answered, allowed or not', async () => {
    const { app, close } = boot(undefined, { DASHBOARD_ORIGINS: ALLOWED });
    await app.ready();

    const allowed = await app.inject({
      method: 'OPTIONS',
      url: '/v1/organizations',
      headers: { origin: ALLOWED, 'access-control-request-method': 'GET' },
    });
    assert.equal(allowed.statusCode, 204);
    assert.equal(allowed.headers['access-control-allow-origin'], ALLOWED);
    // The header the session travels in, or every authenticated request fails the preflight.
    assert.match(String(allowed.headers['access-control-allow-headers']), /authorization/i);
    /**
     * And not the scheduler's header. That hook is not a browser and has no business being
     * reachable through a preflight — naming it here would advertise it.
     */
    assert.ok(!/cron/i.test(String(allowed.headers['access-control-allow-headers'])));

    const refused = await app.inject({
      method: 'OPTIONS',
      url: '/v1/organizations',
      headers: { origin: 'https://attacker.example', 'access-control-request-method': 'GET' },
    });
    assert.equal(refused.statusCode, 204);
    assert.equal(refused.headers['access-control-allow-origin'], undefined);
    await close();
  });

  test('no allowlist means no cross-origin access at all', async () => {
    // The default, and right for a deployment serving the dashboard from the API's own origin.
    const { app, close } = boot(undefined, {});
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/organizations',
      headers: { origin: ALLOWED },
    });
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    await close();
  });

  test('being allowed to ask is not being allowed in', async () => {
    /**
     * The distinction that matters. CORS decides whether a page may *make* the request; the
     * principal check decides whether it is answered. A named origin with no token still gets
     * a 401 — otherwise the allowlist would be an authentication bypass.
     */
    const { app, close } = boot(undefined, { DASHBOARD_ORIGINS: ALLOWED });
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/organizations',
      headers: { origin: ALLOWED },
    });
    assert.equal(response.statusCode, 401, response.body);
    assert.equal(response.headers['access-control-allow-origin'], ALLOWED);
    await close();
  });

  test('the checkout keeps its own narrower allowlist', async () => {
    /**
     * Two hooks, two lists, and `/pay` belongs to the first one. A payer's origin must not
     * inherit access to the authenticated routes, and a dashboard origin must not silently
     * gain the checkout's — they are different audiences.
     */
    const { app, close } = boot(undefined, {
      DASHBOARD_ORIGINS: ALLOWED,
      CHECKOUT_ORIGINS: 'https://pay.avexpay.net',
    });
    await app.ready();

    const payerOnDashboard = await app.inject({
      method: 'GET',
      url: '/v1/organizations',
      headers: { origin: 'https://pay.avexpay.net' },
    });
    assert.equal(payerOnDashboard.headers['access-control-allow-origin'], undefined);

    const dashboardOnCheckout = await app.inject({
      method: 'GET',
      url: '/pay/00000000-0000-4000-8000-000000000000/state',
      headers: { origin: ALLOWED },
    });
    assert.equal(dashboardOnCheckout.headers['access-control-allow-origin'], undefined);
    await close();
  });
});

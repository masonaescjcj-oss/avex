import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildServer } from './server.js';
import { loadEnv } from '../env.js';

/**
 * The API reference against the routes that actually exist.
 *
 * Hand-written API docs have one failure mode and it is always the same: someone adds a
 * route and forgets the page, or renames a path and leaves the old one documented. A
 * merchant then integrates against something that does not exist, which is worse than
 * having no documentation — they trust it.
 *
 * So the page carries `data-route="METHOD /path"` on every endpoint block, and this test
 * diffs that set against the server's own route table in both directions. A new route
 * has to be either documented or explicitly listed as internal below, which makes it a
 * decision either way rather than an omission.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DOC = join(here, '..', '..', '..', '..', 'docs', 'api.html');

/**
 * Routes that exist and are deliberately absent from the public reference.
 *
 * Two kinds. The dashboard's own plumbing — sign-in, TOTP enrolment, member invites —
 * which a merchant's server never calls and which would only distract from the four
 * things this API is for. And the staff panel, which is not a merchant surface at all:
 * documenting it would tell anyone reading exactly what to attack.
 */
const INTERNAL = new Set([
  // Dashboard session lifecycle. Not part of an integration.
  'POST /v1/auth/signup',
  'POST /v1/auth/login',
  'POST /v1/auth/logout',
  'POST /v1/auth/mfa',
  'POST /v1/auth/verify-email',
  'POST /v1/auth/sessions/revoke-others',
  'POST /v1/auth/totp/enroll',
  'POST /v1/auth/totp/confirm',
  'GET /v1/auth/me',
  // Organisation and team administration, done by a human in the dashboard.
  'GET /v1/organizations',
  'GET /v1/organizations/:orgId/members',
  'POST /v1/organizations/:orgId/members',
  'GET /v1/organizations/:orgId/invites',
  'DELETE /v1/organizations/:orgId/invites/:inviteId',
  'POST /v1/invites/accept',
  'PATCH /v1/organizations/:orgId/members/:userId',
  'DELETE /v1/organizations/:orgId/members/:userId',
  'GET /v1/organizations/:orgId/api-keys',
  'POST /v1/organizations/:orgId/api-keys',
  'DELETE /v1/organizations/:orgId/api-keys/:keyId',
  'GET /v1/organizations/:orgId/audit-log',
  // Asset configuration is a dashboard task; the reference documents reading the list.
  'POST /v1/organizations/:orgId/assets',
  'PUT /v1/organizations/:orgId/assets/:assetId',
  'DELETE /v1/organizations/:orgId/payout-addresses/pending/:changeId',
  // Price coverage is an operational read.
  'GET /v1/prices/coverage',
  /**
   * The scheduler hook. Not part of anybody's integration — it is the deployment's own
   * plumbing, called by cron with a shared secret, and documenting it would be publishing
   * the existence of a credential that gates the webhook queue. See docs/DEPLOY.md.
   */
  'POST /internal/jobs',
]);

/** Everything below these prefixes is out of scope for a merchant-facing reference. */
const EXCLUDED_PREFIXES = ['/admin'];

function documentedRoutes(): Set<string> {
  const html = readFileSync(DOC, 'utf8');
  const found = new Set<string>();
  for (const match of html.matchAll(/data-route="([A-Z]+) ([^"]+)"/g)) {
    found.add(`${match[1]} ${match[2]}`);
  }
  return found;
}

/**
 * The server's route table.
 *
 * Read from `printRoutes` after `ready`, because `buildServer` registers everything
 * itself — an `onRoute` hook added afterwards sees nothing. HEAD is dropped: Fastify
 * adds it beside every GET, and documenting it would be noise.
 */
async function serverRoutes(): Promise<Set<string>> {
  const env = loadEnv({
    ...process.env,
    NODE_ENV: 'test',
    // Never connected to. Only the route table is read.
    DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
  });

  // Deep stubs: no handler runs, so nothing here needs to behave.
  const stub = new Proxy(
    {},
    { get: () => new Proxy(() => {}, { get: () => () => {} }) },
  ) as never;

  const app = buildServer({
    ledger: stub,
    env,
    db: stub,
    auth: stub,
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
  await app.ready();

  /**
   * `printRoutes` returns a tree whose nodes hold path *segments*, not full paths, so
   * the full path is the concatenation of a node's ancestors. Depth comes from the
   * indent, which is four characters per level.
   *
   * Reconstructing it is the only way to enumerate the table after `ready` — an
   * `onRoute` hook has to be installed before registration, and `buildServer` does its
   * own. `hasRoute` would answer one direction of this test but not the other.
   */
  const routes = new Set<string>();
  const stack: string[] = [];

  for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
    const match = line.match(/^([│ ]*)(?:├──|└──) (\S*)(?: \(([A-Z, ]+)\))?/);
    if (!match) continue;

    const depth = Math.floor(match[1]!.length / 4);
    const segment = match[2] ?? '';
    stack.length = depth;
    stack[depth] = segment;

    const path = stack.slice(0, depth + 1).join('') || '/';
    if (!match[3]) continue; // A branch node with no handler of its own.

    for (const method of match[3].split(',').map((entry) => entry.trim())) {
      // Fastify adds HEAD beside every GET; documenting it would be noise.
      if (method === 'HEAD') continue;
      routes.add(`${method} ${path}`);
    }
  }

  await app.close();
  return routes;
}

describe('the API reference matches the API', () => {
  test('every documented route exists', async () => {
    /**
     * The half that protects merchants. A documented route that does not exist is worse
     * than no documentation, because they will build against it and trust it.
     */
    const real = await serverRoutes();
    const missing = [...documentedRoutes()].filter((route) => !real.has(route));
    assert.deepEqual(
      missing,
      [],
      `documented but not served — either the path changed or it was never built:\n${missing.join('\n')}`,
    );
  });

  test('every merchant-facing route is documented or declared internal', async () => {
    /**
     * The half that protects the docs. A new route lands here as a failure until someone
     * decides whether merchants should know about it, which is the decision that
     * otherwise never gets made.
     */
    const documented = documentedRoutes();
    const undocumented = [...(await serverRoutes())]
      .filter((route) => {
        const path = route.slice(route.indexOf(' ') + 1);
        return !EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix));
      })
      .filter((route) => !documented.has(route) && !INTERNAL.has(route))
      .sort();

    assert.deepEqual(
      undocumented,
      [],
      `served but neither documented nor declared internal:\n${undocumented.join('\n')}`,
    );
  });

  test('the internal list contains no route that has been removed', async () => {
    // Otherwise the exemption list becomes a graveyard, and a path that comes back with
    // different behaviour stays silently exempt.
    const real = await serverRoutes();
    const stale = [...INTERNAL].filter((route) => !real.has(route)).sort();
    assert.deepEqual(stale, [], `listed as internal but no longer served:\n${stale.join('\n')}`);
  });

  test('the reference documents the four things the API is for', () => {
    /**
     * A coverage check rather than a diff: it is possible to document every route and
     * still leave a merchant unable to get started, because the hard parts are the
     * concepts. These four are the ones without which the endpoint list is unusable.
     */
    const html = readFileSync(DOC, 'utf8');
    for (const [topic, needle] of [
      ['authentication', 'Authorization: Bearer'],
      ['test versus live mode', 'ak_test_'],
      ['integer amounts', 'micro-dollars'],
      ['webhook verification', 'timingSafeEqual'],
    ] as const) {
      assert.ok(html.includes(needle), `the reference must explain ${topic}`);
    }
  });

  test('the reference never shows a secret that looks real', () => {
    /**
     * Copy-paste is how documentation is read. A plausible-looking key in an example is a
     * key someone will try, and one that matches our real format is a key that could
     * collide with a real one in a log search.
     */
    const html = readFileSync(DOC, 'utf8');
    // Our keys are `ak_(test|live)_` plus 32 base64url characters.
    assert.equal(
      html.match(/ak_(test|live)_[A-Za-z0-9_-]{20,}/g),
      null,
      'examples must elide the key body rather than print something key-shaped',
    );
  });
});

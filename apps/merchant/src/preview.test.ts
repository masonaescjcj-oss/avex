import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { matchPreview, previewRoutes } from './preview.js';

/**
 * The preview's router.
 *
 * Two things are worth pinning. A miss must be a miss rather than a wrong hit — a fixture
 * answering the wrong request would show a plausible page built from another endpoint's
 * data, which is worse than an error. And every route the dashboard actually calls has to
 * be covered, or the preview opens with half a page and nothing saying why.
 */

describe('the preview router', () => {
  const routes = previewRoutes();

  test('every request the dashboard makes is answered', () => {
    /**
     * Listed rather than derived, because deriving it from the page would mean parsing the
     * page — and the value here is that adding a call to the dashboard and forgetting the
     * fixture fails a test rather than showing a broken preview.
     */
    const calls: readonly [string, string][] = [
      ['GET', '/v1/auth/me'],
      ['GET', '/v1/organizations'],
      ['GET', '/v1/organizations/preview-org/commission'],
      ['GET', '/v1/organizations/preview-org/reports/volume'],
      ['GET', '/v1/organizations/preview-org/assets'],
      ['GET', '/v1/organizations/preview-org/payout-addresses'],
      ['GET', '/v1/organizations/preview-org/webhook-endpoints'],
      ['GET', '/v1/organizations/preview-org/webhook-deliveries?limit=25'],
      ['GET', '/v1/organizations/preview-org/api-keys'],
      ['GET', '/v1/organizations/preview-org/invoices?limit=50'],
      ['POST', '/v1/organizations/preview-org/checkouts'],
      ['POST', '/v1/auth/totp/enroll'],
      ['POST', '/v1/auth/totp/confirm'],
      ['POST', '/v1/auth/mfa'],
      ['POST', '/v1/auth/sessions/revoke-others'],
    ];

    for (const [method, path] of calls) {
      assert.ok(matchPreview(method, path, routes) !== null, `${method} ${path} is unanswered`);
    }
  });

  test('the enrolment fixture is a URI the page can draw', () => {
    /**
     * The preview's QR is drawn by the real encoder, which refuses anything over 134
     * bytes — so a fixture longer than that would show an empty frame and read as a
     * broken panel rather than as a fixture problem.
     */
    const route = matchPreview('POST', '/v1/auth/totp/enroll', routes);
    const body = route!.body as { secret: string; uri: string };
    assert.ok(body.uri.startsWith('otpauth://totp/'), body.uri);
    assert.ok(body.uri.includes(body.secret), 'the URI must carry the secret beside it');
    assert.ok(Buffer.byteLength(body.uri, 'utf8') <= 134, `${body.uri.length} bytes`);
  });

  test('a request nothing covers is a miss, not a wrong answer', () => {
    // A fixture answering the wrong request would render a plausible page from another
    // endpoint's data, which is harder to notice than an error.
    assert.equal(matchPreview('GET', '/v1/organizations/preview-org/settlements', routes), null);
    assert.equal(matchPreview('DELETE', '/v1/organizations/preview-org/api-keys/k1', routes), null);
  });

  test('the method is part of the match', () => {
    // `GET /checkouts` is not a route the dashboard has, and answering it with the POST
    // fixture would put a payment link on a page that never asked for one.
    assert.equal(matchPreview('GET', '/v1/organizations/preview-org/checkouts', routes), null);
    assert.ok(matchPreview('POST', '/v1/organizations/preview-org/checkouts', routes));
  });

  test('a longer path wins over a shorter one it ends with', () => {
    /**
     * `/webhook-endpoints` and `/endpoints` would both match a path ending in the former if
     * the first hit won. The fixtures here do not currently collide, and this is what keeps
     * that true as they are added to.
     */
    const colliding = new Map([
      ['GET /keys', { status: 200, body: 'short' }],
      ['GET /api-keys', { status: 200, body: 'long' }],
    ]);
    assert.equal(matchPreview('GET', '/v1/org/x/api-keys', colliding)?.body, 'long');
  });

  test('a query string does not stop a match', () => {
    // The dashboard asks for `/invoices?limit=50`; a fixture per limit would be a fixture
    // per caller.
    assert.ok(matchPreview('GET', '/v1/organizations/x/invoices?limit=50', routes));
    assert.ok(matchPreview('GET', '/v1/organizations/x/invoices?limit=200&status=paid', routes));
  });

  test('a write is refused rather than pretended', () => {
    /**
     * The one place a preview has to decide what a change does. Pretending it worked would
     * leave somebody believing they had reconfigured an account that does not exist.
     */
    const answer = matchPreview('POST', '/v1/organizations/x/commission/fee-payer', routes);
    assert.equal(answer?.status, 409);
    assert.match(JSON.stringify(answer?.body), /nothing here can be changed/);
  });

  test('the fixture merchant is half-configured, not finished', () => {
    /**
     * The setup checklist is a feature. A preview of a perfect account shows every step
     * ticked and teaches nobody what the panel is for — so this asserts the fixture still
     * has something missing: no webhook endpoint, and no live key.
     */
    const endpoints = matchPreview('GET', '/v1/organizations/x/webhook-endpoints', routes);
    assert.deepEqual((endpoints?.body as { endpoints: unknown[] }).endpoints, []);

    const keys = matchPreview('GET', '/v1/organizations/x/api-keys', routes);
    const modes = (keys?.body as { keys: { mode: string }[] }).keys.map((key) => key.mode);
    assert.ok(!modes.includes('live'), 'a live key would tick the last step of the checklist');
  });
});

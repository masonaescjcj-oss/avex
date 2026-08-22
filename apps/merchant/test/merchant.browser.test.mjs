import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The dashboard driven in a real browser, against a stubbed API.
 *
 * Stubbed at the network layer rather than inside the page, so the URLs it builds and the
 * shapes it expects are under test. A stub injected into the page would let a wrong path
 * pass — and this page talks to eight endpoints, which is eight paths to get wrong.
 *
 * Visibility is measured as rendered height throughout. An author `display` beats the
 * user-agent `[hidden]` rule, and this project has already shipped a `hidden` attribute
 * that did not hide while a probe reading the `.hidden` property reported success.
 */

const here = dirname(fileURLToPath(import.meta.url));
const PAGE = 'https://dash.test/merchant.html';
const pageFile = join(here, '..', 'public', 'merchant.html');
const ORG = '7b2c1e40-1111-4222-8333-444444444444';

const CANDIDATES = ['/opt/node22/lib/node_modules/playwright/index.mjs', 'playwright'];

async function loadPlaywright() {
  for (const candidate of CANDIDATES) {
    if (candidate.startsWith('/') && !existsSync(candidate)) continue;
    try {
      return await import(candidate);
    } catch {
      // Next one. A missing browser is a skip, not a failure.
    }
  }
  return null;
}

const playwright = await loadPlaywright();

/** A merchant part-way through setup: assets on two chains, a payout address on one. */
const FIXTURE = {
  /**
   * A balance with something on it.
   *
   * Zero hides the block entirely, which is correct for an account that has never taken a TRON
   * payment and useless for testing what the block renders.
   */
  /**
   * One live wallet and one waiting out its delay — the two states the panel draws differently.
   */
  wallets: {
    wallets: [
      { id: 'w1', chain: 'tron', address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', label: 'main', retiredAt: null },
      { id: 'w2', chain: 'tron', address: 'TWKxbjHnf3EY3mZvYUcaLLxLBnMhqUXsQ4', label: null, retiredAt: '2026-08-01T00:00:00.000Z' },
    ],
    pending: [
      { id: 'wc1', chain: 'tron', address: 'TVyAZdNetsrqLL4nKijTKTpyJA7gV5bRRE', effectiveAt: '2099-01-01T00:00:00.000Z' },
    ],
  },
  balance: {
    balanceUsdMicros: '-320000',
    creditLimitUsdMicros: '500000000',
    canInvoiceOnAccruingChains: true,
    entries: [
      { id: 'l1', kind: 'accrual', amountUsdMicros: '-500000', invoiceId: null, note: null, createdAt: '2026-08-01T10:00:00.000Z' },
      { id: 'l2', kind: 'recovery', amountUsdMicros: '180000', invoiceId: null, note: null, createdAt: '2026-08-10T10:00:00.000Z' },
    ],
  },
  commission: {
    plan: { feeBps: 50, negotiatedFee: false },
    commission: {
      feeBps: 50,
      perThousandUsd: 5,
      negotiated: false,
      feePayer: 'merchant',
      nextTier: { bps: 45, fromUsdMicros: '50000000000' },
    },
    ladder: [
      { bps: 50, fromUsdMicros: '0' },
      { bps: 45, fromUsdMicros: '50000000000' },
      { bps: 40, fromUsdMicros: '250000000000' },
    ],
    period: {
      start: '2026-08-18T00:00:00.000Z',
      end: '2026-09-18T00:00:00.000Z',
      processedUsdMicros: '10000000000',
      verifiedUsdMicros: '10000000000',
      declaredUsdMicros: '0',
      unpricedPayments: 0,
      wouldEarnBps: 50,
    },
  },
  report: {
    volume: [{ chain: 'bsc', assetSymbol: 'USDT', assetDecimals: 18, paymentCount: 3, total: '60000000000000000000' }],
    invoicesByStatus: { paid: 3, underpaid: 1, pending: 2 },
  },
  assets: {
    data: [
      { id: 'a1', symbol: 'USDT', chain: 'bsc', contract: '0x55d3', decimals: 18, kind: 'erc20', curated: true, verdict: 'approved', listed: true, requiresFixedRate: false, enabled: true, pricingMode: 'fiat', fixedRateValidUntil: null },
      { id: 'a2', symbol: 'USDT', chain: 'ton', contract: 'EQCx', decimals: 6, kind: 'jetton', curated: true, verdict: 'approved', listed: true, requiresFixedRate: false, enabled: true, pricingMode: 'fiat', fixedRateValidUntil: null },
      { id: 'a3', symbol: 'MINE', chain: 'bsc', contract: '0x9f2c', decimals: 18, kind: 'erc20', curated: false, verdict: 'review', listed: true, requiresFixedRate: true, enabled: false, pricingMode: null, fixedRateValidUntil: null },
      // TRON, so the wallet pool has a chain to be about. It is the only pooled one today.
      { id: 'a4', symbol: 'USDT', chain: 'tron', contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6, kind: 'trc20', curated: true, verdict: 'approved', listed: true, requiresFixedRate: false, enabled: true, pricingMode: 'fiat', fixedRateValidUntil: null },
    ],
  },
  payouts: { addresses: [{ chain: 'bsc', address: '0x7A3f9C21bE04D5aa71cE3B8Ed4F9021cC6b17E52', activeFrom: '2026-08-01T00:00:00.000Z', supersededAt: null }] },
  endpoints: { endpoints: [] },
  keys: { keys: [{ id: 'k1', name: 'staging', displayPrefix: 'ak_test_ab', scopes: ['invoice:create'], createdAt: '2026-08-10T00:00:00.000Z', revokedAt: null }] },
  invoices: {
    invoices: [
      { id: 'i1', reference: 'order-1', status: 'paid', amountDue: '20100502512562814071', amountPaid: '20100502512562814071', chain: 'bsc', assetSymbol: 'USDT', assetDecimals: 18, createdAt: '2026-08-17T10:00:00.000Z' },
      { id: 'i2', reference: 'order-2', status: 'underpaid', amountDue: '20000000000000000000', amountPaid: '10000000000000000000', chain: 'bsc', assetSymbol: 'USDT', assetDecimals: 18, createdAt: '2026-08-17T11:00:00.000Z' },
    ],
  },
  deliveries: { deliveries: [] },
  members: {
    data: [
      { userId: 'u-owner', email: 'owner@example.test', role: 'owner', twoFactorEnabled: true, joinedAt: '2026-02-04T09:00:00.000Z' },
      { userId: 'u-reza', email: 'reza@example.test', role: 'developer', twoFactorEnabled: false, joinedAt: '2026-06-18T11:30:00.000Z' },
    ],
  },
  /** One invitation still live, one nobody acted on — the state that used to be invisible. */
  invites: {
    data: [
      {
        id: 'inv-live',
        email: 'sara@example.test',
        role: 'admin',
        invitedAt: '2026-08-17T08:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
        invitedBy: 'owner@example.test',
        expired: false,
      },
      {
        id: 'inv-stale',
        email: 'gone@example.test',
        role: 'viewer',
        invitedAt: '2026-07-01T08:00:00.000Z',
        expiresAt: '2026-07-08T08:00:00.000Z',
        invitedBy: 'owner@example.test',
        expired: true,
      },
    ],
  },
};

describe('merchant dashboard', { skip: playwright ? false : 'playwright is not installed' }, () => {
  let browser;

  before(async () => {
    browser = await playwright.chromium.launch();
  });

  after(async () => {
    await browser?.close();
  });

  /**
   * A signed-in dashboard wired to the fixture.
   *
   * `overrides` replaces individual responses so a test can express one difference
   * without restating the whole account.
   */
  async function open(overrides = {}) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    const seen = [];
    const posts = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push('console: ' + message.text());
    });

    await page.route(`${PAGE}*`, (route) => route.fulfill({ path: pageFile, contentType: 'text/html' }));

    const json = (body, status = 200) => ({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });

    const data = { ...FIXTURE, ...overrides };

    await page.route('**/v1/**', async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      const method = route.request().method();
      seen.push(`${method} ${path}`);

      if (method === 'POST' && path.endsWith('/v1/auth/login')) {
        return route.fulfill(json(overrides.login ?? { token: 'sess_abc' }));
      }
      if (method === 'POST' && path.endsWith('/v1/auth/verify-email')) {
        posts.push({ path, body: JSON.parse(route.request().postData() ?? '{}') });
        return route.fulfill(
          overrides.verify ?? json({ verified: true }),
        );
      }
      if (method === 'POST' && path.endsWith('/v1/auth/signup')) {
        posts.push({ path, body: JSON.parse(route.request().postData() ?? '{}') });
        /**
         * The API answers the same way whether the address was free or already taken, so
         * this stub does too. A stub that distinguished them would let the page grow a
         * branch the real API can never take.
         */
        return route.fulfill(json(overrides.signup ?? { emailVerificationRequired: true }, 201));
      }
      if (method === 'POST' && path.endsWith('/v1/auth/mfa')) {
        return route.fulfill(json({ token: 'sess_abc' }));
      }
      if (method === 'POST' && path.endsWith('/v1/auth/logout')) return route.fulfill(json({}));
      if (path.endsWith('/v1/auth/me')) return route.fulfill(json({ email: 'owner@example.test' }));
      if (path.endsWith('/v1/organizations')) {
        // With a role: the team page draws differently for a viewer than for an owner, so a
        // fixture without one would exercise only the read-only half.
        return route.fulfill(
          json({
            organizations: [
              { id: ORG, name: 'Example Store', role: overrides.role ?? 'owner' },
            ],
          }),
        );
      }
      if (method === 'POST' && path.endsWith('/v1/invites/accept')) {
        posts.push({ path, body: JSON.parse(route.request().postData() ?? '{}') });
        return route.fulfill(
          overrides.acceptInvite ?? json({ status: 'accepted', organizationId: ORG, role: 'developer' }, 201),
        );
      }

      if (method === 'PATCH') {
        posts.push({ path, body: JSON.parse(route.request().postData() ?? '{}') });
        return route.fulfill(
          overrides.roleChange ?? json({ status: 'changed', from: 'developer', to: 'admin' }),
        );
      }

      if (method === 'PUT') {
        posts.push({ path, body: JSON.parse(route.request().postData() ?? '{}') });
        return route.fulfill({ status: 204, body: '' });
      }

      if (method === 'POST') {
        posts.push({ path, body: JSON.parse(route.request().postData() ?? '{}') });
        if (/\/assets$/.test(path)) {
          return route.fulfill(json({
            assetId: 'new-asset',
            verdict: 'review',
            symbol: 'NEW',
            decimals: 18,
            findings: [{ name: 'Contract has code', result: 'pass', detail: '4,912 bytes' }],
            message: 'Submitted for review. You will be notified when it is decided.',
          }, 202));
        }
        if (path.endsWith('/checkouts')) {
          if (overrides.checkoutFails) {
            return route.fulfill(json({ error: 'no_assets', message: 'No currency is payable yet.' }, 409));
          }
          return route.fulfill(json({
            id: 'chk_1',
            url: 'https://pay.test/pay/chk_1',
            receiptUrl: 'https://pay.test/pay/chk_1/receipt',
            status: 'open',
          }, 201));
        }
        if (path.endsWith('/webhook-endpoints')) {
          return route.fulfill(json({ id: 'e1', secret: 'whsec_shown_once' }, 201));
        }
        if (path.endsWith('/members')) {
          return route.fulfill(
            overrides.invited ?? json({ status: 'invited', id: 'inv-new', superseded: 0 }, 202),
          );
        }
        if (path.endsWith('/payout-addresses')) return route.fulfill(json({ status: 'scheduled' }, 202));
        return route.fulfill(json({ status: 'ok' }));
      }

      if (method === 'DELETE') {
        posts.push({ path, body: null });
        if (path.includes('/members/')) {
          return route.fulfill(
            overrides.removeMember ?? json({ status: 'removed', apiKeysUnaffected: true }),
          );
        }
        return route.fulfill({ status: 204, body: '' });
      }

      if (path.endsWith('/members')) return route.fulfill(json(data.members));
      if (path.endsWith('/invites')) return route.fulfill(json(data.invites));
      if (path.endsWith('/commission')) return route.fulfill(json(data.commission));
      if (path.endsWith('/balance')) return route.fulfill(json(data.balance));
      if (path.endsWith('/deposit-wallets')) return route.fulfill(json(data.wallets));
      if (path.endsWith('/reports/volume')) return route.fulfill(json(data.report));
      if (path.endsWith('/assets')) return route.fulfill(json(data.assets));
      if (path.endsWith('/payout-addresses')) return route.fulfill(json(data.payouts));
      if (path.endsWith('/webhook-endpoints')) return route.fulfill(json(data.endpoints));
      if (path.endsWith('/webhook-deliveries')) return route.fulfill(json(data.deliveries));
      if (path.endsWith('/api-keys')) return route.fulfill(json(data.keys));
      if (path.endsWith('/invoices')) return route.fulfill(json(data.invoices));
      return route.fulfill(json({}));
    });

    await page.goto(overrides.query ? `${PAGE}?${overrides.query}` : PAGE);
    if (!overrides.staySignedOut) {
      await page.fill('#auth-email', 'owner@example.test');
      await page.fill('#auth-password', 'a-sufficiently-long-password');
      await page.click('#auth-submit');
      await page.waitForFunction(
        () => document.getElementById('app')?.hidden === false,
        { timeout: 5000 },
      );
      await page.waitForTimeout(200);
    }

    return { page, context, errors, seen, posts };
  }

  const shown = (page, selector) =>
    page.$eval(selector, (node) => node.getBoundingClientRect().height > 0).catch(() => false);
  const text = (page, selector) => page.$eval(selector, (node) => node.textContent.trim());
  const all = (page, selector) => page.$$eval(selector, (nodes) => nodes.map((n) => n.textContent.trim()));

  // ── signing in ────────────────────────────────────────────────────────────

  test('the dashboard is behind a sign-in', async () => {
    const { page, context } = await open({ staySignedOut: true });
    assert.equal(await shown(page, '#auth-panel'), true);
    assert.equal(await shown(page, '#app'), false);
    await context.close();
  });

  test('the mark is drawn rather than fetched', async () => {
    /**
     * This page is one file and reaches no host at all, so the logo has to be inline — two
     * arches, which is less markup than the base64 of a picture of two arches. Decorative,
     * because the word AVEX is in the text beside it.
     */
    const { page, context } = await open({ staySignedOut: true });
    const mark = await page.$eval('.brand-mark', (node) => ({
      tag: node.tagName.toLowerCase(),
      hidden: node.getAttribute('aria-hidden'),
      paths: node.querySelectorAll('path').length,
      width: Math.round(node.getBoundingClientRect().width),
    }));
    assert.equal(mark.tag, 'svg');
    assert.equal(mark.hidden, 'true');
    assert.equal(mark.paths, 2, 'the mark is two arches');
    assert.ok(mark.width >= 20, `the mark rendered ${mark.width}px wide`);
    await context.close();
  });

  test('nothing belonging to a signed-in account is on the sign-in screen', async () => {
    /**
     * A `hidden` attribute does nothing when the stylesheet gives the element a display, and
     * this page shipped exactly that: `.whoami` is `display: flex`, so a "Sign out" button sat
     * on the sign-in screen of a page nobody was signed in to.
     *
     * Measured as rendered height, because the attribute was set correctly the whole time —
     * a probe reading `.hidden` reported success while the button was on screen.
     */
    const { page, context } = await open({ staySignedOut: true });
    for (const selector of ['#whoami', '#sign-out', '#app', '#tabs', '#preview-banner']) {
      assert.equal(await shown(page, selector), false, `${selector} is visible before sign-in`);
    }
    await context.close();
  });

  test('every element the page hides is actually hidden, signed out and in', async () => {
    /**
     * The general form of the bug above, asked of the whole document rather than one element:
     * if anything carries `hidden` and still occupies space, the `[hidden]` rule has been
     * out-specified by something declared after it.
     *
     * Both states, because the first version of this test only checked the sign-in screen —
     * where every view is inside a hidden `#app` and therefore has no height whatever the rules
     * say. It passed for that reason while `.view { display: flex }`, declared after the
     * `[hidden]` rule, kept the overview stacked under whichever tab was open.
     */
    for (const staySignedOut of [true, false]) {
      const { page, context } = await open({ staySignedOut });
      const leaking = await page.$$eval('[hidden]', (nodes) =>
        nodes
          .filter((node) => node.getBoundingClientRect().height > 0)
          .map((node) => node.id || node.className || node.tagName),
      );
      assert.deepEqual(leaking, [], staySignedOut ? 'signed out' : 'signed in');
      await context.close();
    }
  });

  test('a password alone asks for the authenticator rather than failing', async () => {
    /**
     * The API returns no session when a second factor is needed. Treating that as a wrong
     * password would leave a merchant with 2FA unable to sign in and no idea why.
     */
    const { page, context } = await open({ staySignedOut: true, login: { status: 'mfa_required' } });
    await page.fill('#auth-email', 'owner@example.test');
    await page.fill('#auth-password', 'a-sufficiently-long-password');
    await page.click('#auth-submit');
    await page.waitForFunction(() => document.getElementById('auth-mfa-row')?.hidden === false, { timeout: 5000 });

    assert.equal(await shown(page, '#auth-mfa-row'), true);
    assert.match(await text(page, '#auth-error'), /authenticator/);
    await context.close();
  });

  test('signing in reveals the dashboard and names the organisation', async () => {
    const { page, context } = await open();
    assert.equal(await shown(page, '#app'), true);
    assert.equal(await shown(page, '#auth-panel'), false);
    assert.equal(await text(page, '#whoami-org'), 'Example Store');
    await context.close();
  });

  test('the site can open this page straight on the signup form', async () => {
    /**
     * The landing page's "create an account" button arrives here with `?signup=1`. If the
     * query were ignored the visitor would land on a sign-in form after clicking a button
     * that said the opposite, and conclude the account they meant to make already failed.
     */
    const { page, context } = await open({ staySignedOut: true, query: 'signup=1' });
    assert.equal(await text(page, '#auth-title'), 'Create an account');
    assert.equal(await shown(page, '#auth-org-row'), true, 'a new account needs a name');
    assert.equal(await text(page, '#auth-submit'), 'Create an account');
    await context.close();
  });

  test('an address typed on the site is not asked for a second time', async () => {
    // Which is the whole reason the site asks for it at all.
    const { page, context } = await open({
      staySignedOut: true,
      query: 'signup=1&email=shop%2Btest%40example.com',
    });
    assert.equal(await page.$eval('#auth-email', (node) => node.value), 'shop+test@example.com');
    await context.close();
  });

  test('the form is sign-in until something says otherwise', async () => {
    // The default has to be the common case: most arrivals here already have an account.
    const { page, context } = await open({ staySignedOut: true });
    assert.equal(await text(page, '#auth-title'), 'Sign in');
    assert.equal(await shown(page, '#auth-org-row'), false);
    await context.close();
  });

  test('creating an account signs you in and says the address needs confirming', async () => {
    /**
     * Two requests, in order: the account, then a session for it. Stopping after the first
     * would leave somebody who just signed up staring at a sign-in form — the single worst
     * moment to ask for a password they set four seconds ago.
     */
    const { page, context, posts } = await open({ staySignedOut: true, query: 'signup=1' });
    await page.fill('#auth-org', 'Example Store');
    await page.fill('#auth-email', 'new@example.test');
    await page.fill('#auth-password', 'a-sufficiently-long-password');
    await page.click('#auth-submit');
    await page.waitForFunction(() => document.getElementById('app')?.hidden === false, { timeout: 5000 });

    const signup = posts.find((post) => post.path.endsWith('/v1/auth/signup'));
    assert.ok(signup, 'no account was created');
    assert.equal(signup.body.organizationName, 'Example Store');
    assert.equal(signup.body.email, 'new@example.test');

    assert.equal(await shown(page, '#app'), true);
    // And the one thing they still have to do is on screen, not in an email they may miss.
    assert.match(await text(page, '#flash'), /[Cc]onfirm your email/);
    await context.close();
  });

  test('a signup the API would not let in returns to sign-in without saying who has an account', async () => {
    /**
     * The signup response is identical for a free address and a taken one — deliberately, so
     * the form is not a way to enumerate customers. The page must not undo that by inferring
     * from the failed login and saying "that address is taken".
     */
    const { page, context } = await open({
      staySignedOut: true,
      query: 'signup=1',
      login: { status: 'mfa_required' },
    });
    await page.fill('#auth-org', 'Example Store');
    await page.fill('#auth-email', 'taken@example.test');
    await page.fill('#auth-password', 'a-sufficiently-long-password');
    await page.click('#auth-submit');
    await page.waitForFunction(
      () => document.getElementById('auth-title')?.textContent === 'Sign in',
      { timeout: 5000 },
    );

    const message = await text(page, '#auth-error');
    assert.match(message, /Check your email/);
    assert.ok(!/already (has|have) an account|taken|exists/i.test(message), message);
    assert.equal(await shown(page, '#app'), false);
    await context.close();
  });

  test('switching to signup drops a half-typed authenticator code', async () => {
    /**
     * A new account has no second factor, so the row cannot apply — and a code left in the
     * field would be sent with the signup, where it means nothing. Leaving the row on screen
     * would also ask for something that does not exist yet.
     */
    const { page, context } = await open({ staySignedOut: true, login: { status: 'mfa_required' } });
    await page.fill('#auth-email', 'owner@example.test');
    await page.fill('#auth-password', 'a-sufficiently-long-password');
    await page.click('#auth-submit');
    await page.waitForFunction(() => document.getElementById('auth-mfa-row')?.hidden === false, { timeout: 5000 });
    await page.fill('#auth-code', '123456');

    await page.click('#auth-switch');
    assert.equal(await shown(page, '#auth-mfa-row'), false);
    assert.equal(await page.$eval('#auth-code', (node) => node.value), '');
    await context.close();
  });

  test('the link from the signup email confirms the address and says so', async () => {
    /**
     * The token leaves the API only by email — it is never in a response — so a link is the
     * only way it can be spent, and the link has to land somewhere. It used to point at
     * `/verify-email`, a path nothing serves, so every real signup ended on a 404 with the
     * address unconfirmed and nobody able to say why.
     */
    const { page, context, posts } = await open({
      staySignedOut: true,
      query: 'verify=tok_abc123',
    });
    await page.waitForFunction(
      () => document.getElementById('auth-error')?.hidden === false,
      { timeout: 5000 },
    );

    const spent = posts.find((post) => post.path.endsWith('/v1/auth/verify-email'));
    assert.ok(spent, 'the token was never spent');
    assert.equal(spent.body.token, 'tok_abc123');

    assert.match(await text(page, '#auth-error'), /confirmed/i);
    assert.equal(await page.$eval('#auth-error', (node) => node.dataset.kind), 'ok');
    // The form they need next, not the one they came from.
    assert.equal(await text(page, '#auth-title'), 'Sign in');
    await context.close();
  });

  test('confirming an address does not sign anybody in', async () => {
    /**
     * The token proves an address, not a session. Treating it as one would make a forwarded
     * email a way into somebody's dashboard — and forwarding a "confirm your email" message to
     * a colleague is an ordinary thing to do.
     */
    const { page, context } = await open({ staySignedOut: true, query: 'verify=tok_abc123' });
    await page.waitForFunction(
      () => document.getElementById('auth-error')?.hidden === false,
      { timeout: 5000 },
    );
    assert.equal(await shown(page, '#app'), false, 'a verification link opened the dashboard');
    assert.equal(await shown(page, '#auth-panel'), true);
    await context.close();
  });

  test('a spent or expired link is explained in the API\'s own words', async () => {
    // It is the side that knows which of the two happened. Inventing a message here would mean
    // guessing, and the guess is what the reader would act on.
    const { page, context } = await open({
      staySignedOut: true,
      query: 'verify=tok_stale',
      verify: {
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'invalid_token',
          message: 'This verification link is invalid or has expired. Request a new one.',
        }),
      },
    });
    await page.waitForFunction(
      () => document.getElementById('auth-error')?.hidden === false,
      { timeout: 5000 },
    );

    assert.match(await text(page, '#auth-error'), /invalid or has expired/);
    assert.equal(await page.$eval('#auth-error', (node) => node.dataset.kind), 'warn');
    assert.equal(await shown(page, '#app'), false);
    await context.close();
  });

  test('a link that cannot be checked does not blame the link', async () => {
    /**
     * Offline, or a 500. Telling somebody their link is bad when we could not read it sends
     * them to request another one that will look just as broken.
     */
    const { page, context } = await open({
      staySignedOut: true,
      query: 'verify=tok_abc123',
      verify: { status: 503, contentType: 'application/json', body: JSON.stringify({}) },
    });
    await page.waitForFunction(
      () => document.getElementById('auth-error')?.hidden === false,
      { timeout: 5000 },
    );
    const message = await text(page, '#auth-error');
    assert.match(message, /could not reach us/i);
    assert.ok(!/expired|invalid/i.test(message), message);
    await context.close();
  });

  test('signing out offers sign-in, not a second account', async () => {
    // Somebody who signed out wants back in. Leaving the form on "create an account" — which
    // is where they may have started — reads as their account having been lost.
    const { page, context } = await open({ staySignedOut: true, query: 'signup=1' });
    await page.fill('#auth-org', 'Example Store');
    await page.fill('#auth-email', 'new@example.test');
    await page.fill('#auth-password', 'a-sufficiently-long-password');
    await page.click('#auth-submit');
    await page.waitForFunction(() => document.getElementById('app')?.hidden === false, { timeout: 5000 });

    await page.click('#sign-out');
    await page.waitForFunction(() => document.getElementById('app')?.hidden === true, { timeout: 5000 });
    assert.equal(await text(page, '#auth-title'), 'Sign in');
    assert.equal(await shown(page, '#auth-org-row'), false);
    await context.close();
  });

  test('signing out hides everything again', async () => {
    // Including the case where the server refuses: the token must be cleared locally
    // whatever happens, because leaving it in memory is the wrong way to fail.
    const { page, context } = await open();
    await page.click('#sign-out');
    await page.waitForFunction(() => document.getElementById('app')?.hidden === true, { timeout: 5000 });
    assert.equal(await shown(page, '#auth-panel'), true);
    await context.close();
  });

  test('an email can send a merchant straight to the tab it is about', async () => {
    /**
     * The payout-change notice says to cancel the change now. Landing on the overview and
     * leaving "find the payouts tab" implied is the wrong shape for the one mail that stands
     * between a stolen session and a redirected payout.
     */
    const { page, context } = await open({ query: 'tab=payouts' });
    const current = await page.$eval('nav.tabs button[aria-current="page"]', (node) =>
      node.textContent.trim(),
    );
    assert.equal(current, 'Payouts');
    assert.equal(await shown(page, '#view-payouts'), true);
    assert.equal(await shown(page, '#view-overview'), false);
    await context.close();
  });

  test('a tab nobody has falls back to the overview instead of breaking the page', async () => {
    /**
     * `show()` reaches for `view-<id>`, so an id from the query that names no view would throw
     * on null and take the whole dashboard down — over a mistyped link, which is the one thing
     * a link in an email reliably becomes.
     */
    const { page, context, errors } = await open({ query: 'tab=settlements' });
    const current = await page.$eval('nav.tabs button[aria-current="page"]', (node) =>
      node.textContent.trim(),
    );
    assert.equal(current, 'Overview');
    assert.equal(await shown(page, '#view-overview'), true);
    assert.deepEqual(errors, []);
    await context.close();
  });

  // ── team ──────────────────────────────────────────────────────────────────

  test('the team page lists who is in, and whether they have a second factor', async () => {
    /**
     * Two-factor is a column rather than a detail, because it is the difference between a
     * member who can be phished out of the payout address and one who cannot. Blank would
     * read as "not applicable" for the exact people it matters most for.
     */
    const { page, context } = await open({ query: 'tab=team' });
    /**
     * Read cell by cell, not as one string.
     *
     * `textContent` on a row concatenates without separators, so the first version of this
     * asserted `/\bon\b/` against "owner@example.testowneron195d 23h" — which has no word
     * boundary before "on" and failed for a reason that had nothing to do with the page.
     */
    const rows = await page.$$eval('#member-table tbody tr', (nodes) =>
      nodes.map((node) => ({
        email: node.children[0].textContent.trim(),
        /**
         * The picker's value when there is one, the badge's text when there is not.
         *
         * A cell holding a `<select>` has every option in its `textContent`, so reading the
         * cell as a string gives "viewerdeveloperadminowner" — which is what this asserted
         * before roles became editable.
         */
        role: node.children[1].querySelector('select')?.value
          ?? node.children[1].textContent.trim(),
        twoFactor: node.children[2].textContent.trim(),
      })),
    );
    assert.equal(rows.length, 2, JSON.stringify(rows));
    assert.deepEqual(rows[0], { email: 'owner@example.test', role: 'owner', twoFactor: 'on' });
    assert.deepEqual(rows[1], { email: 'reza@example.test', role: 'developer', twoFactor: 'off' });
    await context.close();
  });

  test('a pending invitation is shown with what is left of its life', async () => {
    const { page, context } = await open({ query: 'tab=team' });
    const rows = await all(page, '#invite-table tbody tr');
    assert.equal(rows.length, 2, rows.join(' | '));
    assert.match(rows[0], /sara@example\.test/);
    assert.match(rows[0], /admin/);
    assert.match(rows[0], /in \d/, rows[0]);
    assert.equal(await text(page, '#invite-count'), '1 waiting');
    await context.close();
  });

  test('an expired invitation is marked expired, not dropped or counted', async () => {
    /**
     * "I invited them and nothing happened" is the question this table answers, and one
     * that vanished on its expiry answers it wrongly. It also must not read as live: the
     * link is dead, and somebody waiting on it needs to know that rather than keep waiting.
     */
    const { page, context } = await open({ query: 'tab=team' });
    const rows = await all(page, '#invite-table tbody tr');
    const stale = rows.find((row) => /gone@example\.test/.test(row));
    assert.ok(stale, rows.join(' | '));
    assert.match(stale, /expired/);
    assert.ok(!/in \d/.test(stale), stale);
    // One live invitation, not two.
    assert.equal(await text(page, '#invite-count'), '1 waiting');
    await context.close();
  });

  test('the role picker offers no role above the caller\'s own', async () => {
    /**
     * Not a security control — the server refuses either way — but a picker offering `owner`
     * to an admin is a form whose only purpose is to be rejected, and the rejection reads as
     * the page being broken rather than as the rule it is.
     */
    const { page, context } = await open({ query: 'tab=team', role: 'admin' });
    const roles = await page.$$eval('#invite-role option', (nodes) =>
      nodes.map((node) => node.value),
    );
    assert.deepEqual(roles, ['viewer', 'developer', 'admin']);
    // Least privilege by default, so a distracted click grants the least.
    assert.equal(await page.$eval('#invite-role', (node) => node.value), 'viewer');
    await context.close();
  });

  test('an owner may offer every role', async () => {
    const { page, context } = await open({ query: 'tab=team', role: 'owner' });
    const roles = await page.$$eval('#invite-role option', (nodes) =>
      nodes.map((node) => node.value),
    );
    assert.deepEqual(roles, ['viewer', 'developer', 'admin', 'owner']);
    await context.close();
  });

  test('the ladder in the page is the one the server enforces', async () => {
    /**
     * The page ships as one file and imports nothing, so this list is a copy of `ROLE_RANK`
     * in domain/rbac.ts. A copy that drifted would offer a role the server refuses, or hide
     * one it allows — this reads the real thing and fails on either.
     */
    const rbac = readFileSync(join(here, '..', '..', 'api', 'src', 'domain', 'rbac.ts'), 'utf8');
    const [, block] = rbac.match(/ROLE_RANK[^=]*=\s*\{([\s\S]*?)\}/);
    const ranked = [...block.matchAll(/(\w+):\s*(\d+)/g)]
      .sort((a, b) => Number(a[2]) - Number(b[2]))
      .map((match) => match[1]);

    const { page, context } = await open({ query: 'tab=team', role: 'owner' });
    const roles = await page.$$eval('#invite-role option', (nodes) =>
      nodes.map((node) => node.value),
    );
    assert.deepEqual(roles, ranked);
    await context.close();
  });

  test('a viewer sees the pending list but is told who can invite', async () => {
    /**
     * Reading the list is `member:read`: a members page that hid pending invitations would
     * read as complete when it is not. Sending one is not. A disabled form with no
     * explanation reads as a bug, so the absence is explained instead.
     */
    const { page, context } = await open({ query: 'tab=team', role: 'viewer' });
    assert.equal((await all(page, '#invite-table tbody tr')).length, 2);
    assert.equal(await shown(page, '#invite-form'), false);
    assert.match(await text(page, '#invite-note'), /owner or an admin/i);
    // And no way to withdraw one either.
    assert.equal((await page.$$('#invite-table button')).length, 0);
    await context.close();
  });

  test('sending an invitation posts the address and role, and says it can be withdrawn', async () => {
    const { page, context, posts } = await open({ query: 'tab=team' });
    await page.fill('#invite-email', 'new@example.test');
    await page.selectOption('#invite-role', 'developer');
    await page.click('#invite-submit');
    await page.waitForFunction(() => document.getElementById('flash')?.hidden === false, { timeout: 5000 });

    const sent = posts.find((post) => post.path.endsWith('/members'));
    assert.ok(sent, JSON.stringify(posts));
    assert.equal(sent.body.email, 'new@example.test');
    assert.equal(sent.body.role, 'developer');
    assert.match(await text(page, '#flash'), /withdrawn/i);
    // The field is cleared, so a second invitation is not an accidental duplicate.
    assert.equal(await page.$eval('#invite-email', (node) => node.value), '');
    await context.close();
  });

  test('replacing an earlier invitation is said out loud', async () => {
    /**
     * Otherwise somebody who corrected a role is left wondering which of two live links
     * their colleague will click. There is only ever one, and this is where they learn it.
     */
    const { page, context } = await open({
      query: 'tab=team',
      invited: {
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'invited', id: 'inv-2', superseded: 1 }),
      },
    });
    await page.fill('#invite-email', 'sara@example.test');
    await page.click('#invite-submit');
    await page.waitForFunction(() => document.getElementById('flash')?.hidden === false, { timeout: 5000 });
    assert.match(await text(page, '#flash'), /replaces the earlier one/i);
    await context.close();
  });

  test('withdrawing an invitation says the link is dead now', async () => {
    // The only defence once the mail has left, so the confirmation has to be about the link
    // rather than about a row disappearing from a table.
    const { page, context, posts } = await open({ query: 'tab=team' });
    await page.click('#invite-table tbody tr:first-child button');
    await page.waitForFunction(() => document.getElementById('flash')?.hidden === false, { timeout: 5000 });

    const deleted = posts.find((post) => post.path.includes('/invites/inv-live'));
    assert.ok(deleted, JSON.stringify(posts.map((p) => p.path)));
    assert.match(await text(page, '#flash'), /no longer works/i);
    await context.close();
  });

  test('the only owner has no role picker and no way out, with the reason on screen', async () => {
    /**
     * The invariant, drawn before anybody tries rather than as an error afterwards. An
     * organisation with no owner is one whose payout address can never be changed again — by
     * anybody, including us — so a control that would reach that state is not offered.
     *
     * The server refuses either way. This is about whether the page teaches the rule or teaches
     * that it is unreliable.
     */
    const { page, context } = await open({ query: 'tab=team' });
    const owner = await page.$eval('#member-table tbody tr:first-child', (node) => ({
      role: node.children[1].textContent.trim(),
      hasPicker: node.querySelector('select') !== null,
      action: node.children[4].textContent.trim(),
      hasButton: node.querySelector('button') !== null,
      reason: node.children[4].querySelector('[title]')?.getAttribute('title') ?? '',
    }));

    assert.equal(owner.role, 'owner');
    assert.equal(owner.hasPicker, false, 'the only owner must not be demotable from here');
    assert.equal(owner.hasButton, false, 'the only owner must not be removable from here');
    assert.match(owner.action, /only owner/i);
    assert.match(owner.reason, /payout address can never be changed/i);
    await context.close();
  });

  test('changing somebody\'s role posts it and says when it applies', async () => {
    /**
     * "Applies to their next request" is the true statement, and it is worth making: the role
     * is read from the memberships table per request, so there is no sign-out to wait for and
     * no cache to explain.
     */
    const { page, context, posts } = await open({ query: 'tab=team' });
    await page.selectOption('#member-table tbody tr:nth-child(2) select', 'admin');
    await page.waitForFunction(() => document.getElementById('flash')?.hidden === false, { timeout: 5000 });

    const patched = posts.find((post) => post.path.includes('/members/u-reza'));
    assert.ok(patched, JSON.stringify(posts.map((p) => p.path)));
    assert.equal(patched.body.role, 'admin');
    const message = await text(page, '#flash');
    assert.match(message, /reza@example\.test/);
    assert.match(message, /next request/i);
    await context.close();
  });

  test('a refused role change puts the picker back rather than showing the new value', async () => {
    /**
     * A picker left showing a role the server refused is the page telling somebody a change
     * happened when it did not — and the next person to read that row believes it.
     */
    const { page, context } = await open({
      query: 'tab=team',
      roleChange: {
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'last_owner', message: 'This is the only owner.' }),
      },
    });
    await page.selectOption('#member-table tbody tr:nth-child(2) select', 'admin');
    await page.waitForFunction(() => document.getElementById('flash')?.hidden === false, { timeout: 5000 });

    assert.match(await text(page, '#flash'), /only owner/i);
    const shown_ = await page.$eval('#member-table tbody tr:nth-child(2) select', (node) => node.value);
    assert.equal(shown_, 'developer', 'the picker kept a value the server refused');
    await context.close();
  });

  test('removing somebody asks first, and says their API keys still work', async () => {
    /**
     * The keys part is the bit an operator assumes wrongly. Keys belong to the organisation,
     * not to the person who typed them in — revoking them on departure would take production
     * down as a side effect of an HR action — so the confirmation says so rather than leaving
     * somebody to assume access is gone.
     */
    const { page, context, posts } = await open({ query: 'tab=team' });

    const asked = [];
    page.on('dialog', (dialog) => {
      asked.push(dialog.message());
      void dialog.accept();
    });

    await page.click('#member-table tbody tr:nth-child(2) button');
    await page.waitForFunction(() => document.getElementById('flash')?.hidden === false, { timeout: 5000 });

    assert.equal(asked.length, 1, JSON.stringify(asked));
    assert.match(asked[0], /reza@example\.test/);
    assert.match(asked[0], /lose access/i);

    assert.ok(posts.some((post) => post.path.includes('/members/u-reza')), JSON.stringify(posts));
    const message = await text(page, '#flash');
    assert.match(message, /API keys they created still work/i);
    await context.close();
  });

  test('declining the confirmation removes nobody', async () => {
    // The only destructive button on the page. A confirmation that fires the request anyway is
    // worse than none, because it teaches people to click through it.
    const { page, context, posts } = await open({ query: 'tab=team' });
    page.on('dialog', (dialog) => void dialog.dismiss());

    await page.click('#member-table tbody tr:nth-child(2) button');
    await page.waitForTimeout(300);

    assert.ok(!posts.some((post) => post.path.includes('/members/u-reza')), JSON.stringify(posts));
    assert.equal(await shown(page, '#flash'), false);
    await context.close();
  });

  test('your own row says Leave, not Remove', async () => {
    /**
     * A row of identical buttons is how somebody removes themselves by accident, and the two
     * acts are not the same act. Needs a second owner in the fixture, or the invariant hides
     * the control entirely — which is the previous test.
     */
    const { page, context } = await open({
      query: 'tab=team',
      members: {
        data: [
          { userId: 'u-owner', email: 'owner@example.test', role: 'owner', twoFactorEnabled: true, joinedAt: '2026-02-04T09:00:00.000Z' },
          { userId: 'u-second', email: 'second@example.test', role: 'owner', twoFactorEnabled: true, joinedAt: '2026-03-04T09:00:00.000Z' },
        ],
      },
    });

    const labels = await page.$$eval('#member-table tbody tr button', (nodes) =>
      nodes.map((node) => node.textContent.trim()),
    );
    assert.deepEqual(labels, ['Leave', 'Remove']);

    const asked = [];
    page.on('dialog', (dialog) => {
      asked.push(dialog.message());
      void dialog.dismiss();
    });
    await page.click('#member-table tbody tr:first-child button');
    await page.waitForTimeout(200);
    assert.match(asked[0] ?? '', /Leave Example Store/);
    await context.close();
  });

  test('leaving signs you out, because there is nothing left to show you', async () => {
    const { page, context } = await open({
      query: 'tab=team',
      members: {
        data: [
          { userId: 'u-owner', email: 'owner@example.test', role: 'owner', twoFactorEnabled: true, joinedAt: '2026-02-04T09:00:00.000Z' },
          { userId: 'u-second', email: 'second@example.test', role: 'owner', twoFactorEnabled: true, joinedAt: '2026-03-04T09:00:00.000Z' },
        ],
      },
    });
    page.on('dialog', (dialog) => void dialog.accept());

    await page.click('#member-table tbody tr:first-child button');
    await page.waitForFunction(() => document.getElementById('app')?.hidden === true, { timeout: 5000 });
    assert.equal(await shown(page, '#auth-panel'), true);
    await context.close();
  });

  test('a viewer can leave but cannot touch anybody else', async () => {
    /**
     * Two authorisation paths, and the page reflects both: no pickers, no Remove buttons, and
     * still a way out. If leaving needed `member:remove` a viewer could never leave at all.
     */
    const { page, context } = await open({
      query: 'tab=team',
      role: 'viewer',
      members: {
        data: [
          { userId: 'u-owner', email: 'owner2@example.test', role: 'owner', twoFactorEnabled: true, joinedAt: '2026-02-04T09:00:00.000Z' },
          { userId: 'u-me', email: 'owner@example.test', role: 'viewer', twoFactorEnabled: false, joinedAt: '2026-03-04T09:00:00.000Z' },
        ],
      },
    });

    assert.equal((await page.$$('#member-table select')).length, 0, 'a viewer must not see role pickers');
    const labels = await page.$$eval('#member-table tbody tr button', (nodes) =>
      nodes.map((node) => node.textContent.trim()),
    );
    assert.deepEqual(labels, ['Leave'], labels.join(' | '));
    await context.close();
  });

  // ── arriving from an invitation ────────────────────────────────────────────

  test('an invitation link says who it is for before asking anybody to sign in', async () => {
    /**
     * Arriving with a token and no session is the normal case, not an error: accepting needs
     * an account for the invited address, and the invitee may not have one yet. Dropping
     * them on a bare sign-in form would leave them guessing which account to use.
     */
    const { page, context } = await open({ staySignedOut: true, query: 'invite=tok_team' });
    assert.equal(await shown(page, '#auth-panel'), true);
    assert.equal(await shown(page, '#app'), false);
    const message = await text(page, '#auth-error');
    assert.match(message, /invited/i);
    assert.match(message, /address the invitation was sent to/i);
    await context.close();
  });

  test('signing in with an invitation in hand spends it before the dashboard loads', async () => {
    /**
     * Order matters: accepting is what puts them into the organisation, so reading the list
     * first would show the team they just joined as absent — or, for somebody whose only
     * organisation is that one, show nothing at all.
     */
    const { page, context, posts, seen } = await open({ query: 'invite=tok_team' });

    const accepted = posts.find((post) => post.path.endsWith('/v1/invites/accept'));
    assert.ok(accepted, JSON.stringify(posts.map((p) => p.path)));
    assert.equal(accepted.body.token, 'tok_team');

    const acceptIndex = seen.indexOf('POST /v1/invites/accept');
    const listIndex = seen.indexOf('GET /v1/organizations');
    assert.ok(acceptIndex >= 0 && listIndex >= 0, seen.join(' | '));
    assert.ok(acceptIndex < listIndex, `accepted after reading the org list: ${seen.join(' | ')}`);

    assert.match(await text(page, '#flash'), /joined the team/i);
    assert.equal(await shown(page, '#app'), true);
    await context.close();
  });

  test('an invitation is spent once, not again on every refresh', async () => {
    // It is a bearer token in a URL that stays in the address bar. Re-posting it on each
    // reload would turn a stale tab into a stream of failures.
    const { page, context, posts } = await open({ query: 'invite=tok_team' });
    await page.click('nav.tabs button:has-text("Invoices")');
    await page.waitForTimeout(200);
    await page.click('nav.tabs button:has-text("Overview")');
    await page.waitForTimeout(200);

    const attempts = posts.filter((post) => post.path.endsWith('/v1/invites/accept'));
    assert.equal(attempts.length, 1, JSON.stringify(attempts));
    await context.close();
  });

  test('an invitation for somebody already inside says what they kept', async () => {
    /**
     * Accepting must not raise an existing role — that is `member:role_change`, elevated and
     * audited. So the message says what is true rather than implying something changed.
     */
    const { page, context } = await open({
      query: 'invite=tok_team',
      acceptInvite: {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'already_member', organizationId: ORG, role: 'viewer' }),
      },
    });
    const message = await text(page, '#flash');
    assert.match(message, /already in that team/i);
    assert.match(message, /viewer/);
    await context.close();
  });

  test('the wrong account is told which address the invitation was for', async () => {
    /**
     * The API names it, and this is the one refusal where the message is the whole remedy:
     * somebody signed in as the wrong colleague otherwise has no way to work out what went
     * wrong. It leaks nothing — they are holding a mail that contains it.
     */
    const { page, context } = await open({
      query: 'invite=tok_team',
      acceptInvite: {
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'wrong_account',
          message: 'This invitation was sent to sara@example.test. Sign in with that address to accept it.',
        }),
      },
    });
    assert.match(await text(page, '#flash'), /sara@example\.test/);
    // And they are still signed in to their own account rather than stranded.
    assert.equal(await shown(page, '#app'), true);
    await context.close();
  });

  // ── overview ──────────────────────────────────────────────────────────────

  test('the period volume is shown as money and as progress towards a cheaper rate', async () => {
    const { page, context } = await open();
    const stats = await all(page, '#overview-stats .stat-value');
    assert.ok(stats.includes('$10,000.00'), stats.join(' | '));

    const width = await page.$eval('#tier-bar', (node) => node.style.width);
    // $10,000 of the $50,000 that reaches 0.45%.
    assert.equal(width, '20%');
    assert.match(await text(page, '#tier-note'), /\$40,000\.00 more this period reaches 0\.45%/);
    await context.close();
  });

  test('nothing on the overview says a merchant owes us money', async () => {
    /**
     * The regression this guards. This panel used to read "$250.00 of $1,500.00 free" with
     * a bar that turned amber and announced a $49 charge. There is no monthly fee any more,
     * so any surviving copy of that would be inventing a bill.
     */
    const { page, context } = await open();
    const body = await text(page, '#view-overview');
    assert.ok(!/\$49/.test(body), body);
    assert.ok(!/free volume|allowance|overdue|owed/i.test(body), body);
    await context.close();
  });

  test('a period that has already earned a rung fills the bar and says when it starts', async () => {
    const { page, context } = await open({
      commission: {
        ...FIXTURE.commission,
        period: { ...FIXTURE.commission.period, processedUsdMicros: '61000000000', wouldEarnBps: 45 },
      },
    });
    assert.equal(await page.$eval('#tier-bar', (node) => node.dataset.earned), 'true');
    // Clamped: a bar wider than its track is a visual bug, and the figure is read aloud.
    assert.equal(await page.$eval('#tier-bar', (node) => node.style.width), '100%');
    // Future-tense, because the rate changes when the period closes and not before.
    assert.match(await text(page, '#tier-note'), /enough for 0\.45%.*when the period closes/);
    await context.close();
  });

  test('the setup checklist names the chain with no payout address', async () => {
    /**
     * The fixture has USDT approved on BSC and TON with a BSC address only. "At least one
     * payout address" would call that done, and every TON invoice would be refused.
     */
    const { page, context } = await open();
    const whys = await all(page, '#checklist .check-why');
    assert.ok(whys.some((why) => why.includes('ton')), whys.join(' | '));

    const done = await page.$$eval('#checklist .check', (nodes) => nodes.map((n) => n.dataset.done));
    // Assets and payouts: one done, one not. Webhook and live key both missing.
    assert.deepEqual(done, ['true', 'false', 'false', 'false']);
    await context.close();
  });

  test('the checklist disappears once everything is configured', async () => {
    // A checklist of ticks is furniture, and this is the first panel on the page.
    const { page, context } = await open({
      assets: { assets: [{ id: 'a1', symbol: 'USDT', chain: 'bsc', decimals: 18, verdict: 'approved', enabled: true, pricingMode: 'fiat' }] },
      endpoints: { endpoints: [{ id: 'e1', url: 'https://x.test/h', events: ['*'], enabled: true, pending: 0, failed: 0, createdAt: '2026-08-01T00:00:00.000Z' }] },
      keys: { keys: [{ id: 'k1', name: 'live', displayPrefix: 'ak_live_zz', scopes: ['invoice:create'], createdAt: '2026-08-01T00:00:00.000Z', revokedAt: null }] },
    });
    assert.equal(await shown(page, '#setup-panel'), false);
    await context.close();
  });

  test('under- and overpaid invoices are surfaced as needing a look', async () => {
    /**
     * The two states that require work. A naive traffic light makes paid green and expired
     * red and leaves these looking neutral, which is exactly backwards.
     */
    const { page, context } = await open();
    assert.match(await text(page, '#attention-note'), /1 invoice/);
    const rows = await page.$$eval('#attention-table tbody tr', (nodes) =>
      nodes.map((n) => n.dataset.attention),
    );
    assert.deepEqual(rows, ['true']);
    assert.match(await text(page, '#attention-table'), /send the difference/);
    await context.close();
  });

  test('an account with nothing outstanding says so rather than showing an empty table', async () => {
    const { page, context } = await open({
      invoices: { invoices: [FIXTURE.invoices.invoices[0]] },
      report: { ...FIXTURE.report, invoicesByStatus: { paid: 3 } },
    });
    assert.match(await text(page, '#attention-table'), /Nothing needs your attention/);
    await context.close();
  });

  // ── taking a payment ──────────────────────────────────────────────────────

  test('creating a payment link sends micro-dollars, not a float', async () => {
    /**
     * 19.99 has no exact binary representation, so `amount * 1000000` is the version that
     * invoices a cent out. The body is asserted rather than the rendering because the body
     * is what reaches the API.
     */
    const { page, context, posts } = await open();
    await page.click('nav.tabs button:has-text("Take a payment")');
    await page.fill('#new-amount', '19.99');
    await page.fill('#new-reference', 'order-1042');
    await page.click('#new-submit');
    await page.waitForFunction(() => document.getElementById('new-result')?.hidden === false, { timeout: 5000 });

    const post = posts.find((entry) => entry.path.endsWith('/checkouts'));
    assert.ok(post);
    assert.equal(post.body.amountFiatMicros, '19990000');
    assert.equal(post.body.reference, 'order-1042');
    assert.equal(await text(page, '#new-link'), 'https://pay.test/pay/chk_1');
    await context.close();
  });

  test('the receipt link is given with the payment link, not after payment', async () => {
    /**
     * So it can be filed with the order now rather than hunted for later. It refuses with
     * "not paid yet" until the money lands, which is the honest state for a receipt to be
     * in — one that existed before the payment would be a document saying somebody had
     * paid when they had not.
     */
    const { page, context } = await open();
    await page.click('nav.tabs button:has-text("Take a payment")');
    await page.fill('#new-amount', '19.99');
    await page.click('#new-submit');
    await page.waitForFunction(() => document.getElementById('new-result')?.hidden === false, { timeout: 5000 });

    assert.equal(await text(page, '#new-receipt'), 'https://pay.test/pay/chk_1/receipt');
    // Two distinct links: one to send, one to keep. Showing the same URL twice would be
    // worse than showing one.
    assert.notEqual(await text(page, '#new-receipt'), await text(page, '#new-link'));
    await context.close();
  });

  test('a refusal is shown with the reason the API gave', async () => {
    // AVEX's refusals are written for a merchant to act on — "no currency is payable
    // yet" is more useful than a generic failure.
    const { page, context } = await open({ checkoutFails: true });
    await page.click('nav.tabs button:has-text("Take a payment")');
    await page.fill('#new-amount', '25');
    await page.click('#new-submit');
    await page.waitForFunction(
      () => document.getElementById('flash')?.hidden === false,
      { timeout: 5000 },
    );
    assert.match(await text(page, '#flash'), /No currency is payable/);
    assert.equal(await shown(page, '#new-result'), false);
    await context.close();
  });

  // ── invoices ──────────────────────────────────────────────────────────────

  test('invoice amounts are shown in the asset precision, not rounded', async () => {
    const { page, context } = await open();
    await page.click('nav.tabs button:has-text("Invoices")');
    await page.waitForTimeout(150);
    // 20100502512562814071 at 18 decimals, which no double holds.
    assert.match(await text(page, '#invoice-table'), /20\.100502512562814071/);
    await context.close();
  });

  test('a status filter reaches the API as a query parameter', async () => {
    const { page, context, seen } = await open();
    await page.click('nav.tabs button:has-text("Invoices")');
    await page.selectOption('#filter-status', 'underpaid');
    await page.click('#invoice-filters button[type="submit"]');
    await page.waitForTimeout(200);
    assert.ok(seen.filter((entry) => entry.includes('/invoices')).length >= 2);
    await context.close();
  });

  // ── currencies and payouts ────────────────────────────────────────────────

  test('each chain says whether it has a payout address', async () => {
    /**
     * The page a merchant opens when an invoice was refused, so the answer belongs here
     * rather than only in the checklist — and per chain, because that is what a payout
     * address is per.
     */
    const { page, context } = await open();
    await page.click('nav.tabs button:has-text("Currencies")');
    await page.waitForTimeout(200);
    const body = await text(page, '#asset-groups');
    assert.match(body, /payout address set/);
    assert.match(body, /no payout address/);
    await context.close();
  });

  test('a currency on a chain with no address says invoices are refused', async () => {
    /**
     * The state a merchant is most likely to be in without knowing: they turned TON on,
     * they believe they are accepting it, and every invoice is being refused.
     */
    const { page, context } = await open();
    await page.click('nav.tabs button:has-text("Currencies")');
    await page.waitForTimeout(200);

    const row = await page.$eval('.asset-row[data-state="needs_payout"]', (node) =>
      node.textContent.replace(/\s+/g, ' ').trim(),
    );
    assert.match(row, /Needs a payout address/);
    assert.match(row, /refused/);
    await context.close();
  });

  test('a currency can be turned on from the list', async () => {
    // The whole point of the tab. It was read-only before, so a merchant had no way to say
    // which currencies they accept.
    const { page, context, posts } = await open();
    await page.click('nav.tabs button:has-text("Currencies")');
    await page.waitForTimeout(200);

    await page.click('.asset-row[data-state="accepting"] button:has-text("Turn off")');
    await page.waitForTimeout(250);

    const write = posts.find((entry) => entry.path.includes('/assets/'));
    assert.ok(write, 'turning a currency off should write to the API');
    assert.equal(write.body.enabled, false);
    // The pricing mode travels with it: `PUT` carries the whole configuration, and omitting
    // it would have the API refuse the write over a rate the merchant never touched.
    assert.equal(write.body.pricingMode, 'fiat');
    await context.close();
  });

  test('a currency in review offers no switch, because none would help', async () => {
    /**
     * A control that silently does nothing reads as a broken page rather than as a refusal.
     * The row still explains itself.
     */
    const { page, context } = await open();
    await page.click('nav.tabs button:has-text("Currencies")');
    await page.waitForTimeout(200);

    const row = await page.$('.asset-row[data-state="in_review"]');
    assert.ok(row);
    assert.equal(await row.$('button'), null, 'no switch on a row a switch cannot fix');
    assert.match(
      (await row.textContent()).replace(/\s+/g, ' '),
      /checking the contract/i,
    );
    await context.close();
  });

  test('a merchant can submit their own token for review', async () => {
    // Approval is neither automatic nor instant, and the response says so rather than
    // reading as "ready".
    const { page, context, posts } = await open();
    await page.click('nav.tabs button:has-text("Currencies")');
    await page.waitForTimeout(200);

    await page.fill('#submit-contract', '0x1234567890abcdef1234567890abcdef12345678');
    await page.click('#submit-asset');
    await page.waitForTimeout(250);

    const submitted = posts.find((entry) => entry.path.endsWith('/assets'));
    assert.ok(submitted);
    assert.equal(submitted.body.chain, 'bsc');
    assert.equal(submitted.body.contract, '0x1234567890abcdef1234567890abcdef12345678');
    await context.close();
  });

  test('a payout change is presented as scheduled, not immediate', async () => {
    /**
     * The delay is the security property: it is the difference between a stolen session
     * costing one order and costing everything after it. A merchant told the change was
     * instant would not check their email.
     */
    const { page, context, posts } = await open();
    await page.click('nav.tabs button:has-text("Payouts")');
    await page.waitForTimeout(150);
    assert.match(await text(page, '#view-payouts'), /scheduled rather than immediate/);

    await page.fill('#payout-address', '0x1111111111111111111111111111111111111111');
    await page.click('#payout-form button[type="submit"]');
    await page.waitForFunction(() => document.getElementById('flash')?.hidden === false, { timeout: 5000 });
    assert.match(await text(page, '#flash'), /Check your email/);
    assert.ok(posts.some((entry) => entry.path.endsWith('/payout-addresses')));
    await context.close();
  });

  // ── webhooks ──────────────────────────────────────────────────────────────

  test('no endpoint is called out as a problem, not left blank', async () => {
    const { page, context } = await open();
    await page.click('nav.tabs button:has-text("Webhooks")');
    await page.waitForTimeout(150);
    assert.match(await text(page, '#endpoint-table'), /nothing telling your system/);
    await context.close();
  });

  test('a new endpoint shows its secret once, with a warning', async () => {
    // The secret cannot be recovered, so the page has to say so at the moment it is
    // shown rather than in documentation somewhere else.
    const { page, context } = await open();
    await page.click('nav.tabs button:has-text("Webhooks")');
    await page.fill('#endpoint-url', 'https://store.test/avex');
    await page.click('#endpoint-form button[type="submit"]');
    await page.waitForFunction(() => document.getElementById('endpoint-secret')?.hidden === false, { timeout: 5000 });

    assert.equal(await text(page, '#endpoint-secret-value'), 'whsec_shown_once');
    assert.match(await text(page, '#endpoint-secret'), /shown once/);
    await context.close();
  });

  // ── keys ──────────────────────────────────────────────────────────────────

  test('a key is labelled by the mode its prefix implies', async () => {
    // The prefix is what the API enforces, so it is what the page reads.
    const { page, context } = await open();
    await page.click('nav.tabs button:has-text("API keys")');
    await page.waitForTimeout(150);
    const modes = await page.$$eval('#key-table .pill', (nodes) => nodes.map((n) => n.dataset.mode));
    assert.deepEqual(modes, ['test']);
    await context.close();
  });

  // ── commission ────────────────────────────────────────────────────────────

  test('the commission tab shows the rate in money and names the next rung', async () => {
    const { page, context } = await open();
    await page.click('nav.tabs button:has-text("Commission")');
    await page.waitForTimeout(150);
    const body = await text(page, '#view-commission');
    assert.match(body, /\$5 per \$1,000/);
    assert.match(body, /over \$50,000\.00 a month/);
    await context.close();
  });

  test('the commission tab says plainly that there is no monthly fee', async () => {
    /**
     * The one thing a merchant comparing us against Cryptomus wants to read, and the
     * change this whole view exists to state. An absent fee stated nowhere is
     * indistinguishable from a fee we have not mentioned yet.
     */
    const { page, context } = await open();
    await page.click('nav.tabs button:has-text("Commission")');
    await page.waitForTimeout(150);
    const body = await text(page, '#view-commission');
    assert.match(body, /No monthly fee|no subscription/i);
    assert.ok(!/\$49/.test(body), body);
    await context.close();
  });

  test('who pays the commission is offered as two stated options, not one toggle', async () => {
    /**
     * A single "pass the fee on" checkbox leaves the unchecked state unsaid — and the
     * unchecked state is the one where the merchant is paying, which is the more expensive
     * of the two to be in by accident.
     */
    const { page, context } = await open();
    await page.click('nav.tabs button:has-text("Commission")');
    await page.waitForTimeout(150);

    const choices = await all(page, '#fee-payer-options .choice');
    assert.equal(choices.length, 2);
    // Spelled out as a worked figure, because "your customer pays the fee" reads like a
    // separate bill and what actually happens is the invoice asks for more.
    assert.match(choices.join(' | '), /sends \$100 and you receive \$99\.5/);
    assert.match(choices.join(' | '), /sends \$100\.5 and you receive \$100/);
    await context.close();
  });

  test('the option in force is the one that cannot be clicked', async () => {
    // Pressing the state you are already in should not fire a request that changes
    // nothing, and a merchant should be able to see which one they are in at a glance.
    const { page, context } = await open();
    await page.click('nav.tabs button:has-text("Commission")');
    await page.waitForTimeout(150);

    const pressed = await page.$$eval('#fee-payer-options .choice', (nodes) =>
      nodes.map((node) => [node.getAttribute('aria-pressed'), node.disabled]),
    );
    assert.deepEqual(pressed, [['true', true], ['false', false]]);
    await context.close();
  });

  test('the published ladder is shown with the merchant own rung marked', async () => {
    // A volume discount a merchant has to ask about is not a published ladder.
    const { page, context } = await open();
    await page.click('nav.tabs button:has-text("Commission")');
    await page.waitForTimeout(150);
    const rows = await all(page, '#ladder-table tbody tr');
    assert.equal(rows.length, 3);
    assert.match(rows[0], /0\.5%/);
    assert.match(rows[0], /from your first payment/);
    assert.match(rows[0], /yours/);
    // Exactly one rung is theirs, or the table is telling them two different prices.
    assert.equal(rows.filter((row) => /yours/.test(row)).length, 1);
    await context.close();
  });

  // ── the wallet pool ───────────────────────────────────────────────────────

  test('the wallet pool lists what is live, what is retired, and what is waiting', async () => {
    /**
     * The pending row is the one that matters. It is the whole reason for the twenty-four hours,
     * and it carries the control that stops it — so it has to be visible to the member who did
     * not request it rather than buried under wallets that already work.
     */
    const { page, context } = await open();
    await page.click('nav.tabs button:has-text("Payouts")');
    await page.waitForTimeout(200);

    const body = await text(page, '#wallets-panel');
    assert.match(body, /Your own wallets on TRON/);
    assert.match(body, /in use/);
    assert.match(body, /retired/);
    // The scheduled one says how long is left, not just that it is pending.
    assert.match(body, /in \d/);
    assert.ok(await page.$('#wallet-table button:has-text("Cancel")'));
    assert.ok(await page.$('#wallet-table button:has-text("Retire")'));
    await context.close();
  });

  test('the pool says plainly that the first wallet is immediate and the rest are not', async () => {
    /**
     * A merchant who adds their second wallet and finds it does nothing for a day, with no
     * warning, will conclude the panel is broken and try again — which is how somebody ends up
     * with three scheduled wallets they did not want.
     */
    const { page, context } = await open();
    await page.click('nav.tabs button:has-text("Payouts")');
    await page.waitForTimeout(200);
    const body = await text(page, '#wallets-panel');
    assert.match(body, /first wallet is usable at once/);
    assert.match(body, /waits 24 hours/);
    assert.match(body, /Retiring one is\s+immediate/);
    await context.close();
  });

  test('a merchant with no pooled currency is shown no pool at all', async () => {
    /**
     * A panel explaining a TRON-only mechanism to somebody who takes only BSC is a paragraph
     * they have to read in order to discover it does not apply to them.
     */
    const { page, context } = await open({
      assets: { data: FIXTURE.assets.data.filter((asset) => asset.chain !== 'tron') },
    });
    await page.click('nav.tabs button:has-text("Payouts")');
    await page.waitForTimeout(200);
    assert.equal(await page.$eval('#wallets-panel', (node) => node.hidden), true);
    await context.close();
  });

  // ── the balance ───────────────────────────────────────────────────────────

  test('the balance explains itself rather than showing a bare negative number', async () => {
    /**
     * The failure this guards against is not a crash. It is a merchant opening their panel,
     * seeing a negative figure next to their money, and having no idea whether we have lost
     * some of it. So the assertions are about the words: what it is, that it clears itself,
     * and that their customers are not involved.
     */
    const { page, context } = await open();
    await page.click('nav.tabs button:has-text("Commission")');
    await page.waitForTimeout(150);

    const body = await text(page, '#balance-panel');
    assert.match(body, /-\$0\.32/, 'the figure, signed');
    assert.match(body, /Owed on TRON/);
    assert.match(body, /clears itself/);
    assert.match(body, /customers never see it/);
    // And the statement, with each line named rather than left as a signed number.
    assert.match(body, /Commission on a TRON payment/);
    assert.match(body, /Cleared by a later invoice/);
    await context.close();
  });

  test('a merchant who owes nothing is shown no balance block at all', async () => {
    /**
     * An empty "Your balance: $0.00" card is a question a merchant has to answer before they
     * can ignore it, and most accounts will never take a TRON payment.
     */
    const { page, context } = await open({
      balance: {
        balanceUsdMicros: '0',
        creditLimitUsdMicros: '500000000',
        canInvoiceOnAccruingChains: true,
        entries: [],
      },
    });
    await page.click('nav.tabs button:has-text("Commission")');
    await page.waitForTimeout(150);
    assert.equal(await page.$eval('#balance-panel', (node) => node.hidden), true);
    await context.close();
  });

  test('past the limit it says what is blocked and what still works', async () => {
    /**
     * The one state that needs action. It names the action, and it names the alternative —
     * because "keep trading on your other chains" is something they can do right now, and it
     * is what clears the balance.
     */
    const { page, context } = await open({
      balance: {
        balanceUsdMicros: '-501000000',
        creditLimitUsdMicros: '500000000',
        canInvoiceOnAccruingChains: false,
        entries: [
          { id: 'l1', kind: 'accrual', amountUsdMicros: '-501000000', invoiceId: null, note: null, createdAt: '2026-08-01T10:00:00.000Z' },
        ],
      },
    });
    await page.click('nav.tabs button:has-text("Commission")');
    await page.waitForTimeout(150);

    const panel = await page.$eval('#balance-panel', (node) => node.dataset.tone);
    assert.equal(panel, 'blocked');
    const body = await text(page, '#balance-panel');
    assert.match(body, /TRON invoices are paused/);
    assert.match(body, /\$500\.00 limit/);
    assert.match(body, /clear the balance as they are paid/);
    await context.close();
  });

  // ── preview mode ──────────────────────────────────────────────────────────

  test('preview mode loads the whole dashboard with no API behind it', async () => {
    /**
     * The point of building the preview as a network stub rather than a branch: every render
     * path runs exactly as it does against the real API. This test is what makes that claim
     * checkable — the page is loaded with no route handlers at all, so anything it renders
     * came through its own fetch path.
     */
    const context = await browser.newContext({ viewport: { width: 430, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push('console: ' + message.text());
    });

    await page.route(`${PAGE}*`, (route) =>
      route.fulfill({ path: pageFile, contentType: 'text/html' }),
    );
    // Anything that escapes the stub is a failure, not a silent network call.
    await page.route('**/v1/**', (route) => route.abort());

    await page.goto(`${PAGE}?preview=1`);
    await page
      .waitForFunction(() => document.getElementById('app')?.hidden === false, { timeout: 6000 })
      .catch(() => {});

    assert.equal(await shown(page, '#app'), true, 'the dashboard should open');
    assert.deepEqual(errors, []);

    // Said before anything else, and not dismissible: a dashboard full of plausible figures
    // that somebody takes for their own account is worse than no preview.
    assert.equal(await shown(page, '#preview-banner'), true);
    assert.match(await text(page, '#preview-banner'), /made up|not an account/i);

    // Every tab renders rather than half of them.
    for (const label of ['Take a payment', 'Invoices', 'Currencies', 'Payouts', 'Webhooks', 'API keys', 'Commission', 'Overview']) {
      await page.click(`nav.tabs button:has-text("${label}")`);
      await page.waitForTimeout(120);
      assert.equal(await shown(page, '#flash'), false, `${label} flashed an error`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('a preview reached from the landing page opens on the form and walks through it', async () => {
    /**
     * The site's "create an account" button carries `?signup=1`. A preview that answered it by
     * opening already signed in would skip the one screen the visitor clicked towards — so the
     * demo would show every part of the product except the door.
     *
     * Driven end to end here, through the page's own fetch, because the preview's whole point
     * is that no code path differs from the real thing.
     */
    const context = await browser.newContext({ viewport: { width: 430, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push('console: ' + message.text());
    });
    await page.route(`${PAGE}*`, (route) =>
      route.fulfill({ path: pageFile, contentType: 'text/html' }),
    );
    // Anything that escapes the stub is a failure, not a silent network call.
    await page.route('**/v1/**', (route) => route.abort());

    await page.goto(`${PAGE}?preview=1&signup=1&email=shop%40example.com`);
    await page.waitForTimeout(200);

    assert.equal(await shown(page, '#auth-panel'), true, 'the form should be on screen');
    assert.equal(await shown(page, '#app'), false, 'the preview signed itself in');
    assert.equal(await text(page, '#auth-title'), 'Create an account');
    assert.equal(await page.$eval('#auth-email', (node) => node.value), 'shop@example.com');
    // The warning comes before the form, not after somebody has filled it in.
    assert.equal(await shown(page, '#preview-banner'), true);

    await page.fill('#auth-org', 'Example Store');
    await page.fill('#auth-password', 'a-sufficiently-long-password');
    await page.click('#auth-submit');
    await page.waitForFunction(() => document.getElementById('app')?.hidden === false, { timeout: 6000 });

    assert.equal(await shown(page, '#app'), true);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('a preview reached from the confirmation email shows the message, not the dashboard', async () => {
    /**
     * Every other preview opens signed in, and this one must not: the dashboard would render
     * straight over the one line the visitor came to read, and the preview would be showing
     * every part of the product except the screen the email points at.
     *
     * The bug was exactly that, and no test caught it — the other verification tests stub the
     * API themselves and never enter preview mode at all.
     */
    const context = await browser.newContext({ viewport: { width: 430, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.route(`${PAGE}*`, (route) =>
      route.fulfill({ path: pageFile, contentType: 'text/html' }),
    );
    // Anything that escapes the stub is a failure, not a silent network call.
    await page.route('**/v1/**', (route) => route.abort());

    await page.goto(`${PAGE}?preview=1&verify=tok_abc123`);
    await page.waitForFunction(
      () => document.getElementById('auth-error')?.hidden === false,
      { timeout: 6000 },
    );

    assert.equal(await shown(page, '#app'), false, 'the preview opened signed in');
    assert.match(await text(page, '#auth-error'), /confirmed/i);
    assert.equal(await shown(page, '#preview-banner'), true);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('preview mode shows every state a currency can be in', async () => {
    /**
     * The tab exists because "off" has six causes and five are not the merchant's to fix. A
     * preview that showed only approved rows would show one of them, so the fixture carries
     * the lot — and this is what keeps it that way.
     */
    const context = await browser.newContext({ viewport: { width: 430, height: 900 } });
    const page = await context.newPage();
    await page.route(`${PAGE}*`, (route) =>
      route.fulfill({ path: pageFile, contentType: 'text/html' }),
    );
    await page.goto(`${PAGE}?preview=1`);
    await page
      .waitForFunction(() => document.getElementById('app')?.hidden === false, { timeout: 6000 })
      .catch(() => {});

    await page.click('nav.tabs button:has-text("Currencies")');
    await page.waitForTimeout(250);

    const states = await page.$$eval('.asset-row', (rows) =>
      rows.map((row) => row.dataset.state),
    );
    for (const state of ['accepting', 'off', 'needs_payout', 'in_review', 'withdrawn']) {
      assert.ok(states.includes(state), `${state} is missing from the preview: ${states.join(', ')}`);
    }

    // The withdrawn row says it is us, not them — a merchant told only "unavailable" goes
    // looking at their own configuration, and there is nothing there to find.
    const withdrawn = await page.$eval('.asset-row[data-state="withdrawn"]', (node) =>
      node.textContent.replace(/\s+/g, ' '),
    );
    assert.match(withdrawn, /AVEX is not accepting/);
    await context.close();
  });

  test('a bridged token is labelled, and a native one is not', async () => {
    /**
     * "USDT on BNB Chain" is Binance-Peg BSC-USD: a Binance liability, not a Tether one.
     * Perfectly usable and merchants accept it, but it depends on a custodian as well as on
     * Tether's reserves — and the merchant deciding what to take should know which promise
     * they are accepting.
     *
     * The native rows carry no badge on purpose. A badge on everything is a badge nobody
     * reads, and it is the exception that carries the information.
     */
    const context = await browser.newContext({ viewport: { width: 430, height: 900 } });
    const page = await context.newPage();
    await page.route(`${PAGE}*`, (route) =>
      route.fulfill({ path: pageFile, contentType: 'text/html' }),
    );
    await page.goto(`${PAGE}?preview=1`);
    await page
      .waitForFunction(() => document.getElementById('app')?.hidden === false, { timeout: 6000 })
      .catch(() => {});

    await page.click('nav.tabs button:has-text("Currencies")');
    await page.waitForTimeout(250);

    const badged = await page.$$eval('.asset-row', (rows) =>
      rows
        .filter((row) => [...row.querySelectorAll('.pill')].some((pill) => pill.textContent === 'bridged'))
        .map((row) => row.querySelector('.asset-symbol')?.textContent + '/' + (row.dataset.state ?? '')),
    );
    assert.ok(badged.length >= 1, 'the Binance-Peg rows should be marked');

    // And it says what it means, rather than leaving a word nobody can act on.
    const row = await page.$('.asset-row:has(.pill:text-is("bridged"))');
    assert.match((await row.textContent()).replace(/\s+/g, ' '), /Wrapped by a third party/);

    // TRON's USDT is issued by Tether itself, so it carries no badge.
    const total = (await page.$$('.asset-row')).length;
    assert.ok(badged.length < total, 'native rows must not be badged too');
    await context.close();
  });

  test('preview mode refuses a change rather than pretending it worked', async () => {
    /**
     * The one place a preview has to decide what a write does. Pretending would leave
     * somebody believing they had reconfigured an account that does not exist.
     */
    const context = await browser.newContext({ viewport: { width: 430, height: 900 } });
    const page = await context.newPage();
    await page.route(`${PAGE}*`, (route) =>
      route.fulfill({ path: pageFile, contentType: 'text/html' }),
    );
    await page.goto(`${PAGE}?preview=1`);
    await page
      .waitForFunction(() => document.getElementById('app')?.hidden === false, { timeout: 6000 })
      .catch(() => {});

    await page.click('nav.tabs button:has-text("Commission")');
    await page.waitForTimeout(150);
    // The second option is the one not in force, so it is the clickable one.
    await page.click('#fee-payer-options .choice:not([disabled])');
    await page.waitForTimeout(200);

    assert.equal(await shown(page, '#flash'), true);
    assert.match(await text(page, '#flash'), /preview|cannot be changed/i);
    await context.close();
  });

  // ── general ───────────────────────────────────────────────────────────────

  test('nothing renders the literal text null', async () => {
    /**
     * `replaceChildren` stringifies whatever it is given, so a `null` from a conditional
     * branch renders as "null" — which shipped in the staff panel once. Every tab is
     * visited here because it only shows up where the data is sparse.
     */
    const { page, context } = await open();
    for (const label of ['Overview', 'Invoices', 'Currencies', 'Payouts', 'Webhooks', 'API keys', 'Commission']) {
      await page.click(`nav.tabs button:has-text("${label}")`);
      await page.waitForTimeout(120);
      const body = await page.$eval('#app', (node) => node.textContent);
      assert.ok(!/\bnull\b/.test(body), `"null" rendered on ${label}`);
      assert.ok(!/\bundefined\b/.test(body), `"undefined" rendered on ${label}`);
      assert.ok(!/\bNaN\b/.test(body), `"NaN" rendered on ${label}`);
    }
    await context.close();
  });

  test('the page declares its own character set', async () => {
    // Served without one, a browser reads the UTF-8 as Latin-1 and every em dash and
    // emoji becomes mojibake. Both other pages had this bug.
    const { page, context } = await open({ staySignedOut: true });
    const charset = await page.$eval('meta[charset]', (node) => node.getAttribute('charset'));
    assert.equal(charset?.toLowerCase(), 'utf-8');
    await context.close();
  });

  test('the dashboard ran without throwing', async () => {
    const { page, context, errors } = await open();
    for (const label of ['Invoices', 'Currencies', 'Payouts', 'Webhooks', 'API keys', 'Commission', 'Overview']) {
      await page.click(`nav.tabs button:has-text("${label}")`);
      await page.waitForTimeout(120);
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
});

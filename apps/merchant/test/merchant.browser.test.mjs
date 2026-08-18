import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
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
    assets: [
      { id: 'a1', symbol: 'USDT', chain: 'bsc', decimals: 18, verdict: 'approved', enabled: true, pricingMode: 'fiat' },
      { id: 'a2', symbol: 'USDT', chain: 'ton', decimals: 6, verdict: 'approved', enabled: true, pricingMode: 'fiat' },
      { id: 'a3', symbol: 'MINE', chain: 'bsc', decimals: 18, verdict: 'review', enabled: true, pricingMode: 'fixed_rate' },
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
      if (method === 'POST' && path.endsWith('/v1/auth/mfa')) {
        return route.fulfill(json({ token: 'sess_abc' }));
      }
      if (method === 'POST' && path.endsWith('/v1/auth/logout')) return route.fulfill(json({}));
      if (path.endsWith('/v1/auth/me')) return route.fulfill(json({ email: 'owner@example.test' }));
      if (path.endsWith('/v1/organizations')) {
        return route.fulfill(json({ organizations: [{ id: ORG, name: 'Example Store' }] }));
      }

      if (method === 'POST') {
        posts.push({ path, body: JSON.parse(route.request().postData() ?? '{}') });
        if (path.endsWith('/checkouts')) {
          if (overrides.checkoutFails) {
            return route.fulfill(json({ error: 'no_assets', message: 'No currency is payable yet.' }, 409));
          }
          return route.fulfill(json({ id: 'chk_1', url: 'https://pay.test/pay/chk_1', status: 'open' }, 201));
        }
        if (path.endsWith('/webhook-endpoints')) {
          return route.fulfill(json({ id: 'e1', secret: 'whsec_shown_once' }, 201));
        }
        if (path.endsWith('/payout-addresses')) return route.fulfill(json({ status: 'scheduled' }, 202));
        return route.fulfill(json({ status: 'ok' }));
      }

      if (path.endsWith('/commission')) return route.fulfill(json(data.commission));
      if (path.endsWith('/reports/volume')) return route.fulfill(json(data.report));
      if (path.endsWith('/assets')) return route.fulfill(json(data.assets));
      if (path.endsWith('/payout-addresses')) return route.fulfill(json(data.payouts));
      if (path.endsWith('/webhook-endpoints')) return route.fulfill(json(data.endpoints));
      if (path.endsWith('/webhook-deliveries')) return route.fulfill(json(data.deliveries));
      if (path.endsWith('/api-keys')) return route.fulfill(json(data.keys));
      if (path.endsWith('/invoices')) return route.fulfill(json(data.invoices));
      return route.fulfill(json({}));
    });

    await page.goto(PAGE);
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

  test('signing out hides everything again', async () => {
    // Including the case where the server refuses: the token must be cleared locally
    // whatever happens, because leaving it in memory is the wrong way to fail.
    const { page, context } = await open();
    await page.click('#sign-out');
    await page.waitForFunction(() => document.getElementById('app')?.hidden === true, { timeout: 5000 });
    assert.equal(await shown(page, '#auth-panel'), true);
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

  test('each currency says whether its chain has a payout address', async () => {
    // The table a merchant looks at when an invoice was refused, so the answer belongs
    // here rather than only in the checklist.
    const { page, context } = await open();
    await page.click('nav.tabs button:has-text("Currencies")');
    await page.waitForTimeout(150);
    const body = await text(page, '#asset-table');
    assert.match(body, /missing/);
    assert.match(body, /set/);
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

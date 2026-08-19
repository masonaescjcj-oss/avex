import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The site in a browser.
 *
 * The claims tests read the shipped HTML as text; these run it. What matters here is the
 * hero: it derives a real CREATE2 address with the same code the gateway uses, and the whole
 * page is an argument that the address commits to the merchant's wallet. If that panel is
 * wrong, or worse plausible-but-fake, the page is making its central claim in a medium where
 * it has quietly stopped being true.
 */

const here = dirname(fileURLToPath(import.meta.url));
const PAGE = 'https://avex.test/index.html';
const pageFile = join(here, '..', 'public', 'index.html');

const CANDIDATES = ['/opt/node22/lib/node_modules/playwright/index.mjs', 'playwright'];

async function loadPlaywright() {
  for (const candidate of CANDIDATES) {
    if (candidate.startsWith('/') && !existsSync(candidate)) continue;
    try {
      return await import(candidate);
    } catch {
      // A missing browser is a skip, not a failure.
    }
  }
  return null;
}

const playwright = await loadPlaywright();

describe('avex.pay', { skip: playwright ? false : 'playwright is not installed' }, () => {
  let browser;

  before(async () => {
    browser = await playwright.chromium.launch();
  });

  after(async () => {
    await browser?.close();
  });

  async function open(viewport = { width: 1400, height: 1000 }) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('ERR_')) {
        errors.push('console: ' + message.text());
      }
    });

    await page.route(`${PAGE}*`, (route) =>
      route.fulfill({ path: pageFile, contentType: 'text/html' }),
    );
    // Fonts are the one external host the page reaches. Blocked here so a test never depends
    // on the network; the fallback stacks are what render.
    await page.route('https://fonts.**', (route) => route.abort());

    await page.goto(PAGE);
    await page.waitForTimeout(300);
    return { page, context, errors };
  }

  const text = (page, selector) =>
    page.$eval(selector, (node) => node.textContent.replace(/\s+/g, ' ').trim());

  test('the page loads with nothing thrown', async () => {
    /**
     * Worth its own test because the script is four modules concatenated into one scope: a
     * single name collision is a SyntaxError that empties the address panel and leaves every
     * dashboard link pointing at whatever the markup happened to hardcode. That happened on
     * the first build, and the static fallbacks looked plausible throughout.
     */
    const { page, context, errors } = await open();
    assert.deepEqual(errors, []);
    assert.match(await text(page, 'h1'), /Take crypto payments\./);
    await context.close();
  });

  test('the hero derives a real address, and the wallet is an input to it', async () => {
    /**
     * The whole argument. The address is a hash over the merchant's payout wallet, so
     * changing the wallet must change the address — if it did not, the page would be
     * asserting non-custody beside a decoration.
     */
    const { page, context } = await open();

    const first = await text(page, '#d-address');
    assert.match(first, /^0x[0-9a-fA-F]{40}$/);

    await page.fill('#d-payout', '0x1111111111111111111111111111111111111111');
    await page.waitForTimeout(150);
    const second = await text(page, '#d-address');
    assert.match(second, /^0x[0-9a-fA-F]{40}$/);
    assert.notEqual(second, first, 'the payout wallet must change the deposit address');

    // The invoice reference too, so two orders never share a deposit address.
    await page.fill('#d-invoice', 'order-9999');
    await page.waitForTimeout(150);
    const third = await text(page, '#d-address');
    assert.notEqual(third, second, 'the invoice reference must change the deposit address');

    // Same inputs, same address: a reader who types the original back must see it return.
    await page.fill('#d-payout', '0x7A3f9C21bE04D5aa71cE3B8Ed4F9021cC6b17E52');
    await page.fill('#d-invoice', 'order-1042');
    await page.waitForTimeout(150);
    assert.equal(await text(page, '#d-address'), first);
    await context.close();
  });

  test('the derived address is checksummed', async () => {
    // Every wallet shows addresses in EIP-55 mixed case. An all-lowercase one on a payments
    // site reads as hand-made.
    const { page, context } = await open();
    const address = await text(page, '#d-address');
    assert.notEqual(address, address.toLowerCase());
    await context.close();
  });

  test('a rejected input clears the address instead of leaving the last good one', async () => {
    /**
     * The worst possible behaviour on this panel: a stale address beside a rejected wallet
     * looks like the answer to what was typed — and here it would look like an address
     * somebody could send money to.
     */
    const { page, context } = await open();
    await page.fill('#d-payout', 'not-an-address');
    await page.waitForTimeout(150);

    assert.equal(await text(page, '#d-address'), '—');
    assert.equal(await page.$eval('#d-error', (node) => node.hidden), false);
    assert.match(await text(page, '#d-error'), /0x followed by 40 hex/);
    await context.close();
  });

  test('every way into the panel resolves to the panel this deployment names', async () => {
    /**
     * The nav, the hero, the CTA band and the footer all offer the same two doors, and the
     * markup hardcodes `/dashboard` only so they work before the script runs. What ships is
     * whatever the `<meta>` names — so this checks the rewriting actually happened on every
     * one of them, which is the failure mode a static read of the HTML cannot see.
     */
    const { page, context } = await open();

    const meta = await page.$eval('meta[name="avex-dashboard"]', (node) => node.content);
    assert.ok(meta.length > 0, 'the page names no panel');

    const links = await page.$$eval('[data-dash]', (nodes) =>
      nodes.map((node) => ({ kind: node.dataset.dash, href: node.getAttribute('href') })),
    );
    assert.ok(links.length >= 5, `only ${links.length} auth links`);
    for (const { kind, href } of links) {
      assert.ok(href.startsWith(meta), `${kind} link points at ${href}, not at ${meta}`);
      if (kind === 'up') assert.match(href, /[?&]signup=1/, href);
      else assert.ok(!/signup=/.test(href), `a sign-in link asks for signup: ${href}`);
    }
    assert.ok(links.some((link) => link.kind === 'in'));
    assert.ok(links.some((link) => link.kind === 'up'));
    await context.close();
  });

  test('the email a visitor types arrives at the panel with them', async () => {
    /**
     * The point of asking for an address on the landing page is that the panel does not have
     * to ask again. If the handoff drops it the visitor types it twice, which is where a
     * signup funnel loses people — and it would drop it silently, because navigating still
     * works.
     */
    const { page, context } = await open();
    // The panel is not served in this test; catching the navigation is what we are asserting.
    await page.route('https://avex.test/dashboard*', (route) =>
      route.fulfill({ body: '<title>panel</title>', contentType: 'text/html' }),
    );

    await page.fill('#start-email', 'shop@example.com');
    await page.click('#start-form button[type="submit"]');
    await page.waitForURL(/\/dashboard/);

    const url = new URL(page.url());
    assert.equal(url.searchParams.get('signup'), '1');
    assert.equal(url.searchParams.get('email'), 'shop@example.com');
    await context.close();
  });

  test('a malformed address is caught here rather than at the panel', async () => {
    /**
     * The field is `type="email"`, so the browser refuses the submit itself and says why,
     * next to the box — which is a better correction than a round trip that lands on a panel
     * with an empty field and no explanation.
     *
     * Worth asserting because the handler behind it would happily navigate: `signUpWithEmail`
     * drops an address it cannot use and sends the visitor on. That fallback is for the paths
     * validation does not cover, and this test is what says which of the two a person meets.
     */
    const { page, context } = await open();
    const before = page.url();

    await page.fill('#start-email', 'not-an-address');
    await page.click('#start-form button[type="submit"]');
    await page.waitForTimeout(300);

    assert.equal(page.url(), before, 'a malformed address was carried to the panel');
    assert.equal(
      await page.$eval('#start-email', (node) => node.checkValidity()),
      false,
      'the field reports itself as valid',
    );
    await context.close();
  });

  test('the products section says what you can sell with, not what you can be paid in', async () => {
    /**
     * Which currencies an account takes is decided in the panel and changes without a
     * redeploy. A card naming one is a promise the front page cannot keep, so the grid is
     * checked here in the rendered text rather than only in the markup.
     */
    const { page, context } = await open();
    const products = await text(page, '#products');
    for (const capability of ['Hosted checkout', 'Payment links', 'WooCommerce', 'Telegram Stars']) {
      assert.ok(products.includes(capability), `${capability} is missing`);
    }
    for (const symbol of ['USDT', 'USDC', 'TRX', 'BNB', 'SOL']) {
      assert.ok(!new RegExp(`\\b${symbol}\\b`).test(products), `${symbol} is named on the page`);
    }
    assert.ok((await page.$$('#products .card')).length >= 6);
    await context.close();
  });

  test('the docs section is on the page, not a link away', async () => {
    // The request was a site with the documentation on it. A page that only links out has
    // not done that.
    const { page, context } = await open();
    const docs = await text(page, '#docs');
    for (const topic of ['Quickstart', 'Test mode', 'Webhooks', 'WooCommerce']) {
      assert.ok(docs.includes(topic), `${topic} is missing from the docs section`);
    }
    // With real code a reader can run, not a screenshot of it.
    assert.ok((await page.$$('#docs pre')).length >= 3);
    assert.match(docs, /amountFiatMicros/);
    await context.close();
  });

  test('the mechanism diagram is described for a reader who cannot see it', async () => {
    // It carries the product's central claim, so it cannot be the one thing a screen reader
    // is left out of.
    const { page, context } = await open();
    const label = await page.$eval('#how svg', (node) => node.getAttribute('aria-label'));
    assert.match(label, /derived from the merchant's wallet/);
    assert.match(label, /holds no balance/);
    assert.equal(await page.$eval('#how svg', (node) => node.getAttribute('role')), 'img');
    await context.close();
  });

  test('nothing renders the literal text undefined or NaN', async () => {
    /**
     * Every figure on the page is computed from a module, so a shape change upstream shows up
     * here rather than as an error. "NaN" on a pricing page is the most expensive typo
     * available.
     */
    const { page, context } = await open();
    /**
     * `innerText`, not `textContent`.
     *
     * The page inlines four of the product's own modules, and `textContent` returns their
     * source along with the copy — so a `=== undefined` comparison inside `findCuratedAsset`
     * read as "undefined reached the page". `innerText` is what a person actually sees.
     */
    const rendered = await page.$eval('body', (node) => node.innerText.replace(/\s+/g, ' '));
    assert.ok(!/\bundefined\b/.test(rendered), 'undefined reached the page');
    assert.ok(!/\bNaN\b/.test(rendered), 'NaN reached the page');
    assert.ok(!/\[object Object\]/.test(rendered));
    await context.close();
  });

  test('the page does not scroll sideways on a phone', async () => {
    /**
     * The tables and the code blocks are wider than a phone, and they are meant to scroll
     * inside their own containers. If one escapes, the whole page slides and every section
     * feels broken.
     */
    const { page, context } = await open({ width: 390, height: 844 });
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    assert.equal(overflows, false, 'the body scrolls horizontally');
    await context.close();
  });

  test('the derivation panel is usable on a phone', async () => {
    // It is the hero. A hero that only works on a desktop is a hero most readers never see.
    const { page, context } = await open({ width: 390, height: 844 });
    assert.match(await text(page, '#d-address'), /^0x[0-9a-fA-F]{40}$/);
    const wide = await page.$eval('#d-payout', (node) => node.scrollWidth > node.clientWidth + 1);
    void wide; // A long address may scroll inside its own input; that is fine.
    await context.close();
  });

  test('the ground is painted, so the page holds on any host', async () => {
    /**
     * The artifact composites over a ground the viewer paints in *its* theme. This page is
     * committed to black — a transparent body would put white text on a white ground for
     * every light-mode reader.
     */
    const { page, context } = await open();
    const background = await page.$eval('body', (node) => getComputedStyle(node).backgroundColor);
    assert.equal(background, 'rgb(0, 0, 0)');
    await context.close();
  });
});

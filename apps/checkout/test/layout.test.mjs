import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The pages on a phone.
 *
 * Everything here is measured, not read: a stylesheet that says `min-height: 44px` can
 * still ship a 38px button when another rule wins, and the only thing that knows what a
 * payer's thumb actually meets is the rendered box. The width is 360px because that is
 * what a cheap Android phone gives a page, and a checkout that scrolls sideways there is
 * a checkout with an address half off screen.
 *
 * Three properties matter enough to guard. No horizontal overflow in any state the page
 * can be in. The amount and the address each have a copy button a thumb can hit. And
 * the QR sits on white — a code on a dark ground without a white frame does not scan,
 * and no amount of styling is worth that.
 */

const here = dirname(fileURLToPath(import.meta.url));
const checkoutFile = join(here, '..', 'public', 'checkout.html');
const receiptFile = join(here, '..', 'public', 'receipt.html');
const checkoutUrl = 'file://' + checkoutFile;

/** 360 wide: a small phone, and the narrowest width the page is designed for. */
const PHONE = { width: 360, height: 780 };
/** The smallest thing a thumb is asked to hit, in CSS pixels. */
const TAP = 44;

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

/** How far the document is wider than the viewport. Zero is the only acceptable answer. */
const overflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

const box = (page, selector) =>
  page.$eval(selector, (node) => {
    const rect = node.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });

/**
 * True when the element's text sits on one line.
 *
 * Measured against the computed line height, with a margin under the second line: the
 * first version of this allowed 2.4 lines' worth of height and passed a figure that had
 * wrapped, which is precisely the failure it exists to catch.
 */
const singleLine = (page, selector) =>
  page.$eval(selector, (node) => {
    const style = getComputedStyle(node);
    const fontSize = parseFloat(style.fontSize);
    const lineHeight = style.lineHeight === 'normal' ? fontSize * 1.2 : parseFloat(style.lineHeight);
    const rect = node.getBoundingClientRect();
    return rect.height > 0 && rect.height < lineHeight * 1.5;
  });

describe('the checkout on a phone', { skip: playwright ? false : 'playwright is not installed' }, () => {
  let browser;
  let page;
  const errors = [];

  before(async () => {
    browser = await playwright.chromium.launch();
    page = await browser.newPage({ viewport: PHONE });
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(checkoutUrl);
  });

  after(async () => {
    await browser?.close();
  });

  const reset = async () => {
    await page.click('[data-demo="awaiting"]');
    await page.waitForTimeout(80);
  };

  test('no screen state scrolls sideways at 360px', async () => {
    /**
     * Every state the page can show, walked in order. A state is only checked once it is
     * actually rendered — the pay screen's address is the widest thing on the page, and
     * the memo warning on TON is the tallest — so each one is entered rather than
     * assumed.
     */
    await reset();
    assert.equal(await overflow(page), 0, 'before choosing anything');

    await page.click('#currencies .coin:has-text("Tether")');
    assert.equal(await overflow(page), 0, 'with the network list open');

    await page.click('#networks .net-row:has-text("BNB Chain")');
    assert.equal(await overflow(page), 0, 'with a network picked');

    await page.click('#to-pay');
    assert.equal(await overflow(page), 0, 'on the pay screen');

    await page.click('#back-to-network');
    await page.click('#networks .net-row:has-text("TON")');
    await page.click('#to-pay');
    assert.equal(await overflow(page), 0, 'on the pay screen with a memo');

    for (const state of ['confirming', 'paid', 'underpaid', 'expired']) {
      await page.click(`[data-demo="${state}"]`);
      await page.waitForTimeout(120);
      assert.equal(await page.$eval('#status', (node) => node.dataset.state), state);
      assert.equal(await overflow(page), 0, `while ${state}`);
    }
  });

  test('the amount and the address each have a copy button a thumb can hit', async () => {
    /**
     * The amount first. On a chain where the merchant's own wallet receives the money,
     * the exact figure is what identifies the payment — so copying it wrongly, or having
     * to select it by hand on a phone, is how a payment goes unmatched.
     */
    await reset();
    await page.click('#currencies .coin:has-text("Tether")');
    await page.click('#networks .net-row:has-text("BNB Chain")');
    await page.click('#to-pay');

    for (const id of ['copy-amount', 'copy-address']) {
      const size = await box(page, '#' + id);
      assert.ok(size.height >= TAP, `#${id} is ${size.height}px tall; a thumb needs ${TAP}`);
      assert.ok(size.width >= TAP, `#${id} is ${size.width}px wide; a thumb needs ${TAP}`);
    }

    // The amount's button copies the figure alone — "20.02", not "20.02 USDT" — because
    // what a wallet's amount field takes is the number.
    assert.equal(await page.$eval('#copy-amount', (node) => node.dataset.copy), 'amount');
    assert.equal(await page.$eval('#amount', (node) => node.textContent.trim()), '20.02');
  });

  test('the copy button for the amount waits for the pay screen', async () => {
    // Before an address exists the figure shown is the fiat price, and a button to copy
    // "20.00" into a wallet would copy the one number nobody should send.
    await reset();
    assert.equal(await box(page, '#copy-amount').catch(() => ({ height: 0 })).then((b) => b.height), 0);
    assert.equal(await box(page, '#amount-exact').catch(() => ({ height: 0 })).then((b) => b.height), 0);
  });

  test('the QR keeps its white frame', async () => {
    /**
     * A scanner needs dark modules on a light ground with a quiet zone around them. The
     * frame is that ground and that zone, and the page is black — so if the frame ever
     * inherits the page's colour, the code stops scanning without anything looking wrong.
     */
    await reset();
    await page.click('#currencies .coin:has-text("Tether")');
    await page.click('#networks .net-row:has-text("BNB Chain")');
    await page.click('#to-pay');

    const frame = await page.$eval('#qr', (node) => {
      const style = getComputedStyle(node);
      return { background: style.backgroundColor, padding: parseFloat(style.paddingLeft) };
    });
    assert.equal(frame.background, 'rgb(255, 255, 255)');
    assert.ok(frame.padding >= 8, 'the quiet zone around the modules has to be there');

    // And the symbol's own ground is white too, so a frame someone restyles later still
    // leaves a scannable code.
    const ground = await page.$eval('#qr svg rect', (node) => node.getAttribute('fill'));
    assert.equal(ground.toUpperCase(), '#FFFFFF');
    assert.equal(await overflow(page), 0);
  });

  test('every control on the pay screen is at least 44px tall', async () => {
    await reset();
    await page.click('#currencies .coin:has-text("Tether")');
    await page.click('#networks .net-row:has-text("TON")');
    await page.click('#to-pay');

    const heights = await page.$$eval('#screen-pay button', (nodes) =>
      nodes.map((node) => [node.id || node.textContent.trim(), node.getBoundingClientRect().height]),
    );
    assert.ok(heights.length >= 3, 'change, copy address, copy memo');
    for (const [name, height] of heights) {
      assert.ok(height >= TAP, `${name} is ${height}px tall`);
    }
  });

  test('the currency and network choices are at least 44px tall', async () => {
    await reset();
    await page.click('#currencies .coin:has-text("Tether")');
    const coins = await page.$$eval('#currencies .coin', (nodes) =>
      nodes.map((node) => node.getBoundingClientRect().height),
    );
    const nets = await page.$$eval('#networks .net-row', (nodes) =>
      nodes.map((node) => node.getBoundingClientRect().height),
    );
    for (const height of [...coins, ...nets]) assert.ok(height >= TAP, `${height}px`);
    assert.ok((await box(page, '#to-pay')).height >= TAP);
  });

  test('the page ran without throwing', () => {
    assert.deepEqual(errors, []);
  });
});

/**
 * The same page against the API's own figures, which are longer than the demo's.
 *
 * A live BNB Chain invoice is eighteen decimals — 20.100502512562814071 USDT — and a
 * passed-on commission adds a row with a figure nearly as long. Neither exists in the
 * demo catalogue, and both are the widest things the page ever shows.
 */
describe('the checkout on a phone, with live-sized figures', { skip: playwright ? false : 'playwright is not installed' }, () => {
  const PAGE = 'https://checkout.test/checkout.html';
  const SESSION = '3f6b1c20-8a11-4b2e-9c47-1d5e2a8b7c90';
  const ADDRESS = '0x7A3f9C21bE04D5aa71cE3B8Ed4F9021cC6b17E52';

  let browser;

  before(async () => {
    browser = await playwright.chromium.launch();
  });

  after(async () => {
    await browser?.close();
  });

  test('an eighteen-decimal amount and an itemised fee fit at 360px', async () => {
    const context = await browser.newContext({ viewport: PHONE });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));

    await page.route(`${PAGE}*`, (route) =>
      route.fulfill({ path: checkoutFile, contentType: 'text/html' }),
    );
    const payment = {
      invoiceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      chain: 'bsc',
      symbol: 'USDT',
      decimals: 18,
      amountDue: '20201005025125628140',
      amountPaid: '0',
      depositAddress: ADDRESS,
      memo: null,
      status: 'pending',
      toleranceBps: 50,
      feeIncluded: '100502512562814070',
      feeBps: 50,
      networkFeeIncluded: '24028834468625150',
      networkFeeBps: 12,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    };
    await page.route(`**/pay/${SESSION}/state`, (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          id: SESSION,
          merchantName: 'Example Store',
          description: 'Order 42',
          amountFiatMicros: '20000000',
          status: 'open',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          payment: null,
        }),
      }),
    );
    await page.route(`**/pay/${SESSION}/options`, (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          options: [
            {
              assetId: '11111111-1111-4111-8111-111111111111',
              symbol: 'USDT',
              name: 'USDT',
              chain: 'bsc',
              decimals: 18,
              amount: payment.amountDue,
              rateUsd: '995000000000000000',
              feeIncluded: payment.feeIncluded,
              feeBps: payment.feeBps,
              networkFeeIncluded: payment.networkFeeIncluded,
              networkFeeBps: payment.networkFeeBps,
              available: true,
              unavailableReason: null,
            },
          ],
        }),
      }),
    );
    await page.route(`**/pay/${SESSION}/select`, (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ changed: true, payment }) }),
    );

    await page.goto(`${PAGE}?s=${SESSION}`);
    await page.waitForFunction(() => document.querySelectorAll('#currencies .coin').length > 0, {
      timeout: 5000,
    });
    await page.click('#currencies .coin:has-text("USDT")');
    assert.equal(await overflow(page), 0, 'with the fee rows in the summary');

    await page.click('#to-pay');
    await page.waitForFunction(
      (expected) => document.getElementById('address')?.textContent.trim() === expected,
      ADDRESS,
      { timeout: 5000 },
    );

    assert.equal(await page.$eval('#amount', (node) => node.textContent.trim()), '20.20100502512562814');
    assert.equal(await overflow(page), 0, 'on the pay screen');
    // The whole figure on one line: a number broken across two is a number misread.
    assert.equal(await singleLine(page, '#amount'), true, 'the amount wrapped');
    assert.ok((await box(page, '#copy-amount')).height >= TAP);
    assert.deepEqual(errors, []);
    await context.close();
  });
});

describe('the receipt on a phone', { skip: playwright ? false : 'playwright is not installed' }, () => {
  let browser;

  before(async () => {
    browser = await playwright.chromium.launch();
  });

  after(async () => {
    await browser?.close();
  });

  test('the preview fits at 360px with the amount on one line', async () => {
    const context = await browser.newContext({ viewport: PHONE });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));

    await page.goto('file://' + receiptFile + '?preview=1');
    await page.waitForFunction(() => document.getElementById('content')?.hidden === false, {
      timeout: 5000,
    });

    assert.equal(await overflow(page), 0);
    // The preview's figure is the eighteen-decimal one, which is the hardest case.
    assert.equal(await page.$eval('#amount', (node) => node.textContent.trim()), '20.100502512562814071');
    assert.equal(await singleLine(page, '#amount'), true, 'the amount wrapped');

    for (const id of ['print', 'copy']) {
      assert.ok((await box(page, '#' + id)).height >= TAP, `#${id} is too short to tap`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
});

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

/**
 * The same pages in both themes.
 *
 * Light is the default and dark follows the system, and every colour comes from the shared
 * tokens — which is exactly what makes a regression here quiet: a token renamed, or a
 * rule that reaches for a colour only one palette defines, leaves text that is still on
 * the page and no longer readable. So the readable text is measured against whatever is
 * actually painted behind it, in each theme, at the WCAG threshold for body copy.
 *
 * And the QR frame: a scanner needs dark modules on white, and the dark theme is the one
 * place a frame that inherited its ground would silently stop scanning.
 */
describe('the checkout and the receipt in both themes', { skip: playwright ? false : 'playwright is not installed' }, () => {
  let browser;

  before(async () => {
    browser = await playwright.chromium.launch();
  });

  after(async () => {
    await browser?.close();
  });

  /** WCAG relative luminance and contrast, for a computed `rgb(...)` string. */
  const luminance = (rgb) => {
    const [r, g, b] = rgb.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((channel) => {
      const c = channel / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (fg, bg) => {
    const [light, dark] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
    return (light + 0.05) / (dark + 0.05);
  };

  /**
   * Every visible element matching each selector, with its ink and the first opaque ground
   * behind it. Text over a translucent ground is skipped: its composite is unknown from here.
   */
  const readable = (page, selectors) =>
    page.evaluate((list) => {
      const ground = (node) => {
        for (let el = node; el; el = el.parentElement) {
          const bg = getComputedStyle(el).backgroundColor;
          const alpha = bg.startsWith('rgba') ? Number(bg.match(/[\d.]+(?=\))/)[0]) : 1;
          if (alpha === 1 && bg !== 'rgba(0, 0, 0, 0)') return bg;
          if (alpha > 0 && alpha < 1) return null;
        }
        return getComputedStyle(document.body).backgroundColor;
      };
      const out = [];
      for (const selector of list) {
        const nodes = [...document.querySelectorAll(selector)].filter((node) => node.getBoundingClientRect().height > 0);
        if (nodes.length === 0) {
          out.push({ selector, missing: true });
          continue;
        }
        for (const node of nodes) {
          const bg = ground(node);
          if (bg !== null) out.push({ selector, fg: getComputedStyle(node).color, bg });
        }
      }
      return out;
    }, selectors);

  const assertReadable = (items, where) => {
    for (const item of items) {
      assert.ok(!item.missing, `${item.selector} is not on the page (${where}); update the list`);
      const ratio = contrast(item.fg, item.bg);
      assert.ok(ratio >= 4.5, `${item.selector}: ${item.fg} on ${item.bg} is ${ratio.toFixed(2)}:1 (${where})`);
    }
  };

  /** The text a payer reads as text, on the pay screen, with a memo showing. */
  const CHECKOUT_TEXT = [
    '.brand', '.brand-pay', '.invoice-ref', '.invoice-ref code', 'h1', '.eyebrow', '.step-title',
    '#status-text', '#amount', '.amount-unit', '.amount-exact', '.amount-exact strong', '.amount-fiat',
    '.lock-left', '.lock-time', '.chosen-label', '.chosen-net', '.chosen-time', '.link-btn',
    '.field-label', '.copyable code', '.copy-btn', '.memo-warning', '.memo-warning strong',
    'h2', '.summary-row dt', '.summary-row dd', '.fine', '.fine strong', '.foot', '.demo-bar', '.demo-bar strong', '.demo-btn',
  ];
  /** And on the first screen, where the choices are. */
  const CHOOSER_TEXT = [
    '.section-label', '.chooser-note', '.coin-sym', '.coin-name', '.coin-mark',
    '.coin[aria-checked="true"] .coin-sym', '.coin[aria-checked="true"] .coin-mark',
    '.net-name', '.net-time', '.net-cost', '.net-cost.free',
    '.net-row[aria-checked="true"] .net-name',
  ];
  const RECEIPT_TEXT = [
    '.brand', '.brand-pay', '.doc-label', '.number', '.rehearsal strong', '.rehearsal span',
    '.verdict-head', '.hero-label', '#amount', '.headline-unit', '.headline-fiat', 'h2',
    '.row dt', '.row dd', '.proof-note', 'button', 'button.primary', '.foot',
  ];

  for (const theme of ['light', 'dark']) {
    test(`checkout text reaches 4.5:1 against its ground (${theme})`, async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
      const page = await context.newPage();
      await page.goto(checkoutUrl);

      await page.click('#currencies .coin:has-text("Tether")');
      // The hint is on screen while a choice is still owed, and gone once it is made.
      assertReadable(await readable(page, ['.hint']), theme);
      await page.click('#networks .net-row:has-text("TON")');
      assertReadable(await readable(page, CHOOSER_TEXT), theme);

      await page.click('#to-pay');
      assertReadable(await readable(page, CHECKOUT_TEXT), theme);

      // The status line, in every colour it can take.
      for (const state of ['confirming', 'paid', 'underpaid', 'expired']) {
        await page.click(`[data-demo="${state}"]`);
        await page.waitForTimeout(120);
        // The rate lock goes once the payment is final, so its figure is only read before that.
        assertReadable(await readable(page, state === 'paid' ? ['#status-text'] : ['#status-text', '.lock-time']), `${theme}, ${state}`);
      }
      // The primary button, dark ink on lime in both themes.
      await page.click('[data-demo="awaiting"]');
      await page.click('#currencies .coin:has-text("Toncoin")');
      assertReadable(await readable(page, ['#to-pay']), theme);
      await context.close();
    });

    test(`receipt text reaches 4.5:1 against its ground (${theme})`, async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
      const page = await context.newPage();
      await page.goto('file://' + receiptFile + '?preview=1');
      await page.waitForFunction(() => document.getElementById('content')?.hidden === false, { timeout: 5000 });
      assertReadable(await readable(page, RECEIPT_TEXT), theme);
      await context.close();
    });
  }

  test('light is the default, and the attribute reaches the same dark palette as the system', async () => {
    const dark = await browser.newContext({ viewport: PHONE, colorScheme: 'dark' });
    const darkPage = await dark.newPage();
    await darkPage.goto(checkoutUrl);
    const system = await darkPage.$eval('body', (node) => getComputedStyle(node).backgroundColor);

    const light = await browser.newContext({ viewport: PHONE, colorScheme: 'light' });
    const lightPage = await light.newPage();
    await lightPage.goto(checkoutUrl);
    const daylight = await lightPage.$eval('body', (node) => getComputedStyle(node).backgroundColor);
    assert.ok(luminance(daylight) > 0.8, `the default ground is ${daylight}; light is the default`);
    assert.ok(luminance(system) < 0.05, `the system-dark ground is ${system}`);

    // The attribute reaches the same palette, so a host that sets it gets the same page.
    await lightPage.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    assert.equal(await lightPage.$eval('body', (node) => getComputedStyle(node).backgroundColor), system);
    await light.close();
    await dark.close();
  });

  test('the QR keeps its white frame in the dark theme too', async () => {
    /**
     * The one place the dark theme could do real harm. The frame is written in hex rather
     * than a token so that no palette can reach it; this is the test that notices if
     * somebody tidies that away.
     */
    for (const how of ['system', 'attribute']) {
      const context = await browser.newContext({ viewport: PHONE, colorScheme: how === 'system' ? 'dark' : 'light' });
      const page = await context.newPage();
      await page.goto(checkoutUrl);
      if (how === 'attribute') await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
      await page.click('#currencies .coin:has-text("Tether")');
      await page.click('#networks .net-row:has-text("BNB Chain")');
      await page.click('#to-pay');

      const frame = await page.$eval('#qr', (node) => {
        const style = getComputedStyle(node);
        return { background: style.backgroundColor, padding: parseFloat(style.paddingLeft) };
      });
      assert.equal(frame.background, 'rgb(255, 255, 255)', `dark by ${how}`);
      assert.ok(frame.padding >= 8, `the quiet zone is ${frame.padding}px (dark by ${how})`);
      assert.equal((await page.$eval('#qr svg rect', (node) => node.getAttribute('fill'))).toUpperCase(), '#FFFFFF');
      await context.close();
    }
  });

  test('no screen state scrolls sideways at 360px in the dark theme either', async () => {
    const context = await browser.newContext({ viewport: PHONE, colorScheme: 'dark' });
    const page = await context.newPage();
    await page.goto(checkoutUrl);
    assert.equal(await overflow(page), 0, 'before choosing anything');
    await page.click('#currencies .coin:has-text("Tether")');
    assert.equal(await overflow(page), 0, 'with the network list open');
    await page.click('#networks .net-row:has-text("TON")');
    await page.click('#to-pay');
    assert.equal(await overflow(page), 0, 'on the pay screen with a memo');
    for (const state of ['confirming', 'paid', 'underpaid', 'expired']) {
      await page.click(`[data-demo="${state}"]`);
      await page.waitForTimeout(120);
      assert.equal(await overflow(page), 0, `while ${state}`);
    }
    // The selectable rows keep their height whatever the palette.
    await page.click('[data-demo="awaiting"]');
    await page.click('#currencies .coin:has-text("Tether")');
    const rows = await page.$$eval('#currencies .coin, #networks .net-row', (nodes) =>
      nodes.map((node) => node.getBoundingClientRect().height),
    );
    assert.ok(rows.length >= 8);
    for (const height of rows) assert.ok(height >= TAP, `a selectable row is ${height}px tall`);
    await context.close();
  });
});

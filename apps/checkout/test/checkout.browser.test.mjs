import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Drives the built checkout page in a real browser.
 *
 * The page has no framework and no module system — it is one file of hand-written
 * DOM code — so the only thing that can tell us a selection actually enables a
 * button, or that a stale address was cleared, is running it. Reading the diff
 * cannot: this file has already shipped a `hidden` attribute that did not hide,
 * because an author `display: flex` beats the user-agent `[hidden]` rule, and a
 * probe that read the `.hidden` property said everything was fine.
 *
 * So every assertion about visibility here measures rendered height rather than
 * asking the element what it thinks.
 *
 * Skipped when Playwright is not installed, which keeps `npm test` runnable on a
 * machine that has never fetched a browser.
 */

const here = dirname(fileURLToPath(import.meta.url));
const pageUrl = 'file://' + join(here, '..', 'public', 'checkout.html');

/**
 * Playwright is a global install in this environment rather than a dependency,
 * so it is resolved by path with a bare specifier as the fallback.
 */
const CANDIDATES = ['/opt/node22/lib/node_modules/playwright/index.mjs', 'playwright'];

async function loadPlaywright() {
  for (const candidate of CANDIDATES) {
    if (candidate.startsWith('/') && !existsSync(candidate)) continue;
    try {
      return await import(candidate);
    } catch {
      // Try the next one. A missing browser is a skip, not a failure.
    }
  }
  return null;
}

const playwright = await loadPlaywright();

describe('checkout, in a browser', { skip: playwright ? false : 'playwright is not installed' }, () => {
  let browser;
  let page;
  const errors = [];

  before(async () => {
    browser = await playwright.chromium.launch();
    page = await browser.newPage({ viewport: { width: 430, height: 900 } });
    // An uncaught exception in the page would otherwise leave the DOM half-rendered,
    // and the assertions would report a confusing symptom instead of the cause.
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push('console: ' + message.text());
    });
    await page.goto(pageUrl);
  });

  after(async () => {
    await browser?.close();
  });

  /** Rendered height, not the `hidden` property — see the note at the top. */
  const shown = (selector) =>
    page.$eval(selector, (node) => node.getBoundingClientRect().height > 0).catch(() => false);
  const text = (selector) => page.$eval(selector, (node) => node.textContent.trim());
  const list = (selector) => page.$$eval(selector, (nodes) => nodes.map((n) => n.textContent.trim()));
  const disabled = (selector) => page.$eval(selector, (node) => node.disabled);
  const checkedCount = async (selector) => (await page.$$(selector + '[aria-checked="true"]')).length;

  const reset = async () => {
    await page.click('[data-demo="awaiting"]');
    await page.waitForTimeout(80);
  };

  test('every currency offered is one we can settle', async () => {
    const coins = await list('#currencies .coin .coin-sym');
    assert.deepEqual(coins, ['USDT', 'USDC', 'TON', 'ETH', 'BNB', 'SOL', 'TRX', 'POL']);
    /**
     * The absences matter more than the entries. BTC, LTC and DOGE are what a payer
     * most expects to see, and AVEX has no UTXO adapter — offering them would take a
     * payment we could not deliver to the merchant.
     */
    for (const absent of ['BTC', 'LTC', 'DOGE', 'XMR']) {
      assert.ok(!coins.includes(absent), absent + ' cannot be settled and must not be offered');
    }
  });

  test('the network step waits for a currency', async () => {
    await reset();
    // An empty network table drawn before a currency is chosen reads as a failure to
    // load, so the section is absent rather than blank.
    assert.equal(await shown('#net-step'), false);
    assert.equal(await disabled('#to-pay'), true);
    assert.match(await text('#choose-hint'), /Pick a currency/);
  });

  test('a currency reveals only the networks that carry it', async () => {
    await reset();
    await page.click('#currencies .coin:has-text("Tether")');

    assert.equal(await shown('#net-step'), true);
    const networks = await list('#networks .net-name');
    assert.deepEqual(networks, ['TON', 'Solana', 'TRON', 'Ethereum', 'BNB Chain', 'Polygon']);
    // Cheapest first: the option that costs the payer least is read before any other.
    assert.equal(networks[0], 'TON');
  });

  test('nothing is preselected when there is a wrong choice to make', async () => {
    /**
     * Paying on the wrong chain cannot be reversed, so among several networks the
     * payer must choose deliberately rather than accept a default they walked past.
     */
    await reset();
    await page.click('#currencies .coin:has-text("Tether")');

    assert.equal(await checkedCount('#networks .net-row'), 0);
    assert.equal(await disabled('#to-pay'), true);
    assert.match(await text('#choose-hint'), /Pick a network/);
  });

  test('a currency on one network only is selected for the payer', async () => {
    // The mirror of the rule above: with a single option there is no wrong choice,
    // so a second click would be friction that buys no safety.
    await reset();
    await page.click('#currencies .coin:has-text("Toncoin")');

    assert.deepEqual(await list('#networks .net-name'), ['TON']);
    assert.equal(await checkedCount('#networks .net-row'), 1);
    assert.equal(await disabled('#to-pay'), false);
    assert.match(await text('#net-note'), /one network only/);
  });

  test('changing the currency clears the network', async () => {
    /**
     * The bug this prevents loses money. A payer who picked USDT on TRON and then
     * switched to USDC would, if the selection survived, be shown a TRON address for
     * a token we do not accept there.
     */
    await reset();
    await page.click('#currencies .coin:has-text("Tether")');
    await page.click('#networks .net-row:has-text("TRON")');
    assert.equal(await disabled('#to-pay'), false);

    await page.click('#currencies .coin:has-text("USD Coin")');
    assert.equal(await checkedCount('#networks .net-row'), 0);
    assert.equal(await disabled('#to-pay'), true);
    // And TRON is gone from the list, because USDC is not offered there.
    assert.ok(!(await list('#networks .net-name')).includes('TRON'));
  });

  test('the amount is the invoice plus the network fee, rounded up', async () => {
    /**
     * Up, never down. (20 + 0.014) / 3410 is 0.005869203…, so the payer is asked for
     * 0.005870 — rounding down would leave every invoice a fraction short and read
     * as an underpayment.
     */
    await reset();
    await page.click('#currencies .coin:has-text("Ethereum")');

    assert.equal(await text('#amount'), '0.005870');
    assert.equal(await text('#amount-unit'), 'ETH');
  });

  test('the same rule at two decimals', async () => {
    // (20 + 0.015) / 1 = 20.015, shown as 20.02 rather than 20.01.
    await reset();
    await page.click('#currencies .coin:has-text("Tether")');
    await page.click('#networks .net-row:has-text("BNB Chain")');

    assert.equal(await text('#amount'), '20.02');
    assert.equal(await text('#amount-unit'), 'USDT');
  });

  test('the rate is blank until a currency is chosen, then follows it', async () => {
    // A hardcoded "1 USDT = $1.00" was here before, wrong twice over: shown before
    // anything was picked, and still shown after picking ETH.
    await reset();
    assert.equal(await text('#summary-rate'), '—');

    await page.click('#currencies .coin:has-text("Tether")');
    assert.equal(await text('#summary-rate'), '1 USDT = $1.00');

    await page.click('#currencies .coin:has-text("Ethereum")');
    assert.equal(await text('#summary-rate'), '1 ETH = $3,410.00');
  });

  test('continuing shows the address for the chosen chain', async () => {
    await reset();
    await page.click('#currencies .coin:has-text("Tether")');
    await page.click('#networks .net-row:has-text("BNB Chain")');
    await page.click('#to-pay');

    assert.equal(await shown('#screen-pay'), true);
    assert.equal(await shown('#screen-network'), false);
    assert.equal(await text('#address'), '0x7A3f9C21bE04D5aa71cE3B8Ed4F9021cC6b17E52');
    // Both halves of the choice, restated where the payer is about to act on them.
    assert.equal(await text('#chosen-net'), 'USDT on BNB Chain');
    assert.equal(await text('#summary-network'), 'USDT · BNB Chain');
    assert.equal(await page.$$eval('#qr svg', (nodes) => nodes.length), 1);
  });

  test('a memo appears on the chain that needs one, and only there', async () => {
    /**
     * On TON the memo is what identifies the invoice. Omitting it sends money to a
     * shared address with nothing tying it to this payment, so it has to be as
     * prominent as the address — and absent everywhere it would confuse.
     */
    await reset();
    await page.click('#currencies .coin:has-text("Tether")');
    await page.click('#networks .net-row:has-text("BNB Chain")');
    await page.click('#to-pay');
    assert.equal(await shown('#memo-block'), false);

    await page.click('#back-to-network');
    await page.click('#networks .net-row:has-text("TON")');
    await page.click('#to-pay');
    assert.equal(await shown('#memo-block'), true);
  });

  test('the address does not survive a change of currency', async () => {
    // The one piece of state that must never go stale: an address from the previous
    // chain still on screen would be funded on a chain that cannot deliver it.
    await reset();
    await page.click('#currencies .coin:has-text("Tether")');
    await page.click('#networks .net-row:has-text("TON")');
    await page.click('#to-pay');
    const tonAddress = await text('#address');

    await page.click('#back-to-network');
    await page.click('#currencies .coin:has-text("USD Coin")');
    assert.equal(await text('#address'), '—');

    await page.click('#networks .net-row:has-text("Polygon")');
    assert.notEqual(await text('#address'), tonAddress);
  });

  test('once a transfer is seen the choice is locked', async () => {
    // The address is fixed the moment money is on its way to it, so changing the
    // chain afterwards could only mislead.
    await reset();
    await page.click('#currencies .coin:has-text("Tether")');
    await page.click('#networks .net-row:has-text("TON")');
    await page.click('#to-pay');
    await page.click('[data-demo="confirming"]');
    await page.waitForTimeout(200);

    assert.equal(await disabled('#back-to-network'), true);
    assert.equal(await text('#back-to-network'), 'Locked in');
  });

  test('the page ran without throwing', () => {
    // Last, so it covers every interaction above rather than only the initial load.
    assert.deepEqual(errors, []);
  });
});

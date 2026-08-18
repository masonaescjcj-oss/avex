import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The staff panel in a browser, driven by its own preview fixtures.
 *
 * This is the panel's first DOM test, and preview mode is what made it cheap: the page
 * stubs its own transport, so a test needs no API and no route table of its own — which
 * means every section renders through exactly the fetch path it uses in production.
 *
 * What these check is the thing unit tests on `permissions.ts` cannot: that each section
 * actually renders, with the numbers in the right places, rather than falling to "could not
 * load this section". A panel whose job is to be trusted when something is broken cannot
 * itself look broken.
 */

const here = dirname(fileURLToPath(import.meta.url));
const PAGE = 'https://admin.test/admin.html';
const pageFile = join(here, '..', 'public', 'admin.html');

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

describe('staff panel', { skip: playwright ? false : 'playwright is not installed' }, () => {
  let browser;

  before(async () => {
    browser = await playwright.chromium.launch();
  });

  after(async () => {
    await browser?.close();
  });

  async function open() {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push('console: ' + message.text());
    });

    await page.route(`${PAGE}*`, (route) =>
      route.fulfill({ path: pageFile, contentType: 'text/html' }),
    );
    // Anything escaping the page's own stub is a failure, not a silent network call.
    await page.route('**/admin/**', (route) => route.abort());

    await page.goto(`${PAGE}?preview=1`);
    await page
      .waitForFunction(() => document.getElementById('panel')?.hidden === false, { timeout: 6000 })
      .catch(() => {});

    return { page, context, errors };
  }

  const shown = (page, selector) =>
    page.$eval(selector, (node) => node.getBoundingClientRect().height > 0).catch(() => false);
  const text = (page, selector) =>
    page.$eval(selector, (node) => node.textContent.replace(/\s+/g, ' ').trim());

  const section = async (page, label) => {
    await page.click(`#nav .nav-btn:has-text("${label}")`);
    await page.waitForTimeout(200);
    return text(page, '#view');
  };

  test('the panel opens without a server, and says it is a preview', async () => {
    const { page, context, errors } = await open();
    assert.equal(await shown(page, '#panel'), true);
    assert.equal(await shown(page, '#signin-screen'), false);
    assert.deepEqual(errors, []);

    // Said before anything else and not dismissible: a panel full of plausible figures that
    // somebody takes for their real system is worse than no preview.
    assert.equal(await shown(page, '#preview-banner'), true);
    assert.match(await text(page, '#preview-banner'), /made up|not your system/i);
    await context.close();
  });

  test('every section in the nav renders rather than erroring', async () => {
    /**
     * The failure this guards is the one that made the preview worth building: a section
     * whose fixture is the wrong shape falls to "could not load this section", and a panel
     * that looks broken is useless for evaluating a panel.
     */
    const { page, context, errors } = await open();
    const labels = await page.$$eval('#nav .nav-btn', (nodes) =>
      nodes.map((node) => node.textContent.replace(/\s+/g, ' ').trim().replace(/^\S+\s*/, '').replace(/\d+$/, '').trim()),
    );
    assert.ok(labels.length >= 6, labels.join(' | '));

    for (const label of labels) {
      const body = await section(page, label);
      assert.doesNotMatch(body, /Could not load/i, `${label} failed to render`);
      assert.doesNotMatch(body, /\bnull\b/, `${label} rendered a literal null`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('health leads with the watcher that has stopped', async () => {
    // The reason this section exists. A lagging watcher is not seeing payments and nothing
    // else looks wrong while it happens.
    const { page, context } = await open();
    const body = await section(page, 'Health');
    assert.match(body, /ton/);
    assert.match(body, /liteserver timed out/);
    await context.close();
  });

  test('revenue shows earned and swept as separate figures', async () => {
    /**
     * The gap between them is the useful part: one is commission the chain owes us, the
     * other is what has reached a collector. A single number would overstate what we hold.
     */
    const { page, context } = await open();
    const body = await section(page, 'Revenue');
    assert.match(body, /\$1,268\.60/);
    assert.match(body, /\$1,181\.50/);
    assert.match(body, /Awaiting sweep/);
    await context.close();
  });

  test('a negotiated rate is marked in the revenue table', async () => {
    // The ladder is not moving it, so nobody will notice if the deal has gone stale.
    const { page, context } = await open();
    await section(page, 'Revenue');
    const marked = await page.$$eval('#view tbody tr', (rows) =>
      rows
        .filter((row) => row.querySelector('.tag[data-tone="warn"], .tag.warn'))
        .map((row) => row.textContent.replace(/\s+/g, ' ').trim()),
    );
    assert.ok(marked.length >= 1, 'the negotiated account should stand out');
    await context.close();
  });

  test('the currency catalogue separates approved from offered, and says why', async () => {
    /**
     * The distinction the whole section turns on. Every operator who opens this will be
     * about to conflate the two columns, because "approved" and "offered" sound like the
     * same thing until somebody explains that they are not.
     */
    const { page, context } = await open();
    const body = await section(page, 'Currencies');

    assert.match(body, /Approved is not the same as offered/);
    assert.match(body, /watcher and price feed/);
    // Grouped by chain, because that is the unit of the decision.
    assert.match(body, /solana/);
    assert.match(body, /offered to merchants/);
    await context.close();
  });

  test('the catalogue shows every chain the platform supports', async () => {
    /**
     * The regression this guards, and it was a real one: the preview carried five of sixteen
     * curated entries by hand, and somebody reading it reasonably concluded the platform
     * supported three chains. The fixture is now the curated list itself.
     */
    const { page, context } = await open();
    await section(page, 'Currencies');

    const chains = await page.$$eval('#view h2', (nodes) => nodes.map((node) => node.textContent));
    for (const chain of ['bsc', 'ethereum', 'polygon', 'solana', 'ton', 'tron']) {
      assert.ok(chains.includes(chain), `${chain} is missing: ${chains.join(', ')}`);
    }
    // USDT, USDC and a native asset on the chains that carry all three.
    const body = await text(page, '#view');
    assert.match(body, /USDT/);
    assert.match(body, /USDC/);
    assert.match(body, /BNB/);
    assert.match(body, /ETH/);
    await context.close();
  });

  test('a stablecoin the catalogue lacks is named rather than left absent', async () => {
    /**
     * An absence has no row to render, so it can only be shown deliberately. Without this a
     * chain missing USDC looks exactly like a chain where we decided against it, and the
     * only person who finds out is a merchant who cannot enable it.
     */
    const { page, context } = await open();
    await section(page, 'Currencies');

    const notice = await text(page, '#view .notice.warn');
    assert.match(notice, /Not in the catalogue/);
    assert.match(notice, /USDC on ton/);
    assert.match(notice, /USDC on tron/);
    // And it says what would close it, because "not yet" is a note to nobody.
    assert.match(notice, /issuer/);
    await context.close();
  });

  test('a vetted currency we are not offering shows as approved and closed', async () => {
    // The state the section exists for: a contract we trust on a chain we are not ready for.
    const { page, context } = await open();
    await section(page, 'Currencies');

    const rows = await page.$$eval('#view tbody tr', (nodes) =>
      nodes.map((node) => node.textContent.replace(/\s+/g, ' ').trim()),
    );
    const solana = rows.find((row) => /USDC/.test(row) && /no/.test(row));
    assert.ok(solana, rows.join(' || '));
    assert.match(solana, /approved/);
    // And the control offered is to open it, not to re-approve it.
    assert.ok(await page.$('#view button:has-text("Open")'));
    await context.close();
  });

  test('a currency nothing can price is marked as needing the merchant rate', async () => {
    /**
     * It decides what a merchant has to do next, and it is worth knowing before offering a
     * currency rather than after the first support message.
     */
    const { page, context } = await open();
    const body = await section(page, 'Currencies');
    assert.match(body, /merchant sets rate/);
    assert.match(body, /quoted/);
    await context.close();
  });

  test('closing a currency states how many merchants it affects', async () => {
    /**
     * The size of the act. "Close USDT on BSC" and "close USDT on BSC, which two merchants
     * are accepting" are different decisions, and the dialog has to be the second one.
     */
    const { page, context } = await open();
    await section(page, 'Currencies');
    await page.click('#view button:has-text("Close")');
    await page.waitForTimeout(200);

    const modal = await text(page, '.modal');
    assert.match(modal, /merchant\(s\) are accepting this right now/);
    assert.match(modal, /Invoices already open still complete/);
    await context.close();
  });

  test('adding a currency warns that it bypasses the probe', async () => {
    /**
     * The most damaging action in the panel. It adds an already-approved asset without
     * probing, so a mistyped address becomes an approved currency for every merchant at
     * once — and the whole defence against a token calling itself USDT is knowing where the
     * real one lives.
     */
    const { page, context } = await open();
    await section(page, 'Currencies');
    await page.click('#view button:has-text("Add a currency")');
    await page.waitForTimeout(200);

    const modal = await text(page, '.modal');
    assert.match(modal, /without probing the contract/);
    assert.match(modal, /issuer/);
    await context.close();
  });

  test('a merchant can be opened from the list, with its commission on the page', async () => {
    /**
     * The regression this guards: whoever can change an account's rate has to see it first,
     * and the rate arrives in the same request as the rest of the merchant.
     */
    const { page, context, errors } = await open();
    await section(page, 'Merchants');
    await page.click('#view tr.clickable');
    await page.waitForTimeout(300);

    const body = await text(page, '#view');
    assert.match(body, /Kian Digital/);
    assert.match(body, /Commission/);
    assert.match(body, /0\.5%/);
    // Earned and swept, again as two figures.
    assert.match(body, /\$92\.20/);
    assert.match(body, /\$90\.10/);
    // And the control to change it, since this staff member holds `staff:write`.
    assert.ok(await page.$('#view button:has-text("Change rate")'));
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('who bears the commission is stated, not offered as a control', async () => {
    /**
     * Read-only on purpose, and the panel says why rather than leaving an operator hunting
     * for a switch: it changes what the merchant's own customers are asked to pay. We
     * receive the same either way, so staff setting it would be us setting their prices.
     */
    const { page, context } = await open();
    await section(page, 'Merchants');
    await page.click('#view tr.clickable');
    await page.waitForTimeout(300);

    const body = await text(page, '#view');
    assert.match(body, /absorb the commission|customers pay the commission/i);
    assert.match(body, /themselves/i);
    await context.close();
  });

  test('a change is refused rather than appearing to work', async () => {
    // Suspending a merchant in a preview must not look successful.
    const { page, context } = await open();
    await section(page, 'Merchants');
    await page.click('#view tr.clickable');
    await page.waitForTimeout(300);

    await page.click('#view button:has-text("Suspend")');
    await page.waitForTimeout(150);
    await page.fill('#f-reason', 'Testing that a preview refuses writes.');
    await page.click('#modal-confirm');
    await page.waitForTimeout(250);

    assert.equal(await shown(page, '#modal-error'), true);
    assert.match(await text(page, '#modal-error'), /nothing here can be changed/i);
    await context.close();
  });

  test('the page declares its own character set', async () => {
    // Without it the em dashes and the section markers come out as mojibake.
    const { page, context } = await open();
    assert.equal(
      await page.$eval('meta[charset]', (node) => node.getAttribute('charset').toLowerCase()),
      'utf-8',
    );
    await context.close();
  });
});

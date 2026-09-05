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

  test('a stablecoin the issuer never minted reads as an answer, not a task', async () => {
    /**
     * The most important thing on this section, and the least obvious. USDC on TRON *used to*
     * exist — Circle stopped minting it in February 2024 — so its contract is still on chain,
     * still findable, and would probe perfectly well. Showing it as "missing, go and add it"
     * is how somebody ends up approving a token whose issuer no longer redeems it.
     *
     * So it renders as a statement with the issuer's reason, and not in the same notice as
     * things that genuinely are outstanding work.
     */
    const { page, context } = await open();
    await section(page, 'Currencies');

    const notices = await page.$$eval('#view .notice', (nodes) =>
      nodes.map((node) => node.textContent.replace(/\s+/g, ' ').trim()),
    );
    const closed = notices.find((notice) => /Not offered by the issuer/.test(notice));
    assert.ok(closed, notices.join(' || '));
    assert.match(closed, /USDC on ton/);
    assert.match(closed, /USDC on tron/);
    // The counter-intuitive part is spelled out rather than summarised.
    assert.match(closed, /discontinued|does not issue/i);

    // And it is not in the "worth adding" notice, because there is nothing to add.
    assert.ok(!notices.some((notice) => /Missing and worth adding/.test(notice)));
    await context.close();
  });

  test('the catalogue says who stands behind each token', async () => {
    /**
     * Three curated entries are bridged and none is a Tether or Circle liability. Both
     * issuers omit those chains from their own supported lists, which is how we know — and a
     * bridged token depends on its custodian as well as on the issuer's reserves.
     */
    const { page, context } = await open();
    await section(page, 'Currencies');

    const bridged = await page.$$eval('#view tbody tr', (rows) =>
      rows
        .filter((row) => [...row.querySelectorAll('.tag')].some((tag) => tag.textContent === 'bridged'))
        .map((row) => row.querySelector('td')?.textContent?.trim().split('\n')[0]),
    );
    assert.ok(bridged.length >= 3, `expected the Binance-Peg rows: ${bridged.join(', ')}`);

    // And the note behind the badge is available on hover rather than only in the code.
    const title = await page.$eval('#view .tag.warn', (node) => node.getAttribute('title'));
    assert.match(title ?? '', /Peg|Bridged|bridged/);
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

  test("a merchant's balance is on the page, with both ways to move it", async () => {
    /**
     * Why it is here and not behind a click: a support call about a raised fee starts on this
     * screen, and the answer is the statement. An operator who does not know the screen exists
     * cannot answer the question.
     *
     * Two buttons rather than one signed amount field, because "they paid us" and "we wrote it
     * off" are different claims about the world and the merchant reads this statement.
     */
    const { page, context, errors } = await open();
    await section(page, 'Merchants');
    await page.click('#view tr.clickable');
    await page.waitForTimeout(300);

    const body = await text(page, '#view');
    assert.match(body, /Balance/);
    assert.match(body, /-\$0\.32/, 'the balance, signed');
    assert.match(body, /accrual/);
    assert.match(body, /recovery/);
    assert.ok(await page.$('#view button:has-text("They paid us")'));
    assert.ok(await page.$('#view button:has-text("Adjust")'));
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('recording a payment asks for dollars and refuses to pretend it worked', async () => {
    /**
     * Two things at once, both learned the hard way.
     *
     * The field is in dollars: an operator typing micro-dollars will eventually type one zero
     * too many, and a wrong balance looks exactly like one somebody meant. And the preview
     * refuses the write rather than showing a success it cannot deliver — the whole point of
     * building the preview as a network stub.
     */
    const { page, context } = await open();
    await section(page, 'Merchants');
    await page.click('#view tr.clickable');
    await page.waitForTimeout(300);

    await page.click('#view button:has-text("They paid us")');
    await page.waitForTimeout(150);
    const modal = await text(page, '#modal-root');
    assert.match(modal, /Amount paid \(USD\)/);
    assert.match(modal, /shown to them/, 'the note reaches the merchant, and says so');
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

/**
 * The panel as a layout: the rail and the drawer, the tables at a phone's width, and the
 * text against whatever is painted behind it, in both themes.
 *
 * Every colour comes from the shared tokens, which is what makes a regression here quiet: a
 * rule that reaches for a colour only one palette defines leaves text that is still on the
 * page and no longer readable. Measured, not read — a stylesheet that says `--ink` can
 * still ship grey on grey when another rule wins.
 */
describe('staff panel, as a layout', { skip: playwright ? false : 'playwright is not installed' }, () => {
  const PHONE = { width: 360, height: 780 };
  let browser;

  before(async () => {
    browser = await playwright.chromium.launch();
  });

  after(async () => {
    await browser?.close();
  });

  async function open({ width = 1280, theme = 'light' } = {}) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.route(`${PAGE}*`, (route) => route.fulfill({ path: pageFile, contentType: 'text/html' }));
    await page.route('**/admin/**', (route) => route.abort());
    await page.goto(`${PAGE}?preview=1`);
    await page.waitForFunction(() => document.getElementById('panel')?.hidden === false, { timeout: 6000 });
    return { page, context, errors };
  }

  /**
   * The section labels, read from the text node between the marker and the count. The
   * button's text runs marker, label and count together with no space, so a regex that
   * strips "the first word" strips the lot.
   */
  const labels = (page) =>
    page.$$eval('#nav .nav-btn', (nodes) =>
      nodes.map((node) =>
        [...node.childNodes].filter((child) => child.nodeType === 3).map((child) => child.textContent.trim()).join(''),
      ),
    );

  const overflow = (page) =>
    page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  const shown = (page, selector) =>
    page.$eval(selector, (node) => node.getBoundingClientRect().height > 0).catch(() => false);

  /** Is the rail inside the viewport, horizontally? Off-canvas is a transform, not `hidden`. */
  const railOnScreen = (page) =>
    page.$eval('#side', (node) => node.getBoundingClientRect().right > 0);

  test('every section fits at 360px, through the drawer', async () => {
    /**
     * The rail becomes a drawer on a phone, so each section is reached the way a phone
     * reaches it: open the drawer, pick, and the drawer closes on its own. The widest
     * tables — the watchers, the catalogue — scroll inside their card rather than
     * widening the page.
     */
    const { page, context, errors } = await open({ width: PHONE.width });
    assert.equal(await railOnScreen(page), false, 'the rail should start off screen on a phone');
    assert.equal(await overflow(page), 0, 'on opening');

    const names = await labels(page);
    assert.ok(names.length >= 6, names.join(' | '));
    for (const name of names) {
      await page.click('#nav-toggle');
      await page.waitForTimeout(250);
      assert.equal(await railOnScreen(page), true, `the drawer did not open for ${name}`);
      assert.equal(await shown(page, '#nav-scrim'), true);
      await page.click(`#nav .nav-btn:has-text("${name}")`);
      await page.waitForTimeout(350);
      assert.equal(await railOnScreen(page), false, `the drawer stayed open after picking ${name}`);
      assert.equal(await overflow(page), 0, `${name} is wider than the phone`);
      // The bar stays a bar. A short section once arrived under one half the screen tall,
      // because the shell's minimum height was shared out between its rows.
      const bar = await page.$eval('.topbar', (node) => node.getBoundingClientRect().height);
      assert.ok(bar <= 64, `the top bar is ${bar}px tall on ${name}`);
    }

    // The detail page, with its tables and its two blocks.
    await page.click('#nav-toggle');
    await page.click('#nav .nav-btn:has-text("Merchants")');
    await page.waitForTimeout(300);
    await page.click('#view tr.clickable');
    await page.waitForTimeout(300);
    assert.equal(await overflow(page), 0, 'the merchant page is wider than the phone');

    // And a dialog.
    await page.click('#view button:has-text("Suspend")');
    await page.waitForTimeout(150);
    assert.equal(await overflow(page), 0, 'the dialog is wider than the phone');
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('the rail is in view on a desktop and the drawer controls are not', async () => {
    const { page, context } = await open();
    assert.equal(await railOnScreen(page), true);
    assert.equal(await shown(page, '#nav-toggle'), false, 'a desktop needs no menu button');
    assert.equal(await overflow(page), 0);
    // Table headers stay put: the rows scroll under them inside the card.
    await page.click('#nav .nav-btn:has-text("Health")');
    await page.waitForTimeout(200);
    assert.equal(await page.$eval('#view th', (node) => getComputedStyle(node).position), 'sticky');
    await context.close();
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

  /** Every visible element matching each selector, with its ink and the opaque ground behind it. */
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

  /** What an operator reads on the health section, which shows every tone at once. */
  const HEALTH_TEXT = [
    '#preview-banner', '#preview-banner strong', '.brand', '.brand-accent', '.brand-sub',
    '.nav-btn', '.nav-btn[aria-current="true"]', '.nav-count', '.nav-count.alert',
    '.role-pill', '.whoami-email', '#sign-out',
    'h1', '.sub', 'h2', '.metric-label', '.metric-value', '.metric.bad .metric-value',
    '.metric.warn .metric-value', '.metric.good .metric-value',
    'th', 'td', 'td strong', 'td .faint', '.tag', '.tag.ok', '.tag.bad',
    '.notice', '.notice strong', '.btn',
  ];
  /** And on a merchant's page: the destructive button, the primary one, and a dialog. */
  const MERCHANT_TEXT = ['.btn.danger', '.btn.primary', '.btn.ghost', '.tag.lime', '.tag.warn', '.block h2', '.block p'];
  const MODAL_TEXT = ['.modal h2', '.modal-note', '.field-label', '.modal .btn.danger', '.modal .btn.ghost', 'textarea'];

  for (const theme of ['light', 'dark']) {
    test(`text reaches 4.5:1 against its ground (${theme})`, async () => {
      const { page, context } = await open({ theme });
      assertReadable(await readable(page, HEALTH_TEXT), `${theme}, health`);

      await page.click('#nav .nav-btn:has-text("Merchants")');
      await page.waitForTimeout(250);
      await page.click('#view tr.clickable');
      await page.waitForTimeout(300);
      assertReadable(await readable(page, MERCHANT_TEXT), `${theme}, merchant`);

      await page.click('#view button:has-text("Suspend")');
      await page.waitForTimeout(150);
      assertReadable(await readable(page, MODAL_TEXT), `${theme}, dialog`);
      await context.close();
    });
  }

  test('light is the default and the attribute reaches the same dark palette as the system', async () => {
    const { page, context } = await open({ theme: 'light' });
    const daylight = await page.$eval('body', (node) => getComputedStyle(node).backgroundColor);
    assert.ok(luminance(daylight) > 0.8, `the default ground is ${daylight}`);

    const dark = await open({ theme: 'dark' });
    const system = await dark.page.$eval('body', (node) => getComputedStyle(node).backgroundColor);
    assert.ok(luminance(system) < 0.05, `the system-dark ground is ${system}`);

    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    assert.equal(await page.$eval('body', (node) => getComputedStyle(node).backgroundColor), system);
    await dark.context.close();
    await context.close();
  });
});

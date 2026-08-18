import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The receipt page against a stubbed API.
 *
 * Stubbed at the network layer, like the checkout page's tests, so what is under test is
 * the real fetch path. Two things here matter more than anywhere else in this product: a
 * test receipt must be unmistakable — it is the document somebody could file as proof of
 * a payment that never happened — and a transaction hash must never reach an href without
 * being what it claims to be.
 */

const here = dirname(fileURLToPath(import.meta.url));
const PAGE = 'https://checkout.test/receipt.html';
const pageFile = join(here, '..', 'public', 'receipt.html');

const SESSION = '3f6b1c20-8a11-4b2e-9c47-1d5e2a8b7c90';
const HASH = `0x${'ab'.repeat(32)}`;

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

const RECEIPT = {
  number: 'AVEX-4D2A9C1B',
  status: 'paid',
  merchantName: 'Example Store',
  description: 'Order 42',
  reference: 'order-42',
  mode: 'live',
  amountFiatMicros: '20000000',
  symbol: 'USDT',
  decimals: 18,
  amountDue: '20100502512562814071',
  amountPaid: '20100502512562814071',
  chain: 'bsc',
  depositAddress: '0x7A3f9C21bE04D5aa71cE3B8Ed4F9021cC6b17E52',
  memo: null,
  transfers: [{ txHash: HASH, amount: '20100502512562814071', blockNumber: 700, at: '2026-08-18T09:04:00.000Z' }],
  feeBps: 0,
  feeIncluded: '0',
  issuedAt: '2026-08-18T09:00:00.000Z',
  paidAt: '2026-08-18T09:04:00.000Z',
};

describe('receipt', { skip: playwright ? false : 'playwright is not installed' }, () => {
  let browser;

  before(async () => {
    browser = await playwright.chromium.launch();
  });

  after(async () => {
    await browser?.close();
  });

  async function open(behaviour = {}) {
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
    await page.route(`**/pay/${SESSION}/receipt`, (route) =>
      route.fulfill({
        status: behaviour.status ?? 200,
        contentType: 'application/json',
        body: JSON.stringify(behaviour.body ?? { ...RECEIPT, ...(behaviour.receipt ?? {}) }),
      }),
    );

    await page.goto(`${PAGE}?s=${SESSION}`);
    await page
      .waitForFunction(
        () =>
          document.getElementById('content')?.hidden === false ||
          document.getElementById('fatal')?.hidden === false,
        { timeout: 5000 },
      )
      .catch(() => {});

    return { page, context, errors };
  }

  const shown = (page, selector) =>
    page.$eval(selector, (node) => node.getBoundingClientRect().height > 0).catch(() => false);
  const text = (page, selector) => page.$eval(selector, (node) => node.textContent.trim());

  test('a settled payment reads as settled, with the amount actually sent', async () => {
    const { page, context, errors } = await open();
    assert.deepEqual(errors, []);

    assert.equal(await text(page, '#number'), 'AVEX-4D2A9C1B');
    assert.match(await text(page, '#verdict-head'), /Paid in full/);
    /**
     * The token amount is the headline and the dollar figure sits under it. What the payer
     * sent is the token amount; the dollar figure was a conversion at one moment, and
     * leading with it would make this read as a fiat invoice, which is not what happened.
     */
    assert.equal(await text(page, '#amount'), '20.100502512562814071');
    assert.equal(await text(page, '#unit'), 'USDT');
    assert.match(await text(page, '#fiat'), /\$20\.00/);
    assert.equal(await shown(page, '#verdict-note'), false, 'nothing is outstanding');
    await context.close();
  });

  test('the transaction hash links to the right chain explorer', async () => {
    // The only line on the page a payer can check without trusting us.
    const { page, context } = await open();
    const href = await page.$eval('#transfers a', (node) => node.href);
    assert.equal(href, `https://bscscan.com/tx/${HASH}`);
    assert.equal(await page.$eval('#transfers a', (node) => node.textContent.trim()), HASH);
    await context.close();
  });

  test('a hash that is not one never reaches an href', async () => {
    /**
     * The hash comes from the API and lands in a link. Two defences: `explorerUrl` refuses
     * anything not hash-shaped, and the page builds the node rather than concatenating
     * markup. This is the test that would catch either being removed.
     */
    const { page, context, errors } = await open({
      receipt: {
        transfers: [
          { txHash: 'javascript:alert(1)', amount: '1', blockNumber: 1, at: RECEIPT.paidAt },
        ],
      },
    });
    assert.deepEqual(errors, []);
    assert.equal(await page.$('#transfers a'), null, 'no link for a hash we do not trust');
    // The string is still shown, as text, so nothing is silently hidden from the payer.
    assert.match(await text(page, '#transfers'), /javascript:alert\(1\)/);
    await context.close();
  });

  test('an unknown chain shows the hash without inventing an explorer', async () => {
    const { page, context } = await open({ receipt: { chain: 'aptos' } });
    assert.equal(await page.$('#transfers a'), null);
    assert.match(await text(page, '#transfers'), new RegExp(HASH));
    // And the network is named with our identifier rather than blanked.
    assert.match(await text(page, '#chain'), /aptos/);
    await context.close();
  });

  test('a test receipt says so before it says anything else', async () => {
    /**
     * The most important test on this page. A test invoice's address is valid on no chain,
     * so nothing was ever sent — and a document headed "Paid in full" with a real-looking
     * amount is exactly what somebody files and later produces as proof.
     */
    const { page, context } = await open({ receipt: { mode: 'test' } });
    assert.equal(await shown(page, '#rehearsal'), true);
    // Whitespace-collapsed: the markup wraps the sentence across lines, and asserting on
    // the copy rather than on the layout is the point.
    const body = (await text(page, '#rehearsal')).replace(/\s+/g, ' ');
    assert.match(body, /no money moved/i);
    assert.match(body, /not valid on any blockchain/i);
    assert.match(body, /Do not treat this as proof/i);

    // And it is above the verdict, so it is read first.
    const order = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('#rehearsal, #verdict')];
      return nodes.map((node) => node.id);
    });
    assert.deepEqual(order, ['rehearsal', 'verdict']);
    await context.close();
  });

  test('a live receipt carries no rehearsal warning', async () => {
    // The other half: a warning on every receipt is a warning nobody reads.
    const { page, context } = await open();
    assert.equal(await shown(page, '#rehearsal'), false);
    await context.close();
  });

  test('an overpayment names the refund it is owed', async () => {
    const { page, context } = await open({
      receipt: { status: 'overpaid', amountPaid: '25100502512562814071' },
    });
    assert.equal(await page.$eval('#verdict', (node) => node.dataset.tone), 'warn');
    assert.match(await text(page, '#verdict-head'), /more than the amount due/);
    assert.equal(await shown(page, '#verdict-note'), true);
    assert.match(await text(page, '#verdict-note'), /owes you the difference/);
    await context.close();
  });

  test('a commission the payer bore is on the receipt', async () => {
    // The same disclosure rule as the payment page: you are told what you were charged.
    const { page, context } = await open({
      receipt: { feeBps: 50, feeIncluded: '100502512562814070' },
    });
    assert.equal(await shown(page, '#row-fee'), true);
    assert.match(await text(page, '#fee-label'), /0\.5%/);
    assert.match(await text(page, '#fee'), /0\.10050251256281407 USDT of the above/);
    await context.close();
  });

  test('a commission the merchant absorbed is not on the receipt', async () => {
    // It came out of the merchant's settlement. What a shop pays its processor is not the
    // customer's business, and a line saying "none" invites the question it answers.
    const { page, context } = await open();
    assert.equal(await shown(page, '#row-fee'), false);
    await context.close();
  });

  test('an unpaid checkout is told to come back, not that it does not exist', async () => {
    /**
     * The link is real and the receipt will exist once the payment lands. A "not found"
     * here reads to a payer as having lost their order.
     */
    const { page, context } = await open({
      status: 409,
      body: { error: 'not_paid', message: 'Nothing has been paid for this checkout yet.' },
    });
    assert.equal(await shown(page, '#content'), false);
    assert.match(await text(page, '#fatal-head'), /Not paid yet/);
    assert.match(await text(page, '#fatal-note'), /Nothing has been paid/);
    await context.close();
  });

  test('a receipt with no transfers says why rather than showing an empty heading', async () => {
    const { page, context } = await open({ receipt: { mode: 'test', transfers: [] } });
    assert.match(await text(page, '#transfers'), /nothing was sent on any chain/i);
    await context.close();
  });

  test('the page declares its own character set', async () => {
    // Without it the em dashes and the currency figures come out as mojibake, which is
    // the whole page's credibility gone on a document somebody keeps.
    const { page, context } = await open();
    assert.equal(
      await page.$eval('meta[charset]', (node) => node.getAttribute('charset').toLowerCase()),
      'utf-8',
    );
    await context.close();
  });

  test('preview mode renders without an API, as a test receipt', async () => {
    /**
     * Deliberately a *test* receipt rather than a live-looking one. A preview claiming to be
     * a real payment would be exactly the document this page's own warning exists to
     * prevent — so the preview walks into the warning rather than around it.
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
    // Nothing may escape to a network: the preview must need no server at all.
    await page.route('**/pay/**', (route) => route.abort());

    await page.goto(`${PAGE}?preview=1`);
    await page
      .waitForFunction(() => document.getElementById('content')?.hidden === false, { timeout: 5000 })
      .catch(() => {});

    assert.equal(await shown(page, '#content'), true);
    assert.equal(await shown(page, '#rehearsal'), true, 'a preview must not look live');
    assert.match(await text(page, '#number'), /^AVEX-/);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('the print stylesheet inverts the page and drops the buttons', async () => {
    /**
     * A receipt that cannot be printed is not finished. White-on-black wastes a cartridge
     * and comes out grey, and a printed "Print" button is a smudge.
     */
    const { page, context } = await open();
    await page.emulateMedia({ media: 'print' });

    const background = await page.$eval('body', (node) => getComputedStyle(node).backgroundColor);
    assert.equal(background, 'rgb(255, 255, 255)');
    assert.equal(await shown(page, '.actions'), false);
    // The explorer URL is printed beside its text: a link on paper showing only its text
    // is a dead end for the one thing on here a reader might check.
    const printed = await page.$eval('#transfers a', (node) =>
      getComputedStyle(node, '::after').content,
    );
    assert.match(printed, /bscscan\.com/);
    await context.close();
  });
});

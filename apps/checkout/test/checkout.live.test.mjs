import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The checkout page against a stubbed API.
 *
 * The stub is at the network layer rather than inside the page, so what is under test
 * is the real fetch path: the URLs it builds, the shapes it expects, and what it does
 * with a refusal. A stub injected into the page would let a wrong URL pass.
 *
 * Two things are worth stating about what these tests cover. The address must not
 * appear before the payer commits, because a page holding an address nobody committed
 * to is a page that can get one funded by mistake. And a reload must not lose it,
 * because that is the worst possible moment to lose it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const PAGE = 'https://checkout.test/checkout.html';
const pageFile = join(here, '..', 'public', 'checkout.html');

const SESSION = '3f6b1c20-8a11-4b2e-9c47-1d5e2a8b7c90';
const BSC_ADDRESS = '0x7A3f9C21bE04D5aa71cE3B8Ed4F9021cC6b17E52';
const TON_WALLET = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';

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

/** USDT on two chains plus one unpriceable currency, which must not be selectable. */
const OPTIONS = [
  {
    assetId: '11111111-1111-4111-8111-111111111111',
    symbol: 'USDT',
    name: 'USDT',
    chain: 'bsc',
    decimals: 18,
    amount: '20100502512562814071',
    rateUsd: '995000000000000000',
    // The default: the merchant absorbs the commission, so there is nothing here for the
    // payer to be told about.
    feeIncluded: '0',
    feeBps: 0,
    available: true,
    unavailableReason: null,
  },
  {
    assetId: '22222222-2222-4222-8222-222222222222',
    symbol: 'USDT',
    name: 'USDT',
    chain: 'ton',
    decimals: 6,
    amount: '20100503',
    rateUsd: '995000000000000000',
    feeIncluded: '0',
    feeBps: 0,
    available: true,
    unavailableReason: null,
  },
  {
    assetId: '33333333-3333-4333-8333-333333333333',
    symbol: 'WEIRD',
    name: 'WEIRD',
    chain: 'bsc',
    decimals: 18,
    amount: '0',
    rateUsd: null,
    available: false,
    unavailableReason: 'No trustworthy price for this currency right now.',
  },
];

describe('checkout, live', { skip: playwright ? false : 'playwright is not installed' }, () => {
  let browser;

  before(async () => {
    browser = await playwright.chromium.launch();
  });

  after(async () => {
    await browser?.close();
  });

  /**
   * A page wired to a controllable stub.
   *
   * `state` and `select` are functions so a test can change what the API says between
   * requests — which is how payment progress and refusals are exercised.
   */
  async function open(behaviour = {}) {
    const context = await browser.newContext({ viewport: { width: 430, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    const requests = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push('console: ' + message.text());
    });

    // The page itself, served from a host that is not the file system so `fetch` has a
    // real origin to be same-origin with.
    // A glob, not the bare URL: the page is loaded with `?s=<uuid>`, and an exact
    // match would miss it and let the request escape to the network.
    await page.route(`${PAGE}*`, (route) =>
      route.fulfill({ path: pageFile, contentType: 'text/html' }),
    );

    const session = {
      id: SESSION,
      merchantName: 'Example Store',
      description: 'Order 42',
      amountFiatMicros: '20000000',
      status: 'open',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      payment: null,
      ...(behaviour.session ?? {}),
    };

    await page.route(`**/pay/${SESSION}/state`, async (route) => {
      requests.push('state');
      const body = behaviour.state ? behaviour.state(requests.length) : session;
      if (body.__status) {
        return route.fulfill({
          status: body.__status,
          contentType: 'application/json',
          body: JSON.stringify(body),
        });
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });

    await page.route(`**/pay/${SESSION}/options`, (route) => {
      requests.push('options');
      const options = behaviour.options ?? OPTIONS;
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ options }),
      });
    });

    await page.route(`**/pay/${SESSION}/select`, async (route) => {
      requests.push('select');
      const sent = JSON.parse(route.request().postData() ?? '{}');
      if (behaviour.selectFails) {
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'no_assets',
            message: 'That currency cannot be used for this payment right now.',
          }),
        });
      }
      const ton = sent.assetId === OPTIONS[1].assetId;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          changed: true,
          payment: {
            invoiceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            chain: ton ? 'ton' : 'bsc',
            symbol: 'USDT',
            decimals: ton ? 6 : 18,
            amountDue: ton ? '20100503' : '20100502512562814071',
            amountPaid: '0',
            depositAddress: ton ? TON_WALLET : BSC_ADDRESS,
            memo: ton ? 'AVEX-0123456789AB' : null,
            status: 'pending',
            toleranceBps: 50,
            feeIncluded: behaviour.feeIncluded ?? '0',
            feeBps: behaviour.feeBps ?? 0,
            networkFeeIncluded: behaviour.networkFeeIncluded ?? '0',
            networkFeeBps: behaviour.networkFeeBps ?? 0,
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
          },
        }),
      });
    });

    await page.goto(`${PAGE}?s=${SESSION}`);
    await page.waitForFunction(
      () => document.querySelectorAll('#currencies .coin').length > 0 ||
        document.querySelector('#choose-hint')?.dataset.error === 'true',
      { timeout: 5000 },
    ).catch(() => {});

    return { page, context, errors, requests };
  }

  const shown = (page, selector) =>
    page.$eval(selector, (node) => node.getBoundingClientRect().height > 0).catch(() => false);
  const text = (page, selector) => page.$eval(selector, (node) => node.textContent.trim());
  const list = (page, selector) =>
    page.$$eval(selector, (nodes) => nodes.map((n) => n.textContent.trim()));

  test('the heading names the merchant being paid, not an example', async () => {
    /**
     * It said "Pay Example Store" to every payer of every merchant. The heading was
     * hard-coded and `loadLive` never wrote the session's `merchantName` into it — and the
     * tests here passed because the stub merchant was also called Example Store. A stub
     * that agrees with a hard-coded page tests nothing, so this one is called something
     * else.
     */
    const { page, context } = await open({ session: { merchantName: 'Kian Digital' } });
    await page.waitForFunction(
      () => document.getElementById('pay-heading')?.textContent?.includes('Kian Digital'),
      { timeout: 5000 },
    );
    assert.equal(
      (await page.$eval('#pay-heading', (node) => node.textContent)).trim(),
      'Pay Kian Digital',
    );
    await context.close();
  });

  test('the session id comes from the query string and drives the requests', async () => {
    const { page, context, requests } = await open();
    // Both loads, in order: the session first, then what it may be paid in.
    assert.deepEqual(requests.slice(0, 2), ['state', 'options']);
    assert.equal(await text(page, '#amount'), '20.00');
    assert.equal(await text(page, '#amount-unit'), 'USD');
    // The merchant's own description, not ours.
    assert.equal(await text(page, '#invoice-ref'), 'Order 42');
    await context.close();
  });

  test('only currencies the API says are available are offered', async () => {
    /**
     * `WEIRD` is returned by the API as unavailable, so the merchant can see it is
     * configured. It must not be selectable here — a payer choosing it would be choosing
     * something that cannot be invoiced.
     */
    const { page, context } = await open();
    const coins = await list(page, '#currencies .coin .coin-sym');
    assert.deepEqual(coins, ['USDT']);
    assert.ok(!coins.includes('WEIRD'));
    await context.close();
  });

  test('the demo controls are gone in live mode', async () => {
    // Not hidden — removed. A button that can force a real payment page into
    // "Confirmed" has no business in the DOM of a page a stranger is looking at.
    const { page, context } = await open();
    assert.equal(await page.$$eval('[data-demo]', (nodes) => nodes.length), 0);
    await context.close();
  });

  test('choosing a currency shows its networks with the API amounts', async () => {
    const { page, context } = await open();
    await page.click('#currencies .coin:has-text("USDT")');

    const networks = await list(page, '#networks .net-name');
    assert.deepEqual([...networks].sort(), ['BNB Chain', 'TON']);
    await context.close();
  });

  test('a paid payment offers the receipt, with the session in the link', async () => {
    /**
     * The thing a payer looks for the moment they have paid. Making them ask the merchant
     * for it is how a successful payment still generates a support message.
     */
    const { page, context } = await open({
      session: {
        id: SESSION,
        merchantName: 'Example Store',
        description: 'Order 42',
        amountFiatMicros: '20000000',
        status: 'paid',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        payment: {
          invoiceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          chain: 'bsc',
          symbol: 'USDT',
          decimals: 18,
          amountDue: '20100502512562814071',
          amountPaid: '20100502512562814071',
          depositAddress: BSC_ADDRESS,
          memo: null,
          status: 'paid',
          toleranceBps: 50,
          feeIncluded: '0',
          feeBps: 0,
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        },
      },
    });

    assert.equal(await shown(page, '#receipt-offer'), true);
    const href = await page.$eval('#receipt-link', (node) => node.getAttribute('href'));
    assert.equal(href, `receipt.html?s=${SESSION}`);
    await context.close();
  });

  test('an unpaid payment offers no receipt', async () => {
    // A receipt for a payment that has not arrived is not a receipt, and the link would be
    // the one control on this screen a payer would certainly press.
    const { page, context } = await open();
    await page.click('#currencies .coin:has-text("USDT")');
    await page.click('#networks .net-row:has-text("BNB Chain")');
    assert.equal(await shown(page, '#receipt-offer'), false);
    await context.close();
  });

  test('a commission the merchant absorbs is not shown to the payer', async () => {
    /**
     * The default, and the half of this that is about restraint. The commission comes out
     * of the merchant's settlement, so what a shop pays its processor is a term between
     * us and them — and a "Service fee — none" row invites the question it is answering.
     */
    const { page, context } = await open();
    await page.click('#currencies .coin:has-text("USDT")');
    await page.click('#networks .net-row:has-text("BNB Chain")');

    assert.equal(await shown(page, '#summary-fee-row'), false);
    await context.close();
  });

  test('a commission the payer bears is itemised in the summary', async () => {
    /**
     * The other half. Once our fee has been added to what the payer must send, showing
     * only the total would make it look like the merchant's price — which is exactly the
     * complaint a surcharge attracts when it is not itemised.
     */
    const { page, context } = await open({
      options: [
        { ...OPTIONS[0], amount: '20201005025125628140', feeIncluded: '100502512562814070', feeBps: 50 },
        OPTIONS[1],
      ],
    });
    await page.click('#currencies .coin:has-text("USDT")');
    await page.click('#networks .net-row:has-text("BNB Chain")');

    assert.equal(await shown(page, '#summary-fee-row'), true);
    // The percentage explains where the figure came from; the figure is what the payer
    // can check against the total. Neither alone is enough.
    assert.match(await text(page, '#summary-fee-label'), /0\.5%/);
    assert.match(await text(page, '#summary-fee'), /^0\.10050251256281407 USDT$/);
    await context.close();
  });

  test('the itemised fee comes from the invoice once one exists', async () => {
    /**
     * The options list is an estimate against a live rate; the invoice is what the payer
     * is actually held to. If the two ever disagree the invoice wins, because its figure
     * is the one a dispute would cite.
     */
    const { page, context } = await open({
      options: [
        { ...OPTIONS[0], amount: '20201005025125628140', feeIncluded: '1', feeBps: 50 },
        OPTIONS[1],
      ],
      feeIncluded: '100502512562814070',
      feeBps: 50,
    });
    await page.click('#currencies .coin:has-text("USDT")');
    await page.click('#networks .net-row:has-text("BNB Chain")');
    await page.click('#to-pay');
    await page.waitForFunction(
      () => document.getElementById('address')?.textContent?.startsWith('0x'),
      { timeout: 5000 },
    );

    assert.match(await text(page, '#summary-fee'), /^0\.10050251256281407 USDT$/);
    await context.close();
  });

  test('a chain with no commission shows no fee line even when another does', async () => {
    /**
     * Per network, not per currency. We hold no collector address for every chain, so two
     * rows under one coin can legitimately differ — and quoting the same surcharge on both
     * would be charging the payer for a fee we are not taking.
     */
    const { page, context } = await open({
      options: [
        { ...OPTIONS[0], amount: '20201005025125628140', feeIncluded: '100502512562814070', feeBps: 50 },
        OPTIONS[1],
      ],
    });
    await page.click('#currencies .coin:has-text("USDT")');
    await page.click('#networks .net-row:has-text("TON")');

    assert.equal(await shown(page, '#summary-fee-row'), false);
    await context.close();
  });

  test('the cost of the transfer is its own line, not folded into ours', async () => {
    /**
     * Two charges with two causes: what this gateway costs, and what the chain charged to move
     * the money. A payer choosing between networks is choosing on the second, so folding them
     * into one "Service fee" would report a busy chain as us getting dearer — and would put a
     * percentage on the row that matches neither our published rate nor anything they could
     * check.
     *
     * The merchant absorbs their commission here, which is the case that matters: the transfer
     * is charged to the payer either way, because a merchant absorbing it would be paying to be
     * paid.
     */
    const { page, context } = await open({
      options: [
        {
          ...OPTIONS[0],
          amount: '20024028834468625150',
          feeIncluded: '0',
          feeBps: 0,
          networkFeeIncluded: '24028834468625150',
          networkFeeBps: 12,
        },
        OPTIONS[1],
      ],
    });
    await page.click('#currencies .coin:has-text("USDT")');
    await page.click('#networks .net-row:has-text("BNB Chain")');

    assert.equal(await shown(page, '#summary-fee-row'), false, 'no commission was passed on');
    assert.equal(await shown(page, '#summary-network-fee-row'), true);
    assert.match(await text(page, '#summary-network-fee-label'), /Network fee \(0\.12%\)/);
    assert.match(await text(page, '#summary-network-fee'), /^0\.02402883446862515 USDT$/);
    await context.close();
  });

  test('a chain we send no transaction on shows no network fee', async () => {
    /**
     * TON's shared wallet and TRON's pooled ones receive the payer's transfer directly, so
     * there is nothing to move and nothing to charge for moving. The cheap chain looking
     * cheaper on this page is the whole point of showing the line at all.
     */
    const { page, context } = await open({
      options: [
        {
          ...OPTIONS[0],
          amount: '20024028834468625150',
          networkFeeIncluded: '24028834468625150',
          networkFeeBps: 12,
        },
        OPTIONS[1],
      ],
    });
    await page.click('#currencies .coin:has-text("USDT")');
    await page.click('#networks .net-row:has-text("TON")');

    assert.equal(await shown(page, '#summary-network-fee-row'), false);
    await context.close();
  });

  test('no address exists until the payer commits', async () => {
    /**
     * The most important property here. Picking a network must not create an invoice:
     * a payer flicking through options would otherwise open one per tap, and the page
     * would be holding an address nobody had committed to.
     */
    const { page, context, requests } = await open();
    await page.click('#currencies .coin:has-text("USDT")');
    await page.click('#networks .net-row:has-text("BNB Chain")');

    assert.ok(!requests.includes('select'), 'picking a network must not create an invoice');
    assert.equal(await text(page, '#address'), '—');
    await context.close();
  });

  test('Continue creates the invoice and shows the address', async () => {
    const { page, context, requests } = await open();
    await page.click('#currencies .coin:has-text("USDT")');
    await page.click('#networks .net-row:has-text("BNB Chain")');
    await page.click('#to-pay');
    await page.waitForFunction(
      (expected) => document.getElementById('address')?.textContent.trim() === expected,
      BSC_ADDRESS,
      { timeout: 5000 },
    );

    assert.ok(requests.includes('select'));
    assert.equal(await text(page, '#address'), BSC_ADDRESS);
    assert.equal(await shown(page, '#screen-pay'), true);
    // 20100502512562814071 at 18 decimals.
    assert.equal(await text(page, '#amount'), '20.100502512562814071');
    assert.equal(await text(page, '#amount-unit'), 'USDT');
    assert.equal(await page.$$eval('#qr svg', (nodes) => nodes.length), 1);
    await context.close();
  });

  test('a memo chain shows the memo the API returned', async () => {
    // On TON the memo is what ties a payment to this invoice, so it has to be the
    // server's value — a locally generated one would match nothing.
    const { page, context } = await open();
    await page.click('#currencies .coin:has-text("USDT")');
    await page.click('#networks .net-row:has-text("TON")');
    await page.click('#to-pay');
    await page.waitForFunction(
      (expected) => document.getElementById('address')?.textContent.trim() === expected,
      TON_WALLET,
      { timeout: 5000 },
    );

    assert.equal(await shown(page, '#memo-block'), true);
    assert.equal(await text(page, '#memo'), 'AVEX-0123456789AB');
    // Six decimals here, not eighteen: the precision follows the asset.
    assert.equal(await text(page, '#amount'), '20.100503');
    await context.close();
  });

  test('a reload restores the address already chosen', async () => {
    /**
     * A payer who refreshes, or comes back to a link they left open, must not lose the
     * address they were given. It is the worst possible moment to lose it, and the
     * invoice already exists — so the page reads the choice back rather than asking
     * them to make it again.
     */
    const { page, context } = await open({
      session: {
        status: 'selected',
        payment: {
          invoiceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          chain: 'bsc',
          symbol: 'USDT',
          decimals: 18,
          amountDue: '20100502512562814071',
          amountPaid: '0',
          depositAddress: BSC_ADDRESS,
          memo: null,
          status: 'pending',
          toleranceBps: 50,
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        },
      },
    });

    await page.waitForFunction(
      (expected) => document.getElementById('address')?.textContent.trim() === expected,
      BSC_ADDRESS,
      { timeout: 5000 },
    );
    assert.equal(await shown(page, '#screen-pay'), true);
    assert.equal(await text(page, '#chosen-net'), 'USDT on BNB Chain');
    await context.close();
  });

  test('a refused selection is reported without losing the choice', async () => {
    // The payer can act on this: pick another currency. So the choices stay on screen.
    const { page, context } = await open({ selectFails: true });
    await page.click('#currencies .coin:has-text("USDT")');
    await page.click('#networks .net-row:has-text("BNB Chain")');
    await page.click('#to-pay');
    await page.waitForFunction(
      () => document.getElementById('choose-hint')?.dataset.error === 'true',
      { timeout: 5000 },
    );

    assert.match(await text(page, '#choose-hint'), /cannot be used/);
    // Still on the first screen, with the currency list intact.
    assert.equal(await shown(page, '#screen-network'), true);
    assert.equal(await page.$eval('#to-pay', (node) => node.disabled), false);
    await context.close();
  });

  test('an expired link says so instead of offering currencies', async () => {
    const { page, context } = await open({ session: { status: 'expired' } });
    await page.waitForFunction(
      () => document.getElementById('choose-hint')?.dataset.error === 'true',
      { timeout: 5000 },
    );

    assert.match(await text(page, '#choose-hint'), /expired/);
    assert.equal(await page.$$eval('#currencies .coin', (nodes) => nodes.length), 0);
    assert.equal(await page.$eval('#to-pay', (node) => node.disabled), true);
    await context.close();
  });

  test('a cancelled link says the merchant cancelled it', async () => {
    // Different from expired: nothing the payer does will revive it, and the reason is
    // not that they were slow.
    const { page, context } = await open({ session: { status: 'cancelled' } });
    await page.waitForFunction(
      () => document.getElementById('choose-hint')?.dataset.error === 'true',
      { timeout: 5000 },
    );
    assert.match(await text(page, '#choose-hint'), /cancelled by the merchant/);
    await context.close();
  });

  test('a missing session reports it rather than showing a broken page', async () => {
    const { page, context } = await open({
      state: () => ({ __status: 404, error: 'not_found', message: 'No such checkout.' }),
    });
    await page.waitForFunction(
      () => document.getElementById('choose-hint')?.dataset.error === 'true',
      { timeout: 5000 },
    );
    assert.match(await text(page, '#choose-hint'), /No such checkout/);
    await context.close();
  });

  test('polling moves the page to paid without a reload', async () => {
    /**
     * What a payer actually watches. The page has to notice the payment on its own —
     * asking someone to refresh a payment page is asking them to wonder whether their
     * money arrived.
     */
    const paid = {
      id: SESSION,
      merchantName: 'Example Store',
      description: 'Order 42',
      amountFiatMicros: '20000000',
      status: 'paid',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      payment: {
        invoiceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        chain: 'bsc',
        symbol: 'USDT',
        decimals: 18,
        amountDue: '20100502512562814071',
        amountPaid: '20100502512562814071',
        depositAddress: BSC_ADDRESS,
        memo: null,
        status: 'paid',
        toleranceBps: 50,
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      },
    };
    const open_ = { ...paid, status: 'open', payment: null };

    // First call reports open, every later one reports paid — as a real payment would.
    const { page, context } = await open({ state: (call) => (call === 1 ? open_ : paid) });

    await page.waitForFunction(
      () => document.getElementById('status')?.dataset.state === 'paid',
      { timeout: 15_000 },
    );
    assert.equal(await page.$eval('#status', (node) => node.dataset.state), 'paid');
    await context.close();
  });

  test('the page ran without throwing', async () => {
    const { context, errors } = await open();
    assert.deepEqual(errors, []);
    await context.close();
  });
});

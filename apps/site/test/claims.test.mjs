import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The site's claims against the product's own constants.
 *
 * A different job from `src/facts.test.ts`, which checks that the derivation is sane. This
 * one crosses the boundary: it reads the API's fee-plan service and the forwarder contract
 * as text and refuses to let the page's numbers disagree with them.
 *
 * That is worth a test of its own because the failure is invisible from inside either side.
 * Reprice the commission in `fee-plan-service.ts` and every test in this repository still
 * passes while the front page quotes the old rate — and the front page is the one document
 * a customer will hold us to.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');

const read = (path) => readFileSync(join(repo, path), 'utf8');
const page = readFileSync(join(here, '..', 'public', 'index.html'), 'utf8');
const facts = read('apps/site/src/facts.ts');

describe('the site does not outlive the product', () => {
  test('the commission ladder matches the service that charges it', () => {
    /**
     * Parsed out of `FEE_TIERS` rather than compared against a copy, because a copy is the
     * thing that drifts. The service declares its tiers cheapest-first; the site lists them
     * entry-first, so the comparison sorts both.
     */
    const service = read('apps/api/src/domain/fee-plan-service.ts');
    const tiers = [...service.matchAll(/fromUsdMicros:\s*([\d_]+)n,\s*bps:\s*(\d+)/g)].map(
      (match) => ({
        fromUsdMicros: BigInt(match[1].replaceAll('_', '')),
        bps: Number(match[2]),
      }),
    );
    assert.ok(tiers.length >= 3, 'FEE_TIERS could not be read; this test needs updating');

    const onSite = [...facts.matchAll(/bps:\s*(\d+),\s*fromUsdMicros:\s*([\d_]+)n/g)].map(
      (match) => ({
        bps: Number(match[1]),
        fromUsdMicros: BigInt(match[2].replaceAll('_', '')),
      }),
    );

    const key = (tier) => `${tier.bps}@${tier.fromUsdMicros}`;
    assert.deepEqual(
      onSite.map(key).sort(),
      tiers.map(key).sort(),
      'the site quotes a different ladder from the one the API charges',
    );
  });

  test('the entry rate on the page is the rate a new merchant gets', () => {
    // The single most quoted number on the site, and the one a customer will hold us to.
    const service = read('apps/api/src/domain/fee-plan-service.ts');
    const [, defaultBps] = service.match(/export const DEFAULT_FEE_BPS = (\d+);/);
    const entry = facts.match(/bps:\s*(\d+),\s*fromUsdMicros:\s*0n/);
    assert.equal(entry[1], defaultBps);
  });

  test('the ceiling the page cites is the one the contract enforces', () => {
    /**
     * The page tells a sceptical reader that the rate cannot be raised behind their back
     * because the contract rejects anything above it. If that number were wrong the claim
     * would be false in the direction that matters.
     */
    const contract = read('contracts/Forwarder.sol');
    const [, ceiling] = contract.match(/MAX_FEE_BPS\s*=\s*(\d+)/);
    const core = read('packages/core/src/chains/evm/create2.ts');
    assert.match(core, new RegExp(`export const MAX_FEE_BPS = ${ceiling};`));
    assert.match(page, /id="ceiling"/);
  });

  test('the figures rendered without JavaScript are right too', () => {
    /**
     * Each number the script fills has a value already in the markup, so a reader with
     * JavaScript off — or one who sees the page before the script runs — reads the real
     * figure rather than a dash. Which means those fallbacks are claims in their own right,
     * and this is what stops them being the stale copy nobody remembers to update.
     *
     * The alternative would have been to leave them blank and let the page flash. On a
     * pricing page the flash is worse: the number a reader half-sees is the number they
     * remember.
     */
    const service = read('apps/api/src/domain/fee-plan-service.ts');
    const contract = read('contracts/Forwarder.sol');
    const signature = read('integrations/woocommerce/includes/class-avex-signature.php');

    const percent = (bps) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
    const fallback = (id) => {
      const match = page.match(new RegExp(`id="${id}"[^>]*>([^<]*)<`));
      assert.ok(match, `#${id} is not in the page`);
      return match[1].trim();
    };

    const [, defaultBps] = service.match(/export const DEFAULT_FEE_BPS = (\d+);/);
    assert.equal(fallback('fact-rate'), percent(Number(defaultBps)));
    assert.equal(fallback('rail-rate'), percent(Number(defaultBps)));

    const [, ceiling] = contract.match(/MAX_FEE_BPS\s*=\s*(\d+)/);
    assert.equal(fallback('ceiling'), percent(Number(ceiling)));

    const [, tolerance] = signature.match(/TOLERANCE_SECONDS\s*=\s*(\d+)/);
    assert.equal(fallback('doc-window'), tolerance);

    // The chain count, from the list the product actually carries.
    const registry = read('packages/core/src/assets/registry.ts');
    const chains = new Set([...registry.matchAll(/chain: '(\w+)'/g)].map((match) => match[1]));
    assert.equal(fallback('fact-chains'), String(chains.size));
    assert.equal(fallback('rail-chains'), String(chains.size));
  });

  test('the webhook window the docs quote is the one the receivers enforce', () => {
    // A larger number in the docs would have integrators accepting deliveries our own
    // plugin rejects; a smaller one would have them rejecting valid ones.
    const signature = read('integrations/woocommerce/includes/class-avex-signature.php');
    const [, tolerance] = signature.match(/TOLERANCE_SECONDS\s*=\s*(\d+)/);
    assert.match(facts, new RegExp(`SIGNATURE_WINDOW_SECONDS = ${tolerance};`));
  });

  test('every error code the docs name is one the API can actually return', () => {
    /**
     * Documenting a code that does not exist teaches an integrator to branch on something
     * that will never arrive — and the branch they wrote instead of the real one is where
     * the payment goes missing.
     */
    const routes = read('apps/api/src/http/routes/merchant.ts');
    const creation = read('apps/api/src/domain/invoice-creation.ts');
    const source = routes + creation;

    for (const code of ['no_payout_address', 'asset_unlisted', 'price_unavailable', 'fixed_rate_expired']) {
      assert.match(page, new RegExp(`>${code}<`), `${code} should be documented`);
      assert.match(source, new RegExp(`'${code}'`), `${code} is documented but not thrown`);
    }
  });

  test('the page does not promise a 402, because there is not one', () => {
    /**
     * The commission is deducted from the payment, so a merchant cannot be behind on it. The
     * old subscription model had a 402; the page states its absence, and this fails if the
     * gate ever comes back without the copy being revisited.
     */
    const routes = read('apps/api/src/http/routes/merchant.ts');
    assert.ok(!routes.includes('402'), 'a 402 exists again; the site says there is none');
    assert.match(page, /There is no <code>402<\/code>/);
  });

  test('the currency table is built from the curated list, not written out', () => {
    /**
     * The check that matters most on this page, because a hand-written table is how the
     * preview panels ended up showing three chains out of six. If the markup ever carries a
     * hardcoded row the count stops tracking the product.
     */
    assert.match(page, /chainRows\(\)/);
    const tbody = page.match(/<table id="chain-table">[\s\S]*?<tbody><\/tbody>/);
    assert.ok(tbody, 'the table body should be empty in the markup and filled from the module');
  });

  test('the derivation is the real one, not a stand-in', () => {
    /**
     * The page's central claim is that the deposit address commits to the merchant's wallet,
     * and it demonstrates that by deriving one in the browser. Faking it with a hash of the
     * inputs would make the argument a decoration — so the shipped page has to contain the
     * same functions the gateway calls.
     */
    for (const symbol of ['function keccak256', 'function predictForwarder', 'function initCodeHash']) {
      assert.ok(page.includes(symbol), `${symbol} should be inlined into the page`);
    }
    assert.match(page, /predictForwarder\(\s*CONFIG/);
  });

  test('the page never shows a factory address as if it were deployed', () => {
    // The demo needs a factory to hash against, and it is a stand-in. It must not appear
    // anywhere a reader would read it as ours.
    const visible = page.replace(/<script[\s\S]*?<\/script>/g, '');
    assert.ok(
      !visible.includes('0x5FbDB2315678afecb367f032d93F642f64180aa3'),
      'the placeholder factory must stay inside the script',
    );
  });
});

describe('the page holds together', () => {
  test('it declares its charset before anything else', () => {
    // Without it the em dashes and the currency figures come out as mojibake, which is the
    // page's credibility gone in the first paragraph.
    assert.match(page.slice(0, 200), /<meta charset="utf-8">/);
  });

  test('every internal link points at a section that exists', () => {
    // A nav that scrolls nowhere is the cheapest possible way to look unfinished.
    const targets = [...page.matchAll(/href="#([\w-]+)"/g)].map((match) => match[1]);
    assert.ok(targets.length >= 4);
    for (const target of new Set(targets)) {
      assert.match(page, new RegExp(`id="${target}"`), `#${target} has no section`);
    }
  });

  test('the fonts come from the one host the CSP admits', () => {
    /**
     * Google Fonts is the only external host an artifact may reach. A face from anywhere else
     * falls back silently — the page still renders, in a different typeface, which is the
     * kind of bug that survives review because nothing errors.
     */
    const links = [...page.matchAll(/<link[^>]+href="(https:\/\/[^"]+)"/g)].map((match) => match[1]);
    for (const href of links) {
      assert.match(href, /^https:\/\/fonts\.(googleapis|gstatic)\.com/);
    }
    // And each family is given a real fallback stack, for the case where even that is blocked.
    assert.match(page, /--display: Archivo, 'Helvetica Neue'/);
    assert.match(page, /--sans: 'IBM Plex Sans', -apple-system/);
    assert.match(page, /--mono: 'IBM Plex Mono', ui-monospace/);
  });

  test('reduced motion is respected', () => {
    // The page has one entrance animation. Somebody who has asked for no motion should not
    // get it.
    assert.match(page, /@media \(prefers-reduced-motion: reduce\)/);
  });

  test('the body paints its own background', () => {
    /**
     * The artifact composites over a ground the viewer paints in *its* theme. A transparent
     * body would borrow that, and this page is committed to black — light-mode viewers would
     * get white text on white.
     */
    assert.match(page, /body \{[^}]*background: var\(--void\)/);
  });
});

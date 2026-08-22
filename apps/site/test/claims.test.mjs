import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The site's claims against the product itself.
 *
 * A different job from `src/facts.test.ts`, which checks that the derivation is sane. This
 * one crosses the boundary: it reads the API's routes, the forwarder's callers and the
 * WooCommerce plugin as text and refuses to let the page disagree with them.
 *
 * That is worth a test of its own because the failure is invisible from inside either side.
 * Widen the webhook tolerance in the plugin and every test in this repository still passes
 * while the page documents the old window — and the page is the one document an integrator
 * will hold us to.
 *
 * Two of the claims here are about what the page must *not* say. It names no currency and
 * quotes no rate: both belong to the account, not to the marketing, and a figure printed
 * here is a figure we would have to keep true forever.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');

const read = (path) => readFileSync(join(repo, path), 'utf8');
const page = readFileSync(join(here, '..', 'public', 'index.html'), 'utf8');
const facts = read('apps/site/src/facts.ts');

/**
 * The page as a reader sees it.
 *
 * The script carries four of the product's own modules inlined, and the stylesheet is full
 * of percentages — so anything asking "does the copy say X" has to strip both first, or it
 * is asking about source code.
 */
const copy = page
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .replace(/<style[\s\S]*?<\/style>/g, '')
  .replace(/<!--[\s\S]*?-->/g, '');

describe('the site does not outlive the product', () => {
  test('the page names no currency', () => {
    /**
     * Which coins and networks we take is a property of an account, changed from the admin
     * panel on an afternoon's notice — and a merchant chooses their own subset on top of
     * that. Printing a list here makes the front page wrong the first time either changes,
     * silently, in the direction that loses a sale.
     *
     * The one place issuer names survive is the note about what non-custody does *not*
     * protect a merchant from, which names Tether and Circle to say they can freeze an
     * address. That is a limitation we state rather than a menu, so this test looks for
     * ticker symbols and for the table that used to list them.
     */
    for (const symbol of ['USDT', 'USDC', 'USDD', 'TRX', 'MATIC', 'BNB', 'SOL']) {
      assert.ok(
        !new RegExp(`\\b${symbol}\\b`).test(copy),
        `the page names ${symbol}; supported currencies belong in the dashboard`,
      );
    }
    assert.ok(!copy.includes('chain-table'), 'the currency table is back');

    /**
     * The count is fine — it is a fact about the integration rather than a promise about a
     * coin — but it belongs in the one element the script fills. Spelled out in prose it
     * becomes a second copy that goes wrong the first time a chain is added, and the meta
     * description is the copy nobody thinks to check.
     */
    assert.match(copy, /id="fact-chains"/);
    const spelled = /\b(three|four|five|six|seven|eight|nine|ten)\s+networks?\b/i;
    assert.ok(!spelled.test(copy), 'a network count is written out in the copy');
    const [, description] = page.match(/name="description" content="([^"]*)"/);
    assert.ok(!spelled.test(description), 'a network count is written into the meta description');
  });

  test('the page quotes no rate', () => {
    /**
     * The commission is a number in an agreement and on a dashboard, not on a landing page.
     * A page that quotes it has to be redeployed in step with `FEE_TIERS`, and the version a
     * customer screenshotted is the version they will argue from.
     *
     * Saying a fee exists is honest and stays; saying what it is does not.
     */
    const figures = [...copy.matchAll(/[^<>]{0,40}%[^<>]{0,20}/g)].map((match) => match[0].trim());
    assert.deepEqual(figures, [], 'a percentage is printed in the copy');
    assert.ok(!/basis points|\bbps\b/i.test(copy), 'the copy talks in basis points');
    assert.ok(!/\bid="(fact-rate|rail-rate|ceiling)"/.test(page), 'a rate element is back');
    for (const removed of ['ladder-table', 'split-demo', 'd-fee']) {
      assert.ok(!page.includes(`id="${removed}"`), `#${removed} is back on the page`);
    }
  });

  test('the figure beside the products is the number of products', () => {
    /**
     * The rail says how many ways there are to get paid, and the grid below it lists them.
     * Two numbers in one section, one of them typed — this is the test that keeps them the
     * same number when a fifth is added.
     *
     * Only the first row counts: the second is what every one of them comes with, not another
     * way to be paid.
     */
    const section = page.match(/<section id="products">[\s\S]*?<\/section>/)[0];
    const [, figure] = section.match(/<div class="rail-figure">(\d+)<\/div>/);
    const [firstRow] = [...section.matchAll(/<div class="cards[^"]*">([\s\S]*?)\n      <\/div>/g)];
    assert.ok(firstRow, 'the products grid could not be read; this test needs updating');
    const ways = [...firstRow[1].matchAll(/<h3>/g)].length;
    assert.equal(Number(figure), ways, 'the rail figure and the grid disagree');

    // And the same number again, spelled out, introducing what they all come with.
    const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
    const [, spelled] = section.match(/<p class="cards-sub">And all (\w+) come with<\/p>/);
    assert.equal(spelled, WORDS[ways], 'the subhead names a different number of products');
  });

  test('the figures rendered without JavaScript are right too', () => {
    /**
     * Each number the script fills has a value already in the markup, so a reader with
     * JavaScript off — or one who sees the page before the script runs — reads the real
     * figure rather than a dash. Which means those fallbacks are claims in their own right,
     * and this is what stops them being the stale copy nobody remembers to update.
     */
    const signature = read('integrations/woocommerce/includes/class-avex-signature.php');
    const fallback = (id) => {
      const match = page.match(new RegExp(`id="${id}"[^>]*>([^<]*)<`));
      assert.ok(match, `#${id} is not in the page`);
      return match[1].trim();
    };

    const [, tolerance] = signature.match(/TOLERANCE_SECONDS\s*=\s*(\d+)/);
    assert.equal(fallback('doc-window'), tolerance);

    /**
     * The network count, from the list the product actually carries.
     *
     * `SUPPORTED_CHAINS` is `Object.keys(CHAINS)`, so the count is the number of top-level
     * keys in that record — read out of the source rather than copied, because a copy is the
     * thing that drifts when a seventh chain lands.
     */
    const registry = read('packages/core/src/chains/registry.ts');
    const [, record] = registry.match(
      /export const CHAINS[\s\S]*?= \{([\s\S]*?)\n\};/,
    );
    const chains = new Set([...record.matchAll(/^ {2}(\w+): \{/gm)].map((match) => match[1]));
    assert.ok(chains.size >= 4, 'CHAINS could not be read; this test needs updating');
    assert.equal(fallback('fact-chains'), String(chains.size));
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

  test('the page describes the 402 that exists, and no more than that', () => {
    /**
     * This test used to assert the opposite, and it is the reason the copy is not now a lie.
     *
     * The commission is deducted from the payment on most chains, so a merchant cannot be
     * behind on it and there was no 402 at all — the page said so, and this failed if the gate
     * ever came back. It came back: a pooled chain pays the merchant's own wallet directly,
     * nothing of ours is in the path, and the commission becomes a balance with a limit behind
     * it.
     *
     * So the assertion inverts rather than being deleted. What it protects now is the shape of
     * the claim: that the page says the refusal is narrow and says which invoices still work,
     * because "your gateway can refuse you" is exactly the sentence a merchant reads twice.
     */
    const routes = read('apps/api/src/http/routes/merchant.ts');
    assert.ok(routes.includes('402'), 'the 402 is gone; the page still describes one');

    assert.match(page, /There is one <code>402<\/code>/);
    // The two halves that keep it honest: it is limited to one network, and the others work.
    assert.match(page, /one network where the payment goes straight into your own wallet/);
    assert.match(page, /Every other network keeps working/);
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
    assert.ok(
      !copy.includes('0x5FbDB2315678afecb367f032d93F642f64180aa3'),
      'the placeholder factory must stay inside the script',
    );
  });
});

describe('the way in', () => {
  test('every route to the panel is one anchor away from being redeployed elsewhere', () => {
    /**
     * The site does not host its own sign-in; it hands off to the panel. Every such anchor
     * carries `data-dash`, and the script rewrites all of them from one `<meta>` — so moving
     * the panel is one line, and a link left hardcoded is a link that keeps pointing at the
     * old deployment. This is the test that catches the one somebody adds by hand.
     */
    assert.match(page, /<meta name="avex-dashboard" content="[^"]+">/);

    const anchors = [...page.matchAll(/<a\b[^>]*data-dash="(in|up)"[^>]*>/g)];
    assert.ok(anchors.length >= 5, `only ${anchors.length} auth links; the nav, hero and footer all need them`);
    for (const [tag] of anchors) {
      // A fallback href, so the links work before the script runs and if it never does.
      assert.match(tag, /href="\/[^"]*"/, tag);
    }
    assert.ok(anchors.some(([, kind]) => kind === 'in'), 'nothing signs in');
    assert.ok(anchors.some(([, kind]) => kind === 'up'), 'nothing signs up');

    // And the rewriting is real: the module's own function, not a string built in the page.
    assert.match(page, /export function dashboardLinks|function dashboardLinks/);
    assert.match(page, /dashboardLinks\(DASHBOARD\)/);
  });

  test('the email a visitor types is carried to the panel rather than dropped', () => {
    // A form that collects an address and then asks for it again on the next screen is a
    // form that loses people at the second ask.
    assert.match(page, /id="start-form"/);
    assert.match(page, /id="start-email"/);
    assert.match(page, /signUpWithEmail\(DASHBOARD, el\('start-email'\)\.value\)/);
    assert.match(facts, /export function signUpWithEmail/);
    // And it is labelled, even though the label is not drawn.
    assert.match(page, /class="sr-only" for="start-email"/);
  });

  test('the panel reads back what the site sent it', () => {
    /**
     * The handoff is only half in this repository's site. `signUpWithEmail` writes
     * `?signup=1&email=…`; if the panel ignores those the visitor lands on a sign-in form
     * with an empty field, which looks like the account they just made did not exist.
     */
    const panel = read('apps/merchant/public/merchant.template.html');
    assert.match(
      panel,
      /const entry = new URLSearchParams\(location\.search\);/,
      'the panel does not read its query at all',
    );
    assert.match(
      panel,
      /entry\.get\('signup'\) === '1'/,
      'the panel does not open its signup view from the query',
    );
    assert.match(
      panel,
      /entry\.get\('email'\)/,
      'the panel does not read the address the site sent',
    );
    // And the two names have to be the ones the site writes.
    assert.match(facts, /'signup=1'/);
    assert.match(facts, /email=\$\{encodeURIComponent/);
  });
});

describe('the page holds together', () => {
  test('it declares its charset before anything else', () => {
    // Without it the em dashes come out as mojibake, which is the page's credibility gone in
    // the first paragraph.
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

  test('every link on the page goes somewhere we serve', () => {
    /**
     * The bug this exists for: "Open the API reference" — the primary call to action of the
     * documentation section — pointed at a claude.ai artifact URL, because that is where the
     * reference was drafted. It shipped to production that way. A visitor clicking the one
     * button on the page that says "here is how you take money" left our domain for a private
     * page on somebody else's host, and nothing in the repository objected: the link was
     * valid HTML, it resolved, and no test looked at where it went.
     *
     * So this test reads the static bundle's own manifest and holds the page to it. A
     * fragment must name something on the page. A root-relative path must be a file the
     * bundle ships. An absolute URL must be one of the two font hosts.
     */
    const manifest = read('deploy/build-static.mjs');
    const shipped = new Set(
      [...manifest.matchAll(/to: '([^']+\.html)'/g)].map(([, file]) =>
        // `cleanUrls` serves each file without its extension, and index.html at the root.
        file === 'index.html' ? '/' : `/${file.replace(/\.html$/, '')}`,
      ),
    );
    assert.ok(shipped.size >= 5, 'read no pages out of the bundle manifest; the regex is stale');

    const ids = new Set([...page.matchAll(/\sid="([^"]+)"/g)].map(([, id]) => id));
    const hrefs = new Set([...copy.matchAll(/href="([^"]+)"/g)].map(([, href]) => href));
    assert.ok(hrefs.size > 0, 'found no links at all; the page or this regex changed');

    for (const href of hrefs) {
      if (href.startsWith('#')) {
        assert.ok(ids.has(href.slice(1)), `${href} names nothing on the page`);
        continue;
      }

      if (href.startsWith('https://')) {
        assert.match(
          href,
          /^https:\/\/fonts\.(googleapis|gstatic)\.com/,
          `${href} sends a reader off our domain`,
        );
        continue;
      }

      // A path of our own. The query is ours to add — `?signup=1` puts the panel on its
      // sign-up view — so the check is on the path.
      assert.ok(href.startsWith('/'), `${href} is neither a fragment, a path, nor a font host`);
      const path = href.split(/[?#]/)[0];
      assert.ok(shipped.has(path), `${href} is linked but the bundle ships no ${path}`);
    }
  });

  test('no stylesheet rule is left addressing something the page removed', () => {
    /**
     * Dead CSS is not a bug on its own; it is the fossil that makes the next person think a
     * table or a demo is still there and write markup for it. The pricing sections went, so
     * their rules go too.
     */
    const [, style] = page.match(/<style>([\s\S]*?)<\/style>/);
    for (const gone of ['.split-demo', '.ladder', '#chain-table']) {
      assert.ok(!style.includes(gone), `${gone} is styled but nothing uses it`);
    }
  });
});

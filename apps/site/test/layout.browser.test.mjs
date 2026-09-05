import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The site as a layout, in a browser.
 *
 * `site.browser.test.mjs` runs the page for what it claims; this file runs it for how it
 * holds up as a page — on a phone, with a keyboard, with a screen reader, on a light host —
 * and against the bundle it actually ships in. None of these are about copy. All of them
 * are about the failures a designer sees once and a test never does unless somebody writes
 * it down: a header that scrolls sideways, a menu that opens and cannot be closed, an h3
 * under an h1, a footer link to a page the deployment does not carry.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const PAGE = 'https://avex.test/index.html';
const pageFile = join(here, '..', 'public', 'index.html');
const page = readFileSync(pageFile, 'utf8');

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

/** The review widths: a small phone, a tablet, a small laptop, a desktop. */
const WIDTHS = [360, 768, 1024, 1440];

describe('the site as a layout', { skip: playwright ? false : 'playwright is not installed' }, () => {
  let browser;

  before(async () => {
    browser = await playwright.chromium.launch();
  });

  after(async () => {
    await browser?.close();
  });

  /**
   * Open the built page with the network off.
   *
   * Every request that is not the page itself is refused, fonts included, so the fallback
   * stacks are what render and no test waits on a host it cannot reach. The catch-all is
   * registered first because Playwright consults routes newest-first.
   */
  async function open(width = 1440, { theme } = {}) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const tab = await context.newPage();
    const errors = [];
    tab.on('pageerror', (error) => errors.push(String(error)));

    await tab.route('**/*', (route) => route.abort());
    await tab.route(`${PAGE}*`, (route) => route.fulfill({ path: pageFile, contentType: 'text/html' }));
    await tab.goto(PAGE, { waitUntil: 'domcontentloaded' });
    if (theme) await tab.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
    await tab.waitForTimeout(250);
    return { tab, context, errors };
  }

  const overflowOf = (tab) =>
    tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  for (const width of WIDTHS) {
    test(`nothing scrolls sideways at ${width}px`, async () => {
      /**
       * The tables, the code and the diagram are wider than a phone and scroll inside their
       * own frames. If any one of them, or a heading that refuses to wrap, escapes, the whole
       * page slides and every section feels broken — and it only shows at the width nobody
       * tested.
       */
      const { tab, context } = await open(width);
      assert.equal(await overflowOf(tab), 0, `the document is wider than the viewport at ${width}px`);

      // Every block that is not inside a scroller has to fit too; overflow that is clipped by
      // a parent does not show in scrollWidth but does cut text off.
      const escaped = await tab.$$eval('main > section *:not(pre *):not(table *):not(svg *)', (nodes, limit) =>
        nodes
          .filter((node) => !node.closest('pre, .scroll, .diagram, svg'))
          .map((node) => ({ tag: node.tagName, cls: node.className, right: Math.round(node.getBoundingClientRect().right) }))
          .filter((item) => item.right > limit + 1),
        width,
      );
      assert.deepEqual(escaped, [], 'elements run past the right edge');
      await context.close();
    });
  }

  test('the page is still readable at 320px', async () => {
    // Below the smallest review width, but the width of the smallest phone still in use.
    const { tab, context } = await open(320);
    assert.equal(await overflowOf(tab), 0);
    const h1 = await tab.$eval('h1', (node) => node.getBoundingClientRect().right);
    assert.ok(h1 <= 320, 'the headline runs off a 320px screen');
    await context.close();
  });

  test('the mobile menu opens, closes, and is described to a screen reader', async () => {
    /**
     * Three section links are too many for a 360px bar, so they live in a panel. The panel
     * has to be reachable — a button the page draws but nothing wires up is the classic
     * marketing-site bug — and it has to close again by every route a person would try.
     */
    const { tab, context } = await open(360);
    const toggle = tab.locator('.nav-toggle');
    const links = tab.locator('#nav-links');

    await toggle.waitFor({ state: 'visible' });
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await toggle.getAttribute('aria-controls'), 'nav-links');
    assert.equal(await links.isVisible(), false, 'the panel is open before anybody asked');

    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await links.isVisible(), true, 'the panel did not open');
    assert.match(await toggle.getAttribute('aria-label'), /close/i);

    // Every link in the panel is a real target and is inside the screen. At 360px the bar is
    // too narrow for both doors, so "Sign in" is in the panel too (see the 23rem rule).
    const items = await tab.$$eval('#nav-links a', (nodes) =>
      nodes
        .filter((node) => node.getBoundingClientRect().height > 0)
        .map((node) => {
          const box = node.getBoundingClientRect();
          return { label: node.textContent.trim(), height: Math.round(box.height), right: Math.round(box.right) };
        }),
    );
    assert.deepEqual(
      items.map((item) => item.label),
      ['Products', 'How it works', 'Developers', 'Sign in'],
    );
    for (const item of items) {
      assert.ok(item.height >= 44, `"${item.label}" is ${item.height}px tall; too small to tap`);
      assert.ok(item.right <= 360, `"${item.label}" runs off the screen`);
    }
    assert.equal(await overflowOf(tab), 0, 'the open panel widens the page');

    // Escape closes it and hands focus back to the button that opened it.
    await tab.keyboard.press('Escape');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await links.isVisible(), false, 'Escape did not close the panel');
    assert.equal(await tab.evaluate(() => document.activeElement?.className), 'nav-toggle');

    // Following a link closes it too, because the panel would otherwise cover what it led to.
    await toggle.click();
    await tab.click('#nav-links a[href="#how"]');
    await tab.waitForTimeout(100);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await links.isVisible(), false, 'the panel stayed open after navigating');
    assert.match(tab.url(), /#how$/);

    // And the button again, as a toggle: open, then closed.
    await toggle.click();
    assert.equal(await links.isVisible(), true);
    await toggle.click();
    assert.equal(await links.isVisible(), false);
    await context.close();
  });

  test('the menu button is absent on a desktop, where the links are in the bar', async () => {
    const { tab, context } = await open(1440);
    assert.equal(await tab.locator('.nav-toggle').isVisible(), false);
    assert.equal(await tab.locator('#nav-links a[href="#how"]').isVisible(), true);
    await context.close();
  });

  test('on the narrowest phones "Sign in" moves into the menu rather than off the page', async () => {
    // Below 23rem the bar cannot hold both doors and the menu button. Sign in is still one tap
    // away: it is in the panel.
    const { tab, context } = await open(320);
    assert.equal(await tab.locator('.bar nav > .nav-auth').isVisible(), false);
    await tab.click('.nav-toggle');
    assert.equal(await tab.locator('#nav-links .nav-auth-menu').isVisible(), true);
    assert.equal(await overflowOf(tab), 0);
    await context.close();
  });

  test('everything a thumb has to hit is at least 44px tall on a phone', async () => {
    /**
     * The header, the hero's two actions, the sign-up form and the footer links are the
     * controls a phone reader actually uses. Inline links in prose are exempt: they are read,
     * not aimed at, and making them 44px would double-space every paragraph.
     */
    const { tab, context } = await open(360);
    const targets = await tab.$$eval(
      '.bar a, .bar button, .hero-cta a, .start-form input, .start-form button, .foot-col a, .foot-cta a',
      (nodes) =>
        nodes
          .filter((node) => node.getBoundingClientRect().height > 0)
          .map((node) => ({
            label: (node.getAttribute('aria-label') || node.textContent).replace(/\s+/g, ' ').trim(),
            height: Math.round(node.getBoundingClientRect().height),
          })),
    );
    assert.ok(targets.length >= 12, `only ${targets.length} controls found`);
    for (const target of targets) {
      assert.ok(target.height >= 44, `"${target.label}" is ${target.height}px tall`);
    }
    await context.close();
  });

  test('the headings form an outline: one h1, and no level skipped on the way down', async () => {
    /**
     * A screen reader navigates by heading, and a jump from h1 to h3 reads as a missing
     * section. Cards use h3 under a section's h2; the hero's h1 is the only h1.
     */
    const { tab, context } = await open(1440);
    const levels = await tab.$$eval('h1, h2, h3, h4, h5, h6', (nodes) =>
      nodes.map((node) => ({ level: Number(node.tagName[1]), text: node.textContent.replace(/\s+/g, ' ').trim() })),
    );
    assert.ok(levels.length >= 20, `only ${levels.length} headings`);
    assert.equal(levels[0].level, 1, 'the first heading is not the h1');
    assert.equal(levels.filter((item) => item.level === 1).length, 1, 'more than one h1');

    let previous = 1;
    for (const { level, text } of levels) {
      assert.ok(level <= previous + 1, `"${text}" is an h${level} after an h${previous}`);
      previous = level;
    }

    /**
     * A section that names itself points at a heading that exists, so the landmarks read as a
     * table of contents rather than "region, region, region". One section is allowed to stay a
     * plain container: `claims.test.mjs` reads `<section id="products">` as a literal tag, so
     * that one carries no attributes and is not exposed as a region at all — which is honest,
     * where a dangling `aria-labelledby` would not be.
     */
    const named = await tab.$$eval('main > section', (nodes) =>
      nodes.map((node) => {
        const id = node.getAttribute('aria-labelledby');
        const target = id ? document.getElementById(id) : null;
        return { section: node.id || node.className, labelled: id !== null, heading: target ? target.tagName : null };
      }),
    );
    assert.ok(named.filter((item) => item.labelled).length >= 5, 'most sections should be named regions');
    for (const item of named) {
      if (!item.labelled) continue;
      assert.match(item.heading ?? '', /^H[1-6]$/, `${item.section} points its label at ${item.heading}`);
    }
    await context.close();
  });

  test('the landmarks are all there, once each', async () => {
    const { tab, context } = await open(1440);
    const counts = await tab.evaluate(() => ({
      header: document.querySelectorAll('body > header').length,
      main: document.querySelectorAll('main').length,
      footer: document.querySelectorAll('body > footer').length,
      nav: document.querySelectorAll('nav[aria-label]').length,
      skip: document.querySelector('a.skip')?.getAttribute('href'),
    }));
    assert.equal(counts.header, 1);
    assert.equal(counts.main, 1);
    assert.equal(counts.footer, 1);
    assert.ok(counts.nav >= 2, 'the primary and footer navigations are each labelled');
    assert.equal(counts.skip, '#main');
    await context.close();
  });

  test('every SVG is either described or hidden from a screen reader', async () => {
    // A drawing with neither is announced as "image" and nothing else, which is worse than
    // silence: it tells the reader they are missing something.
    const { tab, context } = await open(1440);
    const bare = await tab.$$eval('svg', (nodes) =>
      nodes
        .filter((node) => node.getAttribute('aria-hidden') !== 'true' && !node.closest('[aria-hidden="true"]'))
        .filter((node) => !(node.getAttribute('role') === 'img' && node.getAttribute('aria-label')))
        .map((node) => node.outerHTML.slice(0, 80)),
    );
    assert.deepEqual(bare, []);
    await context.close();
  });

  test('focus is visible on every control, in both themes', async () => {
    /**
     * A keyboard reader who cannot see where they are has no page. The outline is asserted
     * as geometry — a focused control draws something a blurred one does not — rather than
     * as the presence of a CSS rule, because the rule was there when a `border-radius` reset
     * on `.btn` swallowed it once.
     */
    for (const theme of [undefined, 'dark']) {
      const { tab, context } = await open(1440, { theme });
      for (const selector of ['.bar nav a.btn', '.hero-cta a.btn-ghost', '#d-payout', '#start-email']) {
        await tab.focus(selector);
        const outline = await tab.$eval(selector, (node) => {
          const style = getComputedStyle(node);
          return { width: parseFloat(style.outlineWidth), style: style.outlineStyle, color: style.outlineColor };
        });
        assert.ok(outline.width >= 2 && outline.style !== 'none', `${selector} shows no focus ring (${theme ?? 'light'})`);
        assert.notEqual(outline.color, 'rgba(0, 0, 0, 0)', `${selector} has a transparent focus ring`);
      }
      await context.close();
    }
  });

  /** WCAG relative luminance and contrast, for a computed `rgb(...)` string. */
  function luminance(rgb) {
    const [r, g, b] = rgb.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((channel) => {
      const c = channel / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const contrast = (fg, bg) => {
    const [light, dark] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
    return (light + 0.05) / (dark + 0.05);
  };

  /**
   * The text a person reads as text, against whatever is painted behind it.
   *
   * Labels set in small caps and the code sample's comments are read too, so they are in the
   * list, and so is everything on the two inverted bands (pricing's lead panel and the closing
   * call to action), which swap ink and surface and are where a token chosen for one theme
   * fails in the other. What is left out is the primary button's ink on lime (checked
   * separately) and anything over the blurred bar, whose ground is translucent.
   */
  const READABLE = [
    '.hero-sub', '.hero-hint', '.body p', '.lede', '.card p', '.step p', '.step-n', 'figcaption',
    '.rail-note', '.rail-eyebrow', '.field label', '.result-note', '.result-value', '.start-note',
    '.foot-brand p', '.foot-col a', '.foot-h', 'td', 'th', 'pre .c', 'pre .k', 'pre .s', 'pre .v',
    '.pill', '.derive-live', '.eyebrow', '.code-head', 'p code',
    '.derive-title', '.result-label', '.card h3', '.step h3', '.cards-sub', '.doc-copy p', 'td.mono',
    '.plan-lead p', '.plan-lead h3', '.plan-lead .eyebrow', '.plan-points p', '.plan-points h3',
    '.start-inner > p', '.start-inner h2', '.start .eyebrow', '.rail-figure', '.foot-end a',
  ];

  for (const theme of [undefined, 'dark']) {
    test(`body text reaches 4.5:1 against its ground (${theme ?? 'light'})`, async () => {
      const { tab, context } = await open(1440, { theme });
      const failures = await tab.evaluate((selectors) => {
        const opaque = (node) => {
          for (let el = node; el; el = el.parentElement) {
            const bg = getComputedStyle(el).backgroundColor;
            const alpha = bg.startsWith('rgba') ? Number(bg.match(/[\d.]+(?=\))/)[0]) : 1;
            if (alpha === 1 && bg !== 'rgba(0, 0, 0, 0)') return bg;
            if (alpha > 0 && alpha < 1) return null; // translucent: composite unknown, skip
          }
          return getComputedStyle(document.body).backgroundColor;
        };
        const out = [];
        for (const selector of selectors) {
          const node = document.querySelector(selector);
          if (!node) {
            out.push({ selector, missing: true });
            continue;
          }
          const bg = opaque(node);
          if (bg === null) continue;
          out.push({ selector, fg: getComputedStyle(node).color, bg });
        }
        return out;
      }, READABLE);

      for (const item of failures) {
        assert.ok(!item.missing, `${item.selector} is not on the page; update the list`);
        const ratio = contrast(item.fg, item.bg);
        assert.ok(ratio >= 4.5, `${item.selector}: ${item.fg} on ${item.bg} is ${ratio.toFixed(2)}:1`);
      }

      // The primary button: dark ink on lime, in both themes.
      const button = await tab.$eval('.hero-cta .btn-lime', (node) => {
        const style = getComputedStyle(node);
        return { fg: style.color, bg: style.backgroundColor };
      });
      assert.ok(contrast(button.fg, button.bg) >= 4.5, 'the primary button is unreadable');
      await context.close();
    });
  }

  test('the page paints only with the shared tokens, and every token it uses exists in both themes', () => {
    /**
     * The stylesheet starts from `packages/design/tokens.css`, inlined at build time, and
     * extends it. Three things keep that true rather than nominal. Every colour the dark
     * palette sets has a light definition, so no token survives the switch as the wrong
     * theme's value. Every `var(--x)` the page reaches for is defined — by the tokens or by the
     * page's own alias block, which may define measures and faces but no colour of its own.
     * And no colour is written out by hand anywhere else, in the CSS or in an SVG attribute.
     */
    const [, style] = page.match(/<style>([\s\S]*?)<\/style>/);
    const tokens = readFileSync(join(repo, 'packages', 'design', 'tokens.css'), 'utf8').trim();
    assert.ok(style.includes(tokens), 'the design tokens are not inlined into the stylesheet');
    assert.ok(!page.includes('/* @inject:tokens */'), 'the tokens marker was left in the page');

    const declarations = (block) =>
      new Map([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
    const blockOf = (source, selector) => {
      const match = source.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
      assert.ok(match, `no ${selector} block`);
      return match[1];
    };
    const light = declarations(blockOf(tokens, ':root'));
    const darkSystem = declarations(blockOf(tokens, ':root:not([data-theme="light"])'));
    const darkForced = declarations(blockOf(tokens, ':root[data-theme="dark"]'));

    const isColour = (value) => /#|rgb/.test(value);
    const darkColours = [...darkSystem].filter(([, value]) => isColour(value)).map(([name]) => name);
    assert.ok(darkColours.length >= 20, `read only ${darkColours.length} colour tokens; the parser is stale`);
    for (const name of darkColours) {
      assert.ok(light.has(name), `${name} is a colour in the dark palette and undefined in the light one`);
    }
    assert.deepEqual([...darkForced.keys()].sort(), [...darkSystem.keys()].sort(), 'the two dark blocks disagree');

    // The page's own block: the `:root` after the tokens. Aliases and measures only.
    const own = style.slice(style.indexOf(tokens) + tokens.length);
    const extension = declarations(blockOf(own, ':root'));
    assert.ok(extension.has('--void'), 'the page no longer names its ground');
    for (const [name, value] of extension) {
      assert.ok(!isColour(value), `${name}: ${value} defines a colour outside the tokens`);
    }

    const defined = new Set([...light.keys(), ...extension.keys()]);
    const used = new Set([...page.matchAll(/var\((--[\w-]+)\)/g)].map(([, name]) => name));
    assert.ok(used.size >= 30, `only ${used.size} tokens are used; the page is not built on them`);
    for (const name of used) {
      assert.ok(defined.has(name), `${name} is used but never defined`);
    }

    // Outside the token palettes, no colour is written out by hand.
    const outside = own.replace(/:root\s*\{[^}]*\}/, '').match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g);
    assert.deepEqual(outside ?? [], [], 'a colour is hard-coded outside the tokens');
    const inSvg = page
      .replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/<style[\s\S]*?<\/style>/g, '')
      .match(/(?:fill|stroke)="#[^"]*"/g);
    assert.deepEqual(inSvg ?? [], [], 'an SVG paints a colour that is not a token');
  });

  test('light is the default, and data-theme="dark" paints a dark ground with light ink', async () => {
    /**
     * The tokens are light-first and the page follows them: a reader with no preference gets
     * a white ground. Dark is a palette in its own right, reached by the system preference or
     * by the attribute — and it has to be dark, not a light page with a dark token or two.
     */
    const { tab, context } = await open(1440);
    const light = await tab.$eval('body', (node) => ({
      bg: getComputedStyle(node).backgroundColor,
      ink: getComputedStyle(node).color,
    }));
    assert.ok(luminance(light.bg) > 0.8, `the default ground is ${light.bg}`);
    assert.ok(luminance(light.ink) < 0.05, `the default ink is ${light.ink}`);
    const linkOnLight = await tab.$eval('.foot-end a', (node) => getComputedStyle(node).color);
    assert.ok(contrast(linkOnLight, light.bg) >= 4.5, `a link is ${linkOnLight} on ${light.bg}`);

    await tab.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    const dark = await tab.$eval('body', (node) => ({
      bg: getComputedStyle(node).backgroundColor,
      ink: getComputedStyle(node).color,
    }));
    assert.ok(luminance(dark.bg) < 0.05, `the dark ground is ${dark.bg}`);
    assert.ok(luminance(dark.ink) > 0.8, `the dark ink is ${dark.ink}`);
    const linkOnDark = await tab.$eval('.foot-end a', (node) => getComputedStyle(node).color);
    assert.ok(contrast(linkOnDark, dark.bg) >= 4.5, `a link is ${linkOnDark} on ${dark.bg}`);
    await context.close();
  });

  test('motion is switched off for a reader who asked for none', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const tab = await context.newPage();
    await tab.route('**/*', (route) => route.abort());
    await tab.route(`${PAGE}*`, (route) => route.fulfill({ path: pageFile, contentType: 'text/html' }));
    await tab.goto(PAGE, { waitUntil: 'domcontentloaded' });
    const duration = await tab.$eval('.rise', (node) => getComputedStyle(node).animationDuration);
    assert.ok(parseFloat(duration) < 0.01, `the entrance still runs for ${duration}`);
    assert.equal(await tab.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior), 'auto');
    await context.close();
  });

  test('body copy keeps a readable measure at every width', async () => {
    // 45-75 characters a line is where prose reads fastest; a paragraph the full width of a
    // 1440px screen is 180. Measured in the browser, because a `max-width` in ch depends on
    // the face that actually rendered.
    const { tab, context } = await open(1440);
    const widths = await tab.$$eval('.body > p, .lede, .hero-sub, .note, figcaption', (nodes) =>
      nodes.map((node) => {
        const size = parseFloat(getComputedStyle(node).fontSize);
        return { text: node.textContent.trim().slice(0, 30), chars: node.getBoundingClientRect().width / (size * 0.5) };
      }),
    );
    assert.ok(widths.length >= 10);
    for (const item of widths) {
      assert.ok(item.chars <= 80, `"${item.text}…" runs ${Math.round(item.chars)} characters wide`);
    }
    await context.close();
  });

  test('every link points at something the static bundle actually ships', async (t) => {
    /**
     * `claims.test.mjs` holds the links to the bundle's manifest as text. This holds them to
     * the bundle itself: `deploy/out`, as `npm run build:static` writes it. A fragment must
     * land on an element; a path must be a file the host will serve under `cleanUrls`; and
     * nothing on the page points off our domain except the font host.
     *
     * The bundle needs every app built, which this workspace's own test does not do — so when
     * a sibling page is missing the bundle is not assembled here and the test says so rather
     * than failing on somebody else's build. The manifest check in claims.test.mjs still runs.
     */
    const manifest = readFileSync(join(repo, 'deploy', 'build-static.mjs'), 'utf8');
    const sources = [...manifest.matchAll(/from: '([^']+)'/g)].map(([, from]) => from);
    assert.ok(sources.length >= 5, 'read no pages out of the bundle manifest; the regex is stale');
    const missing = sources.filter((from) => !existsSync(join(repo, from)));
    if (missing.length > 0) {
      t.skip(`the bundle cannot be assembled here: ${missing.join(', ')} not built`);
      return;
    }

    execFileSync(process.execPath, [join(repo, 'deploy', 'build-static.mjs')], {
      cwd: repo,
      stdio: 'pipe',
      env: { ...process.env, AVEX_API_URL: 'https://api.avexpay.net', AVEX_SITE_URL: 'https://avexpay.net' },
    });
    const out = join(repo, 'deploy', 'out');
    const shipped = new Set(readdirSync(out));
    assert.ok(shipped.has('index.html') && shipped.has('docs.html'), 'the bundle is not what the manifest describes');

    const { tab, context } = await open(1440);
    const links = await tab.$$eval('a[href]', (nodes) =>
      nodes.map((node) => ({ href: node.getAttribute('href'), url: node.href, text: node.textContent.trim() })),
    );
    assert.ok(links.length >= 20, `only ${links.length} links`);

    for (const link of links) {
      if (link.href.startsWith('#')) {
        const exists = await tab.evaluate((id) => document.getElementById(id) !== null, link.href.slice(1));
        assert.ok(exists, `"${link.text}" points at ${link.href}, which is not on the page`);
        continue;
      }
      const url = new URL(link.url);
      assert.equal(url.host, 'avex.test', `"${link.text}" leaves the site for ${url.host}`);
      const path = url.pathname;
      // `cleanUrls`: `/docs` is docs.html, `/` is index.html; a directory is its index.
      const candidates =
        path === '/' ? ['index.html'] : [`${path.slice(1)}.html`, join(path.slice(1), 'index.html')];
      assert.ok(
        candidates.some((file) => existsSync(join(out, file))),
        `"${link.text}" points at ${path}, and the bundle ships no ${candidates[0]}`,
      );
    }
    await context.close();
  });
});

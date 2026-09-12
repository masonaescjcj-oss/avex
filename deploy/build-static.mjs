/**
 * Assemble the four static pages into one directory a static host can serve.
 *
 * Every page in this product is a single self-contained HTML file with no framework and no
 * build server — so "deploying the front end" is copying four files and filling in two
 * values. This script is that, and it exists rather than a README instruction because the
 * two values are the ones that break a split deployment silently:
 *
 *   - `avex-api`: where the API is. Empty means same origin, which is right when one host
 *     serves both and wrong the moment they are split. It was read by three pages and
 *     declared by none, so a split deployment sent every request to the static host and got
 *     HTML back where JSON was expected.
 *   - `avex-dashboard`: where the site's sign-in and sign-up buttons point.
 *
 * Usage:
 *   AVEX_API_URL=https://api.avexpay.net \
 *   AVEX_SITE_URL=https://avexpay.net \
 *   node deploy/build-static.mjs
 *
 * Output: deploy/out/, which is what a host's "output directory" should point at.
 */

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const out = join(here, 'out');

const API_URL = (process.env.AVEX_API_URL ?? '').trim().replace(/\/+$/, '');
const SITE_URL = (process.env.AVEX_SITE_URL ?? '').trim().replace(/\/+$/, '');

/**
 * An empty API URL is allowed and means same origin.
 *
 * Refused instead: a value that cannot survive being put in an HTML attribute. A quote would
 * end the attribute and the rest would be parsed as markup, which is a broken page rather
 * than a wrong URL — and a broken page is harder to diagnose than a 404.
 */
if (API_URL !== '' && /["'<>\s]/.test(API_URL)) {
  console.error(`AVEX_API_URL is not usable in an attribute: ${API_URL}`);
  process.exit(1);
}

/**
 * Replace a meta tag's content, and refuse if the tag is not there.
 *
 * Silence would be the bad outcome: a page whose meta tag was renamed would deploy with an
 * empty API base and fail at runtime, in the browser, with a message about JSON parsing.
 */
function setMeta(html, name, value, file) {
  const pattern = new RegExp(`(<meta name="${name}" content=")[^"]*(">)`);
  if (!pattern.test(html)) {
    console.error(`${file} has no <meta name="${name}">; nothing would configure it`);
    process.exit(1);
  }
  return html.replace(pattern, (_match, open, close) => `${open}${value}${close}`);
}

/** Every page, where it comes from, and where it goes. */
const PAGES = [
  { from: 'apps/site/public/index.html', to: 'index.html', api: false },
  { from: 'apps/merchant/public/merchant.html', to: 'dashboard.html', api: true },
  { from: 'apps/admin/public/admin.html', to: 'admin.html', api: true },
  { from: 'apps/checkout/public/checkout.html', to: 'pay.html', api: true },
  { from: 'apps/checkout/public/receipt.html', to: 'receipt.html', api: true },
  /**
   * The API reference, served from our own domain.
   *
   * It shipped for a while as a link to a claude.ai artifact, which is where it was first
   * drafted — a production site sending its developers to somebody else's host for the
   * document that tells them how to take money. It is self-contained HTML with no external
   * links, so serving it is a copy.
   */
  { from: 'docs/api.html', to: 'docs.html', api: false },
];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const page of PAGES) {
  const source = join(repo, page.from);
  let html = readFileSync(source, 'utf8');

  if (page.api) html = setMeta(html, 'avex-api', API_URL, page.from);

  /**
   * The site's buttons point at the dashboard on this same host.
   *
   * A relative path rather than the site URL, so the artefact does not have to know its own
   * hostname — and so a preview deployment on a throwaway domain still links to itself
   * rather than to production.
   */
  if (page.to === 'index.html') html = setMeta(html, 'avex-dashboard', '/dashboard', page.from);

  writeFileSync(join(out, page.to), html);
  console.log(`${page.to.padEnd(14)} ← ${page.from} (${(html.length / 1024).toFixed(1)} KB)`);
}

/**
 * What makes the dashboard installable: a manifest, the icons a launcher draws, and the
 * service worker.
 *
 * These are the only files here that are not self-contained pages, and they have to be: a
 * browser fetches a manifest from a URL, and a launcher paints an icon without ever loading
 * the page it belongs to, so neither can be a data URI inlined into the HTML.
 *
 * The worker's cache name carries the build, so a deploy cannot reuse the last one's entries.
 * Everything else about it is deliberately timid — network first, this origin only — for
 * reasons written at the top of the file itself.
 */
const site = join(repo, 'apps', 'site', 'public');

/** A build identity the worker can put in its cache name. Time is enough: it only has to differ. */
const BUILD = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);

const worker = readFileSync(join(site, 'sw.js'), 'utf8');
if (!worker.includes('__BUILD__')) {
  console.error('sw.js has no __BUILD__ placeholder; its cache would never be invalidated');
  process.exit(1);
}
writeFileSync(join(out, 'sw.js'), worker.replace('__BUILD__', BUILD));
cpSync(join(site, 'app.webmanifest'), join(out, 'app.webmanifest'));
cpSync(join(site, 'icons'), join(out, 'icons'), { recursive: true });
console.log(`sw.js           ← apps/site/public/sw.js (cache avex-shell-${BUILD})`);
console.log('app.webmanifest ← apps/site/public/app.webmanifest');
console.log('icons/          ← apps/site/public/icons');

/**
 * The WooCommerce plugin, as a download.
 *
 * Shipped beside the pages because the docs point at it and a plugin nobody can download is
 * a plugin nobody installs. Copied rather than zipped: zipping needs a tool this script
 * cannot assume, and a host serves a directory perfectly well.
 */
const plugin = join(repo, 'integrations', 'woocommerce');
try {
  cpSync(plugin, join(out, 'woocommerce'), { recursive: true });
  console.log('woocommerce/    ← integrations/woocommerce');
} catch {
  // Absent in a checkout that does not include it; not worth failing the deployment over.
  console.log('woocommerce/    (skipped: not present)');
}

writeFileSync(
  join(out, 'robots.txt'),
  [
    'User-agent: *',
    'Allow: /$',
    // The dashboard, the admin panel and a payer's checkout have nothing a crawler should
    // hold. A receipt especially: it is a link somebody was given, not a page to index.
    'Disallow: /dashboard',
    'Disallow: /admin',
    'Disallow: /pay',
    'Disallow: /receipt',
    '',
  ].join('\n'),
);

console.log(
  `\nwrote ${out}\n  api      = ${API_URL === '' ? '(same origin)' : API_URL}\n  site     = ${SITE_URL === '' ? '(unset)' : SITE_URL}`,
);

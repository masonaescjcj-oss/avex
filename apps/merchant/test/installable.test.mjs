import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The dashboard as an installable app, checked where it can actually be checked.
 *
 * Every part of this is invisible until somebody tries to install it, and then it fails as a
 * missing menu item rather than an error — a manifest that 404s, an icon the manifest names
 * and the build does not ship, a service worker registered at a path nothing serves. None of
 * those break the page, so nothing else in this repository would ever notice.
 *
 * So the assertions are about agreement between four files that have no other reason to know
 * about each other: the page, the manifest, the icons on disk, and the static build.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const site = join(repo, 'apps', 'site', 'public');

const page = readFileSync(join(repo, 'apps', 'merchant', 'public', 'merchant.html'), 'utf8');
const manifest = JSON.parse(readFileSync(join(site, 'app.webmanifest'), 'utf8'));
const worker = readFileSync(join(site, 'sw.js'), 'utf8');
const builder = readFileSync(join(repo, 'deploy', 'build-static.mjs'), 'utf8');

describe('the dashboard is installable', () => {
  test('the page links a manifest, and the build ships it', () => {
    assert.match(page, /<link rel="manifest" href="\/app\.webmanifest">/);
    assert.match(builder, /app\.webmanifest/, 'the static build copies it');
  });

  test('every icon the manifest names exists, and is a PNG', () => {
    /**
     * A launcher paints the icon without loading the page, so it has to be a real file at a
     * real path — and a manifest naming one that is not there installs with a blank badge and
     * no error anywhere.
     */
    const named = [
      ...manifest.icons.map((icon) => icon.src),
      ...manifest.shortcuts.flatMap((shortcut) => shortcut.icons.map((icon) => icon.src)),
    ];
    assert.ok(named.length >= 3);

    for (const src of new Set(named)) {
      assert.ok(src.startsWith('/icons/'), `${src} is not under /icons/`);
      const file = join(site, src.replace(/^\//, ''));
      assert.ok(existsSync(file), `${src} is named by the manifest but not on disk`);
      // PNG's magic number. A committed SVG renamed to .png installs as nothing at all.
      assert.deepEqual([...readFileSync(file).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], src);
    }
  });

  test('iOS gets the icon it actually reads', () => {
    // It ignores the manifest for the home screen entirely, so the link tag is not optional.
    assert.match(page, /<link rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png">/);
    assert.ok(existsSync(join(site, 'icons', 'apple-touch-icon.png')));
  });

  test('there is a maskable icon, because Android crops the other kind', () => {
    /**
     * Without one, a launcher that masks to a circle cuts the corners off the rounded tile and
     * leaves a visibly wrong badge. With one, the mark sits inside the safe zone.
     */
    const maskable = manifest.icons.filter((icon) => icon.purpose === 'maskable');
    assert.equal(maskable.length, 1);
    assert.equal(maskable[0].sizes, '512x512');
  });

  test('it opens on the dashboard, not on the marketing page', () => {
    // An installed app whose start_url is the front page is one the merchant has to navigate
    // out of every time they open it.
    assert.equal(manifest.start_url, '/dashboard');
    assert.equal(manifest.scope, '/dashboard');
    assert.equal(manifest.display, 'standalone');
  });

  test('the theme colour on the page and in the manifest are the same', () => {
    // They tint the same status bar, from two places, and disagreeing looks like a bug in the
    // app rather than in a config file.
    const [, onPage] = page.match(/<meta name="theme-color" content="([^"]+)">/) ?? [];
    assert.equal(onPage, manifest.theme_color);
  });

  test('the worker is registered where the build serves it', () => {
    assert.match(page, /navigator\.serviceWorker\.register\('\/sw\.js'/);
    assert.match(builder, /join\(out, 'sw\.js'\)/, 'the static build writes /sw.js');
  });

  test('the worker never reaches past this origin', () => {
    /**
     * The rule that matters most in a payment product. The API is another origin, and a worker
     * replaying yesterday's answer to "has this been paid" is the worst bug this file could
     * have. It is enforced by the worker returning early rather than by a cache rule.
     */
    assert.match(worker, /url\.origin !== self\.location\.origin\)\s*return;/);
  });

  test('the worker is network first, so a deploy is never hidden behind it', () => {
    /**
     * This project has already spent a day on "is the new build live". A cache-first worker
     * would make that question permanently unanswerable for anyone without the merchant's
     * phone in their hand.
     */
    const fetchHandler = worker.slice(worker.indexOf("addEventListener('fetch'"));
    const network = fetchHandler.indexOf('await fetch(request)');
    const fallback = fetchHandler.indexOf('caches.match(request)');
    assert.ok(network > 0 && fallback > network, 'the cache is only read after the network fails');
    // And a failed response is never kept, or an outage would outlive itself.
    assert.match(fetchHandler, /if \(fresh\.ok\)/);
  });

  test('the cache name carries the build, and the build insists on it', () => {
    assert.match(worker, /const CACHE = 'avex-shell-__BUILD__'/);
    // The builder refuses rather than shipping a worker whose cache never changes.
    assert.match(builder, /__BUILD__/);
    assert.match(builder, /process\.exit\(1\)/);
  });
});

/**
 * What every page build inlines from the design package.
 *
 * These pages are single self-contained files: no stylesheet, no sprite sheet, no logo
 * file to fetch. Everything shared therefore has to be inlined at build time, and doing
 * it in one place is what keeps the four apps from drifting into four logos.
 *
 * Each function replaces its marker with a *function*, never a string: `String.replace`
 * reads `$&` and `$1` in a string replacement as substitution patterns, and an SVG path
 * or a data URI is exactly the kind of text that contains them. Each one then asserts the
 * result actually contains what it injected, which is the check that would have caught it.
 */

import { avexFaviconUri, avexMarkPath } from './brand/brand.mjs';
import { coinSprite } from './coins/sprite.mjs';

const MARK = '<!-- @inject:mark -->';
const FAVICON = '<!-- @inject:favicon -->';
const COINS = '<!-- @inject:coins -->';

/** Replace every occurrence of a marker, or fail loudly. */
function put(html, marker, value, what) {
  if (!html.includes(marker)) {
    throw new Error(`the template is missing the ${marker} marker, so ${what} would not be in the page`);
  }
  const parts = html.split(marker);
  const out = parts.join(value);
  if (!out.includes(value)) {
    throw new Error(`inlining altered ${what}; refusing to write a corrupt page`);
  }
  return out;
}

/**
 * The logo and the favicon.
 *
 * The mark is the traced brand path, dropped inside the tile each template already draws,
 * so the tile's lime and ink stay design tokens and follow the theme. The favicon is the
 * same mark as a data URI, because these pages are served from several paths on one host
 * and a relative icon href would 404 on all but one of them.
 */
export function injectBrand(html) {
  const withMark = put(html, MARK, avexMarkPath(), 'the brand mark');
  return put(withMark, FAVICON, `<link rel="icon" href="${avexFaviconUri()}">`, 'the favicon');
}

/**
 * The coin icons, as one `<symbol>` sprite.
 *
 * Only for pages that name currencies. `symbols` is the set the page can actually show —
 * asking for one with no icon fails the build rather than shipping a `<use>` that draws
 * nothing, because a missing badge in a currency picker is a hole nobody reports.
 */
export function injectCoins(html, symbols) {
  return put(html, COINS, coinSprite(symbols), 'the coin icons');
}

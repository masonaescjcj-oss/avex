/**
 * The coin icons, as one inline sprite.
 *
 * Every page in this repo is a single file that reaches no host, so an icon has to be in
 * the HTML. Inlining the same `<svg>` at each of a dozen call sites would put the same
 * kilobyte in the page a dozen times, so each icon goes in once as a `<symbol>` and the
 * call sites are `<use>`.
 *
 * The icons keep their own brand colours — a stablecoin's badge is part of how a payer
 * recognises it, and recolouring Tether green or Circle blue to match our palette would
 * make the picker harder to read, not more ours. They are full-bleed squares: round them
 * with `border-radius` and `overflow: hidden` on the element around them.
 *
 * Ids inside the files are already namespaced per symbol (`eth-a`, not `a`), which is what
 * lets several of them share one document.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Every symbol an icon exists for. */
export function coinSymbols() {
  return readdirSync(here)
    .filter((name) => name.endsWith('.svg'))
    .map((name) => name.replace(/\.svg$/, ''))
    .sort();
}

/**
 * The sprite for the given symbols, or for all of them.
 *
 * Refuses a symbol with no icon rather than emitting a `<use>` that silently draws
 * nothing: a missing badge in a currency picker is the kind of hole nobody reports.
 */
export function coinSprite(symbols = coinSymbols()) {
  const symbolMarkup = symbols.map((symbol) => {
    let file;
    try {
      file = readFileSync(join(here, `${symbol}.svg`), 'utf8');
    } catch {
      throw new Error(`no coin icon for ${symbol}; add packages/design/coins/${symbol}.svg`);
    }
    const viewBox = /viewBox="([^"]+)"/.exec(file)?.[1];
    if (viewBox === undefined) throw new Error(`${symbol}.svg has no viewBox`);
    const inner = file.replace(/^[^]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').trim();
    return `<symbol id="coin-${symbol.toLowerCase()}" viewBox="${viewBox}">${inner}</symbol>`;
  });
  // Hidden by size, not by `display:none`: a paint server inside a display:none subtree is
  // not resolved for a <use> that references it, which showed up as four of the thirteen
  // icons — every one whose background is a gradient — drawing as blank squares.
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"' +
    ' style="position:absolute;width:0;height:0;overflow:hidden">' +
    `${symbolMarkup.join('')}</svg>`
  );
}

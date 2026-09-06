/**
 * The brand mark, for the page builds.
 *
 * Every page here is one self-contained file, so the logo has to be inline markup — and
 * there are nine places across four apps that draw it. They all draw the same thing, so
 * they all read it from here: the templates keep the `<svg>` and the lime tile (whose
 * colours are design tokens), and the build drops the traced path inside.
 *
 * `mark.path.svg` and `mark-tile.svg` are written by `trace-mark.mjs` from the logo file
 * the merchant supplied. Do not hand-edit them.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** The mark as one path, unfilled, in the 0 0 100 100 box the templates use. */
export function avexMarkPath() {
  return readFileSync(join(here, 'mark.path.svg'), 'utf8').trim();
}

/**
 * The mark as a favicon, ready for `<link rel="icon" href="…">`.
 *
 * A data URI rather than a file because these pages are served as single files from
 * several different paths; a relative icon href would 404 on at least one of them. The
 * hex colours are the tokens' own values: a favicon is painted by the browser chrome,
 * which has never heard of our custom properties.
 */
export function avexFaviconUri() {
  const svg = readFileSync(join(here, 'mark-tile.svg'), 'utf8')
    .replace(/<!--[^]*?-->/g, '')
    .trim();
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

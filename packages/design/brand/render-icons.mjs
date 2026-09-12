/**
 * Rasterise the brand mark into the PNG icons an installed web app needs.
 *
 * Run by hand, and the output is committed. That is deliberate: the static build runs on a
 * host with no browser, so generating these at deploy time would either fail there or make the
 * deployment depend on a Chromium nobody installed. A handful of PNGs in git is the cheaper
 * promise — regenerate with `node packages/design/brand/render-icons.mjs` when the mark
 * changes, which is the same rule `trace-mark.mjs` already sets for the path itself.
 *
 * Two shapes come out, and the difference matters on Android:
 *
 *   - the plain icon is the tile as drawn, rounded corners and all;
 *   - the *maskable* one has the mark shrunk into the middle of a square that bleeds lime to
 *     every edge, because a launcher crops a maskable icon to whatever shape it likes — a
 *     circle, a squircle, a teardrop — and anything in the outer fifth may simply not be
 *     there. Handing it the rounded tile would clip the corners off the tile and leave a
 *     visibly wrong badge.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchChromium } from '../chromium.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', '..', '..', 'apps', 'site', 'public', 'icons');

/** The tokens' own values. A launcher icon is painted by the OS, which has no custom properties. */
const LIME = '#c8f135';
const INK = '#0f1114';

const markPath = readFileSync(join(here, 'mark.path.svg'), 'utf8').trim();

/** The tile as the pages draw it: rounded square, mark filling it. */
const plain = (size) => `
  <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="22" fill="${LIME}"/>
    <g fill="${INK}">${markPath}</g>
  </svg>`;

/**
 * The maskable one. 62% of the canvas, centred, on lime that reaches every edge.
 *
 * Android's safe zone is the middle 80% by diameter; 62% leaves room for the circle crop and
 * still fills the badge rather than floating a stamp in the middle of it.
 */
const maskable = (size) => {
  const scale = 0.62;
  const offset = (100 - 100 * scale) / 2;
  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
    <rect width="100" height="100" fill="${LIME}"/>
    <g transform="translate(${offset} ${offset}) scale(${scale})" fill="${INK}">${markPath}</g>
  </svg>`;
};

const ICONS = [
  { file: 'icon-192.png', size: 192, svg: plain },
  { file: 'icon-512.png', size: 512, svg: plain },
  { file: 'icon-maskable-512.png', size: 512, svg: maskable },
  /**
   * iOS ignores the manifest's icons for the home screen and reads `apple-touch-icon`, which
   * it also composites onto a white sheet without rounding — so this one is the plain tile at
   * the size Apple asks for, corners included.
   */
  { file: 'apple-touch-icon.png', size: 180, svg: plain },
];

const browser = await launchChromium();
try {
  const page = await browser.newPage();
  mkdirSync(out, { recursive: true });

  for (const icon of ICONS) {
    const svg = icon.svg(icon.size);
    await page.setViewportSize({ width: icon.size, height: icon.size });
    await page.setContent(
      `<body style="margin:0">${svg}</body>`,
      { waitUntil: 'load' },
    );
    const png = await page.screenshot({ omitBackground: true });
    writeFileSync(join(out, icon.file), png);
    console.log(`${icon.file.padEnd(24)} ${icon.size}×${icon.size}  ${(png.length / 1024).toFixed(1)} KB`);
  }
} finally {
  await browser.close();
}

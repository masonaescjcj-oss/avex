/**
 * Turn the AVEX logo bitmap into one SVG path.
 *
 * The brand mark arrived as a 640×640 JPEG. A page that reaches no host has to draw it
 * inline, and a raster inline is both large and soft at the sizes we actually use it
 * (16–40 px), so it has to become a path. There is no tracer on this machine, so this
 * does the tracing: decode the image in Chromium, threshold it, walk the boundary of the
 * ink with marching squares, simplify each contour, and emit one even-odd path.
 *
 * Run it when the source logo changes:
 *   node packages/design/brand/trace-mark.mjs
 *
 * It writes mark.svg (the mark alone, in currentColor) and mark-tile.svg (the mark on the
 * lime square, the form the source file is in).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchChromium } from '../chromium.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(here, 'avex-logo-source.jpg');
const TOLERANCE = Number(process.argv[2] ?? 2); // px, at the source own 640 scale
const GRID = 128; // the viewBox the mark ends up in

const dataUri = 'data:image/jpeg;base64,' + readFileSync(SOURCE).toString('base64');

const browser = await launchChromium();
const page = await browser.newPage();
await page.goto('about:blank');

const traced = await page.evaluate(async (uri) => {
  const img = new Image();
  img.src = uri;
  await img.decode();
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, w, h);

  // Ink is the dark half of a two-colour logo: lime is luminous, the arches are not.
  const lum = (i) => 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  const ink = (x, y) =>
    x < 0 || y < 0 || x >= w || y >= h ? false : lum((y * w + x) * 4) < 128;

  // Walk the boundary between ink and not-ink. Every side of every ink pixel whose
  // neighbour is not ink becomes one directed step, oriented so the ink is always on the
  // right of travel. That makes in-degree equal out-degree at every lattice point, so
  // following unused steps from wherever you stand always closes a ring — including at the
  // corners where two arms of the mark touch diagonally.
  const key = (x, y) => y * (w + 2) + x;
  const out = new Map();
  const step = (x1, y1, x2, y2) => {
    const from = key(x1, y1);
    let list = out.get(from);
    if (list === undefined) out.set(from, (list = []));
    list.push([x2, y2]);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!ink(x, y)) continue;
      if (!ink(x, y - 1)) step(x, y, x + 1, y);
      if (!ink(x + 1, y)) step(x + 1, y, x + 1, y + 1);
      if (!ink(x, y + 1)) step(x + 1, y + 1, x, y + 1);
      if (!ink(x - 1, y)) step(x, y + 1, x, y);
    }
  }

  const rings = [];
  for (const [from, steps] of out) {
    while (steps.length > 0) {
      const ring = [];
      let at = from;
      while (true) {
        const here = out.get(at);
        if (here === undefined || here.length === 0) break;
        const [nx, ny] = here.pop();
        ring.push([nx, ny]);
        at = key(nx, ny);
      }
      if (ring.length > 8) rings.push(ring);
    }
  }
  return { w, h, rings };
}, dataUri);

await browser.close();

/** Ramer–Douglas–Peucker: drop the points a straight line already accounts for. */
function simplify(points, tolerance) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop();
    let worst = 0;
    let index = -1;
    const [ax, ay] = points[first];
    const [bx, by] = points[last];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    for (let i = first + 1; i < last; i++) {
      const [px, py] = points[i];
      const d = Math.abs(dy * (px - ax) - dx * (py - ay)) / len;
      if (d > worst) { worst = d; index = i; }
    }
    if (index !== -1 && worst > tolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

/**
 * Normalise the traced ink into a square 0 0 100 100 box.
 *
 * The source file is a tile — the arch sits in the middle of a lime square with a wide
 * margin — and the pages need the mark itself, at whatever size a header or a list row
 * asks for. So the ink is scaled to fill a 100-unit box (minus a hair of padding) and
 * centred in it, which also makes the path a drop-in for the placeholder it replaces:
 * every template already draws its mark in `viewBox="0 0 100 100"`.
 */
const BOX = 100;
const PAD = 2;
const rings = traced.rings.map((ring) => simplify(ring, TOLERANCE)).filter((ring) => ring.length > 3);
const xs = rings.flatMap((ring) => ring.map(([x]) => x));
const ys = rings.flatMap((ring) => ring.map(([, y]) => y));
const minX = Math.min(...xs);
const minY = Math.min(...ys);
const scale = (BOX - PAD * 2) / Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY);
const offX = (BOX - (Math.max(...xs) - minX) * scale) / 2;
const offY = (BOX - (Math.max(...ys) - minY) * scale) / 2;
const at = (x, y) => `${Number(((x - minX) * scale + offX).toFixed(1))} ${Number(((y - minY) * scale + offY).toFixed(1))}`;
const d = rings.map((ring) => 'M' + ring.map(([x, y]) => at(x, y)).join('L') + 'Z').join('');
const inner = `<path fill="currentColor" fill-rule="evenodd" d="${d}"/>`;
const head = `<!--\n  The AVEX mark, traced from brand/avex-logo-source.jpg by brand/trace-mark.mjs.\n  Edit the source and re-run the tracer; never hand-edit the path.\n-->\n`;

writeFileSync(join(here, 'mark.svg'), `${head}<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BOX} ${BOX}">${inner}</svg>\n`);

// The tile keeps the source's own framing, because that framing is what makes it a tile:
// this is the form the logo arrived in, and the one an app icon or an avatar wants. Its
// path is built straight from the source pixels rather than from the normalised mark, so
// the arch sits exactly where the merchant drew it — legs on the bottom edge and all.
const tile = (x, y) => `${Number(((x * BOX) / traced.w).toFixed(1))} ${Number(((y * BOX) / traced.h).toFixed(1))}`;
const dTile = rings.map((ring) => 'M' + ring.map(([x, y]) => tile(x, y)).join('L') + 'Z').join('');
writeFileSync(
  join(here, 'mark-tile.svg'),
  `${head}<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BOX} ${BOX}">` +
    `<rect width="${BOX}" height="${BOX}" rx="22" fill="#c8f135"/>` +
    `<path fill="#0f1114" fill-rule="evenodd" d="${dTile}"/></svg>\n`,
);

// Just the path, in tile coordinates and with no fill of its own, for the page builds to
// drop inside a template's own <svg>: every page draws the mark as the lime tile, and the
// colours there come from the design tokens rather than from this file.
writeFileSync(join(here, 'mark.path.svg'), `<path fill-rule="evenodd" d="${dTile}"/>\n`);

console.log(`traced ${traced.rings.length} rings -> ${rings.length} contours, ${d.length} chars of path`);

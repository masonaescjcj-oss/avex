/**
 * The plugin directory's icon and banner, drawn rather than exported.
 *
 * Usage: node integrations/woocommerce/assets/render-assets.mjs
 *
 * ## Why this is a script and not two PNGs in the repository
 *
 * Because a PNG in a repository is a file nobody can change. The directory wants specific sizes
 * — 256×256 for an icon, 1544×500 for a banner — and wants them again at different sizes the day
 * it changes its layout, and the mark itself comes from `receipt.template.html`, where it is an
 * SVG that somebody may edit. A script keeps one source for the shape and re-renders whatever is
 * asked for.
 *
 * It writes its own PNGs because this repository has no image toolchain and adding one for two
 * files would be a dependency with a build step, a lockfile and a supply chain, to do something
 * that is a zlib stream and four chunks. The same reasoning that put sha256 and base58 in
 * `packages/core` by hand.
 *
 * ## What is drawn
 *
 * The AVEX mark, which is the one in the receipt header: a lime rounded square with two nested
 * arches struck through it in the void colour. The arches are the cubic Béziers from that SVG,
 * flattened and stroked here by distance rather than by a path renderer — for a shape made of
 * two strokes and a rounded rectangle, "how far is this pixel from the curve" is the whole
 * algorithm, and it antialiases for free at four samples a pixel.
 *
 * The wordmark is monoline: every letter is a set of segments stroked with round caps, which is
 * both what the brand's monospace numerals suggest and the only kind of lettering worth drawing
 * without a font file.
 */

import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// ── the palette, from the design language ────────────────────────────────────

const VOID = [0x00, 0x00, 0x00];
const LIME = [0xc6, 0xf7, 0x3f];
const INK = [0xff, 0xff, 0xff];

/** Samples per pixel per axis. Four is sixteen samples, which is enough for a stroke. */
const SUPERSAMPLE = 4;

// ── geometry ────────────────────────────────────────────────────────────────

/** A cubic Bézier, flattened to points. Dense enough that the gaps are under a pixel. */
function flattenCubic(p0, p1, p2, p3, steps = 240) {
  const points = [];
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    const u = 1 - t;
    points.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return points;
}

/** Squared distance from a point to a segment. Squared, because nothing needs the root. */
function distanceToSegment(x, y, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return (x - ax) ** 2 + (y - ay) ** 2;

  let t = ((x - ax) * dx + (y - ay) * dy) / lengthSquared;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return (x - (ax + t * dx)) ** 2 + (y - (ay + t * dy)) ** 2;
}

/** Inside a stroked polyline, with round joins and caps — which is what the min distance gives. */
function inStroke(x, y, points, width) {
  const radius = (width / 2) ** 2;
  for (let index = 1; index < points.length; index += 1) {
    if (distanceToSegment(x, y, points[index - 1], points[index]) <= radius) return true;
  }
  return false;
}

/** Inside a rounded rectangle. */
function inRoundedRect(x, y, left, top, width, height, radius) {
  const right = left + width;
  const bottom = top + height;
  if (x < left || x > right || y < top || y > bottom) return false;

  const cx = x < left + radius ? left + radius : x > right - radius ? right - radius : x;
  const cy = y < top + radius ? top + radius : y > bottom - radius ? bottom - radius : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
}

/**
 * The mark, as a test at a point, in its own 0–100 coordinates.
 *
 * The two arches are the paths from the receipt's header SVG. `M12 86C14.6 39 32.7 13 50 13C67.3
 * 13 85.4 39 88 86` is two cubics meeting at the top, and the inner arch is the same shape drawn
 * smaller — so the mark is one gesture repeated, which is why it reads at 16 pixels as well as at
 * 256.
 */
const OUTER = [
  ...flattenCubic([12, 86], [14.6, 39], [32.7, 13], [50, 13]),
  ...flattenCubic([50, 13], [67.3, 13], [85.4, 39], [88, 86]),
];
const INNER = [
  ...flattenCubic([28, 86], [29.5, 55], [38.5, 33], [50, 33]),
  ...flattenCubic([50, 33], [61.5, 33], [70.5, 55], [72, 86]),
];

function markColour(u, v) {
  // u, v in 0..100. Outside the tile is transparent.
  if (!inRoundedRect(u, v, 0, 0, 100, 100, 22)) return null;
  if (inStroke(u, v, OUTER, 9) || inStroke(u, v, INNER, 9)) return VOID;
  return LIME;
}

// ── monoline lettering ──────────────────────────────────────────────────────

/**
 * Letters as segments in a 0–1 box, drawn as strokes.
 *
 * Only the six characters the wordmark needs. Written out rather than taken from a font because
 * embedding a font to set one word is a licence to read and a file to ship, and because a
 * monoline capital is a handful of coordinates.
 */
const GLYPHS = {
  A: [
    [
      [0, 1],
      [0.5, 0],
      [1, 1],
    ],
    [
      [0.18, 0.62],
      [0.82, 0.62],
    ],
  ],
  V: [
    [
      [0, 0],
      [0.5, 1],
      [1, 0],
    ],
  ],
  E: [
    [
      [1, 0],
      [0, 0],
      [0, 1],
      [1, 1],
    ],
    [
      [0, 0.5],
      [0.78, 0.5],
    ],
  ],
  X: [
    [
      [0, 0],
      [1, 1],
    ],
    [
      [1, 0],
      [0, 1],
    ],
  ],
  P: [
    [
      [0, 1],
      [0, 0],
      [0.62, 0],
    ],
    // The bowl, out and back. Faceted visibly at the shoulder with fewer points than this.
    [
      [0.62, 0],
      [0.85, 0.05],
      [0.97, 0.15],
      [1, 0.26],
      [0.97, 0.37],
      [0.85, 0.47],
      [0.62, 0.52],
      [0, 0.52],
    ],
  ],
  Y: [
    [
      [0, 0],
      [0.5, 0.52],
      [1, 0],
    ],
    [
      [0.5, 0.52],
      [0.5, 1],
    ],
  ],
};

/** A word as polylines placed on the canvas. */
function layout(word, x, y, size, tracking) {
  const advance = size * 0.72 + tracking;
  const lines = [];
  let cursor = x;

  for (const character of word) {
    if (character === ' ') {
      cursor += advance * 0.6;
      continue;
    }
    const glyph = GLYPHS[character];
    if (glyph === undefined) throw new Error(`no glyph for "${character}"`);

    for (const stroke of glyph) {
      lines.push(stroke.map(([gx, gy]) => [cursor + gx * size * 0.72, y + gy * size]));
    }
    cursor += advance;
  }
  return { lines, width: cursor - x - tracking };
}

// ── the PNG itself ──────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * Write an RGBA image.
 *
 * Filter type 0 on every scanline — no prediction. A predictor would compress a photograph
 * better and does nothing for flat colour, which is all this is.
 */
function writePng(path, width, height, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

/**
 * Read back what was just written and refuse to claim it worked unless it did.
 *
 * Two failures this catches, and neither shows up in a directory listing. A PNG this encoder got
 * wrong is a file whose name and size look fine and which no viewer opens — so the chunk CRCs and
 * the inflated length are checked against what a decoder would demand. And a drawing whose
 * geometry has moved off the canvas is a correct PNG of an empty rectangle, so the colours are
 * counted: an image that is one flat colour is not this mark.
 */
function verifyPng(path, expectedWidth, expectedHeight) {
  const bytes = readFileSync(path);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!bytes.subarray(0, 8).equals(signature)) throw new Error(`${path}: not a PNG`);

  const chunks = new Map();
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 4, offset + 8 + length);
    const stated = bytes.readUInt32BE(offset + 8 + length);
    if (crc32(body) !== stated) throw new Error(`${path}: ${type} chunk CRC is wrong`);
    chunks.set(type, bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  if (offset !== bytes.length) throw new Error(`${path}: trailing bytes after the last chunk`);
  for (const type of ['IHDR', 'IDAT', 'IEND']) {
    if (!chunks.has(type)) throw new Error(`${path}: no ${type} chunk`);
  }

  const ihdr = chunks.get('IHDR');
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  if (width !== expectedWidth || height !== expectedHeight) {
    throw new Error(`${path}: is ${width}×${height} and should be ${expectedWidth}×${expectedHeight}`);
  }

  const raw = inflateSync(chunks.get('IDAT'));
  if (raw.length !== (width * 4 + 1) * height) {
    throw new Error(`${path}: inflates to ${raw.length} bytes, not ${(width * 4 + 1) * height}`);
  }

  const colours = new Set();
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    if (raw[rowStart] !== 0) throw new Error(`${path}: row ${y} has a filter this does not write`);
    for (let x = 0; x < width; x += 1) {
      const at = rowStart + 1 + x * 4;
      colours.add(raw.readUInt32BE(at));
      if (colours.size > 2) break;
    }
  }
  if (colours.size < 2) throw new Error(`${path}: is one flat colour, so nothing was drawn`);
}

/** Render by asking a function what colour each sub-sample is. */
function render(width, height, sample) {
  const pixels = Buffer.alloc(width * height * 4);
  const step = 1 / SUPERSAMPLE;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const colour = sample(x + (sx + 0.5) * step, y + (sy + 0.5) * step);
          if (colour === null) continue;
          r += colour[0];
          g += colour[1];
          b += colour[2];
          a += 255;
        }
      }

      const samples = SUPERSAMPLE * SUPERSAMPLE;
      const offset = (y * width + x) * 4;
      // Premultiplied down by the covered count, so a half-covered edge is the colour it is
      // rather than the colour it would be over black.
      const covered = a / 255;
      pixels[offset] = covered === 0 ? 0 : Math.round(r / covered);
      pixels[offset + 1] = covered === 0 ? 0 : Math.round(g / covered);
      pixels[offset + 2] = covered === 0 ? 0 : Math.round(b / covered);
      pixels[offset + 3] = Math.round(a / samples);
    }
  }
  return pixels;
}

// ── the two files ───────────────────────────────────────────────────────────

mkdirSync(here, { recursive: true });

/**
 * The icon: the mark, edge to edge.
 *
 * No padding and no background of its own. The directory puts it on a card whose colour it
 * chooses, and a mark with its own margin sits small inside somebody else's padding.
 */
{
  const size = 256;
  const pixels = render(size, size, (x, y) => markColour((x / size) * 100, (y / size) * 100));
  writePng(join(here, 'icon-256x256.png'), size, size, pixels);
  verifyPng(join(here, 'icon-256x256.png'), size, size);

  // 128 as well: it is what the search results actually show.
  const small = 128;
  writePng(
    join(here, 'icon-128x128.png'),
    small,
    small,
    render(small, small, (x, y) => markColour((x / small) * 100, (y / small) * 100)),
  );
  verifyPng(join(here, 'icon-128x128.png'), small, small);
}

/**
 * The banner: black, the mark, the name, and a rule under it.
 *
 * 1544×500 is the size the directory asks for and it is shown at half that on a plugin page, which
 * is the argument against a strapline: a sentence legible at 1544 is a smudge at 772, and the
 * banner's job on that page is to be recognisable rather than to explain. What the plugin does is
 * in the description directly underneath it, set in the browser's own text.
 *
 * One `paint` in 1544×500 coordinates, rendered twice at different scales. Written that way
 * because the obvious alternative — a second copy of the drawing with the numbers halved — is two
 * pictures that are only the same picture until somebody edits one of them.
 */
{
  const WIDTH = 1544;
  const HEIGHT = 500;

  const markSize = 232;
  const nameSize = 108;

  /**
   * The gap between the two words, at half the cap height.
   *
   * It has to be measured from the ink rather than eyeballed: `layout` advances by the glyph box,
   * so the space it leaves is reduced on both sides by half a stroke width, and the first version
   * of this used a number that looked generous in the source and set `AVEXPAY` as one word.
   */
  const wordGap = nameSize * 0.5;
  const nameWeight = nameSize * 0.15;

  const avexWidth = layout('AVEX', 0, 0, nameSize, 16).width;
  const payWidth = layout('PAY', 0, 0, nameSize, 16).width;
  const textWidth = avexWidth + wordGap + payWidth;

  /** Centred, because a lockup in the left two thirds of a banner reads as a cropped one. */
  const markGap = 76;
  const markX = Math.round((WIDTH - (markSize + markGap + textWidth)) / 2);
  const markY = (HEIGHT - markSize) / 2;

  const nameX = markX + markSize + markGap;
  const nameY = markY + 26;

  const avex = layout('AVEX', nameX, nameY, nameSize, 16);
  const pay = layout('PAY', nameX + avexWidth + wordGap, nameY, nameSize, 16);

  const ruleTop = nameY + nameSize + 24;
  const ruleHeight = 4;

  const paint = (x, y) => {
    if (x >= markX && x < markX + markSize && y >= markY && y < markY + markSize) {
      const colour = markColour(((x - markX) / markSize) * 100, ((y - markY) / markSize) * 100);
      if (colour !== null) return colour;
    }

    for (const stroke of avex.lines) if (inStroke(x, y, stroke, nameWeight)) return INK;
    for (const stroke of pay.lines) if (inStroke(x, y, stroke, nameWeight)) return LIME;

    // A lime rule under the wordmark, exactly its width, as an anchor for the eye.
    if (y >= ruleTop && y < ruleTop + ruleHeight && x >= nameX && x < nameX + textWidth) {
      return LIME;
    }

    return VOID;
  };

  /**
   * Drawn at each size rather than resampled from the largest, so a stroke edge is antialiased
   * against the size it is shown at instead of being an average of an average.
   */
  for (const scale of [1, 0.5]) {
    const width = Math.round(WIDTH * scale);
    const height = Math.round(HEIGHT * scale);
    const path = join(here, `banner-${width}x${height}.png`);
    writePng(path, width, height, render(width, height, (x, y) => paint(x / scale, y / scale)));
    verifyPng(path, width, height);
  }
}

console.log(
  'wrote icon-128x128.png, icon-256x256.png, banner-772x250.png, banner-1544x500.png\n\n' +
    'These go in the SVN /assets folder, not in the plugin ZIP. Screenshots are still missing\n' +
    'and cannot be generated: they have to be taken from a real WooCommerce install.',
);

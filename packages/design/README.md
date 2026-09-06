# @avex/design

Everything the four surfaces — site, dashboard, checkout, admin — look like. They are
single self-contained files that reach no host, so nothing here is fetched at runtime:
each page inlines what it needs at build time, in place of a marker.

| What | Where | Marker |
|---|---|---|
| Colours, type, spacing, radii, motion | `tokens.css` | `/* @inject:tokens */` in the page's `<style>` |
| The brand mark, and the favicon | `brand/` | `<!-- @inject:mark -->`, `<!-- @inject:favicon -->` |
| The coin icons | `coins/` | `<!-- @inject:coins -->` |

`inject.mjs` does the last two; each app's `build-page.mjs` calls it. Every injection
replaces its marker with a *function*, never a string — `String.replace` reads `$&` and
`$1` in a string replacement as substitution patterns, which is exactly what an SVG path
or a data URI contains — and then asserts the result carries what it injected.

## tokens.css

Pages extend these tokens; they never redefine them. Light is the default; dark follows
the system preference or `data-theme="dark"` on the root. All four surfaces are one system
by construction rather than by discipline.

## brand/

`avex-logo-source.jpg` is the logo as its owner supplied it: a 640×640 bitmap, black arch
on lime. `trace-mark.mjs` turns it into paths — it decodes the image in Chromium,
thresholds it, walks the boundary between ink and not-ink, simplifies each contour and
writes three files:

- `mark.svg` — the mark alone, normalised into a square `0 0 100 100` box, in
  `currentColor`. For anything that wants the arch on its own.
- `mark.path.svg` — the same arch in the source's own framing (legs on the bottom edge),
  as one unfilled path. This is what the pages inline, inside the lime tile their template
  draws, so the tile's colours stay design tokens and follow the theme.
- `mark-tile.svg` — the whole tile, self-contained, with the token colours baked in. This
  is the favicon.

Re-run the tracer when the logo changes; never hand-edit the paths:

```bash
node packages/design/brand/trace-mark.mjs        # tolerance 2px at the source's scale
node packages/design/brand/trace-mark.mjs 1      # finer, larger
```

It finds a browser through `chromium.mjs`, which tries the same three Playwright installs
this repository's browser tests try; if none is there, install one with
`npm i --no-save playwright-core`.

## coins/

One file per ticker, each a full-bleed 18×18 square in the issuer's own colours — which is
how a payer tells USDT from USDC at a glance, so nothing recolours them to match our
palette. Round them with `border-radius` and `overflow: hidden` on the element around them.

`sprite.mjs` wraps them as `<symbol>`s so a page carries each icon once and draws it with
`<use href="#coin-usdt">`. Ids inside the files are namespaced per symbol (`eth-a`, not
`a`), which is what lets several of them share one document. The sprite is hidden by size
rather than `display: none`: a gradient inside a `display: none` subtree is not resolved
for a `<use>` that references it, which showed up as four of the thirteen icons drawing as
blank squares.

To add one: drop `<SYMBOL>.svg` in, namespace any ids it declares, give it a `viewBox`, and
drop its `width`/`height`. Pages fall back to the ticker's first two letters for a symbol
with no icon — a merchant's own token gets a legible badge rather than an empty circle —
but `coinSprite` refuses a symbol it has no file for rather than shipping a `<use>` that
draws nothing.

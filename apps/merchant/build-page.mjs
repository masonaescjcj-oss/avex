/**
 * Inline the compiled modules into the merchant dashboard.
 *
 * Same arrangement as the staff panel and the checkout: one self-contained file whose
 * logic is injected from `dist/` rather than copied by hand, so the page can never drift
 * from the modules the tests actually exercise.
 *
 * Usage: node build-page.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const MODULES = [
  join(here, '..', '..', 'packages', 'ui-format', 'dist', 'index.js'),
  // The curated asset list, so the preview's currency list *is* the real one. The import in
  // `preview.ts` is stripped by the inliner, so the module has to be named here.
  join(here, '..', '..', 'packages', 'core', 'dist', 'assets', 'registry.js'),
  /**
   * The chain registry, because the panel asks it which chains use a wallet pool.
   *
   * Named here for the same reason the asset list is: the inliner strips the import from
   * `dashboard.ts`, so a module it depends on has to be concatenated ahead of it. Deciding
   * "TRON is pooled" in the page instead would put the fact in two places, and the page is the
   * copy that would go stale.
   */
  join(here, '..', '..', 'packages', 'core', 'dist', 'chains', 'registry.js'),
  /**
   * The QR encoder, for the authenticator secret on the security tab.
   *
   * Named here for the same reason the two registries are: the page is one self-contained
   * file, so what it uses has to be concatenated into it. It is the checkout's encoder —
   * the one with the codeword tables under test — not a second copy.
   */
  join(here, '..', '..', 'packages', 'qr', 'dist', 'index.js'),
  join(here, 'dist', 'dashboard.js'),
  join(here, 'dist', 'preview.js'),
];
const MARKER = '/* @inject:modules */';
/**
 * The design tokens, inlined at the top of the stylesheet.
 *
 * `packages/design/tokens.css` is the one place colour, type, spacing and motion are decided
 * for every page. The stylesheet below the marker only extends them — a page that redefined
 * `--surface` would look like a different product from the checkout it links to.
 */
const TOKENS_MARKER = '/* @inject:tokens */';
const TOKENS = join(here, '..', '..', 'packages', 'design', 'tokens.css');

const template = readFileSync(join(here, 'public', 'merchant.template.html'), 'utf8');
for (const marker of [MARKER, TOKENS_MARKER]) {
  if (!template.includes(marker)) {
    console.error(`template is missing the ${marker} marker`);
    process.exit(1);
  }
}

/** Strip module syntax so the code runs in a plain classic script. */
const strip = (source) =>
  source
    .replace(/^export\s+/gm, '')
    .replace(/^import[^;]+;$/gm, '')
    .replace(/\/\/# sourceMappingURL=.*$/gm, '')
    .trim();

const inlined = MODULES.map((path) => strip(readFileSync(path, 'utf8'))).join('\n\n');

/**
 * Replace with a function, never a string.
 *
 * `String.prototype.replace` reads `$$`, `$&` and `$1` in a *string* replacement as
 * substitution patterns. That silently stripped the dollar sign from every figure in the
 * staff panel once, while the module's own tests kept passing — the module was fine and
 * only the copy was corrupt. The assertion afterwards is what would have caught it.
 */
const tokens = readFileSync(TOKENS, 'utf8').trim();
const output = template.replace(MARKER, () => inlined).replace(TOKENS_MARKER, () => tokens);
if (!output.includes(inlined) || !output.includes(tokens)) {
  console.error('inlining altered the injected source; refusing to write a corrupt page');
  process.exit(1);
}

const target = join(here, 'public', 'merchant.html');
writeFileSync(target, output);

console.log(
  `wrote ${target} (${(output.length / 1024).toFixed(1)} KB, modules ${(inlined.length / 1024).toFixed(1)} KB, tokens ${(tokens.length / 1024).toFixed(1)} KB)`,
);

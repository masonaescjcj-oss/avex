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
  join(here, 'dist', 'dashboard.js'),
  join(here, 'dist', 'preview.js'),
];
const MARKER = '/* @inject:modules */';

const template = readFileSync(join(here, 'public', 'merchant.template.html'), 'utf8');
if (!template.includes(MARKER)) {
  console.error(`template is missing the ${MARKER} marker`);
  process.exit(1);
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
const output = template.replace(MARKER, () => inlined);
if (!output.includes(inlined)) {
  console.error('inlining altered the injected source; refusing to write a corrupt page');
  process.exit(1);
}

const target = join(here, 'public', 'merchant.html');
writeFileSync(target, output);

console.log(
  `wrote ${target} (${(output.length / 1024).toFixed(1)} KB, modules ${(inlined.length / 1024).toFixed(1)} KB)`,
);

/**
 * Inline the compiled formatting and permission modules into the admin panel.
 *
 * The panel is one self-contained file, so its logic is injected from `dist/` rather
 * than copied by hand — the same arrangement the checkout uses, for the same reason:
 * the page can then never drift from the modules the tests actually exercise.
 *
 * Usage: node build-page.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const MODULES = ['format.js', 'permissions.js'];
const MARKER = '/* @inject:modules */';

const template = readFileSync(join(here, 'public', 'admin.template.html'), 'utf8');
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

const inlined = MODULES.map((name) => strip(readFileSync(join(here, 'dist', name), 'utf8'))).join(
  '\n\n',
);

/**
 * Replace with a function, never a string.
 *
 * `String.prototype.replace` interprets `$$`, `$&` and `$1` inside a *string*
 * replacement as substitution patterns. The panel's money formatter contains
 * `` `$${grouped}` ``, which a string replacement silently turned into
 * `` `${grouped}` `` — stripping the dollar sign from every figure in the shipped
 * page while the module's own tests kept passing, because the module was fine and
 * only the copy was corrupt. A replacer function is treated literally.
 *
 * The assertion afterwards is the guard that would have caught it: if the injected
 * text is not present verbatim in the output, the inlining was lossy.
 */
const output = template.replace(MARKER, () => inlined);
if (!output.includes(inlined)) {
  console.error('inlining altered the injected source; refusing to write a corrupt page');
  process.exit(1);
}
const target = join(here, 'public', 'admin.html');
writeFileSync(target, output);

console.log(
  `wrote ${target} (${(output.length / 1024).toFixed(1)} KB, modules ${(inlined.length / 1024).toFixed(1)} KB)`,
);

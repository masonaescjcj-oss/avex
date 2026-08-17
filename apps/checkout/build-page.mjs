/**
 * Inline the compiled QR encoder into the checkout page.
 *
 * The page must be a single self-contained file — its content security policy
 * forbids fetching scripts — so the encoder is injected rather than imported. It is
 * injected from `dist/` rather than copied by hand so the page can never drift from
 * the module the tests actually exercise.
 *
 * Usage: node build-page.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const compiled = readFileSync(join(here, 'dist', 'qr.js'), 'utf8');
const template = readFileSync(join(here, 'public', 'checkout.template.html'), 'utf8');

const MARKER = '/* @inject:qr */';
if (!template.includes(MARKER)) {
  console.error(`template is missing the ${MARKER} marker`);
  process.exit(1);
}

// Strip module syntax so the code runs in a plain classic script.
const inlined = compiled
  .replace(/^export\s+/gm, '')
  .replace(/^import[^;]+;$/gm, '')
  .replace(/\/\/# sourceMappingURL=.*$/gm, '')
  .trim();

const output = template.replace(MARKER, inlined);
const target = join(here, 'public', 'checkout.html');
writeFileSync(target, output);

console.log(
  `wrote ${target} (${(output.length / 1024).toFixed(1)} KB, encoder ${(inlined.length / 1024).toFixed(1)} KB)`,
);

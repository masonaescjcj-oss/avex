/**
 * Inline the compiled QR encoder into the checkout page.
 *
 * The page must be a single self-contained file — its content security policy
 * forbids fetching scripts — so the encoder is injected rather than imported. It is
 * injected from the encoder's own `dist/` rather than copied by hand so the page can
 * never drift from the module the tests actually exercise.
 *
 * The encoder lives in `packages/qr` because the merchant dashboard needs one too, to
 * hand an authenticator secret to a phone. Two copies of a QR encoder is two places for
 * a wrong codeword table to live, and only one of them would have the tests.
 *
 * Usage: node build-page.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const compiled = readFileSync(join(here, '..', '..', 'packages', 'qr', 'dist', 'index.js'), 'utf8');

/**
 * The design tokens, inlined into every page's stylesheet.
 *
 * One file in `packages/design` decides the palette, the type scale and the spacing for
 * the site, the dashboard, the checkout and the admin panel, so the four surfaces are one
 * system by construction. A page that copied the values would drift the first time a
 * token changed; a page that fetched them would break the rule that these files reach no
 * host. So they are pasted in at build time, in place of a marker at the top of the
 * page's own `<style>`, and a template without the marker is refused rather than shipped
 * unstyled.
 */
const tokens = readFileSync(join(here, '..', '..', 'packages', 'design', 'tokens.css'), 'utf8').trim();
const TOKENS_MARKER = '/* @inject:tokens */';
const withTokens = (source, name) => {
  if (!source.includes(TOKENS_MARKER)) {
    console.error(`${name} is missing the ${TOKENS_MARKER} marker`);
    process.exit(1);
  }
  const output = source.replace(TOKENS_MARKER, () => tokens);
  if (!output.includes(tokens)) {
    console.error(`inlining altered the design tokens in ${name}; refusing to write a corrupt page`);
    process.exit(1);
  }
  return output;
};

const template = withTokens(
  readFileSync(join(here, 'public', 'checkout.template.html'), 'utf8'),
  'checkout template',
);

const MARKER = '/* @inject:qr */';
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

const inlined = strip(compiled);

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
const target = join(here, 'public', 'checkout.html');
writeFileSync(target, output);

console.log(
  `wrote ${target} (${(output.length / 1024).toFixed(1)} KB, encoder ${(inlined.length / 1024).toFixed(1)} KB)`,
);

/**
 * The receipt page, built the same way from the same reason.
 *
 * Its own file rather than a state of the checkout page: a receipt is kept, printed and
 * forwarded, which wants a URL of its own — and the payment flow page is already the
 * largest thing here.
 */
const receiptModule = strip(readFileSync(join(here, 'dist', 'receipt.js'), 'utf8'));
const receiptTemplate = withTokens(
  readFileSync(join(here, 'public', 'receipt.template.html'), 'utf8'),
  'receipt template',
);

const RECEIPT_MARKER = '/* @inject:receipt */';
if (!receiptTemplate.includes(RECEIPT_MARKER)) {
  console.error(`receipt template is missing the ${RECEIPT_MARKER} marker`);
  process.exit(1);
}

const receiptOutput = receiptTemplate.replace(RECEIPT_MARKER, () => receiptModule);
if (!receiptOutput.includes(receiptModule)) {
  console.error('inlining altered the injected source; refusing to write a corrupt page');
  process.exit(1);
}
const receiptTarget = join(here, 'public', 'receipt.html');
writeFileSync(receiptTarget, receiptOutput);

console.log(
  `wrote ${receiptTarget} (${(receiptOutput.length / 1024).toFixed(1)} KB, ` +
    `module ${(receiptModule.length / 1024).toFixed(1)} KB)`,
);

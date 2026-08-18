/**
 * Inline the compiled modules into the public site.
 *
 * The site makes claims about the product — which chains, which rate, which contracts —
 * and the only way those claims cannot drift is for the page to read them from the same
 * modules the product does. So `CURATED_ASSETS`, the commission ladder and the real
 * CREATE2 derivation are injected here rather than transcribed into the HTML.
 *
 * The keccak and create2 modules are the load-bearing ones: the hero derives a genuine
 * deposit address in the browser with the same code that derives it on the server. A
 * marketing page that faked that would be asserting the product's central claim in a
 * medium where it could quietly stop being true.
 *
 * Usage: node build-page.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const core = join(here, '..', '..', 'packages', 'core', 'dist');

const MODULES = [
  join(core, 'crypto', 'keccak256.js'),
  join(core, 'chains', 'evm', 'create2.js'),
  join(core, 'assets', 'registry.js'),
  join(here, 'dist', 'facts.js'),
];
const MARKER = '/* @inject:modules */';

const template = readFileSync(join(here, 'public', 'site.template.html'), 'utf8');
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

const stripped = MODULES.map((path) => ({ path, source: strip(readFileSync(path, 'utf8')) }));

/**
 * Refuse two declarations of the same name.
 *
 * The modules are concatenated into one classic-script scope, so a name declared twice is a
 * `SyntaxError` that takes the entire page's script down — not the one feature that
 * collided. That is exactly what happened the first time this page was built: `create2.js`
 * and this app's own facts module both exported `MAX_FEE_BPS`, and the result was a page
 * whose address panel, currency table and pricing ladder were all silently empty while the
 * static HTML fallbacks sat there looking plausible.
 *
 * Catching it here rather than in a browser test, because the failure is total and the
 * build is where it is cheapest to see.
 */
const declarations = new Map();
for (const { path, source } of stripped) {
  for (const match of source.matchAll(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    const name = match[1];
    const seen = declarations.get(name);
    if (seen !== undefined && seen !== path) {
      console.error(`"${name}" is declared in both ${seen} and ${path}; the inlined script would not parse`);
      process.exit(1);
    }
    declarations.set(name, path);
  }
}

const inlined = stripped.map((entry) => entry.source).join('\n\n');

/**
 * Replace with a function, never a string.
 *
 * `String.prototype.replace` reads `$$`, `$&` and `$1` in a *string* replacement as
 * substitution patterns, which once stripped the dollar sign from every figure in a
 * shipped page while the module's own tests kept passing. The assertion afterwards is
 * what would have caught it.
 */
const output = template.replace(MARKER, () => inlined);
if (!output.includes(inlined)) {
  console.error('inlining altered the injected source; refusing to write a corrupt page');
  process.exit(1);
}

const target = join(here, 'public', 'index.html');
writeFileSync(target, output);

console.log(
  `wrote ${target} (${(output.length / 1024).toFixed(1)} KB, modules ${(inlined.length / 1024).toFixed(1)} KB)`,
);

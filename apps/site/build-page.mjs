/**
 * Inline the compiled modules into the public site.
 *
 * The site makes few claims, and the ones it makes are read from the same modules the
 * product does rather than transcribed into the HTML — the network count from the chain
 * registry, and the CREATE2 derivation from the code that ships.
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
  join(core, 'chains', 'registry.js'),
  join(here, 'dist', 'facts.js'),
];
const MARKER = '/* @inject:modules */';
const TOKENS_MARKER = '/* @inject:tokens */';
const TOKENS = join(here, '..', '..', 'packages', 'design', 'tokens.css');

const template = readFileSync(join(here, 'public', 'site.template.html'), 'utf8');
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
let output = template.replace(MARKER, () => inlined);
if (!output.includes(inlined)) {
  console.error('inlining altered the injected source; refusing to write a corrupt page');
  process.exit(1);
}

/**
 * The design tokens, from the one file every surface shares.
 *
 * The page's stylesheet starts from `packages/design/tokens.css` and extends it; it never
 * carries a palette of its own. Inlined the same guarded way as the modules, because a
 * `$` in a token value would otherwise be read as a substitution pattern too.
 */
const tokens = readFileSync(TOKENS, 'utf8').trim();
output = output.replace(TOKENS_MARKER, () => tokens);
if (!output.includes(tokens)) {
  console.error('inlining altered the design tokens; refusing to write a corrupt page');
  process.exit(1);
}

/**
 * Point the sign-in and sign-up links at wherever this build's panel is.
 *
 * The template ships `/dashboard`, which is right for a deployment that serves both from one
 * origin. A preview or a demo puts the panel somewhere else entirely, and the page reads it
 * from one `<meta>` — so overriding that here beats editing anchors, all six of which would
 * otherwise have to agree.
 */
const DASHBOARD_META = /(<meta name="avex-dashboard" content=")[^"]*(">)/;
if (!DASHBOARD_META.test(output)) {
  console.error('the template no longer names a dashboard; the auth links would be hardcoded');
  process.exit(1);
}

const dashboard = process.env.AVEX_DASHBOARD_URL?.trim();
if (dashboard) {
  // A quote would end the attribute and the rest would be read as markup.
  if (/["'<>\s]/.test(dashboard)) {
    console.error(`AVEX_DASHBOARD_URL is not usable in an attribute: ${dashboard}`);
    process.exit(1);
  }
  output = output.replace(DASHBOARD_META, (_, open, close) => `${open}${dashboard}${close}`);
  console.log(`dashboard links point at ${dashboard}`);
}

const target = join(here, 'public', 'index.html');
writeFileSync(target, output);

console.log(
  `wrote ${target} (${(output.length / 1024).toFixed(1)} KB, modules ${(inlined.length / 1024).toFixed(1)} KB)`,
);

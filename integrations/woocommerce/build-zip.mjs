/**
 * Build the ZIP that gets uploaded to the WordPress plugin directory, and refuse to build a
 * broken one.
 *
 * Usage: node integrations/woocommerce/build-zip.mjs [outputDir]
 *
 * The upload is a human step — somebody signs in to WordPress.org and picks a file — so the
 * thing worth automating is not the upload but everything that makes the upload fail. A first
 * review takes days to weeks, and a rejection means another round of it, so each check below is
 * one round of waiting that can be avoided by failing here in a second instead.
 *
 * ## What ships and what does not
 *
 * `tests/` is deliberately excluded. `run-tests.php` is a CLI runner with no `ABSPATH` guard —
 * correctly, because it is not a WordPress file — but shipped inside a plugin it becomes a PHP
 * file anybody can execute by URL. That is a finding a reviewer raises and they are right to:
 * the fix is not to add a guard to a test runner, it is not to ship it.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outputDir = process.argv[2] ?? join(here, 'dist');

/** The directory slug. The top-level folder in the ZIP must be exactly this. */
const SLUG = 'avex-pay-for-woocommerce';

/** What a plugin is, as far as the directory is concerned. Anything else is ours. */
const SHIPPED = [`${SLUG}.php`, 'readme.txt', 'includes'];

const problems = [];
const fail = (message) => problems.push(message);

const mainFile = readFileSync(join(here, `${SLUG}.php`), 'utf8');
const readme = readFileSync(join(here, 'readme.txt'), 'utf8');

// ── the header and the readme have to agree ──────────────────────────────────

const header = (name) => new RegExp(`^\\s*\\*\\s*${name}:\\s*(.+)$`, 'm').exec(mainFile)?.[1]?.trim();
const readmeField = (name) => new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(readme)?.[1]?.trim();

const version = header('Version');
const stableTag = readmeField('Stable tag');

if (version === undefined) fail('the main file has no Version header');
if (stableTag === undefined) fail('readme.txt has no Stable tag');
if (version !== undefined && stableTag !== undefined && version !== stableTag) {
  /**
   * The directory reads the version from the header and the download from `Stable tag`. When
   * they disagree it serves one version and reports another, and the symptom for a merchant is
   * an update that never appears or one that installs something older than what they have.
   */
  fail(`Version is ${version} and readme.txt Stable tag is ${stableTag}; they must match`);
}

/**
 * The text domain has to be the slug.
 *
 * A rule with a real consequence rather than a formality: translations are served from
 * translate.wordpress.org keyed on the slug, so a plugin whose domain is anything else ships
 * with no translations at all, forever, silently.
 */
const textDomain = header('Text Domain');
if (textDomain !== SLUG) fail(`Text Domain is "${textDomain}" and must be "${SLUG}"`);

for (const field of ['License', 'License URI', 'Requires at least', 'Requires PHP']) {
  if (header(field) === undefined) fail(`the main file has no ${field} header`);
}
for (const field of ['Requires at least', 'Requires PHP', 'License', 'Tested up to']) {
  if (readmeField(field) === undefined) fail(`readme.txt has no ${field}`);
}

/**
 * The disclosure the directory requires of anything that talks to a third party.
 *
 * Checked by heading rather than by content, because what it has to say is a judgement and what
 * it has to be is present. Its absence is one of the most common rejections there is.
 */
if (!/^== External services ==$/m.test(readme)) {
  fail('readme.txt has no "== External services ==" section');
}

// ── every shipped PHP file must refuse to run outside WordPress ──────────────

const phpFiles = execFileSync('find', [here, '-name', '*.php', '-not', '-path', '*/tests/*'], {
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean)
  .filter((path) => !path.includes('/dist/'));

for (const path of phpFiles) {
  const source = readFileSync(path, 'utf8');
  if (!source.includes("defined( 'ABSPATH' )") && !source.includes("defined('ABSPATH')")) {
    fail(`${path.replace(here, '.')} can be executed directly: it has no ABSPATH guard`);
  }
  if (/^\s*(var_dump|print_r|error_log)\s*\(/m.test(source)) {
    fail(`${path.replace(here, '.')} contains debug output`);
  }
}

// ── build ───────────────────────────────────────────────────────────────────

if (problems.length > 0) {
  console.error('\nnot building a ZIP that would be rejected:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('');
  process.exit(1);
}

const staging = mkdtempSync(join(tmpdir(), 'avex-plugin-'));
const root = join(staging, SLUG);
mkdirSync(root);

for (const entry of SHIPPED) {
  const from = join(here, entry);
  if (!existsSync(from)) {
    console.error(`missing: ${entry}`);
    process.exit(1);
  }
  cpSync(from, join(root, entry), { recursive: true });
}

mkdirSync(outputDir, { recursive: true });
const zipPath = join(outputDir, `${SLUG}-${version}.zip`);
rmSync(zipPath, { force: true });

/**
 * `-X` drops the extra file attributes, so the archive is byte-identical from one machine to
 * the next. Not required by anybody — it just means "the ZIP changed" always means the plugin
 * changed.
 */
execFileSync('zip', ['-r', '-X', '-q', zipPath, SLUG], { cwd: staging });
rmSync(staging, { recursive: true, force: true });

const listing = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).trim().split('\n');
console.log(`${zipPath}\n`);
for (const entry of listing) console.log(`  ${entry}`);
console.log(
  `\nversion ${version}, ${listing.length} entries. The top-level folder is "${SLUG}", which is ` +
    'the slug the directory will use.\n' +
    'Upload at https://wordpress.org/plugins/developers/add/ — see SUBMISSION.md first.',
);

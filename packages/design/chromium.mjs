/**
 * A Chromium, for the design tooling.
 *
 * The tracer and the artboard renderer both need a real browser: one to decode a JPEG and
 * read its pixels, the other to render a screen at the size it will be seen at. Neither is
 * part of the build or the test run, so neither can assume a particular install — this
 * repository's own browser tests already try three paths before skipping, and these tools
 * follow the same order rather than inventing a fourth.
 *
 * `executablePath` is passed when a browser is on the machine but not where the driver
 * expects it, which is the case in this project's container.
 */

import { existsSync } from 'node:fs';

const DRIVERS = [
  'playwright-core',
  '/opt/node22/lib/node_modules/playwright/index.mjs',
  'playwright',
];

const BROWSERS = [
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
];

/**
 * Launch one, or say plainly what is missing.
 *
 * Throwing rather than returning null: every caller here exists only to produce a file
 * from a browser, so there is nothing sensible to do without one.
 */
export async function launchChromium(options = {}) {
  let driver = null;
  for (const candidate of DRIVERS) {
    if (candidate.startsWith('/') && !existsSync(candidate)) continue;
    try {
      driver = await import(candidate);
      break;
    } catch {
      // Next one.
    }
  }
  if (driver === null) {
    throw new Error(
      'no Playwright driver found. Install one with: npm i --no-save playwright-core',
    );
  }

  const executablePath = BROWSERS.find((path) => existsSync(path));
  return driver.chromium.launch({
    ...(executablePath === undefined ? {} : { executablePath }),
    args: ['--no-sandbox'],
    ...options,
  });
}

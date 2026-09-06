// Renders each artboard at its canvas size, in a viewport of exactly that size,
// with the same reset the canvas runtime injects into its preview frames.
import { chromium } from 'playwright-core';
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
const RESET = '<style>html,body{height:100%;margin:0}</style>';
const files = readdirSync('.').filter((f) => f.endsWith('.dc.html'));
mkdirSync('shots', { recursive: true });
mkdirSync('.shotsrc', { recursive: true });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
for (const f of files) {
  const name = f.replace(/\.dc\.html$/, '');
  const src = readFileSync(f, 'utf8').replace('<script src="./support.js"></script>', RESET);
  writeFileSync(`.shotsrc/${name}.html`, src);
  await page.goto(`file://${process.cwd()}/.shotsrc/${name}.html`);
  const box = await page.evaluate(() => {
    const el = document.querySelector('x-dc > div');
    const r = el.getBoundingClientRect();
    return { w: r.width, h: r.height, scroll: el.scrollHeight };
  });
  await page.screenshot({ path: `shots/${name}.png`, clip: { x: 0, y: 0, width: 390, height: 844 } });
  console.log(name.padEnd(16), 'frame', box.w + 'x' + box.h, 'content', box.scroll);
}
await browser.close();

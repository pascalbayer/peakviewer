#!/usr/bin/env node
/**
 * Headless screenshot harness — how the previews get checked before publishing.
 *
 * Usage: shot.mjs <file.html> <out.png> [WxH] [waitMs] ['<js to run first>']
 */
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [, , file, out, size = '900x600', waitMs = '3500', script = ''] = process.argv;
if (!file || !out) {
  console.error("usage: shot.mjs <file.html> <out.png> [WxH] [waitMs] ['js']");
  process.exit(1);
}
const [w, h] = size.split('x').map(Number);

const browser = await chromium.launch({
  // The image ships a Chromium that predates this playwright build; point at it
  // rather than downloading another one.
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox',
    '--no-sandbox',
  ],
});
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(pathToFileURL(resolve(file)).href, { waitUntil: 'load' });
await page.waitForTimeout(Number(waitMs));
if (script) {
  await page.evaluate(script);
  await page.waitForTimeout(1200);
}
await page.screenshot({ path: resolve(out) });

const err = await page.evaluate(() => document.querySelector('.err')?.textContent ?? '');
const info = await page.evaluate(() => {
  const badges = [...document.querySelectorAll('.badge span')].map((s) => s.textContent.trim());
  const rows = [...document.querySelectorAll('.readout > *')].map((s) => s.textContent.trim());
  const pairs = [];
  for (let i = 0; i < rows.length; i += 2) pairs.push(`${rows[i]} = ${rows[i + 1]}`);
  return { badges, pairs };
});
await browser.close();

if (logs.length) console.error(logs.join('\n'));
if (err) { console.error('PAGE ERROR:\n' + err); process.exitCode = 1; }
console.error('badges: ' + info.badges.join('  |  '));
console.error(info.pairs.join('\n'));
console.error(`wrote ${out}`);

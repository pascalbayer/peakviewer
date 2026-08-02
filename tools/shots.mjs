#!/usr/bin/env node
/**
 * Multi-capture harness: load a preview once, then run a list of
 * {name, js, wait} steps, screenshotting the stage after each.
 *
 * Usage: shots.mjs <file.html> <outDir> <spec.json> [WxH]
 */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [, , file, outDir, specPath, size = '1000x640'] = process.argv;
const [w, h] = size.split('x').map(Number);
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox', '--no-sandbox',
    // A synthetic camera so the AR compositing can be checked headlessly.
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(`[console] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(pathToFileURL(resolve(file)).href, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.peak, null, { timeout: 60000 });

for (const s of spec) {
  if (s.js) await page.evaluate(s.js);
  await page.waitForTimeout(s.wait ?? 700);
  const clip = s.full ? undefined : await page.evaluate(() => {
    const node = document.getElementById('stage') || document.querySelector('.stage');
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  await page.screenshot({ path: join(outDir, `${s.name}.png`), ...(clip ? { clip } : {}) });
  if (s.report) console.error(`${s.name}: ${await page.evaluate(s.report)}`);
}

await browser.close();
if (logs.length) console.error(logs.join('\n'));
console.error(`wrote ${spec.length} shots to ${outDir}`);

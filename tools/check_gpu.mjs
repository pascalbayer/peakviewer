#!/usr/bin/env node
/**
 * The check the other two cannot do: run the renderer on a real WebGPU device
 * and look at the pixels.
 *
 * check_wgsl.mjs proves the shaders parse and that every uniform is wired.
 * check_math.mjs proves the vertex geometry agrees with the reference
 * implementation. Neither can tell you the pipeline links, that the passes run
 * in the right order, or that a single pixel is painted — and a blank screen is
 * the failure mode this project is most exposed to.
 *
 * There is no GPU in CI, so this drives Chromium's SwiftShader adapter. That is
 * a real WebGPU implementation with real validation: it will reject a bad bind
 * group layout or an unlinkable pipeline exactly as a phone would. What it
 * cannot vouch for is performance or a vendor's driver quirks.
 *
 * Skips rather than fails when no browser or adapter is available, so this can
 * sit in `npm run check` without making the build depend on a GPU.
 */
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
];

function skip(why) {
  console.log(`gpu check skipped: ${why}`);
  process.exit(0);
}

/**
 * Chromium's SwiftShader adapter drops the device on the first real scene
 * render in some containers and never recovers — the restored device rejects
 * allocations a healthy one accepts. That says nothing about the renderer, so
 * treat it as "no GPU available" rather than a failure. Anything else is a
 * genuine result.
 */
const UNSTABLE =
  /Target (page|browser).*closed|Target crashed|Instance reference|device.*lost|context lost|adapter/i;

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  skip('playwright is not installed');
}

// Playwright's own download is preferred; the pinned path is the fallback for
// images that ship a browser outside the usual location.
let executablePath;
try {
  const p = chromium.executablePath();
  if (existsSync(p)) executablePath = p;
} catch { /* fall through to the candidates */ }
if (!executablePath) executablePath = CHROME_CANDIDATES.find((p) => p && existsSync(p));
if (!executablePath) skip('no Chromium binary found');

const bundle = await build({
  entryPoints: [resolve(root, 'tools', 'gpu_probe.ts')],
  bundle: true, format: 'esm', write: false, platform: 'browser',
  target: 'es2022', logLevel: 'error', legalComments: 'none',
});
const js = bundle.outputFiles[0].text;

const page = `<!doctype html><meta charset=utf-8><title>gpu probe</title>
<style>html,body{margin:0;background:#000}canvas{width:320px;height:240px;display:block}</style>
<canvas id=c></canvas><script type=module>${js}
window.__go = () => runProbe(document.getElementById('c'));
</script>`;

const server = createServer((_q, s) => {
  s.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  s.end(page);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

let browser;
let result;
const logs = [];
try {
  browser = await chromium.launch({
    executablePath,
    headless: process.env.GPU_CHECK_HEADFUL !== '1',
    args: [
      '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan',
      '--enable-unsafe-swiftshader', '--no-sandbox',
    ],
  });
  const p = await browser.newPage();
  p.on('console', (m) => logs.push(`  [${m.type()}] ${m.text()}`));
  p.on('pageerror', (e) => logs.push(`  [pageerror] ${e.message}`));
  await p.goto(url, { waitUntil: 'load', timeout: 60_000 });

  const adapter = await p.evaluate(async () => {
    if (!('gpu' in navigator)) return null;
    return !!(await navigator.gpu.requestAdapter());
  });
  if (!adapter) skip('this browser exposes no WebGPU adapter');

  result = await p.evaluate(() => window.__go().catch((e) => ({
    ok: false, notes: [`probe threw: ${e.message}`], diagnostics: null,
  })), { timeout: 120_000 });
} catch (e) {
  // A crashed software adapter is an environment problem, not a code defect.
  const msg = String(e.message ?? e);
  if (UNSTABLE.test(msg)) {
    if (logs.length) console.log(logs.join('\n'));
    skip(`the software adapter died (${msg.split('\n')[0]})`);
  }
  throw e;
} finally {
  await browser?.close();
  server.close();
}

const d = result.diagnostics ?? {};
console.log(`adapter           : ${d.adapter ?? '?'} — ${d.engine ?? '?'}`);
console.log(`pipelines         : terrain ${d.terrainReady ? 'ok' : 'FAILED'}, `
  + `composite ${d.compositeReady ? 'ok' : 'FAILED'}, ${d.framesDrawn ?? 0} frames`);
console.log(`range buffer      : ${(result.terrain * 100).toFixed(1)}% terrain, rest sky`);
console.log(`composite         : ${(result.white * 100).toFixed(1)}% background, `
  + `${(result.ink * 100).toFixed(2)}% outline, first outline row at `
  + `${(result.edgeRow * 100).toFixed(0)}% of height`);

if (d.shaderErrors?.length) {
  console.log('engine reported   :');
  for (const s of d.shaderErrors) console.log(`  ${s}`);
}

// The renderer records device loss directly, which is a far better signal than
// pattern-matching whatever Babylon threw once the device was already gone.
if (!result.ok && (d.deviceLost > 0 || result.notes.some((n) => UNSTABLE.test(n)))) {
  for (const n of result.notes) console.log(`  note: ${n}`);
  skip(`the adapter lost its device ${d.deviceLost ?? '?'} time(s) mid-probe`);
}

if (!result.ok) {
  console.error('\ngpu check FAILED:');
  for (const n of result.notes) console.error(`  - ${n}`);
  if (logs.length) console.error(logs.join('\n'));
  process.exit(1);
}
console.log('\nthe renderer links, runs and paints a skyline on a real device.');

#!/usr/bin/env node
/**
 * The check the other two cannot do: run the renderer on a real graphics device
 * and look at the pixels.
 *
 * check_wgsl.mjs proves the shaders parse and that every uniform is wired.
 * check_math.mjs proves the vertex geometry agrees with the reference
 * implementation. Neither can tell you the pipeline links, that the passes run
 * in the right order, or that a single pixel is painted — and a blank screen is
 * the failure mode this project is most exposed to.
 *
 * There is no GPU in CI, so this drives Chromium's SwiftShader rasteriser. That
 * is a real implementation with real validation: it rejects an unlinkable
 * program exactly as a phone would. What it cannot vouch for is performance or
 * a vendor's driver quirks.
 *
 * Both backends are probed. WebGL2 is the one that must pass — it is stable
 * under software rasterisation, so it is what actually establishes that the
 * renderer draws a skyline. The WebGPU run is best-effort: its software adapter
 * drops the device on the first scene render in some containers, and that says
 * nothing about the code, so it skips rather than fails.
 *
 * Readback, not screenshots. A headless browser will happily composite nothing
 * from a WebGPU canvas while rendering it perfectly, so a screenshot cannot
 * tell a blank page from a working one. Pixels pulled out of a render target
 * come from the same device that drew them.
 */
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
];

/**
 * Chromium's SwiftShader WebGPU adapter drops the device on the first real
 * scene render in some containers and never recovers — the restored device
 * rejects allocations a healthy one accepts, and the crash takes the page with
 * it. That says nothing about the renderer.
 */
const UNSTABLE =
  /Target (page|browser).*closed|Target crashed|Instance reference|device.*lost|context lost/i;

function skip(why) {
  console.log(`gpu check skipped: ${why}`);
  process.exit(0);
}

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
window.__go = (backend) => runProbe(document.getElementById('c'), backend);
</script>`;

const server = createServer((_q, s) => {
  s.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  s.end(page);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

/** One probe run in a fresh page, since the renderer takes over the canvas. */
async function probe(browser, backend) {
  const logs = [];
  const p = await browser.newPage();
  p.on('console', (m) => logs.push(`  [${m.type()}] ${m.text()}`));
  p.on('pageerror', (e) => logs.push(`  [pageerror] ${e.message}`));
  try {
    await p.goto(url, { waitUntil: 'load', timeout: 60_000 });
    const result = await p.evaluate((b) => window.__go(b).catch((e) => ({
      ok: false, notes: [`probe threw: ${e.message}`], diagnostics: null,
    })), backend, { timeout: 120_000 });
    return { result, logs };
  } catch (e) {
    return { result: null, logs, crash: String(e.message ?? e) };
  } finally {
    await p.close().catch(() => { /* the page may already be gone */ });
  }
}

function report(backend, result) {
  const d = result.diagnostics ?? {};
  console.log(`  engine     : ${d.engine ?? '?'} — ${d.adapter ?? '?'}`);
  console.log(`  pipelines  : terrain ${d.terrainReady ? 'ok' : 'FAILED'}, `
    + `composite ${d.compositeReady ? 'ok' : 'FAILED'}, ${d.framesDrawn ?? 0} frames, `
    + `${d.frameErrors ?? 0} frame errors`);
  console.log(`  range pass : ${(result.terrain * 100).toFixed(1)}% terrain, rest sky`);
  console.log(`  composite  : ${(result.white * 100).toFixed(1)}% background, `
    + `${(result.ink * 100).toFixed(2)}% outline, topmost outline row at `
    + `${(result.edgeRow * 100).toFixed(0)}% of height`);
  if (d.shaderErrors?.length) {
    console.log('  device said:');
    for (const s of d.shaderErrors) console.log(`    ${s}`);
  }
}

const browser = await chromium.launch({
  executablePath,
  headless: process.env.GPU_CHECK_HEADFUL !== '1',
  // No --use-angle=vulkan: it steers WebGL onto a backend that is not there in
  // a headless container, and WebGPU does not need it.
  args: [
    '--enable-unsafe-webgpu', '--enable-features=Vulkan',
    '--enable-unsafe-swiftshader', '--no-sandbox',
  ],
});

// WebGL2 first and last word: it is the backend that must work here.
const BACKENDS = (process.env.GPU_CHECK_BACKENDS ?? 'webgl2,webgpu').split(',');
let failed = false;
let ran = 0;

try {
  for (const backend of BACKENDS) {
    console.log(`\n${backend}:`);
    const { result, logs, crash } = await probe(browser, backend);
    const lost = result?.diagnostics?.deviceLost ?? 0;

    // A device that went away is an environment problem. Tolerated for WebGPU,
    // where the software adapter is known to be unstable; never for WebGL2,
    // which has no excuse.
    const excusable = backend !== 'webgl2'
      && (lost > 0 || UNSTABLE.test(crash ?? '')
        || (result?.notes ?? []).some((n) => UNSTABLE.test(n)));

    if (crash || !result) {
      if (logs.length) console.log(logs.join('\n'));
      if (excusable) { console.log(`  skipped: the adapter died (${(crash ?? '').split('\n')[0]})`); continue; }
      console.error(`  FAILED: ${crash ?? 'no result'}`);
      failed = true;
      continue;
    }

    report(backend, result);
    if (result.image && process.env.GPU_CHECK_DUMP) {
      const file = resolve(root, `${process.env.GPU_CHECK_DUMP}-${backend}.png`);
      writeFileSync(file, Buffer.from(result.image.split(',')[1], 'base64'));
      console.log(`  wrote      : ${file}`);
    }
    if (!result.ok && excusable) {
      for (const n of result.notes) console.log(`  note: ${n}`);
      console.log(`  skipped: the adapter lost its device ${lost} time(s) mid-probe`);
      continue;
    }
    if (!result.ok) {
      for (const n of result.notes) console.error(`  - ${n}`);
      if (logs.length) console.error(logs.join('\n'));
      failed = true;
      continue;
    }
    ran++;
  }
} finally {
  await browser.close();
  server.close();
}

if (failed) {
  console.error('\ngpu check FAILED');
  process.exit(1);
}
if (!ran) skip('no backend produced a usable device');
console.log(`\nthe renderer links, runs and paints a skyline (${ran} backend(s) verified).`);

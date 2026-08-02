#!/usr/bin/env node
/**
 * Bundles one step preview into a single self-contained HTML file.
 *
 * The output has no <html>/<head>/<body> wrapper: it is a fragment that both a
 * plain browser and the Artifact host will render, and it references nothing
 * external — no CDN, no fetch, no separate asset. That constraint is the reason
 * the elevation data is carried as data: URIs.
 */
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const step = process.argv[2];
const outDir = process.argv[3] ?? join(root, 'dist', 'previews');
if (!step) {
  console.error('usage: build_preview.mjs <stepN> [outDir]');
  process.exit(1);
}

const TITLES = {
  step1: 'Peak Finder — Step 1 · Terrain & silhouette',
  step2: 'Peak Finder — Step 2 · Peak labels',
  step3: 'Peak Finder — Step 3 · Pose & sensors',
  step4: 'Peak Finder — Step 4 · AR camera overlay',
  step5: 'Peak Finder — Step 5 · Tiles & offline',
  step6: 'Peak Finder — Step 6 · Full app',
};

const result = await build({
  entryPoints: [join(root, 'src', 'preview', `${step}.ts`)],
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  minify: true,
  legalComments: 'none',
  write: false,
  logLevel: 'warning',
});

const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
// step6 is the shipping app, so it carries the app's stylesheet, not the
// preview harness one.
const cssFile = step === 'step6'
  ? join(root, 'src', 'app', 'app.css')
  : join(root, 'src', 'preview', 'preview.css');
const css = readFileSync(cssFile, 'utf8');
const title = TITLES[step] ?? `Peak Finder — ${step}`;

const html = `<title>${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>
${css}</style>
<script>
${js}</script>
`;

mkdirSync(outDir, { recursive: true });
const out = join(outDir, `${step}.html`);
writeFileSync(out, html);
console.error(`${out}  ${(statSync(out).size / 1024 / 1024).toFixed(2)} MB`);

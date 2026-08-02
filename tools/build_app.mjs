#!/usr/bin/env node
/** Builds the installable PWA into dist/app/. */
import { build } from 'esbuild';
import { cpSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] ?? join(root, 'dist', 'app');
mkdirSync(out, { recursive: true });

const res = await build({
  entryPoints: [join(root, 'src', 'main.ts')],
  bundle: true,
  format: 'esm',
  target: ['es2020'],
  minify: true,
  sourcemap: false,
  legalComments: 'eof',
  outfile: join(out, 'app.js'),
  logLevel: 'warning',
  metafile: true,
});

cpSync(join(root, 'src', 'app', 'app.css'), join(out, 'app.css'));
cpSync(join(root, 'index.html'), join(out, 'index.html'));
for (const f of readdirSync(join(root, 'public'))) {
  cpSync(join(root, 'public', f), join(out, f));
}

// Stamp the shell cache name so a redeploy actually invalidates the old one.
const swPath = join(out, 'sw.js');
const stamp = Object.keys(res.metafile.outputs)
  .map((k) => statSync(join(root, k)).size).reduce((a, b) => a + b, 0);
writeFileSync(swPath, readFileSync(swPath, 'utf8')
  .replace("'peakviewer-shell-v1'", `'peakviewer-shell-${stamp}'`));

const total = readdirSync(out).reduce((a, f) => a + statSync(join(out, f)).size, 0);
console.error(`${out}: ${readdirSync(out).length} files, ${(total / 1024).toFixed(0)} KB`);

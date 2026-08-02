#!/usr/bin/env node
/**
 * Collects the licence text of everything that ends up in a build.
 *
 * Apache-2.0 section 4 requires retaining the copyright and licence notices of
 * the code you redistribute, and a bundler stripping comments does not excuse
 * it. The bundles keep their banners; this file carries the full texts.
 */
import { readFileSync, existsSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';

// Same list the Credits panel renders, so the two cannot drift apart.
const cache = join('node_modules', '.cache-wgsl');
mkdirSync(cache, { recursive: true });
const bundled = await build({
  entryPoints: ['src/core/attribution.ts'],
  bundle: true, format: 'esm', write: false, platform: 'neutral', logLevel: 'error',
});
writeFileSync(join(cache, 'attribution.mjs'), bundled.outputFiles[0].text);
const A = await import(`file://${join(process.cwd(), cache, 'attribution.mjs')}`);

const SHIPPED = ['@babylonjs/core', 'geomagnetism'];
const parts = ['# Third-party notices', '',
  'This app redistributes the following, whose licences are reproduced in full.',
  ''];

for (const name of SHIPPED) {
  const dir = join('node_modules', name);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  parts.push(`## ${name} ${pkg.version} — ${pkg.license}`, '');
  if (pkg.homepage) parts.push(pkg.homepage, '');
  for (const f of readdirSync(dir)) {
    if (/^(licen[cs]e|notice)(\.(md|txt))?$/i.test(f)) {
      parts.push('```', readFileSync(join(dir, f), 'utf8').trim(), '```', '');
    }
  }
}

parts.push('## Data', '');
for (const c of A.OTHER_CREDITS) {
  parts.push(`- ${c.text}${c.url ? ` <${c.url}>` : ''}`);
}
parts.push('',
  '## Elevation surveys', '',
  'Terrain tiles are a composite of national and global surveys. These are the',
  'notices their licences require, reproduced verbatim. They are shown in the',
  "app's Credits panel as well, because a licence notice buried in a repository",
  'is not "a place that is reasonable to the medium".', '');
for (const c of A.TERRAIN_CREDITS) parts.push(`- ${c.text}`);
parts.push('',
  'Source list: https://github.com/tilezen/joerd/blob/master/docs/attribution.md',
  '',
  'The demo region bundled in `data/` covers the Swiss Valais, which that',
  'dataset sources from NASA/USGS SRTM — public domain, and covered by the USGS',
  'line above. Bake data for another country and the matching line above becomes',
  'a live obligation rather than a courtesy.', '',
  '## Summit names', '',
  'At runtime the app queries OpenStreetMap; its data is © OpenStreetMap',
  'contributors under the ODbL, credited in the Credits panel. The catalogue',
  'bundled with the demo build is *not* OSM-derived: those summits are computed',
  'from the elevation model by prominence and named from',
  'data/valais.catalogue.json.', '');

writeFileSync('THIRD-PARTY-NOTICES.md', parts.join('\n'));
if (existsSync('docs')) writeFileSync('docs/THIRD-PARTY-NOTICES.md', parts.join('\n'));
console.error(`THIRD-PARTY-NOTICES.md — ${SHIPPED.length} packages`);

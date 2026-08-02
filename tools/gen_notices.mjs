#!/usr/bin/env node
/**
 * Collects the licence text of everything that ends up in a build.
 *
 * Apache-2.0 section 4 requires retaining the copyright and licence notices of
 * the code you redistribute, and a bundler stripping comments does not excuse
 * it. The bundles keep their banners; this file carries the full texts.
 */
import { readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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

parts.push('## Elevation data', '',
  'Terrain comes from AWS Terrain Tiles (Mapzen "terrarium" encoding), a',
  'composite of national and global elevation models. Attribution follows the',
  'underlying source for the area concerned; the bundled demo region covers the',
  'Swiss Valais, sourced from NASA/USGS SRTM (public domain) via that dataset.',
  'See https://github.com/tilezen/joerd/blob/master/docs/attribution.md for the',
  'full per-source list, and reproduce the relevant lines if you bundle data for',
  'other regions.', '',
  '## Summit names', '',
  'At runtime the app queries OpenStreetMap, whose data is © OpenStreetMap',
  'contributors and licensed under the Open Database Licence (ODbL). The app',
  'credits them in its About panel. The catalogue bundled with the demo build is',
  'not OSM-derived: summits are computed from the elevation model and names come',
  'from data/valais.catalogue.json.', '',
  '## Magnetic model', '',
  'Magnetic declination uses the World Magnetic Model 2025, produced by NOAA',
  "NCEI and the British Geological Survey, via the `geomagnetism` package.", '');

writeFileSync('THIRD-PARTY-NOTICES.md', parts.join('\n'));
if (existsSync('docs')) writeFileSync('docs/THIRD-PARTY-NOTICES.md', parts.join('\n'));
console.error(`THIRD-PARTY-NOTICES.md — ${SHIPPED.length} packages`);

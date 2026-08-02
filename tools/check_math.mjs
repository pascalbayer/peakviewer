#!/usr/bin/env node
/**
 * Cross-check for the vertex shader's geometry.
 *
 * WebGPU cannot run here, so the shader's maths is mirrored in JavaScript,
 * evaluated in float32 the way a GPU would, and compared against the
 * double-precision routines the CPU side uses for labels and the horizon test.
 * If these two ever disagree, the outline and the labels sit on different
 * mountains — which is exactly the failure an earlier build shipped when the
 * shader differenced two isometric latitudes in a float32 register.
 */
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = join(root, 'node_modules', '.cache-wgsl');
mkdirSync(tmp, { recursive: true });

const out = await build({
  entryPoints: [join(root, 'src', 'core', 'geodesy.ts')],
  bundle: true, format: 'esm', write: false, platform: 'neutral', logLevel: 'error',
});
writeFileSync(join(tmp, 'geodesy.mjs'), out.outputFiles[0].text);
const G = await import(`file://${join(tmp, 'geodesy.mjs')}`);

const f = Math.fround;
const D = Math.PI / 180;

/** The WGSL body, term for term, rounded to float32 at every step. */
function shaderOffsets(lat0, bearingDeg, r, R) {
  const s0 = f(Math.sin(lat0 * D));
  const c0 = f(Math.cos(lat0 * D));
  const alpha = f(bearingDeg * D);
  const sinA = f(Math.sin(alpha));
  const cosA = f(Math.cos(alpha));
  const delta = f(r / R);
  const sinD = f(Math.sin(delta));
  const cosD = f(Math.cos(delta));
  const hs = f(Math.sin(f(0.5 * delta)));
  const hav = f(hs * hs);
  const ds = f(f(f(c0 * sinD) * cosA) - f(f(2 * s0) * hav));
  const sinP = Math.max(-1, Math.min(1, f(s0 + ds)));
  const dLon = f(Math.atan2(f(f(sinA * sinD) * c0), f(cosD - f(s0 * sinP))));
  const log1p = (x) => f(x * f(1 - f(x * f(0.5 - f(x * f(0.3333333
    - f(x * f(0.25 - f(x * f(0.2 - f(x * 0.1666667)))))))))));
  const dIso = f(0.5 * f(log1p(f(ds / f(1 + s0))) - log1p(f(-ds / f(1 - s0)))));
  return { dLon, dIso, sinD, hav };
}

const lat0 = 45.98333, lon0 = 7.78472;
const R = G.localRadius(lat0);
const isoRef = G.isometricLat(lat0);

let worstPos = 0, worstPosAt = '';
let worstPx = 0, worstPxAt = '';
let worstDrop = 0;

for (const bearing of [0, 17, 45, 91, 134, 180, 226, 271, 315, 359]) {
  for (const r of [2, 30, 200, 1000, 5000, 20000, 60000, 120000, 200000, 270000]) {
    const sh = shaderOffsets(lat0, bearing, r, R);
    const ref = G.destination(lon0, lat0, bearing, r, R);

    // Position agreement, in metres on the ground.
    const dLonErr = Math.abs(sh.dLon - (ref.lon - lon0) * D);
    const dIsoErr = Math.abs(sh.dIso - (G.isometricLat(ref.lat) - isoRef));
    const mPerRadLon = R * Math.cos(lat0 * D);
    const posErr = Math.hypot(dLonErr * mPerRadLon, dIsoErr * mPerRadLon);
    if (posErr > worstPos) { worstPos = posErr; worstPosAt = `${bearing}° / ${r} m`; }

    // The same error expressed where it actually bites: clipmap pixels at z12.
    const pxPerRad = (256 * 4096) / (2 * Math.PI);
    const pxErr = Math.hypot(dLonErr, dIsoErr) * pxPerRad;
    if (pxErr > worstPx) { worstPx = pxErr; worstPxAt = `${bearing}° / ${r} m`; }

    // Curvature + refraction drop, shader form vs the reference routine.
    const rEff = G.effectiveRadiusAt(lat0);
    const s = f(Math.sin(f(r / f(2 * rEff))));
    const shDrop = f(f(2 * rEff) * f(s * s));
    const refDrop = G.curvatureDrop(r, R);
    worstDrop = Math.max(worstDrop, Math.abs(shDrop - refDrop));
  }
}

console.error(`position agreement : worst ${worstPos.toFixed(3)} m  (at ${worstPosAt})`);
console.error(`clipmap sampling   : worst ${worstPx.toFixed(4)} px at z12  (at ${worstPxAt})`);
console.error(`drop term          : worst ${worstDrop.toFixed(3)} m vs curvatureDrop()`);

// Half a z12 pixel is 13 m on the ground; anything approaching that would show
// as the outline sitting off the ridge it is supposed to trace.
let bad = 0;
if (worstPx > 0.25) { console.error('FAIL: shader samples the clipmap off-position'); bad++; }
if (worstDrop > 0.05) { console.error('FAIL: drop term disagrees with the reference'); bad++; }
if (!bad) console.error('\nshader geometry matches the reference implementation.');
process.exitCode = bad ? 1 : 0;

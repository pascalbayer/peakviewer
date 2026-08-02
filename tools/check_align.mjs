#!/usr/bin/env node
/**
 * Does automatic alignment actually recover the error it is given?
 *
 * A registration routine that silently returns nonsense is worse than none at
 * all, because the whole point of the manual drag is that the user can see it
 * is theirs. So this builds a synthetic world, renders what a camera pointed
 * into it would see, tells the matcher a *wrong* pose, and checks it recovers
 * the difference.
 *
 * The synthetic frames are deliberately hostile to the easy cue: parts of the
 * terrain are brighter than the sky, the way snow is. Anything that separates
 * sky from mountain by brightness passes the flat cases and fails on a glacier,
 * so the fixture makes sure that shortcut cannot score.
 */
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const bundled = await build({
  entryPoints: [join(root, 'tools', 'align_entry.ts')],
  bundle: true, format: 'esm', write: false, platform: 'neutral', logLevel: 'error',
});
const tmp = join(root, 'node_modules', '.cache-align');
mkdirSync(tmp, { recursive: true });
writeFileSync(join(tmp, 'align.mjs'), bundled.outputFiles[0].text);
const M = await import(`file://${join(tmp, 'align.mjs')}`);

const DEG = Math.PI / 180;
const OBS = { lon: 7.7845, lat: 45.9835 };

// A skyline with structure. An even ridge is genuinely ambiguous in yaw and
// the matcher is supposed to say so, which is tested separately below.
const PEAKS = [
  { bear: 5, km: 9.0, top: 3600, sig: 0.9 },
  { bear: 18, km: 14.0, top: 4100, sig: 1.6 },
  { bear: 33, km: 7.5, top: 2900, sig: 0.7 },
  { bear: 47, km: 18.0, top: 3900, sig: 2.0 },
  { bear: -14, km: 11.0, top: 3300, sig: 1.1 },
  { bear: -28, km: 6.0, top: 2600, sig: 0.8 },
];
const FLOOR = 1500;

function heightAt(lon, lat) {
  const dx = (lon - OBS.lon) * 111.32 * Math.cos(lat * DEG);
  const dy = (lat - OBS.lat) * 111.32;
  let h = FLOOR;
  for (const p of PEAKS) {
    const px = p.km * Math.sin(p.bear * DEG);
    const py = p.km * Math.cos(p.bear * DEG);
    const d2 = (dx - px) ** 2 + (dy - py) ** 2;
    h = Math.max(h, FLOOR + (p.top - FLOOR) * Math.exp(-d2 / (2 * p.sig ** 2)));
  }
  return h;
}

/** One clipmap level, cut from the analytic world above. */
function makeField(z, size) {
  const hf = new M.HeightField(OBS.lon, OBS.lat);
  const n = 256 * (1 << z);
  const cx = ((OBS.lon + 180) / 360) * n;
  const s = Math.sin(OBS.lat * DEG);
  const cy = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  const px0 = Math.round(cx - size / 2);
  const py0 = Math.round(cy - size / 2);
  const raw = new Uint16Array(size * size);
  const BIAS = -1000;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const lon = ((px0 + x + 0.5) / n) * 360 - 180;
      const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (py0 + y + 0.5) / n))) / DEG;
      raw[y * size + x] = Math.round(heightAt(lon, lat) - BIAS);
    }
  }
  hf.addLevel({ z, px0, py0, w: size, h: size, quant: 1, bias: BIAS }, raw);
  return hf;
}

let seed = 12345;
function rnd() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
}

/**
 * What a camera at this pose would see. Terrain below the model's skyline, sky
 * above it, with the brightness relation deliberately unhelpful.
 */
function renderFrame(profile, pose, w, h, opts = {}) {
  const { snow = true, fogTop = 0 } = opts;
  const rgba = new Uint8ClampedArray(w * h * 4);
  const tanY = Math.tan(pose.fovY * DEG / 2);
  const tanX = tanY * (w / h);
  const cy = Math.cos(pose.yaw * DEG), sy = Math.sin(pose.yaw * DEG);
  const cp = Math.cos(pose.pitch * DEG), sp = Math.sin(pose.pitch * DEG);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const u = ((px + 0.5) / w) * 2 - 1;
      const v = 1 - ((py + 0.5) / h) * 2;
      const cxr = u * tanX, cyr = 1, czr = v * tanY;
      const ry = cyr * cp - czr * sp;
      const rz = cyr * sp + czr * cp;
      const east = cxr * cy + ry * sy;
      const north = -cxr * sy + ry * cy;
      const bearing = Math.atan2(east, north) / DEG;
      const elev = Math.atan2(rz, Math.hypot(east, north)) / DEG;
      const model = M.profileAt(profile, bearing);
      const isSky = Number.isNaN(model) || elev > model;
      let lum;
      if (isSky) {
        // Smooth, and not necessarily bright: an overcast sky is grey.
        lum = 148 + 42 * (1 - (py / h)) + 2 * (rnd() - 0.5);
      } else {
        // Textured, and sometimes brighter than the sky where there is snow.
        const depth = Math.max(0, model - elev);
        const base = snow && depth < 2.2 ? 205 : 96;
        lum = base + 46 * (rnd() - 0.5) + 26 * Math.sin(px * 0.7) * Math.cos(py * 0.5);
      }
      if (fogTop > 0 && py < h * fogTop) lum = 170 + 2 * (rnd() - 0.5);
      const i = (py * w + px) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = Math.max(0, Math.min(255, lum));
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

// ---------------------------------------------------------------------------

const hf = makeField(10, 512);
const eye = hf.groundAt(OBS.lon, OBS.lat) + 2;
const TRUE = { yaw: 20, pitch: 8, roll: 0, fovY: 51 };
const W = 640, H = 480;

const profile = M.horizonProfile(hf, eye, {
  ...M.DEFAULT_PROFILE, from: TRUE.yaw - 100, span: 200,
});

console.log(`world: eye ${eye.toFixed(0)} m, `
  + `skyline ${Math.min(...profile.elev).toFixed(1)}..${Math.max(...profile.elev).toFixed(1)}°`);

const frame = renderFrame(profile, TRUE, W, H);
const sky = M.extractSkyline(frame, W, H);
console.log(`skyline : ${sky.width}×${sky.height}, ${(sky.coverage * 100).toFixed(0)}% of columns usable`);

/** The boundary row the fixture actually drew, in working-image coordinates. */
function trueRow(pose, w, h, col) {
  const tanY = Math.tan(pose.fovY * DEG / 2);
  const tanX = tanY * (W / H);
  const cy = Math.cos(pose.yaw * DEG), sy = Math.sin(pose.yaw * DEG);
  const cp = Math.cos(pose.pitch * DEG), sp = Math.sin(pose.pitch * DEG);
  const u = ((col + 0.5) / w) * 2 - 1;
  for (let y = 0; y < h; y++) {
    const v = 1 - ((y + 0.5) / h) * 2;
    const cxr = u * tanX, czr = v * tanY;
    const ry = cp - czr * sp;
    const rz = sp + czr * cp;
    const east = cxr * cy + ry * sy;
    const north = -cxr * sy + ry * cy;
    const model = M.profileAt(profile, Math.atan2(east, north) / DEG);
    if (!Number.isNaN(model) && Math.atan2(rz, Math.hypot(east, north)) / DEG <= model) return y;
  }
  return NaN;
}

{
  const errs = [];
  for (let x = 0; x < sky.width; x++) {
    const t = trueRow(TRUE, sky.width, sky.height, x);
    if (!Number.isNaN(t) && sky.strength[x] > 0.05) errs.push(sky.row[x] - t);
  }
  errs.sort((a, b) => a - b);
  const med = errs[errs.length >> 1];
  const degPerPx = TRUE.fovY / sky.height;
  console.log(`row error: median ${med.toFixed(2)} px (${(med * degPerPx).toFixed(2)}°), `
    + `p10 ${errs[(errs.length * 0.1) | 0].toFixed(1)}, p90 ${errs[(errs.length * 0.9) | 0].toFixed(1)}, `
    + `n=${errs.length}`);
}

let failed = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failed++;
};

// --- does it recover a known error? ----------------------------------------
console.log('\nrecovering a known pose error:');
for (const [eYaw, ePitch] of [[0, 0], [4, 0], [-6.5, 0], [0, 2.5], [3.2, -1.8], [-9, 3]]) {
  const believed = { ...TRUE, yaw: TRUE.yaw + eYaw, pitch: TRUE.pitch + ePitch, aspect: W / H };
  const r = M.matchSkyline(sky, profile, believed);
  const errY = r.dYaw - (-eYaw);
  const errP = r.dPitch - (-ePitch);
  // Yaw is the well-conditioned axis: it is fixed by the *shape* of the
  // skyline, and every column votes on it. Pitch is not, because a constant
  // row bias in the extracted boundary and a genuine pitch error are the same
  // observation — nothing in the image distinguishes them. So pitch inherits
  // the extractor's sub-pixel accuracy directly, and about half a degree is
  // the floor for a horizon that spans three rows of a soft ramp.
  const good = r.ok && Math.abs(errY) < 0.35 && Math.abs(errP) < 0.8;
  check(`error ${eYaw >= 0 ? '+' : ''}${eYaw}° yaw / ${ePitch >= 0 ? '+' : ''}${ePitch}° pitch`, good,
    `recovered ${r.dYaw.toFixed(2)}/${r.dPitch.toFixed(2)}, off by `
    + `${errY.toFixed(2)}/${errP.toFixed(2)}, fit ${(r.fit * 100).toFixed(0)}%, `
    + `confidence ${(r.confidence * 100).toFixed(0)}%${r.ok ? '' : ` — ${r.why}`}`);
}

// --- does it decline when it should? ---------------------------------------
console.log('\ndeclining when the frame cannot support a match:');

const fog = M.extractSkyline(renderFrame(profile, TRUE, W, H, { fogTop: 1 }), W, H);
const rFog = M.matchSkyline(fog, profile, { ...TRUE, aspect: W / H });
check('a frame that is entirely fog', !rFog.ok, rFog.why || 'accepted it');

// A skyline from somewhere else entirely: right shape of signal, wrong world.
const elsewhere = M.horizonProfile(hf, eye + 2600, { ...M.DEFAULT_PROFILE, from: TRUE.yaw - 100, span: 200 });
const wrong = M.extractSkyline(renderFrame(elsewhere, TRUE, W, H), W, H);
const rWrong = M.matchSkyline(wrong, profile, { ...TRUE, aspect: W / H });
check('a skyline from 2.6 km higher up', !rWrong.ok || Math.abs(rWrong.dPitch) > 1,
  rWrong.ok ? `accepted with ${rWrong.dPitch.toFixed(2)}° pitch` : rWrong.why);

// --- is it stable against noise? -------------------------------------------
console.log('\nstability:');
const spread = [];
for (let i = 0; i < 5; i++) {
  seed = 999 + i * 7919;
  const s = M.extractSkyline(renderFrame(profile, TRUE, W, H), W, H);
  const r = M.matchSkyline(s, profile, { ...TRUE, yaw: TRUE.yaw + 5, aspect: W / H });
  spread.push(r.dYaw);
}
const mean = spread.reduce((a, b) => a + b, 0) / spread.length;
const dev = Math.max(...spread.map((v) => Math.abs(v - mean)));
check('five different noise seeds agree', dev < 0.3,
  `spread ${dev.toFixed(2)}°, mean ${mean.toFixed(2)}° (want -5)`);

if (process.env.ALIGN_DEBUG) {
  const col = 96;
  const t = trueRow(TRUE, sky.width, sky.height, col);
  console.log(`\ncolumn ${col}: true row ${t}, extracted ${sky.row[col]}`);
  // Re-derive the working-image grey for this column to see the transition.
  const w = sky.width, h = sky.height;
  const acc = new Float64Array(h), cnt = new Float64Array(h);
  for (let sy = 0; sy < H; sy++) {
    const dy = Math.min(h - 1, (sy * h / H) | 0);
    for (let sx = 0; sx < W; sx++) {
      const dx = Math.min(w - 1, (sx * w / W) | 0);
      if (dx !== col) continue;
      const p = (sy * W + sx) * 4;
      acc[dy] += 0.2126 * frame[p] + 0.7152 * frame[p + 1] + 0.0722 * frame[p + 2];
      cnt[dy]++;
    }
  }
  for (let y = Math.max(0, t - 5); y <= Math.min(h - 1, t + 10); y++) {
    console.log(`  row ${String(y).padStart(3)} grey ${(acc[y] / cnt[y]).toFixed(1)}`
      + `${y === t ? '   <- true boundary' : ''}${y === sky.row[col] ? '   <- extracted' : ''}`);
  }
}

console.log(failed ? `\nalign check FAILED (${failed})` : '\nalignment recovers pose error and declines when it cannot.');
process.exit(failed ? 1 : 0);

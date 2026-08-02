#!/usr/bin/env node
/**
 * Does the orientation filter actually settle, and does it still keep up?
 *
 * Those two pull against each other, which is the whole difficulty: any amount
 * of smoothing will stop a still phone shimmering if you are willing to let a
 * turning one lag. So this measures both on the same filter — residual jitter
 * with the phone held still against a noisy magnetometer, and how far behind
 * the truth it sits while being swung at speed.
 *
 * It also pins the two failures that no amount of filtering can fix, because
 * they are not noise: alternating between the two DeviceOrientation events,
 * whose alphas are measured from different norths, and integrating the gyro
 * about the wrong axis for a phone held upright.
 */
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundled = await build({
  entryPoints: [join(root, 'tools', 'pose_entry.ts')],
  bundle: true, format: 'esm', write: false, platform: 'node', logLevel: 'error',
});
const tmp = join(root, 'node_modules', '.cache-pose');
mkdirSync(tmp, { recursive: true });
writeFileSync(join(tmp, 'pose.mjs'), bundled.outputFiles[0].text);
const M = await import(`file://${join(tmp, 'pose.mjs')}`);

let failed = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failed++;
};

let seed = 4242;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const noise = (amp) => (rnd() * 2 - 1) * amp;

/** A phone held upright at the horizon, facing `yaw`. Euler for that pose. */
const upright = (yaw) => ({ alpha: (360 - yaw) % 360, beta: 90, gamma: 0 });

const HZ = 60;
const DT = 1000 / HZ;

function run({ seconds, yawAt, compassNoise = 0, gyro = true, feedRelativeToo = false }) {
  const p = new M.PoseTracker({});
  p.applyDeclination = false;
  const out = [];
  let calls = 0;
  p.opt = p.opt || {};
  const n = Math.round(seconds * HZ);
  let prevYaw = yawAt(0);
  for (let i = 0; i < n; i++) {
    const t = i / HZ;
    const truth = yawAt(t);
    const e = upright(truth + compassNoise * (rnd() * 2 - 1));
    p.feedOrientation(e.alpha, e.beta, e.gamma, 0);
    if (feedRelativeToo) {
      // The relative twin, measured from a different north entirely.
      const bad = upright(truth + 137);
      p.feedOrientation(bad.alpha, bad.beta, bad.gamma, 0);
    }
    if (gyro) {
      // Turning about world up, with the phone upright: for beta = 90 the
      // device's +y axis points at the sky, so that is where the rate goes.
      const rate = (truth - prevYaw) / (1 / HZ);
      p.feedGyro(0, -M.angleDelta(truth, prevYaw) * HZ, 0);
    }
    prevYaw = truth;
    const o = p.sample(i * DT);
    calls++;
    out.push({ t, truth, yaw: o.yaw, pitch: o.pitch, roll: o.roll });
  }
  return { out, calls };
}

// --- still, with a noisy magnetometer --------------------------------------
console.log('\nheld still, magnetometer noisy by ±3°:');
{
  const NOISE = 3;
  const { out } = run({ seconds: 6, yawAt: () => 42, compassNoise: NOISE });
  const tail = out.slice(HZ * 2);
  const rms = Math.sqrt(tail.reduce((a, r) => a + M.angleDelta(r.yaw, 42) ** 2, 0) / tail.length);
  const worst = Math.max(...tail.map((r) => Math.abs(M.angleDelta(r.yaw, 42))));
  // Uniform ±3° has an RMS of 3/sqrt(3) = 1.73°; anything close to that is unfiltered.
  check('jitter is filtered out', rms < 0.45,
    `output RMS ${rms.toFixed(2)}° against ${(NOISE / Math.sqrt(3)).toFixed(2)}° in, worst ${worst.toFixed(2)}°`);
}

// --- turning steadily -------------------------------------------------------
console.log('\nturning at 60°/s:');
{
  const { out } = run({ seconds: 4, yawAt: (t) => (20 + 60 * t) % 360, compassNoise: 1.5 });
  const tail = out.slice(HZ * 2);
  const lag = tail.reduce((a, r) => a + M.angleDelta(r.truth, r.yaw), 0) / tail.length;
  check('keeps up while turning', Math.abs(lag) < 4,
    `mean lag ${lag.toFixed(2)}° (${(lag / 60 * 1000).toFixed(0)} ms behind)`);
}

// --- a disturbed compass ----------------------------------------------------
console.log('\na ferrous object swings the compass 40° for half a second:');
{
  const { out } = run({
    seconds: 6,
    yawAt: () => 42,
    compassNoise: 0.5,
  });
  const p = new M.PoseTracker({});
  p.applyDeclination = false;
  let worst = 0;
  for (let i = 0; i < 6 * HZ; i++) {
    const t = i / HZ;
    const disturbed = t > 2 && t < 2.5 ? 40 : 0;
    const e = upright(42 + disturbed);
    p.feedOrientation(e.alpha, e.beta, e.gamma, 0);
    p.feedGyro(0, 0, 0);                       // the gyro says: not turning
    const o = p.sample(i * DT);
    if (t > 1) worst = Math.max(worst, Math.abs(M.angleDelta(o.yaw, 42)));
  }
  check('the view does not chase it', worst < 12, `worst excursion ${worst.toFixed(1)}° of the 40°`);
}

// --- the two-events bug -----------------------------------------------------
console.log('\nboth DeviceOrientation events firing, 137° apart:');
{
  // Through handleOrientation, which is where the choice is made. Absolute
  // says 42; the relative twin says 179, as it would on Android.
  const p = new M.PoseTracker({});
  p.applyDeclination = false;
  const seen = [];
  for (let i = 0; i < 4 * HZ; i++) {
    const good = upright(42);
    const bad = upright(179);
    p.handleOrientation({ ...good, absolute: true }, true, 0);
    p.handleOrientation({ ...bad }, false, 0);
    seen.push(p.sample(i * DT).yaw);
  }
  const tail = seen.slice(HZ * 2);
  const worst = Math.max(...tail.map((y) => Math.abs(M.angleDelta(y, 42))));
  check('the relative twin is ignored', worst < 1,
    `settled ${worst.toFixed(2)}° from the absolute reading, not pulled toward 179`);

  // And with no absolute event at all — iOS — the relative one must be used.
  const q = new M.PoseTracker({});
  q.applyDeclination = false;
  for (let i = 0; i < 3 * HZ; i++) {
    q.handleOrientation({ ...upright(0), webkitCompassHeading: 318 }, false, 0);
    q.sample(i * DT);
  }
  check('iOS, which has no absolute event, still works',
    Math.abs(M.angleDelta(q.orientation.yaw, 318)) < 1,
    `heading ${q.orientation.yaw.toFixed(1)}° from a webkitCompassHeading of 318`);
}

// --- pitch stays signed -----------------------------------------------------
console.log('\npitch below the horizon:');
{
  const p = new M.PoseTracker({});
  p.applyDeclination = false;
  let last = 0;
  for (let i = 0; i < 3 * HZ; i++) {
    // beta 70 => looking 20° down.
    p.feedOrientation(0, 70, 0, 0);
    last = p.sample(i * DT).pitch;
  }
  check('reads negative, not 340', last < 0 && last > -40, `settled at ${last.toFixed(1)}°`);
}

// --- work per frame ---------------------------------------------------------
console.log('\nwork rate:');
{
  const p = new M.PoseTracker({});
  let calls = 0;
  p.opt.onOrientation = () => { calls++; };
  // Two sensors at 60 Hz for one second, drawn at 60 fps.
  for (let i = 0; i < 60; i++) {
    p.feedOrientation(0, 90, 0, 0);
    p.feedOrientation(0, 90, 0, 0);
    p.feedGyro(0, 0, 0);
    p.feedGyro(0, 0, 0);
    p.sample(i * DT);
  }
  check('one update per frame, not one per event', calls === 60,
    `${calls} callbacks for 240 sensor events and 60 frames`);
}

console.log(failed ? `\npose check FAILED (${failed})` : '\norientation settles, keeps up, and runs once per frame.');
process.exit(failed ? 1 : 0);

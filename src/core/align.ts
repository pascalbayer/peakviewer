/**
 * Automatic alignment: fit the drawn skyline onto the one in the camera frame.
 *
 * The rest of this app deliberately avoids registering against the image — see
 * the note in the README — because sensors plus a drag are honest about their
 * own error, and a wrong automatic match is worse than an obvious manual one.
 * This does not replace that. It proposes a correction, reports how sure it is,
 * and declines when it is not; the drag stays the authority.
 *
 * The method suits mountains specifically. A skyline is a one-dimensional
 * signal — one horizon row per image column — so both sides reduce to a curve
 * of elevation angle against azimuth, and matching becomes a small
 * two-parameter search rather than image registration in any general sense.
 *
 *   camera : find the sky/terrain boundary per column, convert each to a ray
 *   model  : march the elevation model outward per bearing, keep the highest
 *            apparent elevation — exactly the horizon the renderer draws
 *   match  : search yaw and pitch offsets for the best robust agreement
 *
 * Nothing here touches the GPU. The model side is the same DEM march the label
 * visibility pass uses, with the same curvature and refraction terms, so the
 * profile being matched is the one on screen rather than an approximation of it.
 */

import { curvatureDrop, destination, localRadius, REFRACTION_K } from './geodesy';
import { HeightField } from './heightfield';

const DEG = Math.PI / 180;

// ---------------------------------------------------------------- the model

export interface ProfileOptions {
  /** First bearing covered, degrees. */
  from: number;
  /** Bearing span covered, degrees. */
  span: number;
  /** Bearing resolution, degrees. */
  step: number;
  /** Samples along each sightline. */
  steps: number;
  k: number;
}

export interface HorizonProfile {
  from: number;
  step: number;
  /** Apparent elevation of the skyline at each bearing, degrees. */
  elev: Float32Array;
}

export const DEFAULT_PROFILE: Omit<ProfileOptions, 'from' | 'span'> = {
  step: 0.35,
  steps: 96,
  k: REFRACTION_K,
};

/**
 * The skyline the renderer would draw, as elevation against bearing.
 *
 * Only the arc the search can reach is computed — the whole circle would be
 * mostly waste for a one-shot action — so this is a few tens of thousands of
 * DEM lookups rather than a few hundred thousand.
 */
export function horizonProfile(
  hf: HeightField, eyeAlt: number, opt: ProfileOptions,
): HorizonProfile {
  const radius = localRadius(hf.lat);
  const n = Math.max(2, Math.ceil(opt.span / opt.step) + 1);
  const elev = new Float32Array(n);
  const maxRange = Math.max(2000, hf.maxRange);
  const r0 = Math.min(80, maxRange * 0.002);
  const ratio = Math.log(maxRange / r0) / (opt.steps - 1);

  for (let b = 0; b < n; b++) {
    const bearing = opt.from + b * opt.step;
    let maxElev = -90;
    for (let i = 0; i < opt.steps; i++) {
      const r = r0 * Math.exp(i * ratio);
      const p = destination(hf.lon, hf.lat, bearing, r, radius);
      const h = hf.height(p.lon, p.lat, r);
      const up = h - eyeAlt - curvatureDrop(r, radius, opt.k);
      const e = Math.atan2(up, r) / DEG;
      if (e > maxElev) maxElev = e;
    }
    elev[b] = maxElev;
  }
  return { from: opt.from, step: opt.step, elev };
}

/** Linear interpolation into a profile. NaN outside the arc it covers. */
export function profileAt(p: HorizonProfile, bearing: number): number {
  let t = (bearing - p.from) / p.step;
  // Bearings wrap; the arc may straddle 0.
  const n = p.elev.length;
  if (t < 0 || t > n - 1) {
    const alt = (bearing + (t < 0 ? 360 : -360) - p.from) / p.step;
    if (alt < 0 || alt > n - 1) return NaN;
    t = alt;
  }
  const i = Math.floor(t);
  const f = t - i;
  return i + 1 < n ? p.elev[i] * (1 - f) + p.elev[i + 1] * f : p.elev[i];
}

// --------------------------------------------------------------- the camera

export interface SkylineOptions {
  /** Longest side of the working image. Detail beyond this buys nothing. */
  size: number;
  /**
   * Cost per pixel of vertical step between neighbouring columns. Small enough
   * to let a ridge be near-vertical, large enough that the path does not wander
   * through clouds.
   */
  slopeCost: number;
  /** Largest vertical step allowed between columns, in pixels. */
  maxSlope: number;
  /** Weight of "there is terrain below" against the local switch-on. */
  contrast: number;
  /**
   * Cost of each unit of texture the path leaves above it.
   *
   * This is what makes the skyline the *topmost* transition rather than the
   * strongest one. A mountain frame very often has a harder edge below the
   * ridge than the ridge itself — a snowline, a shadow, a treeline — and the
   * cost has to accumulate per row rather than be averaged, or two rows of
   * ridge among sixty of sky barely register and the stronger edge wins.
   */
  skyCost: number;
  /** Half-height of the local window, in pixels of the working image. */
  band: number;
  /**
   * Texture level, in normalised Sobel units, below which a frame is treated as
   * having no usable structure at all. Without a floor the normalisation turns
   * the sensor noise of a fogged-in frame into a confident-looking skyline.
   */
  floor: number;
}

export const DEFAULT_SKYLINE: SkylineOptions = {
  size: 192,
  slopeCost: 0.035,
  maxSlope: 28,
  contrast: 0.25,
  skyCost: 0.3,
  band: 6,
  floor: 0.06,
};

export interface Skyline {
  width: number;
  height: number;
  /** Horizon row per column. */
  row: Float32Array;
  /** Per-column confidence, 0..1. Zero means "do not use this column". */
  strength: Float32Array;
  /** Fraction of columns with a usable horizon. */
  coverage: number;
}

/**
 * The sky/terrain boundary, one row per column.
 *
 * Brightness is not the cue. Snow against a blue sky inverts it and an overcast
 * sky defeats it entirely; what separates sky from mountain reliably is
 * *texture*, which is near-zero above the horizon and never below it. So the
 * boundary is scored by local edge energy plus the contrast between the mean
 * texture below a candidate row and above it, and a shortest-path walk across
 * the columns keeps the result a single connected skyline rather than a set of
 * independent guesses that can each be wrong in a different direction.
 */
export function extractSkyline(
  rgba: Uint8ClampedArray, srcW: number, srcH: number,
  opt: SkylineOptions = DEFAULT_SKYLINE,
): Skyline {
  const scale = Math.min(1, opt.size / Math.max(srcW, srcH));
  const w = Math.max(8, Math.round(srcW * scale));
  const h = Math.max(8, Math.round(srcH * scale));

  // Box-filtered downsample: every source pixel contributes, so thin bright
  // features cannot alias into a false edge.
  const gray = new Float32Array(w * h);
  {
    const acc = new Float32Array(w * h);
    const cnt = new Float32Array(w * h);
    for (let sy = 0; sy < srcH; sy++) {
      const dy = Math.min(h - 1, (sy * h / srcH) | 0);
      for (let sx = 0; sx < srcW; sx++) {
        const dx = Math.min(w - 1, (sx * w / srcW) | 0);
        const p = (sy * srcW + sx) * 4;
        acc[dy * w + dx] += 0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2];
        cnt[dy * w + dx]++;
      }
    }
    for (let i = 0; i < gray.length; i++) gray[i] = cnt[i] ? acc[i] / cnt[i] / 255 : 0;
  }

  // Sobel magnitude, then a light blur so a single noisy pixel cannot anchor
  // the path.
  const edge = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = (gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1])
        - (gray[i - w - 1] + 2 * gray[i - 1] + gray[i + w - 1]);
      const gy = (gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1])
        - (gray[i - w - 1] + 2 * gray[i - w] + gray[i - w + 1]);
      edge[i] = Math.hypot(gx, gy);
    }
  }
  const tex = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      tex[i] = (edge[i - w] + edge[i - 1] + edge[i] + edge[i + 1] + edge[i + w]) / 5;
    }
  }
  // Normalise against the frame's own texture, but never below an absolute
  // floor: a fogged-in frame has no structure, and dividing by its own maximum
  // would rescale the sensor noise into a confident-looking skyline.
  let texMax = opt.floor;
  for (const v of tex) if (v > texMax) texMax = v;

  // Everything below works on texture *above the frame's own noise floor*.
  // Empty sky is not literally smooth — sensor noise, JPEG blocking and haze
  // all register — and since the penalty below accumulates per row, sky that
  // costs anything at all would make the result depend on how much sky is in
  // frame. Subtracting a low percentile makes it cost nothing, which is both
  // truer and what keeps the tuning from being a knife edge.
  const sorted = Float32Array.from(tex).sort();
  const base = sorted[Math.floor(sorted.length * 0.2)] / texMax;

  // Column-cumulative, so every window mean below is O(1).
  const cum = new Float32Array(w * (h + 1));
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const v = Math.max(0, tex[y * w + x] / texMax - base);
      cum[x * (h + 1) + y + 1] = cum[x * (h + 1) + y] + v;
    }
  }
  const mean = (c: number, a: number, b: number): number =>
    (b > a ? (cum[c + b] - cum[c + a]) / (b - a) : 0);

  /**
   * How far down a column the sky reaches.
   *
   * Read it as a running trade: moving the boundary one row down gains
   * whatever terrain that brings into view and pays for the texture it leaves
   * overhead. Through empty sky the texture costs nothing, so the boundary
   * slides freely; at the first real ridge the cost jumps and it stops. The
   * peak therefore sits at the *topmost* transition, which is what a skyline
   * is, rather than at the sharpest one, which on a snow-capped ridge is
   * several degrees too low.
   *
   * Two earlier versions of this got it wrong in instructive ways. Adding the
   * raw edge magnitude at the row is not a change-point measure at all and
   * walks the path down into whatever terrain is busiest — a constant 2.25° of
   * pitch. Averaging the penalty over the whole column above dilutes it to
   * nothing: two ridge rows among sixty of sky move a mean by 3%, and the
   * snowline still won by a clear margin.
   */
  const score = (x: number, y: number): number => {
    const c = x * (h + 1);
    const below = mean(c, y, Math.min(h, y + opt.band));
    return below + opt.contrast * mean(c, y, h) - opt.skyCost * cum[c + y];
  };

  // Shortest path across the columns. The top and bottom rows are excluded:
  // a boundary there means the horizon is outside the frame, not that it sits
  // on the edge of it.
  const y0 = 1;
  const y1 = h - 2;
  const best = new Float32Array(w * h).fill(-Infinity);
  const from = new Int16Array(w * h).fill(-1);
  for (let y = y0; y <= y1; y++) best[y] = score(0, y);
  for (let x = 1; x < w; x++) {
    for (let y = y0; y <= y1; y++) {
      let bv = -Infinity;
      let bi = -1;
      const lo = Math.max(y0, y - opt.maxSlope);
      const hi = Math.min(y1, y + opt.maxSlope);
      for (let py = lo; py <= hi; py++) {
        const v = best[(x - 1) * h + py] - opt.slopeCost * Math.abs(py - y);
        if (v > bv) { bv = v; bi = py; }
      }
      best[x * h + y] = bv + score(x, y);
      from[x * h + y] = bi;
    }
  }

  let endY = y0;
  for (let y = y0; y <= y1; y++) if (best[(w - 1) * h + y] > best[(w - 1) * h + endY]) endY = y;

  const row = new Float32Array(w);
  const strength = new Float32Array(w);
  let y = endY;
  for (let x = w - 1; x >= 0; x--) {
    // Sub-pixel: fit a parabola through the score either side of the chosen
    // row. A whole row is 0.35° of pitch at this working size, which is the
    // largest single error left in the fit, and the boundary is a soft ramp
    // rather than a step — no camera resolves a horizon in one pixel.
    let sub = 0;
    if (y > y0 && y < y1) {
      const a = score(x, y - 1), b = score(x, y), c2 = score(x, y + 1);
      const denom = a - 2 * b + c2;
      if (denom < -1e-9) sub = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c2)) / denom));
    }
    row[x] = y + sub;
    // A column earns its say from how sharply texture switches on across the
    // path. A featureless column — fog, an overexposed sky, the inside of a
    // cloud — contributes nothing rather than a confident guess.
    const c = x * (h + 1);
    const local = mean(c, y, Math.min(h, y + opt.band)) - mean(c, Math.max(0, y - opt.band), y);
    const contrast = mean(c, y, h) - mean(c, 0, y);
    strength[x] = Math.max(0, Math.min(1, 3 * local)) * Math.max(0, Math.min(1, 4 * contrast));
    y = from[x * h + y] >= 0 ? from[x * h + y] : y;
  }

  let used = 0;
  for (let x = 0; x < w; x++) if (strength[x] > 0.05) used++;
  return { width: w, height: h, row, strength, coverage: used / w };
}

// ---------------------------------------------------------------- the match

export interface ViewGeometry {
  /** Bearing of the optical axis, degrees. */
  yaw: number;
  pitch: number;
  roll: number;
  /** Vertical field of view of the *lens*, over the video frame, degrees. */
  fovY: number;
  /** Video frame aspect, width / height. */
  aspect: number;
}

export interface AlignOptions {
  /** Half-width of the yaw search, degrees. */
  yawRange: number;
  pitchRange: number;
  coarseStep: number;
  fineStep: number;
  /** Angular scale of the robust loss, degrees. */
  sigma: number;
  /** How far from the winner a rival has to be to count as a rival, degrees. */
  separation: number;
  minCoverage: number;
  minFit: number;
  minConfidence: number;
}

export const DEFAULT_ALIGN: AlignOptions = {
  yawRange: 14,
  pitchRange: 7,
  coarseStep: 0.5,
  fineStep: 0.05,
  sigma: 0.9,
  separation: 3,
  minCoverage: 0.35,
  minFit: 0.32,
  minConfidence: 0.18,
};

export interface AlignResult {
  ok: boolean;
  /** Correction to add to the heading offset, degrees. */
  dYaw: number;
  /** Correction to add to the pitch offset, degrees. */
  dPitch: number;
  /** Agreement at the winning pose, 0..1. */
  fit: number;
  /** How much the winner beat the best rival elsewhere, 0..1. */
  confidence: number;
  coverage: number;
  why: string;
}

/**
 * Search yaw and pitch for the offset that best lays the camera's skyline on
 * the model's.
 *
 * The score is deliberately robust rather than least-squares. Half a skyline is
 * routinely wrong for reasons no elevation model knows about — a cloud bank, a
 * roof, a lamp post, someone's shoulder — and a quadratic loss lets any of them
 * drag the fit. A Lorentzian weights a column by how well it already agrees, so
 * gross outliers are ignored instead of averaged in.
 */
export function matchSkyline(
  sky: Skyline, profile: HorizonProfile, view: ViewGeometry,
  opt: AlignOptions = DEFAULT_ALIGN,
): AlignResult {
  const fail = (why: string): AlignResult => ({
    ok: false, dYaw: 0, dPitch: 0, fit: 0, confidence: 0, coverage: sky.coverage, why,
  });
  if (sky.coverage < opt.minCoverage) {
    return fail(`only ${(sky.coverage * 100).toFixed(0)}% of the frame has a usable skyline`);
  }

  // Each column's ray in the camera's own frame, fixed for the whole search:
  // x right, y forward, z up, before any of the pose rotations.
  const n = sky.width;
  const tanY = Math.tan(view.fovY * DEG / 2);
  const tanX = tanY * view.aspect;
  const rays = new Float32Array(n * 3);
  const wgt = new Float32Array(n);
  let wsum = 0;
  for (let x = 0; x < n; x++) {
    const u = ((x + 0.5) / sky.width) * 2 - 1;
    const v = 1 - ((sky.row[x] + 0.5) / sky.height) * 2;
    rays[x * 3] = u * tanX;
    rays[x * 3 + 1] = 1;
    rays[x * 3 + 2] = v * tanY;
    wgt[x] = sky.strength[x];
    wsum += wgt[x];
  }
  if (wsum <= 0) return fail('no column carried enough evidence');

  const evaluate = (dYaw: number, dPitch: number): number => {
    const y = (view.yaw + dYaw) * DEG;
    const p = (view.pitch + dPitch) * DEG;
    const r = view.roll * DEG;
    const cy = Math.cos(y), sy = Math.sin(y);
    const cp = Math.cos(p), sp = Math.sin(p);
    const cr = Math.cos(r), sr = Math.sin(r);
    let acc = 0;
    for (let x = 0; x < n; x++) {
      if (wgt[x] <= 0) continue;
      let cx = rays[x * 3], cyv = rays[x * 3 + 1], cz = rays[x * 3 + 2];
      // roll about the optical axis, then pitch, then yaw into ENU
      const rx = cx * cr - cz * sr;
      const rz = cx * sr + cz * cr;
      const py = cyv * cp - rz * sp;
      const pz = cyv * sp + rz * cp;
      const east = rx * cy + py * sy;
      const north = -rx * sy + py * cy;
      const bearing = Math.atan2(east, north) / DEG;
      const elev = Math.atan2(pz, Math.hypot(east, north)) / DEG;
      const model = profileAt(profile, bearing);
      if (Number.isNaN(model)) continue;
      const d = (elev - model) / opt.sigma;
      acc += wgt[x] / (1 + d * d);
    }
    return acc / wsum;
  };

  // Coarse sweep, then a fine one around the winner. The coarse grid also
  // supplies the rival the confidence is measured against.
  let bestFit = -1, bestYaw = 0, bestPitch = 0;
  const grid: { yaw: number; pitch: number; fit: number }[] = [];
  for (let dy = -opt.yawRange; dy <= opt.yawRange + 1e-9; dy += opt.coarseStep) {
    for (let dp = -opt.pitchRange; dp <= opt.pitchRange + 1e-9; dp += opt.coarseStep) {
      const f = evaluate(dy, dp);
      grid.push({ yaw: dy, pitch: dp, fit: f });
      if (f > bestFit) { bestFit = f; bestYaw = dy; bestPitch = dp; }
    }
  }

  let rival = 0;
  for (const g of grid) {
    if (Math.abs(g.yaw - bestYaw) < opt.separation && Math.abs(g.pitch - bestPitch) < opt.separation) continue;
    if (g.fit > rival) rival = g.fit;
  }

  const span = opt.coarseStep;
  for (let dy = bestYaw - span; dy <= bestYaw + span + 1e-9; dy += opt.fineStep) {
    for (let dp = bestPitch - span; dp <= bestPitch + span + 1e-9; dp += opt.fineStep) {
      const f = evaluate(dy, dp);
      if (f > bestFit) { bestFit = f; bestYaw = dy; bestPitch = dp; }
    }
  }

  const confidence = bestFit > 0 ? Math.max(0, (bestFit - rival) / bestFit) : 0;
  const res: AlignResult = {
    ok: true,
    dYaw: bestYaw,
    dPitch: bestPitch,
    fit: bestFit,
    confidence,
    coverage: sky.coverage,
    why: '',
  };
  if (bestFit < opt.minFit) {
    res.ok = false;
    res.why = `the best fit was only ${(bestFit * 100).toFixed(0)}% — the skyline in view does not look like this one`;
  } else if (confidence < opt.minConfidence) {
    res.ok = false;
    res.why = `${(confidence * 100).toFixed(0)}% confidence — a ridge this even fits in several places`;
  }
  return res;
}

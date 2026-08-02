/**
 * Which summits the terrain hides.
 *
 * The WebGL build answered this on the GPU, by drawing one point per summit
 * into a small buffer and reading it back every frame. That read-back is a
 * pipeline stall, and it only ever answered for the current frustum, so the
 * summit list could not say what lay behind you.
 *
 * This walks the elevation model instead: march along the great circle towards
 * each summit, track the highest apparent elevation angle on the way, and the
 * summit is visible if it clears it. It depends on where you stand, not where
 * you point, so it runs once per position rather than once per frame — and it
 * uses the same curvature and refraction terms as the renderer, so the two
 * cannot disagree about the horizon.
 */

import { curvatureDrop, destination, localRadius, REFRACTION_K } from './geodesy';
import { HeightField } from './heightfield';
import type { LabelTarget } from './labels';

export interface HorizonOptions {
  /** Samples along each sightline. */
  steps: number;
  /**
   * Slack in degrees. A catalogued summit sits above the DEM's rounded-off
   * version of itself, and the last few samples of a sightline climb the peak
   * being tested, so a little tolerance keeps real summits from hiding behind
   * their own slopes.
   */
  tolerance: number;
  k: number;
}

export const DEFAULT_HORIZON: HorizonOptions = {
  steps: 96,
  tolerance: 0.05,
  k: REFRACTION_K,
};

/**
 * Sets `visible` on every target. Returns how many are visible.
 *
 * Cost is steps × targets DEM lookups — a few tens of thousands, a couple of
 * milliseconds, once per position.
 */
export function computeVisibility(
  targets: LabelTarget[],
  hf: HeightField,
  eyeAlt: number,
  opt: HorizonOptions = DEFAULT_HORIZON,
): number {
  const radius = localRadius(hf.lat);
  const from = { lon: hf.lon, lat: hf.lat };
  let visible = 0;

  for (const t of targets) {
    const range = t.range;
    if (range < 60) { t.visible = true; visible++; continue; }

    // Geometric spacing: near ground matters far more than the last kilometre,
    // and it keeps the step proportional to the DEM resolution at that range.
    const r0 = Math.min(80, range * 0.02);
    const ratio = Math.log((range * 0.985) / r0) / (opt.steps - 1);
    let maxElev = -90;
    for (let i = 0; i < opt.steps; i++) {
      const r = r0 * Math.exp(i * ratio);
      const p = destination(from.lon, from.lat, t.bearing, r, radius);
      const h = hf.height(p.lon, p.lat, r);
      const up = h - eyeAlt - curvatureDrop(r, radius, opt.k);
      const elev = Math.atan2(up, r) * (180 / Math.PI);
      if (elev > maxElev) maxElev = elev;
    }
    t.visible = t.elevation >= maxElev - opt.tolerance;
    if (t.visible) visible++;
  }
  return visible;
}

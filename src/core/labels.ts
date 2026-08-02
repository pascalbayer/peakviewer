/**
 * Turning a summit catalogue into a readable set of labels.
 *
 * Three separate jobs, deliberately kept apart:
 *   geometry   where a summit sits relative to the observer (curvature and
 *              refraction included, same frame the renderer uses);
 *   visibility whether the terrain hides it — answered by the GPU against the
 *              rendered range buffer, not by a horizon algorithm;
 *   layout     which of the survivors can be shown without overlapping.
 */

import { Camera } from './camera';
import { localOffset } from './geodesy';
import { HeightField, Observer } from './heightfield';
import { Peak, peakImportance } from './peaks';

export interface LabelTarget {
  peak: Peak;
  /** Local ENU of the label anchor, metres. */
  east: number;
  north: number;
  up: number;
  range: number;
  bearing: number;
  /** Apparent elevation angle, degrees, after curvature + refraction. */
  elevation: number;
  /** Altitude the anchor sits at — the DEM's summit, not the catalogue's. */
  anchorAlt: number;
  /** Sort key: how much this summit deserves the screen space. */
  score: number;
  visible: boolean;
}

export interface PlacedLabel {
  target: LabelTarget;
  /** Anchor in CSS pixels. */
  ax: number;
  ay: number;
  /** Text box in CSS pixels. */
  bx: number;
  by: number;
  bw: number;
  bh: number;
  lines: string[];
}

export interface LayoutOptions {
  width: number;
  height: number;
  measure(text: string, big: boolean): number;
  /** Rough line height in CSS pixels. */
  lineHeight: number;
  maxLabels: number;
  /** How many of the top labels get a second line with distance/height. */
  detailed: number;
  /** Minimum gap between boxes, px. */
  gap: number;
}

const NEAR_ANCHOR_M = 140;

/**
 * Builds the per-observer geometry. Called when the observer moves, not per
 * frame — nothing here depends on where the camera is pointing.
 */
export function buildTargets(
  peaks: Peak[], obs: Observer, hf: HeightField, maxRange: number,
): LabelTarget[] {
  const eye = obs.ground + obs.eye;
  const out: LabelTarget[] = [];
  for (const p of peaks) {
    // Anchor on the summit the renderer actually draws. A catalogue elevation
    // can sit 130 m above the DEM's idea of the same summit; anchoring there
    // leaves the label floating in the sky above its own mountain.
    const anchorAlt = p.demEle ?? hf.summitNear(p.lon, p.lat, NEAR_ANCHOR_M);
    const o = localOffset({ lon: obs.lon, lat: obs.lat, alt: eye },
      { lon: p.lon, lat: p.lat, alt: anchorAlt });
    if (o.range > maxRange || o.range < 20) continue;
    out.push({
      peak: p,
      east: o.east, north: o.north, up: o.up,
      range: o.range, bearing: o.bearing, elevation: o.elevation,
      anchorAlt,
      // Importance falls off with distance, but slowly: Mont Blanc at 85 km
      // still earns a label over a nameless 3000er at 6 km.
      score: peakImportance(p) - o.range / 260,
      visible: false,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * Screen placement. Labels are claimed in importance order and stacked
 * upwards from their summit; a label that cannot find a free slot is dropped
 * rather than allowed to overlap, so the ones that survive stay readable.
 */
export function layoutLabels(
  targets: LabelTarget[], cam: Camera, opt: LayoutOptions,
): PlacedLabel[] {
  const ndc = new Float32Array(3);
  const placed: PlacedLabel[] = [];
  const boxes: PlacedLabel[] = [];
  const margin = 4;

  for (let i = 0; i < targets.length && placed.length < opt.maxLabels; i++) {
    const t = targets[i];
    if (!t.visible) continue;
    const w = cam.project(t.east, t.north, t.up, ndc);
    if (w <= 0) continue;
    const ax = (ndc[0] * 0.5 + 0.5) * opt.width;
    const ay = (1 - (ndc[1] * 0.5 + 0.5)) * opt.height;
    if (ax < -40 || ax > opt.width + 40 || ay < -40 || ay > opt.height + 40) continue;

    const detailed = placed.length < opt.detailed;
    const lines = detailed
      ? [t.peak.name, `${fmtEle(t.peak)} · ${fmtRange(t.range)}`]
      : [t.peak.name];
    const bw = Math.max(...lines.map((s, li) => opt.measure(s, li === 0))) + 12;
    const bh = lines.length * opt.lineHeight + 6;

    let bx = Math.min(Math.max(ax - bw / 2, 2), opt.width - bw - 2);
    let by = ay - 14 - bh;
    let ok = false;
    for (let attempt = 0; attempt < 26; attempt++) {
      if (by < 2) break;
      const hit = boxes.some((b) =>
        bx < b.bx + b.bw + opt.gap && bx + bw + opt.gap > b.bx
        && by < b.by + b.bh + margin && by + bh + margin > b.by);
      if (!hit) { ok = true; break; }
      by -= opt.lineHeight + opt.gap;
    }
    if (!ok) continue;

    const p: PlacedLabel = { target: t, ax, ay, bx, by, bw, bh, lines };
    placed.push(p);
    boxes.push(p);
  }
  return placed;
}

export function fmtRange(m: number): string {
  return m < 9500 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 1000)} km`;
}

export function fmtEle(p: Peak): string {
  const e = p.ele ?? p.demEle;
  return e === undefined ? '' : `${Math.round(e)} m`;
}

/** Nearest placed label to a tap, or null. */
export function pickLabel(placed: PlacedLabel[], x: number, y: number, slop = 26): PlacedLabel | null {
  let best: PlacedLabel | null = null;
  let bestD = slop * slop;
  for (const p of placed) {
    if (x >= p.bx - 6 && x <= p.bx + p.bw + 6 && y >= p.by - 4 && y <= p.by + p.bh + 4) return p;
    const d = (x - p.ax) ** 2 + (y - p.ay) ** 2;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

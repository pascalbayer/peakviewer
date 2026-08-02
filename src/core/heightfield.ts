/**
 * The on-device elevation model: a set of concentric Web-Mercator crops
 * ("levels") centred on the observer, each one twice the extent and half the
 * resolution of the one inside it. That is the same clipmap the renderer walks
 * at runtime, so a baked demo region and a live tile stream are interchangeable
 * as far as everything above this file is concerned.
 */

import { isometricLat, latToMercY, lonToMercX, mercResolution } from './geodesy';

export interface LevelSpec {
  /** Web Mercator zoom this level is cropped from. */
  z: number;
  /** Pixel coordinate of the crop's top-left corner at that zoom. */
  px0: number;
  py0: number;
  w: number;
  h: number;
  /** Height quantisation step, metres. */
  quant: number;
  /** height = raw * quant + bias */
  bias: number;
}

export interface Level extends LevelSpec {
  /** Quantised heights, row-major, w*h entries. */
  raw: Uint16Array;
  /** Ground sample distance at the origin latitude, metres. */
  res: number;
  /** Largest range this level is authoritative for, metres (inscribed circle). */
  maxRange: number;
  /** Origin's fractional pixel position inside the crop. */
  cx: number;
  cy: number;
  version: number;
  /**
   * Whether this level holds real data yet.
   *
   * A streamed level is allocated empty and filled later, and an empty raster
   * is not "no answer" — it reads as a uniform `bias` metres, which is a
   * perfectly plausible-looking elevation. Sampling has to skip it, or a cold
   * start reports the observer standing 2.6 km below the valley floor for as
   * long as the fill takes, and every horizon that depends on eye height is
   * wrong for that whole window.
   */
  filled: boolean;
}

export interface Observer {
  lon: number;
  lat: number;
  /** Ground elevation at the observer, metres. */
  ground: number;
  /** Eye height above ground, metres. */
  eye: number;
}

export class HeightField {
  readonly levels: Level[] = [];
  lon = 0;
  lat = 0;
  /** Isometric latitude of the origin, cached — the shader needs the same value. */
  iso0 = 0;

  constructor(lon: number, lat: number) {
    this.setOrigin(lon, lat);
  }

  setOrigin(lon: number, lat: number) {
    this.lon = lon;
    this.lat = lat;
    this.iso0 = isometricLat(lat);
    for (const l of this.levels) this.refreshOrigin(l);
  }

  private refreshOrigin(l: Level) {
    l.cx = lonToMercX(this.lon, l.z) - l.px0;
    l.cy = latToMercY(this.lat, l.z) - l.py0;
    l.res = mercResolution(this.lat, l.z);
    // Largest circle centred on the *observer* that still fits inside the crop,
    // minus a margin so bilinear taps never run off the edge and so the
    // cross-fade into the next level has room. Shrinks as the observer moves
    // away from where the level was cut.
    const inset = Math.min(l.cx, l.w - l.cx, l.cy, l.h - l.cy);
    l.maxRange = Math.max(0, inset - 2) * l.res;
  }

  /** `filled` is false for a level that is allocated now and streamed later. */
  addLevel(spec: LevelSpec, raw: Uint16Array, filled = true): Level {
    const l: Level = {
      ...spec, raw, res: 0, maxRange: 0, cx: 0, cy: 0, version: 0, filled,
    };
    this.refreshOrigin(l);
    this.levels.push(l);
    this.levels.sort((a, b) => a.maxRange - b.maxRange);
    return l;
  }

  get maxRange(): number {
    return this.levels.length ? this.levels[this.levels.length - 1].maxRange : 0;
  }

  /** Pixel coordinates of a geodetic point inside a level's crop. */
  project(l: Level, lon: number, lat: number): { u: number; v: number } {
    const n = 256 * (1 << l.z);
    return {
      u: l.cx + (lon - this.lon) * (n / 360),
      v: l.cy - (isometricLat(lat) - this.iso0) * (n / (2 * Math.PI)),
    };
  }

  /** Bilinear height from one level, metres. NaN outside the crop. */
  heightIn(l: Level, lon: number, lat: number): number {
    const { u, v } = this.project(l, lon, lat);
    // Raster pixels are area samples, so pixel i is centred at i+0.5. The GPU
    // path applies the same half-pixel shift; if these two ever disagree the
    // labels drift against the terrain by half a DEM post.
    const x0 = Math.floor(u - 0.5), y0 = Math.floor(v - 0.5);
    if (x0 < 0 || y0 < 0 || x0 + 1 >= l.w || y0 + 1 >= l.h) return NaN;
    const fx = u - 0.5 - x0, fy = v - 0.5 - y0;
    const i = y0 * l.w + x0;
    const a = l.raw[i], b = l.raw[i + 1];
    const c = l.raw[i + l.w], d = l.raw[i + l.w + 1];
    const top = a + (b - a) * fx;
    const bot = c + (d - c) * fx;
    return (top + (bot - top) * fy) * l.quant + l.bias;
  }

  /**
   * Height at a point, choosing the finest level that covers it. `range` is a
   * hint used to pick the level; pass the real ground range when known so the
   * CPU agrees with the GPU about which level applies.
   */
  height(lon: number, lat: number, range = 0): number {
    for (const l of this.levels) {
      if (range > l.maxRange || !l.filled) continue;
      const h = this.heightIn(l, lon, lat);
      if (!Number.isNaN(h)) return h;
    }
    // Coarsest-first fallback: a level that covers the point at lower
    // resolution beats one that has not been fetched, and during a cold start
    // the coarse levels land first.
    for (let i = this.levels.length - 1; i >= 0; i--) {
      const l = this.levels[i];
      if (!l.filled) continue;
      const h = this.heightIn(l, lon, lat);
      if (!Number.isNaN(h)) return h;
    }
    return 0;
  }

  /**
   * Ground elevation under the observer. Deliberately separate from any GPS
   * vertical fix: a phone's altitude is good to tens of metres at best, while
   * the DEM under a known lat/lon is good to a few, and the whole panorama
   * hinges on the eye being at the right height.
   */
  groundAt(lon: number, lat: number): number {
    return this.height(lon, lat, 0);
  }

  /**
   * Highest DEM sample within `radius` metres. Catalogue coordinates land
   * anywhere from the true summit to a few hundred metres down the ridge, and
   * a 30 m grid rounds the top off anyway; taking the local maximum puts a
   * label on the summit the renderer draws instead of on its flank.
   */
  summitNear(lon: number, lat: number, radius = 120): number {
    const l = this.levels.find((lv) => lv.filled && !Number.isNaN(this.heightIn(lv, lon, lat)));
    if (!l) return 0;
    const { u, v } = this.project(l, lon, lat);
    const n = Math.max(1, Math.round(radius / l.res));
    let best = -Infinity;
    for (let dy = -n; dy <= n; dy++) {
      const y = Math.round(v - 0.5) + dy;
      if (y < 0 || y >= l.h) continue;
      for (let dx = -n; dx <= n; dx++) {
        const x = Math.round(u - 0.5) + dx;
        if (x < 0 || x >= l.w) continue;
        const h = l.raw[y * l.w + x] * l.quant + l.bias;
        if (h > best) best = h;
      }
    }
    return best === -Infinity ? this.height(lon, lat) : best;
  }
}

/**
 * A baked demo region dressed up as a tile source.
 *
 * The preview pages cannot reach the network, so this lets the identical
 * clipmap streamer run against data already in the bundle. Same interface, same
 * windowing, same re-centring — only where the bytes come from differs, which
 * is exactly the seam the app is built around.
 */

import { HeightField, Level } from '../core/heightfield';
import { TILE, TileKey, TileSource } from './types';

export class BakedTileSource implements TileSource {
  readonly name = 'bundled demo region';
  readonly minZoom: number;
  readonly maxZoom: number;

  private byZoom = new Map<number, Level>();
  /** Counts so the UI can show what the streamer asked for. */
  stats = { served: 0, missing: 0, clamped: 0 };

  constructor(field: HeightField) {
    let lo = Infinity, hi = -Infinity;
    for (const lv of field.levels) {
      this.byZoom.set(lv.z, lv);
      lo = Math.min(lo, lv.z);
      hi = Math.max(hi, lv.z);
    }
    this.minZoom = lo;
    this.maxZoom = hi;
  }

  async has(key: TileKey): Promise<boolean> {
    return this.byZoom.has(key.z);
  }

  async load(key: TileKey): Promise<Float32Array | null> {
    const lv = this.byZoom.get(key.z);
    if (!lv) { this.stats.missing++; return null; }
    const ox = key.x * TILE, oy = key.y * TILE;
    if (ox + TILE <= lv.px0 || ox >= lv.px0 + lv.w
      || oy + TILE <= lv.py0 || oy >= lv.py0 + lv.h) {
      this.stats.missing++;
      return null;
    }
    const out = new Float32Array(TILE * TILE);
    let clamped = false;
    for (let y = 0; y < TILE; y++) {
      // Outside the baked crop the edge value is repeated rather than left at
      // zero: a hole in the heightfield reads as a cliff down to sea level.
      let sy = oy + y - lv.py0;
      if (sy < 0) { sy = 0; clamped = true; } else if (sy >= lv.h) { sy = lv.h - 1; clamped = true; }
      for (let x = 0; x < TILE; x++) {
        let sx = ox + x - lv.px0;
        if (sx < 0) { sx = 0; clamped = true; } else if (sx >= lv.w) { sx = lv.w - 1; clamped = true; }
        out[y * TILE + x] = lv.raw[sy * lv.w + sx] * lv.quant + lv.bias;
      }
    }
    this.stats.served++;
    if (clamped) this.stats.clamped++;
    return out;
  }
}

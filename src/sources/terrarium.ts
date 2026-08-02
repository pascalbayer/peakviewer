/**
 * AWS Terrain Tiles, "terrarium" encoding.
 *
 * height = R*256 + G + B/256 - 32768, which gives 1/256 m resolution over the
 * whole plausible range in three bytes. Public dataset, no key, global coverage
 * from SRTM / NASADEM / 3DEP and friends — the same class of data the
 * commercial peak finders build on.
 *
 * Every tile that arrives is written to the local store, so ordinary use warms
 * the cache that offline mode later relies on.
 */

import { DecodedCache, TileStore } from './tilestore';
import { TILE, TileKey, TileSource, tileId } from './types';

export const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

export function decodeTerrarium(px: Uint8ClampedArray): Float32Array {
  const out = new Float32Array(TILE * TILE);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = px[p] * 256 + px[p + 1] + px[p + 2] / 256 - 32768;
  }
  return out;
}

async function bytesToHeights(bytes: ArrayBuffer): Promise<Float32Array | null> {
  const blob = new Blob([bytes], { type: 'image/png' });
  try {
    const bmp = await createImageBitmap(blob);
    const cv = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = cv.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    return decodeTerrarium(ctx.getImageData(0, 0, TILE, TILE).data);
  } catch {
    return null;
  }
}

export interface TerrariumOptions {
  url?: string;
  store?: TileStore;
  /** How many requests may be in flight at once. */
  concurrency?: number;
}

export class TerrariumSource implements TileSource {
  readonly name = 'AWS Terrain Tiles';
  readonly minZoom = 0;
  readonly maxZoom = 14;

  readonly store: TileStore;
  readonly decoded = new DecodedCache();
  private url: string;
  private inflight = new Map<string, Promise<Float32Array | null>>();
  private queue: (() => void)[] = [];
  private active = 0;
  private concurrency: number;

  /** Counters the UI reports. */
  stats = { fromMemory: 0, fromStore: 0, fromNetwork: 0, failed: 0, bytes: 0 };

  constructor(opt: TerrariumOptions = {}) {
    this.url = opt.url ?? TERRARIUM_URL;
    this.store = opt.store ?? new TileStore();
    this.concurrency = opt.concurrency ?? 6;
  }

  private slot<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((res, rej) => {
      const run = () => {
        this.active++;
        fn().then(res, rej).finally(() => {
          this.active--;
          this.queue.shift()?.();
        });
      };
      if (this.active < this.concurrency) run();
      else this.queue.push(run);
    });
  }

  async has(key: TileKey): Promise<boolean> {
    const id = tileId(key);
    return this.decoded.get(id) !== undefined || this.store.has(id);
  }

  load(key: TileKey, signal?: AbortSignal): Promise<Float32Array | null> {
    const id = tileId(key);
    const hot = this.decoded.get(id);
    if (hot) { this.stats.fromMemory++; return Promise.resolve(hot); }
    const pending = this.inflight.get(id);
    if (pending) return pending;

    const job = (async () => {
      const cached = await this.store.get(id);
      if (cached) {
        const h = await bytesToHeights(cached);
        if (h) { this.stats.fromStore++; this.decoded.set(id, h); return h; }
      }
      return this.slot(async () => {
        try {
          const res = await fetch(this.url
            .replace('{z}', String(key.z))
            .replace('{x}', String(key.x))
            .replace('{y}', String(key.y)), { signal, mode: 'cors' });
          if (!res.ok) { this.stats.failed++; return null; }
          const bytes = await res.arrayBuffer();
          const h = await bytesToHeights(bytes);
          if (!h) { this.stats.failed++; return null; }
          this.stats.fromNetwork++;
          this.stats.bytes += bytes.byteLength;
          this.decoded.set(id, h);
          void this.store.put(id, bytes);
          return h;
        } catch {
          this.stats.failed++;
          return null;
        }
      });
    })().finally(() => this.inflight.delete(id));

    this.inflight.set(id, job);
    return job;
  }

  /** Downloads a tile without decoding it — used by the offline downloader. */
  async prefetch(key: TileKey, signal?: AbortSignal): Promise<number> {
    const id = tileId(key);
    if (await this.store.has(id)) return 0;
    return this.slot(async () => {
      try {
        const res = await fetch(this.url
          .replace('{z}', String(key.z))
          .replace('{x}', String(key.x))
          .replace('{y}', String(key.y)), { signal, mode: 'cors' });
        if (!res.ok) { this.stats.failed++; return 0; }
        const bytes = await res.arrayBuffer();
        this.stats.fromNetwork++;
        this.stats.bytes += bytes.byteLength;
        await this.store.put(id, bytes);
        return bytes.byteLength;
      } catch {
        this.stats.failed++;
        return 0;
      }
    });
  }
}

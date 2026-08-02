/** Anything that can hand back a 256x256 patch of elevation. */

export const TILE = 256;

export interface TileKey {
  z: number;
  x: number;
  y: number;
}

export interface TileSource {
  readonly name: string;
  readonly minZoom: number;
  readonly maxZoom: number;
  /** Heights in metres, row-major, TILE*TILE entries. Null if not available. */
  load(key: TileKey, signal?: AbortSignal): Promise<Float32Array | null>;
  /** True when the tile is already local — used to decide what to preload. */
  has?(key: TileKey): Promise<boolean>;
}

export function tileId(k: TileKey): string {
  return `${k.z}/${k.x}/${k.y}`;
}

/** Wraps x around the date line and rejects y outside the projection. */
export function normaliseTile(k: TileKey): TileKey | null {
  const n = 1 << k.z;
  if (k.y < 0 || k.y >= n) return null;
  return { z: k.z, x: ((k.x % n) + n) % n, y: k.y };
}

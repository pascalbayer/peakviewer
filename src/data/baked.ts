/**
 * Loader for a pre-baked demo region.
 *
 * Heights arrive as two 8-bit PNG planes (high byte / low byte) because a
 * browser hands back 8 bits per channel from <canvas> no matter what bit depth
 * the file declared — a 16-bit grayscale PNG would silently lose its low byte
 * on the way through getImageData.
 */

import { HeightField, LevelSpec } from '../core/heightfield';

export interface BakedLevel extends LevelSpec {
  res: number;
  halfKm: number;
  /** data: URIs for the two byte planes. */
  hi: string;
  lo: string;
}

export interface Viewpoint {
  id: string;
  name: string;
  lon: number;
  lat: number;
  /** Metres above ground. */
  eye: number;
  /** Suggested initial bearing. */
  yaw?: number;
  note?: string;
}

export interface BakedRegion {
  name: string;
  origin: { lon: number; lat: number };
  levels: BakedLevel[];
  viewpoints: Viewpoint[];
}

async function planeBytes(src: string): Promise<{ data: Uint8ClampedArray; w: number; h: number }> {
  const img = new Image();
  img.decoding = 'async';
  img.src = src;
  await img.decode();
  const w = img.naturalWidth, h = img.naturalHeight;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  return { data: ctx.getImageData(0, 0, w, h).data, w, h };
}

export async function loadBakedRegion(
  region: BakedRegion,
  onProgress?: (done: number, total: number) => void,
): Promise<HeightField> {
  const hf = new HeightField(region.origin.lon, region.origin.lat);
  let done = 0;
  for (const lv of region.levels) {
    const [hi, lo] = await Promise.all([planeBytes(lv.hi), planeBytes(lv.lo)]);
    if (hi.w !== lv.w || hi.h !== lv.h) {
      throw new Error(`level plane size ${hi.w}x${hi.h} does not match spec ${lv.w}x${lv.h}`);
    }
    const raw = new Uint16Array(lv.w * lv.h);
    for (let i = 0, p = 0; i < raw.length; i++, p += 4) {
      raw[i] = (hi.data[p] << 8) | lo.data[p];
    }
    hf.addLevel({
      z: lv.z, px0: lv.px0, py0: lv.py0, w: lv.w, h: lv.h,
      quant: lv.quant, bias: lv.bias,
    }, raw);
    onProgress?.(++done, region.levels.length);
  }
  return hf;
}

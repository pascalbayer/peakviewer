/**
 * In-page half of the GPU check. Bundled by tools/check_gpu.mjs and run in a
 * browser with a real WebGPU device.
 *
 * The static checks prove the WGSL parses and that every uniform is wired. They
 * cannot prove the pipeline links, that the passes are ordered correctly, or
 * that anything reaches the screen — which is exactly the class of defect that
 * shows up as a blank app. This renders a synthetic ridge through the real
 * renderer and reads the pixels back.
 *
 * Readback rather than a screenshot on purpose: a WebGPU canvas is composited
 * by the browser, and a headless software adapter may present nothing while
 * rendering perfectly. Pixels pulled out of a render target come from the same
 * device that drew them, so they cannot lie about it.
 */

import { Backend, GpuRenderer, Quality } from '../src/render/gpu/renderer';
import { HeightField } from '../src/core/heightfield';

/** Small enough that a software adapter survives it. */
const PROBE_QUALITY: Quality = { azimuths: 256, rows: 96, sectors: 8 };

const LON = 7.7845;
const LAT = 45.9835;
const GROUND = 1500;
const WALL = 2200;
const EYE = GROUND + 10;

/**
 * Where the top of the ridge should land, as a fraction of image height from
 * the top. The level is ~26.6 m per post at this latitude, so the near face of
 * the band sits 80 posts ≈ 2.13 km out and 690 m above the eye — 18.0° up. The
 * frame spans pitch ± fov/2, so 6 ± 25 gives −19°..31°, and 18° falls at
 * (31 − 18) / 50 of the way down.
 *
 * The point of pinning it is orientation. A renderer that samples the range
 * buffer upside down still produces a plausible-looking outline, just mirrored,
 * and against a uniform white background nothing else would give it away.
 */
const EXPECT_SKYLINE = 0.26;

/**
 * One clipmap level holding a ridge due north and flat ground everywhere else.
 * A horizon that is a step function makes the assertions unambiguous: sky
 * above, terrain below, one edge between them.
 */
function syntheticField(): HeightField {
  const hf = new HeightField(LON, LAT);
  const z = 12;
  const w = 256;
  const h = 256;
  const n = 256 * (1 << z);
  const px = ((LON + 180) / 360) * n;
  const s = Math.sin((LAT * Math.PI) / 180);
  const py = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  const raw = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Mercator y grows southward, so rows above centre are north of us. The
      // band has to stay inside the level's usable radius (~126 posts) and far
      // enough out that it does not fill the whole frame.
      const north = h / 2 - y;
      raw[y * w + x] = north > 80 && north < 110 ? WALL : GROUND;
    }
  }
  hf.addLevel({
    z, px0: Math.round(px - w / 2), py0: Math.round(py - h / 2),
    w, h, quant: 1, bias: 0,
  }, raw);
  return hf;
}

export interface ProbeResult {
  ok: boolean;
  notes: string[];
  diagnostics: unknown;
  /** Fraction of composite pixels that are near-white (the unpainted sky). */
  white: number;
  /** Fraction that are near-black (the outline). */
  ink: number;
  /** Fraction of the range buffer flagged as terrain rather than sky. */
  terrain: number;
  /** Row of the topmost outline pixel, as a fraction of image height. */
  edgeRow: number;
  /** The composite, as a PNG data URL, so a human can look at it. */
  image: string | null;
}

export async function runProbe(canvas: HTMLCanvasElement,
  backend: Backend = 'webgpu'): Promise<ProbeResult> {
  const notes: string[] = [];
  const renderer = await GpuRenderer.create(canvas, PROBE_QUALITY, backend);
  renderer.setHeightField(syntheticField());
  renderer.moveTo(LON, LAT, EYE);
  renderer.camera.set({ yaw: 0, pitch: 6, fov: 50 });

  // Warm-up. A software adapter routinely drops the device once on the first
  // real scene render and Babylon restores it; anything read back before that
  // settles describes a dead device rather than the renderer. Frames are cheap,
  // so spend a few dozen and let it happen.
  for (let i = 0; i < 40; i++) {
    renderer.render();
    await new Promise((r) => requestAnimationFrame(r));
  }

  const d = renderer.diagnostics;
  if (!d.terrainReady) notes.push('terrain pipeline never became ready');
  if (!d.compositeReady) notes.push('composite pipeline never became ready');
  if (!d.framesDrawn) notes.push('no frames were drawn');

  /** Retries once through a device loss, which costs a frame to recover from. */
  async function settled<T>(what: string, fn: () => Promise<T | null>): Promise<T | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const v = await fn();
        if (v) return v;
      } catch (e) {
        notes.push(`${what} attempt ${attempt + 1}: ${e instanceof Error ? e.message : String(e)}`);
      }
      for (let i = 0; i < 10; i++) {
        renderer.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    }
    return null;
  }

  // --- the range buffer: did the terrain pass write anything? ---------------
  let terrain = 0;
  const range = await settled('range readback', () => renderer.readRange());
  if (!range) {
    notes.push('could not read the range buffer back');
  } else {
    let hit = 0;
    for (let i = 3; i < range.pixels.length; i += 4) if (range.pixels[i] > 127) hit++;
    terrain = hit / (range.pixels.length / 4);
    if (terrain < 0.02) notes.push(`terrain pass wrote almost nothing (${(terrain * 100).toFixed(1)}% of the buffer)`);
    if (terrain > 0.98) notes.push('terrain pass covered the whole buffer — no sky, so no skyline');
  }

  // --- the composite: is anything on screen? --------------------------------
  const shot = await settled('composite readback', () => renderer.capture());
  let white = 0;
  let ink = 0;
  let edgeRow = 1;
  let image: string | null = null;
  if (!shot) {
    notes.push('capture returned nothing');
  } else {
    const { width, height, pixels } = shot;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = (y * width + x) * 4;
        const lum = (pixels[p] + pixels[p + 1] + pixels[p + 2]) / 3;
        if (lum > 235) white++;
        else if (lum < 90) { ink++; if (y / height < edgeRow) edgeRow = y / height; }
      }
    }
    const total = width * height;
    white /= total;
    ink /= total;
    // With no camera attached the shader paints plain white, so anything that
    // is neither white nor outline means the composite pass is misbehaving.
    if (white < 0.4) notes.push(`only ${(white * 100).toFixed(1)}% of the image is white — the composite pass is not painting the background`);
    if (ink < 0.0005) notes.push('no outline pixels — the edge detector found no skyline');
    if (ink > 0.5) notes.push(`${(ink * 100).toFixed(1)}% of the image is dark — the outline has flooded the frame`);
    if (ink > 0.0005 && Math.abs(edgeRow - EXPECT_SKYLINE) > 0.12) {
      notes.push(`the skyline is at ${(edgeRow * 100).toFixed(0)}% of image height, `
        + `expected ${(EXPECT_SKYLINE * 100).toFixed(0)}% — `
        + `${edgeRow > 0.5 ? 'that is roughly the mirror image, so something is sampled upside down' : 'the geometry is off'}`);
    }
    image = toPng(shot);
  }

  renderer.dispose();
  return {
    ok: notes.length === 0, notes, diagnostics: JSON.parse(JSON.stringify(d)),
    white, ink, terrain, edgeRow, image,
  };
}

/** The captured frame as a data URL, so a failure can be looked at. */
function toPng(shot: { width: number; height: number; pixels: Uint8Array }): string | null {
  try {
    const cv = document.createElement('canvas');
    cv.width = shot.width;
    cv.height = shot.height;
    const ctx = cv.getContext('2d');
    if (!ctx) return null;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(shot.pixels), shot.width, shot.height), 0, 0);
    return cv.toDataURL('image/png');
  } catch {
    return null;
  }
}

(globalThis as unknown as Record<string, unknown>).runProbe = runProbe;

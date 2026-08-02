/**
 * Taking a picture of what you are looking at.
 *
 * The composite is re-rendered into an offscreen buffer rather than scraped off
 * the visible canvas: a WebGPU swap-chain texture is not reliably readable
 * after presentation, and re-rendering also lets the capture carry the labels,
 * which live on a separate 2D overlay.
 *
 * Saving goes through the Web Share API, because that is the only route a web
 * page has into the Photos app — on iOS the share sheet offers "Save Image",
 * on Android "Save to Photos". Where sharing files is not supported the file is
 * downloaded instead, which lands in Files or Downloads.
 */

import type { CaptureResult } from '../render/gpu/renderer';

export type SaveOutcome = 'shared' | 'downloaded' | 'cancelled' | 'failed';

/** GPU composite plus the label overlay, as one PNG. */
export async function composeCapture(
  gpu: CaptureResult,
  overlay: HTMLCanvasElement | null,
  stamp?: string,
): Promise<Blob | null> {
  const cv = document.createElement('canvas');
  cv.width = gpu.width;
  cv.height = gpu.height;
  const ctx = cv.getContext('2d');
  if (!ctx) return null;

  const clamped = new Uint8ClampedArray(gpu.width * gpu.height * 4);
  clamped.set(gpu.pixels);
  ctx.putImageData(new ImageData(clamped, gpu.width, gpu.height), 0, 0);

  if (overlay && overlay.width > 0) {
    ctx.drawImage(overlay, 0, 0, gpu.width, gpu.height);
  }

  if (stamp) {
    const pad = Math.round(gpu.width * 0.022);
    ctx.font = `500 ${Math.round(gpu.width * 0.022)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(255,255,255,.75)';
    ctx.fillRect(0, gpu.height - pad * 2.1, gpu.width, pad * 2.1);
    ctx.fillStyle = 'rgba(16,22,30,.85)';
    ctx.fillText(stamp, pad, gpu.height - pad * 0.5);
  }

  return new Promise((res) => cv.toBlob((b) => res(b), 'image/png'));
}

export async function saveImage(blob: Blob, filename: string): Promise<SaveOutcome> {
  const file = new File([blob], filename, { type: 'image/png' });
  const nav = navigator as Navigator & {
    canShare?: (d: ShareData) => boolean;
    share?: (d: ShareData) => Promise<void>;
  };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: filename });
      return 'shared';
    } catch (e) {
      // A dismissed share sheet rejects with AbortError; that is not a failure.
      if (e instanceof Error && e.name === 'AbortError') return 'cancelled';
    }
  }
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return 'downloaded';
  } catch {
    return 'failed';
  }
}

export function captureFilename(lon: number, lat: number, bearing: number): string {
  const t = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `peak-${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}`
    + `-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}`
    + `-${lat.toFixed(4)}_${lon.toFixed(4)}-${Math.round(bearing)}deg.png`;
}

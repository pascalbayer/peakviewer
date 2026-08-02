/**
 * Plan view of the clipmap: nested level windows around the observer.
 *
 * Makes the streaming legible — you can see which level covers what, watch the
 * windows jump when a fix moves far enough to force a refill, and click to move
 * the observer somewhere else.
 */

import { mercResolution } from '../core/geodesy';
import type { HeightField } from '../core/heightfield';

export class ClipmapMap {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  /** Half-width of the plan view, metres. */
  span = 300000;

  constructor(private onPick?: (east: number, north: number) => void) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'planview';
    this.ctx = this.canvas.getContext('2d')!;
    this.canvas.addEventListener('click', (e) => {
      const r = this.canvas.getBoundingClientRect();
      const s = Math.min(r.width, r.height);
      const east = ((e.clientX - r.left - r.width / 2) / (s / 2)) * this.span;
      const north = -((e.clientY - r.top - r.height / 2) / (s / 2)) * this.span;
      this.onPick?.(east, north);
    });
  }

  draw(hf: HeightField, progress?: { done: number; total: number }) {
    const dpr = Math.min(devicePixelRatio || 1, 2.5);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    if (this.canvas.width !== Math.round(w * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    const c = this.ctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    const scale = Math.min(w, h) / 2 / this.span;

    c.fillStyle = 'rgba(6,10,16,.55)';
    c.fillRect(0, 0, w, h);

    // Distance rings every 50 km.
    c.strokeStyle = 'rgba(255,255,255,.10)';
    c.lineWidth = 1;
    c.font = '9px ui-monospace, Menlo, monospace';
    c.fillStyle = 'rgba(255,255,255,.35)';
    for (let km = 50; km <= this.span / 1000; km += 50) {
      const r = km * 1000 * scale;
      c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.stroke();
      if (km % 100 === 0) c.fillText(`${km}`, cx + r - 12, cy - 3);
    }

    const hues = ['#ffd166', '#8ad6ff', '#a6e3a1', '#f5a3c7', '#c3b1ff', '#ffb37a'];
    [...hf.levels].reverse().forEach((lv, ri) => {
      const i = hf.levels.length - 1 - ri;
      const res = mercResolution(hf.lat, lv.z);
      const half = (lv.w / 2) * res;
      // Where the window sits relative to the observer, in metres.
      const offE = (lv.w / 2 - lv.cx) * res;
      const offN = (lv.h / 2 - lv.cy) * res;
      const x = cx + (-offE - half) * scale;
      const y = cy - (-offN + half) * scale;
      c.strokeStyle = hues[i % hues.length];
      c.globalAlpha = 0.85;
      c.lineWidth = 1.25;
      c.strokeRect(x, y, half * 2 * scale, half * 2 * scale);
      c.globalAlpha = 1;
      c.fillStyle = hues[i % hues.length];
      c.font = '600 9px ui-monospace, Menlo, monospace';
      c.fillText(`z${lv.z} ${res < 100 ? res.toFixed(0) : Math.round(res)}m`, x + 3, y + 10);
    });

    // Observer.
    c.fillStyle = '#fff';
    c.beginPath(); c.arc(cx, cy, 3, 0, Math.PI * 2); c.fill();

    if (progress && progress.total && progress.done < progress.total) {
      c.fillStyle = 'rgba(255,209,102,.9)';
      c.fillRect(0, h - 3, (progress.done / progress.total) * w, 3);
    }
  }
}

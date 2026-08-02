/**
 * The viewer: terrain, labels and selection in one object.
 *
 * Everything above this — the installed app and the published preview —
 * differs only in where the elevation data and the summit catalogue come from.
 */

import { Camera } from '../core/camera';
import { HeightField } from '../core/heightfield';
import { computeVisibility } from '../core/horizon';
import {
  LabelTarget, PlacedLabel, buildTargets, layoutLabels, pickLabel,
} from '../core/labels';
import { Peak } from '../core/peaks';
import { LabelPainter, ON_WHITE } from '../ui/labelPainter';
import { Backend, GpuRenderer, Quality } from '../render/gpu/renderer';

export interface ViewerOptions {
  canvas: HTMLCanvasElement;
  overlay: HTMLCanvasElement;
  /** Graphics API. WebGL2 is the debugging path; WebGPU is the target. */
  backend?: Backend;
}

export class PeakViewer {
  readonly painter: LabelPainter;

  peaks: Peak[] = [];
  targets: LabelTarget[] = [];
  placed: PlacedLabel[] = [];
  selected: PlacedLabel | null = null;

  showLabels = true;
  maxLabels = 22;
  detailedLabels = 6;
  /** Summits beyond this are not labelled at all, metres. */
  labelRange = 260000;
  /** Set from GPS when available, otherwise sampled from the DEM. */
  eyeAltitude = 0;
  /** Where the current eye altitude came from. */
  altitudeSource: 'gps' | 'dem' = 'dem';
  visibleCount = 0;
  lastVisibilityMs = 0;

  private constructor(readonly renderer: GpuRenderer, overlay: HTMLCanvasElement) {
    this.painter = new LabelPainter(overlay);
    this.painter.style = ON_WHITE;
  }

  static async create(opt: ViewerOptions, quality?: Quality): Promise<PeakViewer> {
    const renderer = await GpuRenderer.create(opt.canvas, quality, opt.backend);
    return new PeakViewer(renderer, opt.overlay);
  }

  get camera(): Camera { return this.renderer.camera; }
  get heightField(): HeightField | null { return this.renderer.heightField; }

  setHeightField(hf: HeightField) {
    this.renderer.setHeightField(hf);
    this.rebuildTargets();
  }

  refreshHeights() {
    if (this.renderer.heightField) this.renderer.setHeightField(this.renderer.heightField);
  }

  setPeaks(peaks: Peak[]) {
    this.peaks = peaks;
    this.rebuildTargets();
  }

  /**
   * Moves the eye. `eyeAlt` is absolute: GPS altitude plus eye height when the
   * device reports one, the DEM's ground plus eye height when it does not.
   */
  moveTo(lon: number, lat: number, eyeAlt: number, source: 'gps' | 'dem') {
    this.eyeAltitude = eyeAlt;
    this.altitudeSource = source;
    this.renderer.moveTo(lon, lat, eyeAlt);
    this.rebuildTargets();
  }

  get groundBelow(): number {
    const hf = this.renderer.heightField;
    return hf ? hf.groundAt(hf.lon, hf.lat) : 0;
  }

  /** Recomputes summit geometry and which of them the terrain hides. */
  rebuildTargets() {
    const hf = this.renderer.heightField;
    if (!hf || !this.peaks.length) { this.targets = []; this.visibleCount = 0; return; }
    const range = Math.min(this.labelRange, hf.maxRange);
    const obs = { lon: hf.lon, lat: hf.lat, ground: this.eyeAltitude, eye: 0 };
    this.targets = buildTargets(this.peaks, obs, hf, range);
    const t0 = performance.now();
    this.visibleCount = computeVisibility(this.targets, hf, this.eyeAltitude);
    this.lastVisibilityMs = performance.now() - t0;
    this.selected = null;
  }

  render() {
    this.renderer.render();
    const overlay = this.painter.canvas;
    const cssW = overlay.clientWidth || 1;
    const cssH = overlay.clientHeight || 1;
    this.painter.resize(cssW, cssH);

    if (!this.showLabels || !this.targets.length) { this.placed = []; return; }

    this.placed = layoutLabels(this.targets, this.camera, {
      width: cssW,
      height: cssH,
      measure: this.painter.measure,
      lineHeight: this.painter.style.nameSize + 3,
      maxLabels: this.maxLabels,
      detailed: this.detailedLabels,
      gap: 5,
    });

    if (this.selected) {
      const id = this.selected.target.peak.id;
      this.selected = this.placed.find((p) => p.target.peak.id === id) ?? this.selected;
    }
    this.painter.draw(this.placed, this.selected);
  }

  pick(x: number, y: number): PlacedLabel | null {
    const hit = pickLabel(this.placed, x, y);
    this.selected = hit;
    return hit;
  }

  dispose() { this.renderer.dispose(); }
}

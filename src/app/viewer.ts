/**
 * The viewer: terrain, labels and selection in one object.
 *
 * Everything above this — the preview pages and the installed app — differs
 * only in where the elevation data and the summit catalogue come from and in
 * what drives the camera.
 */

import { Camera } from '../core/camera';
import { HeightField } from '../core/heightfield';
import {
  LabelTarget, PlacedLabel, buildTargets, layoutLabels, pickLabel,
} from '../core/labels';
import { Peak } from '../core/peaks';
import { LabelPainter } from '../ui/labelPainter';
import { VisibilityProbe } from '../render/probe';
import { Scene } from '../render/scene';
import type { Style } from '../render/compose';

export interface ViewerOptions {
  canvas: HTMLCanvasElement;
  overlay: HTMLCanvasElement;
}

export class PeakViewer {
  readonly scene: Scene;
  readonly painter: LabelPainter;
  private probe: VisibilityProbe;


  peaks: Peak[] = [];
  targets: LabelTarget[] = [];
  placed: PlacedLabel[] = [];
  selected: PlacedLabel | null = null;

  showLabels = true;
  maxLabels = 26;
  detailedLabels = 8;
  /** Summits beyond this are not labelled at all, metres. */
  labelRange = 260000;

  /** Slack on the occlusion test. Set very large to label everything. */
  set occlusionTolerance(v: number) { this.probe.tolerance = v; }
  get occlusionTolerance(): number { return this.probe.tolerance; }

  constructor(opt: ViewerOptions) {
    this.scene = new Scene(opt.canvas);
    this.painter = new LabelPainter(opt.overlay);
    this.probe = new VisibilityProbe(this.scene.gl);
  }

  get camera(): Camera { return this.scene.camera; }
  get heightField(): HeightField | null { return this.scene.heightField; }
  set style(s: Style) { this.scene.style = s; }
  get style(): Style { return this.scene.style; }

  setHeightField(hf: HeightField) {
    this.scene.setHeightField(hf);
    this.rebuildTargets();
  }

  setPeaks(peaks: Peak[]) {
    this.peaks = peaks;
    this.rebuildTargets();
  }

  moveTo(lon: number, lat: number, eye?: number) {
    this.scene.moveTo(lon, lat, eye);
    this.rebuildTargets();
  }

  /** Recomputes summit geometry. Cheap enough to run whenever the eye moves. */
  rebuildTargets() {
    const hf = this.scene.heightField;
    if (!hf || !this.peaks.length) { this.targets = []; return; }
    const range = Math.min(this.labelRange, hf.maxRange);
    this.targets = buildTargets(this.peaks, this.scene.observer, hf, range);
    this.probe.setTargets(this.targets);
    this.selected = null;
  }

  render() {
    this.scene.render();
    const overlay = this.painter.canvas;
    const cssW = overlay.clientWidth || 1;
    const cssH = overlay.clientHeight || 1;
    this.painter.resize(cssW, cssH);

    if (!this.showLabels || !this.targets.length) {
      this.placed = [];
      return;
    }

    this.probe.run(this.targets, this.scene.camera,
      this.scene.rangeTexture, this.scene.stats.width, this.scene.stats.height);

    this.placed = layoutLabels(this.targets, this.scene.camera, {
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

  /** Returns the newly selected label, or null when the tap hit nothing. */
  pick(x: number, y: number): PlacedLabel | null {
    const hit = pickLabel(this.placed, x, y);
    this.selected = hit;
    return hit;
  }

  get visibleCount(): number {
    let n = 0;
    for (const t of this.targets) if (t.visible) n++;
    return n;
  }
}

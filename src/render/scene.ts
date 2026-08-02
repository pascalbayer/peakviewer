/** Ties the passes together and owns the canvas / GL state. */

import { Camera } from '../core/camera';
import { HeightField, Observer } from '../core/heightfield';
import { ComposePass, Style } from './compose';
import { GBuffer, GL, createContext } from './gl';
import { QUALITY_HIGH, QUALITY_LOW, TerrainPass, TerrainQuality } from './terrain';

export interface RenderStats {
  frameMs: number;
  columns: number;
  width: number;
  height: number;
}

export class Scene {
  readonly gl: GL;
  readonly camera = new Camera();
  readonly terrain: TerrainPass;
  readonly compose: ComposePass;
  private gbuf: GBuffer;

  heightField: HeightField | null = null;
  observer: Observer = { lon: 0, lat: 0, ground: 0, eye: 1.7 };

  /** Render scale relative to CSS pixels; trimmed automatically when slow. */
  renderScale = 1;
  maxPixels = 2.6e6;
  stats: RenderStats = { frameMs: 0, columns: 0, width: 0, height: 0 };

  private frameTimes: number[] = [];

  constructor(readonly canvas: HTMLCanvasElement) {
    this.gl = createContext(canvas);
    this.terrain = new TerrainPass(this.gl);
    this.compose = new ComposePass(this.gl);
    this.gbuf = new GBuffer(this.gl);
    const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    this.terrain.quality = mobile ? QUALITY_LOW : QUALITY_HIGH;
  }

  set quality(q: TerrainQuality) { this.terrain.quality = q; }
  get quality(): TerrainQuality { return this.terrain.quality; }
  set style(s: Style) { this.compose.style = s; }
  get style(): Style { return this.compose.style; }

  setHeightField(hf: HeightField) {
    this.heightField = hf;
    this.terrain.upload(hf);
    this.syncObserver();
  }

  /**
   * Moves the observer. Altitude always comes from the DEM plus an eye height —
   * never from a GPS vertical fix, which is routinely tens of metres out and
   * would tilt the whole horizon.
   */
  moveTo(lon: number, lat: number, eye = this.observer.eye) {
    const hf = this.heightField;
    if (!hf) return;
    if (lon !== hf.lon || lat !== hf.lat) hf.setOrigin(lon, lat);
    this.observer = { lon, lat, ground: hf.groundAt(lon, lat), eye };
    this.syncObserver();
  }

  private syncObserver() {
    const hf = this.heightField;
    if (!hf) return;
    this.terrain.syncLevelUniforms(hf);
    this.terrain.eyeAlt = this.observer.ground + this.observer.eye;
    this.camera.far = Math.max(1000, hf.maxRange * 1.15);
  }

  get eyeAltitude(): number {
    return this.observer.ground + this.observer.eye;
  }

  resize(): { w: number; h: number } {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const cssW = this.canvas.clientWidth || 640;
    const cssH = this.canvas.clientHeight || 360;
    let scale = dpr * this.renderScale;
    const px = cssW * cssH * scale * scale;
    if (px > this.maxPixels) scale *= Math.sqrt(this.maxPixels / px);
    const w = Math.max(2, Math.round(cssW * scale));
    const h = Math.max(2, Math.round(cssH * scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gbuf.resize(w, h);
    this.camera.aspect = w / h;
    return { w, h };
  }

  render() {
    const gl = this.gl;
    const t0 = performance.now();
    const { w, h } = this.resize();
    this.camera.update();

    this.terrain.shade = this.compose.style === 'shaded';
    this.gbuf.bind();
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (this.heightField) this.terrain.draw(this.heightField, this.camera);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    this.compose.draw(this.gbuf.color, this.gbuf.range, w, h, this.camera);

    const dt = performance.now() - t0;
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 30) this.frameTimes.shift();
    this.stats = {
      frameMs: this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length,
      columns: this.terrain.lastDrawnColumns,
      width: w,
      height: h,
    };
  }

  /** CPU-side copy of the range buffer readback used by the label depth test. */
  readRange(x: number, y: number): { range: number; hit: boolean } {
    const gl = this.gl;
    const px = new Uint8Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.gbuf.fbo);
    gl.readBuffer(gl.COLOR_ATTACHMENT1);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const v = px[0] * 65536 + px[1] * 256 + px[2];
    const LOG_MIN = 2.0794415, LOG_SPAN = 10.8198;
    return { range: Math.exp(LOG_MIN + (v / 16777215) * LOG_SPAN), hit: px[3] > 127 };
  }

  get rangeTexture(): WebGLTexture { return this.gbuf.range; }
  get gbuffer(): GBuffer { return this.gbuf; }
}

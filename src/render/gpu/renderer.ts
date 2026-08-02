/**
 * The renderer: Babylon.js on WebGPU, core modules only.
 *
 * Two passes. The terrain pass draws a polar mesh into an offscreen buffer
 * holding nothing but the distance to each fragment. The composite pass runs an
 * edge detector over that buffer and lays the resulting black outline over the
 * camera image, washed towards white so the lines carry.
 *
 * Imports are individual modules rather than the barrel, so a build pulls in
 * the engine, one mesh, one material and one render target instead of the whole
 * of Babylon.
 */

// Must come first. Babylon's engine modules form an import cycle in which
// ThinWebGPUEngine is evaluated before AbstractEngine has finished defining
// itself; pulling the full engine module in ahead of them settles the order.
// Without it the bundle throws "Class extends value undefined" at load.
import '@babylonjs/core/Engines/engine';
import { Constants } from '@babylonjs/core/Engines/constants';
import { ShaderStore } from '@babylonjs/core/Engines/shaderStore';
import { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';
import '@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture';
import '@babylonjs/core/Engines/WebGPU/Extensions/engine.dynamicTexture';
import '@babylonjs/core/Engines/WebGPU/Extensions/engine.videoTexture';
import '@babylonjs/core/Engines/WebGPU/Extensions/engine.readTexture';
import '@babylonjs/core/Engines/WebGPU/Extensions/engine.renderTarget';
import '@babylonjs/core/Engines/WebGPU/Extensions/engine.renderTargetTexture';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { RenderTargetTexture } from '@babylonjs/core/Materials/Textures/renderTargetTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { VideoTexture } from '@babylonjs/core/Materials/Textures/videoTexture';
import { Color4 } from '@babylonjs/core/Maths/math.color';
import { Matrix, Vector2, Vector3, Vector4 } from '@babylonjs/core/Maths/math.vector';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { Scene } from '@babylonjs/core/scene';

import { Camera } from '../../core/camera';
import { DEG, REFRACTION_K, effectiveRadiusAt, localRadius } from '../../core/geodesy';
import { HeightField, Observer } from '../../core/heightfield';
import {
  COMPOSITE_FRAGMENT, COMPOSITE_UNIFORMS, COMPOSITE_VERTEX, HEIGHT_BIAS,
  TERRAIN_FRAGMENT, TERRAIN_UNIFORMS, TERRAIN_VERTEX,
} from './wgsl';

const MAX_LEVELS = 8;
const TERRAIN_MASK = 0x1;
const VIEW_MASK = 0x2;

export interface Quality {
  /** Rays around the full circle. 2048 gives ~0.18 deg of azimuth. */
  azimuths: number;
  /** Samples along each ray. */
  rows: number;
  /** Azimuth sectors; only those in front of the camera are drawn. */
  sectors: number;
}

export const QUALITY_HIGH: Quality = { azimuths: 2048, rows: 600, sectors: 32 };
export const QUALITY_LOW: Quality = { azimuths: 1024, rows: 420, sectors: 32 };

export interface RendererDiagnostics {
  webgpu: boolean;
  engine: string;
  adapter: string;
  shaderErrors: string[];
  levels: number;
  atlas: string;
  vertices: number;
  sectorsDrawn: number;
  frameMs: number;
  size: string;
}

export interface CaptureResult {
  width: number;
  height: number;
  /** RGBA, top-down. */
  pixels: Uint8Array;
}

/** True when this browser can run the app at all. */
export function webgpuAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

export class GpuRenderer {
  readonly camera = new Camera();
  quality: Quality = QUALITY_HIGH;

  /** How far the camera image is washed towards white, 0..1. */
  whiten = 0.62;
  desaturate = 0.55;
  edgeLow = 0.030;
  edgeHigh = 0.320;
  edgeWidth = 1.0;
  lineDark = 0.04;
  refractionK = REFRACTION_K;
  curvature = true;

  observer: Observer = { lon: 0, lat: 0, ground: 0, eye: 1.7 };
  heightField: HeightField | null = null;

  readonly diagnostics: RendererDiagnostics = {
    webgpu: false, engine: '', adapter: '', shaderErrors: [],
    levels: 0, atlas: '', vertices: 0, sectorsDrawn: 0, frameMs: 0, size: '',
  };

  private engine!: WebGPUEngine;
  private scene!: Scene;
  private viewCam!: FreeCamera;
  private terrainCam!: FreeCamera;
  private sectors: Mesh[] = [];
  private terrainMat!: ShaderMaterial;
  private compositeMat!: ShaderMaterial;
  private quad!: Mesh;
  private rangeRtt!: RenderTargetTexture;
  private atlas: RawTexture | null = null;
  private atlasData: Uint8Array | null = null;
  private atlasLevelPx = 0;
  private blank!: RawTexture;
  private video: VideoTexture | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private lvlA = new Float32Array(MAX_LEVELS * 4);
  private lvlB = new Float32Array(MAX_LEVELS * 4);
  private uploaded: number[] = [];
  private frameTimes: number[] = [];
  private disposed = false;

  private constructor(readonly canvas: HTMLCanvasElement) {}

  static async create(canvas: HTMLCanvasElement, quality?: Quality): Promise<GpuRenderer> {
    if (!webgpuAvailable()) {
      throw new Error('This browser has no WebGPU. The renderer needs it — try '
        + 'Chrome or Edge 121+, or Safari 26+ on iOS 26.');
    }
    const r = new GpuRenderer(canvas);
    if (quality) r.quality = quality;
    try {
      await r.init();
    } catch (e) {
      // A present navigator.gpu is not the same as a usable one: virtual
      // machines, remote desktops and browsers started without GPU access all
      // expose the API and then hand back no adapter. Say which it was.
      const why = e instanceof Error ? e.message : String(e);
      throw new Error(`WebGPU is present but would not start.\n\n${why}\n\n`
        + 'This usually means the device or browser has no usable GPU adapter — '
        + 'a virtual machine, a remote session, or hardware acceleration turned '
        + 'off in the browser settings.');
    }
    return r;
  }

  private async init() {
    ShaderStore.ShadersStoreWGSL.terrainVertexShader = TERRAIN_VERTEX;
    ShaderStore.ShadersStoreWGSL.terrainFragmentShader = TERRAIN_FRAGMENT;
    ShaderStore.ShadersStoreWGSL.compositeVertexShader = COMPOSITE_VERTEX;
    ShaderStore.ShadersStoreWGSL.compositeFragmentShader = COMPOSITE_FRAGMENT;

    this.engine = new WebGPUEngine(this.canvas, {
      antialias: false,          // edges come from the detector, not from MSAA
      stencil: false,
      adaptToDeviceRatio: true,
      powerPreference: 'high-performance',
    });
    await this.engine.initAsync();

    const d = this.diagnostics;
    d.webgpu = true;
    d.engine = `Babylon.js ${this.engine.description ?? 'WebGPU'}`;
    const adapter = (this.engine as unknown as { _adapterInfo?: Record<string, string> })._adapterInfo;
    d.adapter = adapter ? `${adapter.vendor ?? '?'} ${adapter.architecture ?? ''} ${adapter.description ?? ''}`.trim() : 'unreported';

    this.scene = new Scene(this.engine);
    this.scene.clearColor = new Color4(0, 0, 0, 1);
    this.scene.autoClear = true;
    this.scene.skipPointerMovePicking = true;
    this.scene.detachControl();

    this.viewCam = new FreeCamera('view', Vector3.Zero(), this.scene);
    this.viewCam.layerMask = VIEW_MASK;
    this.terrainCam = new FreeCamera('terrain', Vector3.Zero(), this.scene);
    this.terrainCam.layerMask = TERRAIN_MASK;
    this.scene.activeCamera = this.viewCam;

    this.blank = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1,
      this.scene, false, false, Texture.NEAREST_SAMPLINGMODE);

    this.buildTerrainMaterial();
    this.buildRangeTarget();
    this.buildComposite();
    this.buildSectors();

    // Babylon reports WGSL problems through the engine's observable; keep them
    // so the app can show the actual message instead of a black screen.
    this.engine.onContextLostObservable.add(() => {
      d.shaderErrors.push('WebGPU device lost');
    });
  }

  // ------------------------------------------------------------------ passes

  private buildTerrainMaterial() {
    this.terrainMat = new ShaderMaterial('terrain', this.scene,
      { vertex: 'terrain', fragment: 'terrain' }, {
        attributes: ['position'],
        uniforms: [...TERRAIN_UNIFORMS],
        samplers: ['heights'],
        shaderLanguage: ShaderLanguage.WGSL,
      });
    this.terrainMat.backFaceCulling = false;
    this.terrainMat.setTexture('heights', this.blank);
  }

  private buildRangeTarget() {
    this.rangeRtt = new RenderTargetTexture('range', { width: 2, height: 2 }, this.scene, {
      generateDepthBuffer: true,
      generateMipMaps: false,
      samplingMode: Texture.NEAREST_SAMPLINGMODE,
      type: Constants.TEXTURETYPE_UNSIGNED_BYTE,
      format: Constants.TEXTUREFORMAT_RGBA,
    });
    // Alpha zero marks sky; the edge detector reads that as "infinitely far",
    // which is what makes the outer skyline an edge like any other.
    this.rangeRtt.clearColor = new Color4(0, 0, 0, 0);
    this.rangeRtt.activeCamera = this.terrainCam;
    this.rangeRtt.renderList = [];
    this.scene.customRenderTargets.push(this.rangeRtt);
  }

  private buildComposite() {
    this.compositeMat = new ShaderMaterial('composite', this.scene,
      { vertex: 'composite', fragment: 'composite' }, {
        attributes: ['position'],
        uniforms: [...COMPOSITE_UNIFORMS],
        samplers: ['rangeTex', 'videoTex'],
        shaderLanguage: ShaderLanguage.WGSL,
      });
    this.compositeMat.backFaceCulling = false;
    this.compositeMat.disableDepthWrite = true;
    this.compositeMat.setTexture('rangeTex', this.rangeRtt);
    this.compositeMat.setTexture('videoTex', this.blank);

    this.quad = new Mesh('composite', this.scene);
    const vd = new VertexData();
    vd.positions = [-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0];
    vd.indices = [0, 1, 2, 2, 1, 3];
    vd.applyToMesh(this.quad);
    this.quad.material = this.compositeMat;
    this.quad.layerMask = VIEW_MASK;
    this.quad.alwaysSelectAsActiveMesh = true;
    this.quad.isPickable = false;
    this.quad.infiniteDistance = true;
  }

  /**
   * The polar mesh, split into azimuth sectors so only the wedge in front of
   * the camera is submitted — about a sixth of the panorama at a typical field
   * of view, and the difference between a warm phone and a hot one.
   */
  private buildSectors() {
    for (const m of this.sectors) m.dispose(false, true);
    this.sectors = [];
    const { azimuths, rows, sectors } = this.quality;
    const cols = Math.ceil(azimuths / sectors);
    let verts = 0;

    for (let s = 0; s < sectors; s++) {
      const a0 = s * cols;
      const n = Math.min(cols, azimuths - a0);
      if (n <= 0) break;
      const w = n + 1;
      const positions = new Float32Array(w * rows * 3);
      for (let j = 0, p = 0; j < rows; j++) {
        for (let i = 0; i < w; i++, p += 3) {
          positions[p] = a0 + i;      // azimuth index, wraps naturally in the shader
          positions[p + 1] = j;       // radial row
          positions[p + 2] = 0;
        }
      }
      const quads = n * (rows - 1);
      const indices = w * rows > 65535 ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6);
      let k = 0;
      for (let j = 0; j < rows - 1; j++) {
        for (let i = 0; i < n; i++) {
          const a = j * w + i, b = a + 1, c = a + w, dd = c + 1;
          indices[k++] = a; indices[k++] = c; indices[k++] = b;
          indices[k++] = b; indices[k++] = c; indices[k++] = dd;
        }
      }
      const mesh = new Mesh(`sector${s}`, this.scene);
      const vd = new VertexData();
      vd.positions = positions;
      vd.indices = indices as unknown as number[];
      vd.applyToMesh(mesh, false);
      mesh.material = this.terrainMat;
      mesh.layerMask = TERRAIN_MASK;
      mesh.isPickable = false;
      mesh.alwaysSelectAsActiveMesh = true;
      mesh.doNotSyncBoundingInfo = true;
      mesh.setEnabled(false);
      this.sectors.push(mesh);
      verts += w * rows;
    }
    this.diagnostics.vertices = verts;
    this.rangeRtt.renderList = this.sectors;
  }

  // ------------------------------------------------------------------- data

  /**
   * Uploads the clipmap as one stacked rgba8 atlas: levels tile down the
   * texture, height packed as (R*256 + G) + bias. Integer and float texture
   * formats each come with device-dependent conditions; eight-bit channels do
   * not, and three bytes of range at one-metre steps is all the model holds.
   */
  setHeightField(hf: HeightField) {
    this.heightField = hf;
    const levels = hf.levels;
    if (!levels.length) return;
    const { w, h } = levels[0];
    for (const l of levels) {
      if (l.w !== w || l.h !== h) throw new Error('clipmap levels must share a size');
    }
    const need = w * h * 4 * levels.length;
    if (!this.atlasData || this.atlasData.length !== need) {
      this.atlasData = new Uint8Array(need);
      this.atlas?.dispose();
      this.atlas = null;
      this.uploaded = levels.map(() => -1);
    }
    this.atlasLevelPx = h;

    let changed = false;
    levels.forEach((l, i) => {
      if (this.uploaded[i] === l.version && this.atlas) return;
      changed = true;
      const base = i * w * h * 4;
      const raw = l.raw;
      for (let p = 0, o = base; p < raw.length; p++, o += 4) {
        // The stored value is already quantised; re-express it at one metre so
        // one packing works for every level.
        const m = Math.round(raw[p] * l.quant + l.bias) - HEIGHT_BIAS;
        const v = m < 0 ? 0 : m > 65535 ? 65535 : m;
        this.atlasData![o] = v >> 8;
        this.atlasData![o + 1] = v & 255;
        this.atlasData![o + 2] = 0;
        this.atlasData![o + 3] = 255;
      }
      this.uploaded[i] = l.version;
    });

    if (!this.atlas) {
      this.atlas = RawTexture.CreateRGBATexture(this.atlasData!, w, h * levels.length,
        this.scene, false, false, Texture.NEAREST_SAMPLINGMODE);
      this.atlas.wrapU = Texture.CLAMP_ADDRESSMODE;
      this.atlas.wrapV = Texture.CLAMP_ADDRESSMODE;
      this.terrainMat.setTexture('heights', this.atlas);
    } else if (changed) {
      this.atlas.update(this.atlasData!);
    }

    this.diagnostics.levels = levels.length;
    this.diagnostics.atlas = `${w}×${h * levels.length} rgba8`;
    this.syncLevels(hf);
  }

  private syncLevels(hf: HeightField) {
    hf.levels.forEach((l, i) => {
      const pxPerRad = (256 * (1 << l.z)) / (2 * Math.PI);
      this.lvlA.set([l.cx, l.cy, pxPerRad, l.maxRange], i * 4);
      // Heights were re-expressed at one metre when the atlas was packed.
      this.lvlB.set([1, HEIGHT_BIAS, l.w, l.h], i * 4);
    });
    this.camera.far = Math.max(1000, hf.maxRange * 1.15);
  }

  moveTo(lon: number, lat: number, eyeAlt: number) {
    const hf = this.heightField;
    if (!hf) return;
    if (lon !== hf.lon || lat !== hf.lat) hf.setOrigin(lon, lat);
    this.observer = { lon, lat, ground: eyeAlt - this.observer.eye, eye: this.observer.eye };
    this.eyeAltitude = eyeAlt;
    this.syncLevels(hf);
  }

  /** Absolute altitude of the eye, metres. Set from GPS or the DEM. */
  eyeAltitude = 0;

  attachVideo(el: HTMLVideoElement | null) {
    if (this.video) { this.video.dispose(); this.video = null; }
    this.videoEl = el;
    if (!el) { this.compositeMat.setTexture('videoTex', this.blank); return; }
    this.video = new VideoTexture('feed', el, this.scene, false, true,
      Texture.BILINEAR_SAMPLINGMODE, { autoPlay: false, autoUpdateTexture: true, loop: false });
    this.video.wrapU = Texture.CLAMP_ADDRESSMODE;
    this.video.wrapV = Texture.CLAMP_ADDRESSMODE;
    this.compositeMat.setTexture('videoTex', this.video);
  }

  // ----------------------------------------------------------------- render

  private radialParams(hf: HeightField) {
    const { azimuths, rows } = this.quality;
    const azStep = (2 * Math.PI) / azimuths;
    const post = Math.max(8, hf.levels[0]?.res ?? 30);
    const maxRange = Math.max(hf.maxRange, post * 64);
    const r0 = 2;
    const ratioNear = 1.15;
    const logRatioNear = Math.log(ratioNear);
    const jNear = Math.max(1, Math.ceil(Math.log(post / (ratioNear - 1) / r0) / logRatioNear));
    const rNearEnd = r0 * Math.exp(jNear * logRatioNear);
    const splitTarget = Math.min(post / azStep, maxRange * 0.6);
    const jSplit = Math.min(rows - 8, jNear
      + Math.max(2, Math.round((splitTarget - rNearEnd) / post)));
    const rSplit = rNearEnd + (jSplit - jNear) * post;
    const logRatioFar = Math.log(Math.max(maxRange, rSplit * 1.5) / rSplit) / (rows - 1 - jSplit);
    return { azStep, r0, logRatioNear, jNear, rNearEnd, post, jSplit, rSplit, logRatioFar };
  }

  resize(): { w: number; h: number } {
    const cssW = this.canvas.clientWidth || 640;
    const cssH = this.canvas.clientHeight || 360;
    this.engine.resize();
    const w = this.engine.getRenderWidth();
    const h = this.engine.getRenderHeight();
    this.camera.aspect = w / Math.max(1, h);
    if (this.rangeRtt.getSize().width !== w || this.rangeRtt.getSize().height !== h) {
      this.rangeRtt.resize({ width: w, height: h });
    }
    this.diagnostics.size = `${w}×${h} (css ${cssW}×${cssH})`;
    return { w, h };
  }

  render() {
    if (this.disposed || !this.heightField) return;
    const t0 = performance.now();
    const { w, h } = this.resize();
    this.camera.update();
    this.updateTerrainUniforms();
    this.updateCompositeUniforms(w, h);
    this.scene.render();
    const dt = performance.now() - t0;
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 30) this.frameTimes.shift();
    this.diagnostics.frameMs = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
  }

  private updateTerrainUniforms() {
    const hf = this.heightField!;
    const m = this.terrainMat;
    const p = this.radialParams(hf);
    const latR = hf.lat * DEG;

    m.setFloat('uAzStep', p.azStep);
    m.setVector4('uRadial', new Vector4(p.jNear, p.logRatioNear, p.jSplit, p.logRatioFar));
    m.setVector4('uRadialB', new Vector4(p.r0, p.rNearEnd, p.post, p.rSplit));
    m.setFloat('uSinLat0', Math.sin(latR));
    m.setFloat('uCosLat0', Math.cos(latR));
    m.setFloat('uEyeAlt', this.eyeAltitude);
    m.setFloat('uRadius', localRadius(hf.lat));
    m.setFloat('uRefRadius', effectiveRadiusAt(hf.lat, this.refractionK));
    m.setFloat('uDropScale', this.curvature ? 1 : 0);
    m.setFloat('uLevelCount', hf.levels.length);
    m.setVector2('uTexSize', new Vector2(hf.levels[0].w, this.atlasLevelPx * hf.levels.length));
    m.setFloat('uLevelPx', this.atlasLevelPx);
    m.setFloat('uFar', this.camera.far);
    m.setMatrix('uViewProj', Matrix.FromArray(this.camera.viewProj));
    m.setArray4('uLvlA', Array.from(this.lvlA));
    m.setArray4('uLvlB', Array.from(this.lvlB));

    // Wedge culling: enable only the sectors the frustum can reach.
    const arc = this.camera.azimuthArc(4);
    const { azimuths, sectors } = this.quality;
    const cols = Math.ceil(azimuths / sectors);
    let on = 0;
    for (let s = 0; s < this.sectors.length; s++) {
      let enabled = true;
      if (arc) {
        const a0 = ((s * cols) / azimuths) * 360;
        const a1 = (((s + 1) * cols) / azimuths) * 360;
        enabled = arcsOverlap(arc.start, arc.span, a0, a1 - a0);
      }
      this.sectors[s].setEnabled(enabled);
      if (enabled) on++;
    }
    this.diagnostics.sectorsDrawn = on;
  }

  private updateCompositeUniforms(w: number, h: number) {
    const m = this.compositeMat;
    m.setVector2('uTexel', new Vector2(1 / w, 1 / h));
    m.setFloat('uEdgeLow', this.edgeLow);
    m.setFloat('uEdgeHigh', this.edgeHigh);
    m.setFloat('uEdgeWidth', this.edgeWidth);
    m.setFloat('uWhiten', this.whiten);
    m.setFloat('uDesat', this.desaturate);
    m.setFloat('uLineDark', this.lineDark);
    const vw = this.videoEl?.videoWidth ?? 0;
    const vh = this.videoEl?.videoHeight ?? 0;
    const ready = !!this.video && vw > 0 && vh > 0;
    m.setFloat('uHasVideo', ready ? 1 : 0);
    // Reproduce object-fit: cover, so the overlay lines up with the frame.
    let sx = 1, sy = 1;
    if (ready) {
      const canvasAspect = w / h;
      const videoAspect = vw / vh;
      if (canvasAspect > videoAspect) sy = videoAspect / canvasAspect;
      else sx = canvasAspect / videoAspect;
    }
    m.setVector2('uVideoScale', new Vector2(sx, sy));
  }

  /** Renders the composite once more into a buffer and reads it back. */
  async capture(): Promise<CaptureResult | null> {
    const { w, h } = this.resize();
    const rtt = new RenderTargetTexture('capture', { width: w, height: h }, this.scene, {
      generateDepthBuffer: false,
      generateMipMaps: false,
      type: Constants.TEXTURETYPE_UNSIGNED_BYTE,
      format: Constants.TEXTUREFORMAT_RGBA,
    });
    rtt.renderList = [this.quad];
    rtt.activeCamera = this.viewCam;
    rtt.clearColor = new Color4(0, 0, 0, 1);
    try {
      this.updateCompositeUniforms(w, h);
      rtt.render(false, false);
      const data = await rtt.readPixels();
      if (!data) return null;
      const src = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      // Render targets read back bottom-up; images are top-down.
      const out = new Uint8Array(w * h * 4);
      const stride = w * 4;
      for (let y = 0; y < h; y++) {
        out.set(src.subarray((h - 1 - y) * stride, (h - y) * stride), y * stride);
      }
      return { width: w, height: h, pixels: out };
    } finally {
      rtt.dispose();
    }
  }

  dispose() {
    this.disposed = true;
    this.video?.dispose();
    this.scene?.dispose();
    this.engine?.dispose();
  }
}

/** Do two circular arcs, given as (start, span) in degrees, overlap? */
function arcsOverlap(s1: number, span1: number, s2: number, span2: number): boolean {
  const rel = ((s2 - s1) % 360 + 360) % 360;
  return rel < span1 || rel + span2 > 360;
}

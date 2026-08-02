/**
 * Terrain pass.
 *
 * The mesh is polar, not a grid: rays fan out from the observer at a fixed
 * angular step and march outwards with a step that grows to match. That makes
 * screen-space triangle size roughly constant all the way out to 270 km, and it
 * means the renderer can draw only the azimuth wedge the camera can actually
 * see — about a sixth of the panorama at a typical field of view.
 *
 * No vertex buffers are involved: every vertex derives its (bearing, range)
 * from gl_VertexID and gl_InstanceID, samples its own height out of the clipmap
 * texture array, and places itself in a geocentric frame that carries both
 * earth curvature and atmospheric refraction.
 */

import { DEG, REFRACTION_K, effectiveRadius, localRadius } from '../core/geodesy';
import { HeightField } from '../core/heightfield';
import type { Camera } from '../core/camera';
import { GL, RANGE_CODEC, Uniforms, link } from './gl';

export const MAX_LEVELS = 8;

const VERT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2DArray;

uniform usampler2DArray uHeights;

uniform int   uAzStart;
uniform float uAzStep;         // radians between adjacent rays
uniform int   uRows;
uniform vec4  uRadial;         // jNear, logRatioNear, jSplit, logRatioFar
uniform vec4  uRadialB;        // r0, rNearEnd, stepMid, rSplit
uniform float uShade;          // skip the normal fetches when drawing outlines

uniform float uSinLat0, uCosLat0;
uniform float uEyeAlt;
uniform float uRadius;         // local earth radius
uniform float uRefRadius;      // radius that reproduces refracted drop-off
uniform float uDropScale;      // 0 flattens the earth — a correctness check

uniform int   uLevelCount;
uniform vec4  uLvlA[${MAX_LEVELS}];   // cx, cy, pxPerRad, maxRange
uniform vec4  uLvlB[${MAX_LEVELS}];   // quant, bias, w, h

uniform mat4  uViewProj;
uniform float uLogDepthC;

out vec3  vEnu;
out vec3  vNormal;
out float vRange;
out float vHeight;

/**
 * log(1+x) without the cancellation. |x| stays under ~0.12 for the ranges this
 * renderer covers, where six terms are good to about 4e-7.
 */
float log1p(float x) {
  return x * (1.0 - x * (0.5 - x * (0.3333333 - x * (0.25 - x * (0.2 - x * 0.1666667)))));
}

/**
 * Sample spacing along a ray, in three segments:
 *   near  geometric, so the ground at your feet is not one enormous triangle;
 *   mid   one DEM post per step, which is all the data can support;
 *   far   geometric again, tracking the angular step so screen-space triangle
 *         size stays roughly constant out to the far plane.
 */
float radiusAt(int j) {
  float f = float(j);
  if (f < uRadial.x) return uRadialB.x * exp(f * uRadial.y);
  if (f < uRadial.z) return uRadialB.y + (f - uRadial.x) * uRadialB.z;
  return uRadialB.w * exp((f - uRadial.z) * uRadial.w);
}

float sampleLevel(int lv, float dLon, float dIso) {
  vec4 A = uLvlA[lv], B = uLvlB[lv];
  float u = A.x + dLon * A.z;
  float v = A.y - dIso * A.z;
  vec2 f = vec2(u, v) - 0.5;            // raster pixels are area samples
  vec2 p0 = floor(f);
  vec2 t = f - p0;
  vec2 hi = B.zw - 1.0;
  ivec2 a = ivec2(clamp(p0, vec2(0.0), hi));
  ivec2 b = ivec2(clamp(p0 + 1.0, vec2(0.0), hi));
  float h00 = float(texelFetch(uHeights, ivec3(a.x, a.y, lv), 0).r);
  float h10 = float(texelFetch(uHeights, ivec3(b.x, a.y, lv), 0).r);
  float h01 = float(texelFetch(uHeights, ivec3(a.x, b.y, lv), 0).r);
  float h11 = float(texelFetch(uHeights, ivec3(b.x, b.y, lv), 0).r);
  float h = mix(mix(h00, h10, t.x), mix(h01, h11, t.x), t.y);
  return h * B.x + B.y;
}

void main() {
  int row  = gl_VertexID >> 1;
  int side = gl_VertexID & 1;
  int az   = uAzStart + gl_InstanceID + side;

  float r = radiusAt(min(row, uRows - 1));
  float alpha = float(az) * uAzStep;
  float sinA = sin(alpha), cosA = cos(alpha);

  // Great-circle destination at bearing alpha, ground range r — kept entirely
  // in offsets from the observer. Forming sin(lat) and then subtracting
  // sin(lat0), or forming the isometric latitude and subtracting the
  // observer's, both cancel two numbers near 0.93 in a float32 register and
  // then multiply the wreckage by ~1.7e5 pixels per radian. The result is a
  // sampling error of a metre or two on flat ground and tens of metres on a
  // sharp summit, which reads as a nearby cliff that is not there.
  float delta = r / uRadius;
  float sinD = sin(delta), cosD = cos(delta);
  float hs = sin(0.5 * delta);
  float hav = hs * hs;                                  // sin^2(delta/2)
  float ds = uCosLat0 * sinD * cosA - 2.0 * uSinLat0 * hav;   // sin(lat) - sin(lat0)
  float sinP = clamp(uSinLat0 + ds, -1.0, 1.0);
  float dLon = atan(sinA * sinD * uCosLat0, cosD - uSinLat0 * sinP);
  // d/dphi of the isometric latitude is sec(phi), and in terms of s = sin(phi)
  // the integral is 0.5*log((1+s)/(1-s)) — so the offset falls out of ds alone.
  float dIso = 0.5 * (log1p(ds / (1.0 + uSinLat0)) - log1p(-ds / (1.0 - uSinLat0)));

  // Finest clipmap level that still covers this range, cross-faded into the
  // next one so the LOD change never shows up as a step in the skyline.
  int lv = uLevelCount - 1;
  for (int i = 0; i < ${MAX_LEVELS}; i++) {
    if (i >= uLevelCount) break;
    if (r <= uLvlA[i].w) { lv = i; break; }
  }
  float h = sampleLevel(lv, dLon, dIso);
  if (lv + 1 < uLevelCount) {
    float outer = uLvlA[lv].w;
    float fade = smoothstep(outer * 0.86, outer, r);
    if (fade > 0.0) h = mix(h, sampleLevel(lv + 1, dLon, dIso), fade);
  }

  // The surface normal is taken from the DEM rather than from screen-space
  // derivatives: the polar mesh produces very long, very thin triangles, and
  // dFdx/dFdy across those reduces the shading to vertical streaks. Two extra
  // taps are only paid for when something is actually being shaded.
  vNormal = vec3(0.0, 0.0, 1.0);
  if (uShade > 0.5) {
    float step = 1.0 / uLvlA[lv].z;                 // one pixel, in radians
    float post = uRadius * uCosLat0 * step;         // ...and in metres
    float hE = sampleLevel(lv, dLon + step, dIso);
    float hN = sampleLevel(lv, dLon, dIso + step);
    vNormal = normalize(vec3(-(hE - h) / post, -(hN - h) / post, 1.0));
  }

  float horiz = (uRadius + h) * sinD;
  float s = sin(r / (2.0 * uRefRadius));
  float drop = 2.0 * (uRefRadius + h) * s * s * uDropScale;

  vec3 enu = vec3(horiz * sinA, horiz * cosA, (h - uEyeAlt) - drop);
  vEnu = enu;
  vRange = length(enu);
  vHeight = h;

  gl_Position = uViewProj * vec4(enu, 1.0);
  // Logarithmic depth: a single 24-bit buffer has to separate a boulder 3 m
  // away from a ridge 270 km away, which a linear mapping cannot do.
  gl_Position.z = (log2(max(1e-6, 1.0 + gl_Position.w)) * uLogDepthC - 1.0) * gl_Position.w;
}
`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;

in vec3  vEnu;
in vec3  vNormal;
in float vRange;
in float vHeight;

uniform vec3  uSunDir;
uniform float uHazeScale;
uniform float uSnowLine;

layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outRange;

${RANGE_CODEC}

void main() {
  vec3 n = normalize(vNormal);
  float lambert = max(0.0, dot(n, uSunDir));
  float sky = 0.35 + 0.65 * max(0.0, n.z);
  float lit = 0.20 * sky + 0.80 * lambert;

  vec3 rock = vec3(0.42, 0.40, 0.38);
  vec3 snow = vec3(0.92, 0.94, 0.97);
  float snowT = smoothstep(uSnowLine - 250.0, uSnowLine + 250.0, vHeight)
              * smoothstep(0.35, 0.75, n.z);
  vec3 albedo = mix(rock, snow, snowT);

  vec3 col = albedo * (0.25 + 0.85 * lit);
  float haze = 1.0 - exp(-vRange * uHazeScale);
  col = mix(col, vec3(0.62, 0.70, 0.82), haze * 0.92);

  outColor = vec4(col, 1.0);
  outRange = packRange(vRange, 1.0);
}
`;

export interface TerrainQuality {
  /** Rays around the full circle. 2048 gives ~0.18 deg of azimuth. */
  azimuths: number;
  /** Samples along each ray. */
  rows: number;
}

export const QUALITY_HIGH: TerrainQuality = { azimuths: 2048, rows: 1320 };
export const QUALITY_LOW: TerrainQuality = { azimuths: 1024, rows: 900 };

export class TerrainPass {
  private program: WebGLProgram;
  private u: Uniforms;
  private vao: WebGLVertexArrayObject;
  private tex: WebGLTexture | null = null;
  private layers = 0;
  private texW = 0;
  private texH = 0;

  private uploaded: number[] = [];
  private lvlA = new Float32Array(MAX_LEVELS * 4);
  private lvlB = new Float32Array(MAX_LEVELS * 4);

  quality: TerrainQuality = QUALITY_HIGH;
  /** Eye altitude above the ellipsoid, metres. */
  eyeAlt = 0;
  /** Refraction coefficient; 0 = vacuum geometry. */
  refractionK = REFRACTION_K;
  /** Off = flat earth. Only useful for demonstrating what curvature is worth. */
  curvature = true;
  /** Whether the colour attachment is used; outline mode does not need it. */
  shade = false;
  sunAzimuth = 150;
  sunElevation = 35;
  /** Visibility in metres — how far before terrain fades fully into haze. */
  visibility = 160000;
  snowLine = 2900;
  lastDrawnColumns = 0;

  constructor(private gl: GL) {
    this.program = link(gl, VERT, FRAG, 'terrain');
    this.u = new Uniforms(gl, this.program);
    this.vao = gl.createVertexArray()!;
  }

  /**
   * Uploads the clipmap into a texture array. Every level must share one pixel
   * size so the vertex shader can pick a layer with a computed index — WebGL2
   * forbids indexing an array of samplers dynamically.
   */
  upload(hf: HeightField) {
    const gl = this.gl;
    const levels = hf.levels;
    if (!levels.length) throw new Error('height field has no levels');
    const { w, h } = levels[0];
    for (const l of levels) {
      if (l.w !== w || l.h !== h) {
        throw new Error(`clipmap levels must share a size (${l.w}x${l.h} vs ${w}x${h})`);
      }
    }
    if (!this.tex || this.texW !== w || this.texH !== h || this.layers !== levels.length) {
      if (this.tex) gl.deleteTexture(this.tex);
      this.tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R16UI, w, h, levels.length);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.texW = w; this.texH = h; this.layers = levels.length;
      this.uploaded = levels.map(() => -1);
    }
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
    levels.forEach((l, i) => {
      // Streaming refills one level at a time; re-sending all six on every
      // tile that lands would dominate the frame.
      if (this.uploaded[i] === l.version) return;
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, w, h, 1,
        gl.RED_INTEGER, gl.UNSIGNED_SHORT, l.raw);
      this.uploaded[i] = l.version;
    });
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    this.syncLevelUniforms(hf);
  }

  /** Refreshes the per-level constants after the observer or a level moves. */
  syncLevelUniforms(hf: HeightField) {
    hf.levels.forEach((l, i) => {
      const pxPerRad = (256 * (1 << l.z)) / (2 * Math.PI);
      this.lvlA.set([l.cx, l.cy, pxPerRad, l.maxRange], i * 4);
      this.lvlB.set([l.quant, l.bias, l.w, l.h], i * 4);
    });
  }

  /**
   * Radial sample distribution. Three segments, chosen so that the step is
   * never much finer than the data can justify and never coarser than the
   * screen can resolve:
   *   near  geometric from 2 m until the step reaches one DEM post,
   *   mid   one DEM post per step until a post subtends one ray spacing,
   *   far   geometric at the ray spacing, out to the edge of the model.
   */
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

  draw(hf: HeightField, cam: Camera) {
    const gl = this.gl;
    if (!this.tex) return;
    const { azimuths, rows } = this.quality;
    const p = this.radialParams(hf);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex);
    this.u.i('uHeights', 0);

    this.u.f('uAzStep', p.azStep);
    this.u.i('uRows', rows);
    this.u.v4('uRadial', p.jNear, p.logRatioNear, p.jSplit, p.logRatioFar);
    this.u.v4('uRadialB', p.r0, p.rNearEnd, p.post, p.rSplit);
    this.u.f('uShade', this.shade ? 1 : 0);

    const latR = hf.lat * DEG;
    this.u.f('uSinLat0', Math.sin(latR));
    this.u.f('uCosLat0', Math.cos(latR));
    this.u.f('uRadius', localRadius(hf.lat));
    this.u.f('uRefRadius', effectiveRadius(this.refractionK));
    this.u.f('uDropScale', this.curvature ? 1 : 0);
    this.u.f('uEyeAlt', this.eyeAlt);

    this.u.i('uLevelCount', hf.levels.length);
    this.u.v4v('uLvlA', this.lvlA);
    this.u.v4v('uLvlB', this.lvlB);

    this.u.m4('uViewProj', cam.viewProj);
    this.u.f('uLogDepthC', 2.0 / Math.log2(cam.far + 1.0));

    const sa = this.sunAzimuth * DEG, se = this.sunElevation * DEG;
    this.u.v3('uSunDir', Math.sin(sa) * Math.cos(se), Math.cos(sa) * Math.cos(se), Math.sin(se));
    this.u.f('uHazeScale', 1 / Math.max(1000, this.visibility));
    this.u.f('uSnowLine', this.snowLine);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);

    const arc = cam.azimuthArc();
    const vertsPerStrip = rows * 2;
    if (!arc) {
      this.u.i('uAzStart', 0);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, vertsPerStrip, azimuths);
      this.lastDrawnColumns = azimuths;
    } else {
      const first = Math.floor((arc.start / 360) * azimuths);
      const count = Math.min(azimuths, Math.ceil((arc.span / 360) * azimuths) + 1);
      this.u.i('uAzStart', first);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, vertsPerStrip, count);
      this.lastDrawnColumns = count;
    }
    gl.bindVertexArray(null);
  }
}

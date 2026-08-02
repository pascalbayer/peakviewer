/**
 * Composite pass: sky, terrain fill and the silhouette.
 *
 * The outline is an edge detector run over the range buffer, not over the
 * shaded image — which is the whole point. Ridge lines then come out of the
 * geometry rather than out of the lighting, so they stay legible whichever way
 * the sun happens to be pointing, and they survive being drawn on top of a
 * bright camera feed.
 *
 * Sky pixels are fed into the detector as "very far away", so the outer
 * skyline and the ridge-behind-ridge creases are found by exactly the same
 * comparison.
 */

import { GL, RANGE_CODEC, Uniforms, link } from './gl';
import type { Camera } from '../core/camera';

const VERT = /* glsl */ `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  // Full-screen triangle; no buffers required.
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uColor;
uniform sampler2D uRange;
uniform vec2  uTexel;
uniform vec3  uFwd, uRight, uUp;
uniform vec2  uTan;          // tan(hfov/2), tan(vfov/2)

uniform float uOutline;      // 0 = shaded only, 1 = outline only
uniform float uEdgeLow, uEdgeHigh;
uniform float uEdgeWidth;
uniform float uSkyAlpha;     // 0 = transparent background (AR), 1 = draw sky
uniform vec3  uLineColor;
uniform float uHorizonMark;

${RANGE_CODEC}

const float LOG_SKY = 13.5;  // log of "beyond the far plane"

float logAt(vec2 uv) {
  vec4 p = texture(uRange, uv);
  return p.a > 0.5 ? unpackLogRange(p) : LOG_SKY;
}

vec3 skyColor(float elevDeg) {
  float t = clamp((elevDeg + 6.0) / 46.0, 0.0, 1.0);
  vec3 low  = vec3(0.86, 0.90, 0.95);
  vec3 high = vec3(0.36, 0.55, 0.82);
  return mix(low, high, pow(t, 0.8));
}

void main() {
  vec2 uv = vUv;
  vec4 rp = texture(uRange, uv);
  bool hit = rp.a > 0.5;

  vec3 dir = normalize(uFwd
    + uRight * (uv.x * 2.0 - 1.0) * uTan.x
    + uUp    * (uv.y * 2.0 - 1.0) * uTan.y);
  float elev = degrees(asin(clamp(dir.z, -1.0, 1.0)));

  // --- silhouette ------------------------------------------------------
  vec2 e = uTexel * uEdgeWidth;
  float lc = logAt(uv);
  float lL = logAt(uv - vec2(e.x, 0.0));
  float lR = logAt(uv + vec2(e.x, 0.0));
  float lD = logAt(uv - vec2(0.0, e.y));
  float lU = logAt(uv + vec2(0.0, e.y));
  // Second difference: a constant range gradient (an even slope) cancels, a
  // step (one ridge in front of another) does not.
  float lap = abs(lL + lR - 2.0 * lc) + abs(lU + lD - 2.0 * lc);
  float edge = smoothstep(uEdgeLow, uEdgeHigh, lap);

  // --- fills -----------------------------------------------------------
  vec3 shaded = texture(uColor, uv).rgb;
  float range = hit ? unpackRange(rp) : 0.0;
  float far = clamp(range / 90000.0, 0.0, 1.0);
  vec3 paper = mix(vec3(1.0, 1.0, 1.0), vec3(0.90, 0.93, 0.97), far);

  vec3 sky = skyColor(elev);
  vec3 base = hit ? mix(shaded, paper, uOutline) : mix(sky, mix(sky, vec3(1.0), 0.55), uOutline);
  float alpha = hit ? 1.0 : uSkyAlpha;

  // A faint true-horizontal reference at elevation 0: handy for checking that
  // the curvature and refraction terms are doing what they claim.
  float hline = uHorizonMark * (1.0 - smoothstep(0.0, 0.08, abs(elev)));

  vec3 col = mix(base, uLineColor, edge);
  col = mix(col, vec3(0.85, 0.25, 0.25), hline * 0.55);
  alpha = max(alpha, edge);

  fragColor = vec4(col, alpha);
}
`;

export type Style = 'shaded' | 'outline' | 'ar';

export class ComposePass {
  private program: WebGLProgram;
  private u: Uniforms;
  private vao: WebGLVertexArrayObject;

  style: Style = 'outline';
  edgeLow = 0.030;
  edgeHigh = 0.320;
  edgeWidth = 1.0;
  showHorizon = false;
  lineColor: [number, number, number] = [0.11, 0.14, 0.20];

  constructor(private gl: GL) {
    this.program = link(gl, VERT, FRAG, 'compose');
    this.u = new Uniforms(gl, this.program);
    this.vao = gl.createVertexArray()!;
  }

  draw(color: WebGLTexture, range: WebGLTexture, w: number, h: number, cam: Camera) {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, color);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, range);
    this.u.i('uColor', 0);
    this.u.i('uRange', 1);
    this.u.v2('uTexel', 1 / w, 1 / h);
    this.u.v3('uFwd', cam.forward[0], cam.forward[1], cam.forward[2]);
    this.u.v3('uRight', cam.right[0], cam.right[1], cam.right[2]);
    this.u.v3('uUp', cam.up[0], cam.up[1], cam.up[2]);
    const th = Math.tan((cam.fov * Math.PI) / 360);
    this.u.v2('uTan', th * cam.aspect, th);
    this.u.f('uOutline', this.style === 'shaded' ? 0 : 1);
    this.u.f('uSkyAlpha', this.style === 'ar' ? 0 : 1);
    this.u.f('uEdgeLow', this.edgeLow);
    this.u.f('uEdgeHigh', this.edgeHigh);
    this.u.f('uEdgeWidth', this.edgeWidth);
    this.u.f('uHorizonMark', this.showHorizon ? 1 : 0);
    this.u.v3('uLineColor', ...this.lineColor);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }
}

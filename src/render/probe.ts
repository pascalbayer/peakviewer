/**
 * Label visibility, answered by the depth buffer.
 *
 * Each candidate summit is drawn as a single point into a tiny off-screen
 * buffer — one pixel per summit — where the fragment shader looks up the
 * terrain's range at that summit's projected position and compares. One draw
 * and one small read-back settle every label at once, and because the answer
 * comes from the same rasterised terrain the user is looking at, a summit is
 * hidden exactly when the ridge in front of it covers it. No analytic horizon,
 * no per-peak ray marching.
 */

import type { Camera } from '../core/camera';
import type { LabelTarget } from '../core/labels';
import { GL, RANGE_CODEC, Uniforms, link } from './gl';

const PROBE_W = 64;
const MAX_PROBES = PROBE_W * 64;

const VERT = /* glsl */ `#version 300 es
precision highp float;

in vec3 aEnu;
uniform mat4 uViewProj;
uniform vec2 uProbeSize;

out vec2  vUv;
out float vRange;
out float vFront;

void main() {
  vec4 c = uViewProj * vec4(aEnu, 1.0);
  vFront = c.w > 0.0 ? 1.0 : 0.0;
  vUv = c.w > 0.0 ? (c.xy / c.w) * 0.5 + 0.5 : vec2(-1.0);
  vRange = length(aEnu);

  float i = float(gl_VertexID);
  vec2 cell = vec2(mod(i, uProbeSize.x), floor(i / uProbeSize.x));
  gl_Position = vec4((cell + 0.5) / uProbeSize * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;

in vec2  vUv;
in float vRange;
in float vFront;

uniform sampler2D uRange;
uniform vec2  uTexel;
uniform float uTolerance;

out vec4 outVis;

${RANGE_CODEC}

/** Farthest terrain in a small neighbourhood — a summit is often one pixel. */
float terrainBehind(vec2 uv) {
  float far = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec4 p = texture(uRange, uv + vec2(float(i), float(j)) * uTexel * 1.5);
      float r = p.a > 0.5 ? unpackRange(p) : 1.0e9;
      far = max(far, r);
    }
  }
  return far;
}

void main() {
  bool onScreen = vFront > 0.5
    && vUv.x >= 0.0 && vUv.x <= 1.0 && vUv.y >= 0.0 && vUv.y <= 1.0;
  float vis = 0.0;
  if (onScreen) {
    // Visible when nothing nearer than this summit is drawn where it projects.
    // The tolerance absorbs the gap between a catalogued summit height and the
    // DEM's rounded-off version of the same peak.
    vis = vRange < terrainBehind(vUv) * uTolerance + 60.0 ? 1.0 : 0.0;
  }
  outVis = vec4(vis, onScreen ? 1.0 : 0.0, 0.0, 1.0);
}
`;

export class VisibilityProbe {
  private program: WebGLProgram;
  private u: Uniforms;
  private vao: WebGLVertexArrayObject;
  private vbo: WebGLBuffer;
  private fbo: WebGLFramebuffer;
  private tex: WebGLTexture;
  private data = new Float32Array(MAX_PROBES * 3);
  private pixels = new Uint8Array(PROBE_W * 64 * 4);
  private count = 0;

  /** Slack on the occlusion test; 1.0 is exact. */
  tolerance = 1.03;

  constructor(private gl: GL) {
    this.program = link(gl, VERT, FRAG, 'probe');
    this.u = new Uniforms(gl, this.program);
    this.vao = gl.createVertexArray()!;
    this.vbo = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    const loc = gl.getAttribLocation(this.program, 'aEnu');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, PROBE_W, 64, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Uploads anchor positions. Call when the target list or observer changes. */
  setTargets(targets: LabelTarget[]) {
    const gl = this.gl;
    this.count = Math.min(targets.length, MAX_PROBES);
    for (let i = 0; i < this.count; i++) {
      const t = targets[i];
      this.data[i * 3] = t.east;
      this.data[i * 3 + 1] = t.north;
      this.data[i * 3 + 2] = t.up;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, this.count * 3);
  }

  /** Runs the test and writes `visible` back onto the targets. */
  run(targets: LabelTarget[], cam: Camera, rangeTex: WebGLTexture, w: number, h: number) {
    const gl = this.gl;
    if (!this.count) return;
    const rows = Math.ceil(this.count / PROBE_W);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, PROBE_W, 64);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, rangeTex);
    this.u.i('uRange', 0);
    this.u.v2('uTexel', 1 / w, 1 / h);
    this.u.v2('uProbeSize', PROBE_W, 64);
    this.u.f('uTolerance', this.tolerance);
    this.u.m4('uViewProj', cam.viewProj);
    gl.drawArrays(gl.POINTS, 0, this.count);

    gl.readPixels(0, 0, PROBE_W, rows, gl.RGBA, gl.UNSIGNED_BYTE, this.pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);

    for (let i = 0; i < this.count; i++) {
      targets[i].visible = this.pixels[i * 4] > 127;
    }
    for (let i = this.count; i < targets.length; i++) targets[i].visible = false;
  }
}

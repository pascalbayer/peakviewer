export type GL = WebGL2RenderingContext;

export function createContext(canvas: HTMLCanvasElement): GL {
  const gl = canvas.getContext('webgl2', {
    antialias: false, // we resolve edges ourselves in the silhouette pass
    depth: false,
    // Alpha is on for AR: in that mode the compose pass leaves the sky
    // transparent so the camera frame behind the canvas shows through.
    alpha: true,
    premultipliedAlpha: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
  });
  if (!gl) throw new Error('WebGL2 is required for the terrain renderer.');
  return gl;
}

export function compile(gl: GL, type: number, src: string, name: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) ?? '';
    const numbered = src.split('\n').map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join('\n');
    throw new Error(`${name} failed to compile:\n${log}\n${numbered}`);
  }
  return sh;
}

export function link(gl: GL, vsSrc: string, fsSrc: string, name: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsSrc, `${name}.vert`));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc, `${name}.frag`));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`${name} failed to link:\n${gl.getProgramInfoLog(p)}`);
  }
  return p;
}

/** Cached uniform locations — getUniformLocation is slow enough to matter. */
export class Uniforms {
  private cache = new Map<string, WebGLUniformLocation | null>();
  constructor(private gl: GL, readonly program: WebGLProgram) {}
  loc(name: string): WebGLUniformLocation | null {
    let l = this.cache.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.program, name);
      this.cache.set(name, l);
    }
    return l;
  }
  f(n: string, v: number) { this.gl.uniform1f(this.loc(n), v); }
  i(n: string, v: number) { this.gl.uniform1i(this.loc(n), v); }
  v2(n: string, x: number, y: number) { this.gl.uniform2f(this.loc(n), x, y); }
  v3(n: string, x: number, y: number, z: number) { this.gl.uniform3f(this.loc(n), x, y, z); }
  v4(n: string, x: number, y: number, z: number, w: number) { this.gl.uniform4f(this.loc(n), x, y, z, w); }
  m4(n: string, m: Float32Array) { this.gl.uniformMatrix4fv(this.loc(n), false, m); }
  fv(n: string, v: Float32Array) { this.gl.uniform1fv(this.loc(n), v); }
  v4v(n: string, v: Float32Array) { this.gl.uniform4fv(this.loc(n), v); }
}

/** R16UI texture holding quantised heights; sampled with texelFetch only. */
export function createHeightTexture(gl: GL, w: number, h: number, data: Uint16Array): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, w, h, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  return t;
}

export function createColorTexture(gl: GL, w: number, h: number, filter: number = gl.LINEAR): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

/**
 * Off-screen target for the terrain pass: one colour attachment for shading and
 * one for range. Range is packed into RGB8 rather than kept in a float target so
 * the renderer needs no colour-buffer-float extension — mid-range Android GPUs
 * are inconsistent about it, and 24 bits of log-range is far more than the edge
 * detector or the label depth test can use.
 */
export class GBuffer {
  fbo: WebGLFramebuffer;
  color: WebGLTexture;
  range: WebGLTexture;
  depth: WebGLRenderbuffer;
  width = 0;
  height = 0;

  constructor(private gl: GL) {
    this.fbo = gl.createFramebuffer()!;
    this.color = createColorTexture(gl, 1, 1);
    this.range = createColorTexture(gl, 1, 1, gl.NEAREST);
    this.depth = gl.createRenderbuffer()!;
  }

  resize(w: number, h: number) {
    if (w === this.width && h === this.height) return;
    const gl = this.gl;
    this.width = w; this.height = h;
    gl.bindTexture(gl.TEXTURE_2D, this.color);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindTexture(gl.TEXTURE_2D, this.range);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.color, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.range, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depth);
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`incomplete framebuffer: 0x${st.toString(16)}`);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  bind() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.viewport(0, 0, this.width, this.height);
  }
}

/** Shared GLSL: pack/unpack a range in metres as 24-bit log, plus a hit flag. */
export const RANGE_CODEC = /* glsl */ `
const float RANGE_MIN = 8.0;
const float RANGE_MAX = 4.0e5;
const float LOG_MIN = 2.0794415;                 // log(RANGE_MIN)
const float LOG_SPAN = 10.8198;                  // log(RANGE_MAX) - log(RANGE_MIN)

vec4 packRange(float range, float hit) {
  float t = clamp((log(max(range, RANGE_MIN)) - LOG_MIN) / LOG_SPAN, 0.0, 1.0);
  float v = t * 16777215.0;
  float r = floor(v / 65536.0);
  float g = floor((v - r * 65536.0) / 256.0);
  float b = v - r * 65536.0 - g * 256.0;
  return vec4(r / 255.0, g / 255.0, b / 255.0, hit);
}

float unpackRange(vec4 p) {
  float v = (p.r * 255.0) * 65536.0 + (p.g * 255.0) * 256.0 + (p.b * 255.0);
  return exp(LOG_MIN + (v / 16777215.0) * LOG_SPAN);
}

/** Log-range straight from the packed bytes — what the edge detector compares. */
float unpackLogRange(vec4 p) {
  float v = (p.r * 255.0) * 65536.0 + (p.g * 255.0) * 256.0 + (p.b * 255.0);
  return LOG_MIN + (v / 16777215.0) * LOG_SPAN;
}
`;

/**
 * The same two passes in GLSL, for the WebGL2 backend.
 *
 * This exists to be debuggable. WebGPU is the target, but a software WebGPU
 * adapter is unstable enough in headless containers that it cannot be used to
 * check whether the renderer draws the right picture — and a peak finder whose
 * output nobody can look at is a peak finder nobody can trust. WebGL2 runs
 * anywhere, including under SwiftShader in CI, so `tools/check_gpu.mjs` can
 * render a known ridge and assert on the pixels.
 *
 * Everything here is a line-for-line translation of wgsl.ts and must stay one.
 * The uniform names, the packing and the geometry are shared verbatim; only the
 * dialect and two conventions differ:
 *
 *   - Depth. WebGL clips z to [-1,1] where WebGPU uses [0,1], so the
 *     logarithmic remap ends on a different interval. Camera.depthZeroToOne
 *     handles the projection matrix; this handles the remap that follows it.
 *   - Samplers. GLSL combines texture and sampler into one `sampler2D`, so
 *     there is no `xxxSampler` companion to declare.
 *
 * Babylon's WebGL2 processor rewrites `attribute` to `in`, `varying` to
 * `in`/`out`, `texture2D(` to `texture(` and `gl_FragColor` to a declared
 * output. Writing the older spelling is therefore the idiomatic thing to do
 * here, and `textureLod` — which it does not rewrite outside fragment shaders —
 * is already valid GLSL ES 3.00 and passes through untouched.
 */

/** Range packing. Byte-for-byte identical to the WGSL in wgsl.ts. */
const RANGE_CODEC = /* glsl */ `
const float RANGE_MIN = 8.0;
const float LOG_MIN   = 2.0794415;
const float LOG_SPAN  = 10.8198;      // log(4.0e5) - log(8)

vec4 packRange(float range, float hit) {
  float t = clamp((log(max(range, RANGE_MIN)) - LOG_MIN) / LOG_SPAN, 0.0, 1.0);
  float v = t * 16777215.0;
  float r = floor(v / 65536.0);
  float g = floor((v - r * 65536.0) / 256.0);
  float b = v - r * 65536.0 - g * 256.0;
  return vec4(r / 255.0, g / 255.0, b / 255.0, hit);
}

float unpackLogRange(vec4 p) {
  float v = floor(p.r * 255.0 + 0.5) * 65536.0
          + floor(p.g * 255.0 + 0.5) * 256.0
          + floor(p.b * 255.0 + 0.5);
  return LOG_MIN + (v / 16777215.0) * LOG_SPAN;
}
`;

export const TERRAIN_VERTEX_GL = /* glsl */ `
// x = azimuth index, y = radial row index. Everything else is derived.
attribute vec3 position;

uniform float uAzStep;
uniform vec4  uRadial;      // jNear, logRatioNear, jSplit, logRatioFar
uniform vec4  uRadialB;     // r0, rNearEnd, stepMid, rSplit
uniform float uSinLat0;
uniform float uCosLat0;
uniform float uEyeAlt;
uniform float uRadius;
uniform float uRefRadius;
uniform float uDropScale;
uniform float uLevelCount;
uniform vec2  uTexSize;
uniform float uLevelPx;     // pixels per clipmap level in the stacked atlas
uniform mat4  uViewProj;
uniform float uFar;
uniform vec4  uLvlA[8];     // cx, cy, pxPerRad, maxRange
uniform vec4  uLvlB[8];     // quant, bias, w, h

uniform sampler2D heights;

varying float vRange;

/**
 * log(1+x) without the cancellation. |x| stays well under 0.12 for the ranges
 * this renderer covers, where six terms are good to about 4e-7.
 */
float log1p(float x) {
  return x * (1.0 - x * (0.5 - x * (0.3333333 - x * (0.25 - x * (0.2 - x * 0.1666667)))));
}

/**
 * Sample spacing along a ray, in three segments: geometric near, so the ground
 * at your feet is not one enormous triangle; one DEM post per step through the
 * middle; geometric again far out, tracking the angular step so screen-space
 * triangle size stays roughly constant to the far plane.
 */
float radiusAt(float f) {
  if (f < uRadial.x) { return uRadialB.x * exp(f * uRadial.y); }
  if (f < uRadial.z) { return uRadialB.y + (f - uRadial.x) * uRadialB.z; }
  return uRadialB.w * exp((f - uRadial.z) * uRadial.w);
}

/** One exact texel out of the stacked clipmap atlas. */
float texel(int lv, float x, float y) {
  float px = clamp(x, 0.0, uLevelPx - 1.0);
  float py = clamp(y, 0.0, uLevelPx - 1.0) + float(lv) * uLevelPx;
  vec2 uv = vec2((px + 0.5) / uTexSize.x, (py + 0.5) / uTexSize.y);
  vec4 c = textureLod(heights, uv, 0.0);
  return floor(c.r * 255.0 + 0.5) * 256.0 + floor(c.g * 255.0 + 0.5);
}

float sampleLevel(int lv, float dLon, float dIso) {
  vec4 A = uLvlA[lv];
  vec4 B = uLvlB[lv];
  float u = A.x + dLon * A.z;
  float v = A.y - dIso * A.z;
  vec2 f = vec2(u, v) - vec2(0.5, 0.5);   // raster pixels are area samples
  vec2 p0 = floor(f);
  vec2 t = f - p0;
  float h00 = texel(lv, p0.x, p0.y);
  float h10 = texel(lv, p0.x + 1.0, p0.y);
  float h01 = texel(lv, p0.x, p0.y + 1.0);
  float h11 = texel(lv, p0.x + 1.0, p0.y + 1.0);
  float h = mix(mix(h00, h10, t.x), mix(h01, h11, t.x), t.y);
  return h * B.x + B.y;
}

void main(void) {
  float alpha = position.x * uAzStep;
  float r = radiusAt(position.y);
  float sinA = sin(alpha);
  float cosA = cos(alpha);

  // Great-circle destination at bearing alpha, ground range r — kept entirely
  // in offsets from the observer. Forming sin(lat) and then subtracting
  // sin(lat0), or forming the isometric latitude and subtracting the
  // observer's, cancels two f32 values near 0.93 and then multiplies the
  // wreckage by ~1.7e5 pixels per radian.
  float delta = r / uRadius;
  float sinD = sin(delta);
  float cosD = cos(delta);
  float hs = sin(0.5 * delta);
  float hav = hs * hs;
  float ds = uCosLat0 * sinD * cosA - 2.0 * uSinLat0 * hav;   // sin(lat) - sin(lat0)
  float sinP = clamp(uSinLat0 + ds, -1.0, 1.0);
  float dLon = atan(sinA * sinD * uCosLat0, cosD - uSinLat0 * sinP);
  // d/dphi of the isometric latitude is sec(phi); in terms of s = sin(phi) the
  // integral is 0.5*log((1+s)/(1-s)), so the offset falls out of ds alone.
  float dIso = 0.5 * (log1p(ds / (1.0 + uSinLat0)) - log1p(-ds / (1.0 - uSinLat0)));

  // Finest level that still covers this range, cross-faded into the next so an
  // LOD change never shows up as a step in the skyline.
  int lv = int(uLevelCount) - 1;
  for (int i = 0; i < 8; i++) {
    if (float(i) >= uLevelCount) { break; }
    if (r <= uLvlA[i].w) { lv = i; break; }
  }
  float h = sampleLevel(lv, dLon, dIso);
  if (float(lv) + 1.0 < uLevelCount) {
    float outer = uLvlA[lv].w;
    float fade = smoothstep(outer * 0.86, outer, r);
    if (fade > 0.0) { h = mix(h, sampleLevel(lv + 1, dLon, dIso), fade); }
  }

  float horiz = (uRadius + h) * sinD;
  float s = sin(r / (2.0 * uRefRadius));
  float drop = 2.0 * (uRefRadius + h) * s * s * uDropScale;

  vec3 enu = vec3(horiz * sinA, horiz * cosA, (h - uEyeAlt) - drop);
  vRange = length(enu);

  vec4 clip = uViewProj * vec4(enu, 1.0);
  // Logarithmic depth. Same curve as the WGSL, mapped to WebGL's [-1,1] clip
  // range instead of WebGPU's [0,1]. One 24-bit buffer has to separate a
  // boulder three metres away from a ridge 270 km away.
  clip.z = (2.0 * log2(max(1e-6, 1.0 + clip.w)) / log2(1.0 + uFar) - 1.0) * clip.w;
  gl_Position = clip;
}
`;

export const TERRAIN_FRAGMENT_GL = /* glsl */ `
precision highp float;
varying float vRange;
${RANGE_CODEC}

void main(void) {
  gl_FragColor = packRange(vRange, 1.0);
}
`;

export const COMPOSITE_VERTEX_GL = /* glsl */ `
attribute vec3 position;
varying vec2 vUV;

void main(void) {
  // A fullscreen quad in clip space; no camera is involved.
  vUV = position.xy * 0.5 + vec2(0.5, 0.5);
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const COMPOSITE_FRAGMENT_GL = /* glsl */ `
precision highp float;
varying vec2 vUV;

uniform vec2  uTexel;
uniform float uEdgeLow;
uniform float uEdgeHigh;
uniform float uEdgeWidth;
uniform float uWhiten;   // how far the camera image is washed towards white
uniform float uDesat;
uniform float uHasVideo;
uniform vec2  uVideoScale;   // cover-crop of the video inside the canvas
uniform float uLineDark;

uniform sampler2D rangeTex;
uniform sampler2D videoTex;

${RANGE_CODEC}

const float LOG_SKY = 13.5;   // "beyond the far plane", so the skyline is an edge too

float logAt(vec2 uv) {
  vec4 p = texture2D(rangeTex, uv);
  if (p.a > 0.5) { return unpackLogRange(p); }
  return LOG_SKY;
}

void main(void) {
  vec2 uv = vUV;

  // --- silhouette ------------------------------------------------------
  vec2 e = uTexel * uEdgeWidth;
  float lc = logAt(uv);
  float lL = logAt(uv - vec2(e.x, 0.0));
  float lR = logAt(uv + vec2(e.x, 0.0));
  float lD = logAt(uv - vec2(0.0, e.y));
  float lU = logAt(uv + vec2(0.0, e.y));
  // Second difference: an even slope cancels, one ridge in front of another
  // does not. The outline therefore comes from the geometry, not the lighting.
  float lap = abs(lL + lR - 2.0 * lc) + abs(lU + lD - 2.0 * lc);
  float edge = smoothstep(uEdgeLow, uEdgeHigh, lap);

  // --- the world behind it ---------------------------------------------
  vec3 ground = vec3(1.0, 1.0, 1.0);
  if (uHasVideo > 0.5) {
    // The video is drawn cover-cropped, matching the CSS object-fit the
    // element would have used, so the overlay geometry lines up with it.
    vec2 cuv = (uv - vec2(0.5, 0.5)) * uVideoScale + vec2(0.5, 0.5);
    vec3 cam = texture2D(videoTex, vec2(cuv.x, 1.0 - cuv.y)).rgb;
    float luma = dot(cam, vec3(0.2126, 0.7152, 0.0722));
    cam = mix(cam, vec3(luma, luma, luma), uDesat);
    ground = mix(cam, vec3(1.0, 1.0, 1.0), uWhiten);
  }

  vec3 ink = vec3(uLineDark, uLineDark, uLineDark);
  gl_FragColor = vec4(mix(ground, ink, edge), 1.0);
}
`;

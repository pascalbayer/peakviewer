/**
 * WGSL for the two passes, in Babylon's dialect.
 *
 * Babylon preprocesses these: `attribute`/`uniform`/`varying` declarations
 * become bindings, inputs arrive as `vertexInputs`/`fragmentInputs`, and
 * outputs are written to `vertexOutputs`/`fragmentOutputs`. A texture declared
 * as `foo` is paired with a sampler named `fooSampler`.
 *
 * Custom uniforms are declared with `uniform name : type;` but *read* through
 * the generated `uniforms` struct. Babylon strips the declarations and gathers
 * them into a uniform buffer during finalisation, so a bare reference is simply
 * an undeclared identifier and the shader will not compile on a device.
 *
 * Every texture here is rgba8unorm on purpose. Float and integer texture
 * formats carry filterability and bind-group-layout conditions that vary by
 * device, and a peak finder that fails to start on a mid-range Android is worse
 * than one that spends three bytes per height sample.
 */

/**
 * Uniform names each material declares. Kept next to the shader source so the
 * build check can prove the two agree — a name that appears in one and not the
 * other fails silently at runtime as an unset uniform.
 */
export const TERRAIN_UNIFORMS = [
  'uAzStep', 'uRadial', 'uRadialB', 'uSinLat0', 'uCosLat0', 'uEyeAlt',
  'uRadius', 'uRefRadius', 'uDropScale', 'uLevelCount', 'uTexSize',
  'uLevelPx', 'uViewProj', 'uFar', 'uLvlA', 'uLvlB',
] as const;

export const COMPOSITE_UNIFORMS = [
  'uTexel', 'uEdgeLow', 'uEdgeHigh', 'uEdgeWidth', 'uWhiten',
  'uDesat', 'uHasVideo', 'uVideoScale', 'uLineDark',
] as const;

/** Height packing shared by the CPU uploader and both shaders. */
export const HEIGHT_BIAS = -1000;

/** Range packing: 24-bit log distance plus a terrain/sky flag in alpha. */
const RANGE_CODEC = /* wgsl */ `
const RANGE_MIN : f32 = 8.0;
const LOG_MIN   : f32 = 2.0794415;
const LOG_SPAN  : f32 = 10.8198;      // log(4.0e5) - log(8)

fn packRange(range : f32, hit : f32) -> vec4<f32> {
  let t = clamp((log(max(range, RANGE_MIN)) - LOG_MIN) / LOG_SPAN, 0.0, 1.0);
  let v = t * 16777215.0;
  let r = floor(v / 65536.0);
  let g = floor((v - r * 65536.0) / 256.0);
  let b = v - r * 65536.0 - g * 256.0;
  return vec4<f32>(r / 255.0, g / 255.0, b / 255.0, hit);
}

fn unpackLogRange(p : vec4<f32>) -> f32 {
  let v = round(p.r * 255.0) * 65536.0 + round(p.g * 255.0) * 256.0 + round(p.b * 255.0);
  return LOG_MIN + (v / 16777215.0) * LOG_SPAN;
}
`;

export const TERRAIN_VERTEX = /* wgsl */ `
// x = azimuth index, y = radial row index. Everything else is derived.
attribute position : vec3<f32>;

uniform uAzStep    : f32;
uniform uRadial    : vec4<f32>;   // jNear, logRatioNear, jSplit, logRatioFar
uniform uRadialB   : vec4<f32>;   // r0, rNearEnd, stepMid, rSplit
uniform uSinLat0   : f32;
uniform uCosLat0   : f32;
uniform uEyeAlt    : f32;
uniform uRadius    : f32;
uniform uRefRadius : f32;
uniform uDropScale : f32;
uniform uLevelCount : f32;
uniform uTexSize   : vec2<f32>;
uniform uLevelPx   : f32;         // pixels per clipmap level in the stacked atlas
uniform uViewProj  : mat4x4<f32>;
uniform uFar       : f32;
uniform uLvlA      : array<vec4<f32>, 8>;   // cx, cy, pxPerRad, maxRange
uniform uLvlB      : array<vec4<f32>, 8>;   // quant, bias, w, h

var heightsSampler : sampler;
var heights        : texture_2d<f32>;

varying vRange : f32;

/**
 * log(1+x) without the cancellation. |x| stays well under 0.12 for the ranges
 * this renderer covers, where six terms are good to about 4e-7.
 */
fn log1p(x : f32) -> f32 {
  return x * (1.0 - x * (0.5 - x * (0.3333333 - x * (0.25 - x * (0.2 - x * 0.1666667)))));
}

/**
 * Sample spacing along a ray, in three segments: geometric near, so the ground
 * at your feet is not one enormous triangle; one DEM post per step through the
 * middle; geometric again far out, tracking the angular step so screen-space
 * triangle size stays roughly constant to the far plane.
 */
fn radiusAt(f : f32) -> f32 {
  if (f < uniforms.uRadial.x) { return uniforms.uRadialB.x * exp(f * uniforms.uRadial.y); }
  if (f < uniforms.uRadial.z) { return uniforms.uRadialB.y + (f - uniforms.uRadial.x) * uniforms.uRadialB.z; }
  return uniforms.uRadialB.w * exp((f - uniforms.uRadial.z) * uniforms.uRadial.w);
}

/** One exact texel out of the stacked clipmap atlas. */
fn texel(lv : i32, x : f32, y : f32) -> f32 {
  let px = clamp(x, 0.0, uniforms.uLevelPx - 1.0);
  let py = clamp(y, 0.0, uniforms.uLevelPx - 1.0) + f32(lv) * uniforms.uLevelPx;
  let uv = vec2<f32>((px + 0.5) / uniforms.uTexSize.x, (py + 0.5) / uniforms.uTexSize.y);
  let c = textureSampleLevel(heights, heightsSampler, uv, 0.0);
  return round(c.r * 255.0) * 256.0 + round(c.g * 255.0);
}

fn sampleLevel(lv : i32, dLon : f32, dIso : f32) -> f32 {
  let A = uniforms.uLvlA[lv];
  let B = uniforms.uLvlB[lv];
  let u = A.x + dLon * A.z;
  let v = A.y - dIso * A.z;
  let f = vec2<f32>(u, v) - vec2<f32>(0.5, 0.5);   // raster pixels are area samples
  let p0 = floor(f);
  let t = f - p0;
  let h00 = texel(lv, p0.x, p0.y);
  let h10 = texel(lv, p0.x + 1.0, p0.y);
  let h01 = texel(lv, p0.x, p0.y + 1.0);
  let h11 = texel(lv, p0.x + 1.0, p0.y + 1.0);
  let h = mix(mix(h00, h10, t.x), mix(h01, h11, t.x), t.y);
  return h * B.x + B.y;
}

@vertex
fn main(input : VertexInputs) -> FragmentInputs {
  let alpha = vertexInputs.position.x * uniforms.uAzStep;
  let r = radiusAt(vertexInputs.position.y);
  let sinA = sin(alpha);
  let cosA = cos(alpha);

  // Great-circle destination at bearing alpha, ground range r — kept entirely
  // in offsets from the observer. Forming sin(lat) and then subtracting
  // sin(lat0), or forming the isometric latitude and subtracting the
  // observer's, cancels two f32 values near 0.93 and then multiplies the
  // wreckage by ~1.7e5 pixels per radian.
  let delta = r / uniforms.uRadius;
  let sinD = sin(delta);
  let cosD = cos(delta);
  let hs = sin(0.5 * delta);
  let hav = hs * hs;
  let ds = uniforms.uCosLat0 * sinD * cosA - 2.0 * uniforms.uSinLat0 * hav;   // sin(lat) - sin(lat0)
  let sinP = clamp(uniforms.uSinLat0 + ds, -1.0, 1.0);
  let dLon = atan2(sinA * sinD * uniforms.uCosLat0, cosD - uniforms.uSinLat0 * sinP);
  // d/dphi of the isometric latitude is sec(phi); in terms of s = sin(phi) the
  // integral is 0.5*log((1+s)/(1-s)), so the offset falls out of ds alone.
  let dIso = 0.5 * (log1p(ds / (1.0 + uniforms.uSinLat0)) - log1p(-ds / (1.0 - uniforms.uSinLat0)));

  // Finest level that still covers this range, cross-faded into the next so an
  // LOD change never shows up as a step in the skyline.
  var lv : i32 = i32(uniforms.uLevelCount) - 1;
  for (var i : i32 = 0; i < 8; i = i + 1) {
    if (f32(i) >= uniforms.uLevelCount) { break; }
    if (r <= uniforms.uLvlA[i].w) { lv = i; break; }
  }
  var h = sampleLevel(lv, dLon, dIso);
  if (f32(lv) + 1.0 < uniforms.uLevelCount) {
    let outer = uniforms.uLvlA[lv].w;
    let fade = smoothstep(outer * 0.86, outer, r);
    if (fade > 0.0) { h = mix(h, sampleLevel(lv + 1, dLon, dIso), fade); }
  }

  let horiz = (uniforms.uRadius + h) * sinD;
  let s = sin(r / (2.0 * uniforms.uRefRadius));
  let drop = 2.0 * (uniforms.uRefRadius + h) * s * s * uniforms.uDropScale;

  let enu = vec3<f32>(horiz * sinA, horiz * cosA, (h - uniforms.uEyeAlt) - drop);
  vertexOutputs.vRange = length(enu);

  var clip = uniforms.uViewProj * vec4<f32>(enu, 1.0);
  // Logarithmic depth, mapped to WebGPU's [0,1] clip range. One 24-bit buffer
  // has to separate a boulder three metres away from a ridge 270 km away.
  clip.z = (log2(max(1e-6, 1.0 + clip.w)) / log2(1.0 + uniforms.uFar)) * clip.w;
  vertexOutputs.position = clip;
}
`;

export const TERRAIN_FRAGMENT = /* wgsl */ `
varying vRange : f32;
${RANGE_CODEC}

@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
  fragmentOutputs.color = packRange(fragmentInputs.vRange, 1.0);
}
`;

export const COMPOSITE_VERTEX = /* wgsl */ `
attribute position : vec3<f32>;
varying vUV : vec2<f32>;

@vertex
fn main(input : VertexInputs) -> FragmentInputs {
  // A fullscreen quad in clip space; no camera is involved.
  vertexOutputs.vUV = vertexInputs.position.xy * 0.5 + vec2<f32>(0.5, 0.5);
  vertexOutputs.position = vec4<f32>(vertexInputs.position.xy, 0.0, 1.0);
}
`;

export const COMPOSITE_FRAGMENT = /* wgsl */ `
varying vUV : vec2<f32>;

uniform uTexel     : vec2<f32>;
uniform uEdgeLow   : f32;
uniform uEdgeHigh  : f32;
uniform uEdgeWidth : f32;
uniform uWhiten    : f32;   // how far the camera image is washed towards white
uniform uDesat     : f32;
uniform uHasVideo  : f32;
uniform uVideoScale : vec2<f32>;   // cover-crop of the video inside the canvas
uniform uLineDark  : f32;

var rangeTexSampler : sampler;
var rangeTex        : texture_2d<f32>;
var videoTexSampler : sampler;
var videoTex        : texture_2d<f32>;

${RANGE_CODEC}

const LOG_SKY : f32 = 13.5;   // "beyond the far plane", so the skyline is an edge too

fn logAt(uv : vec2<f32>) -> f32 {
  let p = textureSample(rangeTex, rangeTexSampler, uv);
  if (p.a > 0.5) { return unpackLogRange(p); }
  return LOG_SKY;
}

@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
  let uv = fragmentInputs.vUV;

  // --- silhouette ------------------------------------------------------
  let e = uniforms.uTexel * uniforms.uEdgeWidth;
  let lc = logAt(uv);
  let lL = logAt(uv - vec2<f32>(e.x, 0.0));
  let lR = logAt(uv + vec2<f32>(e.x, 0.0));
  let lD = logAt(uv - vec2<f32>(0.0, e.y));
  let lU = logAt(uv + vec2<f32>(0.0, e.y));
  // Second difference: an even slope cancels, one ridge in front of another
  // does not. The outline therefore comes from the geometry, not the lighting.
  let lap = abs(lL + lR - 2.0 * lc) + abs(lU + lD - 2.0 * lc);
  let edge = smoothstep(uniforms.uEdgeLow, uniforms.uEdgeHigh, lap);

  // --- the world behind it ---------------------------------------------
  var ground = vec3<f32>(1.0, 1.0, 1.0);
  if (uniforms.uHasVideo > 0.5) {
    // The video is drawn cover-cropped, matching the CSS object-fit the
    // element would have used, so the overlay geometry lines up with it.
    let cuv = (uv - vec2<f32>(0.5, 0.5)) * uniforms.uVideoScale + vec2<f32>(0.5, 0.5);
    var cam = textureSample(videoTex, videoTexSampler, vec2<f32>(cuv.x, 1.0 - cuv.y)).rgb;
    let luma = dot(cam, vec3<f32>(0.2126, 0.7152, 0.0722));
    cam = mix(cam, vec3<f32>(luma, luma, luma), uniforms.uDesat);
    ground = mix(cam, vec3<f32>(1.0, 1.0, 1.0), uniforms.uWhiten);
  }

  let ink = vec3<f32>(uniforms.uLineDark, uniforms.uLineDark, uniforms.uLineDark);
  fragmentOutputs.color = vec4<f32>(mix(ground, ink, edge), 1.0);
}
`;

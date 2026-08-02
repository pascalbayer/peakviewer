/**
 * Geodesy for a long-range terrain view.
 *
 * Everything the renderer needs is expressed in a *polar* frame centred on the
 * observer: a sample is identified by (bearing, ground range). That choice is
 * what keeps the maths well-conditioned — the alternative, differencing two
 * ECEF vectors of magnitude ~6.4e6 m in float32, throws away roughly a metre
 * of precision right where the near terrain needs it most.
 */

export const WGS84_A = 6378137.0;
export const WGS84_F = 1 / 298.257223563;
export const WGS84_B = WGS84_A * (1 - WGS84_F);

/** Mean radius used for the local sphere approximation. */
export const R_MEAN = 6371008.8;

/**
 * Standard terrestrial refraction coefficient. Light bends towards the earth,
 * so a distant summit appears higher than pure geometry predicts; the usual
 * dodge is to keep the ray straight and inflate the earth's radius instead.
 * k = 0.13 is the value surveyors use for daytime sightlines over land.
 */
export const REFRACTION_K = 0.13;

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

/**
 * Radius of the sphere on which a straight sightline reproduces the real,
 * refracted drop-off: R / (1 - k). At 300 km this is worth ~600 m of apparent
 * summit height, which is the difference between seeing a peak and not.
 */
export function effectiveRadius(k = REFRACTION_K): number {
  return R_MEAN / (1 - k);
}

/**
 * Radius of curvature of the ellipsoid at a latitude, averaged over azimuth
 * (the Gaussian mean radius). Using this instead of R_MEAN removes a ~0.3%
 * bias in the curvature drop, i.e. ~20 m at 300 km.
 */
export function localRadius(latDeg: number): number {
  const s = Math.sin(latDeg * DEG);
  const e2 = WGS84_F * (2 - WGS84_F);
  const w = Math.sqrt(1 - e2 * s * s);
  const M = (WGS84_A * (1 - e2)) / (w * w * w); // meridional
  const N = WGS84_A / w; // prime vertical
  return Math.sqrt(M * N);
}

/**
 * Apparent vertical drop of a point `range` metres away, including refraction.
 * Positive = the point sits that far below the observer's horizontal plane
 * purely because the earth curves away.
 */
export function curvatureDrop(range: number, radius: number, k = REFRACTION_K): number {
  const rEff = radius / (1 - k);
  // 2*rEff*sin^2(range/2rEff) is the exact chord drop; it degrades gracefully
  // to range^2/(2*rEff) at short range without any conditional.
  const s = Math.sin(range / (2 * rEff));
  return 2 * rEff * s * s;
}

/** Great-circle destination: start point + bearing + ground range. */
export function destination(
  lonDeg: number, latDeg: number, bearingDeg: number, range: number, radius = R_MEAN,
): { lon: number; lat: number } {
  const d = range / radius;
  const br = bearingDeg * DEG;
  const p0 = latDeg * DEG;
  const sinP0 = Math.sin(p0), cosP0 = Math.cos(p0);
  const sinD = Math.sin(d), cosD = Math.cos(d);
  const sinP = sinP0 * cosD + cosP0 * sinD * Math.cos(br);
  const lat = Math.asin(Math.min(1, Math.max(-1, sinP)));
  const dLon = Math.atan2(Math.sin(br) * sinD * cosP0, cosD - sinP0 * sinP);
  return { lon: lonDeg + dLon * RAD, lat: lat * RAD };
}

/** Great-circle range in metres (haversine — stable at short distances). */
export function groundRange(
  lon1: number, lat1: number, lon2: number, lat2: number, radius = R_MEAN,
): number {
  const dP = (lat2 - lat1) * DEG;
  const dL = (lon2 - lon1) * DEG;
  const a = Math.sin(dP / 2) ** 2
    + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dL / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing from point 1 to point 2, degrees clockwise from north. */
export function bearing(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const p1 = lat1 * DEG, p2 = lat2 * DEG;
  const dL = (lon2 - lon1) * DEG;
  const y = Math.sin(dL) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dL);
  return (Math.atan2(y, x) * RAD + 360) % 360;
}

/**
 * Where a target sits relative to the observer, in the local ENU frame with
 * curvature and refraction folded in. `up` is what the renderer and the label
 * projector both consume, so the two can never disagree about the horizon.
 */
export function localOffset(
  obs: { lon: number; lat: number; alt: number },
  target: { lon: number; lat: number; alt: number },
  k = REFRACTION_K,
): { east: number; north: number; up: number; range: number; bearing: number; elevation: number } {
  const radius = localRadius(obs.lat);
  const range = groundRange(obs.lon, obs.lat, target.lon, target.lat, radius);
  const brg = bearing(obs.lon, obs.lat, target.lon, target.lat);
  const up = target.alt - obs.alt - curvatureDrop(range, radius, k);
  const br = brg * DEG;
  return {
    east: range * Math.sin(br),
    north: range * Math.cos(br),
    up,
    range,
    bearing: brg,
    elevation: Math.atan2(up, range) * RAD,
  };
}

// --------------------------------------------------------------- Web Mercator

export const TILE_SIZE = 256;

export function lonToMercX(lonDeg: number, z: number): number {
  return ((lonDeg + 180) / 360) * TILE_SIZE * (1 << z);
}

export function latToMercY(latDeg: number, z: number): number {
  const s = Math.sin(latDeg * DEG);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE_SIZE * (1 << z);
}

export function mercXToLon(x: number, z: number): number {
  return (x / (TILE_SIZE * (1 << z))) * 360 - 180;
}

export function mercYToLat(y: number, z: number): number {
  const n = Math.PI * (1 - (2 * y) / (TILE_SIZE * (1 << z)));
  return Math.atan(Math.sinh(n)) * RAD;
}

/** Ground sample distance of a Web Mercator pixel, metres. */
export function mercResolution(latDeg: number, z: number): number {
  return (156543.03392804097 * Math.cos(latDeg * DEG)) / (1 << z);
}

/** Isometric latitude — the Mercator y ordinate, before scaling. */
export function isometricLat(latDeg: number): number {
  return Math.log(Math.tan(Math.PI / 4 + (latDeg * DEG) / 2));
}

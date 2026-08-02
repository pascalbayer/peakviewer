/**
 * Where the observer is and which way they are facing.
 *
 * Position and altitude both come from GPS. The vertical fix is the weaker of
 * the two — a phone reports altitude above the WGS84 ellipsoid, which differs
 * from height above sea level by tens of metres depending on where you are,
 * and its accuracy is typically several times the horizontal figure. The app
 * therefore reports the DEM's own value alongside it and falls back to the DEM
 * when the device gives no altitude at all, which is common indoors and on
 * hardware without a barometer.
 *
 * Orientation is magnetometer plus gyroscope. The magnetometer is absolute but
 * noisy and slow; the gyroscope is smooth and fast but drifts. Integrating the
 * gyro between compass updates and bleeding toward the compass with a ~0.7 s
 * time constant gives a heading that neither jitters nor walks away.
 *
 * One caveat is worth naming: the DeviceOrientation Euler sequence is Z-X'-Y'',
 * so at beta = 90 — a phone held upright, which is exactly the AR pose — alpha
 * and gamma both turn about the vertical and neither is well conditioned on its
 * own. The full rotation matrix stays well defined, which is why this code
 * builds it rather than trusting alpha as a heading.
 *
 * What is deliberately absent is any registration against the camera image.
 * Alignment is sensors plus a manual offset the user drags in — which is why
 * that offset exists and why the app shows it rather than hiding it.
 */

import geomagnetism from 'geomagnetism';

export type PoseSource = 'sensors' | 'manual' | 'simulated';

export interface Orientation {
  /** Bearing of the view axis, degrees clockwise from TRUE north. */
  yaw: number;
  /** Positive = looking up, degrees. */
  pitch: number;
  /** Screen roll, degrees. */
  roll: number;
}

export interface PoseStatus {
  source: PoseSource;
  /** Raw compass heading before declination and manual offset, degrees. */
  magneticYaw: number;
  /** Magnetic declination applied, degrees east of true north. */
  declination: number;
  /** Manual correction the user has dragged in, degrees. */
  offset: number;
  /** Browser-reported compass accuracy, degrees, when available. */
  compassAccuracy: number | null;
  /** True when the platform already reports true north (iOS does). */
  headingIsTrue: boolean;
  hasOrientation: boolean;
  hasGyro: boolean;
  permission: 'unknown' | 'granted' | 'denied' | 'unavailable';
  gpsAccuracy: number | null;
  gpsAge: number | null;
  /** Altitude the device reported, metres above the WGS84 ellipsoid. */
  gpsAltitude: number | null;
  gpsAltitudeAccuracy: number | null;
}

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** Magnetic declination at a point, degrees east of true north (WMM). */
export function declinationAt(lon: number, lat: number, when = new Date()): number {
  try {
    return geomagnetism.model(when).point([lat, lon]).decl;
  } catch {
    return 0;
  }
}

/** Shortest signed difference a - b, in (-180, 180]. */
export function angleDelta(a: number, b: number): number {
  return ((a - b + 540) % 360) - 180;
}

/**
 * Device Euler angles to a view direction.
 *
 * The DeviceOrientation frame is east/north/up and the rotation is the
 * intrinsic Z-X'-Y'' sequence alpha, beta, gamma. The camera looks along the
 * device's -Z. `screenAngle` folds in the rotation between the device and what
 * the user sees, so the horizon does not tip over when the phone is turned to
 * landscape.
 */
export function orientationFromEuler(
  alpha: number, beta: number, gamma: number, screenAngle = 0,
): Orientation {
  const a = alpha * DEG, b = beta * DEG, g = gamma * DEG;
  const cA = Math.cos(a), sA = Math.sin(a);
  const cB = Math.cos(b), sB = Math.sin(b);
  const cG = Math.cos(g), sG = Math.sin(g);

  // R = Rz(alpha) * Rx(beta) * Ry(gamma), columns are the device axes in world.
  const m11 = cA * cG - sA * sB * sG, m12 = -cB * sA, m13 = cA * sG + cG * sA * sB;
  const m21 = cG * sA + cA * sB * sG, m22 = cA * cB, m23 = sA * sG - cA * cG * sB;
  const m31 = -cB * sG, m32 = sB, m33 = cB * cG;

  // Device axes in world (east, north, up).
  let rx = m11, ry = m21, rz = m31;      // device +X
  let ux = m12, uy = m22, uz = m32;      // device +Y
  const fx = -m13, fy = -m23, fz = -m33; // device -Z, the way the camera looks

  // Rotate the screen axes about the view axis by the screen orientation.
  if (screenAngle) {
    const s = screenAngle * DEG, cs = Math.cos(s), ss = Math.sin(s);
    const nrx = rx * cs + ux * ss, nry = ry * cs + uy * ss, nrz = rz * cs + uz * ss;
    const nux = ux * cs - rx * ss, nuy = uy * cs - ry * ss, nuz = uz * cs - rz * ss;
    rx = nrx; ry = nry; rz = nrz;
    ux = nux; uy = nuy; uz = nuz;
  }

  const yaw = (Math.atan2(fx, fy) * RAD + 360) % 360;
  const pitch = Math.asin(Math.max(-1, Math.min(1, fz))) * RAD;

  // Roll is how far the screen's up has turned away from the horizon's up.
  const horiz = Math.hypot(fx, fy) || 1e-9;
  // "no-roll" right and up for this view direction
  const nrX = fy / horiz, nrY = -fx / horiz, nrZ = 0;
  const nuX = nrY * fz - nrZ * fy;
  const nuY = nrZ * fx - nrX * fz;
  const nuZ = nrX * fy - nrY * fx;
  const roll = Math.atan2(ux * nrX + uy * nrY + uz * nrZ,
    ux * nuX + uy * nuY + uz * nuZ) * RAD;

  return { yaw, pitch, roll };
}

export interface PoseOptions {
  /** Called whenever position changes enough to matter. */
  onPosition?(lon: number, lat: number, accuracy: number): void;
  /** Called on every orientation update. */
  onOrientation?(o: Orientation): void;
}

export class PoseTracker {
  readonly orientation: Orientation = { yaw: 0, pitch: 0, roll: 0 };
  readonly status: PoseStatus = {
    source: 'manual',
    magneticYaw: 0,
    declination: 0,
    offset: 0,
    compassAccuracy: null,
    headingIsTrue: false,
    hasOrientation: false,
    hasGyro: false,
    permission: 'unknown',
    gpsAccuracy: null,
    gpsAge: null,
    gpsAltitude: null,
    gpsAltitudeAccuracy: null,
  };

  lon = 0;
  lat = 0;

  /** Time constant for pulling the gyro estimate back onto the compass, s. */
  fusionTau = 0.7;
  /** Off only for demonstrating what declination is worth. */
  applyDeclination = true;

  private absolute: Orientation | null = null;
  private lastGyro = 0;
  private lastFix = 0;
  private watchId: number | null = null;
  private detach: (() => void)[] = [];

  constructor(private opt: PoseOptions = {}) {}

  setOffset(deg: number) {
    this.status.offset = ((deg % 360) + 360) % 360;
  }

  nudgeOffset(deltaDeg: number) {
    this.setOffset(this.status.offset + deltaDeg);
  }

  setPosition(lon: number, lat: number, accuracy: number | null = null,
    altitude: number | null = null, altitudeAccuracy: number | null = null) {
    this.lon = lon;
    this.lat = lat;
    this.status.gpsAccuracy = accuracy;
    this.status.gpsAltitude = altitude;
    this.status.gpsAltitudeAccuracy = altitudeAccuracy;
    this.status.declination = declinationAt(lon, lat);
    this.opt.onPosition?.(lon, lat, accuracy ?? 0);
  }

  /** Feeds simulated Euler angles through the same path as a real device. */
  feedSimulated(alpha: number, beta: number, gamma: number, screenAngle = 0) {
    this.status.source = 'simulated';
    this.status.hasOrientation = true;
    this.status.headingIsTrue = false;
    // A real magnetometer reports magnetic north, so the simulated alpha does
    // too — otherwise the declination step would never be exercised.
    this.applyAbsolute(orientationFromEuler(alpha, beta, gamma, screenAngle), true);
    this.absolute = null;               // simulation is exact; no fusion needed
  }

  private applyAbsolute(o: Orientation, magnetic: boolean) {
    this.status.magneticYaw = o.yaw;
    const decl = magnetic && !this.status.headingIsTrue && this.applyDeclination
      ? this.status.declination : 0;
    this.orientation.yaw = (o.yaw + decl + this.status.offset + 720) % 360;
    this.orientation.pitch = o.pitch;
    this.orientation.roll = o.roll;
    this.opt.onOrientation?.(this.orientation);
  }

  /**
   * iOS gates the motion sensors behind a user gesture. Call this from a click
   * handler; on every other platform it resolves immediately.
   */
  async requestPermission(): Promise<boolean> {
    type Req = { requestPermission?: () => Promise<string> };
    const dev = DeviceOrientationEvent as unknown as Req;
    const mot = (window.DeviceMotionEvent ?? {}) as unknown as Req;
    try {
      if (typeof dev.requestPermission === 'function') {
        // Must be reached from a user gesture; see app/permissions.ts, which
        // owns the full flow and the ordering rule this depends on.
        const r = await dev.requestPermission();
        this.status.permission = r === 'granted' ? 'granted' : 'denied';
        if (typeof mot.requestPermission === 'function') await mot.requestPermission();
        return r === 'granted';
      }
      this.status.permission = 'granted';
      return true;
    } catch {
      this.status.permission = 'denied';
      return false;
    }
  }

  start() {
    this.stop();

    const onOrient = (e: DeviceOrientationEvent) => {
      const wk = e as DeviceOrientationEvent & { webkitCompassHeading?: number; webkitCompassAccuracy?: number };
      if (e.alpha === null || e.beta === null || e.gamma === null) return;
      this.status.hasOrientation = true;
      this.status.source = 'sensors';

      let alpha = e.alpha;
      if (typeof wk.webkitCompassHeading === 'number') {
        // iOS reports a true-north heading directly, and its alpha runs the
        // other way; take the heading and skip the declination correction.
        this.status.headingIsTrue = true;
        this.status.compassAccuracy = wk.webkitCompassAccuracy ?? null;
        alpha = 360 - wk.webkitCompassHeading;
      } else {
        this.status.headingIsTrue = false;
      }
      const o = orientationFromEuler(alpha, e.beta, e.gamma, screenAngle());
      this.absolute = o;
      this.applyAbsolute(o, true);
    };

    const onMotion = (e: DeviceMotionEvent) => {
      const r = e.rotationRate;
      if (!r || r.alpha === null) return;
      this.status.hasGyro = true;
      const now = performance.now();
      const dt = this.lastGyro ? Math.min(0.1, (now - this.lastGyro) / 1000) : 0;
      this.lastGyro = now;
      if (!dt || !this.absolute) return;

      // Integrate the yaw rate about the screen normal for immediate response,
      // then bleed back onto the compass so the integration cannot drift away.
      const o = this.orientation;
      o.yaw = (o.yaw - (r.alpha ?? 0) * dt + 720) % 360;
      const k = 1 - Math.exp(-dt / this.fusionTau);
      const decl = this.status.headingIsTrue || !this.applyDeclination
        ? 0 : this.status.declination;
      const targetYaw = (this.absolute.yaw + decl + this.status.offset + 720) % 360;
      o.yaw = (o.yaw + angleDelta(targetYaw, o.yaw) * k + 720) % 360;
      this.opt.onOrientation?.(o);
    };

    window.addEventListener('deviceorientationabsolute', onOrient as EventListener);
    window.addEventListener('deviceorientation', onOrient as EventListener);
    window.addEventListener('devicemotion', onMotion as EventListener);
    this.detach.push(() => {
      window.removeEventListener('deviceorientationabsolute', onOrient as EventListener);
      window.removeEventListener('deviceorientation', onOrient as EventListener);
      window.removeEventListener('devicemotion', onMotion as EventListener);
    });

    this.startWatch();
  }

  /** Position updates on their own — the orientation listeners are separate. */
  startWatch() {
    if (this.watchId !== null) return;
    if (navigator.geolocation) {
      this.watchId = navigator.geolocation.watchPosition(
        (p) => {
          this.lastFix = performance.now();
          this.setPosition(p.coords.longitude, p.coords.latitude, p.coords.accuracy,
            p.coords.altitude, p.coords.altitudeAccuracy);
        },
        () => { this.status.gpsAccuracy = null; },
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
      );
    }
  }

  stop() {
    this.detach.forEach((f) => f());
    this.detach = [];
    if (this.watchId !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
  }

  tick() {
    this.status.gpsAge = this.lastFix ? (performance.now() - this.lastFix) / 1000 : null;
  }
}

export function screenAngle(): number {
  const so = screen.orientation;
  if (so && typeof so.angle === 'number') return so.angle;
  const legacy = (window as unknown as { orientation?: number }).orientation;
  return typeof legacy === 'number' ? legacy : 0;
}

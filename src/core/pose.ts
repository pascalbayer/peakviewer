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
 * A one-euro filter over an angle.
 *
 * Plain exponential smoothing forces a single choice between jitter at rest and
 * lag in motion, and an AR overlay needs to lose on neither: a still phone must
 * not shimmer, and a phone being swung to a new peak must not trail behind the
 * view. So the cutoff rises with the observed rate of change — heavy smoothing
 * while the signal is basically still, progressively less as it genuinely moves.
 *
 * Everything is done through `angleDelta`, so the filter is unaware of the seam
 * at 0/360 and cannot produce the full-circle spin that filtering raw bearings
 * gives you when the user happens to be facing north.
 */
export class AngleFilter {
  private value = NaN;
  private rate = 0;

  /**
   * @param minCutoff Hz. Lower is smoother when still.
   * @param beta      How fast the cutoff opens up with motion.
   * @param rateCutoff Hz, the smoothing on the rate estimate itself.
   */
  constructor(public minCutoff = 1.0, public beta = 0.03, public rateCutoff = 1.0) {}

  reset(to = NaN) {
    this.value = Number.isFinite(to) ? norm180(to) : NaN;
    this.rate = 0;
  }

  get current(): number { return this.value; }

  /**
   * Results come back in (-180, 180]. Pitch and roll are signed quantities and
   * a filter that handed back 350° for ten degrees below the horizon would be
   * clamped to the opposite end of its range by everything downstream.
   */
  filter(target: number, dt: number): number {
    if (!Number.isFinite(this.value)) { this.value = norm180(target); return this.value; }
    if (dt <= 0) return this.value;
    const step = angleDelta(target, this.value);
    this.rate += smoothing(this.rateCutoff, dt) * (step / dt - this.rate);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.rate);
    this.value = norm180(this.value + step * smoothing(cutoff, dt));
    return this.value;
  }
}

/** Exponential weight for a first-order low pass at `cutoff` Hz over `dt` s. */
function smoothing(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

/** To [0, 360). */
function wrap(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** To (-180, 180]. */
function norm180(deg: number): number {
  return ((deg + 540) % 360) - 180;
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
export interface DeviceFrame extends Orientation {
  /**
   * Vertical components of the device's x, y and z axes.
   *
   * Dotted with a device-frame angular rate this gives the rate about *world*
   * up, which is the only part of it that is yaw. It matters because a phone
   * held up at a mountain has its screen normal pointing at the horizon, not at
   * the sky: rotation about that axis is roll, and integrating it as yaw feeds
   * in an error the compass then has to fight.
   */
  upRow: [number, number, number];
}

export function orientationFromEuler(
  alpha: number, beta: number, gamma: number, screenAngle = 0,
): DeviceFrame {
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

  return { yaw, pitch, roll, upRow: [m31, m32, m33] };
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
  /**
   * Above this rate the compass is treated as disturbed and its pull is eased
   * off, degrees per second. A magnetometer near a chairlift or a car door
   * swings tens of degrees in a step; the gyro is right about that interval and
   * the compass is not.
   */
  disturbedRate = 90;
  /** How long a detected disturbance keeps the compass on probation, s. */
  distrustTau = 1.5;

  private target: DeviceFrame | null = null;
  private gyro: { x: number; y: number; z: number } | null = null;
  private yawStarted = false;
  private pitchFilter = new AngleFilter(1.0, 0.03);
  private rollFilter = new AngleFilter(1.2, 0.03);
  private compassFilter = new AngleFilter(0.6, 0.02);
  private lastCompass: number | null = null;
  private distrust = 0;
  /** True once deviceorientationabsolute has fired; the relative twin is then ignored. */
  private sawAbsolute = false;
  private lastSample = 0;
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
    this.feedOrientation(alpha, beta, gamma, screenAngle);
  }

  /**
   * Records a reading. Deliberately does no work beyond the Euler conversion:
   * these arrive at up to 60 Hz and there is no point filtering, fusing or
   * redrawing faster than the display, so everything else happens in `sample`.
   */
  feedOrientation(alpha: number, beta: number, gamma: number, screenAngle = 0) {
    this.status.hasOrientation = true;
    const o = orientationFromEuler(alpha, beta, gamma, screenAngle);
    this.status.magneticYaw = o.yaw;
    this.target = o;
  }

  /** Records the latest angular rate, in the device frame, degrees per second. */
  feedGyro(aboutX: number, aboutY: number, aboutZ: number) {
    this.status.hasGyro = true;
    this.gyro = { x: aboutX, y: aboutY, z: aboutZ };
  }

  /**
   * The DeviceOrientation event path, minus the DOM.
   *
   * Public because the decision it makes — which of the two orientation events
   * to believe — is not a detail. Android fires both, and their alphas are
   * measured from different places: `deviceorientationabsolute` from magnetic
   * north, plain `deviceorientation` from wherever the page happened to start.
   * Taking both alternately swings the heading between two reference frames
   * sixty times a second, which is not noise and no amount of filtering will
   * rescue it.
   */
  handleOrientation(e: {
    alpha: number | null; beta: number | null; gamma: number | null; absolute?: boolean;
    webkitCompassHeading?: number; webkitCompassAccuracy?: number;
  }, fromAbsolute: boolean, screen = 0) {
    if (e.alpha === null || e.beta === null || e.gamma === null) return;
    if (fromAbsolute) this.sawAbsolute = true;
    else if (this.sawAbsolute) return;

    let alpha = e.alpha;
    if (typeof e.webkitCompassHeading === 'number') {
      // iOS reports a true-north heading directly, and its alpha runs the other
      // way; take the heading and skip the declination correction.
      this.status.headingIsTrue = true;
      this.status.compassAccuracy = e.webkitCompassAccuracy ?? null;
      alpha = 360 - e.webkitCompassHeading;
    } else {
      this.status.headingIsTrue = fromAbsolute || e.absolute === true;
    }
    this.feedOrientation(alpha, e.beta, e.gamma, screen);
  }

  /**
   * Advances the fused orientation by `dt` seconds and returns it.
   *
   * Call this once per rendered frame. Sensor events only ever record their
   * reading; the fusion, the filtering and the callback all happen here, which
   * is what keeps a device firing `deviceorientation` and `devicemotion` at
   * 60 Hz apiece from doing 120 rounds of work for 60 frames of display.
   *
   * Yaw is the gyro carrying the fast motion with the compass pulling it back;
   * pitch and roll come from gravity, which is quiet enough to filter directly.
   */
  sample(now = performance.now()): Orientation {
    const dt = this.lastSample ? Math.min(0.25, (now - this.lastSample) / 1000) : 0;
    this.lastSample = now;
    this.status.gpsAge = this.lastFix ? (now - this.lastFix) / 1000 : null;

    const t = this.target;
    const o = this.orientation;
    if (!t) return o;
    if (this.status.source === 'manual') this.status.source = 'sensors';

    const decl = this.status.headingIsTrue || !this.applyDeclination
      ? 0 : this.status.declination;
    const compass = wrap(t.yaw + decl + this.status.offset);

    if (!this.yawStarted || dt <= 0) {
      // Nothing to fuse from yet: take the reading whole rather than easing in
      // from an arbitrary zero, which would swing the view across the compass
      // on the first frame.
      this.yawStarted = true;
      this.compassFilter.reset(compass);
      o.yaw = compass;
      o.pitch = this.pitchFilter.filter(t.pitch, dt || 1 / 60);
      o.roll = this.rollFilter.filter(t.roll, dt || 1 / 60);
      this.opt.onOrientation?.(o);
      return o;
    }

    // The gyro's contribution is the part of its rate that is about world up.
    // Anything else it reports is pitch or roll and is not yaw at all.
    let turned = 0;
    if (this.gyro) {
      const [ux, uy, uz] = t.upRow;
      turned = -(this.gyro.x * ux + this.gyro.y * uy + this.gyro.z * uz) * dt;
      o.yaw = wrap(o.yaw + turned);
    }

    // Ease the compass itself before trusting it, then pull toward it. A
    // magnetometer that is swinging is a magnetometer being lied to by
    // something ferrous, so the harder it swings the less it is allowed to say.
    const eased = this.compassFilter.filter(compass, dt);

    // Is the compass telling the same story as the gyro? A magnetometer near a
    // chairlift pylon or a car door reads tens of degrees off in a step, and
    // the giveaway is that the gyro says the phone did not move. Disagreement
    // between the two is a far better disturbance test than the compass's own
    // swing, which cannot distinguish being lied to from being turned.
    //
    // Distrust decays rather than clearing, because one bad frame means the
    // next several are suspect too. The gyro covers real turning with no lag
    // meanwhile, so being slow to believe the compass costs very little.
    if (this.gyro && this.lastCompass !== null) {
      const disagree = Math.abs(angleDelta(compass, this.lastCompass) - turned) / dt;
      const excess = Math.max(0, disagree - this.disturbedRate);
      this.distrust = Math.max(
        this.distrust * Math.exp(-dt / this.distrustTau),
        Math.min(1, excess / (this.disturbedRate * 4)),
      );
    } else {
      this.distrust = 0;
    }
    this.lastCompass = compass;

    const k = (1 - Math.exp(-dt / this.fusionTau)) * (1 - this.distrust);
    o.yaw = wrap(o.yaw + angleDelta(this.gyro ? eased : compass, o.yaw) * k);

    o.pitch = this.pitchFilter.filter(t.pitch, dt);
    o.roll = this.rollFilter.filter(t.roll, dt);
    this.opt.onOrientation?.(o);
    return o;
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

    const onAbsolute = (e: Event) =>
      this.handleOrientation(e as DeviceOrientationEvent, true, screenAngle());
    const onRelative = (e: Event) =>
      this.handleOrientation(e as DeviceOrientationEvent, false, screenAngle());

    const onMotion = (e: DeviceMotionEvent) => {
      const r = e.rotationRate;
      if (!r || r.alpha === null) return;
      // The spec's alpha, beta and gamma here are rates about the device's z,
      // x and y axes respectively — not the Euler angles of the same names.
      this.feedGyro(r.beta ?? 0, r.gamma ?? 0, r.alpha ?? 0);
    };

    window.addEventListener('deviceorientationabsolute', onAbsolute);
    window.addEventListener('deviceorientation', onRelative);
    window.addEventListener('devicemotion', onMotion as EventListener);
    this.detach.push(() => {
      window.removeEventListener('deviceorientationabsolute', onAbsolute);
      window.removeEventListener('deviceorientation', onRelative);
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

}

export function screenAngle(): number {
  const so = screen.orientation;
  if (so && typeof so.angle === 'number') return so.angle;
  const legacy = (window as unknown as { orientation?: number }).orientation;
  return typeof legacy === 'number' ? legacy : 0;
}

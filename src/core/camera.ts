/** Camera in the observer's local ENU frame: x=east, y=north, z=up. */

const DEG = Math.PI / 180;

export interface CameraState {
  /** Bearing of the view axis, degrees clockwise from true north. */
  yaw: number;
  /** Positive = looking up, degrees. */
  pitch: number;
  /** Screen roll, degrees. */
  roll: number;
  /** Vertical field of view, degrees. */
  fov: number;
}

export class Camera {
  yaw = 0;
  pitch = 0;
  roll = 0;
  fov = 32;
  aspect = 1;
  near = 0.5;
  far = 4.0e5;

  readonly view = new Float32Array(16);
  readonly proj = new Float32Array(16);
  readonly viewProj = new Float32Array(16);

  readonly forward = new Float32Array(3);
  readonly right = new Float32Array(3);
  readonly up = new Float32Array(3);

  set(s: Partial<CameraState>) {
    if (s.yaw !== undefined) this.yaw = s.yaw;
    if (s.pitch !== undefined) this.pitch = Math.max(-89, Math.min(89, s.pitch));
    if (s.roll !== undefined) this.roll = s.roll;
    if (s.fov !== undefined) this.fov = Math.max(2, Math.min(120, s.fov));
  }

  /** Horizontal field of view, degrees. */
  get hfov(): number {
    return (2 * Math.atan(Math.tan((this.fov * DEG) / 2) * this.aspect)) / DEG;
  }

  update() {
    const y = this.yaw * DEG, p = this.pitch * DEG, r = this.roll * DEG;
    const cp = Math.cos(p), sp = Math.sin(p);
    const f = [Math.sin(y) * cp, Math.cos(y) * cp, sp];
    // right = normalize(f x worldUp)
    let rt = [f[1] * 1 - f[2] * 0, f[2] * 0 - f[0] * 1, 0];
    let n = Math.hypot(rt[0], rt[1], rt[2]) || 1;
    rt = [rt[0] / n, rt[1] / n, rt[2] / n];
    let up = [
      rt[1] * f[2] - rt[2] * f[1],
      rt[2] * f[0] - rt[0] * f[2],
      rt[0] * f[1] - rt[1] * f[0],
    ];
    if (r !== 0) {
      const cr = Math.cos(r), sr = Math.sin(r);
      const rt2 = [rt[0] * cr + up[0] * sr, rt[1] * cr + up[1] * sr, rt[2] * cr + up[2] * sr];
      const up2 = [up[0] * cr - rt[0] * sr, up[1] * cr - rt[1] * sr, up[2] * cr - rt[2] * sr];
      rt = rt2; up = up2;
    }
    this.forward.set(f); this.right.set(rt); this.up.set(up);

    // View matrix, column-major, camera at the ENU origin.
    const v = this.view;
    v[0] = rt[0]; v[4] = rt[1]; v[8] = rt[2]; v[12] = 0;
    v[1] = up[0]; v[5] = up[1]; v[9] = up[2]; v[13] = 0;
    v[2] = -f[0]; v[6] = -f[1]; v[10] = -f[2]; v[14] = 0;
    v[3] = 0; v[7] = 0; v[11] = 0; v[15] = 1;

    const t = 1 / Math.tan((this.fov * DEG) / 2);
    const pm = this.proj;
    pm.fill(0);
    pm[0] = t / this.aspect;
    pm[5] = t;
    pm[10] = -(this.far + this.near) / (this.far - this.near);
    pm[11] = -1;
    pm[14] = (-2 * this.far * this.near) / (this.far - this.near);

    mul4(this.viewProj, pm, v);
  }

  /** Project an ENU point to normalised device coords; w<=0 means behind. */
  project(e: number, n: number, u: number, out: Float32Array): number {
    const m = this.viewProj;
    const w = m[3] * e + m[7] * n + m[11] * u + m[15];
    out[0] = (m[0] * e + m[4] * n + m[8] * u + m[12]) / w;
    out[1] = (m[1] * e + m[5] * n + m[9] * u + m[13]) / w;
    out[2] = (m[2] * e + m[6] * n + m[10] * u + m[14]) / w;
    return w;
  }

  /**
   * Smallest bearing arc that contains the whole frustum, so the renderer can
   * skip the ~5/6 of the panorama that is off screen. Returns null when the
   * view is steep enough that every azimuth is potentially visible.
   */
  azimuthArc(marginDeg = 2): { start: number; span: number } | null {
    const th = Math.tan((this.fov * DEG) / 2);
    const tw = th * this.aspect;
    const bearings: number[] = [];
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const d = [
        this.forward[0] + this.right[0] * sx * tw + this.up[0] * sy * th,
        this.forward[1] + this.right[1] * sx * tw + this.up[1] * sy * th,
        this.forward[2] + this.right[2] * sx * tw + this.up[2] * sy * th,
      ];
      const horiz = Math.hypot(d[0], d[1]);
      // A ray within ~6 deg of vertical has an ill-defined bearing; once one
      // corner is that steep the frustum can sweep any azimuth at all.
      if (horiz < 0.1 * Math.abs(d[2])) return null;
      bearings.push((Math.atan2(d[0], d[1]) / DEG + 360) % 360);
    }
    bearings.sort((a, b) => a - b);
    let gapAt = 0, gap = bearings[0] + 360 - bearings[bearings.length - 1];
    for (let i = 1; i < bearings.length; i++) {
      const g = bearings[i] - bearings[i - 1];
      if (g > gap) { gap = g; gapAt = i; }
    }
    const start = bearings[gapAt] - marginDeg;
    const span = 360 - gap + 2 * marginDeg;
    return span >= 360 ? null : { start, span };
  }
}

function mul4(out: Float32Array, a: Float32Array, b: Float32Array) {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
}

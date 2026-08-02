/**
 * Compass rose with the alignment-offset dot orbiting it.
 *
 * The rose turns under a fixed view mark, so north moves and "where you are
 * looking" stays at the top. The orbiting dot is the manual correction the
 * user has dragged in: sensor alignment is the app's weakest link, so the
 * amount of fudge currently applied is shown rather than hidden — a dot far
 * from the top means the compass and the terrain disagree badly.
 */

const TAU = Math.PI * 2;

export class CompassRose {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  size = 78;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'compass';
    this.ctx = this.canvas.getContext('2d')!;
  }

  draw(yaw: number, offset: number, opts: { warn?: boolean } = {}) {
    const dpr = Math.min(devicePixelRatio || 1, 2.5);
    const s = this.size;
    if (this.canvas.width !== s * dpr) {
      this.canvas.width = s * dpr;
      this.canvas.height = s * dpr;
      this.canvas.style.width = `${s}px`;
      this.canvas.style.height = `${s}px`;
    }
    const c = this.ctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, s, s);

    const cx = s / 2, cy = s / 2, r = s / 2 - 11;

    c.fillStyle = 'rgba(8,12,18,.72)';
    c.beginPath();
    c.arc(cx, cy, r + 7, 0, TAU);
    c.fill();
    c.strokeStyle = 'rgba(255,255,255,.16)';
    c.lineWidth = 1;
    c.stroke();

    // Rose, rotating so that the current heading sits at the top.
    c.save();
    c.translate(cx, cy);
    c.rotate((-yaw * Math.PI) / 180);
    for (let b = 0; b < 360; b += 30) {
      const major = b % 90 === 0;
      const a = (b * Math.PI) / 180;
      c.strokeStyle = major ? 'rgba(255,255,255,.8)' : 'rgba(255,255,255,.3)';
      c.lineWidth = major ? 1.5 : 1;
      c.beginPath();
      c.moveTo(Math.sin(a) * (r - (major ? 8 : 4)), -Math.cos(a) * (r - (major ? 8 : 4)));
      c.lineTo(Math.sin(a) * r, -Math.cos(a) * r);
      c.stroke();
    }
    // North needle
    c.fillStyle = '#ff7a5c';
    c.beginPath();
    c.moveTo(0, -r + 2);
    c.lineTo(-4.5, -r + 13);
    c.lineTo(4.5, -r + 13);
    c.closePath();
    c.fill();
    c.restore();

    // Fixed view mark at the top.
    c.fillStyle = '#ffd166';
    c.beginPath();
    c.moveTo(cx, cy - r - 8);
    c.lineTo(cx - 5, cy - r - 1);
    c.lineTo(cx + 5, cy - r - 1);
    c.closePath();
    c.fill();

    // Offset dot: the manual correction, orbiting at its own angle.
    const oa = (offset * Math.PI) / 180;
    const ox = cx + Math.sin(oa) * (r + 7);
    const oy = cy - Math.cos(oa) * (r + 7);
    c.fillStyle = opts.warn ? '#ff7a5c' : '#8ad6ff';
    c.beginPath();
    c.arc(ox, oy, 3.6, 0, TAU);
    c.fill();
    c.strokeStyle = 'rgba(0,0,0,.55)';
    c.lineWidth = 1;
    c.stroke();

    const mag = Math.abs(((offset + 180) % 360) - 180);
    c.fillStyle = mag > 0.5 ? 'rgba(255,255,255,.92)' : 'rgba(255,255,255,.45)';
    c.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(`${mag > 0.5 ? (offset > 180 ? offset - 360 : offset).toFixed(1) : '0.0'}°`, cx, cy);
  }
}

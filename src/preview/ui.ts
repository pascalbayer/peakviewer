/** Preview-page controls. */

export { domReady, el } from '../ui/dom';
import { el } from '../ui/dom';

export class Controls {
  readonly root = el('div', { class: 'ctl' });

  section(title: string): Controls {
    this.root.append(el('div', { class: 'ctl-h' }, title));
    return this;
  }

  chips<T extends { id: string; name: string }>(
    items: T[], initial: string, onPick: (item: T) => void,
  ): Controls {
    const wrap = el('div', { class: 'chips' });
    const buttons = items.map((it) => {
      const b = el('button', {
        class: 'chip' + (it.id === initial ? ' on' : ''), type: 'button',
        onclick: () => {
          wrap.querySelectorAll('.chip').forEach((c) => c.classList.remove('on'));
          b.classList.add('on');
          onPick(it);
        },
      }, it.name);
      return b;
    });
    buttons.forEach((b) => wrap.append(b));
    this.root.append(wrap);
    return this;
  }

  toggle(label: string, initial: boolean, onChange: (v: boolean) => void): Controls {
    const input = el('input', { type: 'checkbox', ...(initial ? { checked: true } : {}) });
    input.addEventListener('change', () => onChange(input.checked));
    this.root.append(el('label', { class: 'row switch' }, el('span', {}, label), input));
    return this;
  }

  slider(
    label: string, min: number, max: number, step: number, value: number,
    onChange: (v: number) => void, fmt: (v: number) => string = (v) => String(v),
  ): { set: (v: number) => void } {
    const out = el('b', {}, fmt(value));
    const input = el('input', { type: 'range', min, max, step, value });
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      out.textContent = fmt(v);
      onChange(v);
    });
    this.root.append(el('div', { class: 'row slider' },
      el('span', {}, label), out, input));
    return {
      set: (v: number) => { input.value = String(v); out.textContent = fmt(v); },
    };
  }

  segmented(label: string, options: string[], initial: string, onPick: (v: string) => void): Controls {
    const wrap = el('div', { class: 'seg' });
    options.forEach((o) => {
      const b = el('button', {
        type: 'button', class: o === initial ? 'on' : '',
        onclick: () => {
          wrap.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
          b.classList.add('on');
          onPick(o);
        },
      }, o);
      wrap.append(b);
    });
    this.root.append(el('div', { class: 'row' }, el('span', {}, label), wrap));
    return this;
  }

  readout(): { set: (rows: [string, string][]) => void } {
    const box = el('div', { class: 'readout' });
    this.root.append(box);
    return {
      set(rows) {
        if (box.childElementCount !== rows.length) {
          box.textContent = '';
          rows.forEach(() => box.append(el('span', {}), el('b', {})));
        }
        rows.forEach(([k, v], i) => {
          box.children[i * 2].textContent = k;
          box.children[i * 2 + 1].textContent = v;
        });
      },
    };
  }

  note(text: string): Controls {
    this.root.append(el('p', { class: 'note' }, text));
    return this;
  }
}

/** Drag to look around, wheel/pinch to change field of view. */
export interface LookTarget {
  yaw: number;
  pitch: number;
  fov: number;
}

export function attachLook(
  canvas: HTMLElement, target: LookTarget, onChange: () => void,
  opts: { onTap?: (x: number, y: number) => void } = {},
) {
  const pts = new Map<number, { x: number; y: number }>();
  let pinch0 = 0, fov0 = 0, moved = 0, downAt = 0;

  const degPerPx = () => target.fov / canvas.clientHeight;

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch0 = Math.hypot(a.x - b.x, a.y - b.y);
      fov0 = target.fov;
    }
    moved = 0;
    downAt = performance.now();
  });

  canvas.addEventListener('pointermove', (e) => {
    const prev = pts.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved += Math.abs(dx) + Math.abs(dy);
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch0 > 4) target.fov = clampFov(fov0 * (pinch0 / d));
    } else {
      target.yaw = (target.yaw + dx * degPerPx() * -1 + 360) % 360;
      target.pitch = Math.max(-80, Math.min(80, target.pitch + dy * degPerPx()));
    }
    onChange();
  });

  const up = (e: PointerEvent) => {
    if (pts.has(e.pointerId) && moved < 8 && performance.now() - downAt < 400) {
      const r = canvas.getBoundingClientRect();
      opts.onTap?.(e.clientX - r.left, e.clientY - r.top);
    }
    pts.delete(e.pointerId);
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    target.fov = clampFov(target.fov * Math.exp(e.deltaY * 0.0012));
    onChange();
  }, { passive: false });
}

export function clampFov(v: number): number {
  return Math.max(3, Math.min(110, v));
}

/** Horizontal bearing ribbon drawn into its own 2D canvas. */
export class CompassRibbon {
  readonly canvas = el('canvas', { class: 'ribbon' });
  private ctx = this.canvas.getContext('2d')!;

  draw(yaw: number, hfov: number) {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    if (this.canvas.width !== w * dpr) {
      this.canvas.width = w * dpr; this.canvas.height = h * dpr;
    }
    const c = this.ctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    const pxPerDeg = w / hfov;
    const names: Record<number, string> = {
      0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW',
    };
    const start = Math.floor((yaw - hfov / 2) / 5) * 5;
    for (let b = start; b <= yaw + hfov / 2 + 5; b += 5) {
      let d = ((b - yaw + 540) % 360) - 180;
      const x = w / 2 + d * pxPerDeg;
      if (x < -40 || x > w + 40) continue;
      const bb = ((b % 360) + 360) % 360;
      const major = bb % 45 === 0;
      c.strokeStyle = major ? 'rgba(255,255,255,.95)' : 'rgba(255,255,255,.45)';
      c.lineWidth = major ? 1.5 : 1;
      c.beginPath();
      c.moveTo(x, h - (major ? 13 : 7));
      c.lineTo(x, h - 1);
      c.stroke();
      if (major) {
        c.fillStyle = bb === 0 ? '#ff8a6a' : 'rgba(255,255,255,.95)';
        c.font = '600 11px ui-sans-serif,system-ui,sans-serif';
        c.textAlign = 'center';
        c.fillText(names[bb] ?? String(bb), x, h - 17);
      }
    }
    c.fillStyle = '#ffd166';
    c.beginPath();
    c.moveTo(w / 2, h - 1); c.lineTo(w / 2 - 5, h - 9); c.lineTo(w / 2 + 5, h - 9);
    c.closePath(); c.fill();
  }
}

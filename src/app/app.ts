/**
 * The app.
 *
 * An AR viewfinder first and a map second: the rear camera fills the frame,
 * washed towards white, with the computed skyline drawn over it as black
 * outlines. Alignment is corrected by dragging — left/right shifts the heading,
 * up/down shifts the pitch — because nothing here registers the drawing against
 * the photograph, and a few degrees of magnetometer error is normal.
 *
 * Written against abstract sources so the installed PWA and the published
 * preview are the same program.
 */

import { PeakViewer } from './viewer';
import { CameraFeed } from './camerafeed';
import { captureFilename, composeCapture, saveImage } from './capture';
import { PoseTracker } from '../core/pose';
import { Peak } from '../core/peaks';
import { fmtRange } from '../core/labels';
import { bearing, groundRange } from '../core/geodesy';
import { ClipmapStreamer, DEFAULT_CLIPMAP } from '../sources/clipmap';
import { TileKey, TileSource } from '../sources/types';
import { TileStore } from '../sources/tilestore';
import {
  PermissionKind, PermissionReport, PermissionState, inspect, recoveryHint, requestAll,
} from './permissions';
import { CompassRose } from '../ui/compass';
import { QUALITY_HIGH, QUALITY_LOW, webgpuAvailable } from '../render/gpu/renderer';
import { el } from '../ui/dom';

export interface DownloadProgress { done: number; total: number; bytes: number }

export interface AppSources {
  label: string;
  tiles: TileSource;
  store: TileStore;
  peaks(lon: number, lat: number, radiusKm: number): Promise<Peak[]>;
  /** Absent when the build cannot reach the network (the preview build). */
  download?(keys: TileKey[], onProgress: (p: DownloadProgress) => void,
    signal: AbortSignal): Promise<DownloadProgress>;
  home: { lon: number; lat: number; name: string };
  places?: { id: string; name: string; lon: number; lat: number; eye: number; yaw?: number }[];
}

export const PRELOAD_KM = 150;
const EYE_HEIGHT = 1.6;

export class App {
  viewer!: PeakViewer;
  readonly pose: PoseTracker;
  readonly feed = new CameraFeed();
  readonly streamer: ClipmapStreamer;
  /** Vertical alignment correction, degrees. The horizontal one lives on the pose. */
  pitchOffset = 0;

  private rose = new CompassRose();
  private stage: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private overlay: HTMLCanvasElement;
  private sheet: HTMLDivElement;
  private tabRow = el('div', { class: 'tabs' });
  private panels: Record<string, HTMLElement> = {};
  private statusBar: HTMLDivElement;
  private card: HTMLDivElement;
  private ribbon: HTMLCanvasElement;
  private hint: HTMLDivElement;
  private shutter: HTMLButtonElement;
  private gate: HTMLDivElement;
  private perms: PermissionReport | null = null;
  private asking = false;

  private followSensors = false;
  private filled = false;
  private dl: AbortController | null = null;
  private note = '';
  private busy = false;
  private adjusting = false;

  constructor(readonly root: HTMLElement, readonly sources: AppSources) {
    this.canvas = el('canvas', { class: 'view' });
    this.overlay = el('canvas', { class: 'labels' });
    this.ribbon = el('canvas', { class: 'ribbon' });
    this.statusBar = el('div', { class: 'status' });
    this.card = el('div', { class: 'card hidden' });
    this.hint = el('div', { class: 'hint' }, 'drag to line the outline up');
    this.gate = el('div', { class: 'gate hidden' });
    this.stage = el('div', { class: 'stage' },
      this.feed.video, this.canvas,
      el('div', { class: 'ovl' }, this.ribbon, this.overlay, this.statusBar,
        this.rose.canvas, this.hint),
      this.card, this.gate);

    this.streamer = new ClipmapStreamer(sources.tiles, DEFAULT_CLIPMAP,
      sources.home.lon, sources.home.lat);

    this.pose = new PoseTracker({
      onPosition: (lon, lat) => { void this.relocate(lon, lat); },
      onOrientation: (o) => {
        if (!this.followSensors || !this.viewer) return;
        this.viewer.camera.set({
          yaw: o.yaw,
          pitch: o.pitch + this.pitchOffset,
          roll: o.roll,
        });
      },
    });

    this.shutter = el('button', {
      class: 'shutter', type: 'button', 'aria-label': 'Capture photo',
      onclick: () => void this.capture(),
    }, el('span', {}));

    this.sheet = el('div', { class: 'sheet' });
    root.append(el('div', { class: 'app' }, this.stage, this.buildBar(), this.sheet));
    this.buildPanels();
    this.attachInput();
  }

  // ------------------------------------------------------------------ chrome

  private buildBar(): HTMLElement {
    const left = el('div', { class: 'actions' },
      this.icon('◎', 'Use my location', () => void this.locate()),
      this.icon('⊕', 'Follow device orientation', () => void this.toggleSensors()),
    );
    const right = el('div', { class: 'actions' },
      this.icon('🔓', 'Device permissions', () => void this.showGate(true)),
      this.icon('↺', 'Reset alignment', () => {
        this.pose.setOffset(0);
        this.pitchOffset = 0;
        this.note = 'alignment reset';
      }),
      this.icon('≡', 'Panels', () => {
        const open = this.sheet.classList.toggle('open');
        if (!open) this.tabRow.querySelectorAll('button').forEach((b) => b.classList.remove('on'));
        else this.openTab('Peaks');
      }),
    );
    return el('div', { class: 'bar' }, left, this.shutter, right);
  }

  private icon(glyph: string, label: string, onClick: () => void): HTMLElement {
    return el('button', {
      type: 'button', class: 'icon', 'aria-label': label, title: label, onclick: onClick,
    }, glyph);
  }

  private openTab(name: string) {
    this.tabRow.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('on', b.textContent === name);
    });
    Object.entries(this.panels).forEach(([k, p]) => p.classList.toggle('hidden', k !== name));
    this.sheet.classList.add('open');
    if (name === 'Offline') void this.refreshOffline();
    if (name === 'Peaks') this.refreshPeakList();
    if (name === 'Check') this.refreshDiagnostics();
    if (name === 'Access') void this.refreshAccess();
  }

  addPanel(name: string, node: HTMLElement) {
    node.classList.add('panel', 'hidden');
    this.panels[name] = node;
    this.sheet.append(node);
    this.tabRow.append(el('button', {
      type: 'button', onclick: () => this.openTab(name),
    }, name));
  }

  private buildPanels() {
    this.sheet.append(this.tabRow);
    for (const n of ['Peaks', 'Camera', 'Access', 'Offline', 'Check', 'About']) {
      this.addPanel(n, el('div', {}));
    }

    this.panels.About.append(
      el('h4', {}, 'What you are looking at'),
      el('p', {}, 'The black outline is computed, not photographed: a 30 m '
        + 'elevation model is rasterised on the GPU in a geocentric frame with '
        + 'atmospheric refraction, and an edge detector runs over the result. '
        + 'The camera image behind it is washed towards white so the lines read.'),
      el('h4', {}, 'Lining it up'),
      el('p', {}, 'Drag left or right to shift the heading, up or down to shift '
        + 'the pitch, until the outline sits on the real ridge. Nothing here '
        + 'matches the drawing to the photograph — alignment is the '
        + 'magnetometer plus whatever you dial in — so a few degrees out is '
        + 'expected, not a fault. Pinch if the middle lines up but the edges '
        + 'do not: that is the lens field of view, not the heading.'),
      el('h4', {}, 'Data'),
      el('p', {}, `Elevation: ${this.sources.tiles.name}. Summits: OpenStreetMap `
        + 'contributors. Position and altitude come from GPS; the elevation '
        + "model's own ground height is shown next to it, because a phone's "
        + 'vertical fix is the weaker half of a satellite fix.'),
    );
  }

  /** Shows a blocking notice in the viewfinder; the rest of the UI stays live. */
  showRendererError(text: string) {
    this.stage.append(el('div', { class: 'stopper' },
      el('h3', {}, 'The renderer could not start'),
      el('pre', {}, text),
      el('p', {}, 'Everything else on this page still works — the access card '
        + 'and the panels below are live — but there is nothing to draw the '
        + 'skyline with until WebGPU is available.')));
    void this.showGate(true);
  }

  // ------------------------------------------------------------ permissions

  /**
   * Shows the access card. `force` opens it even when everything is already
   * granted, so the button in the bar always does something visible.
   */
  async showGate(force: boolean) {
    this.perms = await inspect();
    const p = this.perms;
    const allGood = p.secure
      && p.camera === 'granted'
      && p.location === 'granted'
      && (p.motion === 'granted' || !p.motionNeedsRequest);
    if (allGood && !force) { this.gate.classList.add('hidden'); return; }

    this.renderGate();
    this.gate.classList.remove('hidden');
  }

  private renderGate() {
    const p = this.perms;
    if (!p) return;
    const rows: [PermissionKind, string, string][] = [
      ['camera', 'Camera', 'The view behind the outline, and what the shutter saves.'],
      ['motion', 'Motion & orientation', 'Which way you are pointing, so the skyline follows you.'],
      ['location', 'Location', 'Where you are standing, and how high — the whole view depends on it.'],
    ];

    this.gate.textContent = '';
    this.gate.append(
      el('h2', {}, 'Let the app see where you are'),
      el('p', {}, 'Three permissions, asked once. Nothing is sent anywhere: the '
        + 'elevation model runs on the device and the photos stay on it.'),
    );

    const list = el('div', { class: 'gate-list' });
    for (const [kind, title, why] of rows) {
      const state = p[kind];
      const skip = kind === 'motion' && !p.motionNeedsRequest && state === 'granted';
      list.append(el('div', { class: `gate-row ${state}` },
        el('div', { class: 'gate-mark' }, mark(state)),
        el('div', {},
          el('b', {}, title),
          el('span', {}, skip ? 'Available without a prompt on this device.' : why),
          ...(state === 'denied'
            ? [el('em', {}, recoveryHint(kind))]
            : []))));
    }
    this.gate.append(list);

    if (!p.secure) {
      this.gate.append(el('p', { class: 'gate-warn' },
        'This page is not on a secure origin, so the browser will refuse all '
        + 'three whatever you choose here. Open it over https.'));
    }

    const ask = el('button', {
      class: 'chip on gate-go', type: 'button',
      ...(this.asking ? { disabled: true } : {}),
      onclick: () => void this.runRequest(),
    }, this.asking ? 'Asking…' : 'Allow access');

    this.gate.append(el('div', { class: 'gate-actions' },
      ask,
      el('button', {
        class: 'chip', type: 'button',
        onclick: () => this.gate.classList.add('hidden'),
      }, 'Not now')));

    this.gate.append(el('p', { class: 'gate-fine' },
      'The browser will only ask once. If you refuse, the app keeps working '
      + 'with whatever is left — you can still drag the view by hand — but the '
      + 'prompts will not come back without changing the site settings.'));
  }

  /** Runs the whole request from this tap. Order matters; see permissions.ts. */
  private async runRequest() {
    if (this.asking) return;
    this.asking = true;
    this.renderGate();
    try {
      const res = await requestAll({
        skipCamera: this.feed.status.active,
        onProgress: (kind, state) => {
          if (this.perms) { this.perms[kind] = state; this.renderGate(); }
        },
      });
      this.perms = res;

      if (res.stream) {
        await this.feed.adopt(res.stream);
        this.viewer?.renderer.attachVideo(this.feed.video);
        if (this.viewer) {
          this.viewer.camera.fov = this.feed.renderFovY(
            this.stage.clientWidth, this.stage.clientHeight);
        }
      }
      if (res.motion === 'granted' && !this.followSensors) {
        this.followSensors = true;
        this.pose.start();
      }
      if (res.location === 'granted') this.pose.startWatch();

      this.note = res.notes.length ? res.notes[0] : '';
    } finally {
      this.asking = false;
      this.renderGate();
      const p = this.perms;
      const done = p && p.camera !== 'prompt' && p.location !== 'prompt';
      if (done) setTimeout(() => this.gate.classList.add('hidden'), 700);
    }
  }

  private async refreshAccess() {
    const panel = this.panels.Access;
    if (!panel) return;
    const p = await inspect();
    this.perms = p;
    panel.textContent = '';
    panel.append(el('h4', {}, 'Device access'));
    const rows: [PermissionKind, string][] = [
      ['camera', 'Camera'], ['motion', 'Motion & orientation'], ['location', 'Location'],
    ];
    panel.append(el('div', { class: 'card-rows' },
      ...rows.flatMap(([k, label]) => [el('span', {}, label), el('b', {}, p[k])]),
      el('span', {}, 'Secure origin'), el('b', {}, p.secure ? 'yes' : 'no'),
      el('span', {}, 'Motion needs a prompt'), el('b', {}, p.motionNeedsRequest ? 'yes (iOS)' : 'no')));
    for (const [k, label] of rows) {
      if (p[k] === 'denied') {
        panel.append(el('p', { class: 'muted' }, `${label}: ${recoveryHint(k)}`));
      }
    }
    panel.append(el('div', { class: 'chips' }, el('button', {
      class: 'chip on', type: 'button', onclick: () => void this.showGate(true),
    }, 'Request access')));
  }

  // ------------------------------------------------------------------ input

  private attachInput() {
    const pts = new Map<number, { x: number; y: number }>();
    let pinch = 0, fov0 = 0, moved = 0;
    const degPerPx = () => (this.viewer?.camera.fov ?? 45) / (this.stage.clientHeight || 1);

    this.stage.addEventListener('pointerdown', (e) => {
      this.stage.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
        fov0 = this.viewer?.camera.fov ?? 45;
      }
      moved = 0;
    });

    this.stage.addEventListener('pointermove', (e) => {
      const prev = pts.get(e.pointerId);
      if (!prev || !this.viewer) return;
      const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      moved += Math.abs(dx) + Math.abs(dy);
      const cam = this.viewer.camera;

      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch > 4) cam.fov = clamp(fov0 * (pinch / d), 8, 100);
        return;
      }

      // One finger always means "line the outline up": horizontal shifts the
      // heading, vertical shifts the pitch. Both feed the offsets, so with the
      // sensors driving the view the correction sticks as you turn around.
      const dYaw = -dx * degPerPx();
      const dPitch = dy * degPerPx();
      this.pose.nudgeOffset(dYaw);
      this.pitchOffset = clamp(this.pitchOffset + dPitch, -45, 45);
      cam.yaw = (cam.yaw + dYaw + 360) % 360;
      cam.pitch = clamp(cam.pitch + dPitch, -85, 85);
      if (moved > 10) { this.adjusting = true; this.hint.classList.add('show'); }
    });

    const up = (e: PointerEvent) => {
      if (pts.has(e.pointerId) && moved < 8 && this.viewer) {
        const r = this.stage.getBoundingClientRect();
        this.select(this.viewer.pick(e.clientX - r.left, e.clientY - r.top)?.target.peak ?? null);
      }
      pts.delete(e.pointerId);
      if (!pts.size) {
        this.adjusting = false;
        setTimeout(() => { if (!this.adjusting) this.hint.classList.remove('show'); }, 900);
      }
    };
    this.stage.addEventListener('pointerup', up);
    this.stage.addEventListener('pointercancel', up);
    this.stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!this.viewer) return;
      const cam = this.viewer.camera;
      cam.fov = clamp(cam.fov * Math.exp(e.deltaY * 0.0012), 8, 100);
    }, { passive: false });
  }

  // ------------------------------------------------------------------ state

  async start() {
    if (!webgpuAvailable()) {
      throw new Error('WebGPU is not available in this browser.\n\nThis app renders '
        + 'the terrain with Babylon.js on WebGPU and has no fallback path.\n\n'
        + 'Chrome or Edge 121+, or Safari 26+ on iOS 26+, will run it.');
    }
    const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    this.viewer = await PeakViewer.create(
      { canvas: this.canvas, overlay: this.overlay },
      mobile ? QUALITY_LOW : QUALITY_HIGH,
    );
    this.viewer.setHeightField(this.streamer.heightField);
    this.streamer.onUpdate = () => {
      this.viewer.refreshHeights();
      this.viewer.rebuildTargets();
    };

    await this.relocate(this.sources.home.lon, this.sources.home.lat);
    this.viewer.camera.set({ yaw: 0, pitch: 0, fov: 46 });
    this.loop();
    // Nothing is requested behind the user's back: the gate explains what each
    // permission is for and does the asking from their tap, which is also the
    // only way iOS will hand over the motion sensors.
    void this.showGate(false);
  }

  private async relocate(lon: number, lat: number) {
    const hf = this.streamer.heightField;
    const moved = groundRange(hf.lon, hf.lat, lon, lat);
    if (!this.filled || moved > 30) {
      await this.streamer.setCenter(lon, lat);
      this.filled = true;
    }
    this.viewer?.refreshHeights();
    this.applyAltitude(lon, lat);
    this.pose.lon = lon;
    this.pose.lat = lat;
    void this.loadPeaks(lon, lat);
  }

  /**
   * GPS supplies altitude when it has one. It is the weaker half of a fix — the
   * value is height above the WGS84 ellipsoid, and its accuracy is usually
   * several times the horizontal figure — so the elevation model's own ground
   * height is kept alongside it and used whenever the device reports nothing,
   * which is common indoors and on hardware without a barometer.
   */
  private applyAltitude(lon: number, lat: number) {
    if (!this.viewer) return;
    const dem = this.streamer.heightField.groundAt(lon, lat);
    const gps = this.pose.status.gpsAltitude;
    const useGps = gps !== null && Number.isFinite(gps);
    this.viewer.moveTo(lon, lat, (useGps ? gps! : dem) + EYE_HEIGHT, useGps ? 'gps' : 'dem');
  }

  private async loadPeaks(lon: number, lat: number) {
    try {
      this.viewer?.setPeaks(await this.sources.peaks(lon, lat, 260));
      this.refreshPeakList();
    } catch (e) {
      this.note = e instanceof Error ? e.message : 'summit lookup failed';
    }
  }

  private async locate() {
    if (!navigator.geolocation) { this.note = 'no geolocation here'; return; }
    if (this.perms?.location === 'denied') { void this.showGate(true); return; }
    this.note = 'locating…';
    navigator.geolocation.getCurrentPosition(
      (p) => {
        this.note = '';
        this.pose.setPosition(p.coords.longitude, p.coords.latitude,
          p.coords.accuracy, p.coords.altitude, p.coords.altitudeAccuracy);
      },
      (e) => { this.note = `location: ${e.message}`; },
      { enableHighAccuracy: true, timeout: 20000 },
    );
  }

  private async toggleSensors() {
    this.followSensors = !this.followSensors;
    if (this.followSensors) {
      const ok = await this.pose.requestPermission();
      if (!ok) {
        this.followSensors = false;
        this.note = 'motion access refused';
        void this.showGate(true);
        return;
      }
      this.pose.start();
    } else {
      this.pose.stop();
      this.viewer?.camera.set({ roll: 0 });
    }
  }

  async enableCamera(): Promise<boolean> {
    if (this.feed.status.active) return true;
    const ok = await this.feed.start();
    if (!ok) { this.note = this.feed.status.error ?? 'camera unavailable'; return false; }
    this.viewer?.renderer.attachVideo(this.feed.video);
    if (this.viewer) {
      this.viewer.camera.fov = this.feed.renderFovY(
        this.stage.clientWidth, this.stage.clientHeight);
    }
    return true;
  }

  private async capture() {
    if (!this.viewer || this.busy) return;
    this.busy = true;
    this.shutter.classList.add('firing');
    try {
      const shot = await this.viewer.renderer.capture();
      if (!shot) { this.note = 'capture failed'; return; }
      const hf = this.streamer.heightField;
      const named = this.viewer.placed.slice(0, 3).map((p) => p.target.peak.name).join(' · ');
      const stamp = `${named || 'Peak Finder'} — ${hf.lat.toFixed(4)}, ${hf.lon.toFixed(4)}`
        + ` · ${this.viewer.eyeAltitude.toFixed(0)} m · ${this.viewer.camera.yaw.toFixed(0)}°`;
      const blob = await composeCapture(shot, this.overlay, stamp);
      if (!blob) { this.note = 'capture failed'; return; }
      const outcome = await saveImage(blob,
        captureFilename(hf.lon, hf.lat, this.viewer.camera.yaw));
      this.note = outcome === 'shared' ? 'saved'
        : outcome === 'downloaded' ? 'downloaded'
          : outcome === 'cancelled' ? '' : 'could not save';
      setTimeout(() => { if (this.note === 'saved' || this.note === 'downloaded') this.note = ''; }, 2500);
    } catch (e) {
      this.note = e instanceof Error ? e.message : 'capture failed';
    } finally {
      this.busy = false;
      setTimeout(() => this.shutter.classList.remove('firing'), 220);
    }
  }

  private select(peak: Peak | null) {
    if (!peak || !this.viewer) { this.card.classList.add('hidden'); return; }
    const t = this.viewer.targets.find((x) => x.peak.id === peak.id);
    const hf = this.streamer.heightField;
    const rows: [string, string][] = t
      ? [['Distance', fmtRange(t.range)], ['Bearing', `${t.bearing.toFixed(1)}°`],
        ['Elevation angle', `${t.elevation.toFixed(2)}°`]]
      : [['Distance', fmtRange(groundRange(hf.lon, hf.lat, peak.lon, peak.lat))],
        ['Bearing', `${bearing(hf.lon, hf.lat, peak.lon, peak.lat).toFixed(1)}°`]];
    if (peak.ele !== undefined) rows.push(['Elevation', `${Math.round(peak.ele)} m`]);
    if (peak.demEle !== undefined) rows.push(['DEM at summit', `${Math.round(peak.demEle)} m`]);
    if (peak.prom !== undefined) rows.push(['Prominence', `${peak.prom} m`]);
    rows.push(['Source', peak.src ?? 'unknown']);

    this.card.textContent = '';
    this.card.append(
      el('button', {
        class: 'card-x', type: 'button', 'aria-label': 'Close',
        onclick: () => this.select(null),
      }, '×'),
      el('h3', {}, peak.name),
      el('div', { class: 'card-rows' },
        ...rows.flatMap(([k, v]) => [el('span', {}, k), el('b', {}, v)])),
    );
    this.card.classList.remove('hidden');
  }

  // ----------------------------------------------------------------- panels

  private refreshPeakList() {
    const panel = this.panels.Peaks;
    if (!panel || !this.viewer) return;
    const near = this.viewer.targets.slice(0, 80);
    panel.textContent = '';
    panel.append(el('h4', {}, `${this.viewer.targets.length} in range · `
      + `${this.viewer.visibleCount} not hidden by terrain`));
    if (!near.length) {
      panel.append(el('p', {}, 'No summits in range yet.'));
      return;
    }
    const list = el('div', { class: 'peaklist' });
    for (const t of near) {
      list.append(el('button', {
        type: 'button', class: `peakrow${t.visible ? ' seen' : ''}`,
        onclick: () => { this.select(t.peak); this.sheet.classList.remove('open'); },
      },
      el('b', {}, t.peak.name),
      el('span', {}, `${t.peak.ele !== undefined ? `${Math.round(t.peak.ele)} m · ` : ''}`
        + `${fmtRange(t.range)} · ${t.bearing.toFixed(0)}°`)));
    }
    panel.append(list);
  }

  private refreshCameraPanel() {
    const panel = this.panels.Camera;
    if (!panel || !this.viewer) return;
    const r = this.viewer.renderer;
    panel.textContent = '';
    panel.append(el('h4', {}, 'Camera and overlay'));

    const slider = (label: string, min: number, max: number, step: number,
      value: number, onInput: (v: number) => void, fmt: (v: number) => string) => {
      const out = el('b', {}, fmt(value));
      const input = el('input', { type: 'range', min, max, step, value });
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        out.textContent = fmt(v);
        onInput(v);
      });
      panel.append(el('div', { class: 'row slider' }, el('span', {}, label), out, input));
    };

    panel.append(el('div', { class: 'chips' },
      el('button', {
        class: `chip${this.feed.status.active ? ' on' : ''}`, type: 'button',
        onclick: async () => {
          if (this.feed.status.active) {
            this.feed.stop();
            this.viewer.renderer.attachVideo(null);
          } else {
            await this.enableCamera();
          }
          this.refreshCameraPanel();
        },
      }, this.feed.status.active ? 'Camera on' : 'Turn camera on')));

    slider('Whiten', 0, 0.95, 0.01, r.whiten, (v) => { r.whiten = v; }, (v) => v.toFixed(2));
    slider('Desaturate', 0, 1, 0.01, r.desaturate, (v) => { r.desaturate = v; }, (v) => v.toFixed(2));
    slider('Line weight', 0.5, 3, 0.25, r.edgeWidth, (v) => { r.edgeWidth = v; }, (v) => `${v} px`);
    slider('Detail', 0.005, 0.12, 0.005, r.edgeLow,
      (v) => { r.edgeLow = v; r.edgeHigh = v * 10; }, (v) => v.toFixed(3));
    slider('Lens FOV', 25, 90, 0.5, this.feed.status.fovY, (v) => {
      this.feed.setFov(v);
      this.viewer.camera.fov = this.feed.renderFovY(
        this.stage.clientWidth, this.stage.clientHeight);
    }, (v) => `${v.toFixed(1)}°`);
    panel.append(el('p', {}, 'A wrong lens field of view does not slide the '
      + 'overlay, it scales it about the centre. If the middle sits right and '
      + 'the edges drift, this is the control to reach for.'));
  }

  private refreshDiagnostics() {
    const panel = this.panels.Check;
    if (!panel) return;
    const d = this.viewer?.renderer.diagnostics;
    const s = this.pose.status;
    const f = this.feed.status;
    const rows: [string, string][] = [
      ['WebGPU', webgpuAvailable() ? 'present' : 'missing'],
      ['Engine', d?.engine ?? '—'],
      ['Adapter', d?.adapter ?? '—'],
      ['Clipmap levels', String(d?.levels ?? 0)],
      ['Height atlas', d?.atlas ?? '—'],
      ['Mesh vertices', (d?.vertices ?? 0).toLocaleString()],
      ['Sectors drawn', String(d?.sectorsDrawn ?? 0)],
      ['Render size', d?.size ?? '—'],
      ['Frame', `${(d?.frameMs ?? 0).toFixed(1)} ms`],
      ['Visibility pass', `${(this.viewer?.lastVisibilityMs ?? 0).toFixed(1)} ms`],
      ['Camera', f.active ? `${f.width}×${f.height}` : (f.error ?? 'off')],
      ['Lens FOV', `${f.fovY.toFixed(1)}° (${f.fovSource})`],
      ['GPS accuracy', s.gpsAccuracy === null ? 'no fix' : `±${s.gpsAccuracy.toFixed(0)} m`],
      ['GPS altitude', s.gpsAltitude === null ? 'not reported'
        : `${s.gpsAltitude.toFixed(0)} m ±${(s.gpsAltitudeAccuracy ?? 0).toFixed(0)}`],
      ['DEM ground', `${(this.viewer?.groundBelow ?? 0).toFixed(0)} m`],
      ['Eye altitude', `${(this.viewer?.eyeAltitude ?? 0).toFixed(0)} m `
        + `(${this.viewer?.altitudeSource ?? '—'})`],
      ['Declination', `${s.declination.toFixed(2)}°`],
      ['Heading offset', `${signed(s.offset)}°`],
      ['Pitch offset', `${this.pitchOffset.toFixed(2)}°`],
    ];
    panel.textContent = '';
    panel.append(
      el('h4', {}, 'Diagnostics'),
      el('div', { class: 'card-rows' },
        ...rows.flatMap(([k, v]) => [el('span', {}, k), el('b', {}, v)])),
    );
    if (d?.shaderErrors.length) {
      panel.append(el('h4', {}, 'Device messages'),
        el('pre', { class: 'errbox' }, d.shaderErrors.join('\n')));
    }
    panel.append(el('div', { class: 'chips' }, el('button', {
      class: 'chip', type: 'button', onclick: () => this.refreshDiagnostics(),
    }, 'Refresh')));
  }

  private async refreshOffline() {
    const panel = this.panels.Offline;
    if (!panel) return;
    const hf = this.streamer.heightField;
    const keys = this.streamer.planPreload(hf.lon, hf.lat, PRELOAD_KM);
    const st = await this.sources.store.stats();
    const q = await this.sources.store.quota();

    panel.textContent = '';
    panel.append(
      el('h4', {}, 'Offline coverage'),
      el('p', {}, `A ${PRELOAD_KM} km radius around here is ${keys.length} tiles, `
        + `roughly ${fmtBytes(keys.length * 100 * 1024)}. Tiles fetched while you `
        + 'look around are kept, so this usually downloads far less.'),
      el('div', { class: 'card-rows' },
        el('span', {}, 'Stored tiles'), el('b', {}, String(st.tiles)),
        el('span', {}, 'Stored bytes'), el('b', {}, fmtBytes(st.bytes)),
        el('span', {}, 'Browser usage'), el('b', {}, q ? fmtBytes(q.usage) : '—'),
        el('span', {}, 'Browser quota'), el('b', {}, q ? fmtBytes(q.quota) : '—')),
    );

    const row = el('div', { class: 'chips' });
    if (this.sources.download) {
      row.append(el('button', {
        class: 'chip on', type: 'button',
        onclick: async () => {
          this.dl = new AbortController();
          try {
            const res = await this.sources.download!(keys, (p) => {
              this.note = `downloading ${p.done}/${p.total}`;
            }, this.dl.signal);
            await this.sources.store.putRegion({
              id: `${hf.lon.toFixed(3)},${hf.lat.toFixed(3)}`,
              name: `${PRELOAD_KM} km around ${hf.lat.toFixed(3)}, ${hf.lon.toFixed(3)}`,
              lon: hf.lon, lat: hf.lat, radiusKm: PRELOAD_KM,
              tiles: keys.length, bytes: res.bytes, added: Date.now(),
            });
          } finally {
            this.dl = null;
            this.note = '';
            void this.refreshOffline();
          }
        },
      }, `Download ${PRELOAD_KM} km`));
    } else {
      panel.append(el('p', { class: 'muted' }, 'This build has no network source, '
        + 'so downloading is disabled. The storage figures above are real.'));
    }
    row.append(el('button', {
      class: 'chip', type: 'button',
      onclick: async () => { await this.sources.store.clearTiles(); void this.refreshOffline(); },
    }, 'Clear storage'));
    panel.append(row);
  }

  // ------------------------------------------------------------------- loop

  private loop = () => {
    if (!this.viewer) return;
    const cam = this.viewer.camera;
    this.viewer.render();
    this.drawRibbon(cam.yaw, cam.hfov);
    const off = this.pose.status.offset;
    this.rose.draw(cam.yaw, off, { warn: Math.abs(((off + 180) % 360) - 180) > 8 });
    this.drawStatus();
    if (this.panels.Camera && !this.panels.Camera.classList.contains('hidden')
      && !this.panels.Camera.childElementCount) this.refreshCameraPanel();
    requestAnimationFrame(this.loop);
  };

  private drawStatus() {
    const v = this.viewer;
    const p = this.streamer.progress;
    const bits = [`${v.eyeAltitude.toFixed(0)} m ${v.altitudeSource}`];
    if (p.total && p.done < p.total) bits.unshift(`terrain ${p.done}/${p.total}`);
    if (this.followSensors) bits.push('sensors');
    const off = this.pose.status.offset;
    if (Math.abs(((off + 180) % 360) - 180) > 0.4 || Math.abs(this.pitchOffset) > 0.4) {
      bits.push(`align ${signed(off)}° / ${this.pitchOffset.toFixed(1)}°`);
    }
    if (this.note) bits.push(this.note);
    const text = bits.join('  ·  ');
    if (this.statusBar.textContent !== text) this.statusBar.textContent = text;
  }

  private drawRibbon(yaw: number, hfov: number) {
    const cv = this.ribbon;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    const c = cv.getContext('2d')!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    const pxPerDeg = w / hfov;
    const names: Record<number, string> = {
      0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW',
    };
    for (let b = Math.floor((yaw - hfov / 2) / 5) * 5; b <= yaw + hfov / 2 + 5; b += 5) {
      const d = ((b - yaw + 540) % 360) - 180;
      const x = w / 2 + d * pxPerDeg;
      if (x < -30 || x > w + 30) continue;
      const bb = ((b % 360) + 360) % 360;
      const major = bb % 45 === 0;
      // Dark marks: what is behind them is a whitened photograph.
      c.strokeStyle = major ? 'rgba(12,16,22,.85)' : 'rgba(12,16,22,.4)';
      c.lineWidth = major ? 1.5 : 1;
      c.beginPath(); c.moveTo(x, h - (major ? 12 : 6)); c.lineTo(x, h - 1); c.stroke();
      if (major) {
        c.fillStyle = bb === 0 ? '#b23c1e' : 'rgba(12,16,22,.9)';
        c.font = '600 11px ui-sans-serif, system-ui, sans-serif';
        c.textAlign = 'center';
        c.fillText(names[bb] ?? String(bb), x, h - 16);
      }
    }
    c.fillStyle = '#b23c1e';
    c.beginPath(); c.moveTo(w / 2, h - 1); c.lineTo(w / 2 - 5, h - 9); c.lineTo(w / 2 + 5, h - 9);
    c.closePath(); c.fill();
  }
}

function mark(state: PermissionState): string {
  return state === 'granted' ? '✓' : state === 'denied' ? '✕' : '•';
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function signed(deg: number): string {
  const d = deg > 180 ? deg - 360 : deg;
  return d.toFixed(1);
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

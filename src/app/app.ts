/**
 * The app itself.
 *
 * Written against an abstract pair of sources so the installed PWA and the
 * published preview are the same program: one is wired to AWS Terrain Tiles and
 * Overpass, the other to data already inside the bundle.
 */

import { PeakViewer } from './viewer';
import { CameraFeed } from './camerafeed';
import { PoseTracker } from '../core/pose';
import { Peak } from '../core/peaks';
import { fmtRange } from '../core/labels';
import { bearing, groundRange } from '../core/geodesy';
import { ClipmapStreamer, DEFAULT_CLIPMAP } from '../sources/clipmap';
import { TileKey, TileSource } from '../sources/types';
import { TileStore } from '../sources/tilestore';
import { CompassRose } from '../ui/compass';
import { CAMERA_GROUND, LIGHT_GROUND } from '../ui/labelPainter';
import { el } from '../ui/dom';

export interface DownloadProgress {
  done: number;
  total: number;
  bytes: number;
}

export interface AppSources {
  label: string;
  tiles: TileSource;
  store: TileStore;
  peaks(lon: number, lat: number, radiusKm: number): Promise<Peak[]>;
  /** Absent when the build cannot reach the network (the preview build). */
  download?(keys: TileKey[], onProgress: (p: DownloadProgress) => void,
    signal: AbortSignal): Promise<DownloadProgress>;
  /** Fallback position when there is no fix yet. */
  home: { lon: number; lat: number; name: string };
  /** Extra places the user can jump to; empty in the installed app. */
  places?: { id: string; name: string; lon: number; lat: number; eye: number; yaw?: number }[];
}

export const PRELOAD_KM = 150;

export class App {
  readonly viewer: PeakViewer;
  readonly pose: PoseTracker;
  readonly feed = new CameraFeed();
  readonly streamer: ClipmapStreamer;
  private rose = new CompassRose();

  private stage: HTMLDivElement;
  private overlayCanvas: HTMLCanvasElement;
  private sheet: HTMLDivElement;
  private panels: Record<string, HTMLElement> = {};
  private statusBar: HTMLDivElement;
  private card: HTMLDivElement;
  private ribbonCanvas: HTMLCanvasElement;

  private dirty = true;
  private ar = false;
  private followSensors = false;
  private dl: AbortController | null = null;
  private dlState: DownloadProgress | null = null;
  private note = '';
  private filled = false;

  constructor(readonly root: HTMLElement, readonly sources: AppSources) {
    const canvas = el('canvas', { class: 'view' });
    this.overlayCanvas = el('canvas', { class: 'labels' });
    this.ribbonCanvas = el('canvas', { class: 'ribbon' });
    this.statusBar = el('div', { class: 'status' });
    this.card = el('div', { class: 'card hidden' });
    this.stage = el('div', { class: 'stage' },
      this.feed.video, canvas,
      el('div', { class: 'ovl' }, this.ribbonCanvas, this.statusBar, this.rose.canvas),
      this.card);

    this.viewer = new PeakViewer({ canvas, overlay: this.overlayCanvas });
    this.stage.querySelector('.ovl')!.append(this.overlayCanvas);

    this.streamer = new ClipmapStreamer(sources.tiles, DEFAULT_CLIPMAP,
      sources.home.lon, sources.home.lat);
    this.viewer.setHeightField(this.streamer.heightField);
    this.streamer.onUpdate = () => {
      this.viewer.scene.refreshHeights();
      this.mark();
    };

    this.pose = new PoseTracker({
      onPosition: (lon, lat) => { void this.relocate(lon, lat); },
      onOrientation: (o) => {
        if (!this.followSensors) return;
        this.viewer.camera.set(o);
        this.mark();
      },
    });

    this.sheet = el('div', { class: 'sheet' });
    root.append(el('div', { class: 'app' }, this.stage, this.buildBar(), this.sheet));
    this.buildPanels();
    this.attachInput();
  }

  private mark = () => { this.dirty = true; };

  // ------------------------------------------------------------------ chrome

  /** Registers an extra tab. Used by the preview build for its place picker. */
  addPanel(name: string, node: HTMLElement) {
    node.classList.add('panel', 'hidden');
    this.panels[name] = node;
    this.sheet.append(node);
    this.tabRow.append(this.makeTab(name));
  }

  private tabRow = el('div', { class: 'tabs' });

  private makeTab(name: string): HTMLButtonElement {
    const b = el('button', {
      type: 'button',
      onclick: () => {
        const open = b.classList.contains('on') && this.sheet.classList.contains('open');
        this.tabRow.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        Object.values(this.panels).forEach((p) => p.classList.add('hidden'));
        if (open) { this.sheet.classList.remove('open'); return; }
        b.classList.add('on');
        this.panels[name].classList.remove('hidden');
        this.sheet.classList.add('open');
        if (name === 'Offline') void this.refreshOffline();
        if (name === 'Peaks') this.refreshPeakList();
      },
    }, name);
    return b;
  }

  private buildBar(): HTMLElement {
    const tabs = ['Peaks', 'Offline', 'About'];
    const bar = el('div', { class: 'bar' });
    const actions = el('div', { class: 'actions' },
      this.iconButton('◎', 'Locate me', () => void this.locate()),
      this.iconButton('◐', 'Toggle shading', () => {
        this.viewer.style = this.viewer.style === 'outline' ? 'shaded' : 'outline';
        this.mark();
      }),
      this.iconButton('▣', 'Camera overlay', () => void this.toggleAr()),
      this.iconButton('⊕', 'Follow device', () => void this.toggleSensors()),
    );
    tabs.forEach((t, i) => {
      const b = this.makeTab(t);
      if (i === 0) b.classList.add('on');
      this.tabRow.append(b);
    });
    bar.append(actions, this.tabRow);
    return bar;
  }

  private iconButton(glyph: string, label: string, onClick: () => void): HTMLElement {
    const b = el('button', {
      type: 'button', class: 'icon', 'aria-label': label, title: label, onclick: onClick,
    }, glyph);
    return b;
  }

  private buildPanels() {
    const peaks = el('div', { class: 'panel' });
    const offline = el('div', { class: 'panel hidden' });
    const about = el('div', { class: 'panel hidden' });
    this.panels = { Peaks: peaks, Offline: offline, About: about };
    this.sheet.append(peaks, offline, about);

    about.append(
      el('h4', {}, 'What you are looking at'),
      el('p', {}, 'The skyline is computed, not photographed: a 30 m elevation '
        + 'model is rasterised in a geocentric frame with atmospheric refraction, '
        + 'and the outline you see is an edge detector run over the result. '
        + 'Summits are depth-tested against that same raster, so a peak behind a '
        + 'ridge stays hidden.'),
      el('h4', {}, 'Alignment'),
      el('p', {}, 'Heading comes from the magnetometer and gyroscope with magnetic '
        + 'declination applied. Nothing here looks at the camera image, so the '
        + 'overlay can sit a few degrees off; drag the view to correct it and the '
        + 'dot orbiting the compass shows how much correction is in play.'),
      el('h4', {}, 'Data'),
      el('p', {}, `Elevation: ${this.sources.tiles.name}. Summits: `
        + 'OpenStreetMap contributors. Altitude is sampled from the elevation '
        + 'model rather than taken from the GPS vertical fix, which is routinely '
        + 'tens of metres out.'),
    );
  }

  private attachInput() {
    const pts = new Map<number, { x: number; y: number }>();
    let pinch = 0, fov0 = 0, moved = 0;
    const cam = this.viewer.camera;
    const degPerPx = () => cam.fov / (this.stage.clientHeight || 1);

    this.stage.addEventListener('pointerdown', (e) => {
      this.stage.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
        fov0 = cam.fov;
      }
      moved = 0;
    });
    this.stage.addEventListener('pointermove', (e) => {
      const prev = pts.get(e.pointerId);
      if (!prev) return;
      const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      moved += Math.abs(dx) + Math.abs(dy);
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch > 4) cam.fov = Math.max(4, Math.min(100, fov0 * (pinch / d)));
      } else {
        const dyaw = -dx * degPerPx();
        // While following the device, a drag corrects the alignment rather than
        // fighting the compass — the panorama stays locked to north.
        if (this.followSensors) this.pose.nudgeOffset(dyaw);
        cam.yaw = (cam.yaw + dyaw + 360) % 360;
        if (!this.followSensors) cam.pitch = Math.max(-80, Math.min(80, cam.pitch + dy * degPerPx()));
      }
      this.mark();
    });
    const up = (e: PointerEvent) => {
      if (pts.has(e.pointerId) && moved < 8) {
        const r = this.stage.getBoundingClientRect();
        this.select(this.viewer.pick(e.clientX - r.left, e.clientY - r.top)?.target.peak ?? null);
      }
      pts.delete(e.pointerId);
    };
    this.stage.addEventListener('pointerup', up);
    this.stage.addEventListener('pointercancel', up);
    this.stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      cam.fov = Math.max(4, Math.min(100, cam.fov * Math.exp(e.deltaY * 0.0012)));
      this.mark();
    }, { passive: false });
    new ResizeObserver(this.mark).observe(this.stage);
  }

  // ------------------------------------------------------------------ state

  async start() {
    await this.relocate(this.sources.home.lon, this.sources.home.lat);
    this.viewer.camera.set({ yaw: 0, pitch: -1, fov: 40 });
    this.loop();
  }

  private async relocate(lon: number, lat: number) {
    const hf = this.streamer.heightField;
    const moved = groundRange(hf.lon, hf.lat, lon, lat);
    // The first call has nowhere to move to — the streamer was constructed at
    // this position — but the windows are still empty and must be filled.
    if (!this.filled || moved > 30) {
      await this.streamer.setCenter(lon, lat);
      this.filled = true;
    }
    this.viewer.moveTo(lon, lat, this.viewer.scene.observer.eye);
    this.pose.lon = lon;
    this.pose.lat = lat;
    this.viewer.scene.refreshHeights();
    this.mark();
    void this.loadPeaks(lon, lat);
  }

  private async loadPeaks(lon: number, lat: number) {
    try {
      const peaks = await this.sources.peaks(lon, lat, 260);
      this.viewer.setPeaks(peaks);
      this.mark();
      this.refreshPeakList();
    } catch (e) {
      this.note = e instanceof Error ? e.message : 'summit lookup failed';
    }
  }

  private async locate() {
    if (!navigator.geolocation) { this.note = 'No geolocation in this browser.'; return; }
    this.note = 'locating…';
    navigator.geolocation.getCurrentPosition(
      (p) => {
        this.note = '';
        void this.relocate(p.coords.longitude, p.coords.latitude);
      },
      (e) => { this.note = `location: ${e.message}`; },
      { enableHighAccuracy: true, timeout: 20000 },
    );
  }

  private async toggleSensors() {
    this.followSensors = !this.followSensors;
    if (this.followSensors) {
      const ok = await this.pose.requestPermission();
      if (!ok) { this.followSensors = false; this.note = 'Motion access refused.'; return; }
      this.pose.start();
    } else {
      this.pose.stop();
      this.viewer.camera.set({ roll: 0 });
    }
    this.mark();
  }

  private async toggleAr() {
    this.ar = !this.ar;
    if (this.ar) {
      const ok = await this.feed.start();
      if (!ok) this.note = this.feed.status.error ?? 'camera unavailable';
      this.viewer.camera.fov = this.feed.renderFovY(this.stage.clientWidth, this.stage.clientHeight);
    } else {
      this.feed.stop();
    }
    this.viewer.style = this.ar ? 'ar' : 'outline';
    this.viewer.painter.style = this.ar ? CAMERA_GROUND : LIGHT_GROUND;
    this.viewer.scene.compose.lineColor = this.ar ? [1.0, 0.78, 0.28] : [0.11, 0.14, 0.20];
    this.viewer.scene.compose.edgeWidth = this.ar ? 1.5 : 1;
    this.stage.classList.toggle('ar', this.ar);
    this.mark();
  }

  private select(peak: Peak | null) {
    if (!peak) { this.card.classList.add('hidden'); this.mark(); return; }
    const t = this.viewer.targets.find((x) => x.peak.id === peak.id);
    const rows: [string, string][] = [];
    if (t) {
      rows.push(['Distance', fmtRange(t.range)], ['Bearing', `${t.bearing.toFixed(1)}°`],
        ['Elevation angle', `${t.elevation.toFixed(2)}°`]);
    } else {
      const obs = this.viewer.scene.observer;
      rows.push(['Distance', fmtRange(groundRange(obs.lon, obs.lat, peak.lon, peak.lat))],
        ['Bearing', `${bearing(obs.lon, obs.lat, peak.lon, peak.lat).toFixed(1)}°`]);
    }
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
      el('button', {
        class: 'chip', type: 'button',
        onclick: () => {
          const t2 = this.viewer.targets.find((x) => x.peak.id === peak.id);
          if (t2) {
            this.followSensors = false;
            this.pose.stop();
            this.viewer.camera.set({ yaw: t2.bearing, pitch: t2.elevation, fov: 22 });
            this.mark();
          }
        },
      }, 'Aim at this summit'),
    );
    this.card.classList.remove('hidden');
    this.mark();
  }

  // ----------------------------------------------------------------- panels

  private refreshPeakList() {
    const panel = this.panels.Peaks;
    if (!panel) return;
    // Everything within range, best first — not only what the camera happens to
    // be pointing at. The occlusion probe can only answer for the current
    // frustum, so "on screen now" is a marker on the row, not a filter.
    const near = this.viewer.targets.slice(0, 80);
    const onScreen = this.viewer.placed.length;
    panel.textContent = '';
    panel.append(el('h4', {}, `${this.viewer.targets.length} summits in range`
      + (onScreen ? ` · ${onScreen} labelled ahead` : '')));
    if (!near.length) {
      panel.append(el('p', {}, 'No summits in range yet — the catalogue may '
        + 'still be loading.'));
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

  private async refreshOffline() {
    const panel = this.panels.Offline;
    if (!panel) return;
    const hf = this.streamer.heightField;
    const keys = this.streamer.planPreload(hf.lon, hf.lat, PRELOAD_KM);
    const st = await this.sources.store.stats();
    const q = await this.sources.store.quota();

    panel.textContent = '';
    panel.append(
      el('h4', {}, `Offline coverage`),
      el('p', {}, `A ${PRELOAD_KM} km radius around here is ${keys.length} tiles, `
        + `roughly ${fmtBytes(keys.length * 100 * 1024)}. Tiles already fetched `
        + 'while you look around are kept, so this usually downloads far less.'),
      el('div', { class: 'card-rows' },
        el('span', {}, 'Stored tiles'), el('b', {}, String(st.tiles)),
        el('span', {}, 'Stored bytes'), el('b', {}, fmtBytes(st.bytes)),
        el('span', {}, 'Browser usage'), el('b', {}, q ? fmtBytes(q.usage) : '—'),
        el('span', {}, 'Browser quota'), el('b', {}, q ? fmtBytes(q.quota) : '—'),
        el('span', {}, 'Regions saved'), el('b', {}, String(st.regions.length))),
    );

    const row = el('div', { class: 'chips' });
    if (this.sources.download) {
      if (this.dl) {
        row.append(el('button', {
          class: 'chip', type: 'button',
          onclick: () => { this.dl?.abort(); this.dl = null; void this.refreshOffline(); },
        }, `Stop (${this.dlState?.done ?? 0}/${this.dlState?.total ?? 0})`));
      } else {
        row.append(el('button', {
          class: 'chip on', type: 'button',
          onclick: async () => {
            this.dl = new AbortController();
            void this.refreshOffline();
            try {
              this.dlState = await this.sources.download!(keys, (p) => {
                this.dlState = p;
                this.note = `downloading ${p.done}/${p.total}`;
              }, this.dl.signal);
              await this.sources.store.putRegion({
                id: `${hf.lon.toFixed(3)},${hf.lat.toFixed(3)}`,
                name: `${PRELOAD_KM} km around ${hf.lat.toFixed(3)}, ${hf.lon.toFixed(3)}`,
                lon: hf.lon, lat: hf.lat, radiusKm: PRELOAD_KM,
                tiles: keys.length, bytes: this.dlState.bytes, added: Date.now(),
              });
            } finally {
              this.dl = null;
              this.note = '';
              void this.refreshOffline();
            }
          },
        }, `Download ${PRELOAD_KM} km`));
      }
    } else {
      panel.append(el('p', { class: 'muted' }, 'This build has no network source, '
        + 'so downloading is disabled. The storage figures above are real.'));
    }
    row.append(el('button', {
      class: 'chip', type: 'button',
      onclick: async () => { await this.sources.store.clearTiles(); void this.refreshOffline(); },
    }, 'Clear storage'));
    panel.append(row);

    for (const r of st.regions) {
      panel.append(el('div', { class: 'region' },
        el('b', {}, r.name),
        el('span', {}, `${r.tiles} tiles · ${fmtBytes(r.bytes)}`),
        el('button', {
          type: 'button', class: 'chip',
          onclick: async () => {
            await this.sources.store.deleteRegion(r.id);
            void this.refreshOffline();
          },
        }, 'Forget')));
    }
  }

  // ------------------------------------------------------------------- loop

  private loop = () => {
    const cam = this.viewer.camera;
    const w = this.stage.clientWidth || 1, h = this.stage.clientHeight || 1;
    cam.aspect = w / h;
    if (this.ar && this.feed.status.active) {
      const want = this.feed.renderFovY(w, h);
      if (Math.abs(want - cam.fov) > 0.02) { cam.fov = want; this.dirty = true; }
    }
    cam.update();
    if (this.dirty) { this.viewer.render(); this.dirty = false; }
    this.drawRibbon(cam.yaw, cam.hfov);
    const off = this.pose.status.offset;
    this.rose.draw(cam.yaw, off, { warn: Math.abs(((off + 180) % 360) - 180) > 8 });
    this.drawStatus();
    requestAnimationFrame(this.loop);
  };

  private drawStatus() {
    const obs = this.viewer.scene.observer;
    const p = this.streamer.progress;
    const bits = [
      `${obs.ground.toFixed(0)} m`,
      `${this.viewer.placed.length} labels`,
    ];
    if (p.total && p.done < p.total) bits.unshift(`terrain ${p.done}/${p.total}`);
    if (this.followSensors) bits.push('sensors');
    if (this.note) bits.push(this.note);
    const text = bits.join('  ·  ');
    if (this.statusBar.textContent !== text) this.statusBar.textContent = text;
  }

  private drawRibbon(yaw: number, hfov: number) {
    const cv = this.ribbonCanvas;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const c = cv.getContext('2d')!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    const pxPerDeg = w / hfov;
    const names: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    for (let b = Math.floor((yaw - hfov / 2) / 5) * 5; b <= yaw + hfov / 2 + 5; b += 5) {
      const d = ((b - yaw + 540) % 360) - 180;
      const x = w / 2 + d * pxPerDeg;
      if (x < -30 || x > w + 30) continue;
      const bb = ((b % 360) + 360) % 360;
      const major = bb % 45 === 0;
      c.strokeStyle = major ? 'rgba(255,255,255,.9)' : 'rgba(255,255,255,.4)';
      c.lineWidth = major ? 1.5 : 1;
      c.beginPath(); c.moveTo(x, h - (major ? 12 : 6)); c.lineTo(x, h - 1); c.stroke();
      if (major) {
        c.fillStyle = bb === 0 ? '#ff8a6a' : 'rgba(255,255,255,.95)';
        c.font = '600 11px ui-sans-serif, system-ui, sans-serif';
        c.textAlign = 'center';
        c.fillText(names[bb] ?? String(bb), x, h - 16);
      }
    }
    c.fillStyle = '#ffd166';
    c.beginPath(); c.moveTo(w / 2, h - 1); c.lineTo(w / 2 - 5, h - 9); c.lineTo(w / 2 + 5, h - 9);
    c.closePath(); c.fill();
  }
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

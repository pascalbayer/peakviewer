/**
 * Preview build of the app.
 *
 * The same App class the installed PWA runs. Only the sources differ:
 * elevation comes from a bundled Zermatt region instead of AWS Terrain Tiles,
 * and summits from a baked catalogue instead of Overpass, because a published
 * preview is sandboxed and cannot make external requests. WebGPU, the renderer,
 * the camera overlay, the drag alignment and the capture button are all the
 * shipping code path.
 */

import { PEAKS, REGION } from '../data/generated-gornergrat';
import { loadBakedRegion } from '../data/baked';
import { App, AppSources } from '../app/app';
import { BakedTileSource } from '../sources/bakedsource';
import { TileStore } from '../sources/tilestore';
import { groundRange } from '../core/geodesy';
import { webgpuAvailable } from '../render/gpu/renderer';
import { domReady, el } from '../ui/dom';

async function boot() {
  await domReady();
  const bar = el('i');
  const msg = el('small', {}, 'decoding elevation model…');
  const splash = el('div', { class: 'boot' },
    el('strong', {}, 'Peak Finder'), el('div', { class: 'bar2' }, bar), msg);
  document.body.append(splash);

  const fail = (text: string) => {
    msg.remove();
    splash.append(el('div', { class: 'err' }, text));
  };

  if (!webgpuAvailable()) {
    fail('WebGPU is not available in this browser.\n\nThe renderer is Babylon.js '
      + 'on WebGPU with no fallback path. Chrome or Edge 121+, or Safari 26+ on '
      + 'iOS 26+, will run it.\n\nOn iOS, Settings → Apps → Safari → Advanced → '
      + 'Feature Flags also has a WebGPU switch on some builds.');
    return;
  }

  try {
    const baked = await loadBakedRegion(REGION, (d, t) => {
      bar.style.width = `${Math.round((d / t) * 60)}%`;
      msg.textContent = `decoding elevation level ${d} of ${t}…`;
    });

    const home = REGION.viewpoints[0];
    const sources: AppSources = {
      label: 'bundled demo region',
      tiles: new BakedTileSource(baked),
      store: new TileStore(),
      home: { lon: home.lon, lat: home.lat, name: home.name },
      places: REGION.viewpoints,
      async peaks(lon, lat, radiusKm) {
        return PEAKS.filter((p) => groundRange(lon, lat, p.lon, p.lat) <= radiusKm * 1000);
      },
    };

    msg.textContent = 'starting WebGPU…';
    bar.style.width = '75%';
    const app = new App(document.body, sources);
    addPlaces(app, sources);
    (window as unknown as Record<string, unknown>).peak = { app };

    try {
      await app.start();
      app.viewer.camera.set({ yaw: home.yaw ?? 0, pitch: 0 });
      (window as unknown as Record<string, unknown>).peak = { app, viewer: app.viewer };
    } catch (e) {
      // The renderer is the one part that can fail on an otherwise fine device.
      // Keep the shell up so the message, the access card and the notes on what
      // the app needs are all still reachable, rather than dying on a splash.
      app.showRendererError(e instanceof Error ? e.message : String(e));
    }

    bar.style.width = '100%';
    splash.style.opacity = '0';
    setTimeout(() => splash.remove(), 400);
  } catch (e) {
    // Show the message plainly; the stack only helps if it is not one of the
    // expected environment failures.
    const msg = e instanceof Error ? e.message : String(e);
    const expected = /WebGPU/i.test(msg);
    fail(expected ? msg : `${msg}\n\n${e instanceof Error ? e.stack ?? '' : ''}`);
  }
}

function addPlaces(app: App, sources: AppSources) {
  if (!sources.places) return;
  const row = el('div', { class: 'chips' });
  for (const p of sources.places) {
    row.append(el('button', {
      class: 'chip', type: 'button',
      onclick: () => {
        app.viewer.camera.set({ yaw: p.yaw ?? 0, pitch: 0 });
        // In through the same door a GPS fix would use.
        app.pose.setPosition(p.lon, p.lat);
      },
    }, p.name));
  }
  app.addPanel('Places', el('div', {},
    el('h4', {}, 'Demo viewpoints'), row,
    el('p', {}, 'The installed app takes this from GPS. The preview carries one '
      + 'valley, so it offers places instead. Point the camera at a real ridge '
      + 'and the outline will be the wrong mountain — the geometry is Zermatt.')));
}

void boot();

/**
 * Step 6 preview — the finished app.
 *
 * Byte for byte the same App class the installed PWA runs. Only the two
 * sources differ: elevation comes from the bundled Zermatt region instead of
 * AWS Terrain Tiles, and summits from the baked catalogue instead of Overpass,
 * because a published preview is sandboxed and cannot make external requests.
 * Everything else — streaming, occlusion, pose, AR, storage, the offline
 * panel — is the shipping code path.
 */

import { PEAKS, REGION } from '../data/generated-gornergrat';
import { loadBakedRegion } from '../data/baked';
import { App, AppSources } from '../app/app';
import { BakedTileSource } from '../sources/bakedsource';
import { TileStore } from '../sources/tilestore';
import { groundRange } from '../core/geodesy';
import { domReady, el } from '../ui/dom';

async function boot() {
  await domReady();
  const bar = el('i');
  const msg = el('small', {}, 'decoding elevation model…');
  const splash = el('div', { class: 'boot' },
    el('strong', {}, 'Peak Finder'), el('div', { class: 'bar2' }, bar), msg);
  document.body.append(splash);

  try {
    const baked = await loadBakedRegion(REGION, (d, t) => {
      bar.style.width = `${Math.round((d / t) * 70)}%`;
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
        return PEAKS.filter((p) =>
          groundRange(lon, lat, p.lon, p.lat) <= radiusKm * 1000);
      },
      // No download(): this build has no network, and the offline panel says so
      // rather than offering a button that cannot work.
    };

    msg.textContent = 'streaming terrain…';
    bar.style.width = '80%';
    const app = new App(document.body, sources);
    await app.start();
    app.viewer.camera.set({ yaw: home.yaw ?? 0, pitch: -1, fov: 40 });

    // The preview gets a place picker the installed app does not need — it has
    // GPS, this has one valley.
    addPlaces(app, sources);

    bar.style.width = '100%';
    splash.style.opacity = '0';
    setTimeout(() => splash.remove(), 400);
    (window as unknown as Record<string, unknown>).peak = { app, viewer: app.viewer };
  } catch (e) {
    msg.remove();
    splash.append(el('div', { class: 'err' },
      e instanceof Error ? `${e.message}\n\n${e.stack ?? ''}` : String(e)));
  }
}

function addPlaces(app: App, sources: AppSources) {
  if (!sources.places) return;
  const row = el('div', { class: 'chips' });
  for (const p of sources.places) {
    row.append(el('button', {
      class: 'chip', type: 'button',
      onclick: () => {
        app.viewer.camera.set({ yaw: p.yaw ?? 0, pitch: -1 });
        // Goes in through the same door a GPS fix would.
        app.pose.setPosition(p.lon, p.lat);
      },
    }, p.name));
  }
  app.addPanel('Places', el('div', {},
    el('h4', {}, 'Demo viewpoints'), row,
    el('p', {}, 'The installed app takes this from GPS. The preview carries one '
      + 'valley, so it offers places instead.')));
}

void boot();

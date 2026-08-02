/**
 * PWA entry point: the app wired to live sources.
 *
 * Elevation streams from AWS Terrain Tiles and summits come from OpenStreetMap
 * via Overpass. Both cache to the device, so a region visited once keeps
 * working with the network off.
 */

import { App, AppSources, DownloadProgress } from './app/app';
import { OverpassPeaks } from './sources/overpass';
import { TerrariumSource } from './sources/terrarium';
import { TileStore } from './sources/tilestore';
import { TileKey } from './sources/types';
import { domReady, el } from './ui/dom';

const HOME = { lon: 7.78472, lat: 45.98333, name: 'Gornergrat' };

async function boot() {
  await domReady();
  const bar = el('i');
  const msg = el('small', {}, 'starting…');
  const boot0 = el('div', { class: 'boot' },
    el('strong', {}, 'Peak Finder'), el('div', { class: 'bar2' }, bar), msg);
  document.body.append(boot0);

  try {
    const store = new TileStore();
    const tiles = new TerrariumSource({ store });
    const peaks = new OverpassPeaks();

    const sources: AppSources = {
      label: 'live',
      tiles,
      store,
      home: HOME,
      peaks: (lon, lat, r) => peaks.around(lon, lat, r),
      async download(keys: TileKey[], onProgress, signal): Promise<DownloadProgress> {
        const state: DownloadProgress = { done: 0, total: keys.length, bytes: 0 };
        // The source caps concurrency itself; this just feeds it and reports.
        await Promise.all(keys.map(async (k) => {
          if (signal.aborted) return;
          state.bytes += await tiles.prefetch(k, signal);
          state.done++;
          if (state.done % 5 === 0 || state.done === state.total) onProgress({ ...state });
        }));
        return state;
      },
    };

    msg.textContent = 'starting the renderer…';
    bar.style.width = '40%';
    const app = new App(document.body, sources);
    try {
      await app.start();
    } catch (e) {
      // Keep the shell: the access card and the requirements are still useful
      // even when the renderer will not start on this device.
      app.showRendererError(e instanceof Error ? e.message : String(e));
    }
    bar.style.width = '100%';
    boot0.style.opacity = '0';
    setTimeout(() => boot0.remove(), 400);

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => { /* offline shell is optional */ });
    }
    (window as unknown as Record<string, unknown>).peak = { app, tiles, peaks, store };
  } catch (e) {
    msg.remove();
    boot0.append(el('div', { class: 'err' },
      e instanceof Error ? `${e.message}\n\n${e.stack ?? ''}` : String(e)));
  }
}

void boot();

/**
 * Step 5 preview — streaming and offline storage.
 *
 * The installed app fills its clipmap from AWS Terrain Tiles over the network.
 * This page cannot reach the network — a published preview is sandboxed with no
 * external requests allowed — so it runs the *same* ClipmapStreamer against the
 * bundled region dressed up as a tile source. What is under test is the
 * streaming machinery: window placement, re-centring when the observer moves,
 * coarse-before-fine fill order, and incremental GPU upload.
 *
 * The storage panel is not a mock. It talks to the same IndexedDB store the
 * app uses, so quota, writes, stats and eviction are real here.
 */

import { PEAKS, REGION } from '../data/generated-gornergrat';
import { loadBakedRegion } from '../data/baked';
import { destination, groundRange, mercResolution } from '../core/geodesy';
import { BakedTileSource } from '../sources/bakedsource';
import { ClipmapStreamer, DEFAULT_CLIPMAP } from '../sources/clipmap';
import { TileStore } from '../sources/tilestore';
import { ClipmapMap } from '../ui/clipmapMap';
import { PeakViewer } from '../app/viewer';
import { buildShell } from './shell';
import { attachLook, domReady, el } from './ui';

const PRELOAD_KM = 150;

async function main() {
  await domReady();
  const shell = buildShell('Peak Finder · Step 5 — streaming & offline');
  try {
    const baked = await loadBakedRegion(REGION, (d, t) => {
      shell.setProgress(d / t, `decoding elevation level ${d} of ${t}…`);
    });

    const source = new BakedTileSource(baked);
    const streamer = new ClipmapStreamer(source, DEFAULT_CLIPMAP,
      REGION.viewpoints[0].lon, REGION.viewpoints[0].lat);
    const store = new TileStore();

    const overlay = el('canvas', { class: 'labels' });
    shell.overlay.append(overlay);
    const viewer = new PeakViewer({ canvas: shell.canvas, overlay });
    viewer.setHeightField(streamer.heightField);
    viewer.setPeaks(PEAKS);
    const cam = viewer.camera;

    let dirty = true;
    const mark = () => { dirty = true; };
    new ResizeObserver(mark).observe(shell.stage);
    attachLook(shell.stage, cam, mark, { onTap: (x, y) => { viewer.pick(x, y); mark(); } });

    streamer.onUpdate = () => {
      viewer.scene.refreshHeights();
      viewer.moveTo(streamer.heightField.lon, streamer.heightField.lat,
        viewer.scene.observer.eye);
      mark();
    };

    let lon = REGION.viewpoints[0].lon;
    let lat = REGION.viewpoints[0].lat;
    const goTo = async (nlon: number, nlat: number) => {
      lon = nlon; lat = nlat;
      await streamer.setCenter(lon, lat);
      viewer.moveTo(lon, lat, viewer.scene.observer.eye);
      viewer.scene.refreshHeights();
      mark();
    };

    const plan = new ClipmapMap((east, north) => {
      const rng = Math.hypot(east, north);
      const brg = (Math.atan2(east, north) * 180) / Math.PI;
      const p = destination(lon, lat, brg, rng);
      void goTo(p.lon, p.lat);
    });
    shell.stage.append(plan.canvas);

    const c = shell.controls;
    c.section('Observer').chips(REGION.viewpoints, REGION.viewpoints[0].id, (v) => {
      cam.set({ yaw: v.yaw ?? 0, pitch: -1 });
      void goTo(v.lon, v.lat);
    });
    c.note('Click anywhere on the plan view to move the observer. Each level '
      + 'whose window shifts is refetched, coarsest first, and pushed to the GPU '
      + 'on its own — levels that did not move are left alone.');

    c.section('Clipmap');
    const levelBox = el('div', { class: 'readout' });
    c.root.append(levelBox);

    c.section('Offline region');
    const planNote = el('p', { class: 'note' });
    const storeRows = c.readout();
    c.root.append(planNote);

    const refreshStore = async () => {
      const st = await store.stats();
      const q = await store.quota();
      storeRows.set([
        ['Backing store', store.unavailable ? 'unavailable' : 'IndexedDB'],
        ['Tiles held', `${st.tiles}`],
        ['Bytes held', fmtBytes(st.bytes)],
        ['Saved regions', `${st.regions.length}`],
        ['Browser usage', q ? fmtBytes(q.usage) : 'not reported'],
        ['Browser quota', q ? fmtBytes(q.quota) : 'not reported'],
      ]);
    };

    const showPlan = () => {
      const keys = streamer.planPreload(lon, lat, PRELOAD_KM);
      const byZoom = new Map<number, number>();
      for (const k of keys) byZoom.set(k.z, (byZoom.get(k.z) ?? 0) + 1);
      const breakdown = [...byZoom.entries()].sort((a, b) => b[0] - a[0])
        .map(([z, n]) => `z${z}: ${n}`).join(' · ');
      planNote.textContent = `A ${PRELOAD_KM} km preload around this position is `
        + `${keys.length} tiles (${breakdown}), roughly `
        + `${fmtBytes(keys.length * 100 * 1024)} at typical terrarium sizes. `
        + 'In the installed app these come from AWS Terrain Tiles; this page has '
        + 'no network, so the button below stores the clipmap it already has.';
    };

    const btnRow = el('div', { class: 'chips' });
    btnRow.append(
      el('button', {
        class: 'chip', type: 'button',
        onclick: async () => {
          // Genuinely writes to IndexedDB, so quota and stats below are real.
          let bytes = 0;
          for (const lv of streamer.heightField.levels) {
            const id = `local/${lv.z}/${lv.px0}/${lv.py0}`;
            await store.put(id, lv.raw.slice().buffer);
            bytes += lv.raw.byteLength;
          }
          await store.putRegion({
            id: `zermatt:${lon.toFixed(3)},${lat.toFixed(3)}`,
            name: 'Zermatt (from bundled data)',
            lon, lat, radiusKm: PRELOAD_KM,
            tiles: streamer.heightField.levels.length,
            bytes, added: Date.now(),
          });
          await refreshStore();
        },
      }, 'Store current clipmap'),
      el('button', {
        class: 'chip', type: 'button',
        onclick: async () => { await store.clearTiles(); await refreshStore(); },
      }, 'Clear storage'),
    );
    c.root.append(btnRow);

    c.section('View');
    c.toggle('Show labels', true, (v) => { viewer.showLabels = v; mark(); });
    c.slider('Field of view', 4, 100, 0.5, cam.fov,
      (v) => { cam.fov = v; mark(); }, (v) => `${v.toFixed(1)}°`);
    c.slider('Plan view span', 50, 400, 10, 300,
      (v) => { plan.span = v * 1000; }, (v) => `${v} km`);

    await goTo(lon, lat);
    cam.set({ yaw: REGION.viewpoints[0].yaw ?? 0, pitch: -1 });
    showPlan();
    await refreshStore();

    let lastStats = 0;
    const loop = () => {
      cam.aspect = (shell.canvas.clientWidth || 1) / (shell.canvas.clientHeight || 1);
      cam.update();
      if (dirty) { viewer.render(); dirty = false; }
      shell.ribbon.draw(cam.yaw, cam.hfov);
      plan.draw(streamer.heightField, streamer.progress);

      const now = performance.now();
      if (now - lastStats > 250) {
        lastStats = now;
        const p = streamer.progress;
        shell.setBadges([
          ['brg', `${cam.yaw.toFixed(1)}°`],
          ['tiles', `${p.done}/${p.total}`],
          ['levels', `${p.levelsReady}/${streamer.heightField.levels.length}`],
          ['ms', viewer.scene.stats.frameMs.toFixed(1)],
        ]);
        const drift = groundRange(REGION.origin.lon, REGION.origin.lat, lon, lat);
        levelBox.textContent = '';
        streamer.heightField.levels.forEach((lv) => {
          const res = mercResolution(lat, lv.z);
          levelBox.append(
            el('span', {}, `z${lv.z} · ${res < 100 ? res.toFixed(0) : Math.round(res)} m`),
            el('b', {}, `±${(((lv.w / 2) * res) / 1000).toFixed(1)} km`),
          );
        });
        levelBox.append(
          el('span', {}, 'usable range'),
          el('b', {}, `${(streamer.heightField.maxRange / 1000).toFixed(0)} km`),
          el('span', {}, 'tiles served'),
          el('b', {}, `${source.stats.served}`),
          el('span', {}, 'outside region'),
          el('b', {}, `${source.stats.missing}`),
          el('span', {}, 'moved from centre'),
          el('b', {}, `${(drift / 1000).toFixed(1)} km`),
        );
      }
      requestAnimationFrame(loop);
    };

    (window as unknown as Record<string, unknown>).peak = {
      viewer, cam, mark, streamer, store, goTo, source, scene: viewer.scene,
    };
    shell.done();
    loop();
  } catch (err) {
    shell.fail(err);
    throw err;
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

main();

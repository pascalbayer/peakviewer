/**
 * Step 2 preview — naming what you can see.
 *
 * The check this page supports: does the right name land on the right summit,
 * and does a peak hidden behind a ridge stay hidden? "Ignore terrain" turns the
 * depth test off so you can watch summits that are genuinely behind the
 * skyline reappear where they would be if occlusion were not handled.
 */

import { PEAKS, REGION } from '../data/generated-gornergrat';
import { loadBakedRegion } from '../data/baked';
import { fmtRange } from '../core/labels';
import type { Style } from '../render/compose';
import { PeakViewer } from '../app/viewer';
import { buildShell } from './shell';
import { attachLook, domReady, el } from './ui';

async function main() {
  await domReady();
  const shell = buildShell('Peak Finder · Step 2 — summit labels');
  try {
    const hf = await loadBakedRegion(REGION, (d, t) => {
      shell.setProgress(d / t, `decoding elevation level ${d} of ${t}…`);
    });

    const overlay = el('canvas', { class: 'labels' });
    shell.overlay.append(overlay);
    const viewer = new PeakViewer({ canvas: shell.canvas, overlay });
    viewer.setHeightField(hf);
    viewer.setPeaks(PEAKS);

    const cam = viewer.camera;
    const card = el('div', { class: 'card hidden' });
    shell.stage.append(card);

    let dirty = true;
    const mark = () => { dirty = true; };
    new ResizeObserver(mark).observe(shell.stage);

    const showCard = () => {
      const sel = viewer.selected;
      if (!sel) { card.classList.add('hidden'); return; }
      const t = sel.target;
      const p = t.peak;
      const dem = p.demEle;
      const rows: [string, string][] = [
        ['Distance', fmtRange(t.range)],
        ['Bearing', `${t.bearing.toFixed(1)}°`],
        ['Elevation angle', `${t.elevation.toFixed(2)}°`],
      ];
      if (p.ele !== undefined) rows.push(['Catalogue elevation', `${p.ele} m`]);
      if (dem !== undefined) rows.push(['DEM at summit', `${dem} m`]);
      if (p.ele !== undefined && dem !== undefined) {
        rows.push(['Model deficit', `${Math.round(p.ele - dem)} m`]);
      }
      if (p.prom !== undefined) rows.push(['Prominence', `${p.prom} m`]);
      rows.push(['Source', p.src ?? 'unknown']);

      card.textContent = '';
      card.append(
        el('button', {
          class: 'card-x', type: 'button', 'aria-label': 'Close',
          onclick: () => { viewer.selected = null; showCard(); mark(); },
        }, '×'),
        el('h3', {}, p.name),
        el('div', { class: 'card-rows' },
          ...rows.flatMap(([k, v]) => [el('span', {}, k), el('b', {}, v)])),
      );
      card.classList.remove('hidden');
    };

    attachLook(shell.stage, cam, mark, {
      onTap: (x, y) => {
        viewer.pick(x, y);
        showCard();
        mark();
      },
    });

    const c = shell.controls;
    const vps = REGION.viewpoints;
    const apply = (v: (typeof vps)[number]) => {
      viewer.moveTo(v.lon, v.lat, v.eye);
      cam.set({ yaw: v.yaw ?? 0, pitch: -1 });
      viewer.selected = null;
      showCard();
      mark();
    };
    c.section('Viewpoint').chips(vps, vps[0].id, apply);

    c.section('Labels');
    c.toggle('Show labels', true, (v) => { viewer.showLabels = v; mark(); });
    c.slider('Max on screen', 4, 60, 1, viewer.maxLabels,
      (v) => { viewer.maxLabels = v; mark(); }, (v) => String(v));
    c.slider('With detail line', 0, 30, 1, viewer.detailedLabels,
      (v) => { viewer.detailedLabels = v; mark(); }, (v) => String(v));
    c.slider('Label range', 20, 270, 5, 260,
      (v) => { viewer.labelRange = v * 1000; viewer.rebuildTargets(); mark(); },
      (v) => `${v} km`);

    c.section('Occlusion');
    c.toggle('Depth-test against terrain', true, (v) => {
      // A huge tolerance makes every probe pass: label everything in frustum.
      viewer.occlusionTolerance = v ? 1.03 : 1e9;
      mark();
    });
    c.note('Summits are drawn as single points into a 64-wide off-screen buffer; '
      + 'each looks up the terrain range where it projects and compares. Turn the '
      + 'test off and the peaks behind the skyline come back — Monte Rosa from '
      + 'Zermatt village is the clearest case.');

    c.section('Rendering');
    c.segmented('Style', ['outline', 'shaded'], 'outline', (s) => {
      viewer.style = s as Style;
      mark();
    });
    const fovSlider = c.slider('Field of view', 4, 100, 0.5, cam.fov,
      (v) => { cam.fov = v; mark(); }, (v) => `${v.toFixed(1)}°`);

    const readout = c.readout();
    apply(vps[0]);

    let lastStats = 0;
    const loop = () => {
      cam.aspect = (shell.canvas.clientWidth || 1) / (shell.canvas.clientHeight || 1);
      cam.update();
      if (dirty) { viewer.render(); dirty = false; }
      shell.ribbon.draw(cam.yaw, cam.hfov);

      const now = performance.now();
      if (now - lastStats > 240) {
        lastStats = now;
        shell.setBadges([
          ['brg', `${cam.yaw.toFixed(1)}°`],
          ['fov', `${cam.fov.toFixed(1)}°`],
          ['labels', `${viewer.placed.length}`],
          ['ms', viewer.scene.stats.frameMs.toFixed(1)],
        ]);
        readout.set([
          ['Catalogue', `${PEAKS.length} summits`],
          ['Named', `${PEAKS.filter((p) => !p.name.startsWith('Pt.')).length}`],
          ['In range', `${viewer.targets.length}`],
          ['Not occluded', `${viewer.visibleCount}`],
          ['Drawn', `${viewer.placed.length}`],
          ['Eye altitude', `${viewer.scene.eyeAltitude.toFixed(0)} m`],
          ['Frame', `${viewer.scene.stats.frameMs.toFixed(1)} ms`],
        ]);
        fovSlider.set(Math.round(cam.fov * 2) / 2);
      }
      requestAnimationFrame(loop);
    };

    (window as unknown as Record<string, unknown>).peak = { viewer, cam, apply, mark, hf, scene: viewer.scene };
    shell.done();
    loop();
  } catch (err) {
    shell.fail(err);
    throw err;
  }
}

main();

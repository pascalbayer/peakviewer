/**
 * Step 1 preview — geometry only.
 *
 * What this page is for: checking that the skyline is *right*. The controls
 * expose the three things that decide whether a distant summit lands in the
 * correct place — curvature, refraction and the eye altitude taken from the DEM
 * — so each can be switched off and the damage observed.
 */

import { REGION } from '../data/generated-gornergrat';
import { loadBakedRegion } from '../data/baked';
import { Scene } from '../render/scene';
import { QUALITY_HIGH, QUALITY_LOW } from '../render/terrain';
import { REFRACTION_K, curvatureDrop, effectiveRadius, localRadius } from '../core/geodesy';
import type { Style } from '../render/compose';
import { buildShell } from './shell';
import { attachLook, domReady } from './ui';

async function main() {
  await domReady();
  const shell = buildShell('Peak Finder · Step 1 — terrain & silhouette');
  try {
    const hf = await loadBakedRegion(REGION, (d, t) => {
      shell.setProgress(d / t, `decoding elevation level ${d} of ${t}…`);
    });

    const scene = new Scene(shell.canvas);
    scene.setHeightField(hf);

    const vps = REGION.viewpoints;
    let vp = vps[0];
    const cam = scene.camera;

    const apply = (v: typeof vp) => {
      vp = v;
      scene.moveTo(v.lon, v.lat, v.eye);
      cam.set({ yaw: v.yaw ?? 0, pitch: -2 });
      shell.controls.root.querySelector('.note')!.textContent = v.note ?? '';
      dirty = true;
    };

    let dirty = true;
    const mark = () => { dirty = true; };
    attachLook(shell.stage, cam, mark);
    new ResizeObserver(mark).observe(shell.stage);

    const c = shell.controls;
    c.section('Viewpoint').chips(vps, vps[0].id, apply);
    c.note('');

    c.section('Rendering');
    c.segmented('Style', ['outline', 'shaded'], 'outline', (s) => {
      scene.style = s as Style;
      mark();
    });
    const fovSlider = c.slider('Field of view', 4, 100, 0.5, cam.fov,
      (v) => { cam.fov = v; mark(); }, (v) => `${v.toFixed(1)}°`);
    c.slider('Eye height', 0, 60, 0.5, 1.7,
      (v) => { scene.moveTo(vp.lon, vp.lat, v); mark(); }, (v) => `${v.toFixed(1)} m`);
    c.slider('Visibility', 20, 400, 5, 160,
      (v) => { scene.terrain.visibility = v * 1000; mark(); }, (v) => `${v} km`);
    c.segmented('Quality', ['high', 'low'], 'high', (q) => {
      scene.quality = q === 'high' ? QUALITY_HIGH : QUALITY_LOW;
      mark();
    });

    c.section('Geometry checks');
    c.toggle('Earth curvature', true, (v) => { scene.terrain.curvature = v; mark(); });
    c.toggle('Atmospheric refraction', true, (v) => {
      scene.terrain.refractionK = v ? REFRACTION_K : 0;
      mark();
    });
    c.toggle('True-horizontal marker', false, (v) => { scene.compose.showHorizon = v; mark(); });
    c.note('Turn curvature off and distant ridges jump upwards; turn refraction '
      + 'off and they sink by a few hundred metres at 200 km. Both terms are '
      + 'applied per vertex in the geocentric frame, not as a screen-space fudge.');

    c.section('Silhouette');
    c.slider('Edge threshold', 0.005, 0.20, 0.005, scene.compose.edgeLow,
      (v) => { scene.compose.edgeLow = v; scene.compose.edgeHigh = v * 10; mark(); },
      (v) => v.toFixed(3));
    c.slider('Edge width', 0.5, 3, 0.5, 1,
      (v) => { scene.compose.edgeWidth = v; mark(); }, (v) => `${v} px`);

    const readout = c.readout();

    apply(vps[0]);

    let lastStats = 0;
    const loop = () => {
      cam.aspect = (shell.canvas.clientWidth || 1) / (shell.canvas.clientHeight || 1);
      cam.update();
      if (dirty) {
        scene.render();
        dirty = false;
      }
      shell.ribbon.draw(cam.yaw, cam.hfov);

      const now = performance.now();
      if (now - lastStats > 220) {
        lastStats = now;
        const R = localRadius(vp.lat);
        const eye = scene.eyeAltitude;
        const horizon = Math.sqrt(2 * effectiveRadius(scene.terrain.refractionK) * Math.max(1, eye));
        shell.setBadges([
          ['brg', `${cam.yaw.toFixed(1)}°`],
          ['pit', `${cam.pitch.toFixed(1)}°`],
          ['fov', `${cam.fov.toFixed(1)}°`],
          ['ms', scene.stats.frameMs.toFixed(1)],
        ]);
        readout.set([
          ['DEM ground', `${scene.observer.ground.toFixed(0)} m`],
          ['Eye altitude', `${eye.toFixed(0)} m`],
          ['Earth radius here', `${(R / 1000).toFixed(1)} km`],
          ['Effective radius', `${(effectiveRadius(scene.terrain.refractionK) / 1000).toFixed(1)} km`],
          ['Drop @ 50 km', `${curvatureDrop(50000, R, scene.terrain.refractionK).toFixed(0)} m`],
          ['Drop @ 150 km', `${curvatureDrop(150000, R, scene.terrain.refractionK).toFixed(0)} m`],
          ['Sea-level horizon', `${(horizon / 1000).toFixed(1)} km`],
          ['Model range', `${(hf.maxRange / 1000).toFixed(0)} km`],
          ['Rays drawn', `${scene.stats.columns} / ${scene.quality.azimuths}`],
          ['Render', `${scene.stats.width}×${scene.stats.height}`],
          ['Frame', `${scene.stats.frameMs.toFixed(1)} ms`],
        ]);
        fovSlider.set(Math.round(cam.fov * 2) / 2);
      }
      requestAnimationFrame(loop);
    };
    // Handle for the headless screenshot harness and for poking at state in
    // devtools; nothing in the app reads it.
    (window as unknown as Record<string, unknown>).peak = { scene, cam, apply, mark, hf };
    shell.done();
    loop();
  } catch (err) {
    shell.fail(err);
    throw err;
  }
}

main();

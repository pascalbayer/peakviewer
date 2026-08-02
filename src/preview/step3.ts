/**
 * Step 3 preview — pose.
 *
 * On a phone this reads the real magnetometer, gyroscope and GPS. On a desktop
 * there is nothing to read, so the same pipeline can be driven with simulated
 * device Euler angles: set alpha/beta/gamma and the screen rotation and check
 * that the heading, pitch and horizon roll come out where they should. That is
 * the whole point of this page — the sensor maths is the part you cannot eyeball
 * from a screenshot.
 */

import { PEAKS, REGION } from '../data/generated-gornergrat';
import { loadBakedRegion } from '../data/baked';
import { groundRange } from '../core/geodesy';
import { PoseTracker, screenAngle } from '../core/pose';
import { CompassRose } from '../ui/compass';
import { PeakViewer } from '../app/viewer';
import { buildShell } from './shell';
import { attachLook, domReady, el } from './ui';

async function main() {
  await domReady();
  const shell = buildShell('Peak Finder · Step 3 — pose & sensors');
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

    const rose = new CompassRose();
    shell.overlay.append(rose.canvas);

    let dirty = true;
    const mark = () => { dirty = true; };
    new ResizeObserver(mark).observe(shell.stage);

    let mode: 'manual' | 'sensors' | 'simulated' = 'manual';
    const sim = { alpha: 94, beta: 91, gamma: 0, screen: 0 };

    // Declared before the tracker: setPosition fires onPosition synchronously.
    const gpsNote = el('p', { class: 'note' });
    const sensorNote = el('p', { class: 'note' });

    const pose = new PoseTracker({
      onPosition: (lon, lat) => {
        const d = groundRange(REGION.origin.lon, REGION.origin.lat, lon, lat);
        if (d > hf.maxRange * 0.6) {
          gpsNote.textContent = `Fix is ${(d / 1000).toFixed(0)} km outside the `
            + 'demo region — the bundled elevation model only covers the Zermatt '
            + 'area, so the viewpoint was left where it was.';
          return;
        }
        gpsNote.textContent = '';
        viewer.moveTo(lon, lat, viewer.scene.observer.eye);
        mark();
      },
      onOrientation: (o) => {
        if (mode === 'manual') return;
        cam.set({ yaw: o.yaw, pitch: o.pitch, roll: o.roll });
        mark();
      },
    });
    pose.setPosition(REGION.viewpoints[0].lon, REGION.viewpoints[0].lat);

    // Dragging horizontally re-aims the camera by hand in manual mode, but in
    // sensor mode it feeds the alignment offset instead — the panorama stays
    // locked to the compass and the correction is what moves.
    attachLook(shell.stage, {
      get yaw() { return cam.yaw; },
      set yaw(v: number) {
        if (mode === 'manual') cam.yaw = v;
        else { pose.nudgeOffset(v - cam.yaw); cam.yaw = v; }
      },
      get pitch() { return cam.pitch; },
      set pitch(v: number) { if (mode === 'manual') cam.pitch = v; },
      get fov() { return cam.fov; },
      set fov(v: number) { cam.fov = v; },
    }, mark, {
      onTap: (x, y) => { viewer.pick(x, y); mark(); },
    });

    const c = shell.controls;
    c.section('Viewpoint').chips(REGION.viewpoints, REGION.viewpoints[0].id, (v) => {
      viewer.moveTo(v.lon, v.lat, v.eye);
      pose.setPosition(v.lon, v.lat);
      if (mode === 'manual') cam.set({ yaw: v.yaw ?? 0, pitch: -1, roll: 0 });
      mark();
    });

    c.section('Orientation source');
    c.segmented('Mode', ['manual', 'sensors', 'simulated'], 'manual', async (m) => {
      mode = m as typeof mode;
      if (mode === 'sensors') {
        const ok = await pose.requestPermission();
        if (ok) pose.start(); else sensorNote.textContent =
          'Motion access was refused. On iOS this needs a tap on a secure (https) page.';
      } else {
        pose.stop();
      }
      if (mode === 'simulated') pushSim();
      if (mode === 'manual') cam.set({ roll: 0 });
      mark();
    });
    c.root.append(sensorNote);
    c.root.append(gpsNote);

    c.section('Simulated device');
    const pushSim = () => {
      pose.feedSimulated(sim.alpha, sim.beta, sim.gamma, sim.screen);
      cam.set(pose.orientation);
      mark();
    };
    c.slider('alpha (compass)', 0, 360, 1, sim.alpha,
      (v) => { sim.alpha = v; if (mode === 'simulated') pushSim(); }, (v) => `${v}°`);
    c.slider('beta (tilt)', 0, 180, 1, sim.beta,
      (v) => { sim.beta = v; if (mode === 'simulated') pushSim(); }, (v) => `${v}°`);
    c.slider('gamma (roll)', -90, 90, 1, sim.gamma,
      (v) => { sim.gamma = v; if (mode === 'simulated') pushSim(); }, (v) => `${v}°`);
    c.segmented('Screen', ['0', '90', '180', '270'], '0', (v) => {
      sim.screen = parseInt(v, 10);
      if (mode === 'simulated') pushSim();
    });
    c.note('beta 90° is the phone held upright, so the camera looks at the '
      + 'horizon; alpha is the compass reading. Rotating the screen must leave '
      + 'the horizon level — that is the check this section exists for.');

    c.section('Alignment');
    const offsetSlider = c.slider('Manual offset', -30, 30, 0.5, 0,
      (v) => {
        pose.setOffset(v);
        if (mode === 'simulated') pushSim();
        mark();
      }, (v) => `${v.toFixed(1)}°`);
    c.toggle('Apply magnetic declination', true, (v) => {
      pose.applyDeclination = v;
      if (mode === 'simulated') pushSim();
      mark();
    });
    c.note('Declination comes from WMM-2025 evaluated at the observer. In the '
      + 'Alps it is a few degrees; in parts of Alaska and Siberia it is over '
      + 'thirty, which is the difference between the right mountain and one '
      + 'valley over.');

    c.section('Labels');
    c.toggle('Show labels', true, (v) => { viewer.showLabels = v; mark(); });
    c.slider('Field of view', 4, 100, 0.5, cam.fov, (v) => { cam.fov = v; mark(); },
      (v) => `${v.toFixed(1)}°`);

    const readout = c.readout();
    viewer.moveTo(REGION.viewpoints[0].lon, REGION.viewpoints[0].lat, REGION.viewpoints[0].eye);
    cam.set({ yaw: REGION.viewpoints[0].yaw ?? 0, pitch: -1 });

    let lastStats = 0;
    const loop = () => {
      cam.aspect = (shell.canvas.clientWidth || 1) / (shell.canvas.clientHeight || 1);
      cam.update();
      pose.tick();
      if (dirty) { viewer.render(); dirty = false; }
      shell.ribbon.draw(cam.yaw, cam.hfov);
      const off = pose.status.offset;
      rose.draw(cam.yaw, off, { warn: Math.abs(((off + 180) % 360) - 180) > 8 });

      const now = performance.now();
      if (now - lastStats > 240) {
        lastStats = now;
        const s = pose.status;
        shell.setBadges([
          ['brg', `${cam.yaw.toFixed(1)}°`],
          ['pit', `${cam.pitch.toFixed(1)}°`],
          ['rol', `${cam.roll.toFixed(1)}°`],
          ['labels', `${viewer.placed.length}`],
        ]);
        readout.set([
          ['Mode', mode],
          ['Magnetic heading', s.hasOrientation || mode === 'simulated'
            ? `${s.magneticYaw.toFixed(1)}°` : '—'],
          ['Declination', pose.applyDeclination ? `${s.declination.toFixed(2)}° E` : 'off'],
          ['Manual offset', `${(s.offset > 180 ? s.offset - 360 : s.offset).toFixed(1)}°`],
          ['True heading', `${cam.yaw.toFixed(1)}°`],
          ['Pitch / roll', `${cam.pitch.toFixed(1)}° / ${cam.roll.toFixed(1)}°`],
          ['Gyro', s.hasGyro ? 'fusing' : 'not present'],
          ['Compass accuracy', s.compassAccuracy === null ? 'not reported'
            : `±${s.compassAccuracy.toFixed(0)}°`],
          ['GPS accuracy', s.gpsAccuracy === null ? 'no fix' : `±${s.gpsAccuracy.toFixed(0)} m`],
          ['GPS altitude', 'ignored (DEM used)'],
          ['DEM ground', `${viewer.scene.observer.ground.toFixed(0)} m`],
          ['Eye altitude', `${viewer.scene.eyeAltitude.toFixed(0)} m`],
        ]);
        offsetSlider.set(Math.round((s.offset > 180 ? s.offset - 360 : s.offset) * 2) / 2);
      }
      requestAnimationFrame(loop);
    };

    (window as unknown as Record<string, unknown>).peak = {
      viewer, cam, mark, pose, hf, scene: viewer.scene,
      setMode: (m: string) => { mode = m as typeof mode; if (m === 'simulated') pushSim(); },
      sim, pushSim, screenAngle,
    };
    shell.done();
    loop();
  } catch (err) {
    shell.fail(err);
    throw err;
  }
}

main();

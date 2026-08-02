/**
 * Step 4 preview — AR overlay.
 *
 * The rendered skyline is drawn over the rear camera with a transparent sky, so
 * the outline should sit directly on the real ridge. Two things decide whether
 * it does: the heading (sensors plus the manual offset from step 3) and the
 * lens field of view. They fail differently — heading error slides the whole
 * overlay sideways, FOV error stretches it about the centre — and the controls
 * here are arranged so you can tell which one you are looking at.
 *
 * Without a camera the page falls back to a synthetic backdrop so the
 * compositing is still reviewable.
 */

import { PEAKS, REGION } from '../data/generated-gornergrat';
import { loadBakedRegion } from '../data/baked';
import { CameraFeed } from '../app/camerafeed';
import { PoseTracker } from '../core/pose';
import { CompassRose } from '../ui/compass';
import { CAMERA_GROUND, LIGHT_GROUND } from '../ui/labelPainter';
import { PeakViewer } from '../app/viewer';
import type { Style } from '../render/compose';
import { buildShell } from './shell';
import { attachLook, domReady, el } from './ui';

async function main() {
  await domReady();
  const shell = buildShell('Peak Finder · Step 4 — AR camera overlay');
  try {
    const hf = await loadBakedRegion(REGION, (d, t) => {
      shell.setProgress(d / t, `decoding elevation level ${d} of ${t}…`);
    });

    const feed = new CameraFeed();
    shell.stage.prepend(feed.video);

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

    let arOn = false;
    let sensors = false;
    let lockFov = true;

    const pose = new PoseTracker({
      onOrientation: (o) => {
        if (!sensors) return;
        cam.set({ yaw: o.yaw, pitch: o.pitch, roll: o.roll });
        mark();
      },
    });
    pose.setPosition(REGION.viewpoints[0].lon, REGION.viewpoints[0].lat);

    const setStyle = (ar: boolean) => {
      arOn = ar;
      viewer.style = (ar ? 'ar' : 'outline') as Style;
      viewer.painter.style = ar ? CAMERA_GROUND : LIGHT_GROUND;
      // Over a photograph a dark line disappears into dark rock and a white one
      // disappears into snow; a saturated warm line survives both.
      viewer.scene.compose.lineColor = ar ? [1.0, 0.78, 0.28] : [0.11, 0.14, 0.20];
      shell.stage.classList.toggle('ar', ar);
      mark();
    };

    attachLook(shell.stage, {
      get yaw() { return cam.yaw; },
      set yaw(v: number) {
        if (sensors) pose.nudgeOffset(v - cam.yaw);
        cam.yaw = v;
      },
      get pitch() { return cam.pitch; },
      set pitch(v: number) { if (!sensors) cam.pitch = v; },
      get fov() { return cam.fov; },
      set fov(v: number) { if (!lockFov) cam.fov = v; },
    }, mark, { onTap: (x, y) => { viewer.pick(x, y); mark(); } });

    const c = shell.controls;
    const camNote = el('p', { class: 'note' });

    c.section('Camera');
    c.toggle('AR overlay', false, async (v) => {
      if (v) {
        const ok = await feed.start();
        camNote.textContent = ok
          ? `Using ${feed.status.label ?? 'camera'} at ${feed.status.width}×${feed.status.height}.`
          : `${feed.status.error} — showing a synthetic backdrop instead, so the `
            + 'compositing is still visible.';
      } else {
        feed.stop();
        camNote.textContent = '';
      }
      setStyle(v);
    });
    c.root.append(camNote);
    c.slider('Overlay opacity', 0.2, 1, 0.05, 1,
      (v) => { shell.canvas.style.opacity = String(v); }, (v) => v.toFixed(2));
    c.slider('Line weight', 0.5, 3, 0.5, 1.5,
      (v) => { viewer.scene.compose.edgeWidth = v; mark(); }, (v) => `${v} px`);

    c.section('Lens calibration');
    const fovSlider = c.slider('Camera vertical FOV', 25, 90, 0.5, feed.status.fovY, (v) => {
      feed.setFov(v);
      if (lockFov) cam.fov = feed.renderFovY(shell.stage.clientWidth, shell.stage.clientHeight);
      mark();
    }, (v) => `${v.toFixed(1)}°`);
    c.toggle('Match render FOV to lens', true, (v) => { lockFov = v; mark(); });
    c.note('A wrong field of view does not slide the overlay, it scales it: the '
      + 'centre stays put while peaks near the edges drift outwards or inwards. '
      + 'If the middle of the frame lines up and the sides do not, this is the '
      + 'control to reach for — not the heading.');

    c.section('Alignment');
    c.toggle('Use device sensors', false, async (v) => {
      sensors = v;
      if (v) {
        const ok = await pose.requestPermission();
        if (ok) pose.start();
        else camNote.textContent = 'Motion access refused; drag to aim instead.';
      } else {
        pose.stop();
        cam.set({ roll: 0 });
      }
      mark();
    });
    const offsetSlider = c.slider('Heading offset', -30, 30, 0.25, 0,
      (v) => { pose.setOffset(v); mark(); }, (v) => `${v.toFixed(2)}°`);
    c.note('Drag across the view to re-aim. With sensors on, the drag feeds the '
      + 'offset instead of the camera — the panorama stays locked to the compass '
      + 'and the correction is what moves. There is no computer vision here: '
      + 'nothing matches the drawn skyline to the photographed one, which is why '
      + 'this control exists at all.');

    c.section('Viewpoint').chips(REGION.viewpoints, REGION.viewpoints[0].id, (v) => {
      viewer.moveTo(v.lon, v.lat, v.eye);
      pose.setPosition(v.lon, v.lat);
      if (!sensors) cam.set({ yaw: v.yaw ?? 0, pitch: -1, roll: 0 });
      mark();
    });
    c.toggle('Show labels', true, (v) => { viewer.showLabels = v; mark(); });

    const readout = c.readout();
    viewer.moveTo(REGION.viewpoints[0].lon, REGION.viewpoints[0].lat, REGION.viewpoints[0].eye);
    cam.set({ yaw: REGION.viewpoints[0].yaw ?? 0, pitch: -1 });
    viewer.scene.compose.edgeWidth = 1.5;

    let lastStats = 0;
    const loop = () => {
      const w = shell.stage.clientWidth || 1, h = shell.stage.clientHeight || 1;
      cam.aspect = w / h;
      if (lockFov && arOn) {
        const want = feed.renderFovY(w, h);
        if (Math.abs(want - cam.fov) > 0.01) { cam.fov = want; dirty = true; }
      }
      cam.update();
      if (dirty) { viewer.render(); dirty = false; }
      shell.ribbon.draw(cam.yaw, cam.hfov);
      const off = pose.status.offset;
      rose.draw(cam.yaw, off, { warn: Math.abs(((off + 180) % 360) - 180) > 8 });

      const now = performance.now();
      if (now - lastStats > 250) {
        lastStats = now;
        const s = feed.status;
        shell.setBadges([
          ['brg', `${cam.yaw.toFixed(1)}°`],
          ['fov', `${cam.fov.toFixed(1)}°`],
          ['ar', arOn ? (s.active ? 'camera' : 'fallback') : 'off'],
        ]);
        readout.set([
          ['Camera', s.active ? `${s.width}×${s.height}` : (s.error ? 'unavailable' : 'off')],
          ['Lens FOV', `${s.fovY.toFixed(1)}° (${s.fovSource})`],
          ['Render FOV', `${cam.fov.toFixed(1)}°`],
          ['Horizontal FOV', `${cam.hfov.toFixed(1)}°`],
          ['Heading', `${cam.yaw.toFixed(1)}°`],
          ['Declination', `${pose.status.declination.toFixed(2)}°`],
          ['Manual offset', `${(off > 180 ? off - 360 : off).toFixed(2)}°`],
          ['Registration', 'sensors + manual only'],
          ['Labels drawn', `${viewer.placed.length}`],
        ]);
        offsetSlider.set(Math.round((off > 180 ? off - 360 : off) * 4) / 4);
        fovSlider.set(s.fovY);
      }
      requestAnimationFrame(loop);
    };

    (window as unknown as Record<string, unknown>).peak = {
      viewer, cam, mark, pose, feed, setStyle, scene: viewer.scene,
    };
    shell.done();
    loop();
  } catch (err) {
    shell.fail(err);
    throw err;
  }
}

main();

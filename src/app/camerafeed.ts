/**
 * Rear-camera passthrough for the AR overlay.
 *
 * The one number that matters here is the lens field of view, and no browser
 * reports it. getSettings() may expose a focal length and sensor size on a
 * handful of devices; everywhere else the only honest options are a sensible
 * default and a control the user can nudge until the drawn skyline sits on the
 * real one. Getting it wrong does not shift the overlay, it *stretches* it, so
 * the peaks near the edges of the frame drift while the centre looks fine.
 */

export interface FeedStatus {
  active: boolean;
  error: string | null;
  label: string | null;
  width: number;
  height: number;
  /** Vertical field of view in degrees, estimated or set by hand. */
  fovY: number;
  /** How the FOV was arrived at. */
  fovSource: 'default' | 'reported' | 'manual';
}

/** Typical rear-camera vertical FOV in a 4:3 frame. A starting point, not a fact. */
const DEFAULT_FOV_Y = 51;

export class CameraFeed {
  readonly video: HTMLVideoElement;
  readonly status: FeedStatus = {
    active: false, error: null, label: null,
    width: 0, height: 0, fovY: DEFAULT_FOV_Y, fovSource: 'default',
  };

  private stream: MediaStream | null = null;

  constructor() {
    this.video = document.createElement('video');
    this.video.className = 'feed';
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.autoplay = true;
    this.video.setAttribute('playsinline', '');
  }

  async start(): Promise<boolean> {
    this.stop();
    if (!navigator.mediaDevices?.getUserMedia) {
      this.status.error = 'This browser exposes no camera API.';
      return false;
    }
    try {
      return await this.adopt(await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      }));
    } catch (e) {
      this.status.active = false;
      this.status.error = e instanceof Error
        ? `${e.name}: ${e.message}`
        : 'Camera access failed.';
      return false;
    }
  }

  /**
   * Takes over a stream someone else opened. The permission flow opens one as
   * part of asking, and opening a second a moment later is both slower and, on
   * some Android builds, a second prompt.
   */
  async adopt(stream: MediaStream): Promise<boolean> {
    if (this.stream && this.stream !== stream) this.stop();
    try {
      this.stream = stream;
      this.video.srcObject = this.stream;
      await this.video.play();
      const track = this.stream.getVideoTracks()[0];
      const st = track?.getSettings() ?? {};
      this.status.active = true;
      this.status.error = null;
      this.status.label = track?.label ?? null;
      this.status.width = st.width ?? this.video.videoWidth;
      this.status.height = st.height ?? this.video.videoHeight;

      // A few Android builds report the optics; use them when they are there.
      const opt = st as MediaTrackSettings & { focalLength?: number; height?: number };
      if (opt.focalLength && opt.height) {
        // Assume a 1/2.55" sensor: ~4.7 mm tall. Rough, but better than nothing.
        const sensorMm = 4.7;
        this.status.fovY = 2 * Math.atan(sensorMm / 2 / opt.focalLength) * (180 / Math.PI);
        this.status.fovSource = 'reported';
      }
      return true;
    } catch (e) {
      this.status.active = false;
      this.status.error = e instanceof Error
        ? `${e.name}: ${e.message}`
        : 'Camera access failed.';
      return false;
    }
  }

  setFov(deg: number) {
    this.status.fovY = deg;
    this.status.fovSource = 'manual';
  }

  /**
   * Vertical FOV to render at, given that the video is displayed with
   * object-fit: cover. When the element is wider than the frame the video is
   * cropped top and bottom, which narrows the vertical angle actually on screen.
   */
  renderFovY(elementW: number, elementH: number): number {
    const vw = this.status.width || this.video.videoWidth;
    const vh = this.status.height || this.video.videoHeight;
    if (!vw || !vh || !elementW || !elementH) return this.status.fovY;
    const videoAspect = vw / vh;
    const elemAspect = elementW / elementH;
    const tanY = Math.tan((this.status.fovY * Math.PI) / 360);
    if (elemAspect > videoAspect) {
      // Cover crops vertically: the visible half-angle shrinks by the ratio.
      const visible = tanY * (videoAspect / elemAspect);
      return (2 * Math.atan(visible) * 180) / Math.PI;
    }
    return this.status.fovY;
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.status.active = false;
  }
}

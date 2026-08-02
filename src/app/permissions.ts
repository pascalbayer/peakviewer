/**
 * Asking for the three things the app cannot work without.
 *
 * The platforms differ in ways that decide the shape of this code:
 *
 * iOS gates the motion sensors behind `DeviceOrientationEvent.requestPermission`,
 * and that call is only honoured while the page still has user activation. An
 * `await` on anything slower — a camera stream, a location fix — can spend that
 * activation before the motion request is made, so motion is always asked for
 * first, synchronously into the tap.
 *
 * Android exposes no motion permission at all; the sensors simply work on a
 * secure origin and are silent on an insecure one. Camera and location prompt
 * on first use on both.
 *
 * None of the three can be re-prompted once refused. A denied state is
 * therefore a signpost to the browser's own settings, not a button to press
 * again, and this module reports enough to say which.
 */

export type PermissionKind = 'motion' | 'camera' | 'location';
export type PermissionState = 'granted' | 'denied' | 'prompt' | 'unsupported' | 'unknown';

export interface PermissionReport {
  motion: PermissionState;
  camera: PermissionState;
  location: PermissionState;
  /** False on plain http, where all three are unavailable whatever the user says. */
  secure: boolean;
  /** True where an explicit motion request exists — iOS and iPadOS. */
  motionNeedsRequest: boolean;
  /** True when the page is inside an iframe. */
  framed: boolean;
  /**
   * What the embedding Permissions-Policy allows, where the browser will say.
   * A sandboxed iframe that has not been given `allow="camera; geolocation;
   * gyroscope; accelerometer; magnetometer"` blocks these no matter what the
   * user agrees to, and the failure looks exactly like a refusal.
   */
  policy: Record<string, 'allowed' | 'blocked' | 'unknown'>;
  /** Anything the browser told us on the way. */
  notes: string[];
}

const POLICY_FEATURES = ['camera', 'geolocation', 'gyroscope', 'accelerometer',
  'magnetometer', 'xr-spatial-tracking'];

function readPolicy(): Record<string, 'allowed' | 'blocked' | 'unknown'> {
  const out: Record<string, 'allowed' | 'blocked' | 'unknown'> = {};
  const fp = (document as unknown as {
    featurePolicy?: { allowsFeature(f: string): boolean; features(): string[] };
    permissionsPolicy?: { allowsFeature(f: string): boolean; features(): string[] };
  });
  const api = fp.featurePolicy ?? fp.permissionsPolicy;
  for (const f of POLICY_FEATURES) {
    if (!api) { out[f] = 'unknown'; continue; }
    try {
      const known = api.features?.() ?? [];
      out[f] = known.length && !known.includes(f)
        ? 'unknown'
        : (api.allowsFeature(f) ? 'allowed' : 'blocked');
    } catch {
      out[f] = 'unknown';
    }
  }
  return out;
}

interface RequestPermissionCtor { requestPermission?: () => Promise<string> }

function orientationCtor(): RequestPermissionCtor | null {
  return typeof DeviceOrientationEvent === 'undefined'
    ? null : (DeviceOrientationEvent as unknown as RequestPermissionCtor);
}

function motionCtor(): RequestPermissionCtor | null {
  return typeof DeviceMotionEvent === 'undefined'
    ? null : (DeviceMotionEvent as unknown as RequestPermissionCtor);
}

export function motionNeedsRequest(): boolean {
  return typeof orientationCtor()?.requestPermission === 'function';
}

export function framed(): boolean {
  try { return window.top !== window.self; } catch { return true; }
}

export function isSecure(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext;
}

/** Best-effort current state, without prompting for anything. */
export async function inspect(): Promise<PermissionReport> {
  const report: PermissionReport = {
    motion: 'unknown',
    camera: 'unknown',
    location: 'unknown',
    secure: isSecure(),
    motionNeedsRequest: motionNeedsRequest(),
    framed: framed(),
    policy: readPolicy(),
    notes: [],
  };
  const blocked = Object.entries(report.policy)
    .filter(([, v]) => v === 'blocked').map(([k]) => k);
  if (report.framed && blocked.length) {
    report.notes.push(`This page is embedded in a frame that blocks `
      + `${blocked.join(', ')}. The browser will refuse those regardless of what `
      + `you allow here — open the app at its own address instead.`);
  } else if (report.framed) {
    report.notes.push('This page is running inside a frame. Camera, motion and '
      + 'location depend on the embedding page delegating them.');
  }
  if (!report.secure) {
    report.notes.push('This page is not on a secure origin. Camera, location and '
      + 'motion sensors are all unavailable over plain http — use https or localhost.');
  }

  // The Permissions API is the only way to read a state without asking, and
  // support for the individual names is uneven: Safari answers for geolocation
  // and throws for camera, so each query stands on its own.
  const perms = navigator.permissions;
  if (perms?.query) {
    for (const [kind, name] of [['camera', 'camera'], ['location', 'geolocation']] as const) {
      try {
        const s = await perms.query({ name: name as PermissionName });
        report[kind] = s.state as PermissionState;
      } catch {
        report[kind] = 'unknown';
      }
    }
  }
  if (!navigator.mediaDevices?.getUserMedia) report.camera = 'unsupported';
  if (!navigator.geolocation) report.location = 'unsupported';

  if (!report.motionNeedsRequest) {
    // Android and desktop: no gate, so it is granted if the events exist at all.
    report.motion = orientationCtor() && report.secure ? 'granted' : 'unsupported';
  }
  return report;
}

export interface RequestOptions {
  /** Called after each step so the UI can update while the prompts run. */
  onProgress?(kind: PermissionKind, state: PermissionState): void;
  /** Skip the camera step; used when the camera is already running. */
  skipCamera?: boolean;
}

export interface RequestResult extends PermissionReport {
  /** The camera stream, if one was opened — hand it straight to the feed. */
  stream: MediaStream | null;
}

/**
 * Requests all three. **Call this directly from a click or touch handler** —
 * the motion request needs the user activation that the gesture provides, and
 * it is issued before anything is awaited for exactly that reason.
 */
export async function requestAll(opt: RequestOptions = {}): Promise<RequestResult> {
  // 1. Motion goes out before this function awaits *anything*, including the
  // inspection below. Safari's activation is transient, and every await is a
  // chance to lose it — the request has to leave on the same tick as the tap.
  const motionPromise = motionNeedsRequest()
    ? orientationCtor()!.requestPermission!().then(
      (r) => (r === 'granted' ? 'granted' : 'denied') as PermissionState,
      (e): PermissionState => { motionError = message(e); return 'denied'; },
    )
    : null;
  let motionError: string | null = null;

  const report = await inspect();
  const out: RequestResult = { ...report, stream: null };

  if (motionPromise) {
    out.motion = await motionPromise;
    if (motionError) out.notes.push(`Motion request failed: ${motionError}`);
    // The motion event has its own gate on some iOS versions; the answer to
    // the first prompt is reused, so this rarely shows a second dialog.
    const m = motionCtor();
    if (out.motion === 'granted' && typeof m?.requestPermission === 'function') {
      try { await m.requestPermission(); } catch { /* orientation is the one that matters */ }
    }
  }
  opt.onProgress?.('motion', out.motion);

  // 2. Camera. Opening the stream *is* the request; keep it and hand it over
  // rather than opening a second one a moment later.
  if (!opt.skipCamera && navigator.mediaDevices?.getUserMedia) {
    try {
      out.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      out.camera = 'granted';
    } catch (e) {
      out.camera = deniedOrError(e);
      out.notes.push(`Camera: ${message(e)}`);
    }
  }
  opt.onProgress?.('camera', out.camera);

  // 3. Location last: it never needs user activation, and on iOS the dialog
  // queues behind the others anyway.
  if (navigator.geolocation) {
    out.location = await new Promise<PermissionState>((res) => {
      navigator.geolocation.getCurrentPosition(
        () => res('granted'),
        (e) => {
          if (e.code === e.PERMISSION_DENIED) return res('denied');
          out.notes.push(`Location: ${e.message}`);
          res('prompt');
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
      );
    });
  }
  opt.onProgress?.('location', out.location);

  return out;
}

function deniedOrError(e: unknown): PermissionState {
  if (e instanceof Error && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
    return 'denied';
  }
  return 'unsupported';
}

function message(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/** What to tell someone whose answer the browser will not ask for again. */
export function recoveryHint(kind: PermissionKind): string {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios) {
    return kind === 'motion'
      ? 'Safari remembers a refusal for this site. Settings → Apps → Safari → '
        + 'Motion & Orientation Access, then reload.'
      : `Tap the "aA" or page-settings icon in the address bar → Website Settings `
        + `→ ${kind === 'camera' ? 'Camera' : 'Location'} → Ask, then reload.`;
  }
  return `Tap the lock or tune icon beside the address bar → Permissions → `
    + `${kind === 'camera' ? 'Camera' : kind === 'location' ? 'Location' : 'Motion sensors'}`
    + ' → Allow, then reload.';
}

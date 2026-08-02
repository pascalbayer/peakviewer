# peakviewer

An AR peak finder: the rear camera fills the frame, washed towards white, with
the skyline computed from an on-device elevation model drawn over it as black
outlines. Drag to line the outline up with the real ridge; the shutter saves the
composite to your photos.

Rendered with **Babylon.js on WebGPU**, core modules only. There is no WebGL
fallback — Chrome or Edge 121+, or Safari 26+ on iOS 26+.

    npm install
    npm run build     # runs the checks, then -> dist/app/ (the PWA, ~1.4 MB)
    npm run serve     # http://localhost:8080

Geolocation, motion sensors and the camera all require a secure context, so use
`https://` or `localhost`.

**Permissions.** An access card asks for camera, motion and location together,
from a single tap — which is the only way iOS hands over the motion sensors,
since `DeviceOrientationEvent.requestPermission` is only honoured while the page
still has user activation. Motion is therefore requested first, before anything
slower is awaited. The 🔓 button in the bar and the **Access** panel reopen it,
and report per-item state plus how to undo a refusal, which no browser will
prompt for a second time.

## How it works

**Elevation.** Terrain is a heightfield, not geometry. Levels are concentric
Web-Mercator windows centred on the observer, each twice the extent and half the
resolution of the one inside it (a clipmap: 640 px square, z12 down to z7,
≈8.5 km out to ≈272 km). They fill from [AWS Terrain
Tiles](https://registry.opendata.aws/terrain-tiles/) — SRTM / NASADEM / 3DEP
derived, ~30 m posts, global — and every tile that arrives is written to
IndexedDB, so looking around warms the cache offline mode later relies on. Zoom
above z11 buys nothing: the source is ~30 m data, and z13 reproduces the
Matterhorn's summit within 3 m of what z11 gives.

**Rendering.** Two WGSL passes through Babylon. The terrain pass draws a polar
mesh into an offscreen buffer holding only the distance to each fragment; the
composite pass runs an edge detector over it and lays the black outline over the
camera image. The mesh is polar: rays fan out at a fixed angular step and march
outwards with a step that grows to match, in three segments — geometric near (so
the ground at your feet is not one enormous triangle), one DEM post per step
through the middle, geometric again far out. It is split into 32 azimuth sectors
and only the wedge in front of the camera is submitted. Depth is logarithmic,
mapped to WebGPU's [0,1] clip range, because one 24-bit buffer has to separate a
boulder 3 m away from a ridge 270 km away.

Every texture is rgba8unorm on purpose. Float and integer formats carry
filterability and bind-group conditions that vary by device; heights are packed
into two bytes and ranges into three, and nothing needs a device feature.

**The outline** is an edge detector run over a range buffer, not over the shaded
image. Ridge lines therefore come out of the geometry rather than the lighting,
stay legible whichever way the sun points, and survive being drawn over a bright
camera frame. Sky is fed into the detector as "very far away", so the outer
skyline and the ridge-behind-ridge creases are found by the same comparison.

**Geometry.** Vertices are placed in a geocentric frame. At 190 km, curvature
drops a summit ~2.8 km and refraction lifts ~365 m of that back; the two are
worth 0.83° and 0.10° of apparent elevation there, measured off the rendered
image and matching theory. Refraction uses the surveyor's effective-radius
model, R/(1−k) with k = 0.13.

**Labels.** Which summits the terrain hides is answered by marching the
elevation model along each sightline and tracking the highest apparent elevation
angle — using the same curvature and refraction terms as the renderer, so the
two cannot disagree about the horizon. That depends on where you stand, not
where you point, so it runs once per position rather than once per frame, and
the summit list can say what is behind you. Anchors sit at the DEM's summit
rather than the catalogue's — the two disagree by ~120 m on the Matterhorn — so
a marker never floats above its own mountain.

**Pose.** Position and altitude both from GPS. Altitude is the weaker half of a
fix — the value is height above the WGS84 ellipsoid, and its accuracy is usually
several times the horizontal figure — so the elevation model's own ground height
is shown next to it in the Check panel and used whenever the device reports no
altitude at all. Orientation is magnetometer plus gyroscope: the gyro is integrated between
compass updates and bled back onto the compass with a 0.7 s time constant.
Magnetic declination comes from WMM-2025 — a centred-dipole approximation is
~16° wrong in the Alps, which is useless. The DeviceOrientation Euler sequence
is Z-X'-Y'', degenerate at beta = 90 which is exactly how a phone is held in AR,
so the code builds the full rotation matrix rather than trusting alpha.

**What is deliberately absent** is any registration against the camera image.
Alignment is sensors plus what you drag in: left/right shifts the heading,
up/down shifts the pitch, and both persist as offsets so the correction sticks
as you turn around. The compass shows how much is applied.

**Capture.** The composite is re-rendered into an offscreen target rather than
scraped off the visible canvas — a WebGPU swap-chain texture is not reliably
readable after presentation — then the labels are drawn on and the PNG goes
through the Web Share API, which is the only route a web page has into the
Photos app. Where sharing files is unsupported it downloads instead.

## Layout

    src/core/       geodesy, clipmap heightfield, camera, labels, pose, horizon
    src/render/gpu/ WGSL sources and the Babylon WebGPU renderer
    src/sources/    terrarium tiles, IndexedDB store, clipmap streamer, Overpass
    src/app/        the app — viewer, camera feed, capture, shell
    src/preview/    the published preview build
    src/ui/         label painter, compass rose, plan view
    tools/          data baking, codegen, bundling, shader and geometry checks

`src/main.ts` wires the app to the network sources; `src/preview/app.ts` wires
the same `App` class to bundled data. That is the only difference between them.

## Preview

One self-contained HTML file with no external requests, which is why the
elevation data travels as data: URIs inside the bundle.

    npm run build:previews          # -> dist/previews/app.html

## Checks

WebGPU cannot run in CI here, so correctness is established without a GPU:

    npm run check        # tsc, then both of the below

`tools/check_wgsl.mjs` puts the shaders through **Babylon's own preprocessor and
finalize step** — the same code path the engine uses — then parses the result as
WGSL and asserts that every uniform the material sets reaches the generated
struct and is referenced through it. This caught two real defects that would
otherwise have been a black screen on device: uniforms referenced without the
`uniforms.` prefix, and the engine module import cycle.

`tools/check_math.mjs` mirrors the vertex shader's geometry in float32 and
compares it against the double-precision routines the labels and horizon test
use. Current agreement: 0.06 m of position, 0.002 clipmap pixels at z12.

What no check here can establish is that the pipeline links on a real device or
that the picture looks right. That needs a phone.

## Demo data

    python3 tools/bake_dem.py --lon 7.7845 --lat 45.9835 --name gornergrat --out data
    python3 tools/extract_peaks.py --region data/gornergrat.json \
        --catalogue data/valais.catalogue.json --out data/gornergrat.peaks.json
    npm run gen:region

The bundled summit catalogue is a demo artefact, not a data source: the preview
pages cannot reach Overpass, so summits are derived from the DEM by key-saddle
prominence and names attached by a one-to-one assignment that gates on elevation
and scores on distance. 40 of 68 catalogue entries attach confidently; the rest
are dropped rather than guessed onto the wrong mountain, and unnamed summits
show as `Pt. 4341`. **The installed app does not use any of this** — it queries
OpenStreetMap.

## Data sources

- Elevation: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/),
  Mapzen terrarium encoding. Licensing follows the underlying source (SRTM,
  NASADEM, 3DEP and others).
- Summits: OpenStreetMap contributors, ODbL, via Overpass at runtime.
- Magnetic declination: NOAA/BGS World Magnetic Model 2025, via the
  `geomagnetism` package.

## Known limits

- **Alignment drift** is the main failure mode, as it is for any sensor-only AR
  peak finder. Magnetometers are disturbed by ski lifts, cars and phone cases.
  Drag to correct; the compass dot shows how much correction is applied.
- **DEM resolution** rounds sharp summits off. The Matterhorn reads 4355 m
  against a catalogued 4478 m, and no zoom level fixes it because the source
  data is ~30 m. The label card shows the deficit rather than hiding it.
- **Coverage** is 80°N to 80°S, wherever the tile source has data.
- A cold start at a new position fetches ~64 tiles (~6 MB) for a 150 km radius.
- **No WebGL fallback.** On a browser without WebGPU the app says so and stops.
- **GPS altitude** is used as asked, and it is noisy. If the horizon sits high or
  low by a consistent amount, that is usually the altitude, not the compass —
  the Check panel shows the GPS value and the elevation model's side by side.

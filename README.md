# peakviewer

An AR peak finder: the rear camera fills the frame, washed towards white, with
the skyline computed from an on-device elevation model drawn over it as black
outlines. Drag to line the outline up with the real ridge; the shutter saves the
composite to your photos.

Rendered with **Babylon.js**, core modules only, through either WebGPU or
WebGL2 — the same scene, the same uniforms, the same geometry, two shader
dialects.

> **Currently defaulting to WebGL2** while the rendering is being debugged,
> because it is the path whose output has actually been verified against
> read-back pixels. Add `?backend=webgpu` to the address to force the other, or
> `?backend=webgl2` to come back. The Check panel says which is live, and the
> choice sticks for the session. `DEFAULT_BACKEND` in `src/app/app.ts` is the
> one line that flips it.

WebGPU needs Chrome or Edge 121+, or Safari 26+ on iOS 26+. WebGL2 runs
essentially everywhere.

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

**Rendering.** Two passes through Babylon. The terrain pass draws a polar
mesh into an offscreen buffer holding only the distance to each fragment; the
composite pass runs an edge detector over it and lays the black outline over the
camera image. The mesh is polar: rays fan out at a fixed angular step and march
outwards with a step that grows to match, in three segments — geometric near (so
the ground at your feet is not one enormous triangle), one DEM post per step
through the middle, geometric again far out. It is split into 32 azimuth sectors
and only the wedge in front of the camera is submitted. Depth is logarithmic,
because one 24-bit buffer has to separate a boulder 3 m away from a ridge 270 km
away — mapped to [0,1] on WebGPU and [-1,1] on WebGL2, which along with the
shader dialect is the whole of the difference between the two backends.

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

**Staying up.** An empty viewfinder is the failure this app is most exposed to,
because everything looks the same behind it: a shader that did not link, a
device that went away, a tile server that never answered. So nothing is allowed
to stop the frame loop. Frames draw from the first moment — the clipmap is
allocated before any tile is fetched, so a cold start shows a flat horizon that
sharpens as levels land, rather than nothing until 6 MB has arrived. A frame
that throws is counted and the next one is still requested; losing the GPU
device re-uploads the height atlas and carries on, which matters because
backgrounding the app to save a photo is enough to lose it. If five seconds pass
with nothing drawn, the app says which of those it was instead of leaving a dark
rectangle. The Check panel reports pipeline compilation, frames drawn, frame
errors, device losses and tile progress.

**Capture.** The composite is re-rendered into an offscreen target rather than
scraped off the visible canvas — a WebGPU swap-chain texture is not reliably
readable after presentation — then the labels are drawn on and the PNG goes
through the Web Share API, which is the only route a web page has into the
Photos app. Where sharing files is unsupported it downloads instead.

## Layout

    src/core/       geodesy, clipmap heightfield, camera, labels, pose, horizon
    src/render/gpu/ WGSL and GLSL sources, and the Babylon renderer
    src/sources/    terrarium tiles, IndexedDB store, clipmap streamer, Overpass
    src/app/        the app — viewer, camera feed, capture, shell
    src/preview/    the published preview build
    src/ui/         label painter, compass rose, plan view
    tools/          data baking, codegen, bundling, shader/geometry/GPU checks

`src/main.ts` wires the app to the network sources; `src/preview/app.ts` wires
the same `App` class to bundled data. That is the only difference between them.

## Deploying

`docs/` on `main` holds a built copy for GitHub Pages. Enable it once under
**Settings → Pages → Build and deployment → Deploy from a branch**, branch
`main`, folder `/docs`. The app then lives at
`https://<owner>.github.io/peakviewer/`.

Rebuild and commit `docs/` whenever `src/` changes — it is a checked-in build
artefact, not something Pages compiles for you.

    npm run build:pages     # checks, builds the PWA and the demo into docs/

This matters more than convenience. Camera, geolocation and the motion sensors
are delegated through Permissions-Policy, so a page embedded in someone else's
iframe only gets them if the embedder passed
`allow="camera; geolocation; gyroscope; accelerometer; magnetometer"` down. A
host that does not — most sandboxed preview frames — produces failures that look
exactly like the user refusing. The **Access** panel reports whether the page is
framed and what the policy allows, so the two can be told apart.

`docs/index.html` is the live app: it streams tiles and queries OpenStreetMap.
`docs/demo.html` is the self-contained build with Zermatt baked in — one file,
no external requests, useful with no signal.

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

`tools/check_gpu.mjs` runs the renderer on an actual WebGPU device — Chromium's
SwiftShader adapter — over a synthetic ridge, and reads the pixels back. That
covers what the other two cannot: that the pipelines link, that the passes run
in the right order, and that something is painted. It reads render targets
rather than taking a screenshot, because a headless browser will happily
composite nothing while rendering correctly, and a screenshot cannot tell those
apart. It skips rather than fails where no adapter is available, so `npm run
check` does not depend on a GPU.

What no check here can establish is performance, a vendor's driver quirks, or
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

## Licensing and attribution

The code in this repository is **MIT** — see `LICENSE`.

That covers the code and nothing else. Three things in the tree are not the
project's to license:

- **Dependencies.** Babylon.js, `geomagnetism`, TypeScript and Playwright are
  Apache-2.0; esbuild and `wgsl_reflect` are MIT. None copyleft. Apache-2.0
  section 4 asks you to retain licence notices in code you redistribute, so the
  bundles are built with `legalComments: 'eof'` rather than stripping them, and
  the full texts are in `THIRD-PARTY-NOTICES.md`.
- **Elevation data** in `data/` is derived from AWS Terrain Tiles. The bundled
  Valais region traces to USGS SRTM and is public domain; other regions carry
  their own attribution requirements, listed below and in the notices file.
- **Summit names** fetched at runtime are © OpenStreetMap contributors under the
  ODbL, which is share-alike for derived *databases* — worth knowing if you
  build something that redistributes them.

`THIRD-PARTY-NOTICES.md` is regenerated by `npm run build:pages`.

## Data sources

Terrain tiles are a composite of national and global surveys, several of which
require attribution by licence — and require it somewhere a user would
reasonably look, not only in a repository. The app therefore carries a
**Credits** panel reproducing every notice verbatim, generated from
`src/core/attribution.ts`, which is also the source for
`THIRD-PARTY-NOTICES.md`. Changing one changes both.

- Elevation: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/),
  Tilezen terrarium encoding — a composite of ArcticDEM, Geoscience Australia,
  data.gv.at, the Government of Canada, Copernicus EU-DEM, NOAA ETOPO1, INEGI,
  Land Information New Zealand, Kartverket, the UK Environment Agency and the
  U.S. Geological Survey. The bundled Valais demo comes from USGS SRTM.
- Summits: © OpenStreetMap contributors, ODbL, via Overpass at runtime.
- Magnetic declination: NOAA NCEI / British Geological Survey World Magnetic
  Model 2025, via the `geomagnetism` package.
- Rendering: Babylon.js, Apache-2.0.

## Known limits

- **Alignment drift** is the main failure mode, as it is for any sensor-only AR
  peak finder. Magnetometers are disturbed by ski lifts, cars and phone cases.
  Drag to correct; the compass dot shows how much correction is applied.
- **DEM resolution** rounds sharp summits off. The Matterhorn reads 4355 m
  against a catalogued 4478 m, and no zoom level fixes it because the source
  data is ~30 m. The label card shows the deficit rather than hiding it.
- **Coverage** is 80°N to 80°S, wherever the tile source has data.
- A cold start at a new position fetches ~64 tiles (~6 MB) for a 150 km radius.
- **Two backends, one verified.** WebGL2 is what the checks exercise and what
  the screenshots above came from. The WebGPU path shares all of its geometry
  and uniforms and its shaders are checked statically, but no picture from it
  has been looked at — no container here keeps a software WebGPU device alive
  long enough to render a frame.
- **GPS altitude** is used as asked, and it is noisy. If the horizon sits high or
  low by a consistent amount, that is usually the altitude, not the compass —
  the Check panel shows the GPS value and the elevation model's side by side.

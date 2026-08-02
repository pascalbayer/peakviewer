# peakviewer

A mobile PWA peak finder: an on-device elevation model, a GPU-rendered horizon,
and sensor-based labelling of the summits you can actually see.

The architecture follows the same split the commercial apps use — a 2.5D
heightfield rasterised in real time, plus an independently versioned catalogue
of named summits — rather than shipping a 3D model of the Alps.

    npm install
    npm run build     # -> dist/app/  (the installable PWA, ~100 KB)
    npm run serve     # http://localhost:8080

Geolocation, motion sensors and the camera all require a secure context, so use
`https://` or `localhost`.

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

**Rendering.** The mesh is polar: rays fan out from the observer at a fixed
angular step and march outwards with a step that grows to match, in three
segments — geometric near (so the ground at your feet is not one enormous
triangle), one DEM post per step through the middle, geometric again far out.
Triangles stay roughly constant in screen space from 2 m to 270 km, and only the
azimuth wedge in front of the camera is drawn, about a sixth of the panorama at
a typical field of view. Vertices carry no attributes at all: each derives its
(bearing, range) from `gl_VertexID`/`gl_InstanceID` and samples its own height
from the clipmap texture array. Occlusion comes from the depth buffer, which is
logarithmic because one 24-bit buffer has to separate a boulder 3 m away from a
ridge 270 km away.

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

**Labels.** Summits are projected into camera space and depth-tested against the
rendered terrain by drawing one point per summit into a 64-wide off-screen
buffer, where each looks up the terrain's range at its own projected position.
One draw and one small read-back settle every label. Anchors sit at the DEM's
summit rather than the catalogue's — the two disagree by ~120 m on the
Matterhorn — so a marker never floats above its own mountain. Placement is
importance-ordered greedy stacking that drops what will not fit rather than
overlapping it.

**Pose.** Position from GPS; altitude never from GPS. A phone's vertical fix is
routinely tens of metres out and an eye placed 30 m too high tilts the whole
horizon, so altitude is sampled from the DEM and an eye height added.
Orientation is magnetometer plus gyroscope: the gyro is integrated between
compass updates and bled back onto the compass with a 0.7 s time constant.
Magnetic declination comes from WMM-2025 — a centred-dipole approximation is
~16° wrong in the Alps, which is useless. The DeviceOrientation Euler sequence
is Z-X'-Y'', degenerate at beta = 90 which is exactly how a phone is held in AR,
so the code builds the full rotation matrix rather than trusting alpha.

**What is deliberately absent** is any registration against the camera image.
Alignment is sensors plus a manual offset the user drags in — which is why that
offset exists, and why the app shows it as a dot orbiting the compass rather
than hiding it.

## Layout

    src/core/       geodesy, clipmap heightfield, camera, labels, pose, catalogue
    src/render/     WebGL2 passes: terrain, silhouette compose, visibility probe
    src/sources/    terrarium tiles, IndexedDB store, clipmap streamer, Overpass
    src/app/        the app — viewer, camera feed, shell
    src/preview/    the six step-by-step preview pages
    src/ui/         label painter, compass rose, plan view
    tools/          data baking, region codegen, bundling, screenshots

`src/main.ts` wires the app to the network sources; `src/preview/step6.ts` wires
the same `App` class to bundled data. That is the only difference between them.

## Previews

Each step builds to one self-contained HTML file with no external requests —
which is why the elevation data travels as data: URIs inside the bundle.

    npm run build:previews          # -> dist/previews/step1..6.html
    node tools/build_preview.mjs step1

| Step | What it adds | What to check |
| --- | --- | --- |
| 1 | Terrain, curved frame, silhouette | skyline shape; curvature and refraction toggles |
| 2 | Summit labels, occlusion, layout | right name on right peak; hidden peaks stay hidden |
| 3 | GPS, DEM altitude, compass fusion | simulated-device mode: heading, pitch, roll, declination |
| 4 | AR camera overlay | outline on the real ridge; FOV error vs heading error |
| 5 | Tile streaming, offline storage | clipmap re-centring; the IndexedDB figures are real |
| 6 | The finished app | the shipping code path, on bundled data |

Headless verification (Chromium + SwiftShader, synthetic camera):

    node tools/shot.mjs dist/previews/step1.html out.png 900x600
    node tools/shots.mjs dist/previews/step6.html outdir spec.json 430x880

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

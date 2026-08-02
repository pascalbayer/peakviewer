# peakviewer

A mobile PWA peak finder: an on-device elevation model, a GPU-rendered horizon,
and sensor-based labelling of the summits you can actually see.

The architecture follows the same split the commercial apps use — a 2.5D
heightfield rasterised in real time, plus an independently versioned catalogue
of named summits — rather than shipping a 3D model of the Alps.

## How it works

**Elevation.** Terrain is a heightfield, not geometry. Levels are concentric
Web-Mercator crops centred on the observer, each twice the extent and half the
resolution of the one inside it (a clipmap). At runtime they are filled from
[AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) — SRTM /
NASADEM / 3DEP derived, ~30 m posts — and cached on the device. The demo
regions under `data/` are the same structure baked ahead of time.

**Rendering.** The mesh is polar: rays fan out from the observer at a fixed
angular step and march outwards with a step that grows to match, so triangles
stay roughly constant in screen space from 2 m to 270 km, and only the azimuth
wedge in front of the camera is drawn. Vertices carry no attributes at all —
each one derives its (bearing, range) from `gl_VertexID`/`gl_InstanceID` and
samples its own height from the clipmap. Occlusion comes from the depth buffer;
the visible outline is an edge detector run over a range buffer, so ridge lines
follow the geometry rather than the lighting.

**Geometry.** Vertices are placed in a geocentric frame. At 270 km, earth
curvature drops a summit by ~5 km and atmospheric refraction lifts it back by
~700 m of that; without both terms distant peaks land in the wrong place by
degrees, not pixels. Refraction uses the surveyor's effective-radius model,
R/(1−k) with k = 0.13.

**Pose.** Position from GPS, but altitude is sampled from the DEM plus an eye
height — never from the GPS vertical fix, which is routinely tens of metres out.
Orientation is compass + gyro fusion with magnetic declination applied, and a
manual drag offset for the residual error.

## Layout

    src/core/      geodesy, clipmap, camera, peak catalogue
    src/render/    WebGL2 passes: terrain, silhouette compose
    src/data/      baked-region loader
    src/preview/   the step-by-step preview pages
    tools/         data baking, region codegen, preview bundling, screenshots

## Building

    npm install
    npm run gen:region                  # inline data/ into a TS module
    node tools/build_preview.mjs step1   # -> dist/previews/step1.html

Preview pages are single self-contained files with no external requests, so the
elevation data travels as data: URIs inside the bundle.

    npm run typecheck
    node tools/shot.mjs dist/previews/step1.html out.png 900x600

## Data

    python3 tools/bake_dem.py --lon 7.7845 --lat 45.9835 --name gornergrat --out data

Elevation: AWS Terrain Tiles (Mapzen terrarium encoding), public domain /
CC-BY depending on the underlying source. Summit names and positions come from
OpenStreetMap contributors (ODbL) at runtime.

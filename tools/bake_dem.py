#!/usr/bin/env python3
"""Bake a ring-LOD heightfield around a viewpoint from AWS Terrain Tiles.

The output mirrors what the running app streams at runtime: each ring is a
native Web-Mercator crop at a fixed zoom, so no resampling ever happens - the
renderer converts (zoom, pixel) straight to geodetic coordinates.

Heights are split into a high-byte plane and a low-byte plane and stored as two
8-bit PNGs. Browsers truncate 16-bit PNGs to 8 bits through <canvas>, so a
16-bit grayscale file would silently lose the low byte; splitting the planes
also lets zlib compress the smooth high byte far better than an interleaved
RGB encoding would.
"""

import argparse
import json
import math
import os
import subprocess
import sys
import zlib

import numpy as np

TILE = 256
TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
CACHE = os.environ.get("TILE_CACHE", "/tmp/tilecache")


# ---------------------------------------------------------------- projection

def lonlat_to_px(lon, lat, z):
    n = TILE * (1 << z)
    x = (lon + 180.0) / 360.0 * n
    s = math.sin(math.radians(lat))
    y = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n
    return x, y


def px_to_lonlat(x, y, z):
    n = TILE * (1 << z)
    lon = x / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return lon, lat


def ground_res(lat, z):
    """metres per pixel at a latitude (Web Mercator, 256px tiles)"""
    return 156543.033928 * math.cos(math.radians(lat)) / (1 << z)


# ------------------------------------------------------------------- fetching

def fetch_tiles(tiles):
    """tiles: iterable of (z,x,y). Downloads in parallel via curl, cached."""
    todo = []
    for z, x, y in tiles:
        path = f"{CACHE}/{z}_{x}_{y}.png"
        if not os.path.exists(path) or os.path.getsize(path) == 0:
            todo.append((TERRARIUM.format(z=z, x=x, y=y), path))
    if not todo:
        return
    os.makedirs(CACHE, exist_ok=True)
    spec = "\n".join(f"{u}\t{p}" for u, p in todo)
    print(f"  downloading {len(todo)} tiles...", file=sys.stderr)
    subprocess.run(
        ["xargs", "-P", "8", "-d", "\n", "-I", "{}", "sh", "-c",
         'set -- $(printf "%s" "{}" | tr "\\t" " "); curl -sfS --retry 3 -o "$2" "$1"'],
        input=spec, text=True, check=True,
    )


def decode_terrarium(path):
    from PIL import Image
    im = Image.open(path).convert("RGB")
    a = np.asarray(im).astype(np.int32)
    return (a[:, :, 0] * 256 + a[:, :, 1] + a[:, :, 2] / 256.0) - 32768.0


# -------------------------------------------------------------------- mosaic

def mosaic(z, px0, py0, w, h):
    """Heights for the pixel window [px0,px0+w) x [py0,py0+h) at zoom z."""
    tx0, ty0 = px0 // TILE, py0 // TILE
    tx1, ty1 = (px0 + w - 1) // TILE, (py0 + h - 1) // TILE
    n = 1 << z
    want = [(z, tx % n, ty) for ty in range(ty0, ty1 + 1) for tx in range(tx0, tx1 + 1)
            if 0 <= ty < n]
    fetch_tiles(want)

    big = np.zeros(((ty1 - ty0 + 1) * TILE, (tx1 - tx0 + 1) * TILE), dtype=np.float32)
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            if not (0 <= ty < n):
                continue
            p = f"{CACHE}/{z}_{tx % n}_{ty}.png"
            if not os.path.exists(p):
                continue
            big[(ty - ty0) * TILE:(ty - ty0 + 1) * TILE,
                (tx - tx0) * TILE:(tx - tx0 + 1) * TILE] = decode_terrarium(p)
    ox, oy = px0 - tx0 * TILE, py0 - ty0 * TILE
    return big[oy:oy + h, ox:ox + w]


# ------------------------------------------------------------------ png write

def write_png_gray(path, arr):
    """Minimal 8-bit grayscale PNG writer with per-scanline filter search."""
    h, w = arr.shape
    raw = bytearray()
    prev = np.zeros(w, dtype=np.uint8)
    for r in range(h):
        row = arr[r]
        cand = []
        # 0 none, 1 sub, 2 up, 3 avg, 4 paeth
        cand.append((0, row.astype(np.uint8)))
        cand.append((1, (row - np.concatenate(([0], row[:-1]))).astype(np.uint8)))
        cand.append((2, (row - prev).astype(np.uint8)))
        a = np.concatenate(([0], row[:-1])).astype(np.int32)
        b = prev.astype(np.int32)
        c = np.concatenate(([0], prev[:-1])).astype(np.int32)
        cand.append((3, (row - ((a + b) // 2)).astype(np.uint8)))
        p = a + b - c
        pa, pb, pc = np.abs(p - a), np.abs(p - b), np.abs(p - c)
        pred = np.where((pa <= pb) & (pa <= pc), a, np.where(pb <= pc, b, c))
        cand.append((4, (row - pred).astype(np.uint8)))
        # minimum sum of absolute differences heuristic (as libpng does)
        ft, data = min(cand, key=lambda t: int(np.abs(t[1].astype(np.int8)).sum()))
        raw.append(ft)
        raw += data.tobytes()
        prev = row

    def chunk(tag, data):
        return (len(data).to_bytes(4, "big") + tag + data
                + zlib.crc32(tag + data).to_bytes(4, "big"))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", w.to_bytes(4, "big") + h.to_bytes(4, "big") + bytes([8, 0, 0, 0, 0]))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)
    return len(png)


# ---------------------------------------------------------------------- rings

def bake(lon, lat, rings, outdir, name):
    os.makedirs(outdir, exist_ok=True)
    meta = {"name": name, "origin": {"lon": lon, "lat": lat}, "rings": []}
    total = 0
    for i, (half_km, z, quant) in enumerate(rings):
        res = ground_res(lat, z)
        half_px = int(round(half_km * 1000.0 / res))
        cx, cy = lonlat_to_px(lon, lat, z)
        px0, py0 = int(round(cx)) - half_px, int(round(cy)) - half_px
        w = h = half_px * 2 + 1
        print(f"ring{i}: z{z} {w}x{h} px @ {res:.1f} m  (+-{half_km} km)", file=sys.stderr)
        hm = mosaic(z, px0, py0, w, h)

        q = np.clip(np.round(hm / quant), -1000, 9000).astype(np.int32) + 1000
        hi = (q >> 8).astype(np.uint8)
        lo = (q & 255).astype(np.uint8)
        nhi = write_png_gray(f"{outdir}/{name}_r{i}_hi.png", hi)
        nlo = write_png_gray(f"{outdir}/{name}_r{i}_lo.png", lo)
        total += nhi + nlo
        print(f"        hi={nhi/1024:.0f}K lo={nlo/1024:.0f}K", file=sys.stderr)

        meta["rings"].append({
            "z": z, "px0": px0, "py0": py0, "w": w, "h": h,
            "res": res, "halfKm": half_km, "quant": quant, "bias": -1000 * quant,
            "hi": f"{name}_r{i}_hi.png", "lo": f"{name}_r{i}_lo.png",
        })
        np.save(f"{outdir}/{name}_r{i}.npy", hm.astype(np.float32))

    # height(m) = (hi*256 + lo) * quant + bias
    with open(f"{outdir}/{name}.json", "w") as f:
        json.dump(meta, f, indent=1)
    print(f"total png {total/1024/1024:.2f} MB", file=sys.stderr)
    return meta


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--lon", type=float, required=True)
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--out", default="data")
    ap.add_argument("--rings", default="8.5:12:1,17:11:1,34:10:2,68:9:2,136:8:4,272:7:4",
                    help="comma list of halfKm:zoom:quantMetres")
    a = ap.parse_args()
    rings = [(float(p[0]), int(p[1]), int(p[2])) for p in (r.split(":") for r in a.rings.split(","))]
    bake(a.lon, a.lat, rings, a.out, a.name)

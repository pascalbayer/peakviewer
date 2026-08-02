#!/usr/bin/env python3
"""Derive a summit catalogue from a baked elevation model.

The shipping app reads summits from OpenStreetMap. This exists because the
preview pages must be self-contained and cannot call Overpass, so the demo
region needs a catalogue baked in.

Positions and elevations come from the DEM by textbook key-saddle prominence,
which is exact for the grid it runs on. Names come from a hand-written list of
approximate coordinates and are attached by a one-to-one assignment that scores
both distance and elevation agreement — a name that does not match a real
summit confidently is dropped rather than guessed onto the wrong mountain.
"""

import argparse
import json
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bake_dem import px_to_lonlat, ground_res  # noqa: E402


# ----------------------------------------------------------------- prominence

def find_summits(hm, min_prom):
    """Key-saddle prominence over a grid.

    Cells are added highest first. Each connected component of already-added
    cells remembers its highest cell. When adding a cell joins two or more
    components, that cell is their key saddle: every component except the
    tallest is closed off, and its summit's prominence is its height minus the
    saddle. This is the standard construction and it is exact for the grid.
    """
    h, w = hm.shape
    flat = hm.ravel()
    order = np.argsort(-flat, kind="stable")

    parent = np.full(flat.size, -1, dtype=np.int64)   # -1 = not yet added
    top = np.zeros(flat.size, dtype=np.int64)         # component -> summit cell

    def find(x):
        root = x
        while parent[root] != root:
            root = parent[root]
        while parent[x] != root:
            parent[x], x = root, parent[x]
        return root

    results = []
    for idx in order:
        y, x = divmod(int(idx), w)
        parent[idx] = idx
        top[idx] = idx
        roots = []
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w:
                n = ny * w + nx
                if parent[n] != -1:
                    r = find(n)
                    if r not in roots:
                        roots.append(r)
        if not roots:
            continue
        roots.sort(key=lambda r: -flat[top[r]])
        keeper = roots[0]
        for r in roots[1:]:
            summit = top[r]
            prom = float(flat[summit] - flat[idx])
            if prom >= min_prom:
                results.append((int(summit), prom))
            parent[r] = keeper
        # the new cell always joins the tallest neighbouring component
        parent[find(idx)] = keeper
        parent[keeper] = keeper

    # The highest cell in the grid never merges into anything; treat its
    # prominence as its height above the lowest cell present.
    highest = int(order[0])
    results.append((highest, float(flat[highest] - flat.min())))
    return results


def summits_for_level(hm, meta, min_prom, edge_margin=3):
    h, w = hm.shape
    out = []
    for cell, prom in find_summits(hm, min_prom):
        y, x = divmod(cell, w)
        if x < edge_margin or y < edge_margin or x >= w - edge_margin or y >= h - edge_margin:
            continue
        lon, lat = px_to_lonlat(meta["px0"] + x + 0.5, meta["py0"] + y + 0.5, meta["z"])
        out.append({"lon": lon, "lat": lat, "ele": float(hm[y, x]), "prom": prom,
                    "res": meta["res"]})
    return out


# ---------------------------------------------------------------------- merge

def haversine(a, b):
    R = 6371008.8
    p1, p2 = math.radians(a["lat"]), math.radians(b["lat"])
    dp = p2 - p1
    dl = math.radians(b["lon"] - a["lon"])
    x = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(min(1.0, math.sqrt(x)))


def merge(groups):
    """Keep the finest-resolution detection of each summit."""
    kept = []
    for group in groups:                       # finest level first
        for c in sorted(group, key=lambda p: -p["prom"]):
            radius = max(3 * c["res"], 400)
            if any(haversine(c, k) < max(radius, 3 * k["res"], 400) for k in kept):
                continue
            kept.append(c)
    return kept


# ---------------------------------------------------------------------- names

def assign_names(candidates, catalogue, max_dist=1500):
    """One-to-one match of catalogued names onto detected summits.

    Distance dominates the score and elevation only gates it. A grid DEM
    *understates* a sharp summit — a 30 m posting cannot represent the top of
    the Matterhorn, and it loses more the coarser the level — so the expected
    deficit is one-sided and grows with resolution. Scoring on |delta ele|
    instead hands each summit to whichever catalogue entry happens to sit
    closest to the truncated height, which is how Dufourspitze ends up
    labelled Nordend.

    Everything is scored first and claimed best-first, so a name cannot take a
    summit that fits another name far better.
    """
    scored = []
    for ci, entry in enumerate(catalogue):
        for si, cand in enumerate(candidates):
            d = haversine(entry, cand)
            if d > max_dist:
                continue
            deficit = entry["ele"] - cand["ele"]        # positive = DEM lower
            expected = 40 + 0.25 * cand["res"]
            if deficit < -60 or deficit > 130 + 0.6 * cand["res"]:
                continue
            over = max(0.0, deficit - expected) / 200.0
            scored.append(((d / 400.0) ** 2 + over * over, ci, si, d, abs(deficit)))
    scored.sort()

    taken_name, taken_summit, matches = set(), set(), {}
    for score, ci, si, d, de in scored:
        if ci in taken_name or si in taken_summit:
            continue
        taken_name.add(ci)
        taken_summit.add(si)
        matches[si] = (catalogue[ci], d, de, score)
    unmatched = [c["name"] for i, c in enumerate(catalogue) if i not in taken_name]
    return matches, unmatched


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--region", required=True, help="path to data/<name>.json")
    ap.add_argument("--catalogue", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--levels", default="1:120,3:320,5:700",
                    help="comma list of levelIndex:minProminence")
    ap.add_argument("--keep-unnamed", type=float, default=500.0,
                    help="minimum prominence for an unnamed summit to survive")
    a = ap.parse_args()

    meta = json.load(open(a.region))
    base = os.path.dirname(a.region)
    catalogue = json.load(open(a.catalogue))

    groups = []
    for spec in a.levels.split(","):
        li, mp = spec.split(":")
        li, mp = int(li), float(mp)
        ring = meta["rings"][li]
        hm = np.load(f"{base}/{meta['name']}_r{li}.npy")
        found = summits_for_level(hm, ring, mp)
        print(f"level {li} (z{ring['z']}, {ring['res']:.0f} m): {len(found)} summits "
              f"with prominence >= {mp:.0f} m", file=sys.stderr)
        groups.append(found)

    candidates = merge(groups)
    print(f"merged: {len(candidates)} distinct summits", file=sys.stderr)

    matches, unmatched = assign_names(candidates, catalogue)
    print(f"\nnamed {len(matches)} of {len(catalogue)} catalogue entries\n", file=sys.stderr)
    print(f"{'name':22} {'cat ele':>8} {'dem ele':>8} {'moved':>7} {'prom':>7}", file=sys.stderr)
    for si, (entry, d, de, _) in sorted(matches.items(), key=lambda kv: -kv[1][0]["ele"]):
        c = candidates[si]
        print(f"{entry['name']:22} {entry['ele']:8.0f} {c['ele']:8.0f} "
              f"{d:6.0f} m {c['prom']:6.0f} m", file=sys.stderr)
    if unmatched:
        print(f"\nno confident match, dropped: {', '.join(unmatched)}", file=sys.stderr)

    peaks = []
    for si, cand in enumerate(candidates):
        if si in matches:
            entry = matches[si][0]
            peaks.append({
                "id": f"cat:{entry['name'].lower().replace(' ', '_')}",
                "name": entry["name"],
                "lon": round(cand["lon"], 6), "lat": round(cand["lat"], 6),
                "ele": entry["ele"],
                "demEle": round(cand["ele"]),
                "prom": round(cand["prom"]),
                "src": "catalogue+DEM",
            })
        elif cand["prom"] >= a.keep_unnamed:
            peaks.append({
                "id": f"dem:{cand['lon']:.4f},{cand['lat']:.4f}",
                "name": f"Pt. {round(cand['ele'])}",
                "lon": round(cand["lon"], 6), "lat": round(cand["lat"], 6),
                "demEle": round(cand["ele"]),
                "prom": round(cand["prom"]),
                "src": "DEM",
            })
    peaks.sort(key=lambda p: -(p.get("ele") or p["demEle"]))
    json.dump(peaks, open(a.out, "w"), indent=1)
    print(f"\nwrote {len(peaks)} peaks to {a.out}", file=sys.stderr)

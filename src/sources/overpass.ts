/**
 * Named summits from OpenStreetMap, via Overpass.
 *
 * Kept deliberately separate from the elevation model. The two move on
 * different clocks — an OSM edit is live within a day, a DEM release every few
 * years — and they disagree about elevation often enough that the app treats
 * the catalogue as the authority on *identity* and the DEM as the authority on
 * *geometry*.
 *
 * Results are cached per whole-degree cell so a walk around one valley is a
 * single query, and so the app still names peaks with the network off.
 */

import { Peak } from '../core/peaks';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const CACHE_DB = 'peakviewer-peaks';
const STORE = 'cells';
/** OSM edits reach the app within a day, so a cell older than this is refetched. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * How long a cell that failed waits before it is worth asking again. The public
 * Overpass endpoints rate-limit hard and answer 429 or 504 under load, so a
 * failure says more about the minute than about the place.
 */
const RETRY_MS = 30 * 1000;

interface CellRecord {
  id: string;
  peaks: Peak[];
  fetched: number;
}

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(CACHE_DB, 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(STORE)) {
        r.result.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function parseEle(tags: Record<string, string>): number | undefined {
  const raw = tags.ele ?? tags['ele:m'];
  if (!raw) return undefined;
  const v = parseFloat(raw.replace(',', '.'));
  return Number.isFinite(v) ? v : undefined;
}

function toPeaks(elements: OverpassElement[]): Peak[] {
  const out: Peak[] = [];
  for (const e of elements) {
    const lat = e.lat ?? e.center?.lat;
    const lon = e.lon ?? e.center?.lon;
    const tags = e.tags ?? {};
    if (lat === undefined || lon === undefined) continue;
    const name = tags.name ?? tags['name:en'] ?? tags['name:de'] ?? tags['name:it']
      ?? tags['name:fr'];
    if (!name) continue;
    out.push({
      id: `osm:${e.type}/${e.id}`,
      name,
      lon,
      lat,
      ele: parseEle(tags),
      src: 'OpenStreetMap',
      tags: {
        ...(tags.natural ? { natural: tags.natural } : {}),
        ...(tags.wikipedia ? { wikipedia: tags.wikipedia } : {}),
      },
    });
  }
  return out;
}

export interface PeakSourceStatus {
  cells: number;
  peaks: number;
  lastError: string | null;
  fetching: number;
  offline: boolean;
}

export class OverpassPeaks {
  readonly status: PeakSourceStatus = {
    cells: 0, peaks: 0, lastError: null, fetching: 0, offline: false,
  };

  private db: Promise<IDBDatabase> | null = null;
  private cells = new Map<string, Peak[]>();
  private inflight = new Map<string, Promise<Peak[]>>();
  /** Cell id -> when it is worth querying again after a failure. */
  private cooldown = new Map<string, number>();

  private handle(): Promise<IDBDatabase> {
    if (!this.db) this.db = openDb();
    return this.db;
  }

  private async readCell(id: string): Promise<CellRecord | null> {
    try {
      const db = await this.handle();
      const tx = db.transaction(STORE, 'readonly');
      return await new Promise((res) => {
        const r = tx.objectStore(STORE).get(id);
        r.onsuccess = () => res((r.result as CellRecord) ?? null);
        r.onerror = () => res(null);
      });
    } catch {
      return null;
    }
  }

  private async writeCell(rec: CellRecord): Promise<void> {
    try {
      const db = await this.handle();
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(rec);
    } catch { /* a cache miss next time is the only cost */ }
  }

  /** Every summit within `radiusKm`, from cache where possible. */
  async around(lon: number, lat: number, radiusKm: number): Promise<Peak[]> {
    const dLat = radiusKm / 111.32;
    const dLon = radiusKm / (111.32 * Math.max(0.15, Math.cos((lat * Math.PI) / 180)));
    const ids = new Set<string>();
    for (let la = Math.floor(lat - dLat); la <= Math.floor(lat + dLat); la++) {
      for (let lo = Math.floor(lon - dLon); lo <= Math.floor(lon + dLon); lo++) {
        ids.add(`${la}_${lo}`);
      }
    }
    const groups = await Promise.all([...ids].map((id) => this.cell(id)));
    const merged = new Map<string, Peak>();
    for (const g of groups) for (const p of g) merged.set(p.id, p);
    this.status.cells = this.cells.size;
    this.status.peaks = merged.size;
    return [...merged.values()];
  }

  private cell(id: string): Promise<Peak[]> {
    const hot = this.cells.get(id);
    if (hot) return Promise.resolve(hot);
    const pending = this.inflight.get(id);
    if (pending) return pending;

    const job = (async () => {
      const cached = await this.readCell(id);
      if (cached && Date.now() - cached.fetched < MAX_AGE_MS) {
        this.cells.set(id, cached.peaks);
        return cached.peaks;
      }
      // Still cooling off from a failure: hand back whatever is on disk rather
      // than queueing another request that is likely to be refused too.
      if (Date.now() < (this.cooldown.get(id) ?? 0)) return cached?.peaks ?? [];

      const [la, lo] = id.split('_').map(Number);
      const fresh = await this.query(la, lo);
      if (fresh) {
        this.cooldown.delete(id);
        this.cells.set(id, fresh);
        void this.writeCell({ id, peaks: fresh, fetched: Date.now() });
        return fresh;
      }
      // Network failed: stale beats nothing, and offline is the normal case.
      // The failure is deliberately *not* remembered as a result — caching an
      // empty list in `cells` would make one rate-limited request mean no
      // summit names at all until the page is reloaded.
      this.cooldown.set(id, Date.now() + RETRY_MS);
      return cached?.peaks ?? [];
    })().finally(() => this.inflight.delete(id));

    this.inflight.set(id, job);
    return job;
  }

  private async query(la: number, lo: number): Promise<Peak[] | null> {
    const bbox = `${la},${lo},${la + 1},${lo + 1}`;
    const q = `[out:json][timeout:40];(node["natural"="peak"](${bbox});`
      + `node["natural"="volcano"](${bbox}););out body;`;
    this.status.fetching++;
    try {
      for (const url of ENDPOINTS) {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `data=${encodeURIComponent(q)}`,
          });
          if (!res.ok) {
            // 429 and 504 are the usual answers from a busy public endpoint,
            // and they are worth showing: "no summit names" and "Overpass is
            // rate-limiting you" look identical from the viewfinder.
            this.status.lastError = `${new URL(url).host}: HTTP ${res.status}`;
            continue;
          }
          const json = await res.json() as { elements?: OverpassElement[] };
          this.status.lastError = null;
          this.status.offline = false;
          return toPeaks(json.elements ?? []);
        } catch (e) {
          this.status.lastError = e instanceof Error ? e.message : String(e);
        }
      }
      this.status.offline = true;
      return null;
    } finally {
      this.status.fetching--;
    }
  }
}

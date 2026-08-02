/**
 * On-device tile store.
 *
 * Compressed tile bytes go into IndexedDB, not decoded heights: a 256x256
 * terrarium PNG is ~100 KB on disk and 256 KB as float32 in memory, and the
 * whole point of the offline mode is to keep a lot of them. Decoded tiles live
 * in a small in-memory LRU in front of it.
 */

const DB_NAME = 'peakviewer';
const DB_VERSION = 1;
const STORE = 'tiles';
const META = 'regions';

export interface StoredTile {
  id: string;
  bytes: ArrayBuffer;
  /** Epoch millis of the last use, for eviction. */
  used: number;
}

export interface RegionRecord {
  id: string;
  name: string;
  lon: number;
  lat: number;
  radiusKm: number;
  tiles: number;
  bytes: number;
  added: number;
}

export interface StoreStats {
  tiles: number;
  bytes: number;
  regions: RegionRecord[];
}

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

function idle<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export class TileStore {
  private db: Promise<IDBDatabase> | null = null;
  /** Set when IndexedDB is unavailable (private mode, blocked storage). */
  unavailable = false;

  private handle(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = open().catch((e) => {
        this.unavailable = true;
        throw e;
      });
    }
    return this.db;
  }

  async get(id: string): Promise<ArrayBuffer | null> {
    if (this.unavailable) return null;
    try {
      const db = await this.handle();
      const tx = db.transaction(STORE, 'readonly');
      const rec = await idle<StoredTile | undefined>(tx.objectStore(STORE).get(id));
      return rec?.bytes ?? null;
    } catch {
      return null;
    }
  }

  async put(id: string, bytes: ArrayBuffer): Promise<void> {
    if (this.unavailable) return;
    try {
      const db = await this.handle();
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ id, bytes, used: Date.now() } satisfies StoredTile);
      await new Promise((r) => { tx.oncomplete = r; tx.onerror = r; });
    } catch { /* a full or blocked store is not fatal — tiles refetch */ }
  }

  async has(id: string): Promise<boolean> {
    if (this.unavailable) return false;
    try {
      const db = await this.handle();
      const tx = db.transaction(STORE, 'readonly');
      const k = await idle(tx.objectStore(STORE).getKey(id));
      return k !== undefined;
    } catch {
      return false;
    }
  }

  async stats(): Promise<StoreStats> {
    if (this.unavailable) return { tiles: 0, bytes: 0, regions: [] };
    try {
      const db = await this.handle();
      const tx = db.transaction([STORE, META], 'readonly');
      const all = await idle<StoredTile[]>(tx.objectStore(STORE).getAll());
      const regions = await idle<RegionRecord[]>(tx.objectStore(META).getAll());
      return {
        tiles: all.length,
        bytes: all.reduce((a, t) => a + t.bytes.byteLength, 0),
        regions: regions.sort((a, b) => b.added - a.added),
      };
    } catch {
      return { tiles: 0, bytes: 0, regions: [] };
    }
  }

  async putRegion(r: RegionRecord): Promise<void> {
    if (this.unavailable) return;
    const db = await this.handle();
    const tx = db.transaction(META, 'readwrite');
    tx.objectStore(META).put(r);
    await new Promise((res) => { tx.oncomplete = res; tx.onerror = res; });
  }

  async deleteRegion(id: string): Promise<void> {
    if (this.unavailable) return;
    const db = await this.handle();
    const tx = db.transaction(META, 'readwrite');
    tx.objectStore(META).delete(id);
    await new Promise((res) => { tx.oncomplete = res; tx.onerror = res; });
  }

  async clearTiles(): Promise<void> {
    if (this.unavailable) return;
    const db = await this.handle();
    const tx = db.transaction([STORE, META], 'readwrite');
    tx.objectStore(STORE).clear();
    tx.objectStore(META).clear();
    await new Promise((res) => { tx.oncomplete = res; tx.onerror = res; });
  }

  /** Browser's own view of how much room is left. */
  async quota(): Promise<{ usage: number; quota: number } | null> {
    if (!navigator.storage?.estimate) return null;
    const e = await navigator.storage.estimate();
    return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
  }
}

/** Small in-memory cache of decoded tiles, keyed by tile id. */
export class DecodedCache {
  private map = new Map<string, Float32Array>();
  constructor(public limit = 220) {}

  get(id: string): Float32Array | undefined {
    const v = this.map.get(id);
    if (v) { this.map.delete(id); this.map.set(id, v); }  // refresh recency
    return v;
  }

  set(id: string, data: Float32Array) {
    this.map.set(id, data);
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get size(): number { return this.map.size; }
  clear() { this.map.clear(); }
}

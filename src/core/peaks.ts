/**
 * The named-summit database.
 *
 * Deliberately independent of the elevation model: names and positions come
 * from GIS sources (OpenStreetMap and friends) that change on a completely
 * different schedule from the DEM, and a peak's catalogued elevation routinely
 * disagrees with the DEM under it by tens of metres. The renderer always trusts
 * the DEM for geometry; the catalogue supplies identity.
 */

export interface Peak {
  /** Stable id, e.g. "osm:node/12345" or "dem:4f2a". */
  id: string;
  name: string;
  lon: number;
  lat: number;
  /** Catalogued elevation, metres. May be absent in raw OSM data. */
  ele?: number;
  /**
   * The DEM's elevation at this summit. Usually lower than `ele` — a 30 m grid
   * cannot hold the top of a sharp peak — and it is what the label anchors to,
   * so the marker sits on the summit the renderer actually drew.
   */
  demEle?: number;
  /** Topographic prominence, metres, when known. */
  prom?: number;
  /** Where the record came from. */
  src?: string;
  /** Free-form extras (region, first ascent, ...). */
  tags?: Record<string, string>;
}

/** Ranking score used to decide which labels get the scarce screen space. */
export function peakImportance(p: Peak): number {
  const ele = p.ele ?? 0;
  const prom = p.prom ?? 0;
  return ele * 0.35 + prom * 1.6 + (p.name ? 400 : 0);
}

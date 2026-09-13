import { json2satrec, type SatRec } from 'satellite.js';
import { decodeCatalog, type Kind } from './catalog-format';

export interface CatalogEntry {
  name: string;
  /** NORAD catalogue number. Up to 9 digits since 2026-07-11. */
  catnr: number;
  /** Coarse, from the name - see `kindFromName`. */
  kind: Kind;
  satrec: SatRec;
}

export interface Catalog {
  entries: CatalogEntry[];
  /** When the element sets were fetched from CelesTrak. */
  generatedAt: Date;
  /** Element sets SGP4 rejected at init - decayed or corrupt. Real data has a few. */
  dropped: number;
}

/**
 * Load a packed catalogue and build a satrec for every object.
 *
 * `json2satrec`, not `twoline2satrec`: there is no TLE text anywhere at runtime,
 * and objects catalogued since 2026-07-11 have no TLE to parse. Measured at ~8 ms
 * per thousand objects, so the 21k-object `full` set costs under 200 ms here.
 */
export async function loadCatalog(url: string): Promise<Catalog> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to load ${url}: ${res.status} ${res.statusText}`);

  // Throws on a bad magic number - which is also what a dev server's HTML 404 page
  // looks like when it answers a missing file with 200.
  const packed = decodeCatalog(await res.arrayBuffer());

  const entries: CatalogEntry[] = [];
  let dropped = 0;

  for (let i = 0; i < packed.count; i++) {
    const satrec = json2satrec({ ...packed.elementsAt(i), OBJECT_ID: '', ELEMENT_SET_NO: 0 });
    if (satrec.error) {
      dropped++;
      continue;
    }
    entries.push({
      name: packed.names[i]!,
      catnr: packed.catnr[i]!,
      kind: packed.kind[i] as Kind,
      satrec,
    });
  }

  return { entries, generatedAt: packed.generatedAt, dropped };
}

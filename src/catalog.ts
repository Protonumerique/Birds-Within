import { readCatalogHeader, type CatalogHeader } from './catalog-format';

export interface FetchedCatalog {
  bytes: ArrayBuffer;
  header: CatalogHeader;
}

/**
 * Fetch a packed catalogue and check that it is one.
 *
 * Only the header is read here. Decoding, building satrecs and propagating all
 * happen in the sky worker (src/sky.worker.ts), so satellite.js never loads on the
 * render thread at all - these bytes are transferred to the worker, not copied.
 */
export async function fetchCatalog(url: string): Promise<FetchedCatalog> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to load ${url}: ${res.status} ${res.statusText}`);
  const bytes = await res.arrayBuffer();

  // Throws on a bad magic number - which is also what a dev server's HTML 404 page
  // looks like when it answers a missing file with 200.
  return { bytes, header: readCatalogHeader(bytes) };
}

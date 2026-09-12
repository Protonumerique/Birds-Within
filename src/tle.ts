import { twoline2satrec, type SatRec } from 'satellite.js';

export interface CatalogEntry {
  name: string;
  /** NORAD catalogue number. */
  catnr: number;
  satrec: SatRec;
}

/**
 * Parse CelesTrak 3LE text (name line + two element lines, repeating).
 *
 * Blank lines and `#` comments are skipped, so the vendored placeholder file can
 * carry a header. Anything that fails to parse is dropped with a warning rather
 * than taking the whole catalogue down - at 30k objects there will always be a
 * few malformed or decayed entries.
 */
export function parseTle(text: string): CatalogEntry[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0 && !l.startsWith('#'));

  const out: CatalogEntry[] = [];

  for (let i = 0; i + 2 < lines.length + 1; i += 3) {
    const name = lines[i];
    const l1 = lines[i + 1];
    const l2 = lines[i + 2];
    if (!name || !l1 || !l2) break;

    if (!l1.startsWith('1 ') || !l2.startsWith('2 ')) {
      console.warn(`[tle] skipping malformed entry near line ${i}: ${name}`);
      continue;
    }

    try {
      const satrec = twoline2satrec(l1, l2);
      out.push({
        name: name.trim(),
        catnr: Number.parseInt(l2.slice(2, 7).trim(), 10),
        satrec,
      });
    } catch (err) {
      console.warn(`[tle] skipping ${name}: ${String(err)}`);
    }
  }

  return out;
}

export async function loadCatalog(url: string): Promise<CatalogEntry[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to load ${url}: ${res.status} ${res.statusText}`);
  return parseTle(await res.text());
}

/**
 * What the piece is built from. Shared by fetch-catalog.mjs, pack-catalog.mjs,
 * check-catalog.mjs and make-synthetic.mjs, so they cannot disagree.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Raw CelesTrak JSON. Gitignored; carried between CI runs by the Actions cache. */
export const CACHE_DIR = '.catalog-cache';

/** CelesTrak updates GP data every 2 hours and 403s a repeat inside the cycle. */
export const MIN_REFETCH_MS = 2 * 60 * 60 * 1000;

/** CelesTrak asks automated clients to identify themselves. */
export const USER_AGENT =
  'birds-within/0.2 (satellite art project; https://github.com/Protonumerique/birds-within)';

/**
 * Every CelesTrak GP dataset that contributes objects.
 *
 * CelesTrak publishes no full-catalogue query. On 2026-09-13 their SATCAT counted
 * 35,093 objects on orbit, and the union of everything below was 20,933: every
 * payload, but only ~3k of the ~15k debris, almost all of it from three breakups.
 * General debris and most rocket bodies are not published as GP data at all.
 * Space-Track has them, but requires an account and restricts redistribution,
 * which a public page shipping element sets to browsers would be.
 *
 * Counts in the comments are from 2026-09-13, for scale only.
 */
export const SOURCES = [
  { id: 'active', query: 'GROUP=active' }, // 16,563 - payloads
  { id: 'analyst', query: 'GROUP=analyst' }, // 566 - tracked, not yet identified
  { id: 'last-30-days', query: 'GROUP=last-30-days' }, // 255, 19 not in active
  { id: 'gpz-plus', query: 'SPECIAL=GPZ-PLUS' }, // 1,728 - GEO protected zone, incl. its rocket bodies and debris
  { id: 'decaying', query: 'SPECIAL=DECAYING' }, // 95
  { id: 'fengyun-1c-debris', query: 'GROUP=fengyun-1c-debris' }, // 1,969 - 2007 ASAT test
  { id: 'cosmos-2251-debris', query: 'GROUP=cosmos-2251-debris' }, // 585 - 2009 collision
  { id: 'iridium-33-debris', query: 'GROUP=iridium-33-debris' }, // 110 - same collision
];

export const gpUrl = ({ query }) => `https://celestrak.org/NORAD/elements/gp.php?${query}&FORMAT=json`;

/** The packed catalogues the browser can load, and the sources each is the union of. */
export const DATASETS = {
  active: ['active'],
  full: SOURCES.map((s) => s.id),
};

#!/usr/bin/env node
/**
 * Download the CelesTrak GP datasets the piece is built from, as OMM JSON, into
 * .catalog-cache/. pack-catalog.mjs turns that into public/data/*.bin.
 *
 * This is the ONLY thing in the project that talks to CelesTrak. The browser never
 * does, for two reasons: CelesTrak sends no CORS headers, and more importantly
 * their terms are enforced - one download per dataset per 2-hour update cycle, HTTP
 * 403 and then IP-level firewall blocks on abuse, restrictions past 100 MB/day. A
 * public page fetching directly would put every visitor's request on our account.
 *
 * So this script is deliberately timid:
 *   - A dataset fetched under 2 hours ago is not requested at all.
 *   - Nothing is retried. A 403 means "not updated since your last download" or
 *     worse, and asking again only makes a block more likely.
 *   - Any failure with a cached copy on disk keeps that copy and moves on.
 *   - Requests go one at a time, with an identifying User-Agent.
 *
 * A full run is ~9 MB across 8 requests, four times a day from CI - well inside
 * the 100 MB/day limit even counting pushes.
 *
 *   npm run fetch:catalog     fetch, then pack
 *   in CI                     .github/workflows/deploy.yml, every 6 h and on push
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CACHE_DIR, MIN_REFETCH_MS, ROOT, SOURCES, USER_AGENT, gpUrl } from './catalog-sources.mjs';

const dir = resolve(ROOT, CACHE_DIR);
await mkdir(dir, { recursive: true });

const readMeta = async (id) => {
  try {
    return JSON.parse(await readFile(resolve(dir, `${id}.meta.json`), 'utf8'));
  } catch {
    return null;
  }
};

const ago = (ms) => (ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);
const indent = ' '.repeat(24);

let unavailable = 0;

for (const source of SOURCES) {
  const label = `  ${source.id.padEnd(20)}`;
  const meta = await readMeta(source.id);
  const age = meta ? Date.now() - Date.parse(meta.fetchedAt) : Infinity;

  if (age < MIN_REFETCH_MS) {
    console.log(`${label}cached ${ago(age)} ago, inside CelesTrak's 2 h cycle - not requested`);
    continue;
  }

  const url = gpUrl(source);
  let problem;

  try {
    const res = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
    const body = await res.text();

    let records = null;
    if (res.ok) {
      try {
        records = JSON.parse(body);
      } catch {
        /* handled below */
      }
    }

    if (!res.ok) {
      problem = `HTTP ${res.status}: ${body.trim().slice(0, 140)}`;
    } else if (!Array.isArray(records)) {
      // CelesTrak answers some errors with HTTP 200 and a plain-text body.
      problem = `not a JSON array: ${body.trim().slice(0, 140)}`;
    } else {
      // Write-then-rename, so an interrupted run never leaves half a file behind.
      const tmp = resolve(dir, `${source.id}.json.tmp`);
      await writeFile(tmp, body, 'utf8');
      await rename(tmp, resolve(dir, `${source.id}.json`));
      await writeFile(
        resolve(dir, `${source.id}.meta.json`),
        JSON.stringify({ id: source.id, url, fetchedAt: new Date().toISOString(), count: records.length }, null, 2) + '\n'
      );
      console.log(`${label}${String(records.length).padStart(6)} objects  ${(body.length / 1_048_576).toFixed(1)} MB`);
      continue;
    }
  } catch (err) {
    problem = String(err);
  }

  if (meta) {
    console.warn(`${label}${problem}\n${indent}keeping the cached copy from ${ago(age)} ago`);
  } else {
    console.error(`${label}${problem}\n${indent}and nothing cached to fall back on`);
    unavailable++;
  }
}

if (unavailable) {
  console.error(
    `\n${unavailable} dataset(s) unavailable. Do not retry in a loop - CelesTrak firewalls IPs that do.\n` +
      'Wait for the next 2-hour cycle.'
  );
  process.exit(1);
}

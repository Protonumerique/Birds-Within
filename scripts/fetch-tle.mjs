#!/usr/bin/env node
/**
 * Fetch a GP dataset from CelesTrak and write it into public/data/.
 *
 * This is the ONLY thing that talks to CelesTrak. The browser never does, for two
 * reasons: CelesTrak sends no CORS headers, and more importantly their terms are
 * enforced - one download per dataset per 2-hour update cycle, HTTP 403 and then
 * IP-level firewall blocks on abuse, restrictions past 100 MB/day. A public page
 * fetching directly would put every visitor's request on our account.
 *
 * Run locally:   npm run fetch:tle
 *                npm run fetch:tle -- --group=active --out=active.tle
 * In CI:         .github/workflows/update-tle.yml, every 6 hours
 *
 * Their guidance is explicit: do not poll more often than every 2 hours, and a 403
 * or 404 will not change by retrying. So this script does not retry.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const arg = (name, fallback) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const group = arg('group', 'stations');
const out = arg('out', `${group}.tle`);
const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=tle`;

const res = await fetch(url, {
  headers: {
    // Identify the client. CelesTrak asks that automated consumers be identifiable.
    'user-agent': 'birds-within/0.1 (satellite art project; contact via repo)',
  },
});

if (!res.ok) {
  console.error(`CelesTrak returned ${res.status} ${res.statusText} for GROUP=${group}`);
  if (res.status === 403) {
    console.error(
      'A 403 usually means this dataset was already fetched inside the current\n' +
        '2-hour update cycle, or the daily bandwidth limit was exceeded. Retrying\n' +
        'will not help and repeated attempts risk an IP block. Wait and try later.'
    );
  }
  process.exit(1);
}

const body = await res.text();

// CelesTrak answers some errors with HTTP 200 and a plain-text body.
if (!/^\s*1 \d{5}/m.test(body)) {
  console.error('Response does not look like TLE data. First 200 characters:\n');
  console.error(body.slice(0, 200));
  process.exit(1);
}

const objects = body.split('\n').filter((l) => l.startsWith('1 ')).length;
const header =
  `# CelesTrak GROUP=${group}, retrieved ${new Date().toISOString()}\n` +
  `# ${objects} objects. Source: ${url}\n`;

const target = resolve(ROOT, 'public/data', out);
await mkdir(dirname(target), { recursive: true });
await writeFile(target, header + body.replace(/\r\n/g, '\n'), 'utf8');

console.log(`wrote ${objects} objects to public/data/${out}`);

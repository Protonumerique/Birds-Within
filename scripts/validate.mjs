/**
 * Validate the browser-side propagation chain against an independent implementation.
 *
 * Compares satellite.js (what ships to the browser) against sgp4 + skyfield
 * (Python, Vallado's C++ reference) for the same elements and the same instants,
 * along every road a satrec can take in this project:
 *
 *   twoline2satrec  TLE text straight in - what reference.json was computed from
 *   json2satrec     the same elements as the OMM record CelesTrak would publish,
 *                   which is what the browser builds satrecs from
 *   packed          that OMM record through src/catalog-format.ts encode -> decode
 *                   first - exactly what a visitor's browser receives
 *
 *   python3 scripts/reference.py > scripts/reference.json   # regenerate reference
 *   npm run validate                                        # compare
 *
 * Expect small non-zero differences in the topocentric numbers: satellite.js
 * rotates TEME -> ECEF by GMST alone, while Skyfield applies the full TEME -> ITRF
 * transform including polar motion. That is a real difference of a few hundredths
 * of a degree, not a bug. The ECI vectors should agree to metres.
 */

import { readFileSync } from 'node:fs';
import {
  twoline2satrec,
  json2satrec,
  propagate,
  gstime,
  eciToEcf,
  eciToGeodetic,
  ecfToLookAngles,
  degreesToRadians,
  radiansToDegrees,
  degreesLat,
  degreesLong,
} from 'satellite.js';
import { decodeCatalog, encodeCatalog } from '../src/catalog-format.ts';

// Tolerances. Tight on the things that must be exact, loose where the two
// implementations legitimately model different physics.
const TOL = {
  eciKm: 0.001, // metre-level: same algorithm, must agree
  rangeKm: 0.5,
  elevationDeg: 0.05,
  azimuthDeg: 0.05,
  latDeg: 0.01,
  lonDeg: 0.01,
  altKm: 0.5,
};

const ref = JSON.parse(readFileSync(new URL('./reference.json', import.meta.url), 'utf8'));

// scripts/fixtures/validation.tle, never public/data/: the published catalogue is
// refreshed every six hours, and reference.json would then be describing a
// different set of elements than the ones loaded here.
const tleText = readFileSync(new URL('./fixtures/validation.tle', import.meta.url), 'utf8');
const tleLines = tleText.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
const fixture = [];
for (let i = 0; i < tleLines.length; i += 3) {
  fixture.push({ name: tleLines[i].trim(), l1: tleLines[i + 1], l2: tleLines[i + 2] });
}

/**
 * The same elements as the OMM record CelesTrak publishes. Column by column this
 * mirrors twoline2satrec's own parsing, so both roads start from identical numbers
 * and the fixture itself stays the frozen TLE text reference.json was built from.
 */
function tleToOmm(name, l1, l2) {
  const year = 2000 + Number(l1.slice(18, 20)); // fixture epochs are all 20xx
  const epochMs = Date.UTC(year, 0, 1) + (Number(l1.slice(20, 32)) - 1) * 86_400_000;
  // TLE's implied-decimal exponent notation: " 16538-3" is 0.16538e-3.
  const exp = (s) => Number(`${s[0]}.${s.slice(1, 6)}e${s.slice(6, 8)}`);
  return {
    OBJECT_NAME: name,
    OBJECT_ID: '',
    ELEMENT_SET_NO: 0,
    NORAD_CAT_ID: Number(l1.slice(2, 7)),
    EPOCH: new Date(epochMs).toISOString(),
    MEAN_MOTION_DOT: Number(l1.slice(33, 43)),
    MEAN_MOTION_DDOT: exp(l1.slice(44, 52)),
    BSTAR: exp(l1.slice(53, 61)),
    INCLINATION: Number(l2.slice(8, 16)),
    RA_OF_ASC_NODE: Number(l2.slice(17, 25)),
    ECCENTRICITY: Number(`.${l2.slice(26, 33).replace(/\s/g, '0')}`),
    ARG_OF_PERICENTER: Number(l2.slice(34, 42)),
    MEAN_ANOMALY: Number(l2.slice(43, 51)),
    MEAN_MOTION: Number(l2.slice(52, 63)),
  };
}

const omms = fixture.map(({ name, l1, l2 }) => tleToOmm(name, l1, l2));
const packed = decodeCatalog(encodeCatalog(omms, new Date(0)));

const ROADS = {
  twoline2satrec: new Map(fixture.map(({ name, l1, l2 }) => [name, twoline2satrec(l1, l2)])),
  json2satrec: new Map(omms.map((o) => [o.OBJECT_NAME, json2satrec(o)])),
  packed: new Map(
    Array.from({ length: packed.count }, (_, i) => [
      packed.names[i],
      json2satrec({ ...packed.elementsAt(i), OBJECT_ID: '', ELEMENT_SET_NO: 0 }),
    ])
  ),
};

const observer = {
  latitude: degreesToRadians(ref.observer.latitudeDeg),
  longitude: degreesToRadians(ref.observer.longitudeDeg),
  height: ref.observer.heightKm,
};

/** Smallest signed difference between two angles in degrees, in (-180, 180]. */
const angleDelta = (a, b) => {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
};

const worst = {};
const failures = [];

const track = (road, key, delta, ctx) => {
  const mag = Math.abs(delta);
  worst[road] ??= {};
  if (!worst[road][key] || mag > worst[road][key].mag) worst[road][key] = { mag, ctx };
  if (mag > TOL[key]) failures.push(`${road}: ${ctx}  ${key}: |Δ| = ${mag.toExponential(3)} > ${TOL[key]}`);
};

// The OMM roads must reach SGP4 with the numbers the TLE road does, before any
// propagation gets a chance to hide a difference.
const SATREC_FIELDS = ['no', 'ecco', 'inclo', 'nodeo', 'argpo', 'mo', 'bstar', 'ndot', 'nddot', 'jdsatepoch'];
for (const road of ['json2satrec', 'packed']) {
  for (const { name } of fixture) {
    const got = ROADS[road].get(name);
    const want = ROADS.twoline2satrec.get(name);
    if (!got) {
      failures.push(`${road}: no satrec for ${name}`);
      continue;
    }
    for (const f of SATREC_FIELDS) {
      if (Math.abs(got[f] - want[f]) > 1e-12 * Math.max(1, Math.abs(want[f]))) {
        failures.push(`${road}: ${name} satrec.${f} = ${got[f]}, twoline2satrec gives ${want[f]}`);
      }
    }
  }
}

for (const [road, satrecs] of Object.entries(ROADS)) {
  for (const c of ref.cases) {
    const satrec = satrecs.get(c.name);
    if (!satrec) {
      failures.push(`${road}: no satrec for ${c.name}`);
      continue;
    }

    const [y, mo, d, h, mi, s] = c.utc;
    const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
    const ctx = `${c.name} @ ${date.toISOString()}`;

    const pv = propagate(satrec, date);
    if (!pv || !pv.position) {
      failures.push(`${road}: ${ctx}  propagate() returned no position`);
      continue;
    }

    track(road, 'eciKm', pv.position.x - c.eci.x, ctx);
    track(road, 'eciKm', pv.position.y - c.eci.y, ctx);
    track(road, 'eciKm', pv.position.z - c.eci.z, ctx);

    const gmst = gstime(date);
    const look = ecfToLookAngles(observer, eciToEcf(pv.position, gmst));

    track(road, 'azimuthDeg', angleDelta(radiansToDegrees(look.azimuth), c.azimuthDeg), ctx);
    track(road, 'elevationDeg', radiansToDegrees(look.elevation) - c.elevationDeg, ctx);
    track(road, 'rangeKm', look.rangeSat - c.rangeKm, ctx);

    const gd = eciToGeodetic(pv.position, gmst);
    track(road, 'latDeg', degreesLat(gd.latitude) - c.latDeg, ctx);
    track(road, 'lonDeg', angleDelta(degreesLong(gd.longitude), c.lonDeg), ctx);
    track(road, 'altKm', gd.height - c.altKm, ctx);
  }
}

console.log(`reference: ${ref.generatedBy}`);
console.log(`cases:     ${ref.cases.length} per road, ${Object.keys(ROADS).length} roads\n`);
console.log('worst deviation per quantity');
for (const [road, keys] of Object.entries(worst)) {
  console.log(`  ${road}`);
  for (const [key, { mag, ctx }] of Object.entries(keys)) {
    const ok = mag <= TOL[key];
    console.log(
      `    ${ok ? 'ok  ' : 'FAIL'} ${key.padEnd(13)} ${mag.toExponential(3).padStart(11)}` +
        `  (tol ${TOL[key]})   ${ctx}`
    );
  }
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log('\nall quantities within tolerance, on every road');

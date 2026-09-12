/**
 * Validate the browser-side propagation chain against an independent implementation.
 *
 * Compares satellite.js (what ships to the browser) against sgp4 + skyfield
 * (Python, Vallado's C++ reference) for the same TLEs and the same instants.
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

const tleText = readFileSync(new URL('../public/data/stations.tle', import.meta.url), 'utf8');
const tleLines = tleText.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
const satrecs = new Map();
for (let i = 0; i < tleLines.length; i += 3) {
  satrecs.set(tleLines[i].trim(), twoline2satrec(tleLines[i + 1], tleLines[i + 2]));
}

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

const track = (key, delta, ctx) => {
  const mag = Math.abs(delta);
  if (!worst[key] || mag > worst[key].mag) worst[key] = { mag, ctx };
  if (mag > TOL[key]) failures.push(`${ctx}  ${key}: |Δ| = ${mag.toExponential(3)} > ${TOL[key]}`);
};

for (const c of ref.cases) {
  const satrec = satrecs.get(c.name);
  if (!satrec) {
    failures.push(`no satrec for ${c.name}`);
    continue;
  }

  const [y, mo, d, h, mi, s] = c.utc;
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  const ctx = `${c.name} @ ${date.toISOString()}`;

  const pv = propagate(satrec, date);
  if (!pv || !pv.position) {
    failures.push(`${ctx}  propagate() returned no position`);
    continue;
  }

  track('eciKm', pv.position.x - c.eci.x, ctx);
  track('eciKm', pv.position.y - c.eci.y, ctx);
  track('eciKm', pv.position.z - c.eci.z, ctx);

  const gmst = gstime(date);
  const ecf = eciToEcf(pv.position, gmst);
  const look = ecfToLookAngles(observer, ecf);

  track('azimuthDeg', angleDelta(radiansToDegrees(look.azimuth), c.azimuthDeg), ctx);
  track('elevationDeg', radiansToDegrees(look.elevation) - c.elevationDeg, ctx);
  track('rangeKm', look.rangeSat - c.rangeKm, ctx);

  const gd = eciToGeodetic(pv.position, gmst);
  track('latDeg', degreesLat(gd.latitude) - c.latDeg, ctx);
  track('lonDeg', angleDelta(degreesLong(gd.longitude), c.lonDeg), ctx);
  track('altKm', gd.height - c.altKm, ctx);
}

console.log(`reference: ${ref.generatedBy}`);
console.log(`cases:     ${ref.cases.length}\n`);
console.log('worst deviation per quantity');
for (const [key, { mag, ctx }] of Object.entries(worst)) {
  const ok = mag <= TOL[key];
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'} ${key.padEnd(13)} ${mag.toExponential(3).padStart(11)}` +
      `  (tol ${TOL[key]})   ${ctx}`
  );
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log('\nall quantities within tolerance');

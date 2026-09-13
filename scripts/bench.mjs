#!/usr/bin/env node
/**
 * Does full-catalogue propagation fit in a frame budget?
 *
 * Compares the pure-JS path (what the step-0 spike uses) against satellite.js v7's
 * WASM BulkPropagator, at catalogue scale. This is the measurement that decides
 * whether step 2 needs anything cleverer than a Web Worker.
 *
 *   npm run bench
 *
 * The catalogue is faked by repeating the frozen validation fixture up to 30k entries -
 * SGP4 cost per object barely depends on which object it is, so the timing holds.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  twoline2satrec,
  propagate,
  gstime,
  eciToEcf,
  ecfToLookAngles,
  degreesToRadians,
  geodeticToEcf,
  createSingleThreadRuntime,
  BulkPropagator,
  EciBaseCalculator,
  GmstCalculator,
  EcfPositionCalculator,
  EcfVelocityCalculator,
  LookAnglesCalculator,
  DopplerFactorCalculator,
  SunPositionCalculator,
  ShadowFractionCalculator,
} from 'satellite.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COUNT = Number(process.argv[2] ?? 30000);
const OBSERVER = { latitude: degreesToRadians(52.52), longitude: degreesToRadians(13.405), height: 0.034 };
const WHEN = new Date(Date.UTC(2026, 8, 12, 0, 0, 0));

const lines = readFileSync(resolve(ROOT, 'scripts/fixtures/validation.tle'), 'utf8')
  .split('\n')
  .filter((l) => l.trim() && !l.startsWith('#'));

const seed = [];
for (let i = 0; i < lines.length; i += 3) seed.push(twoline2satrec(lines[i + 1], lines[i + 2]));

const sats = [];
while (sats.length < COUNT) sats.push(...seed);
sats.length = COUNT;

console.log(`catalogue: ${COUNT} objects, observer ${OBSERVER.latitude.toFixed(3)} rad\n`);

// --- pure JS ---------------------------------------------------------------
{
  const t0 = performance.now();
  const gmst = gstime(WHEN);
  let seen = 0;
  for (const s of sats) {
    const pv = propagate(s, WHEN);
    if (pv?.position) {
      ecfToLookAngles(OBSERVER, eciToEcf(pv.position, gmst));
      seen++;
    }
  }
  console.log(`pure JS   eci + lookAngles          ${(performance.now() - t0).toFixed(1).padStart(7)} ms  (${seen} ok)`);
}

// --- WASM, single thread ----------------------------------------------------
{
  const runtime = await createSingleThreadRuntime();
  const propagator = new BulkPropagator({
    runtime,
    calculators: [
      new EciBaseCalculator(),
      new GmstCalculator(),
      new EcfPositionCalculator(),
      new EcfVelocityCalculator(),
      new LookAnglesCalculator(),
      new DopplerFactorCalculator(),
      new SunPositionCalculator(),
      new ShadowFractionCalculator(),
    ],
    satRecsCount: sats.length,
    datesCount: 1,
  });

  const observerEcf = geodeticToEcf(OBSERVER);
  propagator.setSatRecs(sats);
  propagator.setDates([WHEN]);

  const params = { lookAngles: { observer: OBSERVER }, dopplerFactor: { observer: observerEcf } };
  propagator.run(params); // warm up

  const N = 25;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    propagator.setDates([new Date(WHEN.getTime() + i * 60_000)]);
    propagator.run(params);
  }
  const per = (performance.now() - t0) / N;
  console.log(`WASM 1T   + doppler, sun, shadow    ${per.toFixed(1).padStart(7)} ms  per full propagation`);
  console.log(`\nAt 5 Hz that is ${((per * 5) / 10).toFixed(1)}% of one core.`);
  console.log('createMultiThreadRuntime() divides this further, but pthreads needs');
  console.log('SharedArrayBuffer, so the host must send COOP/COEP headers.');

  // In a long-lived app these MUST be disposed or WASM memory leaks. Under Node
  // the emscripten runtime raises ExitStatus on teardown, which is harmless here.
  try {
    propagator.dispose();
    runtime.dispose();
  } catch {
    /* emscripten exit(0) */
  }
}

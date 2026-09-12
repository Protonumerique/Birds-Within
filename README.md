# Birds Within

The tracked satellite catalogue, overhead, in realtime — from where you stand.

An abstract sky dome rather than a map: no Earth, no globe, just the hemisphere above
one observer and the objects crossing it. Sunlit objects are drawn as what you could
actually see with the naked eye; eclipsed ones as what is there but invisible.

A revival of a project first built in Java around 2010. The premise is what changed in
between: roughly a thousand active satellites then, well over ten thousand now plus
tens of thousands of tracked debris fragments.

## Running it

```bash
npm install
npm run fetch:tle   # optional but recommended — see below
npm run dev
```

The repo ships with **placeholder** element sets so it runs offline out of the box:
`synthetic-leo.tle` (~1450 generated orbits across plausible LEO shells, loaded by
default so the dome has realistic density) and `stations.tle` (five station-like objects
with approximate real elements). Neither is real — `npm run fetch:tle` replaces them
with live CelesTrak data.

Drag to look around, scroll to zoom, click a row to draw that object's track.

## How the data works

CelesTrak is fetched **only** by `scripts/fetch-tle.mjs` — never by the browser. Their
GP data refreshes every two hours and their terms are enforced with 403s and IP blocks,
so a public page fetching directly would put every visitor's request on this project's
account. A GitHub Action refreshes the snapshot every six hours and commits it; the
browser reads a static file. TLE accuracy degrades over days, so this is generous.

## Verifying it

The coordinate and time handling is validated against an independent implementation —
Brandon Rhodes' `sgp4` (Vallado's C++ reference) plus Skyfield:

```bash
pip install sgp4 skyfield
python3 scripts/reference.py > scripts/reference.json
npm run validate
```

ECI positions agree to about 10 cm; alt/az to a few thousandths of a degree.

## Scale

```bash
npm run bench
```

satellite.js v7's WASM `BulkPropagator` handles all 30k catalogued objects — with
Doppler, sun position and shadow fraction — in roughly 15 ms single-threaded, about
4× faster than the pure-JS path.

## Layout

```
src/
  config.ts    observer, dome, trail and clock settings
  tle.ts       3LE parsing
  sky.ts       propagation to observer-relative state
  scene.ts     three.js — dome, points, trails, look controls
  clock.ts     scene time (the single authority)
  ui.ts        overlay
  main.ts      wiring and the frame loop
scripts/
  fetch-tle.mjs   CelesTrak client
  reference.py    independent reference (Python)
  validate.mjs    cross-implementation check
  bench.mjs       JS vs WASM at catalogue scale
```

See `CLAUDE.md` for the architecture decisions and the roadmap.

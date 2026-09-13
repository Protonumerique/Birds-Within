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

The dome loads `synthetic-leo.tle` by default — ~1450 **generated** orbits across
plausible LEO shells, so it runs offline out of the box with something like the density
the piece is about. Nothing in it is a real object. `stations.tle` alongside it *is* real
CelesTrak data, refreshed by the scheduled Action. `npm run fetch:tle` pulls live data
yourself; see `public/data/SOURCES.md` for where it all comes from.

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
npm run validate                                        # compare — Node only
```

ECI positions agree to about 10 cm; alt/az to a few thousandths of a degree.

Both sides propagate `scripts/fixtures/validation.tle`, which is frozen on purpose and
must never be refreshed: the checked-in `scripts/reference.json` was computed from those
exact elements, so replacing them turns the check into a comparison of two different
things. Regenerating the reference is the only step that needs Python:

```bash
pip install sgp4 skyfield
python3 scripts/reference.py > scripts/reference.json
```

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
  fetch-tle.mjs   CelesTrak client — the only thing that talks to them
  reference.py    independent reference (Python)
  validate.mjs    cross-implementation check
  bench.mjs       JS vs WASM at catalogue scale
  fixtures/       frozen elements for the check — not live data, never refreshed
public/data/      the shipped snapshot; see SOURCES.md
```

See `CLAUDE.md` for the architecture decisions and the roadmap.

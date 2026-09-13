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
npm run fetch:catalog   # the real sky - see below
npm run dev
```

Without the fetch, the dev server shows `synthetic.bin` — ~1,450 **invented** orbits,
committed so the project runs offline — and says so on screen. `npm run fetch:catalog`
pulls the real catalogue from CelesTrak and packs it into `public/data/active.bin`
(16,563 active payloads) and `full.bin` (20,933: everything CelesTrak publishes, debris
included). Add `?catalog=full` to the URL for the larger set.

Drag to look around, scroll to zoom, click a row to draw that object's track.

## How the data works

CelesTrak is contacted **only** by `scripts/fetch-catalog.mjs` — never by the browser.
Their GP data refreshes every two hours and their terms are enforced with 403s and IP
blocks, so a public page fetching directly would put every visitor's request on this
project's account. The deploy workflow fetches every six hours, packs the elements into a
compact binary, checks it, and publishes it with the site. Nothing is committed; the raw
data rides between runs in the Actions cache.

Element sets arrive as OMM JSON rather than TLE: since July 2026 new objects carry catalog
numbers the TLE format cannot represent. The binary format is documented at the top of
`src/catalog-format.ts`.

CelesTrak publishes about 21k of the ~35k objects on orbit — every payload, but only a
fraction of the debris. `public/data/SOURCES.md` has the detail.

## Verifying it

The coordinate and time handling is validated against an independent implementation —
Brandon Rhodes' `sgp4` (Vallado's C++ reference) plus Skyfield — along every road a satrec
takes here: from TLE text, from OMM, and from OMM through the packed binary.

```bash
npm run validate        # Node only
npm run check:catalog   # the fetched catalogues decode exactly, and look sane
```

ECI positions agree to about 10 cm; alt/az to a few thousandths of a degree.

Both sides of `validate` propagate `scripts/fixtures/validation.tle`, which is frozen on
purpose and must never be refreshed: the checked-in `scripts/reference.json` was computed
from those exact elements, so replacing them turns the check into a comparison of two
different things. Regenerating the reference is the only step that needs Python:

```bash
pip install sgp4 skyfield
python3 scripts/reference.py > scripts/reference.json
```

## Scale

```bash
npm run bench
```

satellite.js v7's WASM `BulkPropagator` handles 30k objects — with Doppler, sun position
and shadow fraction — in roughly 15–20 ms single-threaded, two to four times faster than
the pure-JS path.

## Layout

```
src/
  config.ts            observer, dataset, dome, trail and clock settings
  catalog-format.ts    the packed catalogue binary - shared with the scripts
  catalog.ts           loading it into satrecs
  sky.ts               propagation to observer-relative state
  scene.ts             three.js — dome, points, trails, look controls
  clock.ts             scene time (the single authority)
  ui.ts                overlay
  main.ts              wiring and the frame loop
scripts/
  catalog-sources.mjs  which CelesTrak datasets, and why
  fetch-catalog.mjs    CelesTrak client — the only thing that talks to them
  pack-catalog.mjs     raw JSON -> public/data/*.bin
  check-catalog.mjs    pre-deploy gate: sanity + exact round trip
  make-synthetic.mjs   the invented offline fallback
  reference.py         independent reference (Python)
  validate.mjs         cross-implementation check
  bench.mjs            JS vs WASM at catalogue scale
  fixtures/            frozen elements for the check — never refreshed
public/data/           synthetic.bin (committed), active/full.bin (built), SOURCES.md
```

See `CLAUDE.md` for the architecture decisions and the roadmap.

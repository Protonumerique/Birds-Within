# Birds Within — context for Claude Code

Read this first. It carries the decisions across sessions and machines.

## What this is

A revival of a project Luis built around 2010 in Java: satellites overhead, visualised
and sonified from their trajectories. This is the contemporary version — a browser
piece, realtime, on a standalone subdomain.

The premise is the change in the sky itself. In 2010 there were roughly a thousand
active satellites. Today it is well over ten thousand, dominated by megaconstellations,
plus tens of thousands of tracked debris fragments. Same code, today's catalogue,
categorically different image. **That density is the piece**, so decisions that make
the density legible beat decisions that make individual objects identifiable.

It is an artwork, not a tracker. stuff-in-orbit, satellitemap and KeepTrack already
exist and are excellent. Do not drift toward feature parity with them — no search, no
object info panels, no orbital element readouts beyond what serves the image.

## Locked-in direction

| | |
|---|---|
| **Framing** | Observer looking up, rendered abstractly. **No Earth geometry, no globe, no map.** The scene is a hemisphere in horizontal (alt/az) coordinates, camera at the observer. |
| **Scope** | **Everything CelesTrak publishes: ~21k objects** — every payload, and ~3k of the ~15k debris on orbit. The full ~35k catalogue exists only on Space-Track, which a public page cannot redistribute. See *The catalogue* below. |
| **Sound** | Phase 2. The data model already emits what it needs. |
| **Hosting** | Standalone subdomain, own repo. |
| **Stack** | Vite + TypeScript + three.js + satellite.js v7. No framework. |

## Architecture

### Data flow

```
CelesTrak GP API ──(deploy.yml, every 6h: fetch → pack → check → build)──> Pages: data/*.bin ──> browser
                          │
                  Actions cache: .catalog-cache/ (raw OMM JSON, between runs)
```

**The browser must never fetch CelesTrak directly.** Two reasons, the second decisive:
they send no CORS headers, and their terms are enforced — one download per dataset per
2-hour cycle, HTTP 403 then IP firewall blocks on abuse, restrictions past 100 MB/day.
A public page fetching directly puts every visitor's request on our account.
`scripts/fetch-catalog.mjs` is the only thing that talks to them, and it will not
request a dataset fetched under 2 hours ago.

Element accuracy degrades over *days*, so a 6-hourly snapshot is generous. Do not add
polling, "live" refresh, or a client-side cache-busting scheme.

### The catalogue

**OMM, not TLE.** CelesTrak ran out of 5-digit catalog numbers on 2026-07-11. Everything
catalogued since has a 6-digit number and **no TLE at all** — a TLE pipeline silently
misses every new launch. The pipeline fetches `FORMAT=json` (OMM) and the browser builds
satrecs with `json2satrec`; there is no TLE text anywhere at runtime. `json2satrec` parses
`EPOCH` with `new Date()`, i.e. to the millisecond, so storing epochs as float64 ms loses
nothing it would use.

**Packed.** `src/catalog-format.ts` is a columnar little-endian binary: a column per
field, angles ×1e4 and eccentricity / mean motion ×1e8 as int32, the drag terms as
float64, names in a UTF-8 blob, plus a `kind` byte (debris / rocket body / other) read
from the name — a heuristic, but enough to read density composition. The encoder checks
that every scaled value round-trips **bit-exactly** and falls back to float64 per field if
one does not, recording the choice in the header. Columnar beats row layout because whole
constellation shells share values; measured on `active`: JSON 1,030 KB gzipped, row
float64 895 KB, columnar float64 814 KB, columnar scaled 661 KB.

The same file runs in the browser and, through Node's type stripping, in the scripts. Keep
it **import-free and erasable-syntax-only** (no enums, no parameter properties) or the
pipeline breaks. GitHub Pages gzips `application/octet-stream`, so there is no hand-rolled
compression — verify that on the live site if the hosting ever changes.

| dataset | objects (2026-09-13) | size | what |
|---|---|---|---|
| `active` | 16,563 | 661 KB gzipped | every payload CelesTrak lists as active — the default |
| `full` | 20,933 | 831 KB gzipped | union of every CelesTrak GP dataset, newest elements win |
| `synthetic` | 1,452 | 110 KB | **invented** orbits, committed, development fallback only |

`?catalog=full` switches without a rebuild: which image the piece wants is an aesthetic
question, answered by looking. The **dev server** falls back to `synthetic` when the real
catalogue has not been fetched, and the HUD labels it. **Production never falls back** —
a missing catalogue is an error, because the piece is about what is actually up there.

**CelesTrak has no full-catalogue query.** `SPECIAL=GPZ` is the GEO Protected Zone, not
"everything". SATCAT counted 35,093 objects on orbit on 2026-09-13; every CelesTrak GP
dataset together is 20,933 of them — every payload, but ~3k of ~15k debris, nearly all
from the Fengyun-1C, Cosmos 2251 and Iridium 33 breakups. General debris and most rocket
bodies are not published as GP data. `scripts/catalog-sources.mjs` holds the list.

### Propagation

satellite.js v7 does SGP4/SDP4 and, importantly, ships a **WASM `BulkPropagator`** with
SIMD and optional pthreads. Measured on this catalogue size (`npm run bench`):

| path | 30k objects |
|---|---|
| pure JS, eci + lookAngles | ~41–59 ms |
| WASM single-thread, 8 calculators | ~15–21 ms |

At 5 Hz that is 7–10% of one core, for the full catalogue *including* Doppler, sun
position and shadow fraction. **No custom WGSL/WebGPU port is needed.** If more headroom
is ever required, `createMultiThreadRuntime({threadsCount})` divides it further — but
pthreads needs `SharedArrayBuffer`, which needs cross-origin isolation, which means the
host must send `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. **GitHub Pages cannot send headers.**
Netlify and Cloudflare Pages can. Single-thread is fast enough; treat multi-thread as a
hosting-constrained option, not a default.

The calculators worth knowing about:

- `LookAnglesCalculator` — az/el/range for an observer, exactly our model
- `DopplerFactorCalculator` — needs the observer as an **ECF vector**, not geodetic
- `SunPositionCalculator` + `ShadowFractionCalculator` — 0 = sunlit, 1 = umbra.
  **This is naked-eye visibility**, and is doing real artistic work: which of these
  thousands of objects you could actually see.

`BulkPropagator` allocates WASM memory. Dispose it or it leaks — `using`, or an explicit
`.dispose()` on teardown.

Until step 2 moves propagation off the main thread, `src/sky.ts` differences range only
for objects **above the horizon**; `SkyState.rangeRate` is NaN below it. Differencing is a
second propagation per object, and nothing reads range rate for objects that are not up —
not the readout, and not the future sonification. Measured on `active`: 54 ms per tick
differencing everything, 24 ms like this.

### Rendering

three.js. `Points` with a custom shader for bodies, `BufferGeometry` for trails.
`src/scene.ts` owns all of it. Alt/az maps to scene space with +Y up, +X East, −Z North,
so the camera's default forward looks North.

Keep the render loop decoupled from propagation: propagate at `CLOCK.propagationHz`,
render at 60 fps, interpolate between. **Interpolating azimuth needs wrap-around care**
— lerping across 359°→1° sends the object the long way round the sky.

### Time

`src/clock.ts` is the single authority for scene time. Everything — propagation, trails,
sun position — reads from it. Mixing in a bare `new Date()` anywhere else is how a
scrubbed timeline silently desynchronises from what is drawn.

## Deployment

Pages **Source must be "GitHub Actions"**, not "Deploy from a branch". Serving from a
branch publishes the repo as-is, so `index.html` asks the browser for `/src/main.ts` —
a TypeScript file no browser can execute. The symptom is a blank page that works
perfectly in `npm run dev`. `.github/workflows/deploy.yml` builds and publishes `dist/`.

`base` in `vite.config.ts` is `'./'` — relative, so one build works both at a domain root
and under `/birds-within/`. With `base: '/'` the built page requests `/assets/…`, which
404s on a project page: the same blank screen. **Do not change it back to `'/'`.**

### The catalogue is built at deploy time, never committed

`deploy.yml` runs on push, on demand, and every 6 hours. Each run restores the newest raw
JSON from the Actions cache, runs `fetch-catalog.mjs`, **saves the cache immediately**,
then packs, runs `check-catalog.mjs` and `validate`, and builds. Packed snapshots delta
poorly; committed four times a day they would add on the order of 1–2 GB of history a
year that every clone downloads. `active.bin`, `full.bin` and `.catalog-cache/` are
gitignored.

- `check-catalog.mjs` is the gate: minimum counts, element age under 7 days, SGP4 init
  error rate, and an **exact round trip of every object** against the raw JSON. A failure
  leaves the previous deployment live. A stale sky beats a wrong one.
- `cancel-in-progress` is false: a cancelled run can discard a download CelesTrak will not
  serve again for two hours.
- **GitHub disables scheduled workflows in public repos after 60 days without repository
  activity.** The old TLE workflow committed data, which reset that timer as a side effect;
  nothing does now. The last step of each scheduled run re-enables the workflow through
  the API. That is common practice but **unproven here until day 60** — if the published
  elements ever go stale, check the Actions tab before anything else.

### The subdomain

The site lives at **birds.protonumerique.net**, a DNS `CNAME` to
`protonumerique.github.io`, served over HTTPS with **Enforce HTTPS** on, so both
`http://` and `protonumerique.github.io/birds-within/` 301 to the canonical origin.

With Pages built by Actions the custom domain lives in **repo Settings**, and the
artifact's `CNAME` file is not strictly required. Keep `public/CNAME` populated anyway
so the repo and Settings cannot disagree — `dist/CNAME` falls out of Vite copying
`public/`. The one state to avoid is the **zero-byte** file this repo carried for a
while: neither absent (Settings wins) nor present (they agree), and invisible in a diff.

**If HTTPS is broken, the fix is almost certainly Settings, not DNS or that file.** The
certificate went unissued here for days. Everything people normally suspect was checked
and was fine: the `CNAME` record pointed at `protonumerique.github.io`; CAA resolved
through it to GitHub's own set, which permits `letsencrypt.org`; the
`_github-pages-challenge-Protonumerique` TXT was present; and no other repo claimed the
domain. Populating `public/CNAME` and redeploying changed nothing, because a deploy does
not retrigger certificate issuance.

What worked: **Settings → Pages → Custom domain → Remove, wait a minute, re-enter it,
Save.** That refiles the DNS check and the certificate request, and the Let's Encrypt
cert appeared within the hour. There is no other retry control. Two cautions learned the
hard way — a 500 on that settings page means the backend is mid-reconcile, so wait rather
than clicking again; and after ticking **Enforce HTTPS** the redirect takes a few minutes
to reach GitHub's edge, so an immediate `curl` showing plain `http://` is not a failure.

DNS is at manitu (`dns01/dns02.manitu.net`). The zone's default TTL is **86400**, from
the SOA, which is what a blank TTL field inherits; the `birds` record now sets **300**
explicitly. That matters only when a record *changes* — a long TTL means every correction
takes up to a day to become visible, which is what made this painful to iterate on.
Nothing is wrong with a cached 86400 answer while the record is correct.

## Correctness

The coordinate and time chain is the easiest thing to get subtly and invisibly wrong.
It is validated against an independent implementation, and that validation is
repeatable:

```bash
python3 scripts/reference.py > scripts/reference.json   # sgp4 (Vallado C++) + skyfield
npm run validate                                        # satellite.js vs that
```

`validate` checks **three roads to a satrec**: `twoline2satrec` on the frozen TLE text;
`json2satrec` on the same elements as an OMM record, which is what the browser uses; and
that record through `catalog-format.ts` encode → decode first, which is what the browser
actually receives. Before propagating, it also requires the OMM roads to reach SGP4 with
the same satrec fields as the TLE road. All three currently agree with the reference
identically, 25 cases across 5 objects and 5 instants:

| quantity | worst deviation |
|---|---|
| ECI position | 9.8e-5 km (≈10 cm) |
| azimuth | 1.5e-3 ° |
| elevation | 4.9e-4 ° |
| range | 2.7e-2 km |
| sub-satellite lat/lon | < 4.1e-4 ° |

Small non-zero topocentric differences are expected and correct: satellite.js rotates
TEME → ECEF by GMST alone, Skyfield applies the full TEME → ITRF transform including
polar motion. **Re-run `npm run validate` after touching anything in `src/sky.ts` or
`src/catalog-format.ts`.** CI runs it on every deploy.

Both sides read **`scripts/fixtures/validation.tle`**, a frozen file, and never the
published catalogue. This is not tidiness. The check originally read the TLE snapshot a
cron job rewrote every six hours. The first time it did, `reference.json` began comparing
the same objects propagated from *different element sets*, and `npm run validate` reported
~11,000 km of ECI "deviation" that was not a bug in anything. A validation fixture a cron
job can edit is not a fixture. If you ever change that file, regenerate `reference.json`
in the same commit. It stays TLE text on purpose: the OMM roads are derived from it inside
`validate.mjs`, so one frozen source covers all three.

Regenerating needs `pip install sgp4 skyfield`. Comparing does not — `npm run validate`
is pure Node, so the check runs anywhere even when Python is unavailable.

One trap already handled: `eciToEcf` is a pure rotation and does **not** subtract the
frame's angular velocity, so dotting that "ECF velocity" against the line of sight gives
a range rate wrong by the observer's own motion — hundreds of m/s at this latitude, a
large fraction of the Doppler signal. `src/sky.ts` differences the range over 1 s instead.
If you switch to `DopplerFactorCalculator`, verify it against the differenced value first.

## Roadmap

- [x] **Step 0 — spike.** Vendored snapshot, JS propagation decoupled from the render
      loop at `CLOCK.propagationHz`, abstract dome, one trail, clock with scrub,
      sunlit/eclipsed distinction. Validated against Python.
- [x] **Step 1 — data pipeline.** CelesTrak OMM JSON, fetched at deploy time, packed into
      a columnar binary, gated by an exact round-trip check, never committed. `active`
      and `full` behind `?catalog=`, committed `synthetic` as the offline fallback.
      `json2satrec` and the packed format both validated against Python. ← *you are here*
- [ ] **Step 2 — scale.** `BulkPropagator` in a Web Worker, horizon cull (only ~6–9% of
      the catalogue is above the horizon at once), interpolation between propagation
      ticks. The main thread currently spends **24–33 ms per tick** propagating
      `active` / `full` in pure JS — a visible hitch five times a second. Loading is not
      the problem: decode plus `json2satrec` for all of `full` is under 250 ms.
- [ ] **Step 3 — aesthetics.** The actual work. Visual grammar, shader design, what a
      satellite *is* on screen, how trails read, how density reads. The `kind` byte is
      there for this.
- [ ] **Step 4 — sound.** Web Audio over the range-rate and pass events the model already
      produces. Pitch ← range rate, amplitude ← elevation, pan ← azimuth, events on
      AOS/LOS. A global view sonifies into mush; one observer's sky does not.

## Conventions

- Observer location lives in `src/config.ts` and **must** match `OBS_*` in
  `scripts/reference.py`, or the validation compares different things.
- Angles are radians internally; degrees only at the UI boundary.
- Distances in kilometres throughout.
- `public/data/active.bin` and `full.bin` are **built, never committed**. Locally
  `npm run fetch:catalog` makes them. It will not re-request anything fetched in the last
  2 hours, so running it repeatedly is safe — do not work around that.
- `public/data/synthetic.bin` **is** committed. `npm run make:synthetic` regenerates it:
  deterministic, drag-free so it never decays, and **not real objects**. It exists so a
  fresh clone runs offline; nothing may be concluded from it.
- The readout lists only the highest `HUD_ROWS` objects above the horizon, refreshed at
  4 Hz. At catalogue scale there is no listing the whole thing, and rebuilding rows every
  frame is wasted DOM work.

## Licence

Code is **AGPL-3.0-or-later** (AGPL, not GPL: this is a web app, and plain GPL's
obligations do not trigger on hosting). The `LICENSE` file is added through GitHub's
license-template picker so the text is canonical.

The element sets the site publishes are not covered by it — their origin and CelesTrak's
terms are documented in `public/data/SOURCES.md`. Keep the fetch-and-cache arrangement
intact in any fork; pointing browsers straight at CelesTrak earns 403s and an IP block.

## Commands

```bash
npm install
npm run dev              # localhost:5173 - the synthetic sky until you fetch
npm run fetch:catalog    # CelesTrak -> .catalog-cache/ -> public/data/{active,full}.bin
npm run check:catalog    # sanity + exact round trip of the packed catalogues
npm run validate         # three roads to a satrec, against the Python reference
npm run bench            # WASM vs JS at catalogue scale
npm run build            # typecheck + production build
npm run make:synthetic   # regenerate the committed offline fallback
```

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
| **Scope** | The full tracked catalogue, ~30k objects including debris. |
| **Sound** | Phase 2. The data model already emits what it needs. |
| **Hosting** | Standalone subdomain, own repo. |
| **Stack** | Vite + TypeScript + three.js + satellite.js v7. No framework. |

## Architecture

### Data flow

```
CelesTrak GP API  ──(GitHub Action, every 6h)──>  public/data/*.tle  ──>  browser
```

**The browser must never fetch CelesTrak directly.** Two reasons, the second decisive:
they send no CORS headers, and their terms are enforced — one download per dataset per
2-hour cycle, HTTP 403 then IP firewall blocks on abuse, restrictions past 100 MB/day.
A public page fetching directly puts every visitor's request on our account.
`scripts/fetch-tle.mjs` is the only thing that talks to them.

TLE accuracy degrades over *days*, so a 6-hourly snapshot is generous. Do not add
polling, "live" refresh, or a client-side cache-busting scheme.

### Propagation

satellite.js v7 does SGP4/SDP4 and, importantly, ships a **WASM `BulkPropagator`** with
SIMD and optional pthreads. Measured on this catalogue size (`npm run bench`):

| path | 30k objects |
|---|---|
| pure JS, eci + lookAngles | ~59 ms |
| WASM single-thread, 8 calculators | ~15 ms |

At 5 Hz that is about 7% of one core, for the full catalogue *including* Doppler, sun
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

## Correctness

The coordinate and time chain is the easiest thing to get subtly and invisibly wrong.
It is validated against an independent implementation, and that validation is
repeatable:

```bash
python3 scripts/reference.py > scripts/reference.json   # sgp4 (Vallado C++) + skyfield
npm run validate                                        # satellite.js vs that
```

Current agreement, 25 cases across 5 objects and 5 instants:

| quantity | worst deviation |
|---|---|
| ECI position | 9.8e-5 km (≈10 cm) |
| azimuth | 1.5e-3 ° |
| elevation | 4.9e-4 ° |
| range | 2.7e-2 km |
| sub-satellite lat/lon | < 4.1e-4 ° |

Small non-zero topocentric differences are expected and correct: satellite.js rotates
TEME → ECEF by GMST alone, Skyfield applies the full TEME → ITRF transform including
polar motion. **Re-run `npm run validate` after touching anything in `src/sky.ts`.**

One trap already handled: `eciToEcf` is a pure rotation and does **not** subtract the
frame's angular velocity, so dotting that "ECF velocity" against the line of sight gives
a range rate wrong by the observer's own motion — hundreds of m/s at this latitude, a
large fraction of the Doppler signal. `src/sky.ts` differences the range over 1 s instead.
If you switch to `DopplerFactorCalculator`, verify it against the differenced value first.

## Roadmap

- [x] **Step 0 — spike.** Vendored snapshot, JS propagation decoupled from the render
      loop at `CLOCK.propagationHz`, abstract dome, one trail, clock with scrub,
      sunlit/eclipsed distinction. Validated against Python. ← *you are here*
- [ ] **Step 1 — data pipeline.** Packed binary catalogue instead of raw TLE text (~5–6 MB
      of 3LE for 30k objects → ~1–2 MB gzipped). Versioned, with epoch timestamps.
      Enable the `active` fetch in the Action.
- [ ] **Step 2 — scale.** `BulkPropagator` in a Web Worker, full catalogue, horizon cull
      (only ~3–8% of the catalogue is above the horizon at once), interpolation between
      propagation ticks. Loading state for the ~30k `twoline2satrec` inits.
- [ ] **Step 3 — aesthetics.** The actual work. Visual grammar, shader design, what a
      satellite *is* on screen, how trails read, how density reads.
- [ ] **Step 4 — sound.** Web Audio over the range-rate and pass events the model already
      produces. Pitch ← range rate, amplitude ← elevation, pan ← azimuth, events on
      AOS/LOS. A global view sonifies into mush; one observer's sky does not.

## Conventions

- Observer location lives in `src/config.ts` and **must** match `OBS_*` in
  `scripts/reference.py`, or the validation compares different things.
- Angles are radians internally; degrees only at the UI boundary.
- Distances in kilometres throughout.
- Both files in `public/data/` are **placeholders**, generated by
  `scripts/make_placeholder_tle.py` so the spike runs offline:
  `stations.tle` is five station-like objects with approximate real elements;
  `synthetic-leo.tle` is ~1450 **entirely generated** orbits across plausible LEO shells,
  loaded by default so the dome shows realistic density (about 6% above the horizon at
  any instant, matching the real catalogue). Neither is real. `npm run fetch:tle`
  replaces them — do that before drawing any conclusion about where anything actually is.
- The readout lists only the highest `HUD_ROWS` objects above the horizon, refreshed at
  4 Hz. At catalogue scale there is no listing the whole thing, and rebuilding rows every
  frame is wasted DOM work.

## Commands

```bash
npm install
npm run dev         # localhost:5173
npm run fetch:tle   # replace the placeholder snapshot with live CelesTrak data
npm run validate    # cross-check propagation against Python reference
npm run bench       # WASM vs JS at catalogue scale
npm run build       # typecheck + production build
```

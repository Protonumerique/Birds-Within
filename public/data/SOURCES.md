# Where the element sets in this directory come from

The code in this repository is AGPL-3.0-or-later. **The orbital element sets in this
directory are not**, and nothing here relicenses them. This file records where each
one came from and what the source asks of anyone redistributing it.

## The files

| file | origin | real? |
|---|---|---|
| `stations.tle` | CelesTrak GP API, `GROUP=stations` | **yes** — live data |
| `synthetic-leo.tle` | `scripts/make_placeholder_tle.py` | **no** — entirely generated |

`stations.tle` began life as a placeholder, but the scheduled Action has since
replaced it with genuine CelesTrak data. It carries a header line naming the query
and the retrieval time. Do not run `make_placeholder_tle.py` against it again.

`synthetic-leo.tle` is ~1450 **invented** orbits spread across plausible LEO shells,
with valid line checksums so parsers accept them. It exists so the dome shows
something like the density the piece is about while running offline, and because
about 6% of it is above the horizon at any instant — which is what the real
catalogue does. It is not a catalogue of anything. Nothing in it corresponds to a
real object, and no conclusion about where anything actually is may be drawn from
it. `npm run fetch:tle` replaces it with live data.

A third file, `scripts/fixtures/validation.tle`, is deliberately **not** in this
directory. See the header inside it.

## CelesTrak

<https://celestrak.org/> — Dr T.S. Kelso's service, the canonical free source of
general perturbations data, derived from the US Space Force's public catalogue.
Orbital elements produced by a US government body are not themselves copyrightable,
but CelesTrak's *service* is a private one run at someone's expense, and its terms
are enforced technically rather than legally:

- GP data refreshes every **2 hours**. Do not request a dataset more than once per
  cycle.
- Abuse earns **HTTP 403**, then an **IP-level firewall block**. Retrying a 403 or a
  404 does not help and makes a block more likely.
- Further restrictions apply past **100 MB/day**.
- Automated consumers should identify themselves in the `User-Agent` header.

### The arrangement this repo uses, and why a fork must keep it

`scripts/fetch-tle.mjs` is the only thing in this project that talks to CelesTrak.
It runs from `.github/workflows/update-tle.yml` every six hours and commits the
result. **The browser never contacts CelesTrak** — it reads the static file that job
produced.

This is not merely polite. A public page fetching CelesTrak directly puts *every
visitor's* request on this project's account, which is exactly the pattern their
403s and IP blocks exist to stop; and CelesTrak sends no CORS headers, so it would
not work from a browser anyway. Every six hours is far more often than the data
needs — TLE accuracy degrades over days, not minutes.

If you fork this, keep the fetch-and-cache arrangement intact.

## Space-Track

<https://www.space-track.org/> holds a fuller catalogue including debris, but
requires authentication and restricts redistribution, which makes it unsuitable as
the source for a public page. It is noted here only so the choice is on the record.

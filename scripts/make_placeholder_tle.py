"""
Build syntactically valid placeholder TLE files with correct checksums.

Two outputs, both written to public/data/ and both FAKE:

  stations.tle       five station-like objects, approximate real elements
  synthetic-leo.tle  ~1500 objects across plausible LEO shells

They exist only so the spike runs offline and shows something resembling the
density the piece is about. Nothing here is a real orbit. Replace both with live
data before drawing any conclusion about where anything actually is:

    npm run fetch:tle

    python3 scripts/make_placeholder_tle.py
"""

import math
import random

MU = 398600.4418  # km^3/s^2
R_EARTH = 6378.137  # km

# Epoch 2026-09-12 00:00 UTC -> 26255.00000000 (2026 is not a leap year)
EPOCH = "26255.00000000"


def checksum(line: str) -> int:
    total = 0
    for ch in line[:68]:
        if ch.isdigit():
            total += int(ch)
        elif ch == "-":
            total += 1
    return total % 10


def finish(line: str) -> str:
    assert len(line) == 68, f"expected 68 chars before checksum, got {len(line)}: {line!r}"
    return line + str(checksum(line))


def l1(catnr, intldes, epoch, ndot, bstar, elset):
    # cols: 1 | 3-7 catnr | 8 class | 10-17 intldes | 19-32 epoch |
    #       34-43 ndot/2 | 45-52 nddot/6 | 54-61 bstar | 63 ephtype | 65-68 elset
    return finish(
        f"1 {catnr:>5}U {intldes:<8} {epoch:>14} {ndot:>10} {' 00000-0':>8} {bstar:>8} 0 {elset:>4}"
    )


def l2(catnr, inc, raan, ecc, argp, ma, mm, rev):
    # cols: 1 | 3-7 catnr | 9-16 inc | 18-25 raan | 27-33 ecc | 35-42 argp |
    #       44-51 ma | 53-63 mm | 64-68 rev
    inc, raan, ecc, argp, ma, mm = (s.strip() for s in (inc, raan, ecc, argp, ma, mm))
    return finish(
        f"2 {catnr:>5} {inc:>8} {raan:>8} {ecc:>7} {argp:>8} {ma:>8} {mm:>11}{rev:>5}"
    )


def mean_motion(altitude_km: float) -> float:
    """Revolutions per day for a circular orbit at this altitude."""
    a = R_EARTH + altitude_km
    period_s = 2 * math.pi * math.sqrt(a**3 / MU)
    return 86400.0 / period_s


# --------------------------------------------------------------------------
# stations.tle - five station-like objects
# --------------------------------------------------------------------------

STATIONS = [
    # name, catnr, intl des, ndot/2, bstar, inc, raan, ecc, argp, ma, mm, rev
    ("ISS (ZARYA)", 25544, "98067A", " .00016717", " 16538-3",
     "51.6400", "247.4600", "0006703", "130.5360", "325.0288", "15.50377579", 56353),
    ("CSS (TIANHE)", 48274, "21035A", " .00021584", " 24076-3",
     "41.4700", "108.3320", "0004521", "275.8400", "84.2100", "15.61870000", 25610),
    ("PROGRESS-MS 30", 62841, "25009A", " .00023918", " 41864-3",
     "51.6390", "247.3010", "0005890", "128.9100", "231.2400", "15.50410000", 12045),
    ("SOYUZ-MS 28", 63102, "25041A", " .00018204", " 32700-3",
     "51.6410", "247.5220", "0007120", "112.4400", "247.7800", "15.50390000", 4812),
    ("TIANZHOU-9", 61455, "25018A", " .00019772", " 22015-3",
     "41.4680", "108.2010", "0003990", "301.7700", "58.2900", "15.61910000", 7320),
]


def write_stations():
    out = [
        "# PLACEHOLDER - approximate elements, fixed epoch 2026-09-12T00:00:00Z.",
        "# NOT REAL POSITIONS. Replace with:  npm run fetch:tle",
    ]
    for name, catnr, des, ndot, bstar, inc, raan, ecc, argp, ma, mm, rev in STATIONS:
        out.append(name)
        out.append(l1(catnr, des, EPOCH, ndot, bstar, 999))
        out.append(l2(catnr, inc, raan, ecc, argp, ma, mm, rev))

    with open("public/data/stations.tle", "w") as fh:
        fh.write("\n".join(out) + "\n")
    print(f"stations.tle:      {len(STATIONS)} objects")


# --------------------------------------------------------------------------
# synthetic-leo.tle - plausible shells, so the dome is not empty before the
# real catalogue arrives in step 2
# --------------------------------------------------------------------------

# count, altitude km, inclination deg, label
SHELLS = [
    (700, 550, 53.0, "SHELL-A"),   # dense low-inclination shell
    (250, 570, 70.0, "SHELL-B"),
    (200, 1200, 87.9, "SHELL-C"),  # near-polar
    (150, 800, 98.6, "SSO"),       # sun-synchronous
    (200, None, None, "SCATTER"),  # broad spread, debris-like
]


def write_synthetic():
    rng = random.Random(20260912)  # deterministic: the file should be reproducible
    out = [
        "# SYNTHETIC - generated orbits, not a real catalogue and not real objects.",
        "# Present so the dome shows realistic density before the live catalogue",
        "# lands in step 2. Replace with:  npm run fetch:tle --group=active",
    ]

    catnr = 90000
    total = 0

    for count, alt, inc, label in SHELLS:
        # Walker-like: spread planes in RAAN, spread objects within each plane.
        planes = max(1, round(math.sqrt(count)))
        per_plane = max(1, count // planes)

        for p in range(planes):
            for k in range(per_plane):
                catnr += 1
                if catnr > 99999:
                    break

                altitude = alt if alt is not None else rng.uniform(380, 1400)
                inclination = inc if inc is not None else rng.uniform(0, 105)

                raan = (p / planes) * 360.0 + rng.uniform(-1.5, 1.5)
                ma = (k / per_plane) * 360.0 + (p * 11.0) + rng.uniform(-1.5, 1.5)
                mm = mean_motion(altitude) * rng.uniform(0.9995, 1.0005)
                ecc = int(rng.uniform(2, 900))  # 0.0000002 .. 0.00009, near-circular

                out.append(f"{label}-{catnr}")
                out.append(
                    l1(catnr, f"26{catnr % 1000:03d}A", EPOCH, " .00002000", " 15000-3", 999)
                )
                out.append(
                    l2(
                        catnr,
                        f"{inclination % 180:.4f}",
                        f"{raan % 360:.4f}",
                        f"{ecc:07d}",
                        f"{rng.uniform(0, 360):.4f}",
                        f"{ma % 360:.4f}",
                        f"{mm:.8f}",
                        rng.randint(100, 99999),
                    )
                )
                total += 1

    with open("public/data/synthetic-leo.tle", "w") as fh:
        fh.write("\n".join(out) + "\n")
    print(f"synthetic-leo.tle: {total} objects")


if __name__ == "__main__":
    write_stations()
    write_synthetic()

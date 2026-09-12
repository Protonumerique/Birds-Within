"""
Generate an independent reference for the propagation chain.

Uses Brandon Rhodes' `sgp4` (the C++ Vallado reference, via Python) for ECI state
vectors and `skyfield` for topocentric alt/az/range. satellite.js is validated
against this - two separate implementations agreeing is the only cheap way to know
the coordinate and time handling is right.

    pip install sgp4 skyfield
    python3 scripts/reference.py > scripts/reference.json
"""

import json
import sys

from sgp4.api import Satrec, jday
from skyfield.api import EarthSatellite, load, wgs84

TLE_PATH = "public/data/stations.tle"

# Berlin. Must match OBSERVER in src/config.ts.
OBS_LAT_DEG = 52.5200
OBS_LON_DEG = 13.4050
OBS_ALT_KM = 0.034

# Fixed instants spanning a few hours past the TLE epoch.
SAMPLE_TIMES = [
    (2026, 9, 12, 0, 0, 0),
    (2026, 9, 12, 0, 31, 17),
    (2026, 9, 12, 3, 45, 0),
    (2026, 9, 12, 11, 0, 0),
    (2026, 9, 13, 18, 22, 33),
]


def read_tles(path):
    out = []
    lines = [
        ln.rstrip("\n")
        for ln in open(path, encoding="utf-8")
        if ln.strip() and not ln.startswith("#")
    ]
    for i in range(0, len(lines), 3):
        out.append((lines[i].strip(), lines[i + 1], lines[i + 2]))
    return out


def main():
    ts = load.timescale(builtin=True)
    observer = wgs84.latlon(OBS_LAT_DEG, OBS_LON_DEG, elevation_m=OBS_ALT_KM * 1000.0)

    cases = []
    for name, l1, l2 in read_tles(TLE_PATH):
        satrec = Satrec.twoline2rv(l1, l2)
        sf_sat = EarthSatellite(l1, l2, name, ts)

        for y, mo, d, h, mi, s in SAMPLE_TIMES:
            jd, fr = jday(y, mo, d, h, mi, s)
            err, r, v = satrec.sgp4(jd, fr)
            if err != 0:
                print(f"# sgp4 error {err} for {name}", file=sys.stderr)
                continue

            t = ts.utc(y, mo, d, h, mi, s)
            topo = (sf_sat - observer).at(t)
            alt, az, dist = topo.altaz()
            subpoint = wgs84.subpoint(sf_sat.at(t))

            cases.append(
                {
                    "name": name,
                    "utc": [y, mo, d, h, mi, s],
                    # TEME / ECI, km and km/s
                    "eci": {"x": r[0], "y": r[1], "z": r[2]},
                    "vel": {"x": v[0], "y": v[1], "z": v[2]},
                    # Topocentric, degrees and km
                    "azimuthDeg": az.degrees,
                    "elevationDeg": alt.degrees,
                    "rangeKm": dist.km,
                    # Sub-satellite point, degrees and km
                    "latDeg": subpoint.latitude.degrees,
                    "lonDeg": subpoint.longitude.degrees,
                    "altKm": subpoint.elevation.km,
                }
            )

    json.dump(
        {
            "generatedBy": "sgp4 (Vallado C++) + skyfield",
            "observer": {
                "latitudeDeg": OBS_LAT_DEG,
                "longitudeDeg": OBS_LON_DEG,
                "heightKm": OBS_ALT_KM,
            },
            "cases": cases,
        },
        sys.stdout,
        indent=1,
    )
    print()


if __name__ == "__main__":
    main()

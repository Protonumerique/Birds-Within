import {
  propagate,
  gstime,
  jday,
  sunPos,
  shadowFraction,
  eciToEcf,
  ecfToLookAngles,
  degreesToRadians,
  type SatRec,
  type EciVec3,
  type AU,
} from 'satellite.js';

import type { CatalogEntry } from './catalog';
import { OBSERVER } from './config';

/**
 * Everything the rest of the app knows about one object at one instant, expressed
 * from where the observer stands. Deliberately observer-relative and not a
 * position in space: this is the data model the sonification will also consume.
 */
export interface SkyState {
  index: number;
  /** Radians, from North through East. */
  azimuth: number;
  /** Radians above the horizon. Negative means below it. */
  elevation: number;
  /** Kilometres from the observer. */
  range: number;
  /**
   * km/s. Negative = approaching (frequency shifted up). Drives Doppler.
   * NaN below the horizon, where it is deliberately not computed - see `stateOf`.
   */
  rangeRate: number;
  /** 0 = in full sunlight, 1 = in Earth's umbra. Below ~0.5 it is naked-eye visible. */
  shadow: number;
}

export const OBSERVER_GEODETIC = {
  latitude: degreesToRadians(OBSERVER.latitudeDeg),
  longitude: degreesToRadians(OBSERVER.longitudeDeg),
  height: OBSERVER.heightKm,
};

/** Range from the observer to a satellite, in km, or null if SGP4 failed. */
function rangeAt(satrec: SatRec, date: Date, gmst: number): number | null {
  const pv = propagate(satrec, date);
  if (!pv?.position) return null;
  return ecfToLookAngles(OBSERVER_GEODETIC, eciToEcf(pv.position, gmst)).rangeSat;
}

/**
 * Per-instant values that are identical for every object. Computing these once
 * per frame instead of once per satellite is the difference between the sun
 * position being free and it dominating the loop at catalogue scale.
 */
export interface Epoch {
  date: Date;
  gmst: number;
  /** One second later, for differencing the range. */
  laterDate: Date;
  laterGmst: number;
  sunEciAU: EciVec3<AU>;
}

export function epochAt(date: Date): Epoch {
  const laterDate = new Date(date.getTime() + 1000);
  return {
    date,
    gmst: gstime(date),
    laterDate,
    laterGmst: gstime(laterDate),
    sunEciAU: sunPos(jday(date)).rsun,
  };
}

/**
 * Resolve one satellite's state as seen from the observer.
 *
 * Range rate is computed by differencing the range one second apart rather than
 * from the velocity vector. `eciToEcf` is a pure rotation and does not subtract
 * the frame's own angular velocity, so a naive dot product of that "ECF velocity"
 * against the line of sight is wrong by the observer's own motion - which is
 * hundreds of metres per second at this latitude, i.e. a large fraction of the
 * Doppler signal we care about. Differencing sidesteps the whole question.
 *
 * It is not free, though: it is a second propagation per object, which at
 * catalogue scale is most of the tick. And nothing reads range rate below the
 * horizon - the readout lists only what is up, and the sonification will only
 * voice what is up. So it is computed for those alone. Measured on the 16,563-object
 * `active` set: 54 ms per tick differencing everything, 24 ms differencing only the
 * ~6% above the horizon. Step 2's worker and WASM propagator are the real fix.
 */
export function stateOf(entry: CatalogEntry, index: number, epoch: Epoch): SkyState | null {
  const pv = propagate(entry.satrec, epoch.date);
  if (!pv?.position) return null;

  const look = ecfToLookAngles(OBSERVER_GEODETIC, eciToEcf(pv.position, epoch.gmst));

  let rangeRate = Number.NaN;
  if (look.elevation > 0) {
    const later = rangeAt(entry.satrec, epoch.laterDate, epoch.laterGmst);
    rangeRate = later === null ? 0 : later - look.rangeSat;
  }

  return {
    index,
    azimuth: look.azimuth,
    elevation: look.elevation,
    range: look.rangeSat,
    rangeRate,
    shadow: shadowFraction(epoch.sunEciAU, pv.position),
  };
}

export function skyAt(catalog: CatalogEntry[], date: Date): SkyState[] {
  const epoch = epochAt(date);
  const out: SkyState[] = [];
  for (let i = 0; i < catalog.length; i++) {
    const entry = catalog[i];
    if (!entry) continue;
    const state = stateOf(entry, i, epoch);
    if (state) out.push(state);
  }
  return out;
}

/**
 * Sample one satellite's track across the sky, for drawing a trail.
 * Returns alt/az pairs; points far below the horizon are still included so the
 * line can be clipped or faded by the renderer rather than ending abruptly.
 */
export function trackOf(
  entry: CatalogEntry,
  centre: Date,
  pastMinutes: number,
  futureMinutes: number,
  stepSeconds: number
): { azimuth: number; elevation: number }[] {
  const points: { azimuth: number; elevation: number }[] = [];
  const from = -pastMinutes * 60;
  const to = futureMinutes * 60;

  for (let offset = from; offset <= to; offset += stepSeconds) {
    const t = new Date(centre.getTime() + offset * 1000);
    const pv = propagate(entry.satrec, t);
    if (!pv?.position) continue;
    const look = ecfToLookAngles(OBSERVER_GEODETIC, eciToEcf(pv.position, gstime(t)));
    points.push({ azimuth: look.azimuth, elevation: look.elevation });
  }

  return points;
}

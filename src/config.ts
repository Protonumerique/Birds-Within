/** Where the observer stands. Everything in this app is relative to this point. */
export const OBSERVER = {
  name: 'Berlin',
  latitudeDeg: 52.52,
  longitudeDeg: 13.405,
  /** Height above the WGS-84 ellipsoid, in kilometres. */
  heightKm: 0.034,
};

/**
 * The vendored catalogue snapshot.
 *
 * `synthetic-leo.tle` is ~1450 GENERATED orbits across plausible LEO shells - not
 * real objects - so the dome shows something like the density the piece is about
 * before the real catalogue arrives in step 2. Roughly 6% of it is above the
 * horizon at any moment, which matches the real catalogue's behaviour.
 *
 * `stations.tle` is five station-like objects with approximate real elements.
 *
 * Both are placeholders. `npm run fetch:tle` replaces them with live CelesTrak data.
 */
export const TLE_URL = `${import.meta.env.BASE_URL}data/synthetic-leo.tle`;

/** How many objects the readout lists, highest first. */
export const HUD_ROWS = 14;

export const SKY = {
  /** Radius of the dome in scene units. Arbitrary - the sky has no scale. */
  radius: 100,
  /**
   * How far below the horizon to keep drawing, in degrees.
   *
   * -90 draws the whole sphere, so objects on the far side of the Earth stay
   * present but heavily dimmed. With only a handful of objects in the spike this
   * is also what stops the sky being empty between passes.
   */
  showBelowHorizonDeg: -90,
};

export const TRAIL = {
  /** Minutes of past track to draw. */
  pastMinutes: 35,
  /** Minutes of future track to draw. */
  futureMinutes: 35,
  /** Seconds between sampled points along a trail. */
  stepSeconds: 20,
};

export const CLOCK = {
  /** Propagation ticks per second. Rendering stays at 60fps and interpolates. */
  propagationHz: 5,
  /** Time multipliers offered by the scrub control. */
  rates: [1, 10, 60, 300, 1800],
};

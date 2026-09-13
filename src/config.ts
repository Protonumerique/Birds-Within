/** Where the observer stands. Everything in this app is relative to this point. */
export const OBSERVER = {
  name: 'Berlin',
  latitudeDeg: 52.52,
  longitudeDeg: 13.405,
  /** Height above the WGS-84 ellipsoid, in kilometres. */
  heightKm: 0.034,
};

/**
 * Which packed catalogue to load - all src/catalog-format.ts binaries in public/data/.
 *
 * - `active`    every payload CelesTrak lists as active. 16,563 on 2026-09-13.
 * - `full`      the union of every CelesTrak GP dataset. 20,933 on 2026-09-13 - all
 *               the sky CelesTrak publishes: every payload, but only ~3k of the ~15k
 *               debris on orbit. See scripts/catalog-sources.mjs.
 * - `synthetic` ~1450 INVENTED orbits, committed so development works offline. Not
 *               real objects, and the HUD says so whenever it is showing.
 *
 * `active` and `full` are built by `npm run fetch:catalog` locally and by deploy.yml
 * in CI. They are not in git.
 *
 * Which of the two real images the piece wants is an aesthetic question, so it is
 * answerable by looking rather than by rebuilding: `?catalog=full` overrides this.
 */
export type Dataset = 'active' | 'full' | 'synthetic';

const DEFAULT_DATASET: Dataset = 'active';

function datasetFromUrl(): Dataset {
  const requested = new URLSearchParams(location.search).get('catalog');
  return requested === 'active' || requested === 'full' || requested === 'synthetic'
    ? requested
    : DEFAULT_DATASET;
}

export const DATASET: Dataset = datasetFromUrl();

export const catalogUrl = (dataset: Dataset) => `${import.meta.env.BASE_URL}data/${dataset}.bin`;

/** How many objects the readout lists, highest first. */
export const HUD_ROWS = 14;

export const SKY = {
  /** Radius of the dome in scene units. Arbitrary - the sky has no scale. */
  radius: 100,
  /**
   * How far below the horizon to keep drawing, in degrees.
   *
   * -90 draws the whole sphere, so objects on the far side of the Earth stay
   * present but heavily dimmed.
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
  /**
   * Minimum propagation ticks per second. Rendering runs at display rate and the GPU
   * blends between ticks, so at 1x this can be low without anything visibly stepping.
   */
  propagationHz: 5,
  /** Most scene seconds allowed between ticks before the tick rate is raised. */
  maxStepSeconds: 10,
  /** Ceiling on ticks per second. A tick of `full` is ~17 ms in the worker. */
  maxPropagationHz: 20,
  /** Time multipliers offered by the scrub control. */
  rates: [1, 10, 60, 300, 1800],
};

/** `?debug` shows frame timing and worker stats. Hidden otherwise - the piece has no chrome for it. */
export const DEBUG = new URLSearchParams(location.search).has('debug');

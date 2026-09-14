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

/**
 * Whether pointing at an object the readout is NOT listing gives it a row for as
 * long as the pointer stays on it.
 *
 * On, the panel answers "what is that one?" while you sweep the sky, which is the
 * only way a name can ever be attached to a mark - nothing textual is drawn up there.
 * The cost is churn: the row is inserted in elevation order, so the rows under it
 * shift by one every time the pointer crosses something new.
 *
 * Off, hovering only ever recolours a row that is already listed, and an unlisted
 * object has to be clicked before it is named.
 *
 * Which of the two the piece wants is an aesthetic question, so it is answerable by
 * looking rather than by reasoning. Marked objects keep their rows either way.
 */
export const HOVER_KEEPS_ROW = true;

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
  /**
   * Haze rising from the horizon: sky-coloured at the horizon, clear by `topDeg`, so
   * objects come into view gradually as they climb instead of popping over the edge.
   * It dims objects, their rings and trails; the graticule and compass labels stay
   * above it, so the dome's structure reads all the way down.
   */
  haze: {
    topDeg: 20,
    /** 1 = objects at the horizon are fully hidden. */
    horizonOpacity: 1,
  },
};

/**
 * Rings around the objects the readout lists. For now these are also the default
 * voices of the sonification to come.
 *
 * The ring is also the whole of the pointer's response. Hovering an object rings it
 * in `markColor`; clicking makes that ring stick, and a stuck object holds its row in
 * the readout until it sets. Nothing textual is ever drawn on the sky - see CLAUDE.md.
 */
export const HIGHLIGHT = {
  /** Outer diameter, CSS pixels. Fixed on screen, whatever the object's range. */
  diameterPx: 30,
  strokePx: 1.5,
  /** The plain ring worn by whatever the readout happens to be listing. */
  color: '#ffffff',
  /**
   * Hovered and marked objects, in the sky and in the readout alike - one colour is
   * what ties a ring to its row. Amber reads as put there by a person: the sky's own
   * marks are warm white (sunlit) and steel blue (eclipsed), and nothing in it is
   * this saturated.
   */
  markColor: '#ffb454',
  /** The hovered ring grows slightly, so the pointer's reach is legible. */
  hoverScale: 1.2,
  /**
   * A marked object's ring and its row dim together as it descends, so a glance at
   * the sky reads the same ordering the readout is sorted by. This is the brightness
   * at the horizon; it reaches full by `fullBrightDeg`.
   */
  dimAtHorizon: 0.3,
  fullBrightDeg: 55,
  /** How near the pointer has to be, in CSS pixels, to take an object. */
  pickRadiusPx: 18,
  /**
   * A kept object is let go once it sinks below this, and its row goes back to
   * whatever has risen.
   *
   * Not zero. The haze is opaque at the horizon, so anything under a couple of
   * degrees is already gone from the image - holding its row while it creeps the
   * last degree reads as the readout being stuck. It also settles the geostationary
   * case: a satellite parked at +0.4° in the south never sets at all, and would
   * otherwise hold its row for the life of the page.
   */
  releaseBelowDeg: 5,
};

/**
 * The tracks drawn through kept objects - where each has been and where it is going.
 *
 * Drawn as real pixel-width lines (three's `LineSegments2`), not GL hairlines, which
 * ANGLE renders one pixel wide whatever you ask for.
 */
/**
 * The choir: the geosynchronous belt, which from Berlin is a fixed arc across the
 * southern sky, peaking at 30° due south. Those objects never rise and never set.
 *
 * They are drawn like everything else - small, because they are 36,000 km away - but
 * they are not passes, so they are kept out of the readout, given no track even when
 * kept, and ringed in blue rather than amber and smaller. A different kind of thing,
 * marked as one. Which objects qualify is decided in catalog-format.ts, from the
 * elements; this is only how they look.
 */
export const CHOIR = {
  /** Ring diameter, CSS pixels. Smaller than HIGHLIGHT.diameterPx on purpose. */
  diameterPx: 17,
  strokePx: 1.2,
  /** Cool against the passing objects' amber, and cooler than the eclipsed blue. */
  color: '#8ad4ff',
  /**
   * How many kept choir objects the panel names. A placeholder: where the choir's
   * data belongs is a dashboard question, not yet answered.
   */
  rows: 6,
};

export const TRAIL = {
  /** Minutes of past track to draw. */
  pastMinutes: 35,
  /** Minutes of future track to draw. */
  futureMinutes: 35,
  /** Seconds between sampled points along a trail. */
  stepSeconds: 20,
  /** Line width in CSS pixels. */
  widthPx: 2,
  /** Opacity of a track at full brightness. */
  opacity: 0.5,
  /**
   * A track dissolves from this elevation down and is cut exactly at the horizon,
   * so an orbit leaves the image rather than diving through the ground. Keep it near
   * the haze's own scale - below a couple of degrees nothing is visible anyway.
   */
  fadeTopDeg: 7,
  /** Track colour for an object that is drawn but not kept. Kept ones use HIGHLIGHT.markColor. */
  color: '#7fa6bf',
  /**
   * A track through every kept object, not only the most recent one. Several at once
   * is the point of keeping several - and also the thing most likely to turn the sky
   * into wool, so it is one line to turn off.
   */
  allMarked: true,
  /**
   * Scene seconds a track may drift before it is recomputed. A track spans 70 minutes,
   * so a minute of drift is invisible; at high time rates this is what stops the
   * worker being asked for tracks faster than it can answer frames.
   */
  refreshSeconds: 60,
  /** Track requests allowed out at once, across all kept objects. */
  maxInflight: 2,
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

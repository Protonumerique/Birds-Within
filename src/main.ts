import './style.css';

import { DATASET, DEBUG, OBSERVER, TRAIL, catalogUrl, type Dataset } from './config';
import { fetchCatalog, type FetchedCatalog } from './catalog';
import { geodeticObserver } from './sky-frame';
import { SkyStream } from './sky-stream';
import { SkyScene } from './scene';
import { Clock } from './clock';
import { createHud } from './ui';
import { createDebugPanel } from './debug';

/**
 * Fetch the configured catalogue.
 *
 * In development only, fall back to the committed synthetic set when the real one
 * has not been fetched, so `npm run dev` works offline and on a fresh clone. The
 * published page never substitutes invented orbits for real ones: the piece is
 * about what is actually up there, so a missing catalogue is an error, not a swap.
 */
async function load(): Promise<{ catalog: FetchedCatalog; dataset: Dataset }> {
  try {
    return { catalog: await fetchCatalog(catalogUrl(DATASET)), dataset: DATASET };
  } catch (err) {
    if (!import.meta.env.DEV || DATASET === 'synthetic') throw err;
    console.warn(
      `[catalog] ${String(err)}\n` +
        'Falling back to SYNTHETIC data. Run `npm run fetch:catalog` for the real sky.'
    );
    return { catalog: await fetchCatalog(catalogUrl('synthetic')), dataset: 'synthetic' };
  }
}

async function main() {
  const canvas = document.querySelector<HTMLCanvasElement>('#sky')!;
  const hudRoot = document.querySelector<HTMLElement>('#hud')!;
  const status = (text: string) => {
    hudRoot.innerHTML = `<div class="panel"><h1>Birds Within</h1><div class="sub">${text}</div></div>`;
  };

  status('loading the catalogue…');
  const { catalog, dataset } = await load();

  // The satrec builds and WASM allocation take the better part of a second for
  // `full` - in the worker, so the page stays responsive while this shows.
  status(`building ${catalog.header.count.toLocaleString('en')} orbits…`);
  const stream = await SkyStream.start(catalog.bytes, geodeticObserver(OBSERVER));
  if (stream.count === 0) throw new Error('catalogue is empty');
  if (stream.dropped) console.info(`[catalog] ${stream.dropped} element sets rejected by SGP4 at init`);
  if (DEBUG) console.info(`[sky worker] ready in ${stream.initMs.toFixed(0)} ms`);

  const clock = new Clock();
  const scene = new SkyScene(canvas, stream.count);
  const hud = createHud(hudRoot, clock, { names: stream.names, dataset, generatedAt: stream.generatedAt });
  const debug = DEBUG ? createDebugPanel(document.body) : null;
  // ?debug: the running piece, for poking at from the console.
  if (DEBUG) Object.assign(window, { birds: { stream, scene, clock } });

  let lastHud = -Infinity;
  let lastWall = performance.now();
  let trailIndex = -1;
  let trailCentre = 0;
  let trailPending = false;

  function frame() {
    clock.tick();
    const now = clock.ms;
    const wall = performance.now();

    // Ticks come from the worker, running ahead of scene time; the GPU blends the
    // two either side of now. Nothing here propagates.
    const pair = stream.update(now, clock.generation, clock.timeRate);
    if (pair) scene.showFrames(pair);

    // The readout only has to keep up with reading, not with the display.
    if (wall - lastHud >= 250) {
      hud.update(clock.date, pair?.from ?? null);
      lastHud = wall;
    }

    // Recompute the trail when the selection changes, or when enough scene time has
    // passed for it to have moved. One request at a time; a stale answer is dropped.
    const selected = hud.selectedIndex();
    if (selected >= 0 && !trailPending && (selected !== trailIndex || Math.abs(now - trailCentre) > 20_000)) {
      trailPending = true;
      const centre = now;
      stream.requestTrack(selected, centre, TRAIL).then((directions) => {
        trailPending = false;
        if (selected !== hud.selectedIndex()) return;
        scene.setTrail(directions);
        trailIndex = selected;
        trailCentre = centre;
      });
    }

    scene.render();
    debug?.frame(wall - lastWall, stream.getStats());
    lastWall = wall;
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

main().catch((err) => {
  console.error(err);
  const hudRoot = document.querySelector<HTMLElement>('#hud');
  if (hudRoot) {
    hudRoot.innerHTML = `<div class="panel"><h1>Birds Within</h1><p class="err">${String(err)}</p></div>`;
  }
});

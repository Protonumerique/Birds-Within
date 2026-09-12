import './style.css';

import { TLE_URL, TRAIL, CLOCK } from './config';
import { loadCatalog } from './tle';
import { skyAt, trackOf, type SkyState } from './sky';
import { SkyScene } from './scene';
import { Clock } from './clock';
import { createHud } from './ui';

async function main() {
  const canvas = document.querySelector<HTMLCanvasElement>('#sky')!;
  const hudRoot = document.querySelector<HTMLElement>('#hud')!;

  const catalog = await loadCatalog(TLE_URL);
  if (catalog.length === 0) throw new Error('catalogue is empty');

  const clock = new Clock();
  const scene = new SkyScene(canvas, catalog.length);
  const hud = createHud(hudRoot, clock, catalog);

  const propagationInterval = 1000 / CLOCK.propagationHz;
  let states: SkyState[] = [];
  let lastPropagation = -Infinity;
  let lastHud = -Infinity;
  let lastTrailIndex = -1;
  let lastTrailMs = 0;

  function frame() {
    clock.tick();
    const date = clock.date;
    const wall = performance.now();

    // Propagation runs on its own clock; rendering stays at display rate.
    //
    // STEP 2 moves this into a Web Worker using satellite.js's WASM
    // BulkPropagator and interpolates between ticks on the render thread.
    // Measured: 30k objects with 8 calculators is ~15 ms single-threaded, so
    // 5 Hz costs roughly 7% of one core. See scripts/bench.mjs.
    //
    // Interpolating azimuth will need wrap-around care - lerping across
    // 359°->1° sends the object the long way round the sky.
    if (wall - lastPropagation >= propagationInterval) {
      states = skyAt(catalog, date);
      scene.update(states);
      lastPropagation = wall;
    }

    // The readout only has to keep up with reading, not with the display.
    if (wall - lastHud >= 250) {
      hud.update(date, states);
      lastHud = wall;
    }

    // A trail costs one propagation per sample, so recompute it only when the
    // selection changes or enough scene time has passed for it to have moved.
    const selected = hud.selectedIndex();
    const entry = selected >= 0 ? catalog[selected] : undefined;
    if (entry && (selected !== lastTrailIndex || Math.abs(date.getTime() - lastTrailMs) > 20_000)) {
      scene.setTrail(
        trackOf(entry, date, TRAIL.pastMinutes, TRAIL.futureMinutes, TRAIL.stepSeconds)
      );
      lastTrailIndex = selected;
      lastTrailMs = date.getTime();
    }

    scene.render();
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

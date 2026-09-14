import { OBSERVER, CLOCK, HIGHLIGHT, HOVER_KEEPS_ROW, HUD_ROWS, type Dataset } from './config';
import type { Clock } from './clock';
import type { SkyFrame } from './sky-frame';
import type { Selection } from './selection';

const deg = (rad: number) => (rad * 180) / Math.PI;
const pad = (n: number) => String(n).padStart(2, '0');

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (azDeg: number) => POINTS[Math.round((((azDeg % 360) + 360) % 360) / 22.5) % 16]!;

export interface Hud {
  update(date: Date, frame: SkyFrame | null): void;
  selectedIndex(): number;
  /**
   * The objects the readout currently lists, highest first - for now the default
   * voices of the sonification to come.
   */
  listed(): readonly number[];
  /**
   * What wears a ring on the sky: every listed object, plus any mark that did not
   * fit in the rows. The sky can hold more rings than the panel can hold rows.
   */
  ringed(): readonly number[];
}

export interface HudSource {
  /** Object names, indexed like every SkyFrame column. */
  names: string[];
  dataset: Dataset;
  /** When the element sets were fetched. */
  generatedAt: Date;
  /** What the pointer is touching and what it has stuck to. Shared with the scene. */
  selection: Selection;
}

/** HIGHLIGHT.markColor as components, so a row can be dimmed the way its ring is. */
const MARK_RGB = (() => {
  const n = parseInt(HIGHLIGHT.markColor.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
})();

/**
 * The same curve the ring shader runs: a marked object low in the sky is darker than
 * one overhead, in the panel and on the dome alike, so the readout's ordering by
 * elevation is visible as brightness without a number being read.
 */
function markBrightness(elevation: number): number {
  const t = Math.min(Math.max(elevation / ((HIGHLIGHT.fullBrightDeg * Math.PI) / 180), 0), 1);
  return HIGHLIGHT.dimAtHorizon + (1 - HIGHLIGHT.dimAtHorizon) * t;
}

const markColor = (alpha: number) => `rgba(${MARK_RGB[0]}, ${MARK_RGB[1]}, ${MARK_RGB[2]}, ${alpha.toFixed(2)})`;

const releaseBelow = (HIGHLIGHT.releaseBelowDeg * Math.PI) / 180;

export function createHud(root: HTMLElement, clock: Clock, source: HudSource): Hud {
  const { names, selection } = source;
  /**
   * What wears the trail when nothing is marked: whatever is highest, held until it
   * sets. A mark takes it over - clicking an object is how you ask for its track.
   */
  let fallback = -1;

  const lat = `${Math.abs(OBSERVER.latitudeDeg).toFixed(3)}° ${OBSERVER.latitudeDeg >= 0 ? 'N' : 'S'}`;
  const lon = `${Math.abs(OBSERVER.longitudeDeg).toFixed(3)}° ${OBSERVER.longitudeDeg >= 0 ? 'E' : 'W'}`;
  const asOf = `${source.generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

  root.innerHTML = `
    <div class="panel">
      <h1>Birds Within</h1>
      <div class="sub">${OBSERVER.name} · ${lat} ${lon}</div>
      <div class="sub">${names.length.toLocaleString('en')} objects · ${source.dataset} · elements as of ${asOf}</div>
      ${source.dataset === 'synthetic' ? '<div class="warn">synthetic · invented orbits, not real objects</div>' : ''}
      <div class="clock" id="t">--:--:--<small id="tl">&nbsp;</small></div>
      <div class="controls">
        <button id="pause">PAUSE</button>
        <button id="now">NOW</button>
        <select id="rate">${CLOCK.rates.map((r) => `<option value="${r}">${r}×</option>`).join('')}</select>
      </div>
      <div class="controls">
        <input id="scrub" type="range" min="-720" max="720" step="1" value="0" title="offset from now, minutes" />
        <span class="sub" id="scrubval">+0 min</span>
      </div>
    </div>
    <div class="panel">
      <div class="sub" id="count">—</div>
      <table>
        <thead><tr><th class="name">Overhead now</th><th>Alt</th><th>Az</th><th>Range</th><th>Δv km/s</th></tr></thead>
        <tbody id="rows"></tbody>
      </table>
      <div class="legend">
        <i style="color:var(--lit)">●</i> sunlit &nbsp;
        <i style="color:var(--eclipsed)">●</i> eclipsed &nbsp;
        <i style="color:var(--ink-faint)">●</i> below horizon &nbsp;·&nbsp; drag to look, scroll to zoom,
        click to keep
      </div>
    </div>
  `;

  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  const tEl = $('t');
  const tlEl = $('tl');
  const rowsEl = $('rows');
  const countEl = $('count');
  const pauseBtn = $<HTMLButtonElement>('pause');
  const scrub = $<HTMLInputElement>('scrub');
  const scrubVal = $('scrubval');

  pauseBtn.onclick = () => {
    clock.togglePause();
    pauseBtn.textContent = clock.isPaused ? 'PLAY' : 'PAUSE';
  };
  $('now').onclick = () => {
    clock.resetToNow();
    scrub.value = '0';
    lastScrub = 0;
    scrubVal.textContent = '+0 min';
  };
  $<HTMLSelectElement>('rate').onchange = (e) => {
    clock.timeRate = Number((e.target as HTMLSelectElement).value);
  };

  let lastScrub = 0;
  scrub.oninput = () => {
    const minutes = Number(scrub.value);
    clock.nudge((minutes - lastScrub) * 60);
    lastScrub = minutes;
    scrubVal.textContent = `${minutes >= 0 ? '+' : ''}${minutes} min`;
  };

  // A fixed pool of rows, refilled each update. The catalogue is far too large to
  // list, so this shows only what is actually overhead, highest first.
  const pool = Array.from({ length: HUD_ROWS }, () => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="name"></td><td></td><td></td><td></td><td></td>`;
    rowsEl.append(tr);
    return { tr, td: tr.querySelectorAll('td'), index: -1 };
  });

  const rowAt = (target: EventTarget | null) => {
    const tr = (target as HTMLElement | null)?.closest('tr');
    const row = pool.find((r) => r.tr === tr);
    return row && row.index >= 0 ? row.index : -1;
  };

  // A row and its object are two halves of one thing: clicking either marks it,
  // pointing at either rings it. The sky is the same gesture, wired up in main.
  rowsEl.onclick = (e) => selection.toggle(rowAt(e.target));
  // A hovered row steps 20px right, which can leave the pointer in the gap it came
  // from. Hover therefore only ever moves to another row, and is dropped when the
  // pointer leaves the table - otherwise the row would flicker in and out under it.
  rowsEl.onpointermove = (e) => {
    const i = rowAt(e.target);
    if (i >= 0) selection.setHovered(i);
  };
  rowsEl.onpointerleave = () => selection.setHovered(-1);

  const above: number[] = [];
  const listed: number[] = [];
  const ringed: number[] = [];
  /**
   * The horizon cull, memoised on the frame it was taken from. The pointer makes the
   * readout rebuild far more often than a tick arrives - every hovered object has to
   * find its row - and rescanning twenty thousand objects for a mouse move would be
   * the one piece of per-frame CPU work this app has managed to avoid.
   */
  let scanned: SkyFrame | null = null;
  let lit = 0;

  return {
    selectedIndex: () => (selection.newest >= 0 ? selection.newest : fallback),
    listed: () => listed,
    ringed: () => ringed,

    update(date, frame) {
      const iso = date.toISOString();
      tEl.firstChild!.textContent = `${iso.slice(11, 19)} UTC`;
      tlEl.textContent = `${iso.slice(0, 10)} · local ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
      if (!frame) return;

      // The horizon cull for the readout: only the few percent that are up get
      // sorted, not the whole catalogue.
      if (frame !== scanned) {
        scanned = frame;
        above.length = 0;
        lit = 0;
        for (let i = 0; i < frame.count; i++) {
          if (frame.range[i]! < 0 || frame.elevation[i]! <= 0) continue;
          above.push(i);
          if (frame.shadow[i]! < 0.5) lit++;
        }
        above.sort((a, b) => frame.elevation[b]! - frame.elevation[a]!);
      }

      // A mark is let go when its object sinks into the haze: the readout lists what
      // is overhead, and an object a degree off the horizon has nothing left to show.
      // Its row is then free for whatever has risen in its place.
      for (const i of selection.marked) {
        if (frame.range[i]! < 0 || frame.elevation[i]! <= releaseBelow) selection.release(i);
      }

      /**
       * The rows, in two passes: everything kept holds its row however far it has
       * fallen, and the slots left over go to the highest, as before. Sorted by
       * elevation either way, so a kept object slides down the list as it descends
       * rather than sitting apart from it.
       */
      const kept = (i: number) => selection.isMarked(i) || (HOVER_KEEPS_ROW && i === selection.hovered);
      listed.length = 0;
      for (const i of above) {
        if (listed.length >= HUD_ROWS) break;
        if (kept(i)) listed.push(i);
      }
      for (const i of above) {
        if (listed.length >= HUD_ROWS) break;
        if (listed.indexOf(i) < 0) listed.push(i);
      }
      listed.sort((a, b) => frame.elevation[b]! - frame.elevation[a]!);

      // Rings: every row, plus anything held or pointed at that did not get one. The
      // sky has room for more rings than the panel has rows.
      ringed.length = 0;
      for (const i of listed) ringed.push(i);
      for (const i of above) {
        if (!selection.isMarked(i) && i !== selection.hovered) continue;
        if (listed.indexOf(i) < 0) ringed.push(i);
      }

      const marks = selection.marked.size;
      countEl.textContent =
        `${above.length} above the horizon · ${lit} sunlit` +
        `${above.length > HUD_ROWS ? ` · showing ${HUD_ROWS}` : ''}` +
        `${marks ? ` · ${marks} kept` : ''}`;

      // Nothing marked: the trail stays on whatever was highest until that one sets.
      if (fallback < 0 || frame.range[fallback]! < 0 || frame.elevation[fallback]! <= 0) {
        fallback = above[0] ?? -1;
      }
      const selected = selection.newest >= 0 ? selection.newest : fallback;

      for (let r = 0; r < pool.length; r++) {
        const row = pool[r]!;
        const i = listed[r];

        if (i === undefined) {
          row.index = -1;
          row.tr.hidden = true;
          continue;
        }

        row.tr.hidden = false;
        row.index = i;
        row.tr.classList.add('up');
        row.tr.classList.toggle('selected', i === selected);

        // Hovered or marked, the row wears the ring's colour and steps out of the
        // column - the only link between a name and a mark on the sky, since no text
        // is ever drawn up there.
        const hovered = i === selection.hovered;
        const tagged = hovered || selection.isMarked(i);
        row.tr.classList.toggle('tagged', tagged);
        row.tr.style.setProperty(
          '--mark-row',
          tagged ? markColor(hovered ? 1 : markBrightness(frame.elevation[i]!)) : 'transparent'
        );

        const azDeg = ((deg(frame.azimuth[i]!) % 360) + 360) % 360;
        const rangeRate = frame.rangeRate[i]!;
        row.td[0]!.textContent = names[i] ?? '—';
        row.td[1]!.textContent = `+${deg(frame.elevation[i]!).toFixed(1)}°`;
        row.td[2]!.textContent = `${azDeg.toFixed(0)}° ${compass(azDeg)}`;
        row.td[3]!.textContent = `${frame.range[i]!.toFixed(0)} km`;
        row.td[4]!.textContent = `${rangeRate >= 0 ? '+' : ''}${rangeRate.toFixed(2)}`;
      }
    },
  };
}

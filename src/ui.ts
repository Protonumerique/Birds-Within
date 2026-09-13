import { OBSERVER, CLOCK, HUD_ROWS, type Dataset } from './config';
import type { Clock } from './clock';
import type { SkyFrame } from './sky-frame';

const deg = (rad: number) => (rad * 180) / Math.PI;
const pad = (n: number) => String(n).padStart(2, '0');

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (azDeg: number) => POINTS[Math.round((((azDeg % 360) + 360) % 360) / 22.5) % 16]!;

export interface Hud {
  update(date: Date, frame: SkyFrame | null): void;
  selectedIndex(): number;
  /**
   * The objects the readout currently lists, highest first - ringed on the sky, and
   * for now the default voices of the sonification to come.
   */
  listed(): readonly number[];
}

export interface HudSource {
  /** Object names, indexed like every SkyFrame column. */
  names: string[];
  dataset: Dataset;
  /** When the element sets were fetched. */
  generatedAt: Date;
}

export function createHud(root: HTMLElement, clock: Clock, source: HudSource): Hud {
  // Start on whatever is highest in the sky; the user can click any row.
  let selected = -1;
  const { names } = source;

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
        <i style="color:var(--ink-faint)">●</i> below horizon &nbsp;·&nbsp; drag to look, scroll to zoom, click a row for its track
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

  rowsEl.onclick = (e) => {
    const tr = (e.target as HTMLElement).closest('tr');
    const row = pool.find((r) => r.tr === tr);
    if (row && row.index >= 0) selected = row.index;
  };

  const above: number[] = [];
  const listed: number[] = [];

  return {
    selectedIndex: () => selected,
    listed: () => listed,

    update(date, frame) {
      const iso = date.toISOString();
      tEl.firstChild!.textContent = `${iso.slice(11, 19)} UTC`;
      tlEl.textContent = `${iso.slice(0, 10)} · local ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
      if (!frame) return;

      // The horizon cull for the readout: only the few percent that are up get
      // sorted, not the whole catalogue.
      above.length = 0;
      let lit = 0;
      for (let i = 0; i < frame.count; i++) {
        if (frame.range[i]! < 0 || frame.elevation[i]! <= 0) continue;
        above.push(i);
        if (frame.shadow[i]! < 0.5) lit++;
      }
      above.sort((a, b) => frame.elevation[b]! - frame.elevation[a]!);

      listed.length = 0;
      for (let r = 0; r < HUD_ROWS && r < above.length; r++) listed.push(above[r]!);

      countEl.textContent =
        `${above.length} above the horizon · ${lit} sunlit` +
        `${above.length > HUD_ROWS ? ` · showing ${HUD_ROWS}` : ''}`;

      if (selected === -1 && above[0] !== undefined) selected = above[0];

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

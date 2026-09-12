import { OBSERVER, CLOCK, HUD_ROWS } from './config';
import type { Clock } from './clock';
import type { CatalogEntry } from './tle';
import type { SkyState } from './sky';

const deg = (rad: number) => (rad * 180) / Math.PI;
const pad = (n: number) => String(n).padStart(2, '0');

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (azDeg: number) => POINTS[Math.round((((azDeg % 360) + 360) % 360) / 22.5) % 16]!;

export interface Hud {
  update(date: Date, states: SkyState[]): void;
  selectedIndex(): number;
}

export function createHud(root: HTMLElement, clock: Clock, catalog: CatalogEntry[]): Hud {
  // Start on whatever is highest in the sky; the user can click any row.
  let selected = -1;

  const lat = `${Math.abs(OBSERVER.latitudeDeg).toFixed(3)}° ${OBSERVER.latitudeDeg >= 0 ? 'N' : 'S'}`;
  const lon = `${Math.abs(OBSERVER.longitudeDeg).toFixed(3)}° ${OBSERVER.longitudeDeg >= 0 ? 'E' : 'W'}`;

  root.innerHTML = `
    <div class="panel">
      <h1>Birds Within</h1>
      <div class="sub">${OBSERVER.name} · ${lat} ${lon} · ${catalog.length} objects tracked</div>
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

  return {
    selectedIndex: () => selected,

    update(date, states) {
      const iso = date.toISOString();
      tEl.firstChild!.textContent = `${iso.slice(11, 19)} UTC`;
      tlEl.textContent = `${iso.slice(0, 10)} · local ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;

      const above = states.filter((s) => s.elevation > 0).sort((a, b) => b.elevation - a.elevation);
      const lit = above.filter((s) => s.shadow < 0.5).length;

      countEl.textContent =
        `${above.length} above the horizon · ${lit} sunlit` +
        `${above.length > HUD_ROWS ? ` · showing ${HUD_ROWS}` : ''}`;

      if (selected === -1 && above[0]) selected = above[0].index;

      for (let i = 0; i < pool.length; i++) {
        const row = pool[i]!;
        const s = above[i];

        if (!s) {
          row.index = -1;
          row.tr.hidden = true;
          continue;
        }

        row.tr.hidden = false;
        row.index = s.index;
        row.tr.classList.add('up');
        row.tr.classList.toggle('selected', s.index === selected);

        const elDeg = deg(s.elevation);
        const azDeg = ((deg(s.azimuth) % 360) + 360) % 360;
        row.td[0]!.textContent = catalog[s.index]?.name ?? '—';
        row.td[1]!.textContent = `+${elDeg.toFixed(1)}°`;
        row.td[2]!.textContent = `${azDeg.toFixed(0)}° ${compass(azDeg)}`;
        row.td[3]!.textContent = `${s.range.toFixed(0)} km`;
        row.td[4]!.textContent = `${s.rangeRate >= 0 ? '+' : ''}${s.rangeRate.toFixed(2)}`;
      }
    },
  };
}

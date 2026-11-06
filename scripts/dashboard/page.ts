/**
 * HTML for the live pages. No framework and nothing fetched from a CDN: the
 * dashboard may run on a box with no outbound network, and a page that cannot
 * load its script shows nothing at all.
 *
 * The index renders in the browser from the same JSON `/api/state` serves, so a
 * poll and a first paint go through one code path.
 */
import type { FleetState, PhaseRunRow } from './db.js';

export const esc = (s: unknown): string => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const DETAIL_CHARS = 160;
const cut = (s: string | null, n = DETAIL_CHARS): string => (!s ? '' : s.length > n ? `${s.slice(0, n)}…` : s);

const dur = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h${m % 60 ? ` ${m % 60}m` : ''}` : `${Math.floor(h / 24)}d ${h % 24}h`;
};
const when = (ms: number | null): string => (ms ? new Date(ms).toLocaleString('en-GB', { hour12: false }) : '');

export const STYLE = `
  .live { color-scheme: light dark; font: 14px/1.5 ui-sans-serif,-apple-system,system-ui,sans-serif;
          --line: color-mix(in srgb, CanvasText 12%, transparent); --soft: color-mix(in srgb, CanvasText 5%, transparent) }
  body.live { margin: 0; padding: 1.5rem 2rem; background: Canvas; color: CanvasText }
  .live h1 { font-size: 1.15rem; margin: 0 0 .75rem } .live h2 { font-size: .95rem; margin: 1.5rem 0 .5rem }
  .live table { border-collapse: collapse; width: 100% }
  .live th { text-align: left; font-weight: 600; font-size: .72rem; text-transform: uppercase; letter-spacing: .04em;
             opacity: .55; padding: 0 .5rem .4rem }
  .live td { padding: .4rem .5rem; border-top: 1px solid var(--line); vertical-align: top }
  .live a { color: inherit } .live .dim { opacity: .55 } .live .num { text-align: right; font-variant-numeric: tabular-nums }
  .live .mono, .live pre { font-family: ui-monospace,SFMono-Regular,monospace; font-size: .8rem }
  .live pre { white-space: pre-wrap; word-break: break-word; background: var(--soft); padding: .75rem; border-radius: 6px }
  .live .strip { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 1rem }
  .live .card { background: var(--soft); border-radius: 8px; padding: .5rem .8rem; min-width: 9rem }
  .live .card b { display: block; font-size: 1.1rem } .live .card span { font-size: .72rem; opacity: .6 }
  .live .pill { font-size: .72rem; padding: .1rem .45rem; border-radius: 999px; background: color-mix(in srgb, CanvasText 10%, transparent); white-space: nowrap }
  .live .p-done, .live .p-ok { background: color-mix(in srgb, #16a34a 28%, transparent) }
  .live .p-blocked, .live .p-failed, .live .p-aborted, .live .p-infra { background: color-mix(in srgb, #dc2626 28%, transparent) }
  .live .p-running, .live .p-claimed { background: color-mix(in srgb, #2563eb 28%, transparent) }
  .live .p-parked, .live .p-warned, .live .p-refused { background: color-mix(in srgb, #d97706 28%, transparent) }
  .live .warn { color: #dc2626 } .live .ok { color: #16a34a }
  .live .section { padding: 1rem 2rem; border-bottom: 1px solid var(--line) }
`;

/**
 * Client renderer. Plain JS in a template string, so it must avoid backticks
 * and `${` — it is concatenated, not interpolated.
 */
const CLIENT = String.raw`
const esc = (s) => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const dur = (ms) => { let s = Math.max(0, Math.round(ms/1000)); if (s < 60) return s+'s'; const m = Math.floor(s/60);
  if (m < 60) return m+'m'; const h = Math.floor(m/60); return h < 48 ? h+'h'+(m%60 ? ' '+(m%60)+'m' : '') : Math.floor(h/24)+'d '+(h%24)+'h'; };
const num = (n) => (n || 0).toLocaleString();
const cut = (s, n) => !s ? '' : s.length > n ? s.slice(0, n)+'…' : s;
const pill = (s) => '<span class="pill p-'+esc(s)+'">'+esc(s)+'</span>';
const card = (v, label) => '<div class="card"><b>'+v+'</b><span>'+label+'</span></div>';
function row(r, now, live) {
  const safe = (u) => u && /^https?:\/\//.test(u) ? u : null;
  const ticket = safe(r.url) ? '<a href="'+esc(r.url)+'">#'+r.iid+'</a>' : '#'+r.iid;
  const phase = r.current.length
    ? r.current.map((p) => esc(p.phase)+' <span class="dim">lap '+p.lap+' · '+dur(now - p.startedAt)+'</span>').join('<br>')
    : esc(r.phase || '');
  const owner = !r.owner ? '<span class="dim">none</span>'
    : r.ownerAlive ? '<span class="ok">alive</span>'
    : '<span class="warn">gone</span>'+(r.ownerSeenAt ? ' <span class="dim">'+dur(now - r.ownerSeenAt)+' ago</span>' : '');
  const mr = safe(r.mrUrl) ? '<a href="'+esc(r.mrUrl)+'">!'+(r.mrIid || 'MR')+'</a>' : r.mrIid ? '!'+r.mrIid : '';
  const total = dur((r.endedAt || now) - r.startedAt);
  return '<tr><td>'+ticket+'</td><td><a href="/run/'+r.iid+'">'+esc(r.title)+'</a></td><td>'+pill(r.status)+'</td>'
    + '<td>'+phase+'</td><td class="num">'+total+'</td>'+(live ? '<td>'+owner+'</td>' : '')+'<td>'+mr+'</td>'
    + '<td class="dim" title="'+esc(r.blockedWhy)+'">'+esc(cut(r.blockedWhy, 90))+'</td></tr>';
}
function table(rows, now, live) {
  if (!rows.length) return '<p class="dim">None.</p>';
  return '<table><tr><th>Ticket</th><th>Title</th><th>Status</th><th>Phase</th><th>Elapsed</th>'+(live ? '<th>Owner</th>' : '')
    + '<th>MR</th><th>Why</th></tr>'+rows.map((r) => row(r, now, live)).join('')+'</table>';
}
function render(s) {
  const now = s.now;
  document.getElementById('strip').innerHTML =
      card(s.conductors.length, 'live conductors')
    + card(s.pauses.length ? '<span class="warn">'+esc(s.pauses.join(', '))+'</span>' : 'none', 'pause switches')
    + card(s.leases.length ? esc(s.leases.map((l) => l.port).join(', ')) : 'none', 'port leases')
    + card(num(s.weighted5h), 'weighted tokens, last 5h')
    + card(num(s.weightedToday), 'weighted tokens, today')
    + (s.dbFound ? '' : card('<span class="warn">missing</span>', 'oneshot.db'));
  document.getElementById('active').innerHTML = table(s.active, now, true);
  document.getElementById('finished').innerHTML = table(s.finished, now, false);
  document.getElementById('stamp').textContent = 'updated ' + new Date(now).toLocaleTimeString();
}
render(JSON.parse(document.getElementById('initial').textContent));
setInterval(() => fetch('/api/state', { credentials: 'same-origin' })
  .then((r) => r.ok ? r.json() : Promise.reject(r.status)).then(render)
  .catch((e) => { document.getElementById('stamp').textContent = 'refresh failed (' + e + ') — retrying'; }), 10000);
`;

// '<' escaped so a title containing "</script>" cannot end the JSON block.
const embed = (v: unknown): string => JSON.stringify(v).replace(/</g, '\\u003c');

export function indexPage(state: FleetState): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Oneshot live</title><style>${STYLE}</style></head>
<body class="live">
<h1>Oneshot live <span class="dim mono" id="stamp"></span></h1>
<div class="strip" id="strip"></div>
<h2>Active runs</h2><div id="active"></div>
<h2>Recently finished</h2><div id="finished"></div>
<p class="dim"><a href="/runs">Every run, including archived journals</a></p>
<script type="application/json" id="initial">${embed(state)}</script>
<script>${CLIENT}</script>
</body></html>`;
}

/** The DB's view of one run, placed above the transcript report. */
export function runSection(
  iid: number,
  phases: PhaseRunRow[],
  events: Array<{ ts: number; kind: string; phase: string | null; detail: string | null }>,
): string {
  const now = Date.now();
  const prow = (p: PhaseRunRow): string => `<tr><td>${esc(p.phase)}</td><td class="num">${p.lap}</td><td>${esc(p.model)}</td>
    <td><span class="pill p-${esc(p.status)}">${esc(p.status)}</span></td><td class="dim">${esc(when(p.started_at))}</td>
    <td class="num">${dur((p.ended_at ?? now) - p.started_at)}</td><td class="num">${p.turns ?? ''}</td>
    <td class="num">${p.weighted ? p.weighted.toLocaleString() : ''}</td><td class="dim mono" title="${esc(p.detail)}">${esc(cut(p.detail))}</td></tr>`;
  const erow = (e: (typeof events)[number]): string => `<tr><td class="dim">${esc(when(e.ts))}</td><td>${esc(e.kind)}</td>
    <td>${esc(e.phase)}</td><td class="dim mono" title="${esc(e.detail)}">${esc(cut(e.detail))}</td></tr>`;
  return `<style>${STYLE}</style><div class="live section">
<p><a href="/">← live</a> · <a href="/run/${iid}/tail">tail the newest transcript</a></p>
<h2>Phase timeline</h2>${phases.length ? `<table><tr><th>Phase</th><th>Lap</th><th>Model</th><th>Status</th><th>Start</th>
<th>Duration</th><th>Turns</th><th>Weighted</th><th>Detail</th></tr>${phases.map(prow).join('')}</table>` : '<p class="dim">No phase runs in the database.</p>'}
<h2>Recent events</h2>${events.length ? `<table><tr><th>When</th><th>Kind</th><th>Phase</th><th>Detail</th></tr>${events.map(erow).join('')}</table>`
    : '<p class="dim">No events.</p>'}
</div>`;
}

export function tailPage(iid: number, file: string | null, lines: string[]): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tail #${iid}</title><style>${STYLE}</style></head>
<body class="live"><p><a href="/run/${iid}">← run #${iid}</a></p>
<h1>#${iid} — ${file ? esc(file) : 'no transcript yet'}</h1>
<pre>${lines.length ? lines.map(esc).join('\n') : 'Nothing to show.'}</pre></body></html>`;
}

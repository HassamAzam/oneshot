/**
 * HTML for the live pages. No framework and nothing fetched from a CDN: the
 * dashboard is served on a LAN box with no promise of outbound network, and a
 * page that cannot load its script shows nothing at all.
 *
 * The index renders in the browser from the same JSON `/api/state` serves, so a
 * poll and a first paint go through one code path. The run page is rendered on
 * the server and reloads itself while the run is in flight.
 */
import type { FleetState, RunDetail, PhaseRunRow, EventRow } from './db.js';
import { compact, dur, type BoardStatus } from '../../src/lib/fleetview.js';

export const esc = (s: unknown): string => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const DETAIL_CHARS = 160;
const cut = (s: string | null, n = DETAIL_CHARS): string => (!s ? '' : s.length > n ? `${s.slice(0, n)}…` : s);
const when = (ms: number | null): string => (ms ? new Date(ms).toLocaleString('en-GB', { hour12: false }) : '');

/** Board status → what the pill says. The client carries the same table. */
export const LABEL: Record<BoardStatus, string> = {
  running: 'running', starting: 'starting', gate: 'on a gate', blocked: 'blocked',
  window: 'waiting for window', quota: 'quota stand-down', stalled: 'stalled', done: 'done', aborted: 'aborted',
};

// Colours are tokens on .live, redefined for dark; every status has a tint
// (--s-*) and the pill mixes it with the page so contrast holds in both themes.
export const STYLE = `
  .live { color-scheme: light dark; font: 14px/1.45 ui-sans-serif,-apple-system,system-ui,"Segoe UI",sans-serif;
    --bg: #f7f7f5; --panel: #ffffff; --text: #1c1d1f; --mute: #6b6f76; --line: #e3e3df; --link: #1f5fbf;
    --s-running: #2563eb; --s-starting: #2563eb; --s-gate: #b45309; --s-blocked: #dc2626; --s-window: #6d28d9;
    --s-quota: #7c3aed; --s-stalled: #c2410c; --s-done: #15803d; --s-aborted: #6b7280;
    --s-ok: #15803d; --s-failed: #dc2626; --s-infra: #dc2626; --s-parked: #b45309; --s-warned: #b45309;
    --s-refused: #b45309; --s-skipped: #6b7280; --s-claimed: #2563eb }
  @media (prefers-color-scheme: dark) {
    .live { --bg: #141518; --panel: #1c1d21; --text: #e7e7e4; --mute: #9a9ea6; --line: #2d2f35; --link: #8ab4ff;
      --s-running: #60a5fa; --s-starting: #60a5fa; --s-gate: #f59e0b; --s-blocked: #f87171; --s-window: #a78bfa;
      --s-quota: #c4b5fd; --s-stalled: #fb923c; --s-done: #4ade80; --s-aborted: #9ca3af;
      --s-ok: #4ade80; --s-failed: #f87171; --s-infra: #f87171; --s-parked: #f59e0b; --s-warned: #f59e0b;
      --s-refused: #f59e0b; --s-skipped: #9ca3af; --s-claimed: #60a5fa }
  }
  body.live { margin: 0; padding: 16px; background: var(--bg); color: var(--text) }
  .live * { box-sizing: border-box }
  .live .wrap { max-width: 78rem; margin: 0 auto }
  .live a { color: var(--link); text-decoration: none } .live a:hover { text-decoration: underline }
  .live h1 { font-size: 1.15rem; margin: 0; display: flex; flex-wrap: wrap; gap: .25rem .75rem; align-items: baseline }
  .live h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; color: var(--mute); margin: 1.5rem 0 .5rem;
    display: flex; gap: .5rem; align-items: center; flex-wrap: wrap }
  .live h2 .n { background: var(--line); color: var(--text); border-radius: 999px; padding: 0 .45rem; letter-spacing: 0 }
  .live .dim { color: var(--mute) } .live .num { text-align: right; font-variant-numeric: tabular-nums }
  .live .mono, .live pre { font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size: .8rem }
  .live pre { white-space: pre-wrap; word-break: break-word; background: var(--panel); border: 1px solid var(--line);
    padding: .75rem; border-radius: 8px; margin: 0 }
  .live .stamp { font-size: .78rem; font-weight: 400; color: var(--mute) } .live .stamp.stale { color: var(--s-blocked) }
  .live .strip { display: grid; grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr)); gap: .5rem; margin-top: .9rem }
  .live .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: .55rem .8rem }
  .live .card .k { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: var(--mute) }
  .live .card .v { font-size: 1.15rem; font-weight: 600; margin: .1rem 0 }
  .live .card .s { font-size: .75rem; color: var(--mute) }
  .live .card.bad { border-color: var(--s-blocked) } .live .card.bad .v { color: var(--s-blocked) }
  .live .card.wait { border-color: var(--s-window) } .live .card.wait .v { color: var(--s-window) }
  .live .bar { height: 4px; background: var(--line); border-radius: 2px; margin-top: .35rem; overflow: hidden }
  .live .bar i { display: block; height: 100%; background: var(--s-running) }
  .live .pill { display: inline-block; font-size: .72rem; font-weight: 600; padding: .1rem .5rem; border-radius: 999px; white-space: nowrap;
    color: var(--c, var(--mute)); background: color-mix(in srgb, var(--c, var(--mute)) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--c, var(--mute)) 35%, transparent) }
  .live .list { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: hidden }
  .live .t { display: grid; grid-template-columns: 9.5rem minmax(0, 1fr) 11rem 6rem 5.5rem 4.5rem; gap: .25rem .9rem;
    align-items: baseline; padding: .6rem .9rem; border-top: 1px solid var(--line) }
  .live .t:first-child { border-top: 0 } .live .t.head { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: var(--mute); padding: .45rem .9rem }
  .live .t .title { min-width: 0 } .live .t .title b { font-weight: 600 } .live .t .title a.name { color: var(--text) }
  .live .t .why { grid-column: 2 / -1; font-size: .78rem; color: var(--mute); overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
  .live .t .lbl { display: none }
  .live .empty { padding: .9rem; color: var(--mute) }
  .live select { font: inherit; font-size: .75rem; color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: .1rem .3rem }
  .live table { border-collapse: collapse; width: 100% }
  .live th { text-align: left; font-weight: 600; font-size: .7rem; text-transform: uppercase; letter-spacing: .04em; color: var(--mute); padding: .45rem .6rem }
  .live td { padding: .4rem .6rem; border-top: 1px solid var(--line); vertical-align: top } .live td.num { white-space: nowrap }
  .live .scroll { overflow-x: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 10px }
  .live .facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr)); gap: .5rem; margin-top: .9rem }
  .live .note { background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--c, var(--mute)); border-radius: 8px;
    padding: .6rem .8rem; margin-top: .9rem; white-space: pre-wrap; word-break: break-word }
  .live details summary { cursor: pointer; color: var(--mute); margin: 1.2rem 0 .5rem; font-size: .8rem; text-transform: uppercase; letter-spacing: .05em }
  .live .runs { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .6rem; font-size: .8rem }
  .live .runs a.on { font-weight: 700; color: var(--text) }
  @media (max-width: 760px) {
    .live .t.head { display: none }
    .live .t { grid-template-columns: auto minmax(0, 1fr); gap: .2rem .6rem }
    .live .t > .title { grid-column: 1 / -1; order: -1 }
    .live .t .why { grid-column: 1 / -1; white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical }
    .live .t .lbl { display: inline; color: var(--mute); font-size: .72rem; margin-right: .3rem }
    .live .t .num { text-align: left }
  }
`;

/**
 * Client renderer. Plain JS in a template string, so it must avoid backticks
 * and `${` — it is concatenated, not interpolated.
 */
const CLIENT = String.raw`
const LABEL = __LABEL__;
const esc = (s) => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const dur = (ms) => { let s = Math.max(0, Math.round(ms/1000)); if (s < 60) return s+'s'; const m = Math.floor(s/60);
  if (m < 60) return m+'m'; const h = Math.floor(m/60); return h < 48 ? h+'h'+(m%60 ? ' '+(m%60)+'m' : '') : Math.floor(h/24)+'d '+(h%24)+'h'; };
const compact = (n) => { n = n || 0; const a = Math.abs(n); return a >= 1e9 ? (n/1e9).toFixed(1)+'B' : a >= 1e6 ? (n/1e6).toFixed(1)+'M'
  : a >= 1e4 ? Math.round(n/1e3)+'k' : String(Math.round(n)); };
const hhmm = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const pill = (b) => '<span class="pill" style="--c:var(--s-'+esc(b)+')">'+esc(LABEL[b] || b)+'</span>';
const card = (k, v, s, cls) => '<div class="card '+(cls || '')+'"><div class="k">'+k+'</div><div class="v">'+v+'</div><div class="s">'+(s || '&nbsp;')+'</div></div>';
const IN_FLIGHT = ['running', 'starting', 'stalled', 'window', 'quota'];
const PERSON = ['gate', 'blocked'];
// In flight: what is not moving first, then the longest-running. Waiting on a
// person: the newest first, since a row weeks old is rarely the one to act on.
const RANK = { stalled: 0, quota: 1, window: 2, running: 3, starting: 4 };
let state = null, lastOk = Date.now();

// A reason the runs table still holds from an earlier stop is not why a
// moving run is where it is, so only a stopped run shows its own.
function whyLine(r) {
  const s = state;
  const text = r.board === 'window' ? 'Outside the run window ('+s.window.spec+'); resumes when it opens'+(s.window.nextChange ? ' at '+hhmm(s.window.nextChange) : '')+'.'
    : r.board === 'quota' ? 'The fleet is standing down after a usage limit'+(s.quota.parkedUntil ? ' until '+hhmm(s.quota.parkedUntil) : '')+'; resumes then.'
    : r.board === 'stalled' ? 'No live conductor owns this run; the next conductor to tick will resume it.'
    : ['gate', 'blocked', 'aborted'].indexOf(r.board) >= 0 ? r.why : '';
  return text ? '<div class="why" title="'+esc(text)+'">'+esc(text)+'</div>' : '';
}
function ticket(r, now, finished) {
  const iid = r.url ? '<a href="'+esc(r.url)+'" title="Open the GitLab issue" target="_blank" rel="noopener">#'+r.iid+'</a>' : '#'+r.iid;
  // An attempt row left open by a crash is not a phase a stopped run is in.
  const phase = IN_FLIGHT.indexOf(r.board) >= 0 && r.current.length
    ? r.current.map((p) => esc(p.phase)+(p.lap ? ' <span class="dim">lap '+(p.lap+1)+'</span>' : '')).join(', ')
    : esc(r.phase || '—');
  const forMs = finished ? (r.endedAt || now) - r.startedAt : now - r.since;
  const mr = r.mrUrl ? '<a href="'+esc(r.mrUrl)+'" target="_blank" rel="noopener">!'+esc(r.mrIid || 'MR')+'</a>' : r.mrIid ? '!'+esc(r.mrIid) : '<span class="dim">—</span>';
  const why = whyLine(r);
  return '<div class="t">'
    + '<div>'+pill(r.board)+'</div>'
    + '<div class="title">'+iid+' <a class="name" href="/run/'+r.iid+'?run='+encodeURIComponent(r.runId)+'"><b>'+esc(r.title || '(untitled)')+'</b></a></div>'
    + '<div><span class="lbl">phase</span>'+phase+'</div>'
    + '<div class="num" title="'+(finished ? 'total run time' : 'in this state since '+esc(new Date(r.since).toLocaleString('en-GB')))+'"><span class="lbl">'+(finished ? 'took' : 'for')+'</span>'+dur(forMs)+'</div>'
    + '<div><span class="lbl">MR</span>'+mr+'</div>'
    + '<div class="num dim" title="weighted tokens, '+r.attempts+' phase attempts"><span class="lbl">tokens</span>'+compact(r.weighted)+'</div>'
    + why + '</div>';
}
function list(rows, now, finished, empty) {
  const head = '<div class="t head"><div>Status</div><div>Ticket</div><div>Phase</div><div class="num">'+(finished ? 'Took' : 'For')+'</div><div>MR</div><div class="num">Tokens</div></div>';
  return '<div class="list">'+(rows.length ? head + rows.map((r) => ticket(r, now, finished)).join('') : '<div class="empty">'+empty+'</div>')+'</div>';
}
function strip(s) {
  const now = s.now, w = s.window, q = s.quota;
  const slots = s.slots.of ? s.slots.used+' / '+s.slots.of : String(s.slots.used);
  const pct = s.slots.of ? Math.min(100, Math.round(100 * s.slots.used / s.slots.of)) : 0;
  const win = !w.valid ? card('Run window', 'unreadable', esc(w.spec), 'bad')
    : w.spec === 'always' ? card('Run window', 'always', 'no daily stop')
    : card('Run window', w.open ? 'open' : 'closed',
        esc(w.spec)+(w.nextChange ? ' · '+(w.open ? 'closes ' : 'opens ')+hhmm(w.nextChange) : ''), w.open ? '' : 'wait');
  const quota = q.parkedUntil
    ? card('Quota', 'standing down', 'until '+hhmm(q.parkedUntil)+' ('+dur(q.parkedUntil - now)+')', 'bad')
    : card('Quota', q.accountPct != null ? q.accountPct+'% of 5h' : 'ok',
        compact(q.weighted5h)+' weighted in 5h · '+compact(q.weightedToday)+' today'
        + (q.lastParkAt && now - q.lastParkAt < 86400000 ? ' · parked '+dur(now - q.lastParkAt)+' ago' : ''));
  return card('Slots', slots, s.slots.of ? 'ONESHOT_CONCURRENCY<div class="bar"><i style="width:'+pct+'%"></i></div>' : 'concurrency unknown')
    + win + quota
    + card('Conductors', s.conductors.length, s.conductors.length ? 'heartbeat '+dur(now - Math.max.apply(null, s.conductors.map((c) => c.heartbeatAt)))+' ago' : 'none alive', s.conductors.length ? '' : (w.open ? 'bad' : 'wait'))
    + (s.pauses.length ? card('Paused', esc(s.pauses.join(', ')), 'remove the file in state/ to resume', 'bad') : '')
    + (s.dbFound ? '' : card('Database', 'missing', 'state/oneshot.db not found', 'bad'));
}
function render(s) {
  state = s;
  const now = s.now;
  const flying = s.active.filter((r) => IN_FLIGHT.indexOf(r.board) >= 0).sort((a, b) => (RANK[a.board] - RANK[b.board]) || (a.since - b.since));
  const person = s.active.filter((r) => PERSON.indexOf(r.board) >= 0).sort((a, b) => b.since - a.since);
  document.getElementById('strip').innerHTML = strip(s);
  document.getElementById('n-flight').textContent = flying.length;
  document.getElementById('n-person').textContent = person.length;
  document.getElementById('n-done').textContent = s.finished.length;
  document.getElementById('flight').innerHTML = list(flying, now, false, 'Nothing in flight.');
  document.getElementById('person').innerHTML = list(person, now, false, 'Nobody is waited on.');
  document.getElementById('done').innerHTML = list(s.finished, now, true, 'Nothing finished in this period.');
  document.title = 'Oneshot · '+flying.length+' in flight · '+person.length+' waiting';
  lastOk = Date.now();
  tick();
}
function tick() {
  const el = document.getElementById('stamp'), age = Date.now() - lastOk;
  el.textContent = 'updated '+dur(age)+' ago';
  el.className = 'stamp' + (age > 60000 ? ' stale' : '');
}
const hoursSel = document.getElementById('hours');
function refresh() {
  return fetch('/api/state?hours='+encodeURIComponent(hoursSel.value), { credentials: 'same-origin' })
    .then((r) => r.ok ? r.json() : Promise.reject(r.status)).then(render)
    .catch((e) => { tick(); document.getElementById('stamp').textContent += ' — refresh failed ('+e+'), retrying'; });
}
hoursSel.addEventListener('change', () => {
  const u = new URL(location.href); u.searchParams.set('hours', hoursSel.value); history.replaceState(null, '', u);
  refresh();
});
render(JSON.parse(document.getElementById('initial').textContent));
setInterval(refresh, 10000);
setInterval(tick, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
`.replace('__LABEL__', JSON.stringify(LABEL));

// '<' escaped so a title containing "</script>" cannot end the JSON block.
const embed = (v: unknown): string => JSON.stringify(v).replace(/</g, '\\u003c');

const HOURS = [[24, 'last 24h'], [72, 'last 3 days'], [168, 'last 7 days'], [720, 'last 30 days']] as const;

export function indexPage(state: FleetState): string {
  const opts = HOURS.map(([h, l]) => `<option value="${h}"${h === state.historyHours ? ' selected' : ''}>${l}</option>`).join('')
    + (HOURS.some(([h]) => h === state.historyHours) ? '' : `<option value="${state.historyHours}" selected>last ${state.historyHours}h</option>`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Oneshot fleet</title><style>${STYLE}</style></head>
<body class="live"><div class="wrap">
<h1>Oneshot fleet ${state.project ? `<a class="stamp" href="${esc(state.project)}" target="_blank" rel="noopener">${esc(state.project.replace(/^https?:\/\//, ''))}</a>` : ''}
<span class="stamp" id="stamp"></span></h1>
<div class="strip" id="strip"></div>
<h2>In flight <span class="n" id="n-flight"></span></h2><div id="flight"></div>
<h2>Waiting on a person <span class="n" id="n-person"></span></h2><div id="person"></div>
<h2>Finished <span class="n" id="n-done"></span> <select id="hours" aria-label="History period">${opts}</select></h2><div id="done"></div>
<p class="dim" style="font-size:.8rem;margin-top:1.5rem"><a href="/runs">Every run journal, archived ones included</a> · refreshes every 10s</p>
</div>
<script type="application/json" id="initial">${embed(state)}</script>
<script>${CLIENT}</script>
</body></html>`;
}

const pillFor = (status: string, label = status): string => `<span class="pill" style="--c:var(--s-${esc(status)})">${esc(label)}</span>`;
const fact = (k: string, v: string, s = ''): string => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s || '&nbsp;'}</div></div>`;

/**
 * One run from the database: where it stands, a line per phase, every attempt,
 * events, and the transcript's tail. The transcript report is a link away.
 */
export function runPageHtml(d: RunDetail, tail: { file: string | null; lines: string[] } | null, hasReport: boolean): string {
  const now = Date.now();
  const r = d.run;
  const live = r.board === 'running' || r.board === 'starting';
  const tokens = new Map(d.tokens.map((t) => [t.phase, t]));
  const issue = r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">#${r.iid}</a>` : `#${r.iid}`;
  const mr = r.mrUrl ? `<a href="${esc(r.mrUrl)}" target="_blank" rel="noopener">!${esc(r.mrIid ?? 'MR')}</a>` : r.mrIid ? `!${esc(r.mrIid)}` : '—';

  const rollRow = (p: RunDetail['rollup'][number]): string => {
    const t = tokens.get(p.phase);
    return `<tr><td>${esc(p.phase)}</td><td>${pillFor(p.status)}</td><td class="num">${p.laps}</td><td class="num">${dur(p.ms)}</td>
      <td class="num">${p.turns || ''}</td><td class="num">${t ? compact(t.input) : ''}</td><td class="num">${t ? compact(t.output) : ''}</td>
      <td class="num">${t ? compact(t.cacheRead) : ''}</td><td class="num">${compact(t?.weighted ?? p.weighted)}</td></tr>`;
  };
  const prow = (p: PhaseRunRow): string => `<tr><td>${esc(p.phase)}</td><td class="num">${p.lap}</td><td class="dim">${esc(p.model)}</td>
    <td>${pillFor(p.status)}</td><td class="dim">${esc(when(p.started_at))}</td>
    <td class="num">${dur((p.ended_at ?? now) - p.started_at)}</td><td class="num">${p.turns ?? ''}</td>
    <td class="num">${p.weighted ? compact(p.weighted) : ''}</td><td class="dim mono" title="${esc(p.detail)}">${esc(cut(p.detail))}</td></tr>`;
  const erow = (e: EventRow): string => `<tr><td class="dim">${esc(when(e.ts))}</td><td>${esc(e.kind)}</td>
    <td>${esc(e.phase)}</td><td class="dim mono" title="${esc(e.detail)}">${esc(cut(e.detail))}</td></tr>`;

  const others = d.runs.length > 1 ? `<div class="runs"><span class="dim">Runs of this ticket:</span>${d.runs.map((x) =>
    `<a class="${x.runId === r.runId ? 'on' : ''}" href="/run/${r.iid}?run=${encodeURIComponent(x.runId)}">${esc(when(x.startedAt))} · ${esc(x.status)}</a>`).join('')}</div>` : '';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${live ? '<meta http-equiv="refresh" content="30">' : ''}<title>#${r.iid} ${esc(LABEL[r.board])} · Oneshot</title><style>${STYLE}</style></head>
<body class="live"><div class="wrap">
<p style="margin:0 0 .6rem"><a href="/">← fleet</a>${hasReport ? ` · <a href="/run/${r.iid}/report">full transcript report</a>` : ''}</p>
<h1>${pillFor(r.board, LABEL[r.board])} <span>${issue}</span> <span>${esc(r.title)}</span></h1>
${others}
<div class="facts">
  ${fact('Phase', esc((live && r.current.map((c) => c.phase).join(', ')) || r.phase || '—'), live ? '' : 'stopped here')}
  ${fact(r.endedAt && (r.board === 'done' || r.board === 'aborted') ? 'Took' : 'In this state for', r.endedAt && (r.board === 'done' || r.board === 'aborted') ? dur(r.endedAt - r.startedAt) : dur(now - r.since), `since ${esc(when(r.board === 'done' || r.board === 'aborted' ? r.startedAt : r.since))}`)}
  ${fact('Merge request', mr)}
  ${fact('Attempts', String(r.attempts), `${d.rollup.length} phases`)}
  ${fact('Tokens', compact(r.weighted), 'weighted')}
  ${fact('Conductor', r.owner ? (r.ownerAlive ? 'alive' : 'gone') : 'none', esc(r.runId))}
</div>
${r.why && (r.board === 'gate' || r.board === 'blocked' || r.board === 'aborted') ? `<div class="note" style="--c:var(--s-${esc(r.board)})">${esc(r.why)}</div>` : ''}
<h2>Phases</h2>${d.rollup.length ? `<div class="scroll"><table><tr><th>Phase</th><th>Last</th><th class="num">Laps</th><th class="num">Time</th>
<th class="num">Turns</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cache read</th><th class="num">Weighted</th></tr>
${d.rollup.map(rollRow).join('')}</table></div>` : '<p class="dim">No phase runs in the database.</p>'}
${tail ? `<h2>Transcript tail <a class="stamp" href="/run/${r.iid}/tail">full tail${tail.file ? ` · ${esc(tail.file)}` : ''}</a></h2>
<pre style="max-height:28rem;overflow:auto">${tail.lines.length ? tail.lines.slice(-25).map(esc).join('\n') : 'No transcript yet.'}</pre>` : ''}
<details><summary>Every attempt (${d.phases.length})</summary>${d.phases.length ? `<div class="scroll"><table><tr><th>Phase</th><th class="num">Lap</th><th>Model</th><th>Status</th><th>Start</th>
<th class="num">Duration</th><th class="num">Turns</th><th class="num">Weighted</th><th>Detail</th></tr>${d.phases.map(prow).join('')}</table></div>` : ''}</details>
<details><summary>Recent events (${d.events.length})</summary>${d.events.length ? `<div class="scroll"><table><tr><th>When</th><th>Kind</th><th>Phase</th><th>Detail</th></tr>${d.events.map(erow).join('')}</table></div>`
    : '<p class="dim">No events.</p>'}</details>
</div></body></html>`;
}

export function tailPage(iid: number, file: string | null, lines: string[]): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tail #${iid}</title><style>${STYLE}</style></head>
<body class="live"><div class="wrap"><p><a href="/run/${iid}">← run #${iid}</a></p>
<h1>#${iid} — ${file ? esc(file) : 'no transcript yet'}</h1>
<pre style="margin-top:.8rem">${lines.length ? lines.map(esc).join('\n') : 'Nothing to show.'}</pre></div></body></html>`;
}

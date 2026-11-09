/**
 * `npm run dashboard` — the live view of the fleet, and the door to every run.
 *
 * `/` polls `/api/state` (read from state/oneshot.db, read-only) so every
 * ticket's status, the fleet's slots, run window and quota stay current without
 * a reload; `/runs` is the journal index, archived runs included; `/run/:iid`
 * is one run's phases, laps, tokens and transcript tail, and `/run/:iid/report`
 * its full transcript report.
 *
 * Node's own http module and no build step. Nothing here writes to state/:
 * reports are rendered in memory, the DB is opened read-only, so opening a page
 * can never race a conductor, and a fleet can be inspected while it works.
 */
import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { RUNS, STATE, envOr } from '../src/lib/config.js';
import { readJournal, type RunJournal } from '../src/lib/artifacts.js';
import { buildReportModel, renderHtml } from '../src/lib/report.js';
import { authorise, requireTokenFor } from './dashboard/auth.js';
import { HISTORY_HOURS, fleetState, runDetail, stats } from './dashboard/db.js';
import { esc, indexPage, runPageHtml, statsPage, tailPage } from './dashboard/page.js';
import { tail } from './dashboard/tail.js';

const PORT = Number(envOr('ONESHOT_DASHBOARD_PORT', '8787'));
const HOST = envOr('ONESHOT_DASHBOARD_HOST', '127.0.0.1');
const TOKEN = envOr('ONESHOT_DASHBOARD_TOKEN');
const ARCHIVE = join(STATE, 'runs-archive');
// An archive directory name as the conductor writes it: no separators, no dot-dot.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface Row {
  iid: number;
  title: string;
  status: string;
  runId: string;
  when: number;
  phases: number;
  archived: string | null;
}

/**
 * Every run we can show, newest first.
 *
 * Archived runs are included because a re-run of the same ticket moves the old
 * journal aside, and the run you want to read is often the one that was moved.
 */
function rows(): Row[] {
  const out: Row[] = [];

  const push = (j: RunJournal | null, archived: string | null): void => {
    if (!j) return;
    out.push({
      iid: j.iid,
      title: j.title ?? '',
      status: j.status ?? 'unknown',
      runId: j.runId ?? '',
      when: j.createdAt ?? 0,
      phases: (j.phases ?? []).length,
      archived,
    });
  };

  if (existsSync(RUNS)) {
    for (const name of readdirSync(RUNS)) {
      const iid = Number(name);
      if (Number.isInteger(iid) && iid > 0) push(readJournal(iid), null);
    }
  }
  if (existsSync(ARCHIVE)) {
    for (const name of readdirSync(ARCHIVE)) {
      const file = join(ARCHIVE, name, 'run.json');
      if (!existsSync(file)) continue;
      try {
        push(JSON.parse(readFileSync(file, 'utf8')) as RunJournal, name);
      } catch { /* an unreadable archive is not worth failing the index over */ }
    }
  }

  return out.sort((a, b) => b.when - a.when);
}

const AGE = (ms: number): string => {
  if (!ms) return '';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};

function index(): string {
  const list = rows();
  const cell = (r: Row): string => `
    <tr class="s-${esc(r.status)}">
      <td class="iid"><a href="/run/${r.iid}${r.archived ? `?archived=${encodeURIComponent(r.archived)}` : ''}">#${r.iid}</a></td>
      <td class="ttl">${esc(r.title)}${r.archived ? ' <span class="arch">archived</span>' : ''}</td>
      <td><span class="pill p-${esc(r.status)}">${esc(r.status)}</span></td>
      <td class="num">${r.phases}</td>
      <td class="dim">${esc(AGE(r.when))}</td>
      <td class="dim mono">${esc(r.runId.slice(0, 14))}</td>
    </tr>`;

  return `<!doctype html><meta charset="utf-8"><title>Oneshot runs</title>
<style>
  :root { color-scheme: light dark }
  body { font: 14px/1.5 ui-sans-serif,-apple-system,system-ui,sans-serif; margin: 0; padding: 2rem;
         max-width: 62rem; background: Canvas; color: CanvasText }
  h1 { font-size: 1.15rem; margin: 0 0 .25rem }
  p.sub { margin: 0 0 1.5rem; opacity: .6 }
  table { border-collapse: collapse; width: 100% }
  th { text-align: left; font-weight: 600; font-size: .75rem; text-transform: uppercase;
       letter-spacing: .04em; opacity: .55; padding: 0 .6rem .5rem }
  td { padding: .55rem .6rem; border-top: 1px solid color-mix(in srgb, CanvasText 12%, transparent) }
  tr:hover td { background: color-mix(in srgb, CanvasText 4%, transparent) }
  .iid a { font-weight: 600; text-decoration: none; color: inherit }
  .iid a:hover { text-decoration: underline }
  .ttl { width: 55% }
  .num { text-align: right; font-variant-numeric: tabular-nums }
  .dim { opacity: .55 } .mono { font-family: ui-monospace,SFMono-Regular,monospace; font-size: .8rem }
  .arch { font-size: .7rem; opacity: .5; border: 1px solid; border-radius: 3px; padding: 0 .25rem }
  .pill { font-size: .72rem; padding: .1rem .45rem; border-radius: 999px;
          background: color-mix(in srgb, CanvasText 10%, transparent) }
  .p-done { background: color-mix(in srgb, #16a34a 25%, transparent) }
  .p-blocked { background: color-mix(in srgb, #dc2626 25%, transparent) }
  .p-running { background: color-mix(in srgb, #2563eb 25%, transparent) }
  .empty { opacity: .6; padding: 2rem 0 }
</style>
<h1>Oneshot runs <a href="/" style="font-size:.8rem;font-weight:400">live view</a></h1>
<p class="sub">${list.length} run${list.length === 1 ? '' : 's'} — click a ticket for its phases, agents and transcripts. Refresh for current state.</p>
${list.length ? `<table>
  <tr><th>Ticket</th><th>Title</th><th>Status</th><th>Phases</th><th>Started</th><th>Run</th></tr>
  ${list.map(cell).join('')}
</table>` : '<p class="empty">No runs yet. Label a ticket <code>Loop</code> and start the conductor.</p>'}`;
}

/**
 * A run's page: the database's view of it, rendered on demand so it is current
 * for a run still in flight — or, for an archived run, the report written at
 * the time.
 */
function runPage(iid: number, archived: string | null, runId: string | null): { code: number; body: string } {
  if (archived) {
    const file = join(ARCHIVE, archived, 'run.json');
    if (!existsSync(file)) return { code: 404, body: 'No such archived run.' };
    // An archived run's transcripts live beside its journal, and buildReportModel
    // reads the live directory — so serve the report that was written at the time.
    const html = join(ARCHIVE, archived, 'report.html');
    return existsSync(html)
      ? { code: 200, body: readFileSync(html, 'utf8') }
      : { code: 200, body: `<!doctype html><meta charset=utf-8><p style="font:14px sans-serif">This run was archived before reports existed. Its journal is at <code>${esc(file)}</code>.</p><p><a href="/">back</a></p>` };
  }
  const detail = runDetail(iid, runId);
  if (!detail) return existsSync(join(RUNS, String(iid))) ? reportPage(iid) : { code: 404, body: `No run found for #${iid}.` };
  // The journal and its transcripts — so the tail and the report — describe
  // only the ticket's current run; an older run gets the database's view alone.
  const current = readJournal(iid)?.runId === detail.run.runId;
  return { code: 200, body: runPageHtml(detail, current ? tail(iid) : null, current && existsSync(join(RUNS, String(iid)))) };
}

/**
 * The transcript report, on its own page: it carries its own stylesheet, and
 * building it parses every transcript, which on a long run is seconds of work
 * the run page should not wait on.
 */
function reportPage(iid: number): { code: number; body: string } {
  const model = buildReportModel(iid);
  return model ? { code: 200, body: renderHtml(model) } : { code: 404, body: `No report for #${iid}.` };
}

const hoursParam = (url: URL): number => Number(url.searchParams.get('hours')) || HISTORY_HOURS;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const send = (code: number, body: string, type = 'text/html; charset=utf-8'): void => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };
  if (!authorise(req, res, url, TOKEN)) return;

  try {
    if (url.pathname === '/') return send(200, indexPage(fleetState(hoursParam(url))));
    if (url.pathname === '/api/state') return send(200, JSON.stringify(fleetState(hoursParam(url))), 'application/json');
    if (url.pathname === '/runs') return send(200, index());
    if (url.pathname === '/stats') return send(200, statsPage(stats(Number(url.searchParams.get('days') ?? 30))));
    if (url.pathname === '/api/stats') return send(200, JSON.stringify(stats(Number(url.searchParams.get('days') ?? 30))), 'application/json');

    const m = url.pathname.match(/^\/run\/(\d{1,9})(\/tail|\/report)?$/);
    if (m) {
      const iid = Number(m[1]);
      if (m[2] === '/report') {
        const out = reportPage(iid);
        return send(out.code, out.body);
      }
      if (m[2]) {
        const t = tail(iid);
        return send(200, tailPage(iid, t.file, t.lines));
      }
      const archived = url.searchParams.get('archived');
      if (archived !== null && !SAFE_NAME.test(archived)) return send(400, 'Bad archive name.', 'text/plain');
      const out = runPage(iid, archived, url.searchParams.get('run'));
      return send(out.code, out.body);
    }

    // Artifacts — screenshots, so a report can link to them. Resolved and then
    // checked to still sit under the run's artifacts dir, which a stripped '..'
    // alone does not guarantee (encoded or absolute segments).
    const a = url.pathname.match(/^\/artifacts\/(\d{1,9})\/(.+)$/);
    if (a) {
      const root = resolve(RUNS, a[1]!, 'artifacts');
      const file = resolve(root, decodeURIComponent(a[2]!));
      if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) return send(404, 'Not found', 'text/plain');
      const ext = file.split('.').pop()?.toLowerCase() ?? '';
      const type = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
        : ext === 'gif' ? 'image/gif' : ext === 'mp4' ? 'video/mp4' : ext === 'webm' ? 'video/webm' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type });
      return res.end(readFileSync(file));
    }

    return send(404, '<p style="font:14px sans-serif">Not found. <a href="/">Live view</a></p>');
  } catch (err) {
    return send(500, `<pre>${esc((err as Error).message)}</pre>`);
  }
});

// Loopback by default. `listen(PORT)` with no host binds every interface, and
// the pages render run journals, which carry whatever a failing phase quoted
// into its own error text — verified once from a LAN address: 200, with the
// pinned ONESHOT_TEST_LOGIN password in the body. So any other host must come
// with a token, and starting without one is refused rather than warned about.
try {
  requireTokenFor(HOST, TOKEN);
} catch (err) {
  console.error(`\n  Refusing to start: ${(err as Error).message}\n`);
  process.exit(1);
}
server.listen(PORT, HOST, () => {
  console.log(`\n  Oneshot dashboard  →  http://${HOST.includes(':') ? `[${HOST}]` : HOST}:${PORT}${TOKEN ? '  (token required)' : ''}\n`);
  console.log('  Live fleet view, refreshing every 10s; /runs lists every journal.');
  console.log('  Ctrl-C to stop.\n');
});

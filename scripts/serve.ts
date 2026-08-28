/**
 * `npm run dashboard` — one URL that lists every run and opens any of them.
 *
 * The reports already exist as files, and a file is a fine artifact but a poor
 * front door: it makes you know an iid and a path before you can look at
 * anything. This is the index that answers "which tickets have run?" and turns
 * the answer into a link.
 *
 * Deliberately small. Node's own http module, no dependency, no build step, no
 * websocket and no polling — a page is rendered from the run directory at the
 * moment you ask for it, so a refresh is the whole update mechanism. That is
 * enough because a run takes hours and the interesting moment is when it ends.
 *
 * Nothing here writes to state/. Reports are rendered in memory and served, so
 * opening a page can never race a conductor writing the same file, and a fleet
 * of three conductors can be inspected while they work.
 */
import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { RUNS, STATE, envOr } from '../src/lib/config.js';
import { readJournal, type RunJournal } from '../src/lib/artifacts.js';
import { buildReportModel, renderHtml } from '../src/lib/report.js';

const PORT = Number(envOr('ONESHOT_DASHBOARD_PORT', '8787'));
const ARCHIVE = join(STATE, 'runs-archive');

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

const esc = (s: unknown): string => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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
<h1>Oneshot runs</h1>
<p class="sub">${list.length} run${list.length === 1 ? '' : 's'} — click a ticket for its phases, agents and transcripts. Refresh for current state.</p>
${list.length ? `<table>
  <tr><th>Ticket</th><th>Title</th><th>Status</th><th>Phases</th><th>Started</th><th>Run</th></tr>
  ${list.map(cell).join('')}
</table>` : '<p class="empty">No runs yet. Label a ticket <code>Loop</code> and start the conductor.</p>'}`;
}

/**
 * A run's report, rendered on demand.
 *
 * Rendered rather than read from report.html so the page is current even for a
 * run still in flight, and so a conductor writing that file cannot be raced.
 */
function runPage(iid: number, archived: string | null): { code: number; body: string } {
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
  const model = buildReportModel(iid);
  if (!model) return { code: 404, body: `No run found for #${iid}.` };
  return { code: 200, body: renderHtml(model) };
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const send = (code: number, body: string, type = 'text/html; charset=utf-8'): void => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };

  try {
    if (url.pathname === '/') return send(200, index());

    const m = url.pathname.match(/^\/run\/(\d+)$/);
    if (m) {
      const out = runPage(Number(m[1]), url.searchParams.get('archived'));
      return send(out.code, out.body);
    }

    // Artifacts — screenshots and the demo, so a report can link to them.
    const a = url.pathname.match(/^\/artifacts\/(\d+)\/(.+)$/);
    if (a) {
      const file = join(RUNS, a[1]!, 'artifacts', a[2]!.replace(/\.\./g, ''));
      if (!existsSync(file) || !statSync(file).isFile()) return send(404, 'Not found', 'text/plain');
      const ext = file.split('.').pop()?.toLowerCase() ?? '';
      const type = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
        : ext === 'gif' ? 'image/gif' : ext === 'mp4' ? 'video/mp4' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type });
      return res.end(readFileSync(file));
    }

    return send(404, '<p style="font:14px sans-serif">Not found. <a href="/">All runs</a></p>');
  } catch (err) {
    return send(500, `<pre>${esc((err as Error).message)}</pre>`);
  }
});

server.listen(PORT, () => {
  console.log(`\n  Oneshot dashboard  →  http://localhost:${PORT}\n`);
  console.log('  Lists every run. Click a ticket for its phases, the agents each');
  console.log('  one dispatched, and the transcripts. Refresh for current state.');
  console.log('  Ctrl-C to stop.\n');
});

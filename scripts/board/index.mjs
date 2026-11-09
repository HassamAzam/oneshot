#!/usr/bin/env node
/**
 * Oneshot Board collector — writes this desk's telemetry into the board's Postgres.
 *
 *   npm run board          daemon: scan every 5s, ship every 60s
 *   npm run board:once     one scan + one flush, then exit (cron-friendly)
 *   npm run board:dry      extract and queue, never ship
 *   npm run board:stats    print what is waiting in the outbox
 *
 * Configured entirely from Oneshot's own .env: BOARD_DATABASE_URL and optionally
 * BOARD_OPERATOR. Reads state/runs/<iid>/{run.json,transcripts/*.jsonl}
 * and state/hook-events.jsonl; writes nothing into state/. Its own bookkeeping
 * lives in BOARD_STATE_DIR (default ~/.oneshot-board).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CFG } from './config.mjs';
import { resolveOperator } from './identity.mjs';
import { journalToRun, readJournal, runDirs, sessionKey, ts } from './journal.mjs';
import { extractTranscript, parseTranscriptName } from './extract.mjs';
import { gatesFor } from './gates.mjs';
import { collectEvidence } from './evidence.mjs';
import { mergedBy, mergerCache } from './mrmerger.mjs';
import { loadHookIndex } from './hooks.mjs';
import { Outbox, atomicWrite } from './outbox.mjs';
import { Sink } from './sink.mjs';

const args = new Set(process.argv.slice(2));
const ONCE = args.has('--once');
const DRY = CFG.dryRun || args.has('--dry-run');
const STATS = args.has('--stats');

mkdirSync(CFG.stateDir, { recursive: true });

/**
 * One collector per state directory.
 *
 * Two of them share an outbox and a watermark file and will race on both: one
 * advances the watermark past lines the other has not shipped, and the loser's
 * write wins. The lock is a pid file, checked for liveness rather than trusted —
 * a killed collector must not wedge the next one out.
 */
const LOCK = join(CFG.stateDir, 'collector.pid');
function claimLock() {
  try {
    const prev = Number(readFileSync(LOCK, 'utf8').trim());
    if (prev && prev !== process.pid) {
      try { process.kill(prev, 0); return prev; } catch { /* stale — the process is gone */ }
    }
  } catch { /* no lock file yet */ }
  try { writeFileSync(LOCK, String(process.pid)); } catch { /* best effort */ }
  return 0;
}
function releaseLock() {
  try { if (Number(readFileSync(LOCK, 'utf8').trim()) === process.pid) unlinkSync(LOCK); } catch { /* ignore */ }
}
const STATE_FILE = join(CFG.stateDir, 'state.json');
let state = { files: {} };
if (existsSync(STATE_FILE)) {
  try { state = JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { /* start fresh */ }
  state.files ||= {};
}
/** sha ids of evidence already queued — a 5 s rescan must not re-hash into a new outbox entry. */
const evidenceSeen = new Set(Array.isArray(state.evidence) ? state.evidence : []);
/** Skips already logged this process: an oversized file is reported once, not every scan. */
const skipsLogged = new Set();
const outbox = new Outbox(CFG.stateDir);
const operator = resolveOperator();
const mergers = mergerCache(CFG.stateDir);
/** run_id → in-flight lookup, so one run is never asked about twice at once. */
const lookups = new Map();
/** Runs already asked this process: a null answer (GitLab unreachable) is not retried every scan. */
const tried = new Set();

/**
 * Who merged a run's MR, without making scan() wait on GitLab: a miss starts the
 * lookup in the background and returns null; the scan after it lands ships the name.
 */
function mergerOf(j) {
  // Only a Review run gets a merge row; asking GitLab for any other is wasted.
  if (!j.reviewMode || !j.mergedSha || !j.mrIid) return null;
  const known = mergers.get(j.runId);
  if (known !== undefined && (known !== null || tried.has(j.runId))) return known;
  if (!lookups.has(j.runId)) {
    tried.add(j.runId);
    lookups.set(j.runId, mergedBy(j.mrIid)
      .then((name) => { mergers.set(j.runId, name); mergers.save(); })
      .catch(() => undefined)
      .finally(() => lookups.delete(j.runId)));
  }
  return known ?? null;
}
/** host:port/db of the board's database — never the user or password. */
function dbHost(url) {
  try { const u = new URL(url); return `${u.hostname}:${u.port || 5432}${u.pathname}`; } catch { return '(unparseable BOARD_DATABASE_URL)'; }
}
const log = (m, extra) => console.log(`${new Date().toISOString()} ${m}${extra ? ` ${JSON.stringify(extra)}` : ''}`);

function scan() {
  const t0 = Date.now();
  let parsed = 0;
  const hooks = loadHookIndex(CFG.oneshotHome);
  outbox.put('operators', { ...operator, last_seen: new Date().toISOString() });

  for (const { dir, iid, archived } of runDirs(CFG.oneshotHome)) {
    const j = readJournal(dir);
    if (j) {
      outbox.put('runs', journalToRun(j, operator.id, archived));
      for (const g of gatesFor(j, operator.id, mergerOf(j))) outbox.put('interventions', g);
      const ev = collectEvidence({
        runDir: dir, journal: j, operatorId: operator.id,
        mediaDir: CFG.mediaDir, maxBytes: CFG.maxMediaBytes, seen: evidenceSeen,
      });
      for (const r of ev.rows) { outbox.put('evidence', r); evidenceSeen.add(r.id); }
      for (const s of ev.skipped) {
        // An unwritable media dir is the same news for every run: say it once.
        const key = s.startsWith(`${CFG.mediaDir}:`) ? s : `${j.runId}:${s}`;
        if (!skipsLogged.has(key)) { skipsLogged.add(key); log(`evidence skipped: run ${j.iid} ${s}`); }
      }
    }
    const tdir = join(dir, 'transcripts');
    const files = existsSync(tdir) ? readdirSync(tdir).filter((f) => f.endsWith('.jsonl')) : [];
    const seen = new Set();

    for (const f of files) {
      const file = join(tdir, f);
      const named = parseTranscriptName(f);
      if (!named) continue;
      seen.add(`${named.phase}/lap${named.lap}`);
      let st;
      try { st = statSync(file); } catch { continue; }
      const prev = state.files[file];
      const unchanged = prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs;
      // A finished file is never re-read. A running one is re-checked every 30s so it can turn 'abandoned'.
      if (unchanged && prev.status !== 'running') continue;
      if (unchanged && prev.lastCheck && Date.now() - prev.lastCheck < 30_000) continue;
      if (!j && !iid) continue;

      const r = extractTranscript({
        file, journal: j, iid: j?.iid ?? iid, operatorId: operator.id,
        sinceLine: prev?.lines ?? 0, hookIndex: hooks, runStatus: j?.status,
      });
      if (!r) continue;
      parsed += 1;
      outbox.put('sessions', r.session);
      for (const a of r.agents) outbox.put('agent_calls', a);
      for (const s of r.skills) outbox.put('skill_calls', s);
      for (const t of r.tools) outbox.put('tool_calls', t);
      for (const l of r.lines) outbox.put('transcript_lines', l);
      state.files[file] = { size: st.size, mtimeMs: st.mtimeMs, lines: r.lineCount, status: r.session.status, lastCheck: Date.now() };
    }

    // Phases with no transcript (code phases like merge/close, or a spawn refused at the door)
    // still get a thin row, so a ticket's session list is complete. seq=0 never beats a real snapshot.
    for (const p of j?.phases ?? []) {
      const lap = p.lap ?? 0;
      if (seen.has(`${p.phase}/lap${lap}`)) continue;
      outbox.put('sessions', {
        session_id: sessionKey(j.runId, p.phase, lap), claude_session_id: p.sessionId ?? null,
        run_id: j.runId, ticket_iid: j.iid, phase: p.phase, lap, model: p.model ?? null,
        status: p.status ?? 'ok', cwd: null, turns: p.turns ?? 0,
        tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, weighted: p.weighted ?? null,
        started_at: ts(p.startedAt), ended_at: ts(p.endedAt),
        duration_ms: p.startedAt && p.endedAt ? Math.max(0, p.endedAt - p.startedAt) : null,
        result_text: null, error_text: p.error ? String(p.error).slice(0, 4000) : null,
        transcript_path: null, transcript_lines: 0, seq: 0, operator_id: operator.id,
      });
    }
  }

  // Outbox first, watermark second: a crash between the two re-parses (idempotent) rather than losing rows.
  outbox.persist();
  state.evidence = [...evidenceSeen];
  atomicWrite(STATE_FILE, JSON.stringify(state));
  if (parsed) log(`scan: ${parsed} transcript(s) changed`, { pending: outbox.size(), ms: Date.now() - t0 });
}

let flushing = false;
let sink = null;
async function flush() {
  if (flushing || !outbox.size()) return;
  flushing = true;
  try {
    if (DRY) { log('dry-run: holding rows, not shipping', outbox.counts()); return; }
    if (!CFG.databaseUrl) { log('BOARD_DATABASE_URL unset — rows wait in the outbox', outbox.counts()); return; }
    const batches = outbox.batches(CFG.maxBatchBytes);
    let wrote = 0;
    try {
      if (!sink) {
        const s = new Sink(CFG.databaseUrl);
        try { await s.open(); } catch (e) { await s.close().catch(() => undefined); throw e; }
        sink = s;
        for (const [t, cols] of Object.entries(sink.droppedColumns())) {
          log(`schema warning: board's ${t} lacks ${cols.join(', ')} — not written (the whole table if a key is missing)`);
        }
      }
      const waiting = {};
      for (const b of batches) {
        const { counts, skipped } = await sink.write(b.payload);
        // Rows of a table the board lacks stay queued; they ship once it migrates.
        outbox.ack(skipped.length ? b.keys.filter(([t]) => !skipped.includes(t)) : b.keys);
        for (const t of skipped) waiting[t] = (waiting[t] ?? 0) + b.payload[t].length;
        wrote += Object.values(counts).reduce((a, n) => a + n, 0);
      }
      const lacking = Object.entries(waiting);
      if (lacking.length) {
        log(`board schema lacks: ${lacking.map(([t]) => t).join(', ')} — ${lacking.reduce((a, [, n]) => a + n, 0)} row(s) waiting`);
      }
    } catch (e) { log(`flush: database error — ${e.message}; will retry`, { pending: outbox.size() }); }
    outbox.persist();
    if (wrote) log(`flush: wrote ${wrote} row(s) in ${batches.length} batch(es)`, { remaining: outbox.size() });
  } finally {
    flushing = false;
  }
}

if (STATS) {
  const files = Object.keys(state.files).length;
  console.log(JSON.stringify({ operator, pending: outbox.counts(), files, stateDir: CFG.stateDir }, null, 2));
  const notes = [...(operator.warnings ?? [])];
  if (!files) {
    notes.push(`no transcripts found under ${CFG.oneshotHome}/state/runs — either this checkout has not run a `
      + 'ticket yet, or ONESHOT_HOME points somewhere else.');
  }
  if (!CFG.databaseUrl) notes.push('BOARD_DATABASE_URL is not set in .env — nothing will ship.');
  if (notes.length) { console.log('\nWarnings:'); for (const n of notes) console.log(`  ! ${n}`); console.log(); }
  process.exit(0);
}

// --stats only reads; it must never be blocked by a running daemon.
const held = STATS ? 0 : claimLock();
if (held) {
  log(`another collector is already running (pid ${held}) using ${CFG.stateDir} — exiting. `
    + 'Two would race on the outbox and the watermark.');
  process.exit(0);
}

log('oneshot-board collector', {
  oneshot: CFG.oneshotHome, board: CFG.databaseUrl ? dbHost(CFG.databaseUrl) : '(unset)',
  operator: operator.id, via: operator.github_login ? 'github' : operator.user_email ? 'claude-email' : 'hostname',
  state: CFG.stateDir, dryRun: DRY,
});
for (const w of operator.warnings ?? []) log(`identity warning: ${w}`);
if (!CFG.databaseUrl) log('BOARD_DATABASE_URL is not set in .env — extracting locally, shipping nothing');
scan();
// A single pass waits for the merge answerers it just asked for (15 s at most each), then
// rescans so they ship now rather than on the next --once.
if (ONCE && lookups.size) { await Promise.all(lookups.values()); scan(); }
await flush();
if (ONCE) { await sink?.close().catch(() => undefined); releaseLock(); log('once: done', outbox.counts()); process.exit(0); }

setInterval(scan, CFG.scanMs);
setInterval(() => flush().catch((e) => log(`flush error: ${e.message}`)), CFG.flushMs);
const stop = async () => {
  outbox.persist(); atomicWrite(STATE_FILE, JSON.stringify(state)); releaseLock();
  await sink?.close().catch(() => undefined);
  log('stopped', outbox.counts()); process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

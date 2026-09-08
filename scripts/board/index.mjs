#!/usr/bin/env node
/**
 * Oneshot Board collector — ships this desk's telemetry to the shared board.
 *
 *   npm run board          daemon: scan every 5s, ship every 60s
 *   npm run board:once     one scan + one flush, then exit (cron-friendly)
 *   npm run board:dry      extract and queue, never ship
 *   npm run board:stats    print what is waiting in the outbox
 *
 * Configured entirely from Oneshot's own .env: BOARD_URL, BOARD_INGEST_TOKEN and
 * optionally BOARD_OPERATOR. Reads state/runs/<iid>/{run.json,transcripts/*.jsonl}
 * and state/hook-events.jsonl; writes nothing into state/. Its own bookkeeping
 * lives in BOARD_STATE_DIR (default ~/.oneshot-board).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CFG } from './config.mjs';
import { resolveOperator } from './identity.mjs';
import { journalToRun, readJournal, runDirs, sessionKey, ts } from './journal.mjs';
import { extractTranscript, parseTranscriptName } from './extract.mjs';
import { loadHookIndex } from './hooks.mjs';
import { Outbox, atomicWrite } from './outbox.mjs';
import { postBatch, postRetention } from './ship.mjs';

const args = new Set(process.argv.slice(2));
const ONCE = args.has('--once');
const DRY = CFG.dryRun || args.has('--dry-run');
const STATS = args.has('--stats');

mkdirSync(CFG.stateDir, { recursive: true });
const STATE_FILE = join(CFG.stateDir, 'state.json');
let state = { files: {} };
if (existsSync(STATE_FILE)) {
  try { state = JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { /* start fresh */ }
  state.files ||= {};
}
const outbox = new Outbox(CFG.stateDir);
const operator = resolveOperator();
const log = (m, extra) => console.log(`${new Date().toISOString()} ${m}${extra ? ` ${JSON.stringify(extra)}` : ''}`);

function scan() {
  const t0 = Date.now();
  let parsed = 0;
  const hooks = loadHookIndex(CFG.oneshotHome);
  outbox.put('operators', { ...operator, last_seen: new Date().toISOString() });

  for (const { dir, iid, archived } of runDirs(CFG.oneshotHome)) {
    const j = readJournal(dir);
    if (j) outbox.put('runs', journalToRun(j, operator.id, archived));
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
  atomicWrite(STATE_FILE, JSON.stringify(state));
  if (parsed) log(`scan: ${parsed} transcript(s) changed`, { pending: outbox.size(), ms: Date.now() - t0 });
}

let flushing = false;
async function flush() {
  if (flushing || !outbox.size()) return;
  flushing = true;
  try {
    if (DRY) { log('dry-run: holding rows, not shipping', outbox.counts()); return; }
    if (!CFG.boardUrl || !CFG.ingestToken) { log('BOARD_URL / BOARD_INGEST_TOKEN unset — rows wait in the outbox', outbox.counts()); return; }
    const batches = outbox.batches(CFG.maxBatchBytes);
    let shipped = 0;
    for (const b of batches) {
      let res;
      try { res = await postBatch(CFG.boardUrl, CFG.ingestToken, b.payload); }
      catch (e) { log(`flush: network error — ${e.message}; will retry`, { pending: outbox.size() }); break; }
      if (!res.ok) { log(`flush: ingest refused HTTP ${res.status} — ${res.text}; will retry`, { pending: outbox.size() }); break; }
      outbox.ack(b.keys);
      shipped += b.keys.length;
    }
    outbox.persist();
    if (shipped) log(`flush: shipped ${shipped} row(s) in ${batches.length} batch(es)`, { remaining: outbox.size() });
  } finally {
    flushing = false;
  }
}

async function retention() {
  if (DRY || !CFG.boardUrl || !CFG.ingestToken) return;
  try {
    const r = await postRetention(CFG.boardUrl, CFG.ingestToken);
    log(r.ok ? `retention: ${r.text}` : `retention: HTTP ${r.status} ${r.text}`);
  } catch (e) { log(`retention: ${e.message}`); }
}

if (STATS) {
  const files = Object.keys(state.files).length;
  console.log(JSON.stringify({ operator, pending: outbox.counts(), files, stateDir: CFG.stateDir }, null, 2));
  const notes = [...(operator.warnings ?? [])];
  if (!files) {
    notes.push(`no transcripts found under ${CFG.oneshotHome}/state/runs — either this checkout has not run a `
      + 'ticket yet, or ONESHOT_HOME points somewhere else.');
  }
  if (!CFG.boardUrl || !CFG.ingestToken) notes.push('BOARD_URL / BOARD_INGEST_TOKEN are not both set in .env — nothing will ship.');
  if (notes.length) { console.log('\nWarnings:'); for (const n of notes) console.log(`  ! ${n}`); console.log(); }
  process.exit(0);
}

log('oneshot-board collector', {
  oneshot: CFG.oneshotHome, board: CFG.boardUrl || '(unset)',
  operator: operator.id, via: operator.github_login ? 'github' : operator.user_email ? 'claude-email' : 'hostname',
  state: CFG.stateDir, dryRun: DRY,
});
for (const w of operator.warnings ?? []) log(`identity warning: ${w}`);
if (!CFG.boardUrl || !CFG.ingestToken) {
  log('BOARD_URL / BOARD_INGEST_TOKEN are not set in .env — extracting locally, shipping nothing');
}
scan();
await flush();
if (ONCE) { log('once: done', outbox.counts()); process.exit(0); }
await retention();
setInterval(() => retention(), 24 * 60 * 60_000);

setInterval(scan, CFG.scanMs);
setInterval(() => flush().catch((e) => log(`flush error: ${e.message}`)), CFG.flushMs);
const stop = () => { outbox.persist(); atomicWrite(STATE_FILE, JSON.stringify(state)); log('stopped', outbox.counts()); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

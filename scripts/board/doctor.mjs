#!/usr/bin/env node
/**
 * `npm run board:doctor` — why is this desk not on the board?
 *
 * Answers the whole question in one pass: who this desk is, whether Oneshot has
 * produced anything to ship, whether the board's database is reachable and current,
 * and what is queued. Every check prints a verdict and, when it fails, the fix.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CFG } from './config.mjs';
import { resolveOperator } from './identity.mjs';
import { runDirs, readJournal } from './journal.mjs';
import { Sink, TABLES } from './sink.mjs';
import { fallbackId, getProject, gitlabTarget } from './mrmerger.mjs';

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m';
const ok = (m, d) => console.log(`  ${G}✓${X} ${m}${d ? `  ${D}${d}${X}` : ''}`);
const bad = (m, fix) => { console.log(`  ${R}✗${X} ${m}`); if (fix) console.log(`      ${Y}→ ${fix}${X}`); failed += 1; };
const warn = (m, fix) => { console.log(`  ${Y}!${X} ${m}`); if (fix) console.log(`      ${Y}→ ${fix}${X}`); };
let failed = 0;

console.log('\nOneshot Board — desk check\n');

// ---- 1. identity
const operator = resolveOperator();
ok(`this desk posts as "${operator.id}"`, `os_user=${operator.os_user ?? '-'} github=${operator.github_login ?? '-'}`);
for (const w of operator.warnings ?? []) warn(w);

// ---- 2. is there anything to ship?
console.log(`\n${D}Oneshot at ${CFG.oneshotHome}${X}`);
if (!existsSync(CFG.oneshotHome)) {
  bad(`ONESHOT_HOME does not exist: ${CFG.oneshotHome}`, 'ONESHOT_HOME defaults to this checkout — remove a stale ONESHOT_HOME from .env or your shell, or point it at your oneshot checkout');
} else if (!existsSync(join(CFG.oneshotHome, 'state', 'runs'))) {
  bad('no state/runs directory — this checkout has never run a ticket',
      'start the conductor (npm start) and let one phase finish, then re-run this');
} else {
  const dirs = runDirs(CFG.oneshotHome);
  let files = 0, newest = 0;
  for (const { dir } of dirs) {
    const t = join(dir, 'transcripts');
    if (!existsSync(t)) continue;
    for (const f of readdirSync(t).filter((x) => x.endsWith('.jsonl'))) {
      files += 1;
      try { newest = Math.max(newest, statSync(join(t, f)).mtimeMs); } catch { /* ignore */ }
    }
  }
  const journals = dirs.filter(({ dir }) => readJournal(dir)).length;
  if (!files) {
    bad(`${dirs.length} run dir(s), ${journals} journal(s), but 0 transcripts`,
        'the conductor has not completed a phase yet. Transcripts appear at '
        + 'state/runs/<iid>/transcripts/ once a phase spawns — check that the loop is actually claiming a ticket.');
  } else {
    const age = Math.round((Date.now() - newest) / 60000);
    ok(`${files} transcript(s) across ${dirs.length} run(s)`, `newest ${age}m old`);
  }
}

// ---- 3. is the board's database configured and reachable?
console.log(`\n${D}Board${X}`);
if (!CFG.databaseUrl) bad('BOARD_DATABASE_URL is not set', 'add BOARD_DATABASE_URL=postgresql://… to .env — the same value as the board\'s DATABASE_URL');
else {
  let host = '(unparseable URL)';
  try { const u = new URL(CFG.databaseUrl); host = `${u.hostname}:${u.port || 5432}${u.pathname}`; } catch { /* reported below */ }
  const sink = new Sink(CFG.databaseUrl);
  try {
    await sink.open();
    ok(`connects  ${host}`);
    const { rows } = await sink.pool.query(
      'select table_name from information_schema.tables where table_schema = current_schema() and table_name = any($1)', [TABLES]);
    const present = new Set(rows.map((r) => r.table_name));
    const missing = TABLES.filter((t) => !present.has(t));
    if (missing.length) bad(`board tables missing: ${missing.join(', ')}`, 'apply the board\'s schema (its db-migrate script) to this database');
    else ok(`all ${TABLES.length} board tables present`);
    for (const [t, cols] of Object.entries(sink.droppedColumns())) {
      if (!missing.includes(t)) warn(`${t} lacks ${cols.join(', ')} — those values are not written`, 'the board\'s schema is older than this collector; migrate it');
    }
    if (present.has('operators')) {
      const r = await sink.pool.query('select max(last_seen) as at from operators');
      const at = r.rows[0].at;
      if (at) ok('last row written', `${Math.round((Date.now() - new Date(at).getTime()) / 60000)}m ago`);
      else warn('nothing shipped yet', 'run `npm run board:once` and read the flush line');
    }
  } catch (e) {
    bad(`cannot connect to ${host}: ${e.message}`, 'check BOARD_DATABASE_URL and that Postgres is running');
  } finally {
    await sink.close().catch(() => undefined);
  }
}

// The merge gate's answerer is asked of GitLab; without it the row ships with a null name.
{
  const t = gitlabTarget();
  if (t.error) warn(`GitLab: ${t.error}`, 'merge answerer will be null');
  else {
    try {
      const res = await getProject(t, '', { timeoutMs: 10_000 });
      const id = fallbackId(t);
      if (res.status === 200) ok(`GitLab answers for ${t.project}`, id ? `by id ${id} — the path form is not routed` : undefined);
      else warn(`GitLab: ${t.project} answered HTTP ${res.status}`, 'merge answerer will be null');
    } catch (e) {
      warn(`GitLab: ${t.project} unreachable (${e.name === 'TimeoutError' ? 'no answer in 10 s' : e.message})`, 'merge answerer will be null');
    }
  }
}

// ---- 4. is the collector actually running?
console.log(`\n${D}Collector${X}`);
let running = false;
try {
  const { execFileSync } = await import('node:child_process');
  const ps = execFileSync('ps', ['-eo', 'pid,command'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const line = ps.split('\n').find((l) => /board\/index\.mjs/.test(l) && !/doctor\.mjs/.test(l));
  running = Boolean(line);
  if (running) ok(`running  ${D}pid ${line.trim().split(/\s+/)[0]}${X}`);
} catch { /* ps unavailable — fall through to the state check below */ }

const stateFile = join(CFG.stateDir, 'state.json');
const everRan = existsSync(stateFile);
if (!running) {
  bad(everRan ? 'not running right now' : 'has never run on this machine',
      'start it with `npm run board` (or `npm run board:once` for a single pass). '
      + 'This is separate from `npm start`, which only produces transcripts.');
}

// ---- 5. queued work
console.log(`\n${D}Outbox  ${CFG.stateDir}${X}`);
const ob = join(CFG.stateDir, 'outbox.json');
if (!existsSync(ob)) {
  if (everRan) ok('empty (everything shipped)');
  else warn('no outbox yet — nothing has been extracted', 'run `npm run board:once`');
}
else {
  try {
    const j = JSON.parse(readFileSync(ob, 'utf8'));
    const n = Object.values(j).reduce((a, v) => a + Object.keys(v).length, 0);
    if (n) warn(`${n} row(s) waiting to ship`, 'run `npm run board:once` and read the flush line');
    else ok('empty (everything shipped)');
  } catch { warn('outbox unreadable'); }
}

console.log(failed ? `\n${R}${failed} problem(s) above.${X}\n` : `\n${G}All checks passed — this desk should appear on the board within a minute of the collector running.${X}\n`);
console.log(`${D}The collector is a separate process from the conductor:${X}`);
console.log(`${D}  npm start        the Oneshot loop — produces transcripts${X}`);
console.log(`${D}  npm run board    the collector    — ships them${X}\n`);
process.exit(failed ? 1 : 0);

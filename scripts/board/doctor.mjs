#!/usr/bin/env node
/**
 * `npm run board:doctor` — why is this desk not on the board?
 *
 * Answers the whole question in one pass: who this desk is, whether Oneshot has
 * produced anything to ship, whether the board is reachable and the token accepted,
 * and what is queued. Every check prints a verdict and, when it fails, the fix.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CFG } from './config.mjs';
import { resolveOperator } from './identity.mjs';
import { runDirs, readJournal } from './journal.mjs';

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
  bad(`ONESHOT_HOME does not exist: ${CFG.oneshotHome}`, 'set ONESHOT_HOME in .env to your oneshot checkout');
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

// ---- 3. is the board configured and reachable?
console.log(`\n${D}Board${X}`);
if (!CFG.boardUrl) bad('BOARD_URL is not set', 'add BOARD_URL=https://… to .env');
else if (!CFG.ingestToken) bad('BOARD_INGEST_TOKEN is not set', 'add it to .env — same value as on the deployment');
else {
  ok(`configured  ${CFG.boardUrl}`);
  try {
    const h = await fetch(`${CFG.boardUrl}/api/health`, { signal: AbortSignal.timeout(20_000) });
    const j = await h.json().catch(() => ({}));
    if (j.ok) ok('reachable and healthy', `${j.sessions} sessions on the board`);
    else bad(`board is up but unhealthy: ${j.error ?? h.status}`, 'the board owner needs to fix DATABASE_URL');
  } catch (e) { bad(`cannot reach ${CFG.boardUrl}: ${e.message}`, 'check the URL and your network/VPN'); }

  try {
    const r = await fetch(`${CFG.boardUrl}/api/ingest`, {
      method: 'POST', headers: { authorization: `Bearer ${CFG.ingestToken}`, 'content-type': 'application/json' },
      body: '{}', signal: AbortSignal.timeout(20_000),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) ok('token accepted');
    else bad(`token refused (HTTP ${r.status})${j.hint ? `: ${j.hint}` : ''}`,
             'copy BOARD_INGEST_TOKEN again — it is 64 characters, easy to truncate');
  } catch (e) { bad(`ingest unreachable: ${e.message}`); }
}

// ---- 4. queued work
console.log(`\n${D}Outbox  ${CFG.stateDir}${X}`);
const ob = join(CFG.stateDir, 'outbox.json');
if (!existsSync(ob)) ok('empty (nothing queued)');
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

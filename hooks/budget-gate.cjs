#!/usr/bin/env node
'use strict';
/**
 * SessionStart: refuse a phase whose quota is already spent.
 *
 * The conductor also checks before dispatching, but a phase can be queued
 * behind a long-running one and start after the ceiling was reached — so the
 * check is repeated at the door. Refusing here costs one process spawn;
 * discovering it after an Opus session has run costs the session.
 *
 * A single Oneshot ticket runs SIX Opus phases, which is materially heavier
 * per ticket than v1's per-loop sessions. Per-phase ceilings are what stop a
 * runaway `implement` cycling against findings it cannot satisfy from eating
 * the whole window before `qa` ever runs.
 *
 * Currently INERT: config/budgets.json sets enabled:false, so every token check
 * here is skipped and only the pause check runs. Before re-enabling, note that
 * the per-phase check below compares CUMULATIVE phase spend against the FLAT
 * cap, while src/lib/quota.ts scales the same cap by attempt (cap * (lap + 1)).
 * The two gates therefore disagree: the conductor admits a retry that this hook
 * then kills at SessionStart, so a phase whose lap 0 outspends its cap can never
 * retry. Fix that here — not by raising the cap — when the ceilings come back.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const C = require(path.join(__dirname, '_common.cjs'));

C.bailIfNotOneshot();

const DB = path.join(C.STATE, 'oneshot.db');

/**
 * Query via the sqlite3 CLI (ships with macOS) rather than better-sqlite3:
 * hooks must stay dependency-free so they work before `npm install` and
 * cannot be broken by a bad node_modules.
 */
function sum(where) {
  if (!fs.existsSync(DB)) return 0;
  const res = spawnSync('sqlite3', [
    DB, `SELECT COALESCE(SUM(weighted),0) FROM quota_usage WHERE ${where};`,
  ], { encoding: 'utf8', timeout: 5000 });
  if (res.status !== 0) return 0;
  return Number((res.stdout || '0').trim()) || 0;
}

function refuse(reason) {
  C.event('session_refused', { reason });
  // SessionStart cannot deny a tool; it injects context. Making the refusal
  // the first thing the model reads is the strongest available signal.
  C.emit({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext:
        `STOP. This session is refused before it starts: ${reason}. ` +
        'Do not begin the task. Do not call any tool. End your turn immediately ' +
        `with exactly: BLOCKED: quota — ${reason}`,
    },
  });
  process.exit(0);
}

try {
  const budgets = C.loadConfig('budgets.json');
  if (budgets) {
    if (C.pauseFile()) refuse('Oneshot is paused');

    // Everything past this point is a self-imposed TOKEN ceiling, and
    // budgets.enabled === false switches all of it off. The pause check above is
    // not a token ceiling, which is why it sits on the other side of the switch.
    if (budgets.enabled === false) process.exit(0);

    const windowMs = (budgets.window_hours || 5) * 3600 * 1000;
    const since = Date.now() - windowMs;

    const win = sum(`ts >= ${since}`);
    if (win >= budgets.window_tokens) {
      refuse(`rolling ${budgets.window_hours}h window ceiling reached (${win}/${budgets.window_tokens} weighted tokens)`);
    }

    const day = sum(`ts >= ${Date.now() - 86400000}`);
    if (day >= budgets.day_tokens) {
      refuse(`daily ceiling reached (${day}/${budgets.day_tokens} weighted tokens)`);
    }

    const run = C.runId();
    if (run) {
      const used = sum(`run_id = '${run.replace(/'/g, "''")}'`);
      if (used >= budgets.ticket_tokens) {
        refuse(`this ticket has spent its whole allowance (${used}/${budgets.ticket_tokens} weighted tokens)`);
      }

      // Scaled by the attempt about to run, exactly as src/lib/quota.ts does.
      //
      // The two gates MUST agree. A flat cap here against cumulative spend
      // while the conductor scales by lap is not a stricter policy, it is a
      // contradiction: the conductor admits the retry its own config promises,
      // and this hook then kills the session at SessionStart — so a phase whose
      // first attempt outspends its cap can never make a second one, and the
      // run dies with a message about ceilings rather than about whatever
      // actually went wrong. The number below is a PER-ATTEMPT allowance; the
      // count of attempts is bounded by maxLaps and maxRetries in
      // config/phases.json, and the whole-ticket total by ticket_tokens above.
      const ph = C.phase();
      const cap = (budgets.phases || {})[ph];
      if (cap !== undefined) {
        const lap = Number(process.env.ONESHOT_LAP || 0);
        const allowance = cap * ((Number.isFinite(lap) && lap >= 0 ? lap : 0) + 1);
        const phUsed = sum(`run_id = '${run.replace(/'/g, "''")}' AND phase = '${ph.replace(/'/g, "''")}'`);
        if (phUsed >= allowance) {
          refuse(
            `the '${ph}' phase has spent its allowance for attempt ${lap + 1} ` +
            `(${phUsed}/${allowance} weighted tokens)`,
          );
        }
      }
    }
  }
} catch (err) {
  C.logFailure('budget-gate', err);
}

process.exit(0);

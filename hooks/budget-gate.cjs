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

      const ph = C.phase();
      const cap = (budgets.phases || {})[ph];
      if (cap !== undefined) {
        const phUsed = sum(`run_id = '${run.replace(/'/g, "''")}' AND phase = '${ph.replace(/'/g, "''")}'`);
        if (phUsed >= cap) {
          refuse(`the '${ph}' phase has spent its allowance (${phUsed}/${cap} weighted tokens)`);
        }
      }
    }
  }
} catch (err) {
  C.logFailure('budget-gate', err);
}

process.exit(0);

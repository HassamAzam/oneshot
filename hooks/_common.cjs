'use strict';
/**
 * Shared helpers for Oneshot guardrail hooks.
 *
 * Dependency-free by design: node: builtins only. Hooks run as separate
 * processes on every tool call, so a broken hook must never crash a session
 * and must never require an install step to work.
 *
 * Contract invariants:
 *   - exit 0 with EMPTY stdout never blocks anything.
 *   - A PreToolUse deny is exit 0 + stdout JSON:
 *       {"hookSpecificOutput":{"hookEventName":"PreToolUse",
 *        "permissionDecision":"deny","permissionDecisionReason":"..."}}
 *   - Hooks are FAIL-OPEN on internal errors, but the failure is logged to
 *     state/hook-errors.log. A guard that crashes closed would wedge every
 *     session on this machine, including Hassam's own.
 *
 * The one deliberate exception to fail-open is deploy-guard, which fails
 * CLOSED — see docs/HOOKS.md 4.2.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = os.homedir();
const ONESHOT = process.env.ONESHOT_HOME || process.env.ONELOOP_HOME ||
  path.join(HOME, 'Documents', 'oneshot');
const STATE = path.join(ONESHOT, 'state');
const PAUSE = path.join(STATE, 'PAUSE');
const PAUSE_QUOTA = path.join(STATE, 'PAUSE-QUOTA');
const PAUSE_NETWORK = path.join(STATE, 'PAUSE-NETWORK');
const PAUSE_DEPLOY = path.join(STATE, 'PAUSE-DEPLOY');
const EVENTS_LOG = path.join(STATE, 'hook-events.jsonl');
const ERROR_LOG = path.join(STATE, 'hook-errors.log');

// ---------------------------------------------------------------- role gate

/**
 * Hooks are installed user-wide in ~/.claude/settings.json, so they fire in
 * EVERY Claude Code session on this machine. Bailing immediately when the
 * phase env var is absent is what keeps Hassam's own interactive sessions
 * untouched — they pay one process spawn and exit.
 */
function phase() { return process.env.ONESHOT_PHASE || ''; }
function runId() { return process.env.ONESHOT_RUN_ID || ''; }
function ticket() { return process.env.ONESHOT_TICKET || ''; }

function bailIfNotOneshot() {
  if (!phase()) process.exit(0);
}

// ------------------------------------------------------------------ plumbing

function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function logFailure(where, err) {
  try {
    fs.mkdirSync(STATE, { recursive: true });
    fs.appendFileSync(ERROR_LOG,
      `${new Date().toISOString()} ${where}: ${(err && err.stack) || err}\n`);
  } catch { /* logging must never throw */ }
}

function event(kind, detail) {
  try {
    fs.mkdirSync(STATE, { recursive: true });
    fs.appendFileSync(EVENTS_LOG, `${JSON.stringify({
      ts: Date.now(), kind, phase: phase(), run_id: runId(), ticket: ticket(), detail,
    })}\n`);
  } catch (err) { logFailure('event', err); }
}

/** Deny the tool call. The reason is read by the model — make it actionable. */
function deny(reason) {
  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
  process.exit(0);
}

/** Empty stdout on exit 0 = allow unchanged. */
function allow() { process.exit(0); }

// -------------------------------------------------------------------- pauses

const SIDE_EFFECT_PREFIXES = ['Write', 'Edit', 'NotebookEdit', 'Bash', 'mcp__'];

function isSideEffect(tool) {
  if (!tool) return false;
  return SIDE_EFFECT_PREFIXES.some((p) => tool.startsWith(p));
}

function pauseFile() {
  if (fs.existsSync(PAUSE)) return { file: 'PAUSE', human: true };
  if (fs.existsSync(PAUSE_QUOTA)) return { file: 'PAUSE-QUOTA', human: false };
  if (fs.existsSync(PAUSE_DEPLOY)) return { file: 'PAUSE-DEPLOY', human: false };
  return null;
}

/**
 * A supervisor killed mid-outage must not wedge every session's GitLab access
 * forever, so a network pause older than this is ignored by hooks. The
 * conductor re-stamps checked_at on every tick while the outage is live.
 */
const NETWORK_PAUSE_STALE_MS = 15 * 60 * 1000;

function networkPaused() {
  if (!fs.existsSync(PAUSE_NETWORK)) return false;
  try {
    const p = JSON.parse(fs.readFileSync(PAUSE_NETWORK, 'utf8'));
    const checked = Number(p.checked_at || 0);
    return Date.now() - checked < NETWORK_PAUSE_STALE_MS;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------- paths

/**
 * Resolve a path for scope comparison, following symlinks.
 *
 * This is the single most important line in the guard layer. Every worktree
 * gets .claude/ symlinked to the context repo so phases can use the real
 * skills — which means a plain string-prefix check would happily accept
 * <worktree>/.claude/skills/foo/SKILL.md as "inside the worktree" while the
 * write lands in ~/Documents/erp. A phase could edit the skills that govern
 * it. realpath closes that.
 *
 * The target may not exist yet (a new file), so walk up to the nearest
 * existing ancestor and resolve that, then re-join the remainder.
 */
function realish(p) {
  if (!p) return '';
  let abs = path.resolve(p);
  const tail = [];
  for (let i = 0; i < 64; i += 1) {
    if (fs.existsSync(abs)) {
      try {
        return path.join(fs.realpathSync(abs), ...tail.reverse());
      } catch {
        return path.join(abs, ...tail.reverse());
      }
    }
    const parent = path.dirname(abs);
    if (parent === abs) break;
    tail.push(path.basename(abs));
    abs = parent;
  }
  return path.resolve(p);
}

/** True when `child` is inside `parent` (both realpath-resolved first). */
function isInside(child, parent) {
  if (!child || !parent) return false;
  const c = realish(child);
  const p = realish(parent);
  if (c === p) return true;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

function expandTilde(p) {
  if (!p) return '';
  return p.startsWith('~') ? path.join(HOME, p.slice(1)) : p;
}

// ------------------------------------------------------------------- config

function loadConfig(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ONESHOT, 'config', name), 'utf8'));
  } catch (err) {
    logFailure(`loadConfig(${name})`, err);
    return null;
  }
}

/**
 * Read a key from the mode-600 .env directly.
 *
 * Session env is scrubbed (that is the point of src/lib/config.ts), so a hook
 * that needs a token cannot read it from process.env — it reads the file.
 */
function envFile(key) {
  try {
    const raw = fs.readFileSync(path.join(ONESHOT, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      if (t.slice(0, eq).trim() === key) return t.slice(eq + 1).trim();
    }
  } catch { /* no .env is a valid state */ }
  return '';
}

module.exports = {
  HOME, ONESHOT, STATE, PAUSE, PAUSE_QUOTA, PAUSE_NETWORK, PAUSE_DEPLOY,
  phase, runId, ticket, bailIfNotOneshot,
  readInput, emit, deny, allow, logFailure, event,
  isSideEffect, pauseFile, networkPaused,
  realish, isInside, expandTilde,
  loadConfig, envFile,
};

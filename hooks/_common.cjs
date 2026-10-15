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
 *   - A PostToolUse block is exit 0 + stdout JSON:
 *       {"decision":"block","reason":"..."}
 *     The call already happened; `reason` is fed back to the model.
 *   - Hooks are FAIL-OPEN on internal errors, but the failure is logged to
 *     state/hook-errors.log. A guard that crashes closed would wedge every
 *     session on this machine, including Hassam's own.
 *
 * Every guard here is fail-open. The exception that used to live here —
 * deploy-guard, which failed CLOSED — went with the deploy phase; the runner
 * keeps the mechanism for whatever guard next needs it (FAIL_CLOSED in
 * src/conductor/hooks.ts).
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

/**
 * Block a PostToolUse result: `reason` comes back to the model as the tool's
 * outcome, so it reacts while the edit is still what it is thinking about.
 *
 * A different event name means a different output shape, and a shape the SDK
 * does not recognise is indistinguishable from a guard that allowed — which is
 * why this lives next to deny() rather than in the one hook that needs it.
 */
function postBlock(reason) {
  emit({ decision: 'block', reason });
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

// --------------------------------------------------------------- local tests

/** The Oneshot checkout these hooks ship in, which a relative path in .env is relative to. */
const ROOT = path.resolve(__dirname, '..');

/**
 * The .env as a map, read the way scripts/localtests.cjs parseDotenv() reads it:
 * `export` prefixes, quoted values and trailing `# comments`. envFile() above is
 * an exact-key lookup and knows none of that, which is fine for the token it
 * was written for and not for a path a person may have quoted.
 */
function envFileMap() {
  const out = {};
  let raw = '';
  try { raw = fs.readFileSync(path.join(ONESHOT, '.env'), 'utf8'); } catch { return out; }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.replace(/^\s*export\s+/, '').trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let v = t.slice(eq + 1).trim();
    const q = v[0];
    if (q === '"' || q === "'") {
      const end = v.indexOf(q, 1);
      v = end > 0 ? v.slice(1, end) : v.slice(1);
    } else {
      v = v.replace(/\s+#.*$/, '').trim();
    }
    out[key] = v;
  }
  return out;
}

/**
 * src/lib/repourl.cjs, the one place the ONESHOT_/ONELOOP_ spelling and the
 * placeholder screen live, so a guard cannot read a desk's paths differently
 * from config.ts and scripts/localtests.cjs. Loaded lazily and only here: every
 * hook requires this file, and a failed require at load would take
 * pause-check down with it. The fallback keeps the same two rules.
 */
function readEnvFn() {
  try {
    return require(path.join(ROOT, 'src', 'lib', 'repourl.cjs')).readEnv;
  } catch (err) {
    logFailure('localTests(repourl)', err);
    const placeholder = (v) => /REPLACE_ME|<[a-z_/-]+>|CHANGE_?ME|your-.*-here/i.test(v)
      || /(^|\/)(their|your|my|some)\/path(\/|$)|(^|\/)path\/to(\/|$)/i.test(v);
    return (env, name, fallback = '') => {
      for (const key of [name, name.replace(/^ONESHOT_/, 'ONELOOP_')]) {
        const v = env[key];
        if (typeof v === 'string' && v !== '' && !placeholder(v)) return v;
      }
      return fallback;
    };
  }
}

let LOCAL_TESTS = null;

/**
 * The two per-desk paths the local-tests step owns and no session may touch:
 * the workstream-automation clone and the Cypress credentials file.
 *
 * Both are .env settings, read exactly as localTestsConfig() in
 * src/lib/config.ts and settingsFrom() in scripts/localtests.cjs read them:
 * .env under the process environment (an exported variable wins, as with
 * dotenv), ONESHOT_ before the legacy ONELOOP_ spelling, a blank or placeholder
 * value counted as unset, `~` expanded and a relative path taken from the
 * Oneshot checkout. The conductor spreads its own environment into every guard
 * it spawns, so process.env normally has them; the file is the fallback for a
 * guard whose environment is a session's whitelist. An empty `repo` means the
 * feature is off on this desk and there is no clone to protect. `creds` always
 * has a value, because a desk that never set ONESHOT_LOCAL_TESTS_CREDS keeps
 * the file at the default.
 *
 * `env` is for the parity test in src/conductor/hooks.test.ts; without it the
 * answer is read once per process.
 */
function localTests(env) {
  if (!env && LOCAL_TESTS) return LOCAL_TESTS;
  const e = env || { ...envFileMap(), ...process.env };
  const readEnv = readEnvFn();
  // repourl.cjs expandPath(): only `~` or `~/…` is the home directory.
  const abs = (p) => (p ? path.resolve(ROOT, String(p).replace(/^~(?=$|\/)/, os.homedir())) : '');
  const out = {
    repo: abs(readEnv(e, 'ONESHOT_LOCAL_TESTS_REPO')),
    creds: abs(readEnv(e, 'ONESHOT_LOCAL_TESTS_CREDS', '~/.config/oneshot/cypress-env.json')),
  };
  if (!env) LOCAL_TESTS = out;
  return out;
}

module.exports = {
  HOME, ONESHOT, STATE, PAUSE, PAUSE_QUOTA, PAUSE_NETWORK,
  phase, runId, ticket, bailIfNotOneshot,
  readInput, emit, deny, postBlock, allow, logFailure, event,
  isSideEffect, pauseFile, networkPaused,
  realish, isInside, expandTilde,
  loadConfig, envFile, envFileMap, localTests,
};

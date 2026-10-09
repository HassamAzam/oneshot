#!/usr/bin/env node
/**
 * localtests.cjs — the local automation (Cypress) run, as plain code.
 *
 * WHY THIS EXISTS
 * ---------------
 * `local-tests-run` is code, not a session: it copies the automation database, builds
 * the ticket's app, runs workstream-automation's specs against it and throws all of it
 * away again. Every step is a fact about this desk that a hand-run pilot on ERP #8800
 * (2026-10-09) proved one by one, and every step that went wrong in that pilot is here
 * as a named error rather than as something a caller has to recognise in a log:
 *
 *     createdb -T <baseline>           18 s for 5.4 GB; refused while anything is on it
 *     git worktree add (ERP, detached) seeded like scripts/app.cjs seed()
 *     local_settings.py -> the copy    checked by asking Django before anything migrates
 *     manage.py migrate                40 s, 9 dev migrations, the ssl/hashlib shim first
 *     harness.cjs up                   cold webpack ~10 min; 25 min budget here
 *     cypress run --spec ...           5 specs in 4.5 min; exit code = failures, not an error
 *     DROP DATABASE ... WITH (FORCE), worktree remove, prune — always
 *
 * CONTRACT
 * --------
 * stdout is exactly ONE JSON object. A non-zero exit means stdout is {code, message,
 * hint}; everything else is logged to stderr. A Cypress run whose tests fail is NOT an
 * error — `run` exits 0 with status 'failed'. Non-zero is for setup errors only.
 *
 *   prepare-scope --iid N [--automation-ref R]   -> {wsa, automationSha}
 *   capture --iid N                               -> {patchFile, patchSha, changedFiles, outsideAllowed,
 *                                                     weakened, addedSpecs, removedSpecs, ...}
 *   run --iid N --worktree W --ref SHA --specs-file F [--patch P] [--patch-sha S]
 *       [--automation-sha S] [--base REF] [--deadline-min M] [--until EPOCH_MS]
 *                                                 -> LocalTestsRun (+ notes)
 *   gc [--keep N,N] [--dry-run]                   -> {dropped, removed, killed}
 *   status                                        -> {dbs, worktrees, processes}
 *
 * WHAT IT WILL NOT TOUCH
 * ----------------------
 * The baseline database, any database not named <dbPrefix><iid>_<n>, the developer's
 * ERP checkout and automation clone working trees, and any port outside the configured
 * pair. Every resource is written to <runDir>/local-tests-resources.json BEFORE it is
 * created, so a run killed at any point can be cleaned up by the next run or by `gc`.
 * Credentials are read by code and written to a mode-600 file in the throwaway worktree;
 * no value is ever printed or logged. Everything this script spawns gets an environment
 * without the Oneshot .env's keys or anything named like a secret, and every credential
 * value is replaced by *** in whatever it prints.
 *
 * Configuration is read the way hooks/_common.cjs and scripts/app.cjs read it: the
 * Oneshot .env and config/project.json, with the process environment winning. The
 * `localTests` block is validated by settingsFrom(), a line-for-line mirror of
 * localTestsConfig() in src/lib/config.ts (src/lib/localtests-cli.test.ts holds the two
 * to each other).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const REPO = require(path.join(ROOT, 'src', 'lib', 'repourl.cjs'));
const HARNESS = path.join(ROOT, 'skills', 'local-browser-verify', 'scripts', 'harness.cjs');
const H = require(HARNESS);
/**
 * harness.cjs as a COMMAND (up / down). ONESHOT_LOCAL_TESTS_HARNESS swaps it for a fake,
 * for src/lib/localtests-cli.test.ts only: that is how `run` is driven end to end there
 * without a real app. The in-process helpers above (listenerPid, pidCwd, alive) never swap.
 */
const HARNESS_CLI = process.env.ONESHOT_LOCAL_TESTS_HARNESS || HARNESS;

/* ------------------------------------------------------------------ constants */

/** The four throwaway worktrees a run may own under state/runs/<iid>/. Nothing else is ever removed. */
const WT_NAMES = ['wsa', 'wsa-run', 'erp-lt', 'erp-base-lt'];
/** Harness run dirs (ONESHOT_RUN_DIR for harness.cjs) under state/runs/<iid>/. */
const HARNESS_NAMES = ['lt-harness', 'lt-harness-base'];
/** Same rule as localTestsConfig(): a name this file writes into SQL needs no quoting. */
const PG_IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;
/** GitLab's attachment limit; a bigger video is noted, not kept. */
const MAX_VIDEO_BYTES = 25 * 1024 * 1024;
/**
 * The base re-run is a comparison for a handful of failures, not a second suite run. The
 * same cap holds for the retry: more failures than this is the app, not a flaky test.
 */
const MAX_BASE_RERUN_SPECS = 10;
/** Cold webpack was ~10 min in the pilot; harness.cjs gives it 20, this waits up to 25 in all. */
const APP_BUDGET_MS = 25 * 60000;
/**
 * Against the conductor's absolute deadline (--until): what cleanup needs after the last
 * step, the shortest Cypress run worth starting, and a fresh copy plus a migrate at the
 * base (about 2 minutes in the pilot; budgeted generously). A base re-run is started only
 * with room for all of it plus a full app budget — overrunning would cost the ticket's
 * finished results, which the kill throws away with everything else.
 */
const CLEANUP_MARGIN_MS = 5 * 60000;
const MIN_CYPRESS_MS = 2 * 60000;
const BASE_SETUP_MS = 10 * 60000;
const BASE_RERUN_NEEDS_MS = BASE_SETUP_MS + APP_BUDGET_MS + MIN_CYPRESS_MS + CLEANUP_MARGIN_MS;
const SEED_EXCLUDES = ['venv', 'node_modules', 'staticfiles', 'hrdb/local_settings.py', 'frontend/src/constants/config.js'];
/**
 * The copy-app's own Celery broker: a Redis DB no worker reads. The seed's broker is the
 * dev app's queue, and a dev worker would run the copy's tasks against the dev database.
 * Not memory:// — settings.py hands the same URL to channels_redis.
 */
const LT_BROKER = 'redis://127.0.0.1:6379/15';

/** Names that are a secret wherever they come from. `PAT` only as a whole word: PATH is not one. */
const SECRET_NAME_RE = /TOKEN|SECRET|_KEY|PASSWORD|(^|_)PAT($|_)/i;
/** Credentials whose names do not say so. */
const CREDENTIAL_NAMES = new Set(['ONESHOT_TEST_LOGIN', 'ONELOOP_TEST_LOGIN']);
/** Never stripped from a child's environment, even when the Oneshot .env sets them. */
const KEEP_ENV_RE = /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|LANG|LC_[A-Z]+|TERM|TZ|ONESHOT_HOME)$/;
/** libpq's own variables: kept for the clients that reach the copy (psql, createdb, Django). */
const PG_ENV_RE = /^PG[A-Z]+$/;

const log = (...a) => console.error('[localtests]', ...a.map((x) => (typeof x === 'string' ? redact(x) : x)));
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, `${JSON.stringify(o, null, 2)}\n`); };
/**
 * realpath for a path that may not exist yet: the nearest existing ancestor resolved,
 * the rest re-joined (hooks/_common.cjs realish). A recorded worktree is often checked
 * before it is created, and on macOS /var is /private/var — a plain path.resolve would
 * put it "outside" a runs dir that does exist.
 */
function real(p) {
  let abs = path.resolve(p);
  const tail = [];
  for (let i = 0; i < 64; i += 1) {
    try { return path.join(fs.realpathSync(abs), ...tail.reverse()); } catch { /* not there yet */ }
    const parent = path.dirname(abs);
    if (parent === abs) break;
    tail.push(path.basename(abs));
    abs = parent;
  }
  return path.resolve(p);
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lastLines = (s, n) => String(s || '').trim().split('\n').slice(-n).join(' | ').slice(0, 600);
const firstLine = (s) => String(s || '').split('\n').map((l) => l.trim()).find(Boolean) || '';

/** Block without an event loop: cleanup must run from a signal handler too. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** True when `child` is `parent` or inside it, both realpath-resolved. */
function inside(child, parent) {
  if (!child || !parent) return false;
  const c = real(child);
  const p = real(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/** Copy by content, never copyFileSync: macOS provenance xattrs make that EPERM (see app.cjs). */
function copyContents(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, fs.readFileSync(src));
}

class LtError extends Error {
  constructor(code, message, hint) { super(message); this.code = code; this.hint = hint || null; }
  toJSON() { return { code: this.code, message: this.message, hint: this.hint }; }
}

/* ------------------------------------------------------------------ config */

/**
 * The Oneshot .env as a map, without touching process.env.
 *
 * Deliberately not loaded INTO the environment. That alone is not enough, though: the
 * conductor has already loaded it into ITS environment and passes that on, so every
 * child here gets childEnv() — process.env without the file's keys — instead.
 */
function parseDotenv(text) {
  const out = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const t = raw.replace(/^\s*export\s+/, '').trim();
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

let ENV = null;
let DOTENV = null;
/** The Oneshot .env alone, parsed once. */
function dotenvFile() {
  if (!DOTENV) {
    DOTENV = {};
    try { DOTENV = parseDotenv(fs.readFileSync(path.join(ROOT, '.env'), 'utf8')); } catch { /* no .env is a valid state */ }
  }
  return DOTENV;
}
/** .env under the process environment: an exported variable wins, as with dotenv `override: false`. */
function env() {
  if (!ENV) ENV = { ...dotenvFile(), ...process.env };
  return ENV;
}

/**
 * An environment for a child: `source` without the Oneshot .env's keys and without any
 * name that reads like a secret (GITLAB_TOKEN, SLACK_BOT_TOKEN, CLAUDE_CODE_OAUTH_TOKEN,
 * LANGFUSE_SECRET_KEY, …). Cypress runs the scope session's patch, and the harness and
 * Django run the ticket's code: none of them has any business with the conductor's
 * tokens, and a spec that printed one would put it in the ticket note. `keepPg` keeps
 * libpq's PG* variables for the clients that have to reach the copy.
 */
function scrubEnv(source, dotenvKeys, opts = {}) {
  const drop = new Set(dotenvKeys || []);
  const out = {};
  for (const [k, v] of Object.entries(source || {})) {
    if (v === undefined) continue;
    const pg = Boolean(opts.keepPg) && PG_ENV_RE.test(k);
    if (!pg && SECRET_NAME_RE.test(k)) continue;
    if (!pg && drop.has(k) && !KEEP_ENV_RE.test(k)) continue;
    out[k] = v;
  }
  return out;
}

function childEnv(extra = {}, opts = {}) {
  return { ...scrubEnv(process.env, Object.keys(dotenvFile()), opts), ...extra };
}

/**
 * Every value that must never be printed: the credentials file's strings, and the value
 * of every variable named like a secret (or a known credential), from the .env and the
 * environment both. Short or trivial values are left out — "1" or "true" is not a
 * secret, and replacing it would garble every message.
 */
function secretValuesFrom(envs, creds) {
  const vals = new Set();
  const add = (v) => {
    const s = String(v === undefined || v === null ? '' : v).trim();
    if (s.length >= 5 && !/^(\d+|true|false|null|yes|no|on|off)$/i.test(s)) vals.add(s);
  };
  for (const e of envs) {
    for (const [k, v] of Object.entries(e || {})) {
      if (!SECRET_NAME_RE.test(k) && !CREDENTIAL_NAMES.has(k)) continue;
      add(v);
      // email:password — the password alone must not survive either.
      if (CREDENTIAL_NAMES.has(k) && String(v).includes(':')) add(String(v).slice(String(v).indexOf(':') + 1));
    }
  }
  const walk = (v) => {
    if (typeof v === 'string' || typeof v === 'number') add(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (isObj(v)) Object.values(v).forEach(walk);
  };
  walk(creds);
  return [...vals].sort((a, b) => b.length - a.length);
}

/** `value` with every secret replaced by ***, strings inside objects and arrays included. */
function redactWith(secrets, value) {
  if (typeof value === 'string') {
    let s = value;
    for (const sec of secrets) if (s.includes(sec)) s = s.split(sec).join('***');
    return s;
  }
  if (Array.isArray(value)) return value.map((v) => redactWith(secrets, v));
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactWith(secrets, v)]));
  return value;
}

let SECRETS = null;
/** The desk's secrets, read once: the .env, the environment and the credentials file. */
function secrets() {
  if (!SECRETS) {
    SECRETS = [];
    let creds = null;
    try {
      const file = REPO.expandPath(REPO.readEnv(env(), 'ONESHOT_LOCAL_TESTS_CREDS', '~/.config/oneshot/cypress-env.json'), ROOT);
      creds = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { /* no file, or not JSON: writeCypressEnv names that */ }
    try { SECRETS = secretValuesFrom([dotenvFile(), process.env], creds); } catch { SECRETS = []; }
  }
  return SECRETS;
}

function redact(value) { return redactWith(secrets(), value); }

/** Where state/ lives: ONESHOT_HOME, else the dry-run home config.ts would use, else this checkout. */
function oneshotHome() {
  const explicit = process.env.ONESHOT_HOME || process.env.ONELOOP_HOME;
  if (explicit) return path.resolve(explicit);
  const dry = REPO.readEnv(env(), 'DRY_RUN').toLowerCase();
  return ['1', 'true', 'on', 'yes'].includes(dry) ? path.join(ROOT, 'state-dry') : ROOT;
}

function projectJson() {
  return readJson(path.join(ROOT, 'config', 'project.json'), {}) || {};
}

/**
 * config/project.json `localTests` merged with this desk's environment.
 *
 * A line-for-line mirror of localTestsConfig() in src/lib/config.ts, including every
 * message, so `off` reads the same from both and the parity test can compare them.
 * Never throws: anything unusable turns the step off and says which field to fix.
 */
function settingsFrom(project, e) {
  const block = project ? project.localTests : undefined;
  const p = isObj(block) ? block : {};
  // The mode's three labels live in project.json `labels`, beside the Loop's own;
  // mirrored here only so this reader and localTestsConfig() stay field for field.
  const names = project && isObj(project.labels) ? project.labels : {};
  const problems = [];
  const reject = (what, fallback) => { problems.push(what); return fallback; };
  const policy = (field) => ({ v: p[field], name: `localTests.${field}` });
  const merged = (envName, field) => {
    const v = REPO.readEnv(e, envName);
    return v ? { v, name: envName } : policy(field);
  };
  const ident = ({ v, name }) => (typeof v === 'string' && PG_IDENT_RE.test(v)
    ? v : reject(`${name} must be a lower-case Postgres name`, ''));
  const text = ({ v, name }, emptyOk = false) => (typeof v === 'string' && (emptyOk || v.trim() !== '')
    ? v.trim()
    : reject(`${name} must be ${emptyOk ? 'a string' : 'a non-empty string'}`, ''));
  const whole = ({ v, name }, max) => {
    const n = typeof v === 'string' ? Number(v) : v;
    return typeof n === 'number' && Number.isInteger(n) && n > 0 && (max === undefined || n <= max)
      ? n
      : reject(`${name} must be a whole number above 0${max === undefined ? '' : ` and at most ${max}`}`, 0);
  };

  const baselineDb = ident(merged('ONESHOT_LOCAL_TESTS_BASELINE_DB', 'baselineDb'));
  const dbPrefix = ident(policy('dbPrefix'));
  if (baselineDb && dbPrefix && baselineDb.startsWith(dbPrefix)) {
    reject('localTests.dbPrefix is the start of the baseline database name, so cleanup would match the baseline', null);
  }
  const allowed = p.allowedPaths;
  const allowedPaths = Array.isArray(allowed) && allowed.length > 0
    && allowed.every((a) => typeof a === 'string' && a.trim() !== '')
    ? allowed.map((a) => a.trim())
    : reject('localTests.allowedPaths must be a non-empty list of repo-relative paths', []);

  const out = {
    repo: REPO.expandPath(REPO.readEnv(e, 'ONESHOT_LOCAL_TESTS_REPO'), ROOT),
    credsFile: REPO.expandPath(REPO.readEnv(e, 'ONESHOT_LOCAL_TESTS_CREDS', '~/.config/oneshot/cypress-env.json'), ROOT),
    baselineDb,
    pg: {
      host: text(merged('ONESHOT_LOCAL_TESTS_PG_HOST', 'pgHost')),
      port: whole(merged('ONESHOT_LOCAL_TESTS_PG_PORT', 'pgPort'), 65535),
      user: text(merged('ONESHOT_LOCAL_TESTS_PG_USER', 'pgUser'), true),
    },
    dbPrefix,
    automationRef: text(policy('automationRef')),
    allowedPaths,
    maxSpecs: whole(policy('maxSpecs')),
    maxRunMinutes: whole(policy('maxRunMinutes')),
    devApproval: p.devApproval === 'any' || p.devApproval === 'all'
      ? p.devApproval
      : reject("localTests.devApproval must be 'any' or 'all'", 'any'),
    failuresBlock: typeof p.failuresBlock === 'boolean'
      ? p.failuresBlock
      : reject('localTests.failuresBlock must be true or false', false),
    labels: {
      trigger: text({ v: names.localTestsTrigger, name: 'labels.localTestsTrigger' }),
      running: text({ v: names.localTestsRunning, name: 'labels.localTestsRunning' }),
      done: text({ v: names.localTestsDone, name: 'labels.localTestsDone' }),
    },
  };

  let off = null;
  if (!isObj(block)) off = 'config/project.json has no `localTests` block';
  else if (p.enabled !== true) off = 'switched off in config/project.json (`localTests.enabled`)';
  else if (!out.repo) off = 'ONESHOT_LOCAL_TESTS_REPO is not set on this desk';
  else if (problems.length) off = `\`localTests\` is not usable: ${problems.join('; ')}`;
  return { enabled: off === null, off, ...out };
}

/**
 * Everything one command needs to know about this desk: the policy, the two ports, and
 * where the ERP clone and its seed are — resolved by repourl.cjs exactly as app.cjs does.
 */
function desk() {
  const e = env();
  const s = settingsFrom(projectJson(), e);
  const target = REPO.resolveTarget(e, ROOT);
  const workRepo = target.workRepo.path;
  const seed = REPO.resolvePath(e, {
    name: target.name, envName: 'ONESHOT_SEED_FROM', fallback: workRepo, root: ROOT,
  }).path;
  const port = (k, d) => {
    const v = REPO.readEnv(e, k);
    const n = v ? Number(v) : d;
    return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
  };
  return {
    ...s,
    workRepo,
    seed,
    ports: { be: port('ONESHOT_LOCAL_TESTS_PORT', 8030), fe: port('ONESHOT_LOCAL_TESTS_FE_PORT', 9030) },
  };
}

/** The Postgres role every client here uses: the configured one, else what libpq would pick. */
function pgUser(d) {
  if (d.pg.user) return d.pg.user;
  if (process.env.PGUSER) return process.env.PGUSER;
  try { return os.userInfo().username; } catch { return ''; }
}

function runsDir() { return path.join(oneshotHome(), 'state', 'runs'); }

function pathsOf(iid) {
  const run = path.join(runsDir(), String(iid));
  const art = path.join(run, 'artifacts', 'local-tests');
  return {
    run,
    wsa: path.join(run, 'wsa'),
    wsaRun: path.join(run, 'wsa-run'),
    erp: path.join(run, 'erp-lt'),
    erpBase: path.join(run, 'erp-base-lt'),
    harness: path.join(run, 'lt-harness'),
    harnessBase: path.join(run, 'lt-harness-base'),
    resources: path.join(run, 'local-tests-resources.json'),
    capture: path.join(run, 'local-tests-capture.json'),
    seq: path.join(run, 'local-tests-seq'),
    logs: path.join(run, 'logs'),
    art,
    patch: path.join(art, 'temporary-changes.patch'),
    videos: path.join(art, 'videos'),
  };
}

/* ------------------------------------------------------------------ pure helpers */

/** `<prefix><iid>_<seq>` — the only database name this script ever creates or drops. */
function dbName(prefix, iid, seq) { return `${prefix}${iid}_${seq}`; }

/**
 * Why `name` must not be created or dropped, or null when it is a run copy.
 *
 * Checked before every CREATE and every DROP, not just once: the name is written into
 * SQL, and the one database that must never be dropped — the baseline — differs from a
 * copy only by its name.
 */
function dbNameProblem(name, prefix, baseline) {
  if (typeof name !== 'string' || !PG_IDENT_RE.test(name)) return 'it is not a plain lower-case Postgres name';
  if (typeof prefix !== 'string' || !PG_IDENT_RE.test(prefix)) return 'there is no usable dbPrefix';
  if (name === baseline) return 'it is the baseline database';
  if (!name.startsWith(prefix)) return `it does not start with ${prefix}`;
  if (!new RegExp(`^${escapeRe(prefix)}\\d+_\\d+$`).test(name)) return `it is not ${prefix}<iid>_<n>`;
  return null;
}

/** {iid, seq} for a run copy's name, or null for anything else. */
function parseOurDb(name, prefix) {
  const m = new RegExp(`^${escapeRe(prefix)}(\\d+)_(\\d+)$`).exec(String(name));
  return m ? { iid: Number(m[1]), seq: Number(m[2]) } : null;
}

/** One past the highest sequence this iid has used — on the server or in the run dir's counter. */
function nextSeq(iid, names, prefix, counter = 0) {
  const used = names.map((n) => parseOurDb(n, prefix)).filter((x) => x && x.iid === Number(iid)).map((x) => x.seq);
  return Math.max(Number(counter) || 0, 0, ...used) + 1;
}

/**
 * Is `rel` under one of the allowed prefixes? A prefix names a directory, so
 * `cypress/e2e/` admits `cypress/e2e/a.ts` and not `cypress/e2e-old/a.ts`. Anything that
 * climbs out (`..`) or is absolute is never allowed.
 */
function isAllowedPath(rel, allowedPaths) {
  const r = String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!r || r.startsWith('/') || r.split('/').includes('..')) return false;
  return (allowedPaths || []).some((a) => {
    const p = String(a).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    return p !== '' && (r === p || r.startsWith(`${p}/`));
  });
}

/**
 * The files in a unified diff: path, and whether the diff creates or deletes it.
 * Read from the headers git writes, so a removed content line that happens to start
 * with `--` is never mistaken for one.
 */
function diffFiles(diff) {
  const files = [];
  let cur = null;
  let inHunk = false;
  for (const line of String(diff || '').split('\n')) {
    const head = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (head) {
      cur = { file: head[2], added: false, deleted: false };
      files.push(cur);
      inHunk = false;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('@@')) { inHunk = true; continue; }
    if (inHunk) continue;
    if (line.startsWith('new file mode')) cur.added = true;
    else if (line.startsWith('deleted file mode')) cur.deleted = true;
    else if (line.startsWith('+++ b/')) cur.file = line.slice(6);
    else if (line.startsWith('--- a/') && cur.deleted) cur.file = line.slice(6);
  }
  return files;
}

/** Spec files a patch creates: the tests that exist only for this run (`newTests`). */
function patchAddedFiles(diff) {
  return diffFiles(diff).filter((f) => f.added).map((f) => f.file);
}

/** A line with its comment taken out, so commenting a test out reads as removing it. */
function codeOf(line) {
  const t = line.trim();
  if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) return '';
  return line.replace(/\s\/\/.*$/, '');
}

const REMOVED_CHECKS = [
  ['an it( test case', /\bit\s*\(/g],
  ['a describe( block', /\bdescribe\s*\(/g],
  ['an expect( assertion', /\bexpect\s*\(/g],
  ['a .should( assertion', /\.should\s*\(/g],
  ['an assert', /\bassert\b/g],
];
/**
 * The last four do not make a test easier to pass; they reach outside the browser — a
 * shell, a Node task, the file system, the credentials — and a temporary change has no
 * need of any of them. They arm the same QA gate, so a person looks first.
 */
const ADDED_CHECKS = [
  ['.skip(', /\.skip\s*\(/g],
  ['.only(', /\.only\s*\(/g],
  ['force: true', /\bforce\s*:\s*true\b/g],
  ['cy.wait(', /\bcy\.wait\s*\(/g],
  ['cy.exec(', /\bcy\.exec\s*\(/g],
  ['cy.task(', /\bcy\.task\s*\(/g],
  ['cy.writeFile(', /\bcy\.writeFile\s*\(/g],
  ['Cypress.env(', /\bCypress\.env\s*\(/g],
];
const TIMEOUT_RE = /\btimeout['"]?\s*:\s*(\d[\d_]*)/g;
const LONG_TIMEOUT_MS = 10000;

const countIn = (lines, re) => lines.reduce((n, l) => n + (codeOf(l).match(re) || []).length, 0);
const timeoutsIn = (lines) => lines.flatMap((l) => [...codeOf(l).matchAll(TIMEOUT_RE)].map((m) => Number(m[1].replace(/_/g, ''))))
  .filter((n) => n >= LONG_TIMEOUT_MS).sort((a, b) => b - a);

/**
 * Where a temporary change makes an existing test easier to pass: [{file, why}].
 *
 * Counted per HUNK, removed against added, because the commonest legitimate edit — a
 * renamed testid on a `.should(` line — removes one assertion line and adds one back.
 * Only a net loss of it/describe/expect/should/assert, or a net gain of .skip/.only/
 * force: true/cy.wait/cy.exec/cy.task/cy.writeFile/Cypress.env/a timeout of 10 s or
 * more, is reported. A false positive costs QA a
 * look; a missed one is a regression the run was meant to catch, so the hunk is the
 * unit and not the file.
 */
function weakenedFindings(diff) {
  const findings = [];
  let file = null;
  let inHunk = false;
  let removed = [];
  let added = [];
  const flush = () => {
    if (!file || (!removed.length && !added.length)) { removed = []; added = []; return; }
    for (const [label, re] of REMOVED_CHECKS) {
      const lost = countIn(removed, re) - countIn(added, re);
      if (lost > 0) findings.push({ file, why: `removes ${lost === 1 ? label : `${lost} × ${label}`}` });
    }
    for (const [label, re] of ADDED_CHECKS) {
      const gained = countIn(added, re) - countIn(removed, re);
      if (gained > 0) findings.push({ file, why: `adds ${label}` });
    }
    const was = timeoutsIn(removed);
    const now = timeoutsIn(added);
    if (now.length > was.length || now.some((t, i) => t > (was[i] || 0))) {
      findings.push({ file, why: `raises a timeout to ${now[0]} ms` });
    }
    removed = [];
    added = [];
  };
  for (const line of String(diff || '').split('\n')) {
    const head = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (head) { flush(); file = head[2]; inHunk = false; continue; }
    if (line.startsWith('@@')) { flush(); inHunk = true; continue; }
    if (!inHunk) {
      if (line.startsWith('--- a/') && file === null) file = line.slice(6);
      continue;
    }
    if (line.startsWith('+')) added.push(line.slice(1));
    else if (line.startsWith('-')) removed.push(line.slice(1));
  }
  flush();
  return findings;
}

/**
 * Per-test rows from one mochawesome report (cypress-mochawesome-reporter's
 * cypress/results/.jsons/*.json): {spec, title, state, durationMs, error?}.
 *
 * `pending` is reported as skipped — the LocalTestsRun shape has no fourth state, and a
 * pending test asserted nothing either way. A failed hook is a row of its own: a
 * `before all` that dies is why the suite's tests never ran, and it must not vanish.
 */
function parseMochawesome(report) {
  const out = [];
  const seen = new Set();
  const norm = (f) => {
    const s = String(f || '').replace(/\\/g, '/').replace(/^\.\//, '');
    const at = s.indexOf('cypress/');
    return at > 0 && s.startsWith('/') ? s.slice(at) : s;
  };
  const row = (t, spec) => {
    if (!t || typeof t !== 'object') return;
    if (t.uuid) {
      if (seen.has(t.uuid)) return;
      seen.add(t.uuid);
    }
    const state = t.state === 'passed' || t.pass === true ? 'passed'
      : t.state === 'failed' || t.fail === true ? 'failed' : 'skipped';
    const r = { spec, title: String(t.fullTitle || t.title || '').trim(), state, durationMs: Number(t.duration) || 0 };
    if (state === 'failed') {
      const msg = isObj(t.err) ? (t.err.message || t.err.estack || '') : '';
      r.error = firstLine(msg).slice(0, 500) || 'failed without an error message';
    }
    out.push(r);
  };
  const walk = (suite, spec) => {
    if (!isObj(suite)) return;
    const here = spec || norm(suite.file || suite.fullFile);
    for (const t of Array.isArray(suite.tests) ? suite.tests : []) row(t, here);
    for (const hk of [...(suite.beforeHooks || []), ...(suite.afterHooks || [])]) {
      if (hk && (hk.state === 'failed' || hk.fail === true)) row(hk, here);
    }
    for (const s of Array.isArray(suite.suites) ? suite.suites : []) walk(s, here);
  };
  for (const root of Array.isArray(report && report.results) ? report.results : []) walk(root, '');
  return out;
}

/**
 * Every requested spec accounted for. A spec with no rows was either cut off by the
 * deadline (skipped, and the run says so) or never reported at all — a spec that does
 * not compile, or a renderer that crashed — which is a failure, never a silent pass.
 */
function assembleResults(specs, rows, opts = {}) {
  const bySpec = new Map();
  for (const r of rows) {
    if (!bySpec.has(r.spec)) bySpec.set(r.spec, []);
    bySpec.get(r.spec).push(r);
  }
  const out = [];
  for (const spec of specs) {
    const got = bySpec.get(spec) || [];
    bySpec.delete(spec);
    if (got.length) out.push(...got);
    else if (opts.deadlineHit) {
      out.push({ spec, title: '(not finished)', state: 'skipped', durationMs: 0,
        error: `not finished: Cypress was stopped at the ${opts.deadlineMin}-minute deadline` });
    } else {
      out.push({ spec, title: '(no results recorded)', state: 'failed', durationMs: 0,
        error: 'Cypress recorded no results for this spec: it failed to load or crashed before reporting' });
    }
  }
  for (const extra of bySpec.values()) out.push(...extra);
  return out;
}

/**
 * failingOnDev for every failed row, from the base re-run: the same test failing there
 * too is true, passing there is false, and anything the base run did not settle stays
 * null. Matched on spec + title first, then on the spec as a whole.
 */
function applyBaseResults(results, baseRows) {
  for (const r of results) {
    if (r.state !== 'failed') continue;
    const same = baseRows.find((b) => b.spec === r.spec && b.title === r.title);
    if (same) {
      r.failingOnDev = same.state === 'failed' ? true : same.state === 'passed' ? false : null;
      continue;
    }
    const spec = baseRows.filter((b) => b.spec === r.spec);
    if (!spec.length) r.failingOnDev = null;
    else if (spec.some((b) => b.state === 'failed')) r.failingOnDev = true;
    else if (spec.every((b) => b.state === 'passed')) r.failingOnDev = false;
    else r.failingOnDev = null;
  }
  return results;
}

/**
 * Retry before blame: the failed rows, against one more run of their specs on the
 * ticket's own app. A test that passes there is flaky — `passed`, `flaky: true`, its
 * first error kept only in the returned note — and only what fails twice is left for the
 * base re-run to judge. Matched on spec + title; a row with no such match (a hook that
 * died, a spec that never reported) is flaky only when its whole spec passed on the
 * retry. Returns one note per flaky row.
 */
function applyRetryResults(results, retryRows) {
  const notes = [];
  for (const r of results) {
    if (r.state !== 'failed') continue;
    const spec = retryRows.filter((b) => b.spec === r.spec);
    const same = spec.find((b) => b.title === r.title);
    const passed = same ? same.state === 'passed'
      : spec.length > 0 && spec.every((b) => b.state !== 'failed') && spec.some((b) => b.state === 'passed');
    if (!passed) continue;
    const first = firstLine(r.error).slice(0, 160);
    r.state = 'passed';
    r.flaky = true;
    delete r.error;
    delete r.failingOnDev;
    notes.push(`flaky: ${r.spec} › ${r.title} failed on the first run${first ? ` (${first})` : ''} and passed on the retry on the ticket's code, so it is not counted as a failure`);
  }
  return notes;
}

/** What ran, as one hash: the same five inputs give the same key, so a repeat is recognisable. */
function cacheKey({ ticketSha, automationSha, patchSha, specs, baseline }) {
  return sha256(JSON.stringify({
    ticketSha: String(ticketSha || ''),
    automationSha: String(automationSha || ''),
    patchSha: patchSha || null,
    specs: [...new Set(specs || [])].sort(),
    baseline: String(baseline || ''),
  }));
}

/** The committed cypress.env.json with the desk's credentials over it — credentials win. */
function mergeEnv(committed, creds) {
  return { ...(isObj(committed) ? committed : {}), ...(isObj(creds) ? creds : {}) };
}

const DATABASES_RE = /^DATABASES\s*=\s*\{[\s\S]*?^\}[ \t]*$/m;

/**
 * The seed's local_settings.py with its DATABASES block pointed at the run's copy.
 *
 * Exactly one block or nothing: a file this does not understand is refused, not guessed
 * at, because the alternative is a Django that migrates whatever the seed points to.
 * The seed's password goes with the block — the copy is reached as the desk's own role.
 * EXPOSE_E2E_API and EXPIRE_TOKEN are appended as the automation server sets them; that
 * is safe ONLY because the database is a throwaway copy.
 *
 * DATABASES is not the only thing that reaches the dev app's data. The seed's Celery
 * broker is the dev app's queue — a dev worker would run the copy-app's tasks against
 * the dev database — so the copy gets its own (LT_BROKER). And settings.py derives the
 * memcached KEY_PREFIX from DATABASE_NAME, so that is set to the copy's name too.
 * assertDbGuard() asks Django for all three before anything runs.
 */
function rewriteLocalSettings(src, db) {
  const hits = String(src).match(new RegExp(DATABASES_RE.source, 'gm')) || [];
  if (hits.length !== 1) {
    throw new LtError('E_LOCAL_SETTINGS',
      `the seed's hrdb/local_settings.py has ${hits.length} DATABASES blocks, expected exactly 1`,
      'Its shape changed; the run will not guess which database Django would use.');
  }
  for (const m of String(src).matchAll(/^CELERY_BROKER_URL\s*=\s*['"]([^'"]*)['"]/gm)) {
    if (/^redis:\/\/(localhost|127\.0\.0\.1)(:6379)?\/15\/?$/.test(m[1].trim())) {
      throw new LtError('E_LOCAL_SETTINGS',
        `the seed's Celery broker is already ${LT_BROKER}, the Redis DB local tests keep for themselves`,
        'Point the seed at another Redis DB; the copy-app must not share a queue with it.');
    }
  }
  const check = (v, re, what) => {
    if (!re.test(String(v))) throw new LtError('E_LOCAL_SETTINGS', `${what} ${JSON.stringify(String(v))} cannot be written into local_settings.py`);
    return String(v);
  };
  const name = check(db.name, PG_IDENT_RE, 'database name');
  const host = check(db.host, /^[A-Za-z0-9_.:/-]+$/, 'host');
  const port = check(db.port, /^\d{1,5}$/, 'port');
  const user = check(db.user || '', /^[A-Za-z0-9_.@-]*$/, 'user');
  const engine = (/['"]ENGINE['"]\s*:\s*['"]([A-Za-z0-9_.]+)['"]/.exec(hits[0]) || [])[1] || 'django.db.backends.postgresql';
  const block = [
    'DATABASES = {',
    "    'default': {",
    `        'ENGINE': '${engine}',`,
    `        'NAME': '${name}',`,
    `        'USER': '${user}',`,
    "        'PASSWORD': '',",
    `        'HOST': '${host}',`,
    `        'PORT': '${port}',`,
    '    }',
    '}',
  ].join('\n');
  const body = String(src).replace(DATABASES_RE, block).replace(/\s*$/, '\n');
  return `${body}\n# Oneshot local tests: this checkout runs against a throwaway copy (${name}).\n`
    + `DATABASE_NAME = '${name}'\n`
    + `CELERY_BROKER_URL = '${LT_BROKER}'\n`
    + 'EXPOSE_E2E_API = True\nEXPIRE_TOKEN = False\n';
}

/**
 * Why what Django reported must stop the run, or null. The database must be the copy,
 * Celery must use the run's own broker, and the cache must be keyed by the copy — any of
 * the three left at the seed's value reaches the dev app's data.
 */
function guardProblem(got, expected) {
  if (!got) return 'settings did not load';
  if (got.name !== expected) return `Django would use database ${JSON.stringify(got.name)}, not the run copy ${expected}`;
  if (got.broker !== LT_BROKER) return `Celery would use ${got.broker ? "the seed's broker" : 'no broker setting'}, not the run's own ${LT_BROKER}`;
  if (got.keyPrefix !== expected) return `the cache KEY_PREFIX is ${JSON.stringify(got.keyPrefix)}, not the copy's name ${expected}, so the run would share the dev app's cache`;
  return null;
}

/** Dependency names in package.json that `has(name)` says are not installed. */
function missingDeps(pkg, has) {
  const names = new Set([
    ...Object.keys(isObj(pkg && pkg.dependencies) ? pkg.dependencies : {}),
    ...Object.keys(isObj(pkg && pkg.devDependencies) ? pkg.devDependencies : {}),
  ]);
  return [...names].filter((n) => !has(n)).sort();
}

/** [major, minor, patch] of a version, prerelease and build ignored; null when it is not one. */
function parseVersion(v) {
  const m = /^\s*=?v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?\s*$/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const cmpVersion = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);

/**
 * Does `version` satisfy `range`? true / false, or null for a range this does not read.
 *
 * Only the shapes package.json files here use: exact (`1.2.3`, `=1.2.3`, `v1.2.3`),
 * caret, tilde, x-ranges (`1`, `1.x`, `1.2.*`, `*`, ``) and `||` between them. Anything
 * else — comparators, hyphen ranges, tags, `npm:`, `file:`, git or URL specs — is null,
 * and the caller falls back to checking the package is there at all. Prereleases count
 * as their release: a false "drift" stops a run, a lenient match only lets it try.
 */
function semverSatisfies(version, range) {
  const have = parseVersion(version);
  if (!have) return null;
  const parts = String(range === undefined || range === null ? '' : range).split('||').map((s) => s.trim());
  let unknown = false;
  for (const part of parts) {
    const ok = satisfiesOne(have, part);
    if (ok === true) return true;
    if (ok === null) unknown = true;
  }
  return unknown ? null : false;
}

function satisfiesOne(have, range) {
  if (range === '' || range === '*' || /^[xX]$/.test(range)) return true;
  const m = /^(\^|~|=|v)?\s*(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:[-+][0-9A-Za-z.-]+)?$/.exec(range);
  if (!m) return null;
  const op = m[1] === '=' || m[1] === 'v' ? '' : (m[1] || '');
  const num = (s) => (s === undefined || /^[xX*]$/.test(s) ? null : Number(s));
  const [maj, min, pat] = [Number(m[2]), num(m[3]), num(m[4])];
  if (m[3] !== undefined && min === null && pat !== null) return null; // 1.x.3 is not a range anyone writes
  const lo = [maj, min || 0, pat || 0];
  let hi;
  if (op === '^') {
    if (maj > 0 || min === null) hi = [maj + 1, 0, 0];
    else if (min > 0 || pat === null) hi = [0, min + 1, 0];
    else hi = [0, 0, pat + 1];
  } else if (op === '~') {
    hi = min === null ? [maj + 1, 0, 0] : [maj, min + 1, 0];
  } else if (min === null) {
    hi = [maj + 1, 0, 0];
  } else if (pat === null) {
    hi = [maj, min + 1, 0];
  } else {
    return cmpVersion(have, lo) === 0;
  }
  return cmpVersion(have, lo) >= 0 && cmpVersion(have, hi) < 0;
}

/**
 * package.json against an installed node_modules: names not installed at all, and names
 * installed at a version the declared range does not admit. `installed(name)` is the
 * installed package.json's `version`, '' when it has none, or null when it is missing.
 */
function depDrift(pkg, installed) {
  const declared = {
    ...(isObj(pkg && pkg.devDependencies) ? pkg.devDependencies : {}),
    ...(isObj(pkg && pkg.dependencies) ? pkg.dependencies : {}),
  };
  const missing = [];
  const mismatched = [];
  for (const name of Object.keys(declared).sort()) {
    const have = installed(name);
    if (have === null || have === undefined) { missing.push(name); continue; }
    if (semverSatisfies(have, declared[name]) === false) mismatched.push({ name, want: String(declared[name]), have: String(have) });
  }
  return { missing, mismatched };
}

/** What depDrift found, as one line, or null when there is nothing. */
function driftText({ missing, mismatched }, where) {
  if (!missing.length && !mismatched.length) return null;
  const parts = [];
  if (missing.length) parts.push(`${missing.length} not installed (${missing.slice(0, 15).join(', ')}${missing.length > 15 ? ', …' : ''})`);
  if (mismatched.length) {
    parts.push(`${mismatched.length} at a version the ref does not accept (${mismatched.slice(0, 10)
      .map((x) => `${x.name} ${x.have}, wants ${x.want}`).join('; ')}${mismatched.length > 10 ? '; …' : ''})`);
  }
  return `${where}: ${parts.join('; ')}`;
}

/** The installed version of `name` under `nm`: its `version`, '' when unreadable, null when absent. */
function installedVersion(nm, name) {
  const f = path.join(nm, name, 'package.json');
  if (!fs.existsSync(f)) return null;
  const pkg = readJson(f);
  return pkg && typeof pkg.version === 'string' ? pkg.version : '';
}

/**
 * A spec path as a literal for `cypress run --spec`, which reads globs: 21 of the
 * automation repo's specs have `(s)` or `(team lead)` in their names and match nothing
 * raw. fast-glob's own escapePath rule (posix), so what Cypress resolves is the file.
 * Only the argument is escaped — mochawesome reports, and videos are named by, the path.
 */
function globEscape(spec) {
  return String(spec).replace(/(\\?)([()*?[\]{|}]|^!|[!+@](?=\()|\\(?![!()*+?@[\]{|}]))/g, '\\$2');
}

/** A spec path the run may hand Cypress, or null: under cypress/e2e/, relative, no comma. */
function specProblem(spec) {
  if (typeof spec !== 'string' || !spec.trim()) return 'is not a path';
  const s = spec.trim();
  if (s.startsWith('/') || s.split('/').includes('..')) return 'is not a path inside the automation repo';
  if (!s.startsWith('cypress/e2e/')) return 'is not under cypress/e2e/';
  if (/[,\0\n]/.test(s)) return 'contains a comma or a control character, which --spec cannot carry';
  return null;
}

/**
 * The specs to run, from a JSON file: what the conductor writes, `{specs: string[],
 * notRunnable: [{spec, why}]}`; a bare list of paths or of {file}; or a
 * LocalTestsScope-shaped object. `notRunnable` specs are reported and not run, even when
 * `specs` names them too. Order kept, duplicates dropped.
 */
function parseSpecs(data) {
  const list = Array.isArray(data) ? data : isObj(data) && Array.isArray(data.specs) ? data.specs : null;
  if (!list) throw new LtError('E_SPECS', 'the specs file is neither a list nor an object with `specs`');
  const seen = new Set();
  const notRunnable = (isObj(data) && Array.isArray(data.notRunnable) ? data.notRunnable : [])
    .filter((n) => isObj(n) && typeof n.spec === 'string' && n.spec.trim() && !seen.has(n.spec.trim()) && seen.add(n.spec.trim()))
    .map((n) => ({
      spec: n.spec.trim(),
      why: (typeof n.why === 'string' && n.why.trim() ? n.why.trim() : 'needs something a local machine does not have').slice(0, 300),
    }));
  const skip = new Set(notRunnable.map((n) => n.spec));
  const specs = [];
  for (const item of list) {
    const spec = typeof item === 'string' ? item : isObj(item) ? (item.file || item.spec) : null;
    const problem = specProblem(spec);
    if (problem) throw new LtError('E_SPECS', `spec ${JSON.stringify(spec)} ${problem}`);
    const s = spec.trim();
    if (!skip.has(s) && !specs.includes(s)) specs.push(s);
  }
  return { specs, notRunnable };
}

/** `git status --porcelain=v1 -z --no-renames` -> {added, removed} paths. */
function statusSpecs(porcelainZ) {
  const added = [];
  const removed = [];
  for (const entry of String(porcelainZ || '').split('\0')) {
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const file = entry.slice(3);
    if (xy === '??' || xy.includes('A')) added.push(file);
    else if (xy.includes('D')) removed.push(file);
  }
  return { added: added.sort(), removed: removed.sort() };
}

/* ------------------------------------------------------------------ shell */

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, timeout: opts.timeout || 120000, ...opts });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || ''), error: r.error || null };
}

const gitEnv = () => ({ ...process.env, HUSKY: '0', GIT_TERMINAL_PROMPT: '0' });

/** git in `cwd`. A soft failure is null, never '' — empty output is a real answer. */
function git(args, cwd, soft = false, raw = false) {
  const r = sh('git', ['-c', 'core.quotePath=false', ...args], { cwd, env: gitEnv() });
  if (r.code !== 0) {
    if (soft) return null;
    throw new LtError('E_GIT', `git ${args.join(' ')} failed${cwd ? ` in ${cwd}` : ''}`, lastLines(r.err, 2));
  }
  return raw ? r.out : r.out.trim();
}

/**
 * git against a repository by its git dir, with hooks off: `worktree add` runs
 * post-checkout, and both repos carry husky. Run from the temp dir so nothing is
 * discovered from wherever the caller happens to stand.
 */
function gitAt(gitDir, args, soft = false) {
  return git(['--git-dir', gitDir, '-c', 'core.hooksPath=/dev/null', ...args], os.tmpdir(), soft);
}

/** The common git dir `dir` belongs to, real-pathed; null when it is not a checkout. */
function commonDirOf(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const out = git(['rev-parse', '--git-common-dir'], dir, true);
  return out ? real(path.resolve(dir, out)) : null;
}

/**
 * A ref as a full sha. A bare branch name is tried as `origin/<name>` first: the
 * developer's local `dev` may be weeks behind, and a base re-run against it would
 * blame — or clear — the ticket for somebody else's change.
 */
function resolveSha(gitDir, ref) {
  if (typeof ref !== 'string' || !ref) return null;
  const bare = !/^[0-9a-f]{7,40}$/.test(ref) && !ref.startsWith('origin/') && !ref.startsWith('refs/');
  for (const cand of bare ? [`origin/${ref}`, ref] : [ref]) {
    const sha = gitAt(gitDir, ['rev-parse', '--verify', '--quiet', `${cand}^{commit}`], true);
    if (sha) return sha;
  }
  return null;
}

/** Kill a process group (a detached child's pid is its pgid), falling back to the pid. */
function killGroup(pid, sig) {
  if (!pid) return false;
  try { process.kill(-pid, sig); return true; } catch {
    try { process.kill(pid, sig); return true; } catch { return false; }
  }
}

/**
 * Alive and not a zombie. Cleanup runs synchronously — from a signal handler, too — so
 * the event loop cannot reap a child that has already exited, and `kill(pid, 0)` keeps
 * answering yes for it: every stop then sat out its whole grace period.
 */
function running(pid) {
  if (!pid || !H.alive(pid)) return false;
  return !sh('ps', ['-o', 'stat=', '-p', String(pid)], { timeout: 5000 }).out.trim().startsWith('Z');
}

/** SIGTERM, a grace period, SIGKILL for what is left. Synchronous, for cleanup. */
function stopPids(pids, graceMs = 8000) {
  const live = pids.filter((p) => running(p));
  for (const p of live) killGroup(p, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && live.some((p) => running(p))) sleepSync(200);
  for (const p of live.filter((x) => running(x))) killGroup(p, 'SIGKILL');
  return live;
}

const ps = (pid) => sh('ps', ['-o', 'command=', '-p', String(pid)], { timeout: 5000 }).out.trim();

/** In-flight async children, so a signal can stop them before cleanup runs. */
const CHILDREN = new Set();

/**
 * Spawn and wait, without blocking the event loop — a SIGTERM during a 25-minute
 * webpack build must be handled now, not when spawnSync would have returned.
 */
function runAsync(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let fd = null;
    if (opts.logFile) {
      fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
      fd = fs.openSync(opts.logFile, 'w'); // one log per step per run: a tail never shows an earlier run
    }
    let out = '';
    let err = '';
    let done = false;
    let timedOut = false;
    const child = spawn(cmd, args, {
      cwd: opts.cwd, env: opts.env || childEnv(), detached: Boolean(opts.detached),
      stdio: fd !== null ? ['ignore', fd, fd] : ['ignore', 'pipe', 'pipe'],
    });
    CHILDREN.add(child);
    if (opts.onSpawn && child.pid) opts.onSpawn(child.pid);
    if (child.stdout) child.stdout.on('data', (b) => { out += b; });
    if (child.stderr) {
      child.stderr.on('data', (b) => {
        err += b;
        if (opts.echo) process.stderr.write(redact(String(b)));
      });
    }
    const timer = opts.timeoutMs ? setTimeout(() => {
      timedOut = true;
      if (opts.detached) killGroup(child.pid, 'SIGTERM'); else child.kill('SIGTERM');
      setTimeout(() => { if (!done) { if (opts.detached) killGroup(child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } }, 15000).unref();
    }, opts.timeoutMs) : null;
    const finish = (code, signal, extra) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      CHILDREN.delete(child);
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
      resolve({ code, signal, out, err: extra ? `${err}${extra}` : err, timedOut, pid: child.pid });
    };
    child.on('error', (e) => finish(null, null, String(e && e.message)));
    child.on('close', (code, signal) => finish(code, signal));
  });
}

/* ------------------------------------------------------------------ resources */

/**
 * What a run holds, written to disk BEFORE each thing is taken.
 *
 * The order is the whole point: a database recorded and then created can always be
 * dropped; one created and then recorded is lost if the process dies in between. The
 * file is deleted last, and only once every resource in it is gone, so whatever a
 * crashed run left is still named for the next run or `gc` to find.
 */
class Resources {
  constructor(file, base) {
    this.file = file;
    this.data = { worktrees: [], harnessDirs: [], cypressPgids: [], db: null, baseDb: null, ...base };
    this.save();
  }

  save() { writeJson(this.file, this.data); }

  set(key, value) { this.data[key] = value; this.save(); }

  push(key, value) {
    if (!this.data[key].some((x) => JSON.stringify(x) === JSON.stringify(value))) this.data[key].push(value);
    this.save();
  }
}

/** True when `p` is one of the throwaway worktree paths under state/runs/<iid>/. */
function isOurWorktreePath(p) {
  const rel = path.relative(real(runsDir()), real(p));
  const parts = rel.split(path.sep);
  return !rel.startsWith('..') && !path.isAbsolute(rel) && parts.length === 2
    && /^\d+$/.test(parts[0]) && WT_NAMES.includes(parts[1]);
}

/** A directory whose .git FILE points at a worktrees/ admin dir: a worktree, live or stale. */
function looksLikeWorktree(dir) {
  try {
    const g = path.join(dir, '.git');
    return fs.lstatSync(g).isFile() && /^gitdir: .*[/\\]worktrees[/\\]/m.test(fs.readFileSync(g, 'utf8'));
  } catch { return false; }
}

/**
 * Remove one of OUR throwaway worktrees: `git worktree remove --force`, then prune.
 *
 * Refuses any path that is not state/runs/<iid>/{wsa,wsa-run,erp-lt,erp-base-lt}. A
 * stale one git no longer knows (its admin dir pruned) is deleted by hand only when its
 * .git file proves it was a worktree; neither path follows the venv / node_modules
 * symlinks into the seed. The credentials file goes first, so it never outlives a
 * failed removal.
 */
function removeWorktree(wt, gitDir) {
  if (!isOurWorktreePath(wt)) throw new LtError('E_NOT_OURS', `${wt} is not a local-tests worktree; refusing to remove it`);
  const exists = fs.existsSync(wt);
  if (exists) fs.rmSync(path.join(wt, 'cypress.env.json'), { force: true });
  const gd = gitDir || (exists ? commonDirOf(wt) : null);
  if (exists && gd && gitAt(gd, ['worktree', 'remove', '--force', '--force', wt], true) !== null) {
    gitAt(gd, ['worktree', 'prune'], true);
    return true;
  }
  if (exists && looksLikeWorktree(wt)) {
    fs.rmSync(wt, { recursive: true, force: true });
  }
  if (gd) gitAt(gd, ['worktree', 'prune'], true);
  return !fs.existsSync(wt);
}

/**
 * Stop a harness instance by its servers.json — only processes whose cwd is inside
 * `roots` (our throwaway checkouts), so a recycled pid is never someone else's server.
 * `harness.cjs down` does the stopping when every live pid checks out; otherwise the
 * checked ones are stopped here and the rest left alone.
 */
function stopHarness(dir, roots) {
  const f = path.join(dir, 'harness', 'servers.json');
  const s = readJson(f);
  if (!s) return [];
  const live = [['webpack', s.webpackPid], ['django', s.djangoPid]].filter(([, pid]) => running(pid));
  const ours = live.filter(([, pid]) => {
    const cwd = H.pidCwd(pid);
    return cwd && roots.some((r) => inside(cwd, r));
  });
  if (live.length && ours.length === live.length) {
    sh(process.execPath, [HARNESS_CLI, 'down'], { env: childEnv({ ONESHOT_RUN_DIR: dir }), timeout: 30000 });
  }
  stopPids(ours.map(([, pid]) => pid));
  fs.rmSync(f, { force: true });
  return ours.map(([name, pid]) => ({ name, pid }));
}

/** Anything still listening on our two ports from inside our checkouts — SIGKILL. */
function killPortStragglers(ports, roots) {
  const killed = [];
  for (const port of [ports.be, ports.fe].filter(Boolean)) {
    const pid = H.listenerPid(port);
    if (!pid) continue;
    const cwd = H.pidCwd(pid);
    if (cwd && roots.some((r) => inside(cwd, r))) {
      killGroup(pid, 'SIGKILL');
      killed.push({ port, pid });
    }
  }
  return killed;
}

function psqlRaw(d, sql, timeout = 60000) {
  const args = ['-h', d.pg.host, '-p', String(d.pg.port), ...(pgUser(d) ? ['-U', pgUser(d)] : []),
    '-d', 'postgres', '-XAtqw', '-v', 'ON_ERROR_STOP=1', '-c', sql];
  return sh('psql', args, { timeout, env: childEnv({ PGCONNECT_TIMEOUT: '10' }, { keepPg: true }) });
}

function psql(d, sql, timeout) {
  const r = psqlRaw(d, sql, timeout);
  if (r.error && r.error.code === 'ENOENT') throw new LtError('E_PG', 'psql is not on PATH', 'brew install libpq (or postgresql) and put its bin on PATH');
  if (r.code !== 0) {
    throw new LtError('E_PG', `psql failed on ${d.pg.host}:${d.pg.port}: ${firstLine(r.err) || 'no answer'}`,
      'Is the desk\'s Postgres running, and is ONESHOT_LOCAL_TESTS_PG_* right?');
  }
  return r.out.trim();
}

/** Run copies on the server, by name. Both names are checked identifiers, safe as literals. */
function listOurDbs(d) {
  const rows = psql(d, `SELECT datname FROM pg_database WHERE left(datname, ${d.dbPrefix.length}) = '${d.dbPrefix}' ORDER BY 1`);
  return (rows ? rows.split('\n') : []).filter((n) => parseOurDb(n, d.dbPrefix) && !dbNameProblem(n, d.dbPrefix, d.baselineDb));
}

/** Sessions on `name`, by its checked name; NaN when the server did not say. */
function sessionsOn(d, name) {
  const r = psqlRaw(d, `SELECT count(*) FROM pg_stat_activity WHERE datname = '${name}'`);
  return r.code === 0 ? Number(r.out.trim()) : NaN;
}

/**
 * End a `createdb` of `name` that is still running on the server. createdb runs as
 * application_name = the copy's name (PGAPPNAME), so its backend is findable: killing the
 * client does not stop it (Postgres 14 does not notice a dropped client mid-copy), and
 * until it commits, DROP DATABASE IF EXISTS cannot see the database and does nothing —
 * the copy then commits afterwards, recorded nowhere. Cancel, wait, terminate, wait.
 */
function endCreatedb(d, name) {
  const count = () => {
    const r = psqlRaw(d, `SELECT count(*) FROM pg_stat_activity WHERE application_name = '${name}' AND pid <> pg_backend_pid()`);
    return r.code === 0 ? Number(r.out.trim()) || 0 : 0;
  };
  if (!count()) return;
  for (const fn of ['pg_cancel_backend', 'pg_terminate_backend']) {
    psqlRaw(d, `SELECT ${fn}(pid) FROM pg_stat_activity WHERE application_name = '${name}' AND pid <> pg_backend_pid()`);
    const until = Date.now() + 15000;
    while (Date.now() < until && count()) sleepSync(500);
    if (!count()) return;
  }
  log(`warning: a createdb of ${name} is still running on the server`);
}

/**
 * DROP one run copy. The name is re-checked here, at the last moment, whoever asked.
 * WITH (FORCE) needs Postgres 13; an older server gets its sessions ended first. `force:
 * false` (gc) leaves a copy that something is still connected to alone.
 */
function dropDb(d, name, { force = true } = {}) {
  const problem = dbNameProblem(name, d.dbPrefix, d.baselineDb);
  if (problem) throw new LtError('E_DB_NAME', `refusing to drop ${name}: ${problem}`);
  endCreatedb(d, name);
  let r = psqlRaw(d, `DROP DATABASE IF EXISTS "${name}"${force ? ' WITH (FORCE)' : ''}`, 300000);
  if (force && r.code !== 0 && /syntax error/i.test(r.err)) {
    psqlRaw(d, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}'`);
    r = psqlRaw(d, `DROP DATABASE IF EXISTS "${name}"`, 300000);
  }
  if (r.code !== 0) throw new LtError('E_DB_DROP', `could not drop ${name}: ${firstLine(r.err)}`);
}

/**
 * Release everything a run recorded, in the order that frees each thing's users first:
 * the browser, the app, the database, the checkouts. Synchronous so a signal handler can
 * run it. Each step is attempted whatever happened to the one before.
 */
function cleanup(data, d) {
  const failed = [];
  const step = (what, fn) => { try { fn(); } catch (err) { failed.push(`${what}: ${err.message}`); log(`cleanup: ${what} failed — ${err.message}`); } };
  const roots = (data.worktrees || []).map((w) => w.path);

  step('stop Cypress', () => {
    const groups = data.cypressPgids || [];
    // A crashed run's pid may be anybody's by now: from its file, only a process that
    // still IS Cypress is signalled (the check gc makes too).
    const mine = data.pid === process.pid;
    const live = groups.filter((p) => running(p) && (mine || /cypress/i.test(ps(p))));
    if (live.length) log(`stopping Cypress (${live.join(', ')})`);
    stopPids(live, 10000);
    // Electron helpers can outlive the group leader. Only this process signals a group
    // whose leader is gone: for a crashed run's file, the number may be someone else's now.
    if (mine) for (const g of groups) { try { process.kill(-g, 'SIGKILL'); } catch { /* group gone */ } }
  });
  for (const dir of data.harnessDirs || []) step(`stop the app in ${dir}`, () => stopHarness(dir, roots));
  if (data.ports) step('free the ports', () => killPortStragglers(data.ports, roots));
  for (const db of [data.db, data.baseDb].filter(Boolean)) {
    step(`drop ${db}`, () => {
      dropDb(d, db);
      log(`dropped ${db}`);
    });
  }
  const gitDirs = new Set();
  for (const w of data.worktrees || []) {
    step(`remove ${w.path}`, () => {
      if (!removeWorktree(w.path, w.gitDir)) throw new Error('still there after git worktree remove');
    });
    if (w.gitDir) gitDirs.add(w.gitDir);
  }
  for (const gd of gitDirs) step(`prune ${gd}`, () => gitAt(gd, ['worktree', 'prune'], true));
  return { ok: failed.length === 0, failed };
}

/**
 * A stale resources file, cut down to what this run's own layout could have recorded.
 *
 * The file is a plain JSON file in the run dir, and it may be days old (a reboot) or not
 * this script's at all. Before anything in it is signalled, dropped or removed: a
 * worktree must be one of the four names under THIS ticket's run dir, a harness dir one
 * of the two, a port one of the desk's pair, a database a copy of THIS ticket, a git dir
 * one of the two clones (else it is worked out from the worktree), a pid a number.
 * Returns {data, ignored}.
 */
function sanitizeStale(prev, ctx) {
  const ignored = [];
  const keep = (ok, what) => { if (!ok) ignored.push(what); return ok; };
  const known = (ctx.gitDirs || []).filter(Boolean).map((g) => real(g));
  const worktrees = (Array.isArray(prev.worktrees) ? prev.worktrees : [])
    .filter((w) => keep(isObj(w) && typeof w.path === 'string' && isOurWorktreePath(w.path) && inside(w.path, ctx.run),
      `worktree ${JSON.stringify(isObj(w) ? w.path : w)}`))
    .map((w) => (typeof w.gitDir === 'string' && known.includes(real(w.gitDir)) ? { path: w.path, gitDir: w.gitDir } : { path: w.path }));
  const harnessDirs = (Array.isArray(prev.harnessDirs) ? prev.harnessDirs : [])
    .filter((h) => keep(typeof h === 'string' && HARNESS_NAMES.some((n) => real(h) === real(path.join(ctx.run, n))),
      `harness dir ${JSON.stringify(h)}`));
  const pids = (Array.isArray(prev.cypressPgids) ? prev.cypressPgids : [])
    .filter((x) => keep(Number.isInteger(x) && x > 1, `pid ${JSON.stringify(x)}`));
  const copy = (name, what) => {
    if (name === null || name === undefined) return null;
    const parsed = typeof name === 'string' ? parseOurDb(name, ctx.dbPrefix) : null;
    return keep(Boolean(parsed) && parsed.iid === Number(ctx.iid) && !dbNameProblem(name, ctx.dbPrefix, ctx.baselineDb),
      `${what} ${JSON.stringify(name)}`) ? name : null;
  };
  const ports = isObj(prev.ports) && ctx.ports ? {
    be: prev.ports.be === ctx.ports.be ? ctx.ports.be : null,
    fe: prev.ports.fe === ctx.ports.fe ? ctx.ports.fe : null,
  } : null;
  if (isObj(prev.ports) && ports && (ports.be === null || ports.fe === null)) ignored.push(`ports ${JSON.stringify(prev.ports)}`);
  return {
    data: {
      pid: Number.isInteger(prev.pid) ? prev.pid : null,
      worktrees, harnessDirs, cypressPgids: pids, ports,
      db: copy(prev.db, 'database'), baseDb: copy(prev.baseDb, 'base database'),
    },
    ignored,
  };
}

/** A previous run's resources file: refuse if that run is alive, else clean up after it. */
function recoverStale(p, d, ctx) {
  const raw = readJson(p.resources);
  if (!raw) return;
  if (!isObj(raw)) {
    log(`ignoring ${p.resources}: not a resources record`);
    fs.rmSync(p.resources, { force: true });
    return;
  }
  if (raw.pid && raw.pid !== process.pid && H.alive(raw.pid) && /localtests/.test(ps(raw.pid))) {
    throw new LtError('E_RUN_IN_PROGRESS', `a local-tests run for this ticket is already running (pid ${raw.pid})`,
      'Wait for it, or stop it; its own cleanup releases what it holds.');
  }
  const { data: prev, ignored } = sanitizeStale(raw, {
    run: p.run, iid: ctx.iid, ports: d.ports, dbPrefix: d.dbPrefix, baselineDb: d.baselineDb, gitDirs: ctx.gitDirs,
  });
  if (ignored.length) log(`ignoring what this run could never have recorded in ${p.resources}: ${ignored.join(', ')}`);
  log(`cleaning up what an earlier run left (${p.resources})`);
  const c = cleanup(prev, d);
  if (!c.ok) {
    throw new LtError('E_STALE_RESOURCES', `an earlier run's leftovers could not be cleaned up: ${c.failed.join('; ')}`,
      'Run `node scripts/localtests.cjs gc --dry-run`, then gc (with --keep <every ticket a conductor has in flight> while one runs), and retry.');
  }
  fs.rmSync(p.resources, { force: true });
}

/* ------------------------------------------------------------------ args */

function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { o[a.slice(2)] = next; i += 1; } else o[a.slice(2)] = true;
    } else o._.push(a);
  }
  return o;
}

function needIid(opts) {
  const v = String(opts.iid || '');
  if (!/^\d+$/.test(v) || Number(v) <= 0) throw new LtError('E_ARGS', '--iid <ticket number> is required');
  return Number(v);
}

function needRepo(d) {
  if (!d.repo) throw new LtError('E_CONFIG', 'ONESHOT_LOCAL_TESTS_REPO is not set on this desk', 'Point it at your workstream-automation clone in the Oneshot .env.');
  const gd = commonDirOf(d.repo);
  if (!gd) throw new LtError('E_CONFIG', `${d.repo} is not a git checkout`, 'ONESHOT_LOCAL_TESTS_REPO must name your workstream-automation clone.');
  return gd;
}

/* ------------------------------------------------------------------ prepare-scope / capture */

/** Add a detached worktree of `gitDir` at `sha` to `wt`, removing a leftover of ours first. */
function addWorktree(gitDir, wt, sha) {
  if (fs.existsSync(wt)) {
    if (!looksLikeWorktree(wt) || !removeWorktree(wt)) {
      throw new LtError('E_WORKTREE_EXISTS', `${wt} exists and is not a worktree this script can remove`,
        'Move it aside by hand; nothing deletes a directory it cannot prove it made.');
    }
  }
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  gitAt(gitDir, ['worktree', 'prune'], true);
  gitAt(gitDir, ['worktree', 'add', '--detach', wt, sha]);
}

/** <wt>/node_modules -> <repo>/node_modules, when the clone has one. */
function linkAutomationNodeModules(wt, repo, required) {
  const src = path.join(repo, 'node_modules');
  const dst = path.join(wt, 'node_modules');
  if (!fs.existsSync(src)) {
    if (required) throw new LtError('E_NO_NODE_MODULES', `${src} does not exist`, `run npm ci in ${repo}`);
    log(`note: ${src} does not exist, so the worktree has no node_modules`);
    return;
  }
  if (!fs.existsSync(dst)) fs.symlinkSync(src, dst);
}

async function prepareScope(opts) {
  const iid = needIid(opts);
  const d = desk();
  const gitDir = needRepo(d);
  const ref = typeof opts['automation-ref'] === 'string' ? opts['automation-ref'] : d.automationRef;
  if (!ref) throw new LtError('E_CONFIG', 'no automation ref: localTests.automationRef is unusable and --automation-ref was not given');
  const p = pathsOf(iid);

  const fetched = sh('git', ['-C', d.repo, 'fetch', '--quiet', 'origin'], {
    timeout: 120000, env: { ...gitEnv(), GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes -o ConnectTimeout=15' },
  });
  if (fetched.code !== 0) log(`note: git fetch origin failed in ${d.repo}; using the refs it already has (${firstLine(fetched.err)})`);
  const sha = resolveSha(gitDir, ref);
  if (!sha) throw new LtError('E_REF_UNRESOLVED', `${ref} does not resolve in ${d.repo}`, 'Fetch it, or pass --automation-ref <sha>.');

  addWorktree(gitDir, p.wsa, sha);
  linkAutomationNodeModules(p.wsa, d.repo, false);
  log(`prepared ${p.wsa} at ${sha.slice(0, 10)} (${ref})`);
  return { wsa: p.wsa, automationSha: sha };
}

/**
 * Save the scope session's temporary edits as a patch, check them, and throw the
 * worktree away. The patch — not the worktree — is what the run applies, so the run is
 * reproducible from an artifact and nothing the session did survives in the clone.
 */
async function capture(opts) {
  const iid = needIid(opts);
  const d = desk();
  if (!d.allowedPaths.length) throw new LtError('E_CONFIG', 'localTests.allowedPaths is unusable', d.off || '');
  const p = pathsOf(iid);
  if (!looksLikeWorktree(p.wsa) || !commonDirOf(p.wsa)) {
    throw new LtError('E_NO_WSA', `${p.wsa} is not a worktree`, 'Run prepare-scope first; capture reads the scope session\'s edits from there.');
  }
  const head = git(['rev-parse', 'HEAD'], p.wsa);
  const spec = ['--', '.', ':(exclude)cypress.env.json', ':(exclude)node_modules'];
  // The credentials file never travels in the patch, and a change to it is never "allowed".
  const envChanged = Boolean(git(['status', '--porcelain', '--', 'cypress.env.json'], p.wsa));

  // `add` takes the bare `.`: an exclude naming an ignored path (node_modules, and
  // cypress.env.json is in .gitignore too) makes git refuse the whole add. Ignored paths
  // are skipped anyway, and -N on a tracked file is a no-op; the diff below excludes both.
  git(['add', '--intent-to-add', '--', '.'], p.wsa);
  let diff;
  let names;
  let status;
  try {
    diff = git(['diff', 'HEAD', '--binary', '--no-color', '--no-ext-diff', '--no-renames', ...spec], p.wsa, false, true);
    names = git(['diff', 'HEAD', '--name-only', '-z', '--no-renames', ...spec], p.wsa, false, true);
    status = git(['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--', 'cypress/e2e'], p.wsa, false, true);
  } finally {
    git(['reset', '-q'], p.wsa, true);
  }

  const changedFiles = names.split('\0').filter(Boolean).sort();
  const outsideAllowed = changedFiles.filter((f) => !isAllowedPath(f, d.allowedPaths));
  if (envChanged) outsideAllowed.push('cypress.env.json');
  const findings = weakenedFindings(diff);
  const { added, removed } = statusSpecs(status);

  let patchSha = null;
  if (diff.trim()) {
    fs.mkdirSync(path.dirname(p.patch), { recursive: true });
    fs.writeFileSync(p.patch, diff);
    patchSha = sha256(Buffer.from(diff));
  } else {
    // A patch from an earlier round must not be mistaken for this one's.
    fs.rmSync(p.patch, { force: true });
  }
  writeJson(p.capture, { patchFile: p.patch, patchSha, automationSha: head, capturedAt: new Date().toISOString() });

  if (!removeWorktree(p.wsa)) log(`warning: could not remove ${p.wsa}; gc will`);
  log(`captured ${changedFiles.length} changed file(s) from ${p.wsa}${patchSha ? ` -> ${p.patch}` : ' (no changes)'}`);
  return {
    patchFile: patchSha ? p.patch : null,
    patchSha,
    automationSha: head,
    changedFiles,
    outsideAllowed: [...new Set(outsideAllowed)].sort(),
    weakened: [...new Set(findings.map((f) => f.file))].sort(),
    weakenedDetail: findings,
    addedSpecs: added,
    removedSpecs: removed,
  };
}

/* ------------------------------------------------------------------ run: pieces */

/**
 * A borrowed node_modules must be able to build `pkg`: every declared package installed,
 * at a version its range admits (depDrift). Otherwise E_NODE_MODULES_DRIFT, before any
 * copy or build — a webpack that dies with "Unable to resolve module" ten minutes in
 * reads like the ticket broke the build (the pilot, posthog-js), and a Cypress whose
 * plugins are a major behind fails every spec, which reads like the specs failing.
 */
function assertNodeModules(pkg, nm, what, hint) {
  if (!fs.existsSync(nm)) throw new LtError('E_SEED_MISSING', `${nm} does not exist`, hint);
  const text = driftText(depDrift(pkg, (n) => installedVersion(nm, n)), `${nm} cannot build ${what}`);
  if (text) throw new LtError('E_NODE_MODULES_DRIFT', text, hint);
}

/**
 * Seed a throwaway ERP checkout exactly as app.cjs seed() does, except for the two
 * files that decide which database it touches, which are written rather than copied.
 * Everything here is checked and written before the copy exists: it needs only the
 * copy's NAME, and a refusal here costs seconds, not an 18-second copy (2026-10-09).
 */
function seedErp(wt, d, db) {
  const seed = d.seed;
  if (!seed || !fs.existsSync(seed)) throw new LtError('E_SEED_MISSING', `the seed ERP checkout ${seed || '(unset)'} does not exist`, 'Set ONESHOT_SEED_FROM (or WORK_REPO) to an installed ERP checkout.');

  const pkg = readJson(path.join(wt, 'package.json'));
  const nm = path.join(seed, 'node_modules');
  if (!pkg) throw new LtError('E_SEED_MISSING', `${wt}/package.json is unreadable`);
  assertNodeModules(pkg, nm, `this ref (${path.basename(wt)})`, `run npm ci in ${seed} on the base branch`);

  const link = (rel, required) => {
    const src = path.join(seed, rel);
    const dst = path.join(wt, rel);
    if (!fs.existsSync(src)) {
      if (required) throw new LtError('E_SEED_MISSING', `${src} does not exist`, `Install it in ${seed}.`);
      log(`note: ${src} is missing; harness.cjs will collect it in the worktree`);
      return;
    }
    if (!fs.existsSync(dst)) fs.symlinkSync(src, dst);
  };
  link('venv', true);
  link('staticfiles', false);
  if (!fs.existsSync(path.join(wt, 'node_modules'))) fs.symlinkSync(nm, path.join(wt, 'node_modules'));

  const cfgSrc = path.join(seed, 'frontend/src/constants/config.js');
  if (!fs.existsSync(cfgSrc)) throw new LtError('E_SEED_MISSING', `${cfgSrc} does not exist`);
  copyContents(cfgSrc, path.join(wt, 'frontend/src/constants/config.js'));

  const lsSrc = path.join(seed, 'hrdb/local_settings.py');
  if (!fs.existsSync(lsSrc)) throw new LtError('E_SEED_MISSING', `${lsSrc} does not exist`);
  const lsDst = path.join(wt, 'hrdb/local_settings.py');
  fs.mkdirSync(path.dirname(lsDst), { recursive: true });
  fs.writeFileSync(lsDst, rewriteLocalSettings(fs.readFileSync(lsSrc, 'utf8'), {
    name: db, host: d.pg.host, port: d.pg.port, user: pgUser(d),
  }), { mode: 0o600 });

  // settings.py: LOG_ROOT = BASE_DIR/../logs. Without it Django dies on import with
  // "Unable to configure handler 'costingLogFile'".
  fs.mkdirSync(path.join(path.dirname(wt), 'logs'), { recursive: true });

  const ex = path.resolve(wt, git(['rev-parse', '--git-path', 'info/exclude'], wt));
  fs.mkdirSync(path.dirname(ex), { recursive: true });
  const have = fs.existsSync(ex) ? fs.readFileSync(ex, 'utf8') : '';
  const add = SEED_EXCLUDES.filter((r) => !have.split('\n').includes(r));
  if (add.length) fs.appendFileSync(ex, `${have.endsWith('\n') || !have ? '' : '\n'}${add.join('\n')}\n`);
}

/**
 * Ask Django itself which database, Celery broker and cache prefix this checkout would
 * use, before anything touches them. A settings file that silently fell back to the
 * seed's database would migrate — and then let Cypress write to — somebody's real data;
 * the seed's broker or cache prefix would hand the copy's tasks and cache to the dev
 * app. Run once the copy exists and before migrate: django.setup() imports every app's
 * signals, and nothing promises that none of them reaches for the database.
 */
function assertDbGuard(wt, expected) {
  const src = [
    'import ssl, hashlib, os, json',
    "os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'hrdb.settings')",
    'import django',
    'django.setup()',
    'from django.conf import settings as s',
    "d = s.DATABASES['default']",
    "c = (getattr(s, 'CACHES', None) or {}).get('default') or {}",
    "print('ONESHOT_DB ' + json.dumps({'name': d.get('NAME'), 'host': d.get('HOST'), 'port': str(d.get('PORT')),"
      + " 'e2e': bool(getattr(s, 'EXPOSE_E2E_API', False)), 'broker': getattr(s, 'CELERY_BROKER_URL', None),"
      + " 'keyPrefix': c.get('KEY_PREFIX')}))",
  ].join('\n');
  const r = sh(path.join(wt, 'venv/bin/python'), ['-c', src], {
    cwd: wt, timeout: 180000, env: childEnv({ DJANGO_SETTINGS_MODULE: 'hrdb.settings', PYTHONUNBUFFERED: '1' }, { keepPg: true }),
  });
  const line = r.out.split('\n').find((l) => l.startsWith('ONESHOT_DB '));
  const got = line ? readJsonText(line.slice('ONESHOT_DB '.length)) : null;
  const problem = guardProblem(got, expected);
  if (problem) {
    throw new LtError('E_DB_GUARD', `in ${wt}: ${problem}`,
      got ? 'Refusing to migrate or test against it.' : `settings did not load: ${lastLines(r.err, 3)}`);
  }
  log(`database guard: Django uses ${got.name} on ${got.host}:${got.port}, Celery ${LT_BROKER}, cache prefix ${got.keyPrefix}, EXPOSE_E2E_API=${got.e2e}`);
  return got;
}

function readJsonText(s) { try { return JSON.parse(s); } catch { return null; } }

/**
 * Is whatever holds a port one of ours — another local-tests run, or a harness — rather
 * than something a person started? Ours means "try again later" (E_PORT_BUSY, which the
 * conductor parks on); anything else needs a person (E_PORT_FOREIGN).
 */
function portHolderIsOurs(cwd, command) {
  if (cwd && (inside(cwd, runsDir()) || /[/\\]state[/\\]runs[/\\]\d+[/\\](erp-lt|erp-base-lt|wsa-run)([/\\]|$)/.test(cwd))) return true;
  return /localtests\.cjs|harness\.cjs|[Cc]ypress/.test(String(command || ''));
}

/** Every requested port must be free: nothing this run started is up yet. */
function assertPortsFree(ports, roots = []) {
  for (const [what, port] of [['Django', ports.be], ['webpack', ports.fe]]) {
    const pid = H.listenerPid(port);
    if (!pid) continue;
    const cwd = H.pidCwd(pid);
    if (cwd && roots.some((r) => inside(cwd, r))) continue;
    if (portHolderIsOurs(cwd, ps(pid))) {
      throw new LtError('E_PORT_BUSY', `port ${port} (${what}) is held by a local-tests or harness process (pid ${pid}, from ${cwd || 'an unknown directory'})`,
        'Another run is using the local-tests ports; try again when it has finished.');
    }
    throw new LtError('E_PORT_FOREIGN', `port ${port} (${what}) is held by pid ${pid} running from ${cwd || 'an unknown directory'}`,
      'The local-tests ports are reserved for this step (ONESHOT_LOCAL_TESTS_PORT / _FE_PORT). Stop that process or change the pair.');
  }
}

async function waitPortsFree(ports, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!H.listenerPid(ports.be) && !H.listenerPid(ports.fe)) return true;
    await sleep(500);
  }
  return false;
}

function parseLastJson(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* fall through */ }
  const at = s.lastIndexOf('\n{');
  return at >= 0 ? readJsonText(s.slice(at + 1)) : null;
}

/** The webpack log with its colour codes taken out. */
const stripAnsi = (s) => String(s || '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');

/**
 * Where webpack's current build stands: 'compiled', 'failed' or 'compiling'.
 *
 * Since ERP d0fa609b4e (2026-09-23) the dev build writes static/webpack-entrypoints.dev.json
 * ({hash, entrypoints}) from EntrypointFilesPlugin, which has NO status field and is written
 * on every `done`, a failed build included — so the file alone says only that A build
 * finished. Ready is that file written since this app started AND the webpack log's last
 * compile line being a "Compiled …" one, not "Failed to compile". A ticket branch cut
 * before the switch still writes webpack-bundle-tracker's webpack-stats.dev.json, read the
 * old way (its own status) under the same freshness rule.
 */
function webpackReadiness({ logText, entrypoints, stats, sinceMs }) {
  const marks = stripAnsi(logText).split('\n').filter((l) => /Compiled successfully|Compiled with warnings|Failed to compile/.test(l));
  const last = marks.length ? marks[marks.length - 1] : '';
  if (/Failed to compile/.test(last)) return 'failed';
  const fresh = (f) => f && Number.isFinite(f.mtimeMs) && f.mtimeMs >= sinceMs - 1000;
  if (fresh(stats) && isObj(stats.json) && stats.json.status === 'error') return 'failed';
  if (!/Compiled/.test(last)) return 'compiling';
  if (fresh(entrypoints) && isObj(entrypoints.json) && isObj(entrypoints.json.entrypoints)
    && Object.keys(entrypoints.json.entrypoints).length) return 'compiled';
  if (fresh(stats) && isObj(stats.json) && stats.json.status === 'done') return 'compiled';
  return 'compiling';
}

function webpackState(wt, harnessDir, sinceMs) {
  const file = (rel) => {
    const f = path.join(wt, rel);
    try { return { mtimeMs: fs.statSync(f).mtimeMs, json: readJson(f) }; } catch { return null; }
  };
  let logText = '';
  try { logText = fs.readFileSync(path.join(harnessDir, 'harness', 'webpack.log'), 'utf8'); } catch { /* no log yet */ }
  return webpackReadiness({
    logText, sinceMs,
    entrypoints: file('static/webpack-entrypoints.dev.json'),
    stats: file('static/webpack-stats.dev.json'),
  });
}

/**
 * `harness.cjs up` for one checkout on our ports, with up to 25 minutes (or what the
 * conductor's deadline leaves) for the cold webpack build. The harness gives webpack 20;
 * when it gives up while webpack is still alive, this watches the build itself
 * (webpackState) for the rest of the budget and then asks the harness again, which
 * reuses the running servers.
 */
async function harnessUp(dir, wt, ports, budgetMs = APP_BUDGET_MS) {
  stopHarness(dir, [wt]);
  fs.rmSync(path.join(dir, 'harness', 'app-env.json'), { force: true });
  const hEnv = childEnv({ ONESHOT_RUN_DIR: dir, ONESHOT_WORKTREE: wt, ONESHOT_PORT: String(ports.be), ONESHOT_FE_PORT: String(ports.fe) }, { keepPg: true });
  delete hEnv.ONESHOT_IID;
  const started = Date.now();
  const left = () => budgetMs - (Date.now() - started);
  const once = async (budget) => {
    const r = await runAsync(process.execPath, [HARNESS_CLI, 'up'], { cwd: wt, env: hEnv, timeoutMs: Math.max(budget, 1000), echo: true });
    return { r, out: parseLastJson(r.out) };
  };
  let { r, out } = await once(budgetMs);
  if (out && out.baseUrl) return out;

  if (out && out.code === 'E_WEBPACK_DEAD') {
    const servers = readJson(path.join(dir, 'harness', 'servers.json')) || {};
    const since = Number(servers.startedAt) || started;
    if (servers.webpackPid && H.alive(servers.webpackPid) && webpackState(wt, dir, since) !== 'failed') {
      log(`webpack is still compiling past the harness's own wait; watching it for up to ${Math.round(left() / 60000)} more min`);
      while (left() > 0) {
        if (!H.alive(servers.webpackPid)) break;
        const st = webpackState(wt, dir, since);
        if (st === 'failed') { log('webpack finished with a build error'); break; }
        if (st === 'compiled') {
          ({ r, out } = await once(Math.min(5 * 60000, Math.max(left(), 60000))));
          if (out && out.baseUrl) return out;
          break;
        }
        await sleep(3000);
      }
    }
  }
  if (r.timedOut || left() <= 0) {
    throw new LtError('E_APP_FAILED', `the app did not come up within ${Math.round(budgetMs / 60000)} min`, `logs in ${path.join(dir, 'harness')}`);
  }
  throw new LtError('E_APP_FAILED', `harness.cjs up failed: ${out ? `${out.code}: ${out.message}` : 'no JSON on stdout'}`,
    (out && out.hint) || lastLines(r.err, 3) || `logs in ${path.join(dir, 'harness')}`);
}

/**
 * The credentials, written where Cypress reads them and nowhere else: the committed
 * cypress.env.json with the desk's file over it, mode 600, in a worktree that is removed
 * when the run ends. Nothing about the values is ever logged — not even key names.
 */
function writeCypressEnv(wsaRun, credsFile) {
  if (!fs.existsSync(credsFile)) {
    throw new LtError('E_NO_CREDS', `the Cypress credentials file ${credsFile} does not exist`,
      "Create it (chmod 600) with the keys of workstream-automation's cypress.env.json, or set ONESHOT_LOCAL_TESTS_CREDS.");
  }
  let creds = null;
  try { creds = JSON.parse(fs.readFileSync(credsFile, 'utf8')); } catch { creds = undefined; }
  // Never the parser's message: Node quotes the offending text, which here is a secret.
  if (creds === undefined) throw new LtError('E_CREDS_INVALID', `${credsFile} is not valid JSON`, 'Fix the file; its contents are never printed.');
  if (!isObj(creds)) throw new LtError('E_CREDS_INVALID', `${credsFile} is not a JSON object`, 'It has the same shape as cypress.env.json.');
  try {
    if (fs.statSync(credsFile).mode & 0o077) log(`warning: ${credsFile} is readable by group or others; chmod 600 it`);
  } catch { /* mode is advice */ }
  const dst = path.join(wsaRun, 'cypress.env.json');
  const committed = readJson(dst, {});
  fs.rmSync(dst, { force: true });
  fs.writeFileSync(dst, `${JSON.stringify(mergeEnv(committed, creds), null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(dst, 0o600);
  log('wrote cypress.env.json for this run (mode 600)');
}

function npxBin() {
  const beside = path.join(path.dirname(process.execPath), 'npx');
  return fs.existsSync(beside) ? beside : 'npx';
}

function clearCypressOutput(wsaRun) {
  for (const rel of ['cypress/results', 'cypress/videos', 'cypress/screenshots']) {
    fs.rmSync(path.join(wsaRun, rel), { recursive: true, force: true });
  }
}

/**
 * One `cypress run`, in its own process group, under a hard deadline. Cypress exits with
 * the number of failures, so a non-zero exit is a result, not an error; only "nothing
 * reported at all" is, and the caller decides that from the reports.
 */
async function runCypress(wsaRun, specs, baseUrl, deadlineMin, logFile, res) {
  const args = ['--no-install', 'cypress', 'run', '--spec', specs.map(globEscape).join(','), '--env', `SERVER=${baseUrl}`, '--browser', 'electron'];
  log(`cypress run: ${specs.length} spec(s) against ${baseUrl}, deadline ${fmtMin(deadlineMin)} min (log: ${logFile})`);
  let deadlineHit = false;
  let pgid = null;
  const started = Date.now();
  const promise = runAsync(npxBin(), args, {
    cwd: wsaRun,
    detached: true,
    logFile,
    // The strictest environment of all: this runs the scope session's patch.
    env: childEnv({ NO_COLOR: '1', FORCE_COLOR: '0', HUSKY: '0', CYPRESS_CRASH_REPORTS: '0' }),
    onSpawn: (pid) => { pgid = pid; res.push('cypressPgids', pid); },
  });
  const timer = setTimeout(() => {
    deadlineHit = true;
    log(`deadline: stopping Cypress after ${deadlineMin} min`);
    killGroup(pgid, 'SIGTERM');
    setTimeout(() => killGroup(pgid, 'SIGKILL'), 15000).unref();
  }, deadlineMin * 60000);
  const r = await promise;
  clearTimeout(timer);
  if (pgid && H.alive(pgid)) stopPids([pgid], 5000);
  // A group cannot be renumbered while any member lives, so this reaches only Cypress's own stragglers.
  if (pgid) { try { process.kill(-pgid, 'SIGKILL'); } catch { /* group already empty */ } }
  return { code: r.code, signal: r.signal, deadlineHit, elapsedMs: Date.now() - started, spawnError: r.code === null && !r.signal ? r.err : null };
}

function readReports(wsaRun) {
  const dir = path.join(wsaRun, 'cypress', 'results', '.jsons');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { return []; }
  return files.flatMap((f) => parseMochawesome(readJson(path.join(dir, f), {})));
}

/** The recording of one spec: cypress/videos/<path under cypress/e2e>.mp4, or found by name. */
function videoFor(wsaRun, spec) {
  const rel = spec.replace(/^cypress\/e2e\//, '');
  const direct = path.join(wsaRun, 'cypress', 'videos', `${rel}.mp4`);
  if (fs.existsSync(direct)) return { file: direct, rel };
  const want = `${path.basename(spec)}.mp4`;
  const stack = [path.join(wsaRun, 'cypress', 'videos')];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) stack.push(path.join(d, e.name));
      else if (e.name === want) return { file: path.join(d, e.name), rel };
    }
  }
  return null;
}

/** Failed specs' videos into artifacts/local-tests/videos/, each row pointing at its file. */
function keepVideos(wsaRun, results, p, notes) {
  const failedSpecs = [...new Set(results.filter((r) => r.state === 'failed').map((r) => r.spec))];
  for (const spec of failedSpecs) {
    const v = videoFor(wsaRun, spec);
    if (!v) continue;
    const size = fs.statSync(v.file).size;
    if (size > MAX_VIDEO_BYTES) {
      notes.push(`the video of ${spec} is ${Math.round(size / 1048576)} MB, over the 25 MB upload limit, so it was not kept`);
      continue;
    }
    const rel = path.posix.join('local-tests', 'videos', `${v.rel}.mp4`);
    copyContents(v.file, path.join(p.run, 'artifacts', rel));
    for (const r of results) if (r.spec === spec && r.state === 'failed') r.video = rel;
  }
}

/* ------------------------------------------------------------------ run */

let ACTIVE = null; // { res, d, printed } while a run holds resources
let LAST_CLEANUP = null; // the run's cleanup outcome, for an error's hint

function installSignalHandlers() {
  const handler = (sig) => {
    const n = { SIGINT: 2, SIGHUP: 1, SIGTERM: 15 }[sig] || 15;
    log(`${sig}: stopping and cleaning up`);
    for (const c of CHILDREN) { try { c.kill('SIGTERM'); } catch { /* gone */ } }
    let cleaned = null;
    if (ACTIVE) {
      cleaned = cleanup(ACTIVE.res.data, ACTIVE.d);
      if (cleaned.ok) fs.rmSync(ACTIVE.res.file, { force: true });
    }
    if (!ACTIVE || !ACTIVE.printed) {
      process.stdout.write(`${JSON.stringify(redact({
        code: 'E_ABORTED', message: `stopped by ${sig}`,
        hint: cleaned && !cleaned.ok ? `cleanup incomplete: ${cleaned.failed.join('; ')} — run gc` : null,
      }), null, 2)}\n`);
    }
    process.exit(128 + n);
  };
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, handler);
}

function emptyRun(fields) {
  return {
    status: 'skipped', cacheKey: '', ticketSha: '', automationSha: '', patchSha: null, db: '',
    totals: { specs: 0, tests: 0, passed: 0, failed: 0, skipped: 0 },
    results: [], notRunnable: [], newTests: [], startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
    ...fields,
  };
}

/** Minutes for a message: whole when whole, else to two places. */
function fmtMin(m) { return Number.isInteger(m) ? m : Number(Number(m).toFixed(2)); }

/**
 * The conductor's absolute deadline (--until) as a clock. Without one every budget is
 * what it always was; with one, each step's budget is cut so that cleanup still fits
 * before the conductor's kill — a kill throws away results that are already complete.
 */
function clock(until) {
  const left = () => (until ? until - Date.now() : Infinity);
  return {
    left,
    leftText: () => `${Math.max(0, Math.round(left() / 60000))} min`,
    /** `ms`, or less so that `reserveMs` is still left when it runs out. */
    cap: (ms, reserveMs) => Math.min(ms, left() - reserveMs),
    /** Cypress minutes: `deadlineMin`, cut so cleanup still fits; 0 when too little is left to start one. */
    cypressMin: (deadlineMin) => {
      if (!until) return deadlineMin;
      const ms = left() - CLEANUP_MARGIN_MS;
      return ms < MIN_CYPRESS_MS ? 0 : Math.min(deadlineMin, ms / 60000);
    },
  };
}

/** `ms` when it is a budget at all, else the step does not start. */
function needTime(ms, what, t) {
  if (ms > 0) return ms;
  throw new LtError('E_DEADLINE', `only ${t.leftText()} were left before the conductor's deadline, too little for ${what}`,
    'The run stopped short of the kill so that its cleanup still runs.');
}

const failedSpecsOf = (results) => [...new Set(results.filter((r) => r.state === 'failed').map((r) => r.spec))];

/** One past the highest copy this ticket has used, on the server or in the run dir's counter. */
function nextCopyName(d, p, iid) {
  let counter = 0;
  try { counter = Number(fs.readFileSync(p.seq, 'utf8')) || 0; } catch { /* the first copy */ }
  const seq = nextSeq(iid, listOurDbs(d), d.dbPrefix, counter);
  fs.writeFileSync(p.seq, `${seq}\n`);
  const db = dbName(d.dbPrefix, iid, seq);
  const problem = dbNameProblem(db, d.dbPrefix, d.baselineDb);
  if (problem) throw new LtError('E_DB_NAME', `refusing to create ${db}: ${problem}`);
  return db;
}

/**
 * `createdb -T <baseline> <db>`, recorded in the resources file under `key` first. The
 * baseline must exist and have no sessions: Postgres will not copy a database anything
 * is connected to. createdb runs as application_name = the copy's name, so an
 * interrupted one can still be found and ended before the drop (endCreatedb).
 */
async function copyBaseline(d, res, key, db) {
  if (psql(d, `SELECT 1 FROM pg_database WHERE datname = '${d.baselineDb}'`) !== '1') {
    throw new LtError('E_NO_BASELINE', `the baseline database ${d.baselineDb} does not exist on ${d.pg.host}:${d.pg.port}`, 'Restore the automation dump into it (docs/LOCAL-TESTS.md).');
  }
  const busy = Number(psql(d, `SELECT count(*) FROM pg_stat_activity WHERE datname = '${d.baselineDb}'`));
  if (busy !== 0) {
    throw new LtError('E_BASELINE_BUSY', `sessions are connected to ${d.baselineDb}`,
      `${busy} session(s). Postgres will not copy a database anything is connected to; close them (psql, pgAdmin, a Django shell).`);
  }
  res.set(key, db);
  const createArgs = ['-h', d.pg.host, '-p', String(d.pg.port), ...(pgUser(d) ? ['-U', pgUser(d)] : []), '-w', '-T', d.baselineDb, db];
  const created = await runAsync('createdb', createArgs, {
    timeoutMs: 60 * 60000, env: childEnv({ PGCONNECT_TIMEOUT: '10', PGAPPNAME: db }, { keepPg: true }),
  });
  if (created.code !== 0) {
    if (/being accessed by other users/i.test(created.err)) {
      throw new LtError('E_BASELINE_BUSY', `${d.baselineDb} was in use when the copy started`, firstLine(created.err));
    }
    throw new LtError('E_DB_COPY', `createdb ${db} failed`, firstLine(created.err) || (created.timedOut ? 'timed out' : ''));
  }
}

/** `manage.py migrate` in `wt`, against whatever its local_settings.py names (the guard has checked). */
async function migrateCopy(wt, logFile, sha, t) {
  const migrate = await runAsync(path.join(wt, 'venv/bin/python'), ['-c',
    "import ssl, hashlib, sys, runpy; sys.argv=['manage.py','migrate','--noinput']; runpy.run_path('manage.py', run_name='__main__')"],
  { cwd: wt, timeoutMs: needTime(t.cap(30 * 60000, CLEANUP_MARGIN_MS), 'manage.py migrate', t), logFile,
    env: childEnv({ DJANGO_SETTINGS_MODULE: 'hrdb.settings', PYTHONUNBUFFERED: '1' }, { keepPg: true }) });
  if (migrate.code !== 0) {
    let tail = '';
    try { tail = lastLines(fs.readFileSync(logFile, 'utf8'), 4); } catch { /* no log */ }
    throw new LtError('E_MIGRATE_FAILED', `manage.py migrate failed on ${sha.slice(0, 10)}`, tail || `see ${logFile}`);
  }
}

async function runCmd(opts) {
  const iid = needIid(opts);
  for (const k of ['worktree', 'ref', 'specs-file']) {
    if (typeof opts[k] !== 'string' || !opts[k]) throw new LtError('E_ARGS', `--${k} is required`);
  }
  const d = desk();
  if (!d.enabled) throw new LtError('E_CONFIG', `local tests are off on this desk: ${d.off}`, 'npm run doctor says what to fix.');
  if (!d.ports.be || !d.ports.fe || d.ports.be === d.ports.fe) {
    throw new LtError('E_CONFIG', 'ONESHOT_LOCAL_TESTS_PORT and ONESHOT_LOCAL_TESTS_FE_PORT must be two different ports');
  }
  const wsaGit = needRepo(d);
  const p = pathsOf(iid);
  const startedAt = new Date().toISOString();
  const notes = [];

  const specsFile = path.resolve(opts['specs-file']);
  const specsData = readJson(specsFile);
  if (specsData === null) throw new LtError('E_SPECS', `${specsFile} is not readable JSON`);
  const { specs, notRunnable } = parseSpecs(specsData);
  if (specs.length > d.maxSpecs) notes.push(`${specs.length} specs is over maxSpecs (${d.maxSpecs}); all of them run, as planned`);

  const deadlineMin = opts['deadline-min'] !== undefined ? Number(opts['deadline-min']) : d.maxRunMinutes + 10;
  if (!(deadlineMin > 0)) throw new LtError('E_ARGS', '--deadline-min must be a positive number of minutes');
  let until = null;
  if (opts.until !== undefined) {
    until = Number(opts.until);
    if (!Number.isFinite(until) || until <= 0) throw new LtError('E_ARGS', "--until must be the conductor's deadline in epoch milliseconds");
  }

  const erpGit = commonDirOf(path.resolve(opts.worktree)) || commonDirOf(d.workRepo);
  if (!erpGit) throw new LtError('E_NO_ERP_REPO', `${opts.worktree} is not a git checkout and WORK_REPO (${d.workRepo || 'unset'}) is not either`);
  const ticketSha = resolveSha(erpGit, opts.ref);
  if (!ticketSha) throw new LtError('E_REF_UNRESOLVED', `${opts.ref} does not resolve in ${erpGit}`);

  // The patch is only true of the commit it was cut against, so that commit wins.
  const captured = readJson(p.capture);
  const automationRef = typeof opts['automation-sha'] === 'string' ? opts['automation-sha']
    : (captured && captured.automationSha) || d.automationRef;
  const automationSha = resolveSha(wsaGit, automationRef);
  if (!automationSha) throw new LtError('E_REF_UNRESOLVED', `${automationRef} does not resolve in ${d.repo}`);

  let patchText = '';
  let patchFile = null;
  if (typeof opts.patch === 'string') {
    patchFile = path.resolve(opts.patch);
    if (!fs.existsSync(patchFile)) throw new LtError('E_PATCH', `${patchFile} does not exist`);
    patchText = fs.readFileSync(patchFile, 'utf8');
  }
  const patchSha = patchText.trim() ? sha256(Buffer.from(patchText)) : null;
  const expected = typeof opts['patch-sha'] === 'string' ? opts['patch-sha']
    : captured && patchFile && real(captured.patchFile || '') === real(patchFile) ? captured.patchSha : undefined;
  if (patchFile && expected !== undefined && (expected || null) !== patchSha) {
    throw new LtError('E_PATCH_MISMATCH', `${patchFile} is not the patch capture recorded (sha256 ${String(patchSha).slice(0, 12)}, expected ${String(expected).slice(0, 12)})`,
      'Something changed it after capture; re-run local-tests-scope.');
  }
  const newTests = patchAddedFiles(patchText).filter((f) => f.startsWith('cypress/e2e/'));
  const key = cacheKey({ ticketSha, automationSha, patchSha, specs, baseline: d.baselineDb });
  const base = { cacheKey: key, ticketSha, automationSha, patchSha, notRunnable, newTests, startedAt };

  if (!specs.length) {
    return emptyRun({
      ...base, reason: notRunnable.length ? 'every planned spec needs something a local machine does not have' : 'no specs to run',
      ...(notes.length ? { notes } : {}),
    });
  }

  fs.mkdirSync(p.run, { recursive: true });
  recoverStale(p, d, { iid, gitDirs: [wsaGit, erpGit] });
  assertPortsFree(d.ports);

  const res = new Resources(p.resources, {
    pid: process.pid, iid, startedAt, ports: d.ports, dbPrefix: d.dbPrefix, baselineDb: d.baselineDb,
  });
  ACTIVE = { res, d, printed: false };
  try {
    const out = await runBody({
      iid, d, p, res, specs, deadlineMin, notes, erpGit, wsaGit, ticketSha, automationSha, patchFile, patchSha, opts, t: clock(until),
    });
    return { ...base, ...out, notes };
  } finally {
    // A signal never reaches here: its handler cleans up and exits on its own.
    const c = cleanup(res.data, d);
    LAST_CLEANUP = c;
    if (c.ok) fs.rmSync(res.file, { force: true });
    else notes.push(`cleanup incomplete: ${c.failed.join('; ')} — run gc`);
    ACTIVE = null;
    if (!c.ok) log('cleanup incomplete; the resources file is kept for gc');
  }
}

async function runBody(ctx) {
  const { iid, d, p, res, specs, deadlineMin, notes, erpGit, wsaGit, ticketSha, automationSha, patchFile, patchSha, opts, t } = ctx;
  const t0 = Date.now();
  const since = () => `${Math.round((Date.now() - t0) / 1000)}s`;

  // 1. Everything that can refuse without the database comes first: the automation
  // worktree and its node_modules, Cypress, the patch, the specs, the credentials, then
  // the ERP checkout seeded against its own package.json. Each costs seconds; on
  // 2026-10-09 a node_modules drift was found only after the copy.
  res.push('worktrees', { path: p.wsaRun, gitDir: wsaGit });
  addWorktree(wsaGit, p.wsaRun, automationSha);
  linkAutomationNodeModules(p.wsaRun, d.repo, true);
  const wsaPkg = readJson(path.join(p.wsaRun, 'package.json'));
  if (wsaPkg) {
    assertNodeModules(wsaPkg, path.join(d.repo, 'node_modules'), `the automation code at ${automationSha.slice(0, 10)}`,
      `run npm ci in ${d.repo} with ${automationSha.slice(0, 10)} (localTests.automationRef) checked out`);
  }
  if (!fs.existsSync(path.join(p.wsaRun, 'node_modules', '.bin', 'cypress'))) {
    throw new LtError('E_NO_CYPRESS', `${d.repo}/node_modules has no cypress binary`, `run npm ci in ${d.repo}`);
  }
  if (patchFile && patchSha) {
    const r = sh('git', ['apply', '--whitespace=nowarn', patchFile], { cwd: p.wsaRun, env: gitEnv() });
    if (r.code !== 0) throw new LtError('E_PATCH_APPLY', `the temporary changes do not apply at ${automationSha.slice(0, 10)}`, lastLines(r.err, 3));
  }
  const missing = specs.filter((s) => !fs.existsSync(path.join(p.wsaRun, s)));
  if (missing.length) throw new LtError('E_SPEC_MISSING', `${missing.length} planned spec(s) are not in the automation worktree: ${missing.join(', ')}`);
  writeCypressEnv(p.wsaRun, d.credsFile);
  fs.rmSync(p.videos, { recursive: true, force: true });
  log(`[${since()}] automation worktree ready at ${automationSha.slice(0, 10)}${patchSha ? ' with the temporary changes' : ''}`);

  // The copy's NAME is all the ERP checkout needs: it is seeded before the copy exists.
  psql(d, 'SELECT 1');
  const db = nextCopyName(d, p, iid);
  res.push('worktrees', { path: p.erp, gitDir: erpGit });
  addWorktree(erpGit, p.erp, ticketSha);
  seedErp(p.erp, d, db);
  log(`[${since()}] ERP worktree ready at ${ticketSha.slice(0, 10)}`);

  // 2. The database copy; 3. Django's own word on what it would touch; 4. migrated to the ticket's code.
  await copyBaseline(d, res, 'db', db);
  log(`[${since()}] copied ${d.baselineDb} -> ${db}`);
  assertDbGuard(p.erp, db);
  await migrateCopy(p.erp, path.join(p.harness, 'migrate.log'), ticketSha, t);
  log(`[${since()}] migrated ${db}`);

  // 5. The app.
  assertPortsFree(d.ports);
  res.push('harnessDirs', p.harness);
  const app = await harnessUp(p.harness, p.erp, d.ports,
    needTime(t.cap(APP_BUDGET_MS, CLEANUP_MARGIN_MS + MIN_CYPRESS_MS), 'the app build', t));
  log(`[${since()}] app up at ${app.baseUrl}`);

  // 6. Cypress.
  const cypMin = t.cypressMin(deadlineMin) || needTime(0, 'a Cypress run', t);
  if (cypMin < deadlineMin) notes.push(`Cypress was given ${fmtMin(cypMin)} min, not ${fmtMin(deadlineMin)}, so the run ends before the conductor's deadline`);
  clearCypressOutput(p.wsaRun);
  const run = await runCypress(p.wsaRun, specs, app.baseUrl, cypMin, path.join(p.harness, 'cypress.log'), res);
  const rows = readReports(p.wsaRun);
  if (!rows.length && !run.deadlineHit) {
    let tail = '';
    try { tail = lastLines(fs.readFileSync(path.join(p.harness, 'cypress.log'), 'utf8'), 4); } catch { /* no log */ }
    throw new LtError('E_CYPRESS_FAILED', `Cypress reported nothing (exit ${run.code})`, run.spawnError || tail || `see ${path.join(p.harness, 'cypress.log')}`);
  }
  const results = assembleResults(specs, rows, { deadlineHit: run.deadlineHit, deadlineMin: fmtMin(cypMin) });
  log(`[${since()}] Cypress finished in ${Math.round(run.elapsedMs / 1000)}s: ${results.filter((r) => r.state === 'failed').length} failed of ${results.length}`);

  // 7. Retry before blame: the failed specs once more on the same app. What passes now
  // is flaky, not broken, and is neither a failure nor a question for the base re-run.
  const firstFailed = failedSpecsOf(results);
  if (firstFailed.length) {
    const retryMin = t.cypressMin(deadlineMin);
    if (run.deadlineHit) notes.push('the failures were not retried: Cypress had already reached its deadline');
    else if (firstFailed.length > MAX_BASE_RERUN_SPECS) notes.push(`${firstFailed.length} specs failed, more than ${MAX_BASE_RERUN_SPECS}, so they were not retried`);
    else if (!retryMin) notes.push(`the failures were not retried: only ${t.leftText()} were left before the conductor's deadline`);
    else {
      clearCypressOutput(p.wsaRun);
      await runCypress(p.wsaRun, firstFailed, app.baseUrl, retryMin, path.join(p.harness, 'cypress-retry.log'), res);
      const retryRows = readReports(p.wsaRun);
      if (!retryRows.length) notes.push("the retry on the ticket's code recorded no results, so the first run's failures stand");
      notes.push(...applyRetryResults(results, retryRows));
      log(`[${since()}] retry done: ${failedSpecsOf(results).length} of ${firstFailed.length} spec(s) still failing`);
    }
  }
  // From the last run on the ticket's code — the retry when there was one: the failure that counts.
  keepVideos(p.wsaRun, results, p, notes);

  // 8. Was it this ticket? Re-run what failed twice on the base, on a fresh copy.
  const failedSpecs = failedSpecsOf(results);
  for (const r of results) if (r.state === 'failed') r.failingOnDev = null;
  if (typeof opts.base === 'string' && failedSpecs.length) {
    if (failedSpecs.length > MAX_BASE_RERUN_SPECS) {
      notes.push(`${failedSpecs.length} specs failed, more than ${MAX_BASE_RERUN_SPECS}, so they were not re-run on ${opts.base}`);
    } else if (t.left() < BASE_RERUN_NEEDS_MS) {
      notes.push(`the failures were not re-run on ${opts.base}: only ${t.leftText()} were left before the conductor's deadline and a base re-run needs about ${Math.round(BASE_RERUN_NEEDS_MS / 60000)}, so whether they fail on ${opts.base} too is unknown`);
    } else {
      try {
        const baseRows = await baseRerun({ d, p, res, iid, erpGit, failedSpecs, deadlineMin, base: opts.base, t });
        applyBaseResults(results, baseRows);
        log(`[${since()}] base re-run done`);
      } catch (err) {
        notes.push(`the failures were not re-run on ${opts.base}, so whether they fail there too is unknown: ${err.code ? `${err.code}: ` : ''}${err.message}`);
        log(`base re-run skipped: ${err.message}`);
      }
    }
  }

  const count = (s) => results.filter((r) => r.state === s).length;
  const failed = count('failed');
  const out = {
    status: failed || run.deadlineHit ? 'failed' : 'passed',
    db,
    totals: { specs: specs.length, tests: results.length, passed: count('passed'), failed, skipped: count('skipped') },
    results,
    endedAt: new Date().toISOString(),
  };
  if (run.deadlineHit) {
    out.reason = `Cypress was stopped at the ${fmtMin(cypMin)}-minute deadline; ${results.filter((r) => r.title === '(not finished)').length} spec(s) did not finish`;
  }
  return out;
}

/**
 * The base branch's code on its OWN fresh copy of the baseline, migrated at the base,
 * running only the specs that failed twice. Never the ticket's copy: the ticket's
 * Cypress run has written to it and the ticket's migrations have changed it — a column
 * the ticket added as NOT NULL makes every base INSERT into that table fail, which would
 * read as "fails on dev too". The copy is recorded as `baseDb` before it exists, so
 * cleanup and gc drop it like the other. Anything that stops this is the caller's note,
 * and failingOnDev stays unknown.
 */
async function baseRerun({ d, p, res, iid, erpGit, failedSpecs, deadlineMin, base, t }) {
  const baseSha = resolveSha(erpGit, base);
  if (!baseSha) throw new LtError('E_REF_UNRESOLVED', `${base} does not resolve in ${erpGit}`);
  const baseDb = nextCopyName(d, p, iid);
  res.push('worktrees', { path: p.erpBase, gitDir: erpGit });
  addWorktree(erpGit, p.erpBase, baseSha);
  seedErp(p.erpBase, d, baseDb);

  await copyBaseline(d, res, 'baseDb', baseDb);
  log(`copied ${d.baselineDb} -> ${baseDb} for the base re-run`);
  assertDbGuard(p.erpBase, baseDb);
  await migrateCopy(p.erpBase, path.join(p.harnessBase, 'migrate.log'), baseSha, t);
  log(`migrated ${baseDb} to ${baseSha.slice(0, 10)}`);

  stopHarness(p.harness, [p.erp]);
  if (!(await waitPortsFree(d.ports, 30000))) killPortStragglers(d.ports, [p.erp, p.erpBase]);
  assertPortsFree(d.ports, [p.erpBase]);
  res.push('harnessDirs', p.harnessBase);
  const app = await harnessUp(p.harnessBase, p.erpBase, d.ports,
    needTime(t.cap(APP_BUDGET_MS, CLEANUP_MARGIN_MS + MIN_CYPRESS_MS), 'the base app build', t));
  log(`base app (${baseSha.slice(0, 10)}) up at ${app.baseUrl}`);

  const min = t.cypressMin(deadlineMin) || needTime(0, 'the base Cypress run', t);
  clearCypressOutput(p.wsaRun);
  await runCypress(p.wsaRun, failedSpecs, app.baseUrl, min, path.join(p.harnessBase, 'cypress.log'), res);
  return readReports(p.wsaRun);
}

/* ------------------------------------------------------------------ gc / status */

function runIids() {
  try { return fs.readdirSync(runsDir()).filter((x) => /^\d+$/.test(x)).map(Number).sort((a, b) => a - b); } catch { return []; }
}

/** The iid's resources file names a localtests process that is still alive. */
function liveRun(iid) {
  const r = readJson(pathsOf(iid).resources);
  return Boolean(r && r.pid && r.pid !== process.pid && H.alive(r.pid) && /localtests/.test(ps(r.pid)));
}

function harnessProcesses(iid) {
  const p = pathsOf(iid);
  const out = [];
  for (const name of HARNESS_NAMES) {
    const s = readJson(path.join(p.run, name, 'harness', 'servers.json'));
    if (!s) continue;
    for (const [kind, pid, port] of [['webpack', s.webpackPid, s.fePort], ['django', s.djangoPid, s.bePort]]) {
      if (!running(pid)) continue;
      const cwd = H.pidCwd(pid);
      // A recycled pid is not ours: only a process standing in this run's dir is.
      if (cwd && inside(cwd, p.run)) out.push({ iid, kind, pid, port: port || null, dir: name });
    }
  }
  const r = readJson(p.resources);
  for (const pid of (r && r.cypressPgids) || []) {
    if (running(pid) && /cypress/i.test(ps(pid))) out.push({ iid, kind: 'cypress', pid, port: null, dir: null });
  }
  return out;
}

function worktreesOf(iid) {
  const p = pathsOf(iid);
  return WT_NAMES.map((name) => path.join(p.run, name)).filter((w) => fs.existsSync(w)).map((w) => ({
    iid, name: path.basename(w), path: w, head: git(['rev-parse', 'HEAD'], w, true),
  }));
}

async function status() {
  const d = desk();
  const errors = [];
  let dbs = [];
  try {
    if (!d.dbPrefix) throw new LtError('E_CONFIG', 'localTests.dbPrefix is unusable');
    dbs = listOurDbs(d).map((name) => ({ name, ...parseOurDb(name, d.dbPrefix) }));
  } catch (err) { errors.push(`databases: ${err.message}`); }
  const iids = runIids();
  const processes = iids.flatMap(harnessProcesses);
  for (const port of [d.ports.be, d.ports.fe].filter(Boolean)) {
    const pid = H.listenerPid(port);
    if (!pid) continue;
    const cwd = H.pidCwd(pid);
    const ours = Boolean(cwd) && iids.some((i) => inside(cwd, pathsOf(i).run));
    processes.push({ iid: null, kind: 'listener', pid, port, cwd: cwd || null, ours });
  }
  const runs = iids.filter((i) => fs.existsSync(pathsOf(i).resources)).map((i) => ({ iid: i, live: liveRun(i), ...readJson(pathsOf(i).resources, {}) }));
  return { dbs, worktrees: iids.flatMap(worktreesOf), processes, runs, errors };
}

/**
 * Release whatever runs left behind, for every ticket not in --keep. A run whose
 * resources file names a live localtests process is always skipped. --keep must list
 * every ticket a conductor has in flight: a scope session's `wsa` has no process to
 * show it is in use.
 *
 * Copies are found by name on the whole server, so they may belong to another Oneshot
 * home's live run, which this home's state/runs knows nothing of. A copy anything is
 * still connected to is therefore left alone (skipped, with why), and the drop is a
 * plain DROP, never WITH (FORCE): a session that arrives in between makes it fail, not
 * a live run lose its database.
 */
async function gc(opts) {
  const d = desk();
  const dry = Boolean(opts['dry-run']);
  const keep = new Set(String(typeof opts.keep === 'string' ? opts.keep : '').split(',').map((s) => s.trim()).filter(Boolean).map(Number));
  const out = { dryRun: dry, dropped: [], removed: [], killed: [], skipped: [], errors: [] };
  const iids = runIids();
  const live = new Set(iids.filter(liveRun));
  const spare = (iid) => keep.has(iid) || live.has(iid);
  for (const iid of live) if (!keep.has(iid)) out.skipped.push({ iid, why: 'a local-tests run is still running for it' });

  const stopped = new Set();
  for (const iid of iids.filter((i) => !spare(i))) {
    const procs = harnessProcesses(iid);
    if (!dry) stopPids(procs.map((x) => x.pid));
    if (procs.length) stopped.add(iid);
    out.killed.push(...procs);
    for (const name of HARNESS_NAMES) if (!dry) fs.rmSync(path.join(pathsOf(iid).run, name, 'harness', 'servers.json'), { force: true });
  }

  try {
    if (!d.dbPrefix) throw new LtError('E_CONFIG', 'localTests.dbPrefix is unusable');
    for (const name of listOurDbs(d)) {
      const { iid } = parseOurDb(name, d.dbPrefix);
      if (spare(iid)) continue;
      try {
        // A Django just stopped above takes a moment to let its connections go.
        let sessions = sessionsOn(d, name);
        const until = Date.now() + (stopped.has(iid) && !dry ? 5000 : 0);
        while (sessions > 0 && Date.now() < until) { sleepSync(500); sessions = sessionsOn(d, name); }
        if (sessions !== 0) {
          out.skipped.push({ iid, db: name, why: Number.isNaN(sessions) ? 'the server did not say whether anything is connected to it' : `${sessions} session(s) are connected to it` });
          continue;
        }
        if (!dry) dropDb(d, name, { force: false });
        out.dropped.push(name);
      } catch (err) { out.errors.push(`${name}: ${err.message}`); }
    }
  } catch (err) { out.errors.push(`databases: ${err.message}`); }

  for (const iid of iids.filter((i) => !spare(i))) {
    let clean = true;
    for (const w of worktreesOf(iid)) {
      try {
        if (!dry && !removeWorktree(w.path)) throw new Error('still there after git worktree remove');
        out.removed.push(w.path);
      } catch (err) { clean = false; out.errors.push(`${w.path}: ${err.message}`); }
    }
    if (!dry && clean) fs.rmSync(pathsOf(iid).resources, { force: true });
  }
  return out;
}

/* ------------------------------------------------------------------ cli */

const USAGE = `localtests.cjs — the local automation (Cypress) run

  prepare-scope --iid N [--automation-ref REF]
        throwaway automation worktree at state/runs/N/wsa (hooks off, node_modules linked)
  capture --iid N
        save wsa's edits as artifacts/local-tests/temporary-changes.patch, check them
        against allowedPaths and for weakened tests, then remove wsa
  run --iid N --worktree <ticket worktree> --ref <ticket sha> --specs-file <json>
      [--patch <file>] [--patch-sha <sha>] [--automation-sha <sha>] [--base <ref>] [--deadline-min M]
      [--until <epoch ms>]
        copy the baseline DB, build the ticket's app, run the specs, retry the failures
        once, re-run what failed twice on --base (its own copy), clean everything up;
        prints LocalTestsRun (exit 0 even when tests fail). --until is the caller's own
        deadline: budgets are cut to fit before it, and the base re-run is skipped when
        it would not.
  gc [--keep N,N] [--dry-run]
        drop leftover copies, worktrees and servers of every ticket not kept
  status
        what is held right now

stdout is one JSON object; errors are {code, message, hint} with a non-zero exit.
Environment: ONESHOT_LOCAL_TESTS_REPO, _CREDS, _BASELINE_DB, _PG_HOST, _PG_PORT, _PG_USER,
             ONESHOT_LOCAL_TESTS_PORT (8030), ONESHOT_LOCAL_TESTS_FE_PORT (9030),
             ONESHOT_SEED_FROM, WORK_REPO, ONESHOT_HOME`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parse(rest);
  // Every value in the credentials file and every secret-named variable becomes ***,
  // wherever in the object it ended up — a test's error, a reason, a note, a hint.
  const print = (o) => process.stdout.write(`${JSON.stringify(redact(o), null, 2)}\n`);
  try {
    switch (cmd) {
      case 'prepare-scope': print(await prepareScope(opts)); break;
      case 'capture': print(await capture(opts)); break;
      case 'run': {
        installSignalHandlers();
        const r = await runCmd(opts);
        if (ACTIVE) ACTIVE.printed = true;
        print(r);
        break;
      }
      case 'gc': print(await gc(opts)); break;
      case 'status': print(await status()); break;
      case undefined: case 'help': case '--help':
        console.error(USAGE);
        print({ commands: ['prepare-scope', 'capture', 'run', 'gc', 'status'] });
        break;
      default:
        throw new LtError('E_ARGS', `unknown command ${JSON.stringify(cmd)}`, 'prepare-scope | capture | run | gc | status');
    }
  } catch (err) {
    const o = err instanceof LtError || err instanceof H.HarnessError ? err.toJSON()
      : { code: 'E_UNKNOWN', message: String((err && err.message) || err), hint: null };
    if (LAST_CLEANUP && !LAST_CLEANUP.ok) {
      o.hint = `${o.hint ? `${o.hint} ` : ''}Cleanup incomplete (${LAST_CLEANUP.failed.join('; ')}) — run gc.`;
    }
    print(o);
    process.exitCode = 1;
  }
}

module.exports = {
  // pure helpers, for src/lib/localtests-cli.test.ts
  parseDotenv, settingsFrom, dbName, dbNameProblem, parseOurDb, nextSeq, isAllowedPath,
  diffFiles, patchAddedFiles, weakenedFindings, parseMochawesome, assembleResults, applyBaseResults,
  applyRetryResults, cacheKey, mergeEnv, rewriteLocalSettings, guardProblem, missingDeps, semverSatisfies,
  depDrift, globEscape, specProblem, parseSpecs, statusSpecs, isOurWorktreePath, sanitizeStale,
  scrubEnv, secretValuesFrom, redactWith, webpackReadiness, portHolderIsOurs, runsDir, LtError,
  WT_NAMES, MAX_BASE_RERUN_SPECS, LT_BROKER, BASE_RERUN_NEEDS_MS,
};
if (require.main === module) main();

#!/usr/bin/env node
/**
 * The deterministic browser harness.
 *
 * WHY THIS EXISTS
 * ---------------
 * Bringing this app up, logging into it and finding a module are facts about the
 * repository, not judgements. Before this file they were rediscovered by a language
 * model on every phase of every run: across the six ui-evidence sessions on disk,
 * 47-86% of the wall clock went to rebooting a server the previous phase had killed,
 * and three of them died at their turn cap before taking a screenshot. verify spent
 * roughly half of every session on the same ground.
 *
 * Everything here is therefore mechanical and reports a NAMED ERROR instead of failing
 * in a way that invites a model to start improvising. Every non-obvious step carries the
 * evidence that made it necessary.
 *
 * THE APP'S REAL TOPOLOGY (verified, and not what the old prompts claimed)
 * -----------------------------------------------------------------------
 *   - It is TWO processes. `npm start` is webpack-dev-server ONLY
 *     (package.json "start" -> frontend/scripts/start.js). Django is separate.
 *   - You navigate to the DJANGO origin for everything. hrdb/urls.py:93 is a catch-all
 *     (`re_path(r"^.*$", index)`) that serves the SPA for every frontend route, so one
 *     port answers for the whole app. The webpack port is never navigated to; it only
 *     serves the bundle that Django's template points at.
 *   - Django renders templates/index.html, whose {% render_entrypoint %} reads
 *     static/webpack-entrypoints.dev.json (checkouts older than the app's 2026-09-23
 *     chunk split use {% render_bundle %} and static/webpack-stats.dev.json instead).
 *     Webpack writes either file with an ABSOLUTE publicPath taken from
 *     frontend/config/localPaths.js (`http://localhost:3000/`). So moving webpack off
 *     3000 requires patching that file, or the browser fetches the bundle from a port
 *     with nothing on it.
 *   - frontend/src/constants/config.js pins `apiUrl` to `http://localhost:8000/`. The
 *     SPA calls the API at that absolute URL, so it must name the Django port we lease.
 *
 * BOTH FILES ARE MANDATORY, but they are handled differently because they belong to
 * different owners. localPaths.js is TRACKED, so it is patched in place and marked
 * --skip-worktree, which is what stops a stray `git add -A` in a phase from committing
 * a machine-local port. constants/config.js is GITIGNORED and seed-copied from a
 * developer's checkout, so it is composed from the repo's own config.example.js
 * instead — see composeConfigJs().
 *
 *   - Django serves templates through ManifestStaticFilesStorage with DEBUG off, so
 *     staticfiles/staticfiles.json must exist before the first request or every route
 *     answers 500. See collectStatic().
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync, execFileSync } = require('child_process');

const ONESHOT_HOME = process.env.ONESHOT_HOME || path.resolve(__dirname, '../../..');

/* ------------------------------------------------------------------ errors */

/**
 * A closed set of codes. A phase that gets one of these knows what happened without
 * reading a stack trace, which is the difference between "report it" and "start
 * improvising a fix" — the behaviour that burned the turn budget in runs 16, 21 and 24.
 */
const CODES = [
  'E_NO_WORKTREE', 'E_NO_VENV', 'E_NO_NODE_MODULES', 'E_NO_SEED_COPIES',
  'E_DOTENV_SHADOW', 'E_DB_UNREACHABLE', 'E_PORT_BUSY_FOREIGN', 'E_PORT_DRIFT',
  'E_PATCH_FAILED', 'E_DJANGO_DEAD', 'E_DJANGO_5XX', 'E_COLLECTSTATIC',
  'E_WEBPACK_DEAD', 'E_BUNDLE_UNREACHABLE',
  'E_NO_CREDENTIALS', 'E_LOGIN_FAILED', 'E_LOGIN_2FA', 'E_TRIAL_EXPIRED',
  'E_MODULE_UNKNOWN', 'E_MODULE_TIMEOUT', 'E_NOT_UP', 'E_PLAYWRIGHT_MISSING',
  'E_SELECTOR_EMPTY',
];

class HarnessError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint || null;
    if (!CODES.includes(code)) this.code = 'E_NOT_UP';
  }
  toJSON() { return { code: this.code, message: this.message, hint: this.hint }; }
}

const log = (...a) => console.error('[harness]', ...a);

/* ------------------------------------------------------------------ paths */

/**
 * Playwright is installed in the Oneshot repo, never in a worktree (the worktree's
 * node_modules is a symlink into the work repo, which does not have it). phase.ts sets
 * NODE_PATH, but an env var is a promise and this is a check: resolve structurally so a
 * missing install is one clear error rather than a MODULE_NOT_FOUND a phase will try to
 * npm-install its way out of — which would rewrite the shared node_modules for every
 * other worktree on the machine.
 */
function requirePlaywright() {
  const candidates = [__dirname, path.join(ONESHOT_HOME, 'node_modules'), ONESHOT_HOME];
  try {
    return require(require.resolve('playwright', { paths: candidates }));
  } catch (err) {
    throw new HarnessError(
      'E_PLAYWRIGHT_MISSING',
      `playwright could not be resolved from ${candidates.join(', ')}`,
      'Run `npm install` in the Oneshot repo. Never npm install inside a worktree.',
    );
  }
}

function runDir() {
  if (process.env.ONESHOT_RUN_DIR) return process.env.ONESHOT_RUN_DIR;
  const iid = process.env.ONESHOT_IID;
  if (!iid) return path.join(ONESHOT_HOME, 'state', 'runs', 'adhoc');
  return path.join(ONESHOT_HOME, 'state', 'runs', String(iid));
}

/**
 * Everything the harness writes goes under state/runs/<iid>/harness/.
 *
 * That directory is already inside the write scope of verify, ui-evidence AND qa
 * (config/phases.json gives all three `"writes": ["run"]`, and hooks/write-scope.cjs
 * maps "run" to state/runs/<iid>). Four of six ui-evidence sessions were denied writing
 * to <worktree>/.verify-scratch/, which is what the old prompt told them to use.
 */
const H = () => path.join(runDir(), 'harness');
const ART = () => path.join(runDir(), 'artifacts');
const p = {
  appEnv: () => path.join(H(), 'app-env.json'),
  servers: () => path.join(H(), 'servers.json'),
  storage: () => path.join(H(), 'storage-state.json'),
  results: () => path.join(H(), 'results.json'),
  django: () => path.join(H(), 'django.log'),
  webpack: () => path.join(H(), 'webpack.log'),
};

const ensure = (d) => fs.mkdirSync(d, { recursive: true });
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, o) => { ensure(path.dirname(f)); fs.writeFileSync(f, JSON.stringify(o, null, 2)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function registry() {
  return readJson(path.join(__dirname, 'modules.json'));
}

/* ------------------------------------------------------------------ credentials */

/**
 * Credentials arrive as env var NAMES, never interpolated into a prompt.
 *
 * The old verify prompt pasted the literal password into its own text, which put it in
 * every transcript and on the telemetry board. Nothing here ever logs a secret; the
 * app-env.json this writes records the env var NAME it read, not the value.
 */
function credentials() {
  const raw = process.env.ONESHOT_TEST_LOGIN || '';
  const idx = raw.indexOf(':');
  if (idx < 1) {
    throw new HarnessError(
      'E_NO_CREDENTIALS',
      'ONESHOT_TEST_LOGIN is unset or not in email:password form',
      'Set ONESHOT_TEST_LOGIN=<email>:<password> in the Oneshot .env (gitignored).',
    );
  }
  // Split on the FIRST colon only: a password may legitimately contain one.
  return { email: raw.slice(0, idx), password: raw.slice(idx + 1) };
}

/* ------------------------------------------------------------------ preflight */

function preflight(wt) {
  if (!fs.existsSync(path.join(wt, '.git'))) {
    throw new HarnessError('E_NO_WORKTREE', `${wt} is not a git worktree`);
  }
  if (!fs.existsSync(path.join(wt, 'venv/bin/python'))) {
    throw new HarnessError('E_NO_VENV', `${wt}/venv/bin/python is missing`,
      'ONESHOT_SEED_LINKS did not seed venv into this worktree.');
  }
  if (!fs.existsSync(path.join(wt, 'node_modules/react-dev-utils'))) {
    throw new HarnessError('E_NO_NODE_MODULES', `${wt}/node_modules is not seeded`,
      'ONESHOT_SEED_LINKS did not link node_modules. Do NOT npm install here.');
  }
  for (const f of ['frontend/src/constants/config.js', 'hrdb/local_settings.py']) {
    if (!fs.existsSync(path.join(wt, f))) {
      throw new HarnessError('E_NO_SEED_COPIES', `${wt}/${f} is missing`,
        'ONESHOT_SEED_COPIES did not land. The app cannot start without it.');
    }
  }
  // frontend/config/env.js loads a worktree .env and would silently override PORT.
  if (fs.existsSync(path.join(wt, '.env'))) {
    throw new HarnessError('E_DOTENV_SHADOW', `${wt}/.env exists and will override PORT`,
      'Remove it: frontend/config/env.js loads it and shadows the leased port.');
  }
}

/**
 * The venv has an import-order conflict: a process that touches psycopg2 before ssl and
 * hashlib are initialised computes corrupted password hashes. Every python this harness
 * starts opens with the shim, not just runserver — a readiness probe that skips it can
 * corrupt an authentication check and make a good password look wrong.
 */
const SHIM = 'import ssl, hashlib\nimport sys\n';

function py(wt, src, opts = {}) {
  return spawnSync(path.join(wt, 'venv/bin/python'), ['-c', SHIM + src], {
    cwd: wt, encoding: 'utf8', timeout: opts.timeout || 60000,
    env: { ...process.env, DJANGO_SETTINGS_MODULE: 'hrdb.settings', PYTHONUNBUFFERED: '1' },
  });
}

/**
 * The staticfiles manifest has to exist before Django serves its first template.
 *
 * hrdb/config.py sets DEBUG = False and hrdb/settings.py installs
 * ManifestStaticFilesStorage UNCONDITIONALLY — it is not gated on DEBUG — so every
 * `{% static %}` tag resolves through staticfiles.json. Without that file Django
 * raises `ValueError: Missing staticfiles manifest entry`, which it serves as a bare
 * 500 on EVERY route including /admin/login/. The process is perfectly healthy; it
 * just cannot render anything.
 *
 * `staticfiles/` is gitignored (.gitignore:110), so a fresh worktree never inherits
 * one, and this harness starts Django with `runserver` directly — skipping the
 * collectstatic that the app repo's own app-entrypoint.sh:5 runs before gunicorn.
 * The result was a bring-up that could not succeed on any machine, reported as
 * E_DJANGO_DEAD because waitDjango could not tell a 500 from a corpse.
 *
 * seedWorktree() carries a warning that names `staticfiles` and this exact symptom,
 * but ONESHOT_SEED_LINKS does not list it and a seed repo has no staticfiles/ of its
 * own to link, so nothing ever provisioned it. Collecting per worktree is what the
 * app itself does and is self-maintaining: a branch that adds a static asset gets a
 * manifest containing it, which a symlink to one shared directory could not give.
 */
function needsCollectstatic(wt) {
  return !fs.existsSync(path.join(wt, 'staticfiles/staticfiles.json'));
}

/**
 * Collect once per worktree. It is ~900 files and tens of seconds, so re-running it
 * on every `ensure` would tax every phase for a file that does not change.
 */
function collectStatic(wt) {
  if (!needsCollectstatic(wt)) return false;
  const r = py(wt, `
from django.core.management import execute_from_command_line
sys.argv = ['manage.py', 'collectstatic', '--noinput', '--verbosity', '0']
execute_from_command_line(sys.argv)
`, { timeout: 300000 });
  if (r.status !== 0 || needsCollectstatic(wt)) {
    throw new HarnessError('E_COLLECTSTATIC',
      'collectstatic did not produce staticfiles/staticfiles.json',
      String(r.stderr || r.stdout || '').trim().slice(-400)
        || 'Django would 500 on every template that uses {% static %}.');
  }
  return true;
}

/**
 * Which integrations this environment cannot exercise, asked of the app's own settings.
 *
 * A phase that has to reproduce a bug needs to know what it cannot reach BEFORE it
 * starts, not after. On ticket 256 research spent 14 of its 123 turns — 12% of the
 * input and 37% of everything it wrote — establishing that the local environment has
 * no Odoo, which is the same answer on every run, for every ticket, on every machine.
 * Reading it from settings costs one interpreter start.
 *
 * DERIVED, never a list maintained here. Naming integrations in this file would make
 * it a place where facts about one app go stale; the app already states them:
 *
 *   - `USE_<NAME>` is False, and `<NAME>_*` settings exist. The second half is what
 *     separates an integration from Django's own booleans — USE_TZ, USE_I18N and
 *     USE_X_FORWARDED_HOST own no namespace, so they never appear.
 *   - `<NAME>_URL|HOST|ENDPOINT|DSN|API_KEY|TOKEN` is empty, equals its own setting
 *     name, contains it (`ODOO_URL = "ODOO_URL_WITH_XMLRPC"`), or reads as a
 *     placeholder. A credential nobody filled in is an integration nobody can reach.
 *
 * Advisory, never a blocker: any failure here returns [] and the run proceeds exactly
 * as it did before this existed. Not being sure what is disabled is not a reason to
 * stop a healthy app from coming up.
 */
function disabledIntegrations(wt) {
  const r = py(wt, `
import json, re, django
django.setup()
from django.conf import settings

PLACEHOLDER = re.compile(r'REPLACE_ME|CHANGE_?ME|<[a-z-]+>|your-.*-here', re.I)
ENDPOINT = re.compile(r'^([A-Z0-9]+)_(URL|HOST|ENDPOINT|DSN|API_KEY|TOKEN)$')
FLAG = re.compile(r'^USE_([A-Z0-9]+(?:_[A-Z0-9]+)*)$')

names = [n for n in dir(settings) if n.isupper()]

def value(n):
    try:
        return getattr(settings, n)
    except Exception:
        return None

def unset(n, v):
    if v == '':
        return 'empty'
    if isinstance(v, str) and (v == n or n in v or PLACEHOLDER.search(v)):
        return 'a placeholder'
    return None

found = {}
for n in names:
    m = FLAG.match(n)
    if m and value(n) is False:
        who = m.group(1)
        if any(o != n and o.startswith(who + '_') for o in names):
            found[who] = n + ' is False'
for n in names:
    m = ENDPOINT.match(n)
    if m:
        reason = unset(n, value(n))
        if reason:
            found.setdefault(m.group(1), n + ' is ' + reason)

out = [{"name": k, "why": v} for k, v in sorted(found.items())]
print("ONESHOT_INTEGRATIONS " + json.dumps(out))
`, { timeout: 120000 });
  const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('ONESHOT_INTEGRATIONS '));
  if (!line) {
    log('could not read integration status; continuing without it');
    return [];
  }
  try { return JSON.parse(line.slice('ONESHOT_INTEGRATIONS '.length)); } catch { return []; }
}

function checkDb(wt) {
  const r = py(wt, `
import django; django.setup()
from django.db import connection
connection.ensure_connection()
print("DB_OK")
`);
  if (!String(r.stdout || '').includes('DB_OK')) {
    throw new HarnessError('E_DB_UNREACHABLE',
      'Django cannot reach the database',
      (String(r.stderr || '').trim().split('\n').pop() || '').slice(0, 200));
  }
}

/* ------------------------------------------------------------------ ports */

/** Who is listening, and is it OURS? A 200 does not prove the server is this checkout. */
function listenerPid(port) {
  const r = spawnSync('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf8' });
  const pid = String(r.stdout || '').trim().split('\n')[0];
  return pid ? Number(pid) : null;
}

function pidCwd(pid) {
  const r = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
  const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('n'));
  return line ? line.slice(1) : null;
}

/**
 * Refuse a port held by a foreign checkout.
 *
 * This is the check that was missing when a phase drove a server belonging to a
 * different worktree: every value it recorded was about the wrong code while reading
 * green. Confirming HTTP 200 is not confirming it is *your* build.
 */
function assertPortFreeOrOurs(port, wt, what) {
  const pid = listenerPid(port);
  if (!pid) return null;
  const cwd = pidCwd(pid);
  if (cwd && path.resolve(cwd) === path.resolve(wt)) return pid;
  throw new HarnessError('E_PORT_BUSY_FOREIGN',
    `port ${port} (${what}) is held by pid ${pid} running from ${cwd || 'an unknown cwd'}, not ${wt}`,
    'Free the port or lease another. Never drive a server you did not start.');
}

/* ------------------------------------------------------------------ patches */

/**
 * Patch, then mark --skip-worktree so a phase's `git add -A` cannot commit a
 * machine-local port into the branch.
 *
 * That guard is load-bearing for localPaths.js, which IS tracked. It is a no-op for
 * constants/config.js, which the app repo gitignores: update-index fails on a path it
 * does not track, and the result is deliberately not checked, because an ignored file
 * was never at risk of being committed in the first place.
 */
function patchFile(wt, rel, re, replacement, code) {
  const abs = path.join(wt, rel);
  const before = fs.readFileSync(abs, 'utf8');
  const hits = before.match(re);
  if (!hits || hits.length !== 1) {
    throw new HarnessError('E_PATCH_FAILED',
      `${rel}: expected exactly 1 match for ${re}, found ${hits ? hits.length : 0}`,
      `${code} — the file's shape changed; the harness will not guess.`);
  }
  const after = before.replace(re, replacement);
  if (after !== before) fs.writeFileSync(abs, after);
  spawnSync('git', ['update-index', '--skip-worktree', rel], { cwd: wt });
  return before !== after;
}

const EXPORT_RE = /^export const ([A-Za-z_$][\w$]*)\s*=/;

/**
 * config.js is COMPOSED from the app repo's committed template, not patched in place.
 *
 * This file is gitignored in the app repo and arrives by verbatim copy from whatever
 * checkout ONESHOT_SEED_COPIES points at, so its contents belong to a developer's
 * machine and not to us. Patching one line of it meant every other line was accepted
 * on trust — including lines that were not there at all. A seed missing
 * `export const SENTRY_DSN` (frontend/src/sentryConfig.js:4 imports it) produced a
 * correct apiUrl, a healthy Django, and a frontend that never compiled.
 *
 * Widening the apiUrl regex to accept either quote style fixed the formatting of one
 * line and left that whole class open. config.example.js is TRACKED, sits at the repo
 * root, and is the file the app's own README points a new developer at, so it follows
 * what the code imports. Composing from it makes every key present by construction and
 * makes apiUrl something we WRITE rather than something we hope to match — which
 * retires the regex, and with it E_PATCH_FAILED on this file.
 *
 * The developer's values are still honoured: any key their copy defines wins over the
 * template's placeholder, so a real googleApiClientId or USE_CALENDAR_API survives.
 * Only keys they are missing come from the template, and only apiUrl is forced.
 */
function composeConfigJs(wt, bePort) {
  const rel = 'frontend/src/constants/config.js';
  const abs = path.join(wt, rel);
  const template = path.join(wt, 'config.example.js');
  const apiUrlLine = `export const apiUrl = 'http://localhost:${bePort}/';`;

  // An app repo without the template is not this repo; fall back to the old in-place
  // patch rather than inventing a config.js for a checkout we do not understand.
  if (!fs.existsSync(template)) {
    return patchFile(wt, rel, /export const apiUrl = ['"][^'"]*['"];/, apiUrlLine, 'apiUrl');
  }

  const before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  const local = new Map();
  for (const line of before.split('\n')) {
    const m = line.match(EXPORT_RE);
    if (m) local.set(m[1], line);
  }

  const lines = fs.readFileSync(template, 'utf8').split('\n');
  if (!lines.some((l) => (l.match(EXPORT_RE) || [])[1] === 'apiUrl')) {
    throw new HarnessError('E_PATCH_FAILED',
      'config.example.js declares no apiUrl export',
      'apiUrl — the template\'s shape changed; the harness will not guess.');
  }
  const after = `${lines.map((line) => {
    const key = (line.match(EXPORT_RE) || [])[1];
    if (!key) return line;
    if (key === 'apiUrl') return apiUrlLine;
    return local.has(key) ? local.get(key) : line;
  }).join('\n').replace(/\n+$/, '')}\n`;

  if (after !== before) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, after);
  }
  // A no-op on this path — the app repo ignores the file — but harmless, and it keeps
  // the two patched files symmetrical if the app repo ever tracks it.
  spawnSync('git', ['update-index', '--skip-worktree', rel], { cwd: wt });
  return after !== before;
}

function applyPatches(wt, bePort, fePort) {
  const a = patchFile(wt, 'frontend/config/localPaths.js',
    /const LOCAL_PUBLIC_URL = '[^']*';/,
    `const LOCAL_PUBLIC_URL = 'http://localhost:${fePort}';`, 'localPaths');
  const b = composeConfigJs(wt, bePort);
  return { localPaths: a, apiUrl: b };
}

/* ------------------------------------------------------------------ processes */

function spawnLogged(cmd, args, opts, logFile) {
  ensure(path.dirname(logFile));
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(cmd, args, { ...opts, detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  return child.pid;
}

/**
 * Start Django on the WSGI dev server, not the Channels ASGI one.
 *
 * settings.py sets ASGI_APPLICATION, so a bare `runserver` is Channels' ASGI server.
 * That server serves curl fine but wedges under a real browser: Chromium holds several
 * keep-alive connections per origin, and once its slots are gone the process keeps its
 * pid and its listening socket while answering nothing at all. Measured here — after one
 * authenticated page load, /home/, /login/ AND /admin/login/ all stopped responding, and
 * a phase watching that would see a live process serving nothing. It is the signature of
 * the four-hour verify wedge in run 18.
 *
 * `--noasgi` falls back to Django's threaded WSGI dev server, which handles keep-alive
 * correctly. The only thing lost is websockets, which the browser context blocks anyway
 * and which nothing under test needs.
 */
function startDjango(wt, port) {
  const src = SHIM +
    `sys.argv = ['manage.py', 'runserver', '127.0.0.1:${port}', '--noreload', '--noasgi']\n` +
    `exec(compile(open('manage.py').read(), 'manage.py', 'exec'))\n`;
  return spawnLogged(path.join(wt, 'venv/bin/python'), ['-c', src], {
    cwd: wt,
    env: { ...process.env, DJANGO_SETTINGS_MODULE: 'hrdb.settings', PYTHONUNBUFFERED: '1' },
  }, p.django());
}

/**
 * CI=true is load-bearing.
 *
 * frontend/scripts/start.js:139-145 registers `process.stdin.on('end', ... exit())`
 * unless CI === 'true'. A detached start has a closed stdin, so without it webpack exits
 * within seconds and the phase then polls a dead port. That is the failure behind the
 * 3.4-minute dead poll in run 20 and the repeated restarts in run 16. The
 * `tail -f /dev/null | npm start` trick in the old skill worked around it; this is the fix.
 */
function startWebpack(wt, port) {
  return spawnLogged('npm', ['start'], {
    cwd: wt,
    env: { ...process.env, PORT: String(port), CI: 'true', BROWSER: 'none' },
  }, p.webpack());
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function httpStatus(url, timeoutMs = 5000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'manual' });
    return res.status;
  } catch { return 0; } finally { clearTimeout(t); }
}

/**
 * Probe Django on a page that does NOT render the React bundle.
 *
 * `/login/` goes through templates/index.html, which raises until webpack has written
 * its manifest (ImproperlyConfigured for a missing static/webpack-entrypoints.dev.json;
 * WebpackLoaderBadStatsError for webpack-stats.dev.json on an older checkout).
 * Probing it means a perfectly healthy Django reads as dead for the whole first compile,
 * which is minutes. The admin login page is plain Django templating and answers as soon
 * as the process is actually serving, which is the thing this check is for.
 */
/**
 * A 500 is not a corpse, and calling it one costs a whole phase.
 *
 * This loop used to accept only 200 and report every other outcome as
 * E_DJANGO_DEAD / "Django did not answer". A process answering 500 on every route is
 * the opposite of not answering: it is up, reachable, and telling you what is wrong in
 * a traceback sitting in django.log. Reported as dead, it invites the phase to retry
 * the bring-up — which cannot help, because nothing about it was transient — and then
 * to go looking for a cause somewhere else entirely. On ticket 256 that turned a
 * one-line missing-manifest error into an inconclusive reproduction and a hunt through
 * an unrelated dependency.
 *
 * Three consecutive 5xx is the cutoff, not one: the first request can land in the
 * gap between the socket binding and the app being ready. Nothing that answers 5xx
 * three times over six seconds recovers on its own — runserver has no lazy
 * initialisation left to do by then.
 */
const DJANGO_5XX_STRIKES = 3;

async function waitDjango(port, pid, budgetMs) {
  const url = `http://localhost:${port}/admin/login/`;
  const deadline = Date.now() + budgetMs;
  let last = 0;
  let strikes = 0;
  while (Date.now() < deadline) {
    if (!alive(pid)) {
      throw new HarnessError('E_DJANGO_DEAD', 'the Django process exited during startup',
        `Last lines of ${p.django()}: ${tail(p.django(), 6)}`);
    }
    last = await httpStatus(url);
    if (last === 200) return true;
    strikes = last >= 500 ? strikes + 1 : 0;
    if (strikes >= DJANGO_5XX_STRIKES) {
      throw new HarnessError('E_DJANGO_5XX',
        `Django is up on ${port} but answers ${last} on ${url}`,
        `The process is alive and serving — this is an application error, not a startup `
        + `failure, so retrying the bring-up will not help. ${p.django()}: ${tail(p.django(), 12)}`);
    }
    await sleep(2000);
  }
  throw new HarnessError('E_DJANGO_DEAD',
    `Django did not answer on ${port} within ${Math.round(budgetMs / 1000)}s`
    + `${last ? ` (last status ${last})` : ''}`, tail(p.django(), 6));
}

function tail(file, n) {
  try { return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-n).join(' | ').slice(0, 400); }
  catch { return '(no log)'; }
}

/**
 * The two manifests Django can read the bundle's script tags from, relative to the
 * worktree. Which one a checkout writes depends on its webpack config, not on us.
 */
const ENTRYPOINTS_FILE = 'static/webpack-entrypoints.dev.json';
const STATS_FILE = 'static/webpack-stats.dev.json';

/**
 * The verdict of the LATEST compile in the webpack log: 'building', 'compiled', 'failed'
 * or null when no compile has started yet.
 *
 * The markers are react-dev-utils' own lines (WebpackDevServerUtils.createCompiler):
 * `Starting the development server...` before the first build, `Compiling...` on every
 * rebuild, then exactly one of `Compiled successfully!`, `Compiled with warnings.` or
 * `Failed to compile.` when it ends. Only the last marker counts — an earlier build's
 * result is history, and a `Compiling...` after it means the current build is not done.
 * Matched only at the start of a line, colour codes stripped, so a warning that quotes
 * one of these words mid-sentence cannot flip the verdict.
 */
function compileVerdict(logText) {
  const lines = String(logText || '').replace(/\x1b\[[0-9;]*m/g, '').split('\n').map((l) => l.trim());
  let verdict = null;
  let at = -1;
  lines.forEach((line, i) => {
    if (/^(Compiling\.\.\.|Starting the development server)/.test(line)) { verdict = 'building'; at = i; }
    else if (/^Compiled (successfully|with warnings)/.test(line)) { verdict = 'compiled'; at = i; }
    else if (/^Failed to compile/.test(line)) { verdict = 'failed'; at = i; }
  });
  const errors = verdict === 'failed'
    ? lines.slice(at + 1).filter(Boolean).slice(0, 8).join(' | ').slice(0, 400)
    : '';
  return { verdict, errors };
}

/**
 * Is the bundle Django will point at finished, for the webpack started at `since`?
 *
 * Returns { state: 'ready' | 'building' | 'failed', via, detail }. Exported so that
 * app.cjs and localtests.cjs ask the same question this file does instead of keeping
 * their own copy of which file means "done" — that copy is how this went stale once.
 *
 * TWO SIGNALS, because the app changed its manifest under us:
 *
 *   - Older checkouts use webpack-bundle-tracker, which writes webpack-stats.dev.json
 *     TWICE per compile: {"status":"compiling"} the moment a build starts, then
 *     {"status":"done", chunks:{...}} when it finishes. django-webpack-loader reads that
 *     exact file and raises WebpackLoaderBadStatsError on anything but `done`, which
 *     Django serves as a bare 500. The file's own status is the whole answer.
 *
 *   - The app replaced that plugin on 2026-09-23 (d0fa609b4e, the ~500 KB chunk split)
 *     with its own EntrypointFilesPlugin, which writes webpack-entrypoints.dev.json as
 *     {hash, entrypoints} and carries NO status. It is written once, in webpack's `done`
 *     hook — which fires for a failed compile too — so the file existing says only that
 *     SOME compile ended. Waiting for a `status` that file never has is what failed every
 *     fresh worktree on current code: webpack logged `Compiled with warnings.` and the
 *     harness still gave up 20 minutes later with E_WEBPACK_DEAD.
 *
 * For the second shape the answer needs both halves: the manifest was written by THIS
 * webpack (mtime at or after `since`, so a file left by an earlier build or an earlier
 * ref does not count), and the log's latest compile verdict is `Compiled`. The plugin's
 * `done` tap is registered before react-dev-utils' own, so by the time the log says
 * `Compiled` the manifest has already been rewritten.
 *
 * The log alone was rejected once, rightly: a `Compiled successfully` from an EARLIER
 * build stays in the log, so a restart read as ready while the current build was still
 * running and every navigation took a 500. Both reasons are gone here — up() truncates
 * the log before it starts webpack, compileVerdict() reads only the LAST marker, and the
 * manifest must be fresh as well.
 *
 * The stats file gets the same freshness rule. A checkout that still writes it rewrites
 * it at the start of every build, so its behaviour is unchanged; a stale `done` left in a
 * reused worktree that has since moved to the entrypoints plugin would otherwise read as
 * ready while Django 500s for want of the other file.
 *
 * `since` is floored to the second: a filesystem that stores whole-second mtimes would
 * otherwise date a manifest written 300 ms after start as before it, forever.
 */
function bundleState(wt, opts = {}) {
  const since = Math.floor(Number(opts.since || 0) / 1000) * 1000;
  const logFile = opts.log || p.webpack();
  const fresh = (rel) => {
    const st = fs.statSync(path.join(wt, rel), { throwIfNoEntry: false });
    return Boolean(st && st.mtimeMs >= since);
  };

  if (fresh(STATS_FILE)) {
    const stats = readJson(path.join(wt, STATS_FILE));
    if (stats && stats.status === 'done') return { state: 'ready', via: STATS_FILE, detail: null };
    if (stats && stats.status === 'error') {
      return { state: 'failed', via: STATS_FILE, detail: String(stats.error || '').slice(0, 300) || null };
    }
  }

  const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  const { verdict, errors } = compileVerdict(logText);
  if (verdict === 'failed') return { state: 'failed', via: 'webpack log', detail: errors || null };
  if (verdict === 'compiled') {
    if (fresh(ENTRYPOINTS_FILE)) return { state: 'ready', via: ENTRYPOINTS_FILE, detail: null };
    return {
      state: 'building', via: 'webpack log',
      detail: `webpack logged a finished compile but wrote neither a fresh ${ENTRYPOINTS_FILE} `
        + `nor a "done" ${STATS_FILE}`,
    };
  }
  return { state: 'building', via: null, detail: null };
}

/**
 * When did this process start? The fallback for a caller that is waiting on a webpack
 * somebody else started (app.cjs joining a bring-up already in progress) and so has no
 * start time of its own to hand over. LC_ALL=C because `ps` localises lstart, and a
 * French month name is not a date Date.parse knows. 0 when it cannot tell, which drops
 * the freshness half of the check and leaves the log verdict to decide.
 */
function processStartedAt(pid) {
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)],
    { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  const t = Date.parse(String(r.stdout || '').trim());
  return Number.isFinite(t) ? t : 0;
}

/**
 * Wait until the bundle Django points at is finished — bundleState() says what that
 * means — never a port probe.
 *
 * Django's catch-all answers 200 for every path from the moment it boots, including
 * while the bundle is missing — which is why a curl check passed in run 24 while the page
 * was blank. A finished manifest plus a real fetch of the bundle URL it names
 * (assertBundleReachable) is the only pair that proves the app can actually render.
 *
 * `startedAt` is when THIS webpack was started; up() records it right before
 * startWebpack(). The timeout message keeps `did not reach status "done"`: localtests.cjs
 * matches that phrase to decide to keep waiting on a slow cold build.
 */
async function waitWebpack(wt, port, pid, budgetMs, startedAt) {
  const deadline = Date.now() + budgetMs;
  const since = Number.isFinite(Number(startedAt)) && Number(startedAt) > 0
    ? Number(startedAt) : processStartedAt(pid);
  let sawPort = false;
  let last = { state: 'building', via: null, detail: null };
  while (Date.now() < deadline) {
    if (!alive(pid)) {
      throw new HarnessError('E_WEBPACK_DEAD', 'the webpack process exited during startup',
        `Last lines of ${p.webpack()}: ${tail(p.webpack(), 8)}`);
    }

    // start.js:69 calls choosePort(), which refuses a busy port rather than drifting
    // silently — but the env can still put it somewhere we did not ask for. Assert once.
    if (!sawPort) {
      const logText = fs.existsSync(p.webpack()) ? fs.readFileSync(p.webpack(), 'utf8') : '';
      const m = logText.match(/webpack output is served from http:\/\/localhost:(\d+)/);
      if (m) {
        sawPort = true;
        if (Number(m[1]) !== Number(port)) {
          throw new HarnessError('E_PORT_DRIFT',
            `webpack is serving on ${m[1]} but we leased ${port}`,
            'The bundle URL in localPaths.js will not match. Free the port and retry.');
        }
      }
    }

    last = bundleState(wt, { since, log: p.webpack() });
    if (last.state === 'ready') return true;
    if (last.state === 'failed') {
      throw new HarnessError('E_WEBPACK_DEAD', 'webpack finished with a build error',
        last.detail || tail(p.webpack(), 8));
    }
    // Never sleep past the deadline: a short budget is a promise, not a suggestion.
    await sleep(Math.max(0, Math.min(2000, deadline - Date.now())));
  }
  throw new HarnessError('E_WEBPACK_DEAD',
    `webpack did not reach status "done" within ${Math.round(budgetMs / 60000)} min — no `
    + `finished compile with a fresh ${ENTRYPOINTS_FILE} or ${STATS_FILE}`,
    [last.detail, tail(p.webpack(), 8)].filter(Boolean).join(' — '));
}

/**
 * Prove the browser can actually fetch the bundle Django points at.
 *
 * The entrypoints manifest gives the page several script tags per entry, in load order
 * — the split vendor chunks (`vendors~main.chunk.js`) BEFORE the entry's own
 * `static/js/bundle.js` — next to Google's gtag loader at the top of the page. Every tag
 * is read and the entry bundle preferred, so the URL recorded in app-env.json is the
 * app's own code rather than whichever chunk happened to come first.
 */
async function assertBundleReachable(bePort) {
  const html = await (async () => {
    try { return await (await fetch(`http://localhost:${bePort}/login/`)).text(); } catch { return ''; }
  })();
  const srcs = [...html.matchAll(/<script\b[^>]*\ssrc="([^"]+)"/gi)].map((m) => m[1]);
  const src = srcs.find((s) => /bundle[^"]*\.js/i.test(s))
    || srcs.find((s) => /main[^"]*\.js$/i.test(s))
    || srcs.find((s) => /^http:\/\/localhost:\d+\/[^"]+\.js$/i.test(s));
  if (!src) {
    throw new HarnessError('E_BUNDLE_UNREACHABLE',
      'Django served /login/ but emitted no bundle script tag',
      `${ENTRYPOINTS_FILE} (or ${STATS_FILE} on an older checkout) is missing or stale. Check ${p.webpack()}`);
  }
  const url = src.startsWith('http') ? src : `http://localhost:${bePort}${src}`;
  const status = await httpStatus(url, 20000);
  if (status !== 200) {
    throw new HarnessError('E_BUNDLE_UNREACHABLE',
      `the bundle at ${url} answered ${status}`,
      'localPaths.js and the webpack port disagree.');
  }
  return url;
}

/* ------------------------------------------------------------------ up / down */

async function up(opts = {}) {
  const wt = opts.worktree || process.env.ONESHOT_WORKTREE || process.cwd();
  const bePort = Number(opts.bePort || process.env.ONESHOT_PORT || 8002);
  const fePort = Number(opts.fePort || process.env.ONESHOT_FE_PORT || bePort + 1000);
  ensure(H()); ensure(ART());

  preflight(wt);
  checkDb(wt);

  const existing = readJson(p.servers());
  if (existing && alive(existing.djangoPid) && alive(existing.webpackPid)
      && await httpStatus(`http://localhost:${existing.bePort}/admin/login/`) === 200) {
    log('already up, reusing', existing.bePort, existing.fePort);
    // Rebuild app-env.json rather than trusting it to exist: a previous attempt can
    // leave live servers behind after failing before it wrote the env file, and
    // returning null here is an E_NOT_UP three calls later that reads like the app
    // never started. Reuse must be as complete as a cold start.
    const cached = readJson(p.appEnv());
    if (cached) return cached;
    const rebuilt = await describeEnv(existing.worktree || wt, existing.bePort, existing.fePort);
    writeJson(p.appEnv(), rebuilt);
    return rebuilt;
  }

  assertPortFreeOrOurs(bePort, wt, 'django');
  assertPortFreeOrOurs(fePort, wt, 'webpack');

  const patched = applyPatches(wt, bePort, fePort);
  log('patched', JSON.stringify(patched));

  // Truncate the logs: readiness and every error hint read them, and a line left by a
  // previous attempt is worse than no line at all.
  ensure(H());
  for (const f of [p.django(), p.webpack()]) fs.writeFileSync(f, '');

  // Before the first request, not after: a manifest that appears late does not help a
  // process that has already cached an empty one at storage init.
  if (collectStatic(wt)) log('collected staticfiles');

  const djangoPid = startDjango(wt, bePort);
  // Right before the spawn, not after: a manifest this webpack writes must never date
  // from before the moment we say it started. waitWebpack() uses it to tell its own
  // manifest from one an earlier build left in the worktree.
  const webpackStartedAt = Date.now();
  const webpackPid = startWebpack(wt, fePort);
  writeJson(p.servers(), {
    djangoPid, webpackPid, bePort, fePort, worktree: wt, startedAt: Date.now(), webpackStartedAt,
  });
  log('django pid', djangoPid, 'webpack pid', webpackPid);

  await waitDjango(bePort, djangoPid, Number(opts.djangoTimeoutMs || 90000));
  log('django ready on', bePort);
  // The first compile is minutes on a cold cache; incremental is seconds. Silence is
  // not failure, so the budget is generous and the liveness check is the pid.
  await waitWebpack(wt, fePort, webpackPid, Number(opts.webpackTimeoutMs || 20 * 60000),
    webpackStartedAt);
  log('webpack compiled on', fePort);
  const bundleUrl = await assertBundleReachable(bePort);
  log('bundle reachable', bundleUrl);

  const env = await describeEnv(wt, bePort, fePort, bundleUrl);
  writeJson(p.appEnv(), env);
  return env;
}

/**
 * The environment contract handed to every later phase.
 *
 * `baseUrl` uses the hostname `localhost`, never the loopback IP: ALLOWED_HOSTS in
 * hrdb/local_settings.py does not carry the bare address, so http://127.0.0.1:<port>/
 * answers 400 from Django while the app is perfectly healthy. Django still BINDS to
 * 127.0.0.1 — binding and the Host header are different things, and conflating them
 * cost this harness its first run.
 */
async function describeEnv(wt, bePort, fePort, bundleUrl) {
  return {
    baseUrl: `http://localhost:${bePort}`,
    bePort, fePort, worktree: wt,
    bundleUrl: bundleUrl || await assertBundleReachable(bePort).catch(() => null),
    credentialEnv: 'ONESHOT_TEST_LOGIN',
    // What this environment CANNOT do, stated up front. A phase that needs one of
    // these can say so in one turn instead of discovering it in fourteen.
    disabledIntegrations: disabledIntegrations(wt),
    patchedFiles: ['frontend/config/localPaths.js', 'frontend/src/constants/config.js'],
    startedAt: new Date().toISOString(),
    logs: { django: p.django(), webpack: p.webpack() },
  };
}

function down() {
  const s = readJson(p.servers());
  if (!s) return { stopped: [] };
  const stopped = [];
  for (const [name, pid] of [['webpack', s.webpackPid], ['django', s.djangoPid]]) {
    if (!pid || !alive(pid)) continue;
    // Kill the PROCESS GROUP: npm start forks a node child that outlives its parent,
    // which is how 18001 was still held by a run that finished two days earlier.
    try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
    stopped.push({ name, pid });
  }
  fs.rmSync(p.servers(), { force: true });
  return { stopped };
}

async function status() {
  const s = readJson(p.servers());
  if (!s) return { up: false, reason: 'no servers.json' };
  const be = await httpStatus(`http://localhost:${s.bePort}/admin/login/`);
  return {
    up: alive(s.djangoPid) && alive(s.webpackPid) && be === 200,
    django: { pid: s.djangoPid, alive: alive(s.djangoPid), status: be },
    webpack: { pid: s.webpackPid, alive: alive(s.webpackPid) },
    bePort: s.bePort, fePort: s.fePort,
  };
}

/* ------------------------------------------------------------------ browser */

async function open(opts = {}) {
  const pw = requirePlaywright();
  const env = readJson(p.appEnv());
  if (!env) throw new HarnessError('E_NOT_UP', 'app-env.json is missing — run `up` first');

  const browser = await pw.chromium.launch({ headless: opts.headless !== false });
  const ctxOpts = { viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true };
  if (fs.existsSync(p.storage())) ctxOpts.storageState = p.storage();
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();

  /**
   * Block every websocket the SPA tries to open. This is load-bearing, not tidiness.
   *
   * settings.py sets ASGI_APPLICATION, so `runserver` serves the app through Django
   * Channels on a single event loop, and frontend/src/common/utils/socketConnection.js
   * opens a socket per live card as soon as an authenticated page mounts. One consumer
   * that blocks that loop takes the whole server with it: measured here, Django kept its
   * pid and its listening socket but stopped answering ANY http — every later request,
   * including a plain page load, hung until it timed out. It is the same signature as the
   * four-hour verify wedge in run 18, where a phase timeout could not reap what looked
   * like a healthy process.
   *
   * Nothing under test needs live sockets: they carry reminders, team updates and mood
   * cards. Refusing them costs no coverage and removes an entire class of hang.
   */
  if (opts.websockets !== true) {
    await page.routeWebSocket(/.*/, (ws) => ws.close()).catch(() => {});
  }

  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });

  return { pw, browser, context, page, env, consoleErrors };
}

/**
 * Log in through the real form.
 *
 * THREE things had to change from what every previous run did:
 *  1. Never `page.waitForURL`. The app navigates with history.push, a same-document
 *     transition, so waitForURL's default `waitUntil:'load'` never resolves. That is what
 *     stalled run 24's login for 30 seconds before it timed out.
 *  2. Read the verdict off the WIRE, not the DOM. The error toast only renders when the
 *     token is empty, so a stale storageState makes a failure silent.
 *  3. Check the submit button is enabled first. It is disabled when the trial has
 *     expired, and a force-click hides that as a generic timeout.
 */
async function login(session, opts = {}) {
  const { page, env } = session;
  const reg = registry();
  const { email, password } = credentials();

  if (!opts.force && fs.existsSync(p.storage())) {
    await page.goto(`${env.baseUrl}/home/`, { waitUntil: 'domcontentloaded' });
    const ok = await page.waitForSelector(reg.shell.readySelector, { timeout: 15000 })
      .then(() => true).catch(() => false);
    if (ok) { log('reused storage state'); return { reused: true }; }
    log('stored session is stale, logging in again');
  }

  let apiStatus = null;
  page.on('response', (r) => {
    if (r.url().includes('/core/email-login/')) apiStatus = r.status();
  });

  await page.goto(`${env.baseUrl}${reg.auth.loginPath}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(reg.auth.emailSelector, { timeout: 60000 }).catch(() => {
    throw new HarnessError('E_LOGIN_FAILED', 'the login form never rendered',
      'The bundle probably did not load. Check ' + p.webpack());
  });

  await page.fill(reg.auth.emailSelector, email);
  await page.fill(reg.auth.passwordSelector, password);

  const submit = page.locator(reg.auth.submitSelector).first();
  if (await submit.isDisabled().catch(() => false)) {
    throw new HarnessError('E_TRIAL_EXPIRED', 'the login button is disabled',
      'headerReducer.trialVersionExpiryDays is 0 — the trial has expired on this dump.');
  }
  await submit.click();

  // 2FA is server-side (Config row slug='use_2fa'); if it is on, unattended login
  // cannot proceed and that must be said plainly rather than timing out.
  const otp = await page.waitForSelector(reg.auth.otpGuardSelector, { timeout: 4000 })
    .then(() => true).catch(() => false);
  if (otp) {
    throw new HarnessError('E_LOGIN_2FA', 'the server demanded an OTP',
      "Set the Config row slug='use_2fa' to false on this database for unattended runs.");
  }

  const landed = await page.waitForFunction(
    () => !window.location.pathname.startsWith('/login')
      && !!window.localStorage.getItem('token'),
    null, { timeout: 45000 },
  ).then(() => true).catch(() => false);

  if (!landed) {
    throw new HarnessError('E_LOGIN_FAILED',
      apiStatus ? `the login endpoint answered ${apiStatus}` : 'login did not complete',
      apiStatus === 404
        ? 'Wrong password OR the account is disabled — Django returns the same 404 for both.'
        : 'Check ' + p.django());
  }

  await page.waitForSelector(reg.shell.readySelector, { timeout: 30000 }).catch(() => {});
  await session.context.storageState({ path: p.storage() });
  return { reused: false, apiStatus };
}

/**
 * Navigate to a module and prove it rendered.
 *
 * Assertions are on data-testid only. Several skeleton components reuse the page's
 * aria-label, so an aria-label assertion passes while the page is still a shimmer — the
 * single largest source of phantom "the data is empty" failures in the old runs.
 */
async function goto(session, key, opts = {}) {
  const { page, env } = session;
  const reg = registry();
  const mod = reg.modules.find((m) => m.key === key);
  if (!mod) {
    throw new HarnessError('E_MODULE_UNKNOWN', `no module "${key}" in modules.json`,
      'Known keys: ' + reg.modules.map((m) => m.key).slice(0, 12).join(', ') + ' …');
  }

  const timeout = Number(opts.timeout || 30000);
  await page.goto(`${env.baseUrl}${mod.path}`, { waitUntil: 'domcontentloaded' });

  // The app shell must be up before a module selector means anything: permission-gated
  // routes render an empty div until person_permission resolves.
  await page.waitForSelector(reg.shell.readySelector, { timeout }).catch(() => {});

  const candidates = mod.readyAny || [mod.ready.selector];
  const started = Date.now();
  let matched = null;
  while (Date.now() - started < timeout && !matched) {
    for (const sel of candidates) {
      const n = await page.locator(sel).first().count().catch(() => 0);
      if (n > 0) { matched = sel; break; }
    }
    if (!matched) await sleep(500);
  }
  if (!matched) {
    throw new HarnessError('E_MODULE_TIMEOUT',
      `${key}: none of ${candidates.join(' , ')} appeared within ${timeout}ms`,
      mod.needsSeededData
        ? 'This module needs seeded data; it may legitimately be empty.'
        : 'Check the console errors in the result.');
  }
  return { key, path: mod.path, matched, url: page.url() };
}

async function shot(session, name) {
  ensure(ART());
  const file = path.join(ART(), name.endsWith('.png') ? name : `${name}.png`);
  await session.page.screenshot({ path: file, fullPage: true });
  return path.basename(file);
}

/**
 * Wait until an element's geometry stops moving, then return its box.
 *
 * `boundingBox()` does not wait for geometry to settle — it returns whatever the box is
 * at the moment it is asked. Measured against a 1.5s transition, 11 of 12 polls came
 * back mid-flight; against a popper re-anchoring every 80ms, consecutive reads gave
 * y = 100, 220, 340, 460, 580, 700. Either way the caller gets a position the element
 * was passing through, not the one it came to rest at.
 *
 * Re-anchoring is the case that matters. A popper (react-datepicker and MUI both sit on
 * @popperjs/core) measures its reference, computes a placement, and flips it when the
 * first choice does not fit — so the box moves in discrete jumps for as long as that
 * negotiation runs, with no transition involved. A pure CSS fade of 0.2-0.3s is often
 * over before the first round-trip returns, so animation alone is the weaker argument.
 *
 * Stability, not a fixed sleep: poll until two consecutive samples agree to within a
 * pixel and stay that way for `quiet`. A blind `sleep` is either too short on a cold
 * machine or wasted budget on a warm one.
 *
 * Returns `{ box, settled }`. `box` is null when the element never resolves a box —
 * absent, detached, or `display:none`. Null means "not measurable", never "measured as
 * zero".
 *
 * `settled` is false when the budget ran out while the box was still moving. `box` is
 * then only the last sample, a position the element was passing through. Returning that
 * bare made it indistinguishable from a settled box: a popper flipping between y=150 and
 * y=300 every 100ms, covering the field only at 150, came back from overlap() as a clean
 * `intersects:false` — the mid-flight read this function exists to prevent, delivered
 * silently. A timeout is deliberately NOT turned into a null box: null routes to
 * `missing`, which is a question about the selector, and this selector resolved fine.
 *
 * Each probe carries its own timeout. `boundingBox()` with no argument inherits
 * Playwright's 30s actionability default, so on a selector that matches nothing the first
 * call outlives this function's whole budget: measured at 30052ms against a 1200ms
 * timeout, and 60106ms for an `overlap()` where both sides were absent. The missing-
 * selector path is the common one — "zero matches is a question" means a phase retries
 * corrected locators routinely — so the per-probe cap is what keeps the documented
 * `timeout` honest.
 */
async function settle(session, selector, opts = {}) {
  const timeout = Number(opts.timeout || 5000);
  const quiet = Number(opts.quiet || 250);
  const loc = session.page.locator(selector).first();
  const started = Date.now();
  let last = null;
  let stableSince = null;
  while (Date.now() - started < timeout) {
    const left = timeout - (Date.now() - started);
    const probe = Math.max(50, Math.min(500, left));
    const box = await loc.boundingBox({ timeout: probe }).catch(() => null);
    const steady = box && last
      && Math.abs(box.x - last.x) < 1 && Math.abs(box.y - last.y) < 1
      && Math.abs(box.width - last.width) < 1 && Math.abs(box.height - last.height) < 1;
    if (steady) {
      if (stableSince === null) stableSince = Date.now();
      if (Date.now() - stableSince >= quiet) return { box, settled: true };
    } else {
      stableSince = null;
    }
    last = box;
    await sleep(50);
  }
  return { box: last, settled: false };
}

/**
 * Is the element something a user can actually see?
 *
 * A box is not visibility. `visibility:hidden` and `opacity:0` both keep their geometry,
 * so a dismissed popover that is merely hidden rather than unmounted still measures
 * 200x120 in the same place as the field under it — reported here as a 6000 px² overlap on
 * a screen where nothing is wrong. That is the ticket-244 failure mode reversed, and it
 * is the more dangerous direction: a false defect costs a week, a missed one costs a
 * retest. react-datepicker unmounts on close so it is safe, but MUI Popper with
 * `keepMounted` and any CSS fade dismissal are not.
 *
 * Playwright's own `isVisible()` does not cover this: it treats `opacity:0` as visible.
 * Opacity also compounds down the tree, so a faded ancestor hides a fully opaque child —
 * hence the walk to the root rather than reading the one element. `display:none` walks
 * for the same reason.
 *
 * `visibility` does NOT walk. It is inherited and a child can override it, so the
 * element's own computed value already accounts for a hidden ancestor, and a child set
 * back to `visibility:visible` under a hidden wrapper is painted and hit-testable.
 * Walking the ancestors reported exactly that child, on screen and over the field, as
 * `hidden` with `intersects:false` — a missed defect.
 *
 * `visible: null` means the element could not be inspected at all — it detached between
 * settle() finding its box and this read, or the page navigated. That is "could not
 * measure", and overlap() files it under `missing`; filing it under `hidden` reported a
 * popper that vanished mid-measure as a clean `intersects:false`.
 *
 * The probe's timeout is evaluate's THIRD argument. The second is the page function's
 * argument, and passed there `{ timeout }` was handed to the page function and ignored:
 * the wait for a detached element ran under Playwright's 30s default, and an overlap()
 * whose popper was removed 550ms in took 30677ms against a 1200ms budget.
 */
async function visible(session, selector, opts = {}) {
  const loc = session.page.locator(selector).first();
  const cap = Math.min(2000, Number(opts.timeout || 5000));
  return loc.evaluate((el) => {
    const own = getComputedStyle(el).visibility;
    if (own !== 'visible') return { visible: false, why: `visibility:${own}` };
    let effective = 1;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const cs = getComputedStyle(node);
      if (cs.display === 'none') return { visible: false, why: 'display:none' };
      effective *= Number(cs.opacity);
    }
    if (effective < 0.05) return { visible: false, why: `opacity:${effective.toFixed(2)}` };
    return { visible: true, why: null };
  }, undefined, { timeout: cap }).catch(() => ({ visible: null, why: 'unmeasurable' }));
}

function intersection(a, b) {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (width <= 0 || height <= 0) return { width: 0, height: 0, areaPx: 0 };
  return {
    width: Math.round(width),
    height: Math.round(height),
    areaPx: Math.round(width * height),
  };
}

/**
 * Do `a` and `b` share screen area, and how much? Answered as an area, in square pixels.
 *
 * The answer is symmetric and says nothing about which of the two paints on top: a
 * popper under the field and one over it return the same `areaPx`. Asked as "does `a`
 * cover `b`?", a field painting over a portalled popper would be reported as the popper
 * covering the field, the defect inverted. Check stacking separately
 * (`document.elementsFromPoint` at the centre of `region`) when that is the question.
 *
 * `areaPx` is the size of the shared patch, NOT a distance. It is about
 * `region.width * region.height`: each side of `region` is rounded on its own and
 * `areaPx` from the unrounded product, so 10352 sits beside a 242 x 43 region (10406)
 * because the band was 42.78px. It is named `areaPx` rather than `px` because "10352px"
 * reads as a length, and a length that large is impossible on a 900px-tall screen, so
 * the number invites the reader to dismiss a real defect as a broken measurement. Divide
 * by `region.width` to recover the height a human would describe: 10352 over a
 * 242px-wide popover is a 43px band, i.e. one input row. Quote `region` when a reviewer
 * needs to picture it.
 *
 * "Obscured", "overlapping" and "covers the field below" are the one bug class this
 * harness could state a rule about but never measure: a screenshot proves it only to a
 * human who happens to notice two things in the same place, and an absence-assertion
 * over a popover passes identically whether dismissal works or is entirely broken.
 *
 * Both boxes are settled first, so the result describes where the overlay came to rest
 * rather than where it started — unless `unsettled` names a side. That side was still
 * moving when its budget ran out, so its box is a snapshot, and the result is not a
 * measurement of anything: re-measure with a longer `timeout`.
 *
 * `intersects: null` is NOT "no overlap" — it means one of the two could not be
 * measured (it never resolved a box, or it resolved and then detached before it could
 * be inspected), and `missing` names which. Which side is missing decides what it means.
 * A selector for something that should be there is a question about the selector:
 * reading it as "nothing on top of the field" is how a working screen gets filed as a
 * product bug, and reading it as "the popper closed" certifies a re-open absent when it
 * was the FIELD selector that matched nothing. An overlay gone after a dismissal —
 * missing, or moved into `hidden` — is a dismissal only behind an earlier read that found
 * both sides resolved, visible and on screen. A control that checked only `missing`
 * certified the dismissal of a kept-mounted popover that never opened, because it reads
 * `hidden: [popper]` before and after alike. SKILL.md's calendar bullet is the procedure.
 *
 * `outsideViewport` catches the other direction. CSS `zoom` and a short viewport have
 * already put a real element at `top=1194px` in a 900px window, where it cannot overlap
 * anything because it is not on screen at all — a green result that means nothing. It is
 * true when either box lies wholly past ANY edge: boxes are viewport-relative, so one
 * scrolled above or left of the viewport has a negative y or x, and checking only the
 * bottom and right edges read a popper above the screen as a believable zero.
 *
 * `hidden` is the same guard for elements that kept their box but are not on screen. If
 * either side is invisible there is nothing for a user to see, so `intersects` is false
 * and `hidden` names which one and why. `areaPx` is then 0 by design, while `region`
 * keeps the patch the invisible element would cover: diagnostics, not a defect to quote.
 *
 * Each side is its selector's FIRST match — settle() and visible() both go through
 * `.first()` — so a selector that also matches a parked copy measures whichever comes
 * first in the DOM. On the live Training modal `.MuiDialogContent-root` matched a hidden
 * copy of the dialog left at y 1203..1497 and gave two readings that described nothing
 * on screen. `hidden` or `outsideViewport` on a side that is plainly on screen is this:
 * narrow the selector rather than believe the result.
 *
 * One thing this does NOT handle: both boxes are viewport-relative and they are read one
 * after the other, so a page that scrolls between the two reads compares two different
 * coordinate frames. Measured: two elements 600px apart, truthfully `areaPx=0`, came back
 * as `areaPx=20000` with a 400px scroll landing in the gap. Settle the page before
 * measuring — do not call this while something is still scrolling a field into view.
 */
async function overlap(session, a, b, opts = {}) {
  const settledA = await settle(session, a, opts);
  const settledB = await settle(session, b, opts);
  const boxA = settledA.box;
  const boxB = settledB.box;
  const unsettled = [[a, settledA], [b, settledB]]
    .filter(([, s]) => s.box && !s.settled)
    .map(([sel]) => sel);
  const viewport = session.page.viewportSize() || null;
  const missing = [];
  if (!boxA) missing.push(a);
  if (!boxB) missing.push(b);
  if (missing.length) {
    return { intersects: null, areaPx: null, missing, unsettled, a: boxA, b: boxB, viewport };
  }
  const seen = await Promise.all([visible(session, a, opts), visible(session, b, opts)]);
  const unmeasured = [a, b].filter((_, i) => seen[i].visible === null);
  if (unmeasured.length) {
    return {
      intersects: null, areaPx: null, missing: unmeasured, unsettled, a: boxA, b: boxB, viewport,
    };
  }
  const hidden = [a, b]
    .map((sel, i) => (seen[i].visible === false ? { selector: sel, why: seen[i].why } : null))
    .filter(Boolean);
  const hit = intersection(boxA, boxB);
  const offscreen = (box) => box.y >= viewport.height || box.x >= viewport.width
    || box.y + box.height <= 0 || box.x + box.width <= 0;
  const outsideViewport = viewport ? [boxA, boxB].some(offscreen) : false;
  if (hidden.length) {
    return {
      intersects: false, areaPx: 0, region: hit, hidden, unsettled, a: boxA, b: boxB, viewport,
      outsideViewport,
    };
  }
  return {
    intersects: hit.areaPx > 0,
    areaPx: hit.areaPx,
    region: hit,
    hidden,
    unsettled,
    a: boxA,
    b: boxB,
    viewport,
    outsideViewport,
  };
}

/**
 * Run one case. NEVER throws.
 *
 * A 20-case list has to be one tool call that cannot abort halfway. An environment fault
 * becomes `blocked`, an assertion failure becomes `fail`, and both carry the reason — so
 * a partial list is never mistaken for a verdict, which is exactly what let a stale
 * partial artifact block a good merge in run 16.
 */
async function runCase(session, id, fn) {
  const started = Date.now();
  try {
    const value = await fn(session);
    return { id, result: 'pass', ms: Date.now() - started, evidence: value ?? null };
  } catch (err) {
    const isEnv = err instanceof HarnessError;
    return {
      id,
      result: isEnv ? 'blocked' : 'fail',
      ms: Date.now() - started,
      reason: err.message.slice(0, 500),
      code: isEnv ? err.code : null,
      hint: isEnv ? err.hint : null,
    };
  }
}

/* ------------------------------------------------------------------ smoke */

/**
 * The proof the harness works: bring the app up, log in, visit two modules, screenshot
 * each. This is what a phase runs first; if it passes, nothing about the environment is
 * worth another turn.
 */
async function smoke(keys) {
  const mods = keys && keys.length ? keys : ['home', 'project-logs'];
  const env = await up();
  const session = await open();
  const results = [];
  try {
    results.push(await runCase(session, 'login', async (s) => login(s)));
    for (const k of mods) {
      results.push(await runCase(session, k, async (s) => {
        const r = await goto(s, k);
        r.screenshot = await shot(s, `smoke-${k}`);
        return r;
      }));
    }
  } finally {
    await session.browser.close().catch(() => {});
  }
  const out = { env: { baseUrl: env.baseUrl, bePort: env.bePort, fePort: env.fePort }, results };
  writeJson(p.results(), out);
  return out;
}

/* ------------------------------------------------------------------ cli */

const API = {
  up, down, status, open, login, goto, shot, settle, overlap, runCase, smoke, registry,
  HarnessError,
  /**
   * Internals, exported for scripts/app.cjs and nothing else.
   *
   * app.cjs owns the machine-wide question ("is an app already up, and is it on my
   * code?"); this file owns the repository facts ("how does this app actually start").
   * Exporting rather than re-implementing keeps every hard-won fact above — the ASGI
   * wedge, CI=true, the bundle readiness (bundleState), the two pinned files — in ONE
   * place.
   */
  preflight, checkDb, disabledIntegrations, applyPatches, composeConfigJs,
  needsCollectstatic, collectStatic,
  startDjango, startWebpack, waitDjango, waitWebpack, bundleState,
  assertBundleReachable, describeEnv, listenerPid, pidCwd, alive, httpStatus,
};
module.exports = API;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const out = (o) => console.log(JSON.stringify(o, null, 2));
  try {
    switch (cmd) {
      case 'up': out(await up()); break;
      case 'down': out(down()); break;
      case 'status': out(await status()); break;
      case 'smoke': out(await smoke(rest)); break;
      case 'modules': {
        const reg = registry();
        out(reg.modules.map((m) => ({
          key: m.key, path: m.path, ready: m.ready.selector,
          needsSeededData: !!m.needsSeededData, readOnlySafe: m.readOnlySafe !== false,
        })));
        break;
      }
      case 'goto': {
        const s = await open();
        try { await login(s); out(await goto(s, rest[0])); await shot(s, `goto-${rest[0]}`); }
        finally { await s.browser.close().catch(() => {}); }
        break;
      }
      default:
        console.log(`harness.cjs — deterministic browser bring-up for the Oneshot pipeline

  up        start Django + webpack on the leased ports, patch the two pinned files, wait
            until the app can actually render, and write app-env.json
  status    is it still up?
  down      stop both processes by recorded pid (kills the process group)
  smoke     up + login + visit home and project-logs + screenshot each   <-- start here
  goto <k>  login and navigate to one module key
  modules   list the module registry

Environment: ONESHOT_WORKTREE, ONESHOT_PORT (django), ONESHOT_FE_PORT (webpack),
             ONESHOT_RUN_DIR or ONESHOT_IID, ONESHOT_TEST_LOGIN=<email>:<password>`);
    }
  } catch (err) {
    out(err instanceof HarnessError ? err.toJSON() : { code: 'E_NOT_UP', message: String(err && err.message || err) });
    process.exitCode = 1;
  }
}

if (require.main === module) main();

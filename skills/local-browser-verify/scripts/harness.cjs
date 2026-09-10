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
 *   - Django renders templates/index.html, whose {% render_bundle %} reads
 *     static/webpack-stats.dev.json. Webpack writes that file with an ABSOLUTE
 *     publicPath taken from frontend/config/localPaths.js (`http://localhost:3000/`,
 *     webpack.config.js:67). So moving webpack off 3000 requires patching that file, or
 *     the browser fetches the bundle from a port with nothing on it.
 *   - frontend/src/constants/config.js pins `apiUrl` to `http://localhost:8000/`. The
 *     SPA calls the API at that absolute URL, so it must name the Django port we lease.
 *
 * BOTH PATCHES ARE MANDATORY AND BOTH FILES ARE TRACKED. They are marked
 * --skip-worktree so a stray `git add -A` in a phase cannot commit a local port.
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
  'E_PATCH_FAILED', 'E_DJANGO_DEAD', 'E_WEBPACK_DEAD', 'E_BUNDLE_UNREACHABLE',
  'E_NO_CREDENTIALS', 'E_LOGIN_FAILED', 'E_LOGIN_2FA', 'E_TRIAL_EXPIRED',
  'E_MODULE_UNKNOWN', 'E_MODULE_TIMEOUT', 'E_NOT_UP', 'E_PLAYWRIGHT_MISSING',
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

function adminCredentials() {
  // Django's admin form takes a USERNAME. The SPA takes an email and translates it
  // internally. Run 20 fed the email to the admin form and the login silently failed.
  const user = process.env.ONESHOT_ADMIN_USER || '';
  const pass = process.env.ONESHOT_ADMIN_PASSWORD || '';
  return user && pass ? { user, pass } : null;
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
 * Both files are TRACKED. Patch, then mark --skip-worktree so a phase's `git add -A`
 * cannot commit a machine-local port into the branch.
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

function applyPatches(wt, bePort, fePort) {
  const a = patchFile(wt, 'frontend/config/localPaths.js',
    /const LOCAL_PUBLIC_URL = '[^']*';/,
    `const LOCAL_PUBLIC_URL = 'http://localhost:${fePort}';`, 'localPaths');
  const b = patchFile(wt, 'frontend/src/constants/config.js',
    /export const apiUrl = '[^']*';/,
    `export const apiUrl = 'http://localhost:${bePort}/';`, 'apiUrl');
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
 * `/login/` goes through templates/index.html, whose {% render_bundle %} raises
 * WebpackLoaderBadStatsError until webpack has written static/webpack-stats.dev.json.
 * Probing it means a perfectly healthy Django reads as dead for the whole first compile,
 * which is minutes. The admin login page is plain Django templating and answers as soon
 * as the process is actually serving, which is the thing this check is for.
 */
async function waitDjango(port, pid, budgetMs) {
  const url = `http://localhost:${port}/admin/login/`;
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) {
      throw new HarnessError('E_DJANGO_DEAD', 'the Django process exited during startup',
        `Last lines of ${p.django()}: ${tail(p.django(), 6)}`);
    }
    if (await httpStatus(url) === 200) return true;
    await sleep(2000);
  }
  throw new HarnessError('E_DJANGO_DEAD',
    `Django did not answer on ${port} within ${Math.round(budgetMs / 1000)}s`, tail(p.django(), 6));
}

/**
 * Webpack readiness is the log marker, not a port probe.
 *
 * Django's catch-all answers 200 for every path from the moment it boots, including
 * while the bundle is missing — which is why a curl check passed in run 24 while the page
 * was blank. "Compiled successfully" plus a real fetch of the emitted bundle URL is the
 * only pair that proves the app can actually render.
 */
function tail(file, n) {
  try { return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-n).join(' | ').slice(0, 400); }
  catch { return '(no log)'; }
}

async function waitWebpack(wt, port, pid, budgetMs) {
  const deadline = Date.now() + budgetMs;
  const statsFile = path.join(wt, 'static/webpack-stats.dev.json');
  let sawPort = false;
  while (Date.now() < deadline) {
    if (!alive(pid)) {
      throw new HarnessError('E_WEBPACK_DEAD', 'the webpack process exited during startup',
        `Last lines of ${p.webpack()}: ${tail(p.webpack(), 8)}`);
    }
    const logText = fs.existsSync(p.webpack()) ? fs.readFileSync(p.webpack(), 'utf8') : '';

    // start.js:69 calls choosePort(), which refuses a busy port rather than drifting
    // silently — but the env can still put it somewhere we did not ask for. Assert once.
    if (!sawPort) {
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

    /**
     * Readiness is the stats file's own `status`, not the log.
     *
     * webpack-bundle-tracker writes this file TWICE per compile: once with
     * {"status":"compiling"} the moment a build starts, then again with
     * {"status":"done", chunks:{...}} when it finishes. django-webpack-loader reads this
     * exact file, and on anything but `done` it raises WebpackLoaderBadStatsError, which
     * Django serves as a bare 500 — with DEBUG off there is no traceback in the response,
     * so from the browser it is indistinguishable from a broken app.
     *
     * A log-marker check is not good enough: `Compiled successfully` from an EARLIER
     * build stays in the log forever, so a restart reads as ready while the current
     * build is still running. Measured here: the harness reported ready, and every
     * navigation then took a 500. Reading the file Django reads removes the whole class.
     */
    const stats = readJson(statsFile);
    if (stats && stats.status === 'done') return true;
    if (stats && stats.status === 'error') {
      throw new HarnessError('E_WEBPACK_DEAD', 'webpack finished with a build error',
        String(stats.error || '').slice(0, 300) || tail(p.webpack(), 8));
    }
    await sleep(2000);
  }
  throw new HarnessError('E_WEBPACK_DEAD',
    `webpack did not reach status "done" within ${Math.round(budgetMs / 60000)} min`,
    tail(p.webpack(), 8));
}

/** Prove the browser can actually fetch the bundle Django points at. */
async function assertBundleReachable(bePort) {
  const html = await (async () => {
    try { return await (await fetch(`http://localhost:${bePort}/login/`)).text(); } catch { return ''; }
  })();
  const m = html.match(/<script[^>]+src="([^"]+bundle[^"]*|[^"]*main[^"]*\.js)"/i)
    || html.match(/src="(http:\/\/localhost:\d+\/[^"]+\.js)"/i);
  if (!m) {
    throw new HarnessError('E_BUNDLE_UNREACHABLE',
      'Django served /login/ but emitted no bundle script tag',
      'webpack-stats.dev.json is missing or stale. Check ' + p.webpack());
  }
  const url = m[1].startsWith('http') ? m[1] : `http://localhost:${bePort}${m[1]}`;
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

  const djangoPid = startDjango(wt, bePort);
  const webpackPid = startWebpack(wt, fePort);
  writeJson(p.servers(), { djangoPid, webpackPid, bePort, fePort, worktree: wt, startedAt: Date.now() });
  log('django pid', djangoPid, 'webpack pid', webpackPid);

  await waitDjango(bePort, djangoPid, Number(opts.djangoTimeoutMs || 90000));
  log('django ready on', bePort);
  // The first compile is minutes on a cold cache; incremental is seconds. Silence is
  // not failure, so the budget is generous and the liveness check is the pid.
  await waitWebpack(wt, fePort, webpackPid, Number(opts.webpackTimeoutMs || 20 * 60000));
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

const API = { up, down, status, open, login, goto, shot, runCase, smoke, registry, HarnessError };
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

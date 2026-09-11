#!/usr/bin/env node
/**
 * app.cjs — the machine-wide answer to "is the app already up, and is it on my code?"
 *
 * WHY THIS EXISTS
 * ---------------
 * harness.cjs knows how to START this app. It does not know whether one is ALREADY
 * running, because its idea of "already up" is a servers.json inside ONE run
 * directory: a second session, a second run, or a human at a terminal cannot see it
 * and starts another. Measured on this machine on 2026-09-10: four live Django/webpack
 * pairs, three of them orphans from runs that finished days earlier, plus the
 * developer's own checkout on :8000 — and every new session still paid a cold start.
 *
 * So this file owns exactly one question, machine-wide, and answers it in one command:
 *
 *     node scripts/app.cjs ensure --ref <branch|!MR|#PR|sha>
 *
 *   already on that code  -> reuse it, ~0s
 *   up but on other code  -> check the ref out INTO it, restart Django, let webpack
 *                            rebuild incrementally, ~20s
 *   nothing usable        -> cold start a seeded worktree, ~2min (measured, warm cache)
 *
 * The three paths return the SAME app-env contract, so a caller never branches on
 * which one happened.
 *
 * WHAT IT WILL NOT DO
 * -------------------
 * It never checks a ref out into a checkout it did not create. The developer's own
 * repo is discovered and offered for REUSE when it already happens to be on the right
 * commit, and is otherwise left alone — on this machine that checkout had eleven
 * modified files, and a `git checkout` into it would have destroyed a day's work.
 *
 * Every repository fact it needs — how Django must be started, why `CI=true`, what
 * "ready" means, which two files pin the ports — is imported from harness.cjs rather
 * than restated. One source of truth for facts that each cost a run to learn.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ONESHOT_HOME = process.env.ONESHOT_HOME || path.resolve(__dirname, '..');
try { require('dotenv').config({ path: path.join(ONESHOT_HOME, '.env'), override: false }); } catch { /* optional */ }

const H = require(path.join(ONESHOT_HOME, 'skills/local-browser-verify/scripts/harness.cjs'));

/* ------------------------------------------------------------------ config */

const expand = (p) => String(p || '').replace(/^~(?=$|\/)/, os.homedir());
const cfg = (k, d) => {
  const v = process.env[k];
  return v && String(v).trim() ? String(v).trim() : d;
};
const list = (k, d) => cfg(k, d).split(',').map((s) => s.trim()).filter(Boolean);

const WORK_REPO = path.resolve(expand(cfg('WORK_REPO', '~/Documents/workstreamai')));
const SEED_FROM = path.resolve(expand(cfg('ONESHOT_SEED_FROM', WORK_REPO)));
const WT_ROOT = path.resolve(expand(cfg('WT_ROOT', '~/Documents/oneshot-wt')));
const BASE_BRANCH = cfg('ONESHOT_BASE_BRANCH', 'dev');

/**
 * `staticfiles` is in this list for a reason worth keeping.
 *
 * local_settings.py ships DEBUG=False with ManifestStaticFilesStorage, so every
 * template that renders {% static %} — /admin/login/, which is the harness's own
 * readiness probe, and /home/ — raises `Missing staticfiles manifest entry` until
 * collectstatic has run. No worktree ever had it, so every fresh bring-up died as
 * E_DJANGO_DEAD after burning the full 90s Django budget. collectstatic takes 5s and
 * the output is 37MB of read-only files, so it is collected ONCE in the seed repo and
 * symlinked, exactly like venv and node_modules.
 */
const SEED_LINKS = list('ONESHOT_SEED_LINKS', 'venv,node_modules,staticfiles');
const SEED_COPIES = list('ONESHOT_SEED_COPIES', 'hrdb/local_settings.py,frontend/src/constants/config.js');

/** Django ports we may lease. The webpack port is always base+1000 (harness convention). */
const PORT_BASES = list('ONESHOT_APP_PORTS', '8010,8011,8012').map(Number).filter(Number.isInteger);

const REGISTRY = path.join(ONESHOT_HOME, 'state', 'instances.json');

/** The two tracked files harness.applyPatches rewrites to carry the leased ports. */
const PINNED = ['frontend/config/localPaths.js', 'frontend/src/constants/config.js'];

const log = (...a) => console.error('[app]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 2)); };
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

class AppError extends Error {
  constructor(code, message, hint) { super(message); this.code = code; this.hint = hint || null; }
  toJSON() { return { code: this.code, message: this.message, hint: this.hint }; }
}

/* ------------------------------------------------------------------ shell */

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout || 120000, ...opts });
  return { code: r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() };
}

function git(args, cwd, soft = false) {
  const r = sh('git', args, { cwd });
  if (r.code !== 0 && !soft) {
    throw new AppError('E_GIT', `git ${args.join(' ')} failed in ${cwd}`, r.err.split('\n').slice(-2).join(' '));
  }
  return r.out;
}

/* ------------------------------------------------------------------ locking */

/**
 * One bring-up per target at a time.
 *
 * The conductor now starts the app in the BACKGROUND the moment a run leases its
 * worktree, and phases still call `ensure` themselves. Without a lock those two race
 * on the same directory: the second one looks, sees a webpack that has not finished
 * its first compile, concludes the instance is broken and kills the very process that
 * was two minutes from ready. The lock makes the loser wait for the winner and then
 * re-examine the world, which is also why `fn` must re-check state rather than assume
 * what it saw before it waited.
 *
 * The holder's pid is written into the file so an abandoned lock — a conductor killed
 * mid-bring-up — is stolen rather than waited on forever.
 */
async function withLock(key, fn, budgetMs = 25 * 60000) {
  const f = path.join(ONESHOT_HOME, 'state', 'apps', 'locks', `${String(key).replace(/[^a-zA-Z0-9]+/g, '_')}.lock`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      fs.writeFileSync(f, JSON.stringify({ pid: process.pid, at: Date.now(), key }), { flag: 'wx' });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const held = readJson(f);
      if (!held || !H.alive(held.pid) || Date.now() - held.at > budgetMs) {
        fs.rmSync(f, { force: true });
        continue; // eslint-disable-line no-continue
      }
      if (Date.now() > deadline) {
        throw new AppError('E_LOCK_TIMEOUT', `another bring-up has held ${key} for over ${Math.round(budgetMs / 60000)} min`,
          `pid ${held.pid} — check it is alive, then delete ${f}`);
      }
      await sleep(1000); // eslint-disable-line no-await-in-loop
    }
  }
  try { return await fn(); } finally { fs.rmSync(f, { force: true }); }
}

/* ------------------------------------------------------------------ discovery */

/** Every listening TCP port with its pid, straight from lsof. */
function listeners() {
  const r = sh('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { timeout: 15000 });
  const rows = [];
  for (const line of r.out.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    const name = f[f.length - 2] || '';
    const port = Number((name.split(':').pop() || '').replace(/\D/g, ''));
    const pid = Number(f[1]);
    if (Number.isInteger(pid) && Number.isInteger(port) && port) rows.push({ pid, port });
  }
  return rows;
}

const ps = (pid) => sh('ps', ['-o', 'command=', '-p', String(pid)], { timeout: 5000 }).out;

/**
 * Every app process on this machine, listening or NOT.
 *
 * Discovery used to be lsof alone, and lsof only sees a bound socket. Django takes
 * about ten seconds to import its way to `bind()`, so for those ten seconds a perfectly
 * healthy bring-up looks like webpack running on its own — a "half-instance" — and the
 * next caller killed it and paid a fresh two-minute compile. Measured exactly that way:
 * an interrupted bring-up, joined one second too early, cost 2m35s instead of a wait.
 *
 * So the process table is the source of truth for EXISTENCE and lsof only for the port.
 * Django's port is recoverable from its own argv, which is what lets a not-yet-bound
 * process still be matched to the instance it belongs to.
 */
function scanProcesses() {
  const out = sh('ps', ['-e', '-o', 'pid=,command='], { timeout: 15000 }).out;
  const found = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const kind = classify(m[2]);
    if (!kind) continue;
    const pid = Number(m[1]);
    if (pid === process.pid) continue;
    const cwd = H.pidCwd(pid);
    if (!cwd) continue;
    // `runserver 127.0.0.1:8011` and `runserver 8000` are both real forms, and a naive
    // "first number after runserver" reads the first octet of the address as the port.
    const portMatch = kind === 'django'
      ? /runserver['"\s,]+(?:(?:\d{1,3}\.){3}\d{1,3}:)?(\d{2,5})/.exec(m[2])
      : null;
    found.push({ pid, kind, cwd: real(cwd), argvPort: portMatch ? Number(portMatch[1]) : null });
  }
  return found;
}

/**
 * Both halves of this app are started by a wrapper, so match on what the wrapper runs.
 * Django arrives as `python -c "...runserver..."` (the ssl/hashlib shim) or as a plain
 * `manage.py runserver` a human typed; webpack is always frontend/scripts/start.js.
 */
function classify(cmd) {
  // Anything that merely MENTIONS the pattern is not the pattern. A `ps | grep runserver`
  // carries the word on its own command line and was duly reported as a Django server
  // running from the Oneshot repo, on port 8000, which is a fiction with a port number.
  if (/(^|\/)(grep|rg|ps|lsof|tail)\s/.test(cmd) || /\bgrep\b/.test(cmd)) return null;
  if (/runserver/.test(cmd) && /python/i.test(cmd)) return 'django';
  if (/frontend\/scripts\/start\.js/.test(cmd) && /node/.test(cmd)) return 'webpack';
  return null;
}

/**
 * Every app instance running on this machine, whoever started it.
 *
 * Discovery is by PROCESS, not by registry file: a registry only knows what this tool
 * started, and the whole problem is the instances it did not start — a previous run's
 * orphan, another session, the developer's own server.
 */
async function discover() {
  const byWt = new Map();
  const boundPort = new Map(listeners().map((l) => [l.pid, l.port]));

  for (const proc of scanProcesses()) {
    const inst = byWt.get(proc.cwd) || { worktree: proc.cwd, django: null, webpack: null };
    const port = boundPort.has(proc.pid) ? boundPort.get(proc.pid) : proc.argvPort;
    const entry = { pid: proc.pid, port: port || null, listening: boundPort.has(proc.pid) };
    // Prefer a process that is actually listening: a stale sibling that never bound must
    // not shadow the one answering requests.
    const cur = inst[proc.kind];
    if (!cur || (!cur.listening && entry.listening)) inst[proc.kind] = entry;
    byWt.set(proc.cwd, inst);
  }
  const out = [];
  for (const inst of byWt.values()) out.push(await annotate(inst));
  // Complete instances first, then the ones with a warm bundle: the best reuse candidate
  // should be the first thing every caller looks at.
  return out.sort((a, b) => (Number(b.healthy) - Number(a.healthy)) || (Number(b.bundleReady) - Number(a.bundleReady)));
}

async function annotate(inst) {
  const wt = inst.worktree;
  const isRepo = fs.existsSync(path.join(wt, '.git'));
  const g = isRepo ? {
    head: git(['rev-parse', 'HEAD'], wt, true),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], wt, true),
  } : { head: null, branch: null };

  // The port patches live in tracked files and are marked --skip-worktree, so they do
  // not show here — but filter by name anyway: a checkout that lost the mark must not
  // read as "the developer has work in progress".
  const dirtyLines = isRepo
    ? git(['status', '--porcelain', '--untracked-files=no'], wt, true).split('\n')
      .filter(Boolean).filter((l) => !PINNED.some((f) => l.includes(f)))
    : [];

  const stats = readJson(path.join(wt, 'static/webpack-stats.dev.json'));
  const healthy = Boolean(inst.django && inst.django.port)
    && await H.httpStatus(`http://localhost:${inst.django.port}/admin/login/`, 8000) === 200;

  return {
    ...inst,
    ...g,
    /**
     * `managed` is the whole safety model: only a checkout THIS tool created under
     * WT_ROOT may have a ref checked out into it. Anything else is someone's working
     * copy and is read-only to us, however convenient it looks.
     */
    role: (wt === WT_ROOT || wt.startsWith(WT_ROOT + path.sep)) ? 'managed' : 'foreign',
    /**
     * Narrower than `managed`, and it is this flag — not `managed` — that licenses a
     * checkout. WT_ROOT also holds the per-ticket worktrees the conductor leases, and
     * re-pointing one of those mid-run swaps the code under a live phase, which is a
     * far worse outcome than paying for a cold start. Only the pool this tool creates
     * (`app-<port>`) is ours to move.
     */
    ours: path.basename(wt).startsWith('app-') && (wt === WT_ROOT || wt.startsWith(WT_ROOT + path.sep)),
    dirty: dirtyLines.length,
    dirtyFiles: dirtyLines.slice(0, 6),
    bundleReady: Boolean(stats && stats.status === 'done'),
    healthy,
    complete: Boolean(inst.django && inst.webpack),
    /** Both processes exist but at least one has not bound its socket yet. */
    binding: Boolean(inst.django && inst.webpack)
      && !(inst.django.listening && inst.webpack.listening),
  };
}

const summarize = (i) => ({
  worktree: i.worktree, role: i.role, ours: i.ours, branch: i.branch, head: (i.head || '').slice(0, 10),
  bePort: i.django && i.django.port, fePort: i.webpack && i.webpack.port,
  healthy: i.healthy, bundleReady: i.bundleReady, binding: i.binding, dirty: i.dirty,
});

/* ------------------------------------------------------------------ refs */

/**
 * Resolve what the caller means by "this MR" into a sha that exists locally.
 *
 *   !123 / MR!123 / mr/123     GitLab merge request head
 *   #45  / PR#45               GitHub pull request head
 *   <branch> / <sha>           whatever it says
 *
 * Fetched into the SEED repo because every worktree shares its object database, so one
 * fetch makes the commit reachable from all of them.
 */
function resolveRef(ref) {
  const mr = /^(?:mr[!/]?|!)(\d+)$/i.exec(ref);
  const pr = /^(?:pr[#/]?|#)(\d+)$/i.exec(ref);
  const remote = 'origin';

  if (mr || pr) {
    const remoteRef = mr ? `refs/merge-requests/${mr[1]}/head` : `refs/pull/${pr[1]}/head`;
    const r = sh('git', ['fetch', remote, remoteRef], { cwd: SEED_FROM, timeout: 180000 });
    if (r.code !== 0) {
      throw new AppError('E_REF_UNRESOLVED', `could not fetch ${remoteRef} from ${remote}`,
        `${r.err.split('\n').slice(-1)[0]} — is ${mr ? 'this a GitLab MR' : 'this a GitHub PR'} on ${remote}?`);
    }
    return { sha: git(['rev-parse', 'FETCH_HEAD'], SEED_FROM), label: ref, fetchRef: remoteRef };
  }

  sh('git', ['fetch', remote, ref], { cwd: SEED_FROM, timeout: 180000 });
  for (const cand of ['FETCH_HEAD', `${remote}/${ref}`, ref]) {
    const sha = git(['rev-parse', '--verify', '--quiet', `${cand}^{commit}`], SEED_FROM, true);
    if (sha) return { sha, label: ref, fetchRef: ref };
  }
  throw new AppError('E_REF_UNRESOLVED', `'${ref}' is not a branch, MR, PR or commit on ${remote}`,
    'Use a branch name, !<mr-iid>, #<pr-number>, or a full sha.');
}

/* ------------------------------------------------------------------ seed + worktree */

/**
 * The seed repo must be able to answer /admin/login/ before anything symlinks it.
 * collectstatic is 5 seconds and is the difference between a working bring-up and
 * E_DJANGO_DEAD, so it is run here rather than left as a README step nobody performs.
 */
function ensureSeed(notes) {
  for (const rel of SEED_LINKS) {
    const src = path.join(SEED_FROM, rel);
    if (fs.existsSync(src)) continue;
    if (rel === 'staticfiles') {
      log('seed staticfiles missing — running collectstatic (once, ~5s)');
      const r = sh(path.join(SEED_FROM, 'venv/bin/python'), ['-c',
        "import ssl, hashlib, sys\nsys.argv=['manage.py','collectstatic','--noinput']\n"
        + "exec(compile(open('manage.py').read(),'manage.py','exec'))\n"],
      { cwd: SEED_FROM, timeout: 600000, env: { ...process.env, DJANGO_SETTINGS_MODULE: 'hrdb.settings' } });
      if (r.code !== 0 || !fs.existsSync(src)) {
        throw new AppError('E_NO_STATICFILES', 'collectstatic did not produce a staticfiles/ tree in the seed repo',
          r.err.split('\n').slice(-2).join(' '));
      }
      notes.push('ran collectstatic in the seed repo (staticfiles/ was missing)');
      continue;
    }
    throw new AppError('E_SEED_MISSING', `${src} does not exist, so it cannot be seeded into a worktree`,
      `Remove '${rel}' from ONESHOT_SEED_LINKS or create it in ${SEED_FROM}.`);
  }
}

/**
 * Seeding is LOUD about a missing source. src/lib/worktrees.ts skips one silently
 * (`if (!existsSync(src)) continue`), which is exactly how staticfiles went missing
 * from every worktree for weeks without a single error message.
 */
function seed(wt, notes) {
  const linked = [];
  for (const rel of SEED_LINKS) {
    const src = path.join(SEED_FROM, rel);
    const dst = path.join(wt, rel);
    if (!fs.existsSync(src)) throw new AppError('E_SEED_MISSING', `seed source ${src} is missing`);
    if (fs.existsSync(dst)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.symlinkSync(src, dst);
    linked.push(rel);
  }
  for (const rel of SEED_COPIES) {
    const src = path.join(SEED_FROM, rel);
    const dst = path.join(wt, rel);
    if (!fs.existsSync(src)) throw new AppError('E_SEED_MISSING', `seed source ${src} is missing`);
    if (fs.existsSync(dst)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    linked.push(rel);
  }
  /**
   * In a LINKED worktree `.git` is a file, not a directory, so `<wt>/.git/info/exclude`
   * is not a path — ask git where the file is. It answers with the COMMON dir's
   * exclude, which is shared by every worktree, so the entries are written once.
   */
  const ex = path.resolve(wt, git(['rev-parse', '--git-path', 'info/exclude'], wt));
  fs.mkdirSync(path.dirname(ex), { recursive: true });
  const have = fs.existsSync(ex) ? fs.readFileSync(ex, 'utf8') : '';
  const add = [...SEED_LINKS, ...SEED_COPIES].filter((r) => !have.split('\n').includes(r));
  if (add.length) fs.appendFileSync(ex, (have.endsWith('\n') || !have ? '' : '\n') + add.join('\n') + '\n');
  if (linked.length) notes.push(`seeded ${linked.join(', ')}`);
}

function leasePorts(found) {
  const busy = new Set(listeners().map((l) => l.port));
  for (const be of PORT_BASES) {
    const fe = be + 1000;
    if (busy.has(be) || busy.has(fe)) continue;
    if (found.some((i) => (i.django && i.django.port === be) || (i.webpack && i.webpack.port === fe))) continue;
    return { be, fe };
  }
  throw new AppError('E_NO_PORTS', `every port in ${PORT_BASES.join(',')} (and its +1000 pair) is busy`,
    'Run `node scripts/app.cjs gc --kill` to reap orphaned servers, or widen ONESHOT_APP_PORTS.');
}

/* ------------------------------------------------------------------ the three paths */

/**
 * Does this switch change anything webpack bundles?
 *
 * Asking git is deterministic; waiting to see whether a rebuild starts is a guess with
 * a 25-second price on every backend-only switch. When the answer is no, the bundle in
 * the browser is already the right one and there is nothing to wait for.
 */
function frontendChanged(wt, from, to) {
  if (!from || from === to) return false;
  return Boolean(git(['diff', '--name-only', from, to, '--', 'frontend/'], wt, true).trim());
}

function migrationsBetween(wt, from, to) {
  if (!from || from === to) return true; // unknown provenance: migrate rather than guess
  const out = git(['diff', '--name-only', from, to, '--', '*/migrations/*.py'], wt, true);
  return Boolean(out.trim());
}

function migrate(wt, notes) {
  const r = sh(path.join(wt, 'venv/bin/python'), ['-c',
    "import ssl, hashlib, sys\nsys.argv=['manage.py','migrate','--noinput']\n"
    + "exec(compile(open('manage.py').read(),'manage.py','exec'))\n"],
  { cwd: wt, timeout: 900000, env: { ...process.env, DJANGO_SETTINGS_MODULE: 'hrdb.settings' } });
  if (r.code !== 0) {
    throw new AppError('E_MIGRATE_FAILED', 'manage.py migrate failed on the checked-out ref',
      r.err.split('\n').slice(-3).join(' '));
  }
  notes.push('ran migrations');
}

/**
 * Wait for the rebuild the checkout just triggered — and know the difference between
 * "still building" and "nothing to build".
 *
 * The stats file already says `done` from the PREVIOUS build the moment we look, so a
 * bare status check returns instantly and the browser then loads the old bundle. The
 * pair that actually settles it is (a) we saw it go to `compiling`, or (b) the file was
 * rewritten after the checkout. A backend-only ref triggers neither, so after a quiet
 * window with the bundle still `done` we accept it as already current.
 */
async function waitRebuild(wt, fePort, pid, since, notes, budgetMs = 10 * 60000, quietMs = 25000) {
  const statsFile = path.join(wt, 'static/webpack-stats.dev.json');
  const deadline = Date.now() + budgetMs;
  let sawCompiling = false;
  while (Date.now() < deadline) {
    if (!H.alive(pid)) throw new AppError('E_WEBPACK_DEAD', `webpack (pid ${pid}) exited during the rebuild`);
    const st = readJson(statsFile);
    const mtime = fs.existsSync(statsFile) ? fs.statSync(statsFile).mtimeMs : 0;
    if (st && st.status === 'compiling') sawCompiling = true;
    if (st && st.status === 'error') {
      throw new AppError('E_WEBPACK_DEAD', 'webpack finished the rebuild with a build error',
        String(st.error || '').slice(0, 300));
    }
    if (st && st.status === 'done' && (sawCompiling || mtime >= since)) {
      notes.push('webpack rebuilt incrementally');
      return true;
    }
    if (st && st.status === 'done' && Date.now() - since > quietMs) {
      /**
       * git changed a bundled file and webpack still has not reacted. Watchpack can miss
       * a checkout that rewrites many files at once, and serving the previous bundle
       * while reporting success is the one outcome that must never happen quietly.
       */
      throw new AppError('E_NO_REBUILD',
        `bundled files changed but webpack did not start a rebuild within ${Math.round(quietMs / 1000)}s`,
        'Touch a file under frontend/src to nudge the watcher, or restart the instance with `app.cjs down --worktree <wt>` then `ensure`.');
    }
    await sleep(1000);
  }
  throw new AppError('E_WEBPACK_DEAD', `webpack did not finish rebuilding within ${Math.round(budgetMs / 60000)} min`);
}

/** Path 2: an app is up, on the wrong code. Move the code, keep the processes. */
async function switchTo(inst, target, notes) {
  const wt = inst.worktree;
  const be = inst.django.port;
  const fe = inst.webpack.port;
  const from = inst.head;

  // Release the port patches so checkout may move the files, then re-apply after: the
  // ports are machine-local and must never survive into a commit.
  // Idempotent, and it repairs as well as seeds: a link added by hand, or a seed entry
  // added to the config after this worktree was created, is otherwise missing forever
  // and never lands in .git/info/exclude — which is how an untracked `staticfiles`
  // showed up in `git status` for a phase that then tried to commit it.
  seed(wt, notes);

  /**
   * Start the rebuild clock BEFORE the checkout, not after.
   *
   * webpack can notice the changed files and finish a small incremental build while
   * `git checkout` is still returning. Timestamping afterwards makes that rebuild look
   * older than the switch, so the poll below never matches it and burns the whole quiet
   * window before concluding — wrongly — that nothing was rebuilt. Measured: a 10s
   * switch reported as 32s.
   */
  const since = Date.now();

  for (const f of PINNED) git(['update-index', '--no-skip-worktree', f], wt, true);
  git(['fetch', 'origin', target.fetchRef || target.sha], wt, true);
  git(['checkout', '--force', '--detach', target.sha], wt);
  H.applyPatches(wt, be, fe);
  notes.push(`checked out ${target.label} (${target.sha.slice(0, 10)}) over ${(from || '?').slice(0, 10)}`);

  if (migrationsBetween(wt, from, target.sha)) migrate(wt, notes);

  /**
   * Django runs --noreload (harness.startDjango), so nothing about the new code is live
   * until the process is replaced. Killing the GROUP, not the pid: runserver's threads
   * and any child hold the socket, and a half-dead listener is worse than none.
   */
  try { process.kill(-inst.django.pid, 'SIGTERM'); } catch { try { process.kill(inst.django.pid, 'SIGTERM'); } catch { /* gone */ } }
  for (let i = 0; i < 30 && H.listenerPid(be); i += 1) await sleep(200); // eslint-disable-line no-await-in-loop
  const djangoPid = H.startDjango(wt, be);
  await H.waitDjango(be, djangoPid, 90000);
  notes.push(`restarted Django on ${be} (pid ${djangoPid})`);

  if (frontendChanged(wt, from, target.sha)) {
    await waitRebuild(wt, fe, inst.webpack.pid, since, notes);
  } else {
    notes.push('no bundled file changed, so the running bundle is already current');
  }
  const bundleUrl = await H.assertBundleReachable(be);
  return { worktree: wt, bePort: be, fePort: fe, djangoPid, webpackPid: inst.webpack.pid, bundleUrl };
}

/**
 * Path 0: the caller already owns a checkout and wants the app up IN IT.
 *
 * This is the conductor's shape, and it is deliberately not the pooled one. A run's
 * worktree carries the run's own ref and, from `implement` onward, the run's own
 * uncommitted work — so this path NEVER runs `git checkout`. It only answers "are the
 * two processes up for this directory", starts what is missing, and returns the same
 * contract. Reuse is by worktree identity, which is the check that stops a phase from
 * reading green off a server belonging to a different checkout.
 */
async function ensureIn(wt, opts, notes) {
  const at = (i) => i && i.worktree === real(wt);
  let here = (await discover()).find(at);

  /**
   * Both processes alive but not serving yet is the NORMAL state of a bring-up that is
   * still running — the first webpack compile is minutes. Wait for it. Killing it was
   * the obvious reading and the wrong one: it turns another caller's nearly-finished
   * work into a fresh two-minute compile, every time.
   */
  if (here && here.complete && !opts.fresh && !(here.healthy && here.bundleReady)) {
    notes.push(here.binding
      ? 'a bring-up for this worktree was mid-start (a process had not bound yet) — waited for it'
      : 'a bring-up for this worktree was already in progress — waited for it rather than restarting');
    const djangoPort = here.django.port || Number(opts.port || process.env.ONESHOT_PORT || 0);
    if (!here.healthy && djangoPort) await H.waitDjango(djangoPort, here.django.pid, 150000);
    if (!here.bundleReady) {
      await H.waitWebpack(real(wt), here.webpack.port || 0, here.webpack.pid, 20 * 60000);
    }
    here = (await discover()).find(at);
  }

  if (here && here.complete && here.healthy && here.bundleReady && !opts.fresh) {
    notes.push(`reused the app already up for ${wt} on ${here.django.port}`);
    return { worktree: real(wt), bePort: here.django.port, fePort: here.webpack.port,
      djangoPid: here.django.pid, webpackPid: here.webpack.pid, bundleUrl: null, reused: true };
  }

  /**
   * A HALF-instance is the case that must be cleared: one process alive and the other
   * gone reads as "a server is running" to anything that only counts listeners, and it
   * holds the port against the cold start that would have fixed it.
   */
  if (here && (here.django || here.webpack) && !here.complete) {
    for (const pid of [here.webpack && here.webpack.pid, here.django && here.django.pid].filter(Boolean)) {
      try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
    }
    notes.push('stopped a half-started instance for this worktree before restarting it');
    await sleep(1500);
  }

  ensureSeed(notes);
  seed(wt, notes);
  const be = Number(opts.port || process.env.ONESHOT_PORT || 0) || leasePorts(await discover()).be;
  const fe = Number(opts['fe-port'] || process.env.ONESHOT_FE_PORT || 0) || be + 1000;
  const envOut = await H.up({ worktree: real(wt), bePort: be, fePort: fe });
  notes.push(`cold-started the app for ${wt} on ${be}/${fe}`);
  const servers = readJson(path.join(process.env.ONESHOT_RUN_DIR || '', 'harness/servers.json'), {});
  return { worktree: real(wt), bePort: be, fePort: fe, bundleUrl: envOut.bundleUrl,
    djangoPid: servers.djangoPid || H.listenerPid(be), webpackPid: servers.webpackPid || H.listenerPid(fe) };
}

/** Path 3: nothing usable. Build one. */
async function cold(target, notes) {
  ensureSeed(notes);
  const { be, fe } = leasePorts(await discover());
  const wt = path.join(WT_ROOT, `app-${be}`);
  const at = target ? target.sha : `origin/${BASE_BRANCH}`;

  if (fs.existsSync(path.join(wt, '.git'))) {
    for (const f of PINNED) git(['update-index', '--no-skip-worktree', f], wt, true);
    git(['checkout', '--force', '--detach', at], wt);
    notes.push(`reused the idle worktree ${wt} at ${at}`);
  } else {
    fs.mkdirSync(WT_ROOT, { recursive: true });
    git(['worktree', 'prune'], SEED_FROM, true);
    git(['worktree', 'add', '--detach', wt, at], SEED_FROM);
    notes.push(`created worktree ${wt} at ${at}`);
  }
  seed(wt, notes);

  const envOut = await H.up({ worktree: wt, bePort: be, fePort: fe });
  const servers = readJson(path.join(process.env.ONESHOT_RUN_DIR || '', 'harness/servers.json'), {});
  return {
    worktree: wt, bePort: be, fePort: fe, bundleUrl: envOut.bundleUrl,
    djangoPid: servers.djangoPid || H.listenerPid(be),
    webpackPid: servers.webpackPid || H.listenerPid(fe),
  };
}

/* ------------------------------------------------------------------ ensure */

async function ensure(opts) {
  const started = Date.now();
  const notes = [];

  // An explicit --worktree means the caller owns the checkout and the ref in it. Answer
  // the narrow question and touch nothing else — no pool, no checkout, no adoption.
  const pinned = opts.worktree || process.env.ONESHOT_WORKTREE;
  if (pinned) {
    if (opts.ref) {
      // Said plainly rather than silently honoured: inside a run, the ref in the
      // worktree is the run's own work, and moving it is never what the caller wanted.
      notes.push(`ignored --ref ${opts.ref}: this worktree's ref belongs to whoever leased it`);
    }
    const inst = await withLock(real(pinned), () => ensureIn(pinned, opts, notes));
    const appOut = await finishEnv(inst, null, opts.owner);
    return { action: inst.reused ? 'reused' : 'cold-start', ref: null, worktree: appOut.worktree,
      elapsedMs: Date.now() - started, notes, app: appOut };
  }

  const target = opts.ref ? resolveRef(opts.ref) : null;

  /**
   * The whole decision is under one lock, including the cheap reuse case.
   *
   * Locking only the mutating paths leaves the read-then-act window open, and two
   * callers arriving together both see "nothing usable" and both cold-start — two
   * worktrees, two ports, two webpack compiles contending on one shared babel cache.
   * A caller that arrives mid-cold-start now waits and is handed the instance that
   * cold start produced, which is what it wanted anyway.
   */
  return withLock('pool', async () => decide());

  async function decide() {
  const found = await discover();
  const usable = found.filter((i) => i.complete && i.healthy && i.bundleReady);

  let action;
  let inst;

  /**
   * With no ref the caller just wants an app. Prefer one of ours anyway: the first
   * healthy instance on this machine is usually the developer's own checkout, and
   * handing a phase a server running someone's uncommitted work is how a run comes to
   * record every value against code that is not in the branch.
   */
  const onTarget = target
    ? usable.find((i) => i.head === target.sha)
    : (usable.find((i) => i.ours) || usable.find((i) => i.role === 'managed') || usable[0]);
  if (onTarget && !opts.fresh) {
    action = onTarget.role === 'foreign' ? 'reused-foreign' : 'reused';
    inst = { worktree: onTarget.worktree, bePort: onTarget.django.port, fePort: onTarget.webpack.port,
      djangoPid: onTarget.django.pid, webpackPid: onTarget.webpack.pid, bundleUrl: null };
    notes.push(target
      ? `an app was already serving ${target.sha.slice(0, 10)} from ${onTarget.worktree}`
      : `reused the app already serving ${onTarget.branch || 'HEAD'} from ${onTarget.worktree}`);
    if (onTarget.role === 'foreign') {
      notes.push('that checkout is not ours — nothing was checked out into it, and it may change under you');
    }
  } else if (target && !opts.fresh && usable.some((i) => i.ours && !i.dirty)) {
    action = 'switched';
    inst = await switchTo(usable.find((i) => i.ours && !i.dirty), target, notes);
  } else {
    action = 'cold-start';
    for (const b of usable.filter((i) => !i.ours)) {
      notes.push(b.role === 'foreign'
        ? `left ${b.worktree} alone (not ours)`
        : `left ${b.worktree} alone (it belongs to the run that leased it)`);
    }
    for (const b of usable.filter((i) => i.ours && i.dirty)) {
      notes.push(`left ${b.worktree} alone (${b.dirty} uncommitted file(s))`);
    }
    inst = await cold(target, notes);
  }

  const app = await finishEnv(inst, target, opts.owner);
  return { action, ref: opts.ref || null, elapsedMs: Date.now() - started, notes, app, considered: found.map(summarize) };
  }
}

/**
 * One warm app per loop, each in its own worktree.
 *
 * A conductor calls this once at boot. The point is not the instance itself — it is
 * the shared babel cache under the seed repo's `node_modules`, which every worktree on
 * this machine symlinks: keeping one compile warm is what makes the NEXT worktree's
 * first build two minutes instead of twenty. A loop never adopts another loop's warm
 * instance, because that one is holding a port its owner is about to want.
 */
async function warm(opts) {
  const started = Date.now();
  const notes = [];
  const me = opts.owner || process.env.ONESHOT_CONDUCTOR || os.hostname();
  return withLock('pool', async () => {
    const reg = readJson(REGISTRY, []) || [];
    const ownerOf = (wt) => (reg.find((r) => r.worktree === wt) || {}).owner || null;
    const found = await discover();

    const mine = found.find((i) => i.ours && i.complete && i.healthy && i.bundleReady
      && (ownerOf(i.worktree) === me || ownerOf(i.worktree) === null));
    if (mine) {
      notes.push(`already warm for ${me}: ${mine.worktree} on ${mine.django.port}`);
      const app = await finishEnv({ worktree: mine.worktree, bePort: mine.django.port, fePort: mine.webpack.port,
        djangoPid: mine.django.pid, webpackPid: mine.webpack.pid, bundleUrl: null }, null, me);
      return { action: 'reused', owner: me, elapsedMs: Date.now() - started, notes, app };
    }

    const taken = found.filter((i) => i.ours && ownerOf(i.worktree) && ownerOf(i.worktree) !== me);
    for (const t of taken) notes.push(`left ${t.worktree} alone (warm for ${ownerOf(t.worktree)})`);

    const inst = await cold(null, notes);
    const app = await finishEnv(inst, null, me);
    return { action: 'cold-start', owner: me, elapsedMs: Date.now() - started, notes, app };
  });
}

/**
 * The one contract, written once.
 *
 * Every path — reuse, switch, cold start, worktree-pinned — ends here, so a caller can
 * never tell which one ran from the shape of what it got. The run directory copy is
 * what makes the conductor's bring-up and a phase's own `ensure` interchangeable.
 */
async function finishEnv(inst, target, owner) {
  const app = await H.describeEnv(inst.worktree, inst.bePort, inst.fePort, inst.bundleUrl);
  app.djangoPid = inst.djangoPid;
  app.webpackPid = inst.webpackPid;
  app.head = git(['rev-parse', 'HEAD'], inst.worktree, true);
  app.ref = target ? target.label : null;

  record(app, owner);
  const iid = process.env.ONESHOT_IID || process.env.ONESHOT_TICKET;
  const runDir = process.env.ONESHOT_RUN_DIR
    || (iid ? path.join(ONESHOT_HOME, 'state', 'runs', String(iid)) : null);
  if (runDir) writeJson(path.join(runDir, 'harness', 'app-env.json'), app);
  return app;
}

function record(app, owner) {
  const rows = readJson(REGISTRY, []) || [];
  // Ownership, once set, is sticky: an ad-hoc `ensure` that happens to reuse a loop's
  // warm instance must not quietly take it away from that loop.
  const prior = rows.find((r) => r.worktree === app.worktree);
  const rest = rows.filter((r) => r.worktree !== app.worktree);
  rest.push({ worktree: app.worktree, bePort: app.bePort, fePort: app.fePort,
    djangoPid: app.djangoPid, webpackPid: app.webpackPid, head: app.head,
    owner: owner || (prior && prior.owner) || null, seenAt: new Date().toISOString() });
  writeJson(REGISTRY, rest);
}

/* ------------------------------------------------------------------ gc / down */

/**
 * Orphans are the tax this whole file exists to stop paying: a run ends, its conductor
 * dies, and its two servers hold a port pair until the machine reboots. Four such pairs
 * were live when this was written. Dry-run by default — killing someone's server is not
 * something a tool should do because it felt confident.
 */
async function gc(opts) {
  const found = await discover();
  const doomed = [];
  const kept = [];
  for (const i of found) {
    const gone = !fs.existsSync(i.worktree) || !i.head;
    const reason = i.role === 'foreign' ? null
      : gone ? 'its worktree is gone'
        : !i.complete ? 'it is a half-instance (only one of the two processes)'
          : !i.healthy ? 'Django is not answering'
            : opts.all ? 'gc --all' : null;
    if (reason) doomed.push({ ...summarize(i), reason, pids: [i.django && i.django.pid, i.webpack && i.webpack.pid].filter(Boolean) });
    else {
      const suspect = i.role === 'foreign' && (!i.head || !i.complete || !i.bundleReady);
      kept.push({ ...summarize(i), reason: suspect ? 'not ours, but it looks abandoned — stop it by hand if it is' : (i.role === 'foreign' ? 'not ours' : 'healthy') });
    }
  }
  if (opts.kill) {
    for (const d of doomed) {
      for (const pid of d.pids) {
        try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
      }
    }
    writeJson(REGISTRY, (readJson(REGISTRY, []) || []).filter((r) => !doomed.some((d) => d.worktree === r.worktree)));
  }
  return { killed: opts.kill, wouldKill: doomed, kept, hint: opts.kill ? null : 're-run with --kill to actually stop these' };
}

async function down(opts) {
  const found = await discover();
  const targets = found.filter((i) => (opts.all ? i.role === 'managed' : i.worktree === real(opts.worktree || '')));
  const stopped = [];
  for (const i of targets) {
    for (const pid of [i.webpack && i.webpack.pid, i.django && i.django.pid].filter(Boolean)) {
      try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
      stopped.push({ worktree: i.worktree, pid });
    }
  }
  writeJson(REGISTRY, (readJson(REGISTRY, []) || []).filter((r) => !targets.some((t) => t.worktree === r.worktree)));
  return { stopped };
}

/* ------------------------------------------------------------------ cli */

function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (['--ref', '--worktree', '--port', '--fe-port', '--owner'].includes(a)) { o[a.slice(2)] = argv[i + 1]; i += 1; } else if (a.startsWith('--')) o[a.slice(2)] = true;
    else o._.push(a);
  }
  return o;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parse(rest);
  const out = (o) => console.log(JSON.stringify(o, null, 2));
  try {
    switch (cmd) {
      case 'ensure': out(await ensure(opts)); break;
      case 'warm': out(await warm(opts)); break;
      case 'list': out(await discover().then((f) => f.map(summarize))); break;
      case 'gc': out(await gc(opts)); break;
      case 'down': out(await down(opts)); break;
      default:
        console.log(`app.cjs — one command for "the app must be up, on this code"

  ensure --ref <ref>   reuse / switch / cold-start, whichever applies, then print app-env
                       <ref> is a branch, !<mr-iid>, #<pr-number> or a sha; omit to reuse
                       or start on ${BASE_BRANCH}
         --worktree <path> [--port N] [--fe-port N]
                       bring the app up FOR THAT CHECKOUT and never move its ref — the
                       shape the conductor uses for a run's own leased worktree
         --fresh       skip reuse and cold-start on purpose
  warm [--owner <id>]  ensure ONE warm app for this loop, in its own worktree — what a
                       conductor runs at boot; never adopts another loop's instance
  list                 every app instance running on this machine, ours or not
  gc [--all] [--kill]  find orphaned servers; --kill actually stops them (dry-run default)
  down --all | --worktree <path>

Environment: WORK_REPO, ONESHOT_SEED_FROM, WT_ROOT, ONESHOT_APP_PORTS,
             ONESHOT_SEED_LINKS, ONESHOT_SEED_COPIES, ONESHOT_RUN_DIR|ONESHOT_IID`);
    }
  } catch (err) {
    out(err instanceof AppError || err instanceof H.HarnessError ? err.toJSON()
      : { code: 'E_UNKNOWN', message: String((err && err.message) || err) });
    process.exitCode = 1;
  }
}

module.exports = { ensure, warm, discover, gc, down, resolveRef };
if (require.main === module) main();

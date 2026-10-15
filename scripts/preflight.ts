/**
 * `npm run preflight` — can a run start RIGHT NOW, and what has to be repaired
 * first.
 *
 * Deliberately a second script rather than more sections in `doctor`. Doctor
 * answers a static question — is this machine configured to run Oneshot at all
 * — and its answer is the same at 9am and at midnight. Everything here is about
 * the state of the world at this instant: which tunnel is up, what residue the
 * last run left in the database, whether a credential still authenticates,
 * how much of the rolling window is already gone. Folding the two together
 * would make the cheap, stable check pay for a 25-second ssh probe every time.
 *
 * The design rule is REPAIR, NOT REPORT. Every stale-state item below has the
 * same shape of failure: it is invisible at start, it survives a restart, and
 * it surfaces several phases later as something that reads like a different
 * bug entirely — a pool with no free ports while nothing is listening, a
 * watcher that truthfully reports no claimable tickets because every one of
 * them is held by a run that died. A check that only prints those leaves the
 * operator doing the clean-up by hand, which is the work this script exists to
 * delete. So anything provably dead is cleared here and the repair is printed.
 *
 * The bar for exiting non-zero is likewise not "something looks odd". It is
 * "this would only surface as a confusing failure three phases in".
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { basename, join } from 'node:path';
import {
  PAUSE, PROJECT_TARGET, ROOT, RUNS, WORK_REPO, WT_ROOT,
  budgetConfig, envOr, localTestsConfig, pathSources, phaseByName, portPool, projectConfig,
  repoIdentity, runDir, seedFrom, type LocalTestsConfig,
} from '../src/lib/config.js';
import { cypressLeaseHolder } from '../src/lib/cypresslease.js';
import { db, reconcileForeignRuns } from '../src/lib/db.js';
import { anyLive, liveConductors } from '../src/lib/fleet.js';
import { pidAlive } from '../src/lib/singleton.js';
import { ping } from '../src/lib/gitlab.js';
import { accountWindowPct, checkQuota, dayUsage, windowUsage } from '../src/lib/quota.js';
import {
  checkoutFindings, identityFindings, relaxRepoChecks, repoCheckOverrideNotice, wtRootFinding, type Finding,
} from '../src/lib/repocheck.js';
import { foreignJournalFinding } from '../src/lib/journalproject.js';

let fails = 0;
let warns = 0;

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', C = '\x1b[36m', D = '\x1b[2m', X = '\x1b[0m';

function pass(label: string, detail = ''): void {
  console.log(`  ${G}PASS${X}  ${label}${detail ? ` ${D}${detail}${X}` : ''}`);
}
function warn(label: string, detail = ''): void {
  warns += 1;
  console.log(`  ${Y}WARN${X}  ${label}${detail ? ` ${D}${detail}${X}` : ''}`);
}
function fail(label: string, detail = ''): void {
  fails += 1;
  console.log(`  ${R}FAIL${X}  ${label}${detail ? ` ${D}${detail}${X}` : ''}`);
}
/** A repair that actually changed something on disk — worth its own colour. */
function fixed(label: string, detail = ''): void {
  console.log(`  ${C}FIXED${X} ${label}${detail ? ` ${D}${detail}${X}` : ''}`);
}
/** Not applicable right now, and correctly so. Counts as neither. */
function skip(label: string, detail = ''): void {
  console.log(`  ${D}SKIP${X}  ${label}${detail ? ` ${D}${detail}${X}` : ''}`);
}
function section(name: string): void { console.log(`\n${name}`); }
function report(f: Finding): void {
  if (f.level === 'fail') fail(f.label, f.detail);
  else if (f.level === 'warn') warn(f.label, f.detail);
  else pass(f.label, f.detail);
}

// --------------------------------------------------------------------- project

/**
 * The same refusals boot makes (src/index.ts), so "READY" here can never
 * precede a conductor that will not start: an unusable GITLAB_REPO_URL, a
 * legacy selector that disagrees with it, a WORK_REPO or seed cloned from
 * another project, a WT_ROOT shared with another project or moved away from
 * this project's worktrees. Past an unusable URL there is no project to judge
 * the rest against, so they are not run.
 */
function checkProject(): void {
  section('Project');
  const override = repoCheckOverrideNotice();
  if (override) report({ level: 'warn', label: 'repo checks overridden', detail: override });
  for (const f of relaxRepoChecks(identityFindings())) report(f);
  if (!repoIdentity().repo) return;
  if (!WORK_REPO || !existsSync(WORK_REPO)) fail('WORK_REPO does not exist', WORK_REPO || 'no path');
  const sources = pathSources();
  const wt = wtRootFinding(WT_ROOT, sources.WT_ROOT, PROJECT_TARGET);
  const checks = [...checkoutFindings({ workRepo: WORK_REPO, seed: seedFrom(), sources }), ...(wt ? [wt] : [])];
  for (const f of relaxRepoChecks(checks)) report(f);
  const foreignRuns = foreignJournalFinding();
  if (foreignRuns) report(foreignRuns);
}

// --------------------------------------------------------------------- network

interface GitlabIdentity { id: number; username: string; name: string; bot?: boolean }

/**
 * Which account the write token resolves to.
 *
 * Not cosmetic. Every label swap, note, MR and merge Oneshot performs is
 * attributed to whoever this is, permanently and in public. A personal token
 * quietly left in .env turns an autonomous pipeline into a stream of activity
 * signed by a human who was asleep — and it is invisible from this side,
 * because a personal token authenticates exactly as well as a bot one.
 */
async function tokenIdentity(): Promise<GitlabIdentity | null> {
  const token = envOr('GITLAB_TOKEN');
  const api = repoIdentity().repo?.apiUrl;
  if (!token || !api) return null;
  const controller = new AbortController();
  const killer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(`${api}/user`, {
      headers: { 'PRIVATE-TOKEN': token },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json() as GitlabIdentity;
  } catch {
    return null;
  } finally {
    clearTimeout(killer);
  }
}

/** GitLab marks token users `bot: true`; project tokens also carry it in the name. */
function isBotAccount(u: GitlabIdentity): boolean {
  return u.bot === true || /_bot(_|$)/.test(u.username);
}

async function checkNetwork(): Promise<void> {
  section('Network');

  if (!envOr('GITLAB_TOKEN')) {
    fail('GITLAB_TOKEN unset', 'nothing can be claimed, labelled or merged');
  } else if (!repoIdentity().repo) {
    skip('GitLab', 'no project to reach until GITLAB_REPO_URL is fixed (see Project)');
  } else {
    const p = await ping();
    if (p.ok) {
      pass('GitLab reachable + authenticated', `project id ${p.data?.id}`);
    } else if (p.kind === 'network' || p.kind === 'server') {
      fail('GitLab unreachable', 'connect the VPN — that subnet is FortiClient-gated');
    } else if (p.kind === 'auth') {
      fail('GitLab refused the token', `HTTP ${p.status} — it needs scope 'api'`);
    } else {
      fail('GitLab error', `${p.kind} HTTP ${p.status}`);
    }

    const who = await tokenIdentity();
    if (!who) {
      warn('could not resolve the token identity', 'GET /user did not answer');
    } else if (isBotAccount(who)) {
      pass('token identity', `${who.username} (bot)`);
    } else {
      warn('GITLAB_TOKEN is NOT a bot account',
        `every label swap, note, MR and merge will be attributed to ${who.username}`);
    }
  }

}

// ----------------------------------------------------------------- stale state

function portLeasesTableExists(): boolean {
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'port_leases'",
  ).get() as { n: number };
  return row.n > 0;
}

/**
 * Clear what a dead conductor left behind.
 *
 * The whole section is gated on the fleet being EMPTY, and the gate is the
 * load-bearing part. Every repair here decides "dead" from the runs table, which
 * is only trustworthy while nothing is writing to it: reconciling rows out from
 * under a live conductor would abort healthy in-flight runs and hand their ports
 * to somebody else. That question used to have a one-word answer because there
 * could only ever be one conductor; now it is a roll call, and a single live
 * peer is enough to make every repair below unsafe.
 *
 * The fleet is asked rather than the PID lock, because the lock is only written
 * by a --solo start and says nothing at all about the ordinary case.
 */
function repairStaleState(): void {
  section('Stale state');

  if (anyLive()) {
    const live = liveConductors();
    warn(`${live.length} conductor(s) are live`,
      `${live.map((c) => `${c.conductor_id.slice(0, 6)}:${c.pid}`).join(', ')} — their runs are ` +
      'in flight, ' +
      'so nothing below is repaired; stop them first if you meant to');
    reportPauseSwitches();
    return;
  }
  pass('no conductor is live', 'nothing else is writing to the runs table');

  // An empty live set, so every claimed/running row in there is foreign to
  // somebody who no longer exists.
  const reaped = reconcileForeignRuns([]);
  if (reaped) {
    fixed(`buried ${reaped} run row(s) left claimed/running`,
      'their tickets are claimable again and resume from the last phase that succeeded');
  } else {
    pass('no orphaned run rows');
  }

  if (!portLeasesTableExists()) {
    pass('no port leases to reclaim', 'the pool has never been leased from');
  } else {
    const freed = db.prepare(`DELETE FROM port_leases WHERE run_id NOT IN
      (SELECT run_id FROM runs WHERE status IN ('claimed','running'))`).run();
    const held = db.prepare('SELECT COUNT(*) AS n FROM port_leases').get() as { n: number };
    if (freed.changes) {
      fixed(`reclaimed ${freed.changes} orphaned port lease(s)`,
        `${portPool().length - held.n} of ${portPool().length} pool ports now free`);
    } else {
      pass('no orphaned port leases', `${portPool().length - held.n} of ${portPool().length} free`);
    }
  }

  reportPauseSwitches();
}

/**
 * The switch that is reported and never repaired.
 *
 * state/PAUSE is the human kill switch, and the rule the rest of the system
 * already keeps is that nothing automatic may create or clear it. Clearing it
 * here would be this script overruling a decision somebody made on purpose.
 *
 * They still belong in a preflight, because from the outside a paused system is
 * indistinguishable from a working one with nothing to do: the conductor starts,
 * logs that it is paused once a minute, and never claims anything. That is
 * exactly the failure this script exists to make visible, so it is a FAIL —
 * the run the operator is about to start will not happen.
 *
 * PAUSE-NETWORK is deliberately absent: the guards already ignore one older
 * than fifteen minutes, so it cannot outlive the outage it describes.
 */
function reportPauseSwitches(): void {
  for (const [file, what] of [
    [PAUSE, 'the human kill switch'],
  ] as Array<[string, string]>) {
    if (existsSync(file)) {
      fail(`state/${basename(file)} is set`, `${what} — remove it by hand when you mean to resume`);
    }
  }
}

// ----------------------------------------------------------------- credentials

/**
 * The app's own login endpoint. Verified by POSTing to it rather than by
 * checking the variable is non-empty, because the failure being caught is a
 * credential that has DRIFTED — the string is still there and still looks
 * right, and the only thing that knows otherwise is the server.
 */
const LOGIN_PATH = '/api/v1/core/email-login/';

interface Credential { user: string; secretLen: number; secret: string }

/** `email:password`, password-last so a colon inside the password survives. */
function splitCredential(raw: string): Credential | null {
  const [user, ...rest] = raw.split(':');
  const secret = rest.join(':');
  if (!user || !secret) return null;
  return { user, secretLen: secret.length, secret };
}

/**
 * What a status from the login endpoint actually means.
 *
 * The distinction that matters is `rejected` versus `host`. The endpoint
 * answers 404 for a bad email or password — that is the credential drift this
 * whole section exists to catch, and it is worth failing over. A 400 is almost
 * never the credential: Django serves its stock "Bad Request (400)" page for a
 * Host outside ALLOWED_HOSTS, which is the same trap config/deploy.json
 * documents for the demo box's health probe. Reporting that as a rejected
 * password sends the operator off to re-pin a credential that was correct all
 * along.
 */
type LoginVerdict = 'ok' | 'rejected' | 'host' | 'other';

function loginVerdict(status: number): LoginVerdict {
  if (status === 200) return 'ok';
  if (status === 404) return 'rejected';
  if (status === 400) return 'host';
  return 'other';
}

async function postLogin(
  baseUrl: string, cred: Credential, timeoutMs: number,
): Promise<{ status: number; error?: string }> {
  const controller = new AbortController();
  const killer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}${LOGIN_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: cred.user, password: cred.secret }),
      signal: controller.signal,
    });
    return { status: res.status };
  } catch (err) {
    return { status: 0, error: (err as Error).message.slice(0, 120) };
  } finally {
    clearTimeout(killer);
  }
}

/**
 * TCP-level, not HTTP: a webpack build that has not finished still accepts.
 *
 * Probed on the literal 127.0.0.1 rather than the name: `localhost` may resolve
 * to ::1 ahead of the v4 address, and a dev server bound to IPv4 only would
 * then look dead. The HTTP request that follows uses the NAME instead, for the
 * opposite reason — see localBaseUrl().
 */
function listening(port: number, timeoutMs = 600): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    const done = (r: boolean): void => { socket.destroy(); resolve(r); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function firstLivePort(): Promise<number | null> {
  for (const p of portPool()) if (await listening(p)) return p;
  return null;
}

/**
 * `localhost`, never the IP.
 *
 * fetch derives the Host header from the URL, and the app's ALLOWED_HOSTS
 * carries the name and not the address — so a request to http://127.0.0.1:8000
 * is refused with Django's stock 400 page before it ever reaches the login
 * view, no matter how correct the credential is.
 */
function localBaseUrl(port: number): string { return `http://localhost:${port}`; }

const LOCAL_LOGIN_TIMEOUT_MS = 10_000;
const DEMO_LOGIN_TIMEOUT_MS = 25_000;

/**
 * Prove the managed logins still work.
 *
 * Nothing in here ever prints a password or a token: names and lengths only.
 * The length is worth printing on its own — a credential mangled by a shell
 * that ate the rest of the line reads as "set" everywhere else in the system
 * and only shows up as a wrong length here.
 */
async function checkCredentials(): Promise<void> {
  section('Credentials');

  const local = splitCredential(envOr('ONESHOT_TEST_LOGIN'));
  if (!local) {
    warn('ONESHOT_TEST_LOGIN unset or malformed',
      'expected email:password — without it the local phases are told to set passwords ' +
      'themselves, which is the loop that burns a budget concluding the app is broken');
  } else {
    const port = await firstLivePort();
    if (port === null) {
      skip('local login not verified',
        `nothing is listening on ${portPool().join(', ')} — there is no local server before a run`);
    } else {
      const res = await postLogin(localBaseUrl(port), local, LOCAL_LOGIN_TIMEOUT_MS);
      const where = `${local.user} on :${port}`;
      if (res.status === 0) {
        warn(`:${port} answered nothing`, `${res.error} — it may not be the app`);
      } else {
        switch (loginVerdict(res.status)) {
          case 'ok':
            pass('local login accepted', `${where} (password ${local.secretLen} chars)`);
            break;
          case 'rejected':
            fail('local login REJECTED', `${where} — re-pin the password before verify runs`);
            break;
          case 'host':
            warn(`:${port} refused the request before the login view`,
              `HTTP 400 — either localhost is outside its ALLOWED_HOSTS, or :${port} is not the app`);
            break;
          default:
            warn('local login answered oddly', `${where} returned HTTP ${res.status}`);
        }
      }
    }
  }

}


// ---------------------------------------------------------------- dependencies

const NPM_SCRIPT_TIMEOUT_MS = 240_000;

/**
 * Run an existing verifier and surface its verdict.
 *
 * Shelled out rather than reimplemented on purpose. Both scripts encode
 * expensive lessons about what a real probe has to do — spawning an MCP server
 * for real and demanding a non-empty tools list, executing the guard scripts
 * against fixtures — and a second copy of that logic here would be a second
 * thing to keep true. The exit code is the whole answer; the detail lives one
 * command away.
 */
function verifierPasses(script: string): void {
  const res = spawnSync('npm', ['run', '--silent', script], {
    cwd: ROOT, encoding: 'utf8', timeout: NPM_SCRIPT_TIMEOUT_MS,
  });
  const tail = `${res.stdout ?? ''}${res.stderr ?? ''}`
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';

  if (res.status === 0) pass(`npm run ${script}`, tail);
  else fail(`npm run ${script} exited ${res.status ?? 'on a signal'}`, `${tail} — run it for the detail`);
}

function checkDependencies(): void {
  section('Dependencies');
  verifierPasses('deps:verify');
  verifierPasses('hooks:verify');
}

// ----------------------------------------------------------------- local tests

/**
 * One query against the desk's Postgres, as `psql -XAtqw`: no psqlrc, bare
 * rows, never a password prompt.
 *
 * Always through the `postgres` maintenance database. Connecting to the
 * baseline to ask about it would put a session on it, which is the one thing
 * that makes Postgres refuse to copy it.
 */
function psql(pg: LocalTestsConfig['pg'], sql: string): { ok: boolean; out: string; error: string } {
  const res = spawnSync('psql', [
    '-h', pg.host, '-p', String(pg.port), ...(pg.user ? ['-U', pg.user] : []),
    '-d', 'postgres', '-XAtqw', '-c', sql,
  ], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, PGCONNECT_TIMEOUT: '5' } });
  if (res.error) {
    const missing = (res.error as NodeJS.ErrnoException).code === 'ENOENT';
    return { ok: false, out: '', error: missing ? 'psql is not on PATH (brew install libpq)' : res.error.message };
  }
  const error = (res.stderr ?? '').split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 160) ?? '';
  return { ok: res.status === 0, out: (res.stdout ?? '').trim(), error };
}

/** `node scripts/localtests.cjs gc`, with the --keep a live fleet needs. */
function gcHint(): string {
  return anyLive()
    ? 'a conductor is live, so some may be in use — `node scripts/localtests.cjs gc --dry-run --keep <iid,…>` ' +
      'with the tickets in flight, then without --dry-run'
    : '`node scripts/localtests.cjs gc --dry-run` to see what goes, then without --dry-run';
}

/**
 * Every package the base branch's package.json names that the seed's
 * node_modules does not have.
 *
 * Found by the pilot: worktrees borrow node_modules from the seed checkout, so
 * when the base branch adds a dependency (posthog-js) and nobody re-installs
 * the seed, every app a run starts — verify's and the local-tests run's alike
 * — dies in webpack with "Unable to resolve module", which reads like the
 * ticket broke the build. Read from origin/<base> as of the last fetch, with
 * `git show`, so nothing is fetched or checked out here.
 */
function checkNodeModulesDrift(): void {
  const base = projectConfig().branches.base;
  const seed = seedFrom();
  if (!seed || !existsSync(join(seed, 'node_modules'))) {
    skip('node_modules drift not checked', seed
      ? `${seed} has no node_modules — see doctor's seed repo check`
      : 'no seed repo configured (ONESHOT_SEED_FROM) — see doctor');
    return;
  }
  const shown = spawnSync('git', ['-C', WORK_REPO, 'show', `origin/${base}:package.json`], {
    encoding: 'utf8', timeout: 20_000,
  });
  let names: string[] = [];
  try {
    const pkg = JSON.parse(shown.stdout ?? '') as
      { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    names = [...new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})])];
  } catch {
    warn('node_modules drift not checked', `could not read origin/${base}:package.json in ${WORK_REPO}`);
    return;
  }
  const missing = names.filter((n) => !existsSync(join(seed, 'node_modules', n, 'package.json'))).sort();
  if (!missing.length) {
    pass('seed node_modules has every base-branch dependency', `${names.length} in origin/${base}:package.json`);
    return;
  }
  fail(`seed node_modules is behind origin/${base}: ${missing.length} package(s) missing`,
    `${missing.join(', ')} — webpack stops with "Unable to resolve module". ` +
    `Run npm ci in the seed ERP checkout (${seed}) on the base branch (${base})`);
}

/**
 * Can a local-tests run start cleanly right now?
 *
 * Doctor has already said whether this desk is set up for the mode; this is
 * the part that changes between runs. Reported, never repaired: a leftover
 * database or worktree may belong to a run a live conductor is in the middle
 * of, and `scripts/localtests.cjs gc` is the one place that knows how to tell.
 */
function checkLocalTests(): void {
  section('Local tests');
  const lt = localTestsConfig();
  if (!lt.enabled) {
    if (lt.repo) warn('local tests: off', lt.off ?? '');
    else skip('local tests: off', lt.off ?? '');
    return;
  }
  // Said here too, because this is what an operator reads before starting the
  // conductor: which tickets this desk will pick up for a local run.
  pass('local tests on', `after the merge, for tickets labelled "${lt.labels.trigger}" — `
    + `"${lt.labels.running}" while a run is in progress, "${lt.labels.done}" when it is over`);

  const holder = cypressLeaseHolder();
  if (holder) {
    const age = `${Math.round((Date.now() - holder.acquiredAt) / 60_000)}m`;
    if (pidAlive(holder.pid)) {
      pass('Cypress is in use', `${holder.runId} (pid ${holder.pid}) for ${age} — the next run waits its turn`);
    } else {
      warn('Cypress lease held by a process that is gone',
        `${holder.runId} (pid ${holder.pid}), ${age} ago — the next run reclaims it`);
    }
  }

  const where = `${lt.pg.user ? `${lt.pg.user}@` : ''}${lt.pg.host}:${lt.pg.port}`;
  const up = psql(lt.pg, 'SELECT 1');
  if (!up.ok) {
    fail('Postgres not reachable with psql', `${where} — ${up.error || 'no answer'}; every local-tests run copies its database there`);
  } else {
    // Both names are checked lower-case identifiers (localTestsConfig), so they are safe as literals.
    const baseline = psql(lt.pg, `SELECT 1 FROM pg_database WHERE datname = '${lt.baselineDb}'`);
    if (baseline.out !== '1') {
      fail('baseline database missing', `${lt.baselineDb} on ${where} — restore the automation dump into it (docs/LOCAL-TESTS.md)`);
    } else {
      // Who is on it, by application name (or role), so the operator knows what to close.
      const sessions = psql(lt.pg,
        "SELECT count(*), coalesce(string_agg(DISTINCT coalesce(nullif(application_name, ''), usename), ', '), '') "
        + `FROM pg_stat_activity WHERE datname = '${lt.baselineDb}'`);
      const [count = '', apps = ''] = sessions.out.split('|');
      if (!sessions.ok) warn('baseline sessions not checked', sessions.error);
      else if (Number(count) === 0) pass('baseline is free to copy', `${lt.baselineDb}, no sessions`);
      else {
        warn(`${count} session(s) connected to the baseline`,
          `${lt.baselineDb} (${apps || 'unnamed'}) — Postgres refuses to copy a database anything is connected to; ` +
          'close them before a run (a psql, pgAdmin, a Django shell pointed at it)');
      }
    }

    const copies = psql(lt.pg,
      `SELECT datname FROM pg_database WHERE left(datname, ${lt.dbPrefix.length}) = '${lt.dbPrefix}' ORDER BY 1`);
    const dbs = copies.out ? copies.out.split('\n') : [];
    if (!copies.ok) warn('leftover run databases not checked', copies.error);
    else if (dbs.length) warn(`${dbs.length} run database(s) left behind`, `${dbs.join(', ')} — ${gcHint()}`);
    else pass('no leftover run databases', `nothing named ${lt.dbPrefix}*`);
  }

  checkLocalTestsLeftovers();
  checkNodeModulesDrift();
}

/**
 * The throwaway worktrees a local-tests run may own under state/runs/<iid>/,
 * from the runner itself so this list cannot fall behind it: the scope's
 * `wsa`, and the run's `wsa-run` (which holds the merged credentials file),
 * `erp-lt` and `erp-base-lt`.
 */
const LT_WORKTREES: readonly string[] =
  (createRequire(import.meta.url)('./localtests.cjs') as { WT_NAMES: string[] }).WT_NAMES;

/** The run's record of everything it created, written before each thing is. */
const RESOURCES_FILE = 'local-tests-resources.json';

/** A pid that is alive AND is a localtests process — a recycled pid is not a run. */
function liveLocalTests(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) return false;
  const ps = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 });
  return /localtests/.test(ps.stdout ?? '');
}

/**
 * What a crashed run leaves on disk: any of its four worktrees, and a
 * resources file whose process is gone. cleanup() drops the database before it
 * removes the worktrees, so a run killed between the two leaves `wsa-run` and
 * `erp-lt` with no database — checking only for `wsa` passed that desk clean.
 * A ticket whose resources file names a live localtests process is in use, not
 * left behind, and is reported as such.
 */
function checkLocalTestsLeftovers(): void {
  const iids = existsSync(RUNS) ? readdirSync(RUNS).filter((d) => /^\d+$/.test(d)).map(Number) : [];
  const live = new Set<number>();
  const stale: string[] = [];
  for (const iid of iids) {
    const file = join(runDir(iid), RESOURCES_FILE);
    if (!existsSync(file)) continue;
    let pid: unknown = null;
    try { pid = (JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown }).pid; } catch { /* unreadable = stale */ }
    if (liveLocalTests(pid)) live.add(iid);
    else stale.push(`state/runs/${iid}/${RESOURCES_FILE}`);
  }
  if (live.size) {
    pass('local-tests run in progress', `ticket(s) ${[...live].join(', ')} — their worktrees are in use, not leftovers`);
  }

  const worktrees = iids.filter((iid) => !live.has(iid)).flatMap((iid) => LT_WORKTREES
    .filter((name) => existsSync(join(runDir(iid), name))).map((name) => `state/runs/${iid}/${name}`));
  if (worktrees.length) {
    warn(`${worktrees.length} local-tests worktree(s) left behind`, `${worktrees.join(', ')} — ${gcHint()}`);
  } else {
    pass('no leftover local-tests worktrees', `none of ${LT_WORKTREES.join(', ')} under state/runs/*`);
  }
  if (stale.length) {
    warn(`${stale.length} stale local-tests resources file(s)`,
      `${stale.join(', ')} — the run that wrote it is gone, and what it names may still be held; ${gcHint()}`);
  } else {
    pass('no stale local-tests resources files', `no ${RESOURCES_FILE} without its run`);
  }
}

// ----------------------------------------------------------------------- quota

function millions(n: number): string { return `${(n / 1e6).toFixed(2)}M`; }

/**
 * What is left of the shared window.
 *
 * The ceilings are weighted tokens, not dollars, and they are shared with the
 * operator's own interactive sessions — so the number that matters is headroom,
 * not spend. Two different things can make a run pointless to start: the
 * conductor would refuse to claim at all, which is a FAIL because it looks
 * identical to an idle pipeline with nothing to do; or there is enough headroom
 * to claim but not enough to carry the heaviest phase, which parks the run
 * mid-flight with a worktree and a branch already in existence.
 */
function checkQuotaHeadroom(): void {
  section('Quota');

  const cfg = budgetConfig();

  // With the ceilings switched off, reporting spend AGAINST them would read as a
  // budget that still bites. Report the spend as an observation and say plainly
  // what is bounding a phase instead.
  if (cfg.enabled === false) {
    skip('token ceilings disabled', 'budgets.json enabled:false — maxTurns/timeoutMin bound each phase');
    pass(`${cfg.window_hours}h window spend`, `${millions(windowUsage())} weighted (not capped)`);
    pass('day spend', `${millions(dayUsage())} weighted (not capped)`);
    const parked = checkQuota();
    parked.allowed
      ? pass('not parked', 'no subscription limit currently in effect')
      : fail('a run could not start now', parked.reason);
    return;
  }

  const win = windowUsage();
  const day = dayUsage();
  const winPct = Math.round((win / cfg.window_tokens) * 100);
  const dayPct = Math.round((day / cfg.day_tokens) * 100);

  const winLine = `${millions(win)} / ${millions(cfg.window_tokens)} weighted (${winPct}%)`;
  const dayLine = `${millions(day)} / ${millions(cfg.day_tokens)} weighted (${dayPct}%)`;
  winPct >= cfg.warn_pct
    ? warn(`${cfg.window_hours}h window`, winLine)
    : pass(`${cfg.window_hours}h window`, winLine);
  dayPct >= cfg.warn_pct ? warn('day', dayLine) : pass('day', dayLine);

  const accountPct = accountWindowPct();
  if (accountPct === null) {
    skip('account-wide window unknown',
      'the status-line signal is absent or stale — the ceilings above stand alone');
  } else if (accountPct >= cfg.reserve.pause_at_five_hour_pct) {
    warn(`account 5h window ${accountPct}% consumed`,
      `at or past the ${cfg.reserve.pause_at_five_hour_pct}% reserve — claims are held back`);
  } else {
    pass(`account 5h window ${accountPct}% consumed`,
      `reserve holds at ${cfg.reserve.pause_at_five_hour_pct}%`);
  }

  const verdict = checkQuota();
  if (!verdict.allowed) {
    fail('a run could not start now', verdict.reason);
    return;
  }

  const heaviest = Object.entries(cfg.phases)
    .reduce((top, e) => (e[1] > top[1] ? e : top), ['none', 0] as [string, number]);
  const headroom = cfg.window_tokens - win;
  if (headroom < heaviest[1]) {
    warn('a run would start and then park mid-flight',
      `${millions(headroom)} of window headroom is under '${heaviest[0]}' at ${millions(heaviest[1])}`);
  } else {
    pass('headroom clears the heaviest phase',
      `${millions(headroom)} left, '${heaviest[0]}' needs up to ${millions(heaviest[1])}`);
  }
}

// ------------------------------------------------------------------------ main

async function main(): Promise<void> {
  console.log('\nOneshot preflight');

  checkProject();
  await checkNetwork();
  repairStaleState();
  await checkCredentials();
  checkDependencies();
  checkLocalTests();
  checkQuotaHeadroom();

  const verdict = fails
    ? `${R}NOT READY${X} — ${fails} failed, ${warns} warnings`
    : `${G}READY${X} — 0 failed, ${warns} warnings`;
  console.log(`\n${verdict}\n`);
  process.exit(fails ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n${R}preflight crashed${X}: ${(err as Error).message}\n`);
  process.exit(1);
});

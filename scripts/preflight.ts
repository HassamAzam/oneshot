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
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { basename, join } from 'node:path';
import {
  PAUSE, PAUSE_DEPLOY, ROOT, STATE,
  budgetConfig, deployConfig, envOr, phaseByName, portPool, projectConfig,
} from '../src/lib/config.js';
import { db, reconcileStaleRuns } from '../src/lib/db.js';
import { ping } from '../src/lib/gitlab.js';
import { accountWindowPct, checkQuota, dayUsage, windowUsage } from '../src/lib/quota.js';
import { demoHostReachable } from '../src/lib/reachability.js';
import { acquire, release } from '../src/lib/singleton.js';

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
  if (!token) return null;
  const controller = new AbortController();
  const killer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(`${projectConfig().gitlab.apiUrl}/user`, {
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

  const d = deployConfig();
  if (await demoHostReachable()) {
    pass('demo host reachable', d.server);
  } else {
    fail(`demo host ${d.server} unreachable`,
      d.vpnGated
        ? 'connect the VPN — deploy and qa would burn their whole wall clock against it'
        : 'deploy and qa would burn their whole wall clock against it');
  }
}

// ----------------------------------------------------------------- stale state

const LOCK = join(STATE, 'conductor.pid');

function peekLock(): { pid: number } | null {
  if (!existsSync(LOCK)) return null;
  try {
    return JSON.parse(readFileSync(LOCK, 'utf8')) as { pid: number };
  } catch {
    return { pid: 0 };
  }
}

function portLeasesTableExists(): boolean {
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'port_leases'",
  ).get() as { n: number };
  return row.n > 0;
}

/**
 * Clear what a dead conductor left behind.
 *
 * The whole section is gated on there being no LIVE conductor, and the gate is
 * the load-bearing part. Every repair here decides "dead" from the runs table,
 * which is only trustworthy while nothing is writing to it: reconciling rows
 * out from under a running conductor would abort healthy in-flight runs and
 * hand their ports to somebody else. The PID lock answers that question
 * definitively, so it is taken first and the rest is skipped when it is held.
 *
 * The lock is acquired and immediately released rather than merely inspected —
 * acquire() already implements the exact staleness rule the conductor uses, and
 * a second copy of "is this PID alive" that drifts from it would be worse than
 * the hand clean-up it replaces.
 */
function repairStaleState(): void {
  section('Stale state');

  const before = peekLock();
  const lock = acquire();
  if (!lock.ok) {
    warn(`a conductor is already running (pid ${lock.heldBy?.pid})`,
      'its runs are live, so nothing below is repaired — stop it first if you meant to');
    return;
  }
  release();
  if (before) fixed('cleared a stale conductor lock', `pid ${before.pid} is gone`);
  else pass('no conductor lock held');

  const reaped = reconcileStaleRuns();
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
 * The two switches that are reported and never repaired.
 *
 * state/PAUSE is the human kill switch, and the rule the rest of the system
 * already keeps is that nothing automatic may create or clear it; PAUSE-DEPLOY
 * is a deliberate hold on the one irreversible phase. Clearing either here
 * would be this script overruling a decision somebody made on purpose.
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
    [PAUSE_DEPLOY, 'the deploy hold'],
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

  const demoUrl = deployConfig().demoUrl;
  const demo = splitCredential(envOr('ONESHOT_DEMO_LOGIN'));
  if (!demo) {
    const qaRuns = phaseByName('qa') !== undefined;
    const detail = 'the demo box carries its own snapshot, so local credentials do not exist there';
    if (qaRuns) fail('ONESHOT_DEMO_LOGIN unset or malformed', `${detail} — qa will block`);
    else warn('ONESHOT_DEMO_LOGIN unset or malformed', `${detail} (qa is not in the phase list)`);
  } else {
    const res = await postLogin(demoUrl, demo, DEMO_LOGIN_TIMEOUT_MS);
    const where = `${demo.user} at ${demoUrl}`;
    if (res.status === 0) {
      fail(`${demoUrl} did not answer`, `${res.error} — VPN, or the box is down`);
    } else {
      switch (loginVerdict(res.status)) {
        case 'ok':
          pass('demo login accepted', `${where} (password ${demo.secretLen} chars)`);
          break;
        case 'rejected':
          fail('demo login REJECTED', `${where} — re-provision it before qa runs`);
          break;
        case 'host':
          fail('the demo box refused the request before the login view',
            `${demoUrl} answered HTTP 400 — that host is outside its ALLOWED_HOSTS`);
          break;
        default:
          fail('demo login answered oddly', `${where} returned HTTP ${res.status}`);
      }
    }
  }

  await checkDemoAdmin();
}

const ADMIN_TIMEOUT_MS = 20_000;

/**
 * Django admin on the demo box — reachability only, never a login attempt.
 *
 * The admin login form is CSRF-protected, so a POST from here would have to
 * scrape a token and carry a cookie jar to prove anything, and a failure would
 * then be ambiguous between "the credential is wrong" and "this script got the
 * form handshake wrong". The question worth answering cheaply is the one that
 * actually bites: whether the panel is served at all on this deploy, because
 * when it is not, a phase that needs to arrange a precondition discovers it
 * mid-run and blocks the case.
 */
async function checkDemoAdmin(): Promise<void> {
  const url = envOr('ONESHOT_DEMO_ADMIN_URL');
  const cred = splitCredential(envOr('ONESHOT_DEMO_ADMIN'));

  if (!url && !cred) {
    skip('demo admin not provisioned', 'phases will mark unmeetable preconditions blocked');
    return;
  }
  if (!url || !cred) {
    warn('demo admin is half-provisioned',
      `${url ? 'ONESHOT_DEMO_ADMIN' : 'ONESHOT_DEMO_ADMIN_URL'} is missing — phases treat it as absent`);
    return;
  }

  const controller = new AbortController();
  const killer = setTimeout(() => controller.abort(), ADMIN_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (res.ok) pass('demo admin reachable', `${url} (user ${cred.user}, password ${cred.secretLen} chars)`);
    else fail('demo admin did not serve a login page', `${url} answered HTTP ${res.status}`);
  } catch (err) {
    fail('demo admin unreachable', `${url} — ${(err as Error).message.slice(0, 120)}`);
  } finally {
    clearTimeout(killer);
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

  await checkNetwork();
  repairStaleState();
  await checkCredentials();
  checkDependencies();
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

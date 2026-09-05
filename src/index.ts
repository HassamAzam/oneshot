/**
 * Oneshot entry point. `npm start`.
 *
 * The conductor is a deterministic TypeScript state machine, not a model. It
 * schedules, validates, retries and reaps; an LLM runs only inside a phase.
 * That is what makes "clear the context between tickets" free rather than a
 * feature — there is no conductor context to clear.
 *
 * On a tick it probes the network, honours the pause/quota switches, scans for
 * tickets carrying the entry label, and fills whatever dispatch slots are free.
 * Runs are NOT awaited: the tick loop keeps scanning while they are in flight,
 * which is what makes `concurrency` mean anything. --watch-only reports what it
 * would claim without claiming it.
 *
 * Several of these may run at once, on purpose. A conductor registers in the
 * fleet at boot rather than refusing to start beside a sibling, and everything
 * that used to be guaranteed by there being exactly one process is now decided
 * against that registry: a ticket is claimed by ownership, a run row is buried
 * only when the conductor that owned it is gone, and dispatch slots are counted
 * across the whole machine because the port pool is shared between all of them.
 * --solo puts the old refusal back for anyone who wants it.
 */
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONTEXT_REPO, DRY_RUN, FOLLOW_TICK_MS, PAUSE, RUNS, MEMORY, ROOT, SKILLS_ROOT, TICK_MS,
  WORK_REPO,
  auditAuth, envOr, phases, portPool, projectConfig, slackConfig,
} from './lib/config.js';
import { activeRunsFleet, logEvent, reconcileForeignRuns } from './lib/db.js';
import { ensureClaudeDir } from './lib/claudedir.js';
import { probe, netState } from './lib/reachability.js';
import { windowUsage, dayUsage, quotaParked } from './lib/quota.js';
import { budgetConfig } from './lib/config.js';
import { describe, scan } from './conductor/watcher.js';
import { runTicket, type RunOutcome } from './conductor/runner.js';
import {
  deregister, heartbeat, liveConductorIds, liveConductors, peersEverSeen, register,
} from './lib/fleet.js';
import { renewPromotion } from './lib/promotion.js';
import { getIssue, projectUrl } from './lib/gitlab.js';
import { alert } from './lib/slack.js';
import { log } from './lib/log.js';
import { refuseIfAnotherConductor } from './lib/singleton.js';

/**
 * How long the watcher may sit held by an unreachable GitLab before the owner
 * is told. The breaker's `recovering` state is designed to absorb a flapping
 * tunnel indefinitely, which is correct and also means a VPN that never comes
 * back looks exactly like a quiet board: one innocuous `holding — network
 * recovering` line a minute, forever.
 */
const OUTAGE_ALERT_MS = 30 * 60_000;

const watchOnly = process.argv.includes('--watch-only');

/**
 * `--solo` — the old refusal, kept for the operator who wants it.
 *
 * Several conductors sharing a machine is now the ordinary case: they claim
 * against each other through the database and divide the port pool between them.
 * But "am I definitely the only one" is still a question worth being able to
 * answer at boot, before a database is even opened, and the PID lock answers it
 * for free. Anyone driving one careful ticket by hand can have the guarantee
 * back by asking.
 */
const solo = process.argv.includes('--solo');

/**
 * This conductor's identity in the fleet. Set by register() at boot; every claim,
 * every promotion lease and every reconciliation is decided against it.
 */
let me = '';

/**
 * Three conductors write to three terminals but into ONE log history, one Slack
 * channel and one operator's memory. The id prefix is what makes a line
 * attributable — and it only appears once a peer has actually been seen, so the
 * ordinary single-conductor console stays exactly as readable as it was.
 */
function tag(msg: string): string {
  return peersEverSeen() ? `${me.slice(0, 6)}  ${msg}` : msg;
}

const say = {
  info: (msg: string, extra?: unknown) => log.info(tag(msg), extra),
  ok: (msg: string, extra?: unknown) => log.ok(tag(msg), extra),
  warn: (msg: string, extra?: unknown) => log.warn(tag(msg), extra),
  error: (msg: string, extra?: unknown) => log.error(tag(msg), extra),
  phase: (msg: string, extra?: unknown) => log.phase(tag(msg), extra),
};

/**
 * In-flight runs, keyed by ticket. This — not the SQLite view — is the
 * in-process truth for how many slots are occupied: a row is written a few
 * statements into runTicket, so counting rows would race with a dispatch that
 * has not reached its first await.
 */
const running = new Map<number, Promise<unknown>>();

/**
 * One controller for the whole process. On the first signal it is aborted, the
 * runs stop at their next phase boundary and finish 'aborted' — which is a
 * RESUMABLE status, so the next boot picks each ticket up from its journal.
 */
const aborter = new AbortController();

let stopping = false;

/** Set while the tick loop is asleep, so a signal does not wait out the tick. */
let wake: (() => void) | null = null;

function nap(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { wake = null; resolve(); }, ms);
    wake = () => { clearTimeout(timer); wake = null; resolve(); };
  });
}

/**
 * How long until the next tick — TICK_MS ordinarily, backed off while the
 * network breaker is open so a dead VPN is not hammered every TICK_MS. Shared
 * by the main loop's own nap() and --follow's "next check in" logging, so the
 * two numbers never drift apart.
 */
function tickDelayMs(): number {
  const base = followArg ? FOLLOW_TICK_MS : TICK_MS;
  return netState() === 'ok' ? base : Math.max(base, 30_000);
}

/**
 * `--ticket <iid>` — run exactly one ticket, then exit.
 *
 * The watcher claims the oldest-updated candidate, which is right for steady
 * state and wrong for a first run: a board with stale labels from an earlier
 * system would have it start on whichever ticket happens to sort first.
 */
const ticketArg = (() => {
  const i = process.argv.indexOf('--ticket');
  if (i === -1) return null;
  const n = Number(process.argv[i + 1]);
  return Number.isInteger(n) && n > 0 ? n : null;
})();

/**
 * `--follow` — only meaningful together with `--ticket <iid>`. Keeps
 * re-attempting that SAME ticket on the normal tick cadence instead of
 * exiting after one pass, without ever calling scan() — so it never claims or
 * even looks at any other ticket, exactly like plain `--ticket`. It exists for
 * the gap plain `--ticket` leaves open: a run that PARKS (a Review-gate reply
 * still pending) or hits a transient network 'aborted' has nobody left to
 * re-invoke it once the one pass has exited. See handleFollowOutcome() below
 * for what counts as terminal versus worth another tick.
 */
const followArg = process.argv.includes('--follow');
if (followArg && ticketArg === null) {
  log.error('--follow only makes sense together with --ticket <iid>');
  process.exit(1);
}

const once = (process.argv.includes('--once') || ticketArg !== null) && !followArg;

/**
 * Set once `--follow`'s ticket reaches a state no further ticking would
 * change. Checked in the same place `stopping` already is — the loop's own
 * exit test — so a terminal outcome ends the process exactly like a signal
 * does, just with an exit code that reflects the outcome instead of always 0.
 */
let followSettled = false;
let followExitCode = 0;

/**
 * Classify one `--follow` pass. Keys off `RunOutcome.status` — the same
 * vocabulary `runner.ts`'s `finish()` and `decideResume()` already use —
 * rather than inventing a parallel one:
 *
 * - `done` — the ticket shipped. Terminal, exit 0.
 * - `blocked` — genuine inability to proceed (a phase out of retries, a
 *   missing implementation, a quota/lease failure). `finish()` swaps the
 *   ticket's label and alerts a human for exactly this status, so treating it
 *   as anything but terminal here would mean --follow retries forever against
 *   something a human now has to act on. Terminal, exit 1.
 * - `parked` — the Review label's gate, waiting on a Slack reply or a merge
 *   precondition. `decideResume()` already treats 'parked' as an ordinary
 *   resumption, not a block; this is the mechanism that makes a human's reply
 *   actually get picked up without a manual re-run. Not terminal.
 * - `aborted` — covers both `finish(j, 'aborted', 'could not read the ticket
 *   from GitLab')` (the transient network case) and every other abort
 *   `runner.ts` treats as resumable (a mid-phase pause, a stopped-while-queued
 *   promotion wait). `decideResume()` resumes 'aborted' exactly like
 *   'running', so retrying it here is consistent with how the rest of the
 *   conductor already understands the status. Not terminal.
 * - `refused` — this pass lost a race for ownership (another conductor holds
 *   the run, or a block's cooldown has not elapsed). Not a failure of the
 *   ticket itself. Not terminal.
 */
function handleFollowOutcome(outcome: RunOutcome): void {
  // A shutdown signal already sets `stopping`, which ends the loop regardless
  // of this outcome — saying "next check" when there will not be one would be
  // wrong, not just unhelpful.
  const wait = stopping ? 'shutting down' : `next check in ${Math.round(tickDelayMs() / 1000)}s`;
  switch (outcome.status) {
    case 'done':
      say.ok(`#${outcome.iid} done — --follow is satisfied`);
      followSettled = true;
      followExitCode = 0;
      break;
    case 'blocked':
      say.error(`#${outcome.iid} blocked — ${outcome.reason ?? 'no reason given'}`);
      followSettled = true;
      followExitCode = 1;
      break;
    case 'parked':
      say.phase(`#${outcome.iid} parked — ${outcome.reason ?? 'waiting on a gate'} — ${wait}`);
      break;
    case 'aborted':
      say.warn(`#${outcome.iid} aborted — ${outcome.reason ?? 'no reason given'} — ${wait}`);
      break;
    case 'refused':
      say.info(`#${outcome.iid} refused — ${outcome.reason ?? 'no reason given'} — ${wait}`);
      break;
    default:
      break;
  }
}

function banner(): void {
  const cfg = projectConfig();
  log.banner('Oneshot');
  log.info(`project    ${cfg.gitlab.project} (${projectUrl()})`);
  log.info(`labels     "${cfg.labels.entry}" in  ->  "${cfg.labels.exit}" out`);
  log.info(`base       ${cfg.branches.base}   protected: ${cfg.branches.protected.join(', ')}`);
  log.info(`phases     ${phases().length} (${phases().filter((p) => p.kind === 'code').length} deterministic)`);
  log.info(`concurrency ${cfg.concurrency} here · ${portPool().length} pool ports across the fleet`);
  if (solo) log.info('mode       --solo, a second conductor is refused');
  if (followArg) log.info(`mode       --follow #${ticketArg}, re-checked every ${FOLLOW_TICK_MS / 1000}s until done/blocked`);
  if (DRY_RUN) log.warn('DRY_RUN is on — every write will be refused, in its own state-dry home');
}

/**
 * Refuse to start on a misconfiguration that would only surface as a confusing
 * failure three phases into a real ticket.
 */
function preflight(): boolean {
  let fatal = false;

  const auth = auditAuth();
  if (auth.clean) {
    log.ok(`auth       ${auth.credential}`);
  } else {
    for (const p of auth.problems) log.error(`auth       ${p}`);
    if (envOr('ONESHOT_REQUIRE_SUBSCRIPTION') === '1') {
      log.error('ONESHOT_REQUIRE_SUBSCRIPTION=1 and auth is not clean — refusing to start');
      fatal = true;
    }
  }
  for (const n of auth.notes) log.warn(`auth       ${n}`);

  if (!envOr('GITLAB_TOKEN')) {
    log.error('GITLAB_TOKEN is not set. cp .env.example .env and fill it in.');
    fatal = true;
  }

  if (!existsSync(WORK_REPO)) {
    log.error(`WORK_REPO does not exist: ${WORK_REPO}`);
    log.error(`  git clone git@gitlab.arbisoft.com:${projectConfig().gitlab.project}.git ${WORK_REPO}`);
    fatal = true;
  }
  if (!existsSync(CONTEXT_REPO)) {
    log.warn(`CONTEXT_REPO does not exist: ${CONTEXT_REPO} — prior-art recall will be thin`);
  }
  if (!existsSync(SKILLS_ROOT)) {
    log.warn(`skills root missing: ${SKILLS_ROOT} — phases will run without repo skills`);
  } else {
    log.ok(`skills     ${SKILLS_ROOT}`);
  }

  if (!slackConfig().channel) {
    log.warn('no Slack channel configured — status stays on this console only');
  }

  return !fatal;
}

let networkHeldSince: number | null = null;
let outageAlerted = false;

/**
 * One @mention per outage, never one per tick. `held` is the watcher's own
 * reason for standing down, so this measures the thing that actually matters —
 * how long work has been unable to start — rather than the breaker's state.
 */
async function noteNetworkHold(held: string | undefined): Promise<void> {
  if (!held || !held.startsWith('network')) {
    networkHeldSince = null;
    outageAlerted = false;
    return;
  }
  if (networkHeldSince === null) {
    networkHeldSince = Date.now();
    return;
  }
  const heldMs = Date.now() - networkHeldSince;
  if (outageAlerted || heldMs < OUTAGE_ALERT_MS) return;

  outageAlerted = true;
  const minutes = Math.round(heldMs / 60_000);
  logEvent('network_outage_alert', { minutes, state: netState() });
  log.error(`network breaker open for ${minutes}m — nothing has been claimable since`);
  await alert(
    `Oneshot has claimed nothing for ${minutes}m — GitLab is unreachable ` +
    `(breaker ${netState()}). VPN?`,
  );
}

/**
 * How many tickets this conductor may still start.
 *
 * Two ceilings, and the fleet one is the reason this is a function. `concurrency`
 * is a per-process setting, so three conductors reading concurrency:2 would
 * happily start six runs against a three-port pool and the fourth would block at
 * its first server-holding phase — a capacity failure surfacing hours later, in
 * a phase that has nothing to do with capacity. The pool is the machine's real
 * limit, so it is counted across everybody's rows and not just this process's
 * map.
 */
function freeSlots(): { slots: number; mine: number; fleet: number; pool: number } {
  const mine = projectConfig().concurrency - running.size;
  const pool = portPool().length;
  const fleet = pool - activeRunsFleet().length;
  return { slots: Math.max(0, Math.min(mine, fleet)), mine, fleet, pool };
}

async function tick(): Promise<void> {
  // The fleet's liveness and the promotion lease's renewal ride the same clock
  // as everything else here. A conductor that has stopped ticking has stopped
  // conducting, and that is exactly what both signals are for.
  heartbeat();
  renewPromotion(me);

  const outcome = await probe();
  if (outcome.changed) {
    logEvent('network_state', { state: outcome.state });
  }

  if (existsSync(PAUSE)) {
    say.warn('paused (state/PAUSE) — not claiming');
    return;
  }
  if (quotaParked()) {
    say.warn('parked after a subscription usage limit — not claiming');
    return;
  }

  if (ticketArg !== null) {
    const res = await getIssue(ticketArg);
    if (!res.ok || !res.data) {
      say.error(`cannot read #${ticketArg}`, { kind: res.kind, status: res.status });
      if (followArg) {
        say.warn(`--follow: could not reach GitLab for #${ticketArg} — ` +
          `next check in ${Math.round(tickDelayMs() / 1000)}s`);
      }
      return;
    }
    say.phase(`${followArg ? 'follow  ' : ''}targeting #${ticketArg}  ${res.data.title.slice(0, 60)}`);
    // --ticket is the one awaited path: it exists to run exactly one ticket and
    // exit, so returning to a loop that is about to break would exit mid-phase.
    // --follow keeps the same one-ticket guarantee — it re-runs THIS call on
    // the normal tick cadence, never scan()'s board-wide claim.
    const runOutcome = await runTicket(res.data, { conductor: me, signal: aborter.signal });
    if (followArg) handleFollowOutcome(runOutcome);
    return;
  }

  const result = await scan();
  await noteNetworkHold(result.held);

  const inFlight = activeRunsFleet();
  const summary = describe(result);
  if (result.candidates.length || inFlight.length) {
    say.info(`tick  ${summary}`, {
      inFlight: inFlight.map((r) => `#${r.iid}:${r.phase ?? r.status}`),
    });
  } else {
    say.info(`tick  ${summary}`);
  }

  for (const s of result.skipped) {
    say.info(`skip       #${s.iid}  ${s.why}`);
  }

  if (!result.candidates.length || stopping) return;

  if (watchOnly) {
    for (const c of result.candidates) say.phase(`claimable  #${c.iid}  ${c.title.slice(0, 70)}`);
    say.warn('--watch-only: not dispatching');
    return;
  }

  // Dispatch and DO NOT await. Awaiting here made `concurrency` decorative —
  // the loop could not scan again until the ticket it started had finished, so
  // the second slot was never filled no matter what the config said. The
  // correctness constraint that used to justify serialising (the deploy script
  // ships a branch TIP, so two runs in the merge→deploy→qa window put both
  // changes on the demo box and QA's verdict stops being attributable) is now
  // carried exactly where it belongs, by the promotion lease.
  const { slots, mine, fleet, pool } = freeSlots();
  if (slots <= 0) {
    say.info(mine > 0
      ? `the fleet is at capacity — ${pool - fleet} of ${pool} pool ports are in use`
      : `at capacity — ${running.size} run(s) in flight here`);
    return;
  }

  // A losing claim is not an error and is not logged as one: several conductors
  // scanning the same board see the same candidates, so exactly one of them
  // wins each ticket and the rest come back on the next tick.
  for (const c of result.candidates.slice(0, slots)) {
    const run = runTicket(c, { conductor: me, signal: aborter.signal }).catch((err) => {
      say.error(`#${c.iid} run threw`, { error: (err as Error).message });
      logEvent('run_threw', { iid: c.iid, error: (err as Error).message });
    });
    running.set(c.iid, run.finally(() => { running.delete(c.iid); }));
  }
}

/**
 * Wait out the runs still in flight. A phase can be 90 minutes long and is
 * mid-write for most of it, so the old fixed 250ms exit was not a shutdown —
 * it was a kill that left a half-written journal and the claimed/running row
 * that reconcileForeignRuns() now has to bury on the way back up.
 */
async function drain(): Promise<void> {
  if (!running.size) return;
  const names = (): string => [...running.keys()].map((i) => `#${i}`).join(' ');
  say.warn(`waiting on ${running.size} run(s) to reach a phase boundary: ${names()}`);

  const progress = setInterval(() => {
    // The heartbeat has to keep beating through the drain, or a shutdown that
    // takes longer than the lease TTL looks like a death to everybody else and
    // this conductor's promotion window is taken while it is still using it.
    heartbeat();
    renewPromotion(me);
    say.info(`still finishing ${running.size} run(s): ${names()}`);
  }, 15_000);
  progress.unref();

  await Promise.allSettled([...running.values()]);
  clearInterval(progress);
  say.ok('all runs finished — they resume from their journals on the next boot');
}

async function main(): Promise<void> {
  if (!existsSync(join(ROOT, '.env'))) {
    log.banner('No .env found — starting first-run setup.');
    const { execFileSync } = await import('node:child_process');
    execFileSync(process.execPath, [join(ROOT, 'node_modules/tsx/dist/cli.mjs'), join(ROOT, 'scripts/setup.ts')], { stdio: 'inherit' });
    log.info('Setup complete — re-run: npm start');
    process.exit(0);
  }
  mkdirSync(RUNS, { recursive: true });
  mkdirSync(MEMORY, { recursive: true });

  // --solo refuses the second start the way this used to. Asked BEFORE
  // registering, so the refusal is about the peers that were already there and
  // this process never appears in its own roll call. Without it a second
  // conductor is welcome, and joins the fleet instead.
  if (solo) {
    const refusal = refuseIfAnotherConductor(liveConductors());
    if (!refusal.ok) {
      log.error('--solo was asked for and another conductor is already running', {
        conductor: refusal.heldBy?.conductor_id.slice(0, 6),
        pid: refusal.heldBy?.pid,
        since: new Date(refusal.heldBy?.started_at ?? 0).toLocaleTimeString(),
        argv: refusal.heldBy?.argv,
      });
      log.error('stop it first:  pkill -f "src/index.ts"');
      process.exit(1);
    }
  }

  me = register().conductor_id;
  process.on('exit', deregister);

  const peers = liveConductors().filter((c) => c.conductor_id !== me);
  if (peers.length) {
    log.info(`fleet      ${peers.length} peer conductor(s) already live`, {
      peers: peers.map((c) => `${c.conductor_id.slice(0, 6)}:${c.pid}`),
    });
  }

  // Only rows belonging to conductors nobody can see any more. The old boot
  // reconciliation buried EVERY claimed/running row, which was correct while the
  // singleton guaranteed there was nothing else alive to own one — and is now a
  // conductor starting up and aborting its neighbours' healthy in-flight runs.
  const reaped = reconcileForeignRuns(liveConductorIds());
  if (reaped) {
    logEvent('runs_reconciled', { reaped });
    log.warn(`reaped ${reaped} run row(s) a dead conductor left in flight — ` +
      'their tickets are claimable again and resume from their journals');
  }

  // Conductor-cwd phases (recall, deploy, qa, demo, memorize, document) run
  // here rather than in a worktree, so without this they resolve no skills at
  // all — the worktree seed is the only other place `.claude` gets built.
  if (ensureClaudeDir(ROOT).length) log.ok('.claude    composed in the conductor repo');

  banner();
  if (!preflight()) process.exit(1);

  const b = budgetConfig();
  log.info(`quota      ${Math.round(windowUsage() / 1e6)}M / ${Math.round(b.window_tokens / 1e6)}M this window · ` +
    `${Math.round(dayUsage() / 1e6)}M / ${Math.round(b.day_tokens / 1e6)}M today (weighted)`);

  log.banner(followArg
    ? `Following ticket #${ticketArg} every ${FOLLOW_TICK_MS / 1000}s until done or blocked. Ctrl-C to stop.`
    : once
      ? (ticketArg !== null ? `Single run: ticket #${ticketArg}.` : 'Single pass, then exit.')
      : `Watching every ${TICK_MS / 1000}s as ${me.slice(0, 6)}. Ctrl-C to stop.`);
  logEvent('conductor_start', {
    root: ROOT, watchOnly, conductor: me, solo, ticket: ticketArg, follow: followArg,
  });

  // First signal: stop claiming, tell the runs to wind up at their next phase
  // boundary, then wait for them. Second signal: the operator has decided the
  // wait is not worth it, so take the loss.
  const shutdown = (sig: string) => {
    if (stopping) {
      say.error(`${sig} again — hard exit, ${running.size} run(s) abandoned mid-phase`);
      process.exit(1);
    }
    stopping = true;
    say.warn(`${sig} — no longer claiming; letting ${running.size} run(s) wind up`);
    logEvent('conductor_stop', { signal: sig, inFlight: running.size, conductor: me });
    aborter.abort();
    if (wake) wake();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  for (;;) {
    try {
      await tick();
    } catch (err) {
      say.error('tick failed', { error: (err as Error).message });
      logEvent('tick_error', { error: (err as Error).message });
    }
    if (stopping || once || followSettled) break;
    // Back off while the network breaker is open rather than hammering it.
    await nap(tickDelayMs());
  }

  await drain();
  // Deregistered only after the runs are done. Leaving the fleet earlier would
  // make this conductor's own in-flight rows look foreign to anybody booting in
  // the meantime, and they would be buried out from under phases still running.
  deregister();
  // followSettled carries a real verdict (0 for done, 1 for blocked); every
  // other exit path — --watch-only, plain --ticket, a signal, the ordinary
  // watch loop — keeps the exit-0 it has always had.
  process.exit(followSettled ? followExitCode : 0);
}

// A phase session the conductor deliberately aborts can still throw from the
// SDK's transport AFTER runPhase has returned — an async write against a dead
// process rejecting with AbortError. Observed live: the rejection surfaced
// while the NEXT phase group was already dispatching and took the whole
// conductor down mid-run. The conductor never dies for a session's corpse: log
// it, keep conducting. A genuinely fatal programming error still surfaces —
// loudly, repeatedly — in the log it would have crashed into anyway.
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection (conductor continues)', {
    error: reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason),
  });
  logEvent('unhandled_rejection', {
    error: reason instanceof Error ? reason.message : String(reason),
  });
});
process.on('uncaughtException', (err) => {
  log.error('uncaught exception (conductor continues)', { error: `${err.name}: ${err.message}` });
  logEvent('uncaught_exception', { error: err.message });
});

main().catch((err) => {
  log.error('fatal', { error: (err as Error).message });
  process.exit(1);
});

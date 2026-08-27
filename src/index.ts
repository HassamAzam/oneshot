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
 */
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONTEXT_REPO, DRY_RUN, PAUSE, RUNS, MEMORY, ROOT, SKILLS_ROOT, WORK_REPO,
  auditAuth, envOr, phases, projectConfig, slackConfig,
} from './lib/config.js';
import { activeRuns, logEvent, reconcileStaleRuns } from './lib/db.js';
import { ensureClaudeDir } from './lib/claudedir.js';
import { probe, netState } from './lib/reachability.js';
import { windowUsage, dayUsage, quotaParked } from './lib/quota.js';
import { budgetConfig } from './lib/config.js';
import { describe, scan } from './conductor/watcher.js';
import { runTicket } from './conductor/runner.js';
import { getIssue, projectUrl } from './lib/gitlab.js';
import { alert } from './lib/slack.js';
import { log } from './lib/log.js';
import { acquire, release } from './lib/singleton.js';

const TICK_MS = 60_000;

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
const once = process.argv.includes('--once') || ticketArg !== null;

function banner(): void {
  const cfg = projectConfig();
  log.banner('Oneshot');
  log.info(`project    ${cfg.gitlab.project} (${projectUrl()})`);
  log.info(`labels     "${cfg.labels.entry}" in  ->  "${cfg.labels.exit}" out`);
  log.info(`base       ${cfg.branches.base}   protected: ${cfg.branches.protected.join(', ')}`);
  log.info(`phases     ${phases().length} (${phases().filter((p) => p.kind === 'code').length} deterministic)`);
  log.info(`concurrency ${cfg.concurrency}`);
  if (DRY_RUN) log.warn('DRY_RUN is on — every write will be refused');
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

async function tick(): Promise<void> {
  const outcome = await probe();
  if (outcome.changed) {
    logEvent('network_state', { state: outcome.state });
  }

  if (existsSync(PAUSE)) {
    log.warn('paused (state/PAUSE) — not claiming');
    return;
  }
  if (quotaParked()) {
    log.warn('parked after a subscription usage limit — not claiming');
    return;
  }

  if (ticketArg !== null) {
    const res = await getIssue(ticketArg);
    if (!res.ok || !res.data) {
      log.error(`cannot read #${ticketArg}`, { kind: res.kind, status: res.status });
      return;
    }
    log.phase(`targeting #${ticketArg}  ${res.data.title.slice(0, 60)}`);
    // --ticket is the one awaited path: it exists to run exactly one ticket and
    // exit, so returning to a loop that is about to break would exit mid-phase.
    await runTicket(res.data, { signal: aborter.signal });
    return;
  }

  const result = await scan();
  await noteNetworkHold(result.held);

  const inFlight = activeRuns();
  const summary = describe(result);
  if (result.candidates.length || inFlight.length) {
    log.info(`tick  ${summary}`, {
      inFlight: inFlight.map((r) => `#${r.iid}:${r.phase ?? r.status}`),
    });
  } else {
    log.info(`tick  ${summary}`);
  }

  for (const s of result.skipped) {
    log.info(`skip       #${s.iid}  ${s.why}`);
  }

  if (!result.candidates.length || stopping) return;

  if (watchOnly) {
    for (const c of result.candidates) log.phase(`claimable  #${c.iid}  ${c.title.slice(0, 70)}`);
    log.warn('--watch-only: not dispatching');
    return;
  }

  // Dispatch and DO NOT await. Awaiting here made `concurrency` decorative —
  // the loop could not scan again until the ticket it started had finished, so
  // the second slot was never filled no matter what the config said. The
  // correctness constraint that used to justify serialising (the deploy script
  // ships a branch TIP, so two runs in the merge→deploy→qa window put both
  // changes on the demo box and QA's verdict stops being attributable) is now
  // carried exactly where it belongs, by the promotion mutex.
  const slots = projectConfig().concurrency - running.size;
  if (slots <= 0) {
    log.info(`at capacity — ${running.size} run(s) in flight`);
    return;
  }

  for (const c of result.candidates.slice(0, slots)) {
    const run = runTicket(c, { signal: aborter.signal }).catch((err) => {
      log.error(`#${c.iid} run threw`, { error: (err as Error).message });
      logEvent('run_threw', { iid: c.iid, error: (err as Error).message });
    });
    running.set(c.iid, run.finally(() => { running.delete(c.iid); }));
  }
}

/**
 * Wait out the runs still in flight. A phase can be 90 minutes long and is
 * mid-write for most of it, so the old fixed 250ms exit was not a shutdown —
 * it was a kill that left a half-written journal and the claimed/running row
 * that reconcileStaleRuns() now has to bury on the way back up.
 */
async function drain(): Promise<void> {
  if (!running.size) return;
  const names = (): string => [...running.keys()].map((i) => `#${i}`).join(' ');
  log.warn(`waiting on ${running.size} run(s) to reach a phase boundary: ${names()}`);

  const progress = setInterval(() => {
    log.info(`still finishing ${running.size} run(s): ${names()}`);
  }, 15_000);
  progress.unref();

  await Promise.allSettled([...running.values()]);
  clearInterval(progress);
  log.ok('all runs finished — they resume from their journals on the next boot');
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

  const lock = acquire();
  if (!lock.ok) {
    log.error('another conductor is already running — refusing to start', {
      pid: lock.heldBy?.pid,
      since: new Date(lock.heldBy?.startedAt ?? 0).toLocaleTimeString(),
      argv: lock.heldBy?.argv,
    });
    log.error('stop it first:  pkill -f "src/index.ts"');
    process.exit(1);
  }
  process.on('exit', release);

  const reaped = reconcileStaleRuns();
  if (reaped) {
    logEvent('runs_reconciled', { reaped });
    log.warn(`reaped ${reaped} run row(s) a previous conductor left in flight — ` +
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

  log.banner(once
    ? (ticketArg !== null ? `Single run: ticket #${ticketArg}.` : 'Single pass, then exit.')
    : `Watching every ${TICK_MS / 1000}s. Ctrl-C to stop.`);
  logEvent('conductor_start', { root: ROOT, watchOnly });

  // First signal: stop claiming, tell the runs to wind up at their next phase
  // boundary, then wait for them. Second signal: the operator has decided the
  // wait is not worth it, so take the loss.
  const shutdown = (sig: string) => {
    if (stopping) {
      log.error(`${sig} again — hard exit, ${running.size} run(s) abandoned mid-phase`);
      process.exit(1);
    }
    stopping = true;
    log.warn(`${sig} — no longer claiming; letting ${running.size} run(s) wind up`);
    logEvent('conductor_stop', { signal: sig, inFlight: running.size });
    aborter.abort();
    if (wake) wake();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  for (;;) {
    try {
      await tick();
    } catch (err) {
      log.error('tick failed', { error: (err as Error).message });
      logEvent('tick_error', { error: (err as Error).message });
    }
    if (stopping || once) break;
    // Back off while the network breaker is open rather than hammering it.
    const delay = netState() === 'ok' ? TICK_MS : Math.max(TICK_MS, 30_000);
    await nap(delay);
  }

  await drain();
  release();
  process.exit(0);
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

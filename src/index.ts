/**
 * Oneshot entry point. `npm start`.
 *
 * The conductor is a deterministic TypeScript state machine, not a model. It
 * schedules, validates, retries and reaps; an LLM runs only inside a phase.
 * That is what makes "clear the context between tickets" free rather than a
 * feature — there is no conductor context to clear.
 *
 * On a tick it probes the network, honours the pause/quota switches, scans for
 * tickets carrying the entry label, and dispatches one. --watch-only reports
 * what it would claim without claiming it.
 */
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONTEXT_REPO, DRY_RUN, PAUSE, RUNS, MEMORY, ROOT, SKILLS_ROOT, WORK_REPO,
  auditAuth, envOr, phases, projectConfig, slackConfig,
} from './lib/config.js';
import { activeRuns, logEvent } from './lib/db.js';
import { probe, netState } from './lib/reachability.js';
import { windowUsage, dayUsage, quotaParked } from './lib/quota.js';
import { budgetConfig } from './lib/config.js';
import { describe, scan } from './conductor/watcher.js';
import { runTicket } from './conductor/runner.js';
import { getIssue, projectUrl } from './lib/gitlab.js';
import { log } from './lib/log.js';

const TICK_MS = 60_000;
const watchOnly = process.argv.includes('--watch-only');

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
    await runTicket(res.data);
    return;
  }

  const result = await scan();
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

  if (!result.candidates.length) return;

  if (watchOnly) {
    for (const c of result.candidates) log.phase(`claimable  #${c.iid}  ${c.title.slice(0, 70)}`);
    log.warn('--watch-only: not dispatching');
    return;
  }

  // Concurrency is 1 by design, not for throughput: the deploy script deploys a
  // branch TIP, so two runs merging into the base between merge and deploy put
  // both changes on the demo server and QA's verdict stops being attributable.
  const slots = projectConfig().concurrency - inFlight.length;
  for (const c of result.candidates.slice(0, Math.max(0, slots))) {
    await runTicket(c);
  }
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

  banner();
  if (!preflight()) process.exit(1);

  const b = budgetConfig();
  log.info(`quota      ${Math.round(windowUsage() / 1e6)}M / ${Math.round(b.window_tokens / 1e6)}M this window · ` +
    `${Math.round(dayUsage() / 1e6)}M / ${Math.round(b.day_tokens / 1e6)}M today (weighted)`);

  log.banner(once
    ? (ticketArg !== null ? `Single run: ticket #${ticketArg}.` : 'Single pass, then exit.')
    : `Watching every ${TICK_MS / 1000}s. Ctrl-C to stop.`);
  logEvent('conductor_start', { root: ROOT, watchOnly });

  let stopping = false;
  const shutdown = (sig: string) => {
    if (stopping) process.exit(1);
    stopping = true;
    log.warn(`${sig} — finishing this tick then exiting`);
    logEvent('conductor_stop', { signal: sig });
    setTimeout(() => process.exit(0), 250);
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
    await new Promise((r) => setTimeout(r, delay));
  }
}

main().catch((err) => {
  log.error('fatal', { error: (err as Error).message });
  process.exit(1);
});

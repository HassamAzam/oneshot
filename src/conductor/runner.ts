/**
 * Drive one ticket through the phase graph.
 *
 * This is the orchestrator, and it is deliberately plain TypeScript. It does
 * not think — it schedules, validates, retries and reaps. An LLM runs only
 * inside a phase. Three things fall out of that: there is no conductor context
 * to clear between tickets, control flow can be single-stepped, and the token
 * spend goes to the work rather than to an orchestrator re-reading its own
 * state.
 *
 * The executor is INDEX-BASED rather than a for-of over the phase list, because
 * the interesting control flow all moves backwards. `review` sends work back to
 * `implement`; so does `qa`, and a qa lap happens after the change has already
 * been merged and deployed — so the second lap has to re-run the MR, the merge
 * and the deploy for the fix to reach the box being tested. A linear loop can
 * express none of that. What the index buys, in order:
 *
 *   forced   — the set of phases that must re-run even though they already
 *              succeeded this run. A cycle populates it; a resume respects it.
 *   retry    — re-enter the same index while the phase's own failed laps are
 *              inside its budget.
 *   cycle    — jump the index back to cycleTo, forcing everything in between.
 *   group    — consecutive phases sharing a `group` are dispatched together and
 *              then reconciled strictly in phase order, so concurrency changes
 *              the wall clock and never the semantics.
 *
 * Two things are asserted here rather than believed. A deploy is verified from
 * the box and the git graph, not from what the deploy phase said about itself;
 * and a promotion window is held by one run at a time, because the demo server
 * carries a branch tip rather than a SHA.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  DRY_RUN, PAUSE, SKIP_DEPLOY, STATE, WORK_REPO, deployConfig, modelFor, phases, projectConfig,
  type PhaseConfig,
} from '../lib/config.js';
import {
  archiveRun, ensureRunDirs, failedLapsOf, lapsOf, phaseSucceeded, readArtifact,
  readJournal, recordPhase, reapScratch, updateJournal, writeArtifact, writeJournal,
  type PhaseRecord, type RunJournal,
} from '../lib/artifacts.js';
import { branchFor, newRunId, worktreeName } from '../lib/ids.js';
import { leasePortFor, leaseWorktree, reapWorktree, releasePort } from '../lib/worktrees.js';
import { addIssueNote, getIssue, issueNotes, issueUrl, swapLabel, type Issue } from '../lib/gitlab.js';
import { acquirePromotion, releasePromotion } from '../lib/promotion.js';
import { checkQuota } from '../lib/quota.js';
import { createRun, getRun, isClaimed, logEvent, phaseEnd, phaseStart, updateRun } from '../lib/db.js';
import { postCard, thread, updateCard, alert, type CardState, type PhaseLine } from '../lib/slack.js';
import { log } from '../lib/log.js';
import { runPhase, type PhaseOutput } from './phase.js';
import { closePhase, mergePhase } from './codephases.js';
import { isImplemented, promptFor, systemPromptFor, type PromptCtx } from '../phases/prompts.js';
import type { Ticket } from '../phases/types.js';

const exec = promisify(execFile);

/**
 * How long a block is respected before a re-claim is allowed.
 *
 * A block means the run wants a human. Re-claiming it immediately spends the
 * same budget on the same failure, and the entry label is still on the ticket
 * for exactly as long as it takes someone to look — so the cooldown is what
 * separates "the human fixed it and re-labelled" from "the watcher came round
 * again ninety seconds later".
 */
const BLOCK_COOLDOWN_MS = 60 * 60_000;

/** The deterministic post-deploy checks get 15s to answer or they have failed. */
const HEALTH_TIMEOUT_MS = 15_000;

export interface RunOutcome {
  runId: string;
  iid: number;
  status: 'done' | 'blocked' | 'aborted';
  reason?: string;
}

export interface CodePhaseCtx {
  iid: number;
  runId: string;
  journal: RunJournal;
  prior: Record<string, Record<string, unknown> | null>;
}

/**
 * Deterministic phases — merge and close. TypeScript, never a model.
 *
 * Registered here rather than assumed: an unregistered name stops the run. The
 * alternative (treat 'code' as "nothing to do") would let a run skip the merge
 * and still finish labelled Ready For Deployment.
 *
 * These run on EVERY pass, including a resume and every cycle lap — they are
 * never skipped by the succeeded-already check. GitLab is the source of truth
 * for whether an MR is merged, and a journal that says "merged" while GitLab
 * says "opened" must lose. Both are therefore idempotent by recheck rather than
 * by memory, and both are cheap when there is nothing left to do.
 */
export const CODE_PHASES: Record<
  string,
  ((ctx: CodePhaseCtx) => Promise<{ ok: boolean; error?: string; data?: Record<string, unknown> }>) | undefined
> = {
  merge: mergePhase,
  close: closePhase,
};

// ------------------------------------------------------------------- the card

function cardLines(j: RunJournal, running: string[]): PhaseLine[] {
  const live = new Set(running);
  return phases()
    .filter((p) => isImplemented(p.name) || Boolean(CODE_PHASES[p.name]))
    .map((p): PhaseLine => {
      const recs = j.phases.filter((r) => r.phase === p.name);
      const last = recs[recs.length - 1];
      if (live.has(p.name)) return { phase: p.name, state: 'running' };
      if (!last) return { phase: p.name, state: 'pending' };
      if (last.status === 'ok' || last.status === 'warned') {
        return { phase: p.name, state: 'done', detail: recs.length > 1 ? `${recs.length} laps` : undefined };
      }
      if (last.status === 'skipped') return { phase: p.name, state: 'skipped' };
      return { phase: p.name, state: 'failed' };
    });
}

function cardState(j: RunJournal, running: string[] = []): CardState {
  return {
    iid: j.iid,
    title: j.title,
    url: j.url,
    lines: cardLines(j, running),
    elapsedMs: Date.now() - j.createdAt,
    weighted: j.phases.reduce((a, p) => a + (p.weighted ?? 0), 0),
    status: j.status,
    blockedWhy: j.blockedWhy,
  };
}

// ------------------------------------------------------------------ the ticket

async function fetchTicket(iid: number): Promise<Ticket | null> {
  const res = await getIssue(iid);
  if (!res.ok || !res.data) return null;
  const notes = await issueNotes(iid);
  return {
    iid: res.data.iid,
    title: res.data.title,
    description: res.data.description,
    labels: res.data.labels,
    // Newest last, and bounded: a ticket with 200 comments must not blow the
    // research prompt's budget before it has read a line of code. Oneshot's own
    // claim and stop notes are dropped too — feeding this system's output back
    // in as ticket requirements is how a phase ends up working on a summary of
    // itself.
    notes: notes.ok && notes.data
      ? notes.data
        .map((n) => n.body)
        .filter((b) => b && !b.startsWith('assigned to') && !b.startsWith('Oneshot '))
        .slice(-25)
      : [],
  };
}

// -------------------------------------------------------------------- resuming

type ResumeDecision =
  | { kind: 'fresh'; archive: string | null }
  | { kind: 'resume'; journal: RunJournal }
  | { kind: 'refuse'; reason: string };

/**
 * What an existing journal means for this claim.
 *
 * 'running' and 'aborted' are the same situation seen from two sides — a run
 * that stopped without finishing. Both resume, keeping the run id and the whole
 * phase history, because that history is what makes a resume cost nothing for
 * the phases that already succeeded.
 *
 * 'done' is a delivered run: the ticket has come back, so it gets a new run and
 * the old directory moves aside rather than being written over.
 */
function decideResume(existing: RunJournal | null): ResumeDecision {
  if (!existing) return { kind: 'fresh', archive: null };

  if (existing.status === 'running' || existing.status === 'aborted') {
    return { kind: 'resume', journal: existing };
  }

  if (existing.status === 'blocked') {
    const since = Date.now() - (existing.blockedAt ?? 0);
    if (since < BLOCK_COOLDOWN_MS) {
      return { kind: 'refuse', reason: 'blocked cooldown — remove the block or wait' };
    }
    // Past the cooldown the human has evidently re-labelled it deliberately.
    return { kind: 'resume', journal: existing };
  }

  return { kind: 'fresh', archive: existing.runId };
}

// -------------------------------------------------------------- control flow

type Control =
  | { kind: 'advance' }
  | { kind: 'retry'; at: number }
  | { kind: 'cycle'; jumpTo: number; windowEnd: number }
  | { kind: 'stop'; status: 'blocked' | 'aborted'; reason: string };

function statusForFailure(p: PhaseConfig): PhaseRecord['status'] {
  if (p.onFail === 'skip') return 'skipped';
  if (p.onFail === 'warn') return 'warned';
  return 'failed';
}

interface PhaseResult {
  cfg: PhaseConfig;
  index: number;
  lap: number;
  startedAt: number;
  endedAt: number;
  /** phase_runs row, kept so a conductor-side overrule can correct the ledger. */
  rowId: number;
  out: PhaseOutput;
}

/**
 * Run one ticket. Resumable: an existing journal means this is a RESUMPTION,
 * and phases that already succeeded are skipped rather than re-paid for.
 */
export async function runTicket(
  issue: Issue,
  opts: { signal?: AbortSignal } = {},
): Promise<RunOutcome> {
  const cfg = projectConfig();
  const iid = issue.iid;
  const list = phases();

  // Claim here, not in the watcher. --ticket dispatches straight to runTicket,
  // so a guard living only in the scan path is a guard that is not there on the
  // path most likely to be used for a manual re-run.
  const decision = decideResume(readJournal(iid));
  if (decision.kind === 'refuse') {
    log.warn(`#${iid} — ${decision.reason}`);
    return { runId: '', iid, status: 'aborted', reason: decision.reason };
  }
  if (decision.kind !== 'resume' && isClaimed(iid)) {
    log.warn(`#${iid} is already claimed by an in-flight run — refusing`);
    return { runId: '', iid, status: 'aborted', reason: 'already claimed' };
  }
  if (decision.kind === 'fresh' && decision.archive) {
    const moved = archiveRun(iid, decision.archive);
    if (moved) log.info(`#${iid} had a completed run — archived to ${moved}`);
  }

  const resuming = decision.kind === 'resume';
  const runId = resuming ? decision.journal.runId : newRunId();

  let j: RunJournal = resuming ? decision.journal : {
    runId,
    iid,
    title: issue.title,
    url: issueUrl(iid),
    createdAt: Date.now(),
    status: 'running',
    phases: [],
  };

  if (resuming) {
    j.status = 'running';
    delete j.blockedWhy;
    delete j.blockedAt;
    writeJournal(j);
    if (getRun(runId)) updateRun(runId, { status: 'running', ended_at: null, blocked_why: null });
    else createRun(runId, iid, issue.title);
    log.banner(`▶ #${iid} ${issue.title}  (resuming ${runId})`);
  } else {
    ensureRunDirs(iid);
    writeJournal(j);
    createRun(runId, iid, issue.title);
    log.banner(`▶ #${iid} ${issue.title}`);
  }

  const fetched = await fetchTicket(iid);
  if (!fetched) {
    return finish(j, 'aborted', 'could not read the ticket from GitLab');
  }
  const ticket: Ticket = fetched;

  // The Slack card is posted once and edited in place for the rest of the run.
  if (!j.slackTs) {
    const ts = await postCard(cardState(j));
    if (ts) { j.slackTs = ts; writeJournal(j); updateRun(runId, { slack_ts: ts }); }
  }

  // Once per run, not once per resumption.
  if (!DRY_RUN && !resuming) {
    await addIssueNote(iid, `Oneshot claimed this ticket — run \`${runId}\`.`);
  }

  // Worktree is leased lazily: phases 0-3 do not need one, and leasing early
  // would hold it through 40 minutes of research for nothing.
  // Validate, do not trust. A journal survives a crash, a manual cleanup, or a
  // `git worktree prune`, so a resumed run can carry a path that no longer
  // exists — and passing a missing cwd to the SDK surfaces as the maximally
  // confusing `spawn node ENOENT`, which looks like a broken PATH.
  let worktree: string | undefined = j.worktree && existsSync(j.worktree) ? j.worktree : undefined;
  if (j.worktree && !worktree) {
    log.warn('recorded worktree is gone — re-leasing', { was: j.worktree });
  }
  let port: number | undefined = j.port;
  const branch = j.branch ?? branchFor(cfg.branches.prefix, iid, issue.title);

  const prior: Record<string, Record<string, unknown> | null> = {};
  /** Phases that must re-run even though they already succeeded — a cycle writes this. */
  const forced = new Set<string>();

  let i = 0;
  while (i < list.length) {
    const phase = list[i]!;

    // Checked at the top as well as after each phase: an abort that arrives
    // while a code phase is running must not be spent starting the next one.
    if (opts.signal?.aborted) {
      return finish(j, 'aborted', 'the conductor asked this run to stop');
    }

    // A phase with no implementation STOPS the run — including 'code' phases.
    // Skipping them would let a run reach the end without merging or deploying
    // and still be labelled Ready For Deployment, which is the worst possible
    // failure mode: silent success on work that never happened.
    if (!isImplemented(phase.name) && !CODE_PHASES[phase.name]) {
      log.warn(`phase '${phase.name}' is not implemented yet — stopping here`);
      return finish(j, 'blocked',
        `not built yet: phase '${phase.name}'. Implemented so far: ` +
        `${list.filter((p) => isImplemented(p.name) || CODE_PHASES[p.name]).map((p) => p.name).join(' → ')}`);
    }

    if (CODE_PHASES[phase.name]) {
      const control = await runCodePhase(phase, i);
      if (control.kind === 'stop') return finish(j, control.status, control.reason);
      i = nextIndex(control, i, i);
      continue;
    }

    if (shouldSkip(phase)) {
      prior[phase.name] = readArtifact(iid, phase.artifact ?? `${phase.name}.json`);
      log.info(`skip ${phase.name} — already succeeded this run`);
      i += 1;
      continue;
    }

    // ONESHOT_SKIP_DEPLOY exists for driving the pipeline with no demo box —
    // deploy and qa are skipped TOGETHER, because a qa phase with nothing
    // deployed would fail its SHA cross-check and block a run that was told
    // not to deploy. Recorded as 'skipped', which phaseSucceeded() does not
    // count, so a later resume without the flag re-runs both for real.
    if (SKIP_DEPLOY && (phase.name === 'deploy' || phase.name === 'qa')) {
      recordPhase(iid, {
        phase: phase.name, lap: lapsOf(iid, phase.name), status: 'skipped',
        startedAt: Date.now(), endedAt: Date.now(), error: 'ONESHOT_SKIP_DEPLOY',
      });
      j = readJournal(iid) ?? j;
      prior[phase.name] = null;
      log.warn(`skip ${phase.name} — ONESHOT_SKIP_DEPLOY is set`);
      i += 1;
      continue;
    }

    // A group is the maximal run of CONSECUTIVE phases with the same marker
    // that are all about to run. A skipped or unimplemented member ends the
    // group rather than being stepped over — a group must stay a contiguous
    // slice of the list, or the index arithmetic behind cycle stops meaning
    // anything.
    const members = [i];
    if (phase.group) {
      for (let k = i + 1; k < list.length; k += 1) {
        const next = list[k]!;
        if (next.group !== phase.group || next.kind !== 'session') break;
        if (!isImplemented(next.name) || shouldSkip(next)) break;
        members.push(k);
      }
    }

    for (const k of members) {
      const p = list[k]!;
      const quota = checkQuota(runId, p.name);
      if (!quota.allowed) return finish(j, 'blocked', `quota: ${quota.reason}`);
      const leaseError = ensureLeases(p);
      if (leaseError) return finish(j, 'blocked', leaseError);
    }

    const running = members.map((k) => list[k]!.name);
    await updateCard(j.slackTs ?? '', cardState(j, running));
    updateRun(runId, { phase: running.join(' + '), status: 'running' });
    if (running.length > 1) log.phase(`running ${running.join(' + ')} concurrently`);

    const results = await Promise.all(members.map((k) => runOne(list[k]!, k)));

    // The deploy phase's own account of itself is not evidence. Overrule it
    // before anything is recorded, so the journal and the card show the verdict
    // the conductor reached rather than the one the session reported.
    for (const r of results) {
      if (r.cfg.name === 'deploy' && r.out.ok) {
        const why = await verifyDeploy(r.cfg);
        if (why) {
          r.out.ok = false;
          r.out.error = `deploy could not be verified: ${why}`;
          phaseEnd(r.rowId, statusForFailure(r.cfg), {
            turns: r.out.turns, weighted: r.out.weighted, sessionId: r.out.sessionId, detail: why,
          });
          log.error(`deploy overruled — ${why}`);
        }
      }
    }

    // Reconciled strictly in phase order, whatever order they finished in:
    // every result is recorded and every success populates prior[] before any
    // of them is allowed to move the index. The first result whose outcome
    // changes the control flow wins; the others still land in the journal.
    const flow: Control[] = [];
    const claim = (c: Control): void => {
      if (c.kind !== 'advance' && flow.length === 0) flow.push(c);
    };

    for (const r of results) {
      recordPhase(iid, {
        phase: r.cfg.name,
        lap: r.lap,
        status: r.out.ok ? 'ok' : statusForFailure(r.cfg),
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        model: modelFor(r.cfg),
        turns: r.out.turns,
        weighted: r.out.weighted,
        sessionId: r.out.sessionId,
        error: r.out.error ?? r.out.blocked ?? undefined,
      });
      j = readJournal(iid) ?? j;

      if (r.out.rateLimited) {
        prior[r.cfg.name] = null;
        claim({
          kind: 'stop',
          status: 'blocked',
          reason: 'subscription usage limit — parked until the window resets',
        });
        continue;
      }

      if (!r.out.ok) {
        prior[r.cfg.name] = null;
        claim(afterFailure(r.cfg, r.index, r.out.blocked ?? r.out.error ?? 'phase failed'));
        continue;
      }

      prior[r.cfg.name] = r.out.data;
      // QA passing is what ends this run's exclusive claim on the demo box.
      if (r.cfg.name === 'qa') releasePromotion(runId);
      if (isMilestone(r.cfg)) await thread(j.slackTs ?? null, milestoneText(r.cfg, r.out.data, iid));
    }

    await updateCard(j.slackTs ?? '', cardState(j));

    if (opts.signal?.aborted) {
      return finish(j, 'aborted', 'the conductor asked this run to stop');
    }

    const control = flow[0];
    if (control?.kind === 'stop') return finish(j, control.status, control.reason);
    i = nextIndex(control ?? { kind: 'advance' }, i, members[members.length - 1]!);
  }

  return finish(j, 'done');

  // ------------------------------------------------------------- run helpers

  function shouldSkip(p: PhaseConfig): boolean {
    return !forced.has(p.name) && phaseSucceeded(iid, p.name);
  }

  /**
   * Leases, taken at the last possible moment.
   *
   * The worktree comes with the first phase that needs a checkout; the PORT is
   * separate and comes with the first phase that actually runs a server. They
   * used to be one lease, which held one of three ports across research, plan
   * and implement — hours of a scarce resource for phases that never bound a
   * socket.
   */
  function ensureLeases(p: PhaseConfig): string | null {
    if (p.cwd === 'worktree' && !worktree) {
      try {
        const lease = leaseWorktree(runId, branch, worktreeName(iid, runId), { withPort: false });
        worktree = lease.worktree;
        j = updateJournal(iid, { worktree, branch: lease.branch }) ?? j;
        updateRun(runId, { worktree, branch: lease.branch });
      } catch (err) {
        return `worktree: ${(err as Error).message}`;
      }
    }
    if (p.needsPort && !port) {
      try {
        port = leasePortFor(runId);
        j = updateJournal(iid, { port }) ?? j;
        updateRun(runId, { port });
      } catch (err) {
        return `port: ${(err as Error).message}`;
      }
    }
    return null;
  }

  async function runOne(p: PhaseConfig, index: number): Promise<PhaseResult> {
    forced.delete(p.name);
    const lap = lapsOf(iid, p.name);
    const startedAt = Date.now();
    // The worktree is handed only to phases whose cwd is the worktree. A
    // conductor-cwd phase that received it would carry ONESHOT_WORKTREE into
    // its environment, and git-guard's no-mutations-without-a-lease rule keys
    // on that variable's ABSENCE — passing it everywhere would disarm the rule
    // for exactly the phases it exists to confine.
    const wt = p.cwd === 'worktree' ? worktree : undefined;
    const ctx: PromptCtx = { ticket, runId, lap, branch, worktree: wt, port, prior, journal: j };

    // The deploy lock is the cross-process shadow of the in-process promotion
    // mutex: hooks/deploy-guard.cjs refuses deploy-surface commands while a
    // DIFFERENT run holds it, so even a rogue second conductor cannot land two
    // builds on the box at once. Written just-in-time and always removed —
    // deploy-guard treats a lock older than the deploy timeout as stale.
    if (p.name === 'deploy') writeDeployLock(runId, iid);
    try {
      // The ledger row is opened before the phase and closed after it, so an
      // external watchdog can see a phase that has been 'running' for longer than
      // its own timeout should allow — the one signal a wedged SDK spawn gives.
      const rowId = phaseStart(runId, p.name, lap, modelFor(p));
      const out = await runPhase({
        iid, runId, lap, cfg: p,
        prompt: promptFor(p, ctx),
        systemPrompt: systemPromptFor(p, ctx),
        worktree: wt, port, branch,
        signal: opts.signal,
      });
      phaseEnd(rowId, out.ok ? 'ok' : statusForFailure(p), {
        turns: out.turns,
        weighted: out.weighted,
        sessionId: out.sessionId,
        detail: out.error ?? out.blocked ?? undefined,
      });

      return { cfg: p, index, lap, startedAt, endedAt: Date.now(), rowId, out };
    } finally {
      if (p.name === 'deploy') removeDeployLock(runId);
    }
  }

  async function runCodePhase(p: PhaseConfig, index: number): Promise<Control> {
    // Taken before the merge rather than after it: the window this protects
    // opens the moment anything of this run's lands on the base branch.
    if (p.name === 'merge') await acquirePromotion(runId);

    const lap = lapsOf(iid, p.name);
    const startedAt = Date.now();
    await updateCard(j.slackTs ?? '', cardState(j, [p.name]));
    updateRun(runId, { phase: p.name, status: 'running' });

    const rowId = phaseStart(runId, p.name, lap, 'code');
    const done = await CODE_PHASES[p.name]!({ iid, runId, journal: j, prior });
    phaseEnd(rowId, done.ok ? 'ok' : statusForFailure(p), { detail: done.error });

    // A code phase hands off exactly like a session one: through an artifact on
    // disk, so a resumed run reads the same thing the live one did.
    if (done.data) {
      writeArtifact(iid, p.artifact ?? `${p.name}.json`, done.data);
      prior[p.name] = done.data;
    } else {
      prior[p.name] = readArtifact(iid, p.artifact ?? `${p.name}.json`);
    }

    recordPhase(iid, {
      phase: p.name,
      lap,
      status: done.ok ? 'ok' : statusForFailure(p),
      startedAt,
      endedAt: Date.now(),
      error: done.error,
    });
    j = readJournal(iid) ?? j;
    await updateCard(j.slackTs ?? '', cardState(j));

    if (done.ok) {
      if (isMilestone(p)) await thread(j.slackTs ?? null, milestoneText(p, prior[p.name] ?? null, iid));
      return { kind: 'advance' };
    }
    return afterFailure(p, index, done.error ?? 'phase failed');
  }

  /** What a failed phase means for the index. The onFail policy, and nothing else. */
  function afterFailure(p: PhaseConfig, index: number, why: string): Control {
    // A pause is a freeze, not a failure. No label swap, no alert, no lap
    // spent: the run stops where it stands and the same journal resumes it.
    if (existsSync(PAUSE)) {
      return { kind: 'stop', status: 'aborted', reason: 'paused mid-phase — resumes when unpaused' };
    }

    if (p.onFail === 'skip' || p.onFail === 'warn') {
      log.warn(`${p.name} failed but is non-fatal — continuing`, { why: why.slice(0, 120) });
      return { kind: 'advance' };
    }

    const failed = failedLapsOf(iid, p.name);

    if (p.onFail === 'retry') {
      const budget = p.maxRetries ?? 1;
      if (failed <= budget) {
        log.warn(`${p.name} failed — retrying`, { attempt: failed + 1, of: budget + 1 });
        return { kind: 'retry', at: index };
      }
      return {
        kind: 'stop', status: 'blocked',
        reason: `${p.name}: ${why} — gave up after ${failed} attempts`,
      };
    }

    if (p.onFail === 'cycle') {
      const jumpTo = list.findIndex((q) => q.name === p.cycleTo);
      if (jumpTo === -1) {
        return {
          kind: 'stop', status: 'blocked',
          reason: `${p.name}: ${why} — and cycleTo '${p.cycleTo}' is not in the phase list`,
        };
      }
      if (failed < (p.maxLaps ?? 2)) {
        return { kind: 'cycle', jumpTo, windowEnd: index };
      }
      return {
        kind: 'stop', status: 'blocked',
        reason: `${p.name}: ${why} — still outstanding after ${failed} laps through ${p.cycleTo}`,
      };
    }

    return { kind: 'stop', status: 'blocked', reason: `${p.name}: ${why}` };
  }

  /**
   * Move the index, or end the run.
   *
   * A cycle forces every phase from the target up to the one that failed, which
   * is the whole point: a qa cycle sits AFTER mr, merge and deploy, so unless
   * those re-run the fix never reaches the box that rejected it. `testcases` is
   * the single exception — that list is written once and pinned, because verify
   * and qa comparing runs against two different lists compares nothing.
   */
  function nextIndex(
    control: Exclude<Control, { kind: 'stop' }>, current: number, lastMember: number,
  ): number {
    if (control.kind === 'retry') return control.at;
    if (control.kind === 'cycle') {
      for (let k = control.jumpTo; k <= control.windowEnd; k += 1) {
        const name = list[k]!.name;
        if (name === 'testcases') continue;
        forced.add(name);
      }
      log.warn(`cycling back to ${list[control.jumpTo]!.name}`, {
        from: list[control.windowEnd]!.name,
        forced: [...forced].join(', '),
      });
      return control.jumpTo;
    }
    return Math.max(current, lastMember) + 1;
  }

  /**
   * The deploy, re-derived from the box and the git graph.
   *
   * The phase decides HOW to deploy — which flags, which retry, whether to
   * restart a service. It does not get to decide WHETHER it deployed. Three
   * independent statements have to agree before qa is allowed to attribute
   * anything to this ticket: the phase claims a SHA and a healthy service, that
   * SHA contains this run's merge, and the site answers.
   */
  async function verifyDeploy(p: PhaseConfig): Promise<string | null> {
    if (DRY_RUN) return null;

    const data = readArtifact<Record<string, unknown>>(iid, p.artifact ?? 'deploy.json');
    if (!data) return 'the phase produced no artifact to check';

    const deployedSha = typeof data.deployedSha === 'string' ? data.deployedSha.trim() : '';
    if (!deployedSha) return 'no deployedSha was reported';
    if (data.healthOk !== true) return 'the phase itself reported the service unhealthy';
    if (!j.mergedSha) return 'no mergedSha on the journal — there is nothing to check the box against';

    const base = cfg.branches.base;
    try {
      await exec('git', ['fetch', 'origin', base], { cwd: WORK_REPO, timeout: 120_000 });
    } catch (err) {
      return `could not fetch origin/${base} to check ancestry: ${(err as Error).message.slice(0, 120)}`;
    }
    try {
      // Equal SHAs pass; so does a descendant, because the script ships a
      // branch TIP and another merge into the base between phases is legal.
      await exec('git', ['merge-base', '--is-ancestor', j.mergedSha, deployedSha], {
        cwd: WORK_REPO, timeout: 60_000,
      });
    } catch {
      return `the box is not running this run's work — ${j.mergedSha.slice(0, 8)} is not an ` +
        `ancestor of the deployed ${deployedSha.slice(0, 8)}`;
    }

    const demo = deployConfig();
    const ac = new AbortController();
    const killer = setTimeout(() => ac.abort(), HEALTH_TIMEOUT_MS);
    try {
      const res = await fetch(demo.demoUrl, { signal: ac.signal });
      if (res.status !== demo.expectStatus) {
        return `${demo.demoUrl} answered ${res.status}, expected ${demo.expectStatus}`;
      }
    } catch (err) {
      return `${demo.demoUrl} did not answer within ${HEALTH_TIMEOUT_MS / 1000}s ` +
        `(${(err as Error).message.slice(0, 80)})`;
    } finally {
      clearTimeout(killer);
    }

    j = updateJournal(iid, { deployedSha }) ?? j;
    return null;
  }

  async function finish(
    journal: RunJournal, status: 'done' | 'blocked' | 'aborted', reason?: string,
  ): Promise<RunOutcome> {
    journal.status = status;
    if (reason) journal.blockedWhy = reason;
    if (status === 'blocked') journal.blockedAt = Date.now();
    writeJournal(journal);
    updateRun(journal.runId, { status, ended_at: Date.now(), blocked_why: reason ?? null });
    logEvent('run_finished', { status, reason }, { runId: journal.runId });

    // Both leases go back on EVERY terminal status. Holding a port for a
    // blocked run's forensics starves the pool with nothing to show for it —
    // the worktree is where the forensics actually are.
    releasePort(journal.runId);
    releasePromotion(journal.runId);

    await updateCard(journal.slackTs ?? '', cardState(journal));

    if (status === 'blocked') {
      await alert(`#${journal.iid} ${journal.title} — BLOCKED: ${reason}`);
      if (!DRY_RUN) {
        await swapLabel(journal.iid, [cfg.labels.entry], [cfg.labels.blocked]);
        await addIssueNote(journal.iid, `Oneshot stopped: **${reason}**\n\nRun \`${journal.runId}\`.`);
      }
      log.error(`■ #${journal.iid} BLOCKED — ${reason}`);
    } else if (status === 'done') {
      if (!DRY_RUN) await swapLabel(journal.iid, [cfg.labels.entry], [cfg.labels.exit]);
      log.ok(`■ #${journal.iid} done`);
    } else {
      log.warn(`■ #${journal.iid} stopped — ${reason ?? 'aborted'}`);
    }

    // Teardown. Scratch goes; the journal, artifacts and transcripts stay —
    // those are the run's value. The WORKTREE stays on anything that is not a
    // completed run: 'blocked' keeps it for forensics, and 'aborted' is now a
    // resumable state, so removing it would throw away uncommitted work the
    // resumed run expects to still be there.
    reapScratch(journal.iid);
    if (journal.worktree && existsSync(journal.worktree) && status === 'done') {
      reapWorktree(journal.worktree, journal.runId);
    }

    return { runId: journal.runId, iid: journal.iid, status, reason };
  }
}

/**
 * The deploy lock, as hooks/deploy-guard.cjs reads it. The in-process
 * promotion mutex already serializes the merge→qa window inside ONE conductor;
 * this file extends the same guarantee across processes, because the guard —
 * not the mutex — is what a session's Bash call actually meets. Best-effort on
 * both sides: a write failure is logged rather than fatal (the mutex still
 * holds), and the guard ignores locks older than the deploy deadline.
 */
function writeDeployLock(runId: string, iid: number): void {
  try {
    writeFileSync(
      join(STATE, 'DEPLOY-LOCK'),
      `${JSON.stringify({ runId, iid, pid: process.pid, since: Date.now() })}\n`,
    );
  } catch (err) {
    log.warn('could not write state/DEPLOY-LOCK', { error: (err as Error).message });
  }
}

function removeDeployLock(runId: string): void {
  try {
    const file = join(STATE, 'DEPLOY-LOCK');
    if (!existsSync(file)) return;
    const lock = JSON.parse(readFileSync(file, 'utf8')) as { runId?: string };
    if (lock.runId === runId) rmSync(file);
  } catch {
    rmSync(join(STATE, 'DEPLOY-LOCK'), { force: true });
  }
}

function isMilestone(p: PhaseConfig): boolean {
  return ['plan', 'testcases', 'review', 'verify', 'mr', 'deploy', 'qa'].includes(p.name);
}

function milestoneText(p: PhaseConfig, data: Record<string, unknown> | null, iid: number): string {
  if (!data) return `#${iid} — ${p.name} done.`;
  if (p.name === 'plan') {
    const steps = (data.steps as unknown[] | undefined)?.length ?? 0;
    return `*#${iid} plan* — ${data.approach}\n${steps} steps${data.migrations ? ' · includes a migration' : ''}`;
  }
  if (p.name === 'testcases') {
    const cases = (data.cases as Array<{ blast: string }> | undefined) ?? [];
    const high = cases.filter((c) => c.blast === 'high').length;
    const empty = (data.passesEmpty as string[] | undefined) ?? [];
    return `*#${iid} test cases* — ${cases.length} cases (${high} high blast)` +
      `${empty.length ? `\nempty passes: ${empty.join(', ')}` : ''}`;
  }
  if (p.name === 'deploy') {
    const sha = String(data.deployedSha ?? '').slice(0, 8) || 'unknown sha';
    const attempts = Number(data.attempts ?? 1);
    return `*#${iid} deployed* — \`${sha}\` on the demo box · ` +
      `${attempts} attempt${attempts === 1 ? '' : 's'}`;
  }
  return `*#${iid} ${p.name}* — ${data.summary ?? 'done'}`;
}

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
 * Three things are asserted here rather than believed. A ticket is driven only
 * by the conductor that can prove it owns the run — on a resumption as much as
 * on a fresh claim, since a live run and an abandoned one both read 'running'
 * from a journal. A deploy is verified from the box and the git graph, not from
 * what the deploy phase said about itself. And a promotion window is held by one
 * run at a time across every conductor on the machine, because the demo server
 * carries a branch tip rather than a SHA.
 *
 * One thing is attempted rather than surrendered. Most blocks this pipeline
 * hits are not defects in the ticket's code — they are a missing credential, an
 * account without the group a feature is gated behind, a wedged MCP server, a
 * cap. Those are diagnosable, so a blocked stop is offered to the 'remediate'
 * phase before it is allowed to end the run, and a run that heals itself
 * continues from the phase remediation says to resume at.
 */
import { execFile } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { promisify } from 'node:util';
import {
  DRY_RUN, PAUSE, SKIP_DEPLOY, WORK_REPO, deployConfig, modelFor, phases, portPool, projectConfig,
  type PhaseConfig,
} from '../lib/config.js';
import {
  archiveRun, artifactPath, ensureRunDirs, failedLapsOf, lapsOf, phaseSucceeded, readArtifact,
  readJournal, recordPhase, recordRemediation, reapScratch, updateJournal, writeArtifact,
  writeJournal,
  type PhaseRecord, type Remediation, type RunJournal,
} from '../lib/artifacts.js';
import { branchFor, newRunId, worktreeName } from '../lib/ids.js';
import {
  leasePortFor, leaseWorktree, reapPortServer, reapWorktree, releasePort,
} from '../lib/worktrees.js';
import {
  addIssueNote, createMergeRequest, findMergeRequests, getIssue, issueNotes, issueUrl,
  swapLabel, type Issue,
} from '../lib/gitlab.js';
import { acquirePromotion, releasePromotion } from '../lib/promotion.js';
import { checkQuota } from '../lib/quota.js';
import {
  claimOwnership, claimTicket, getRun, logEvent, phaseEnd, phaseStart, updateRun,
} from '../lib/db.js';
import { postCard, thread, updateCard, alert, type CardState, type PhaseLine } from '../lib/slack.js';
import { log } from '../lib/log.js';
import { exportRun } from '../lib/langfuse.js';
import { writeRunReport } from '../lib/report.js';
import { publishPending } from '../lib/publish.js';
import { runPhase, type PhaseOutput } from './phase.js';
import { schemaFor } from './schemas.js';
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

/**
 * How many times ONE run may try to heal itself.
 *
 * Two, because the failure mode being bounded is not cost but conviction: an
 * agent asked to remove an obstacle will always find something it can change,
 * and a run that keeps being handed the same block will keep changing things
 * around a cause that was never environmental. Two attempts is enough for the
 * shape this actually takes in practice — one missing credential, then the
 * thing the credential turns out to be gated behind — and short enough that
 * the third failure reaches a person while the diagnosis is still worth
 * reading.
 */
const MAX_REMEDIATIONS = 2;

/**
 * Phase records worth keeping when a phase is re-entered. Deliberately the same
 * set scripts/unblock.ts prunes against, and for the reasons written up there:
 * a succeeded record is what makes a resume cheap, and 'skipped' is a decision
 * the run already made rather than a failure to retry.
 */
const KEPT_STATUSES = new Set<PhaseRecord['status']>(['ok', 'warned', 'skipped']);

export interface RunOutcome {
  runId: string;
  iid: number;
  /**
   * 'refused' is not a failure and never becomes one. It is the answer when
   * another conductor is legitimately driving this ticket, or when a block is
   * still inside its cooldown — nothing was started, nothing was spent, and
   * nothing needs looking at.
   */
  status: 'done' | 'blocked' | 'aborted' | 'refused';
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
    // An on-demand phase is not part of the sequence, so showing it 'pending'
    // on every card would advertise a step that is never coming. It appears the
    // moment it has actually run — which is the moment it is worth seeing.
    .filter((p) => !p.onDemand || j.phases.some((r) => r.phase === p.name) || live.has(p.name))
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
  /**
   * Set by a conductor-side overrule that must STOP the run rather than let
   * the phase's onFail policy retry or cycle it — the evidence says no lap
   * will help and a human (or the operator) has to look.
   */
  hardStop?: string;
}

/**
 * Run one ticket. Resumable: an existing journal means this is a RESUMPTION,
 * and phases that already succeeded are skipped rather than re-paid for.
 */
export async function runTicket(
  issue: Issue,
  opts: { conductor: string; signal?: AbortSignal },
): Promise<RunOutcome> {
  const cfg = projectConfig();
  const iid = issue.iid;
  const list = phases();
  const owner = opts.conductor;

  // Claim here, not in the watcher. --ticket dispatches straight to runTicket,
  // so a guard living only in the scan path is a guard that is not there on the
  // path most likely to be used for a manual re-run.
  const decision = decideResume(readJournal(iid));
  if (decision.kind === 'refuse') {
    log.warn(`#${iid} — ${decision.reason}`);
    return { runId: '', iid, status: 'refused', reason: decision.reason };
  }

  const resuming = decision.kind === 'resume';
  const runId = resuming ? decision.journal.runId : newRunId();

  // The claim is an OWNERSHIP test on both paths, and that is the whole point.
  // Asking "is this ticket claimed?" and then exempting a resume from the
  // question was a hole with a conductor-shaped gap in it: a LIVE run's journal
  // says 'running', decideResume() reads 'running' as resumable, so a second
  // conductor took the resume branch, never consulted the claim at all, and
  // proceeded to drive a ticket the first one was already mid-phase on. A
  // uniqueness constraint would not have caught it either — the second
  // conductor UPDATEs the row it should never have been given.
  //
  // So: a fresh claim inserts and loses cleanly to whoever inserted first, and a
  // resume has to prove the run is HIS — either already owned, or abandoned by a
  // conductor the fleet no longer sees.
  const claimed = resuming && getRun(runId)
    ? claimOwnership(iid, runId, owner)
    // A journal outlives the database on purpose (state/oneshot.db is a cache),
    // so a resume can arrive with history on disk and no row to own yet.
    : claimTicket(iid, runId, issue.title, owner) === 'claimed';

  if (!claimed) {
    const why = resuming
      ? 'another conductor owns the in-flight run for this ticket'
      : 'another conductor claimed this ticket first';
    log.info(`#${iid} — ${why}`);
    return { runId: '', iid, status: 'refused', reason: why };
  }

  if (decision.kind === 'fresh' && decision.archive) {
    const moved = archiveRun(iid, decision.archive);
    if (moved) log.info(`#${iid} had a completed run — archived to ${moved}`);
  }

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
    updateRun(runId, {
      status: 'running', ended_at: null, blocked_why: null, owner_seen_at: Date.now(),
    });
    log.banner(`▶ #${iid} ${issue.title}  (resuming ${runId})`);
  } else {
    ensureRunDirs(iid);
    writeJournal(j);
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

  // Before the first phase, not only after one. A resumed run may be carrying
  // artifacts from a session that predates the publisher, and a plan nobody can
  // see is a plan nobody can object to.
  await publishPending({ iid, runId, journal: j });
  j = readJournal(iid) ?? j;
  /** Phases that must re-run even though they already succeeded — a cycle writes this. */
  const forced = new Set<string>();
  /**
   * What the last remediation concluded, in words a person can act on. Carried
   * out of band because it belongs in the BLOCKED reason — the ticket note is
   * the only thing a human reads after a run stops, and "qa failed" without
   * "and here is what the machine already ruled out" wastes the attempt.
   */
  let remediationNote = '';

  let i = 0;
  while (i < list.length) {
    const phase = list[i]!;

    // Checked at the top as well as after each phase: an abort that arrives
    // while a code phase is running must not be spent starting the next one.
    if (opts.signal?.aborted) {
      return finish(j, 'aborted', 'the conductor asked this run to stop');
    }

    // On-demand phases are stepped over before anything else looks at them:
    // they are invoked by name when something needs them, so an unimplemented
    // one must not stop the run the way a scheduled one does, and a resume must
    // not walk into one because it has no succeeded record.
    if (phase.onDemand) {
      i += 1;
      continue;
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
      if (control.kind === 'stop') {
        const resumeAt = await resumeAfterRemediation(control, phase.name);
        if (resumeAt === null) return finish(j, control.status, stopReason(control));
        i = resumeAt;
        continue;
      }
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
      // The lap goes to checkQuota because the per-phase budget bounds ONE
      // attempt, and this is the only place that knows which attempt is about
      // to run. Without it a phase on its third lap is measured against a
      // one-lap allowance its two failures have already spent, and the run is
      // blocked for budget when what it actually needs is the retry the phase
      // config promises it.
      const quota = checkQuota(runId, p.name, lapsOf(iid, p.name));
      if (!quota.allowed) return finish(j, 'blocked', `quota: ${quota.reason}`);
      const leaseError = ensureLeases(p);
      if (leaseError) return finish(j, 'blocked', leaseError);
    }

    const running = members.map((k) => list[k]!.name);
    await updateCard(j.slackTs ?? '', cardState(j, running));
    // owner_seen_at travels with every phase transition, not only with the
    // conductor's own tick. It is what tells the rest of the fleet that this row
    // belongs to something still breathing — and a phase boundary is the most
    // honest moment to say so, because it is the last one this run is certain to
    // reach before it spends ninety minutes inside a session.
    updateRun(runId, {
      phase: running.join(' + '), status: 'running', owner_seen_at: Date.now(),
    });
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

      // The MR is a mechanical API call wearing a session's clothes, and this
      // pipeline already learned what happens when it is left to a tool the
      // session might not hold: a phase that pushed its branch, could not open
      // a merge request, and stopped the whole run one step short of the merge.
      // The judgement in this phase is the title and the description; issuing
      // the POST is not. So if the session did not come back with an MR, the
      // conductor opens it — over the same REST path it uses for labels and
      // merging, which needs no MCP server at all.
      if (r.cfg.name === 'mr' && !DRY_RUN) {
        const mrIid = Number(r.out.data?.mrIid ?? 0);
        if (!r.out.ok || !mrIid) {
          const made = await ensureMergeRequest(r.out.data);
          if (made) {
            r.out.ok = true;
            r.out.blocked = null;
            r.out.data = made;
            writeArtifact(iid, r.cfg.artifact ?? 'mr.json', made);
            log.ok(`mr opened by the conductor — ${made.mrUrl}`);
          }
        }
      }

      // A verify that executed the list but passed NOTHING is not a green
      // phase, whatever its structured output says. Zero passes with blocked
      // cases means the environment (or the change) is broken end to end, and
      // letting it through is how unverified code reaches an MR with a
      // clean-looking card. Hard stop — cycling to implement would burn an
      // Opus lap on what is almost never a code problem.
      if (r.cfg.name === 'verify' && r.out.ok) {
        const res = (r.out.data?.results ?? []) as Array<{ result: string }>;
        const passes = res.filter((x) => x.result === 'pass').length;
        if (res.length > 0 && passes === 0) {
          r.out.ok = false;
          r.hardStop = `verify executed ${res.length} case(s) and NONE passed — an all-negative ` +
            'local run means the environment or the change is broken end to end, and neither is ' +
            'something a merge should ride through. A human decides whether the demo-server QA ' +
            'gate alone is acceptable for this ticket.';
          r.out.error = r.hardStop;
          log.error(`verify overruled — ${r.hardStop}`);
        }
      }

      // The overrule's mirror image. A verify session that dies at its turn cap
      // returns no structured output, and without this the cycle re-pays an
      // implement and a review lap for what was only the session's budgeting.
      // The prompt has it rewrite verify-partial.json after every case, so a
      // dead session's evidence survives it: salvage the recorded results,
      // mark everything it never reached as skipped, and let the pipeline
      // continue — qa executes this same list against the deployed build
      // anyway, which is what makes a partial local pass acceptable.
      // Both list-executing phases, because both run the same twenty cases and
      // both can run out of turns doing it. qa is the more expensive one to
      // lose: its cycle goes all the way back to implement and drags the MR,
      // the merge and the deploy along with it.
      if ((r.cfg.name === 'verify' || r.cfg.name === 'qa') && !r.out.ok && !r.out.blocked) {
        const partial = readArtifact<{ results?: Array<Record<string, unknown>> }>(
          iid, `${r.cfg.name}-partial.json`,
        );
        const recorded = partial?.results ?? [];
        const recordedPasses = recorded.filter((x) => String(x.result) === 'pass').length;
        if (recorded.length && recordedPasses > 0) {
          const tc = readArtifact<{ cases?: Array<{ id: string }> }>(iid, 'testcases.json');
          const seen = new Set(recorded.map((x) => String(x.id)));
          const skipped = (tc?.cases ?? [])
            .filter((c) => !seen.has(c.id))
            .map((c) => ({
              id: c.id, result: 'skipped',
              evidence: 'session died at its turn cap before this case ran', screenshot: '',
            }));
          const results = [...recorded, ...skipped];
          const summary = `Salvaged from ${r.cfg.name}-partial.json: ${recorded.length} case(s) `
            + `recorded before the session died (${r.out.error ?? 'no error text'}); `
            + `${skipped.length} never ran.`;
          // A salvaged qa verdict is only ever 'fail' — a pass is an assertion
          // that the whole list ran, and by construction this one did not.
          r.out.data = r.cfg.name === 'qa'
            ? {
              summary, blocked: null, results, verdict: 'fail',
              deployedSha: String(readArtifact<{ deployedSha?: string }>(iid, 'deploy.json')?.deployedSha ?? ''),
            }
            : {
              summary, blocked: null, serverStarted: true, port: port ?? 0, results, regressions: [],
            };
          r.out.ok = true;
          writeArtifact(iid, r.cfg.artifact ?? `${r.cfg.name}.json`, r.out.data);
          log.warn(`${r.cfg.name} salvaged from partial results — ${recorded.length} recorded, ${skipped.length} skipped`);
        }
      }
    }

    // Reconciled strictly in phase order, whatever order they finished in:
    // every result is recorded and every success populates prior[] before any
    // of them is allowed to move the index. The first result whose outcome
    // changes the control flow wins; the others still land in the journal.
    // The claiming PHASE travels with the control decision, not just its
    // reason string: remediation is told which phase to diagnose, and reading
    // that back out of a reason built for a human would be guesswork.
    const flow: Array<{ control: Control; from: string }> = [];
    const claim = (c: Control, from: string): void => {
      if (c.kind !== 'advance' && flow.length === 0) flow.push({ control: c, from });
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
        }, r.cfg.name);
        continue;
      }

      if (!r.out.ok) {
        prior[r.cfg.name] = null;
        if (r.hardStop) {
          claim({ kind: 'stop', status: 'blocked', reason: `${r.cfg.name}: ${r.hardStop}` }, r.cfg.name);
        } else if (r.out.blocked && (r.cfg.onFail === 'retry' || r.cfg.onFail === 'cycle')) {
          // The schema's contract for `blocked` is "no retry would help" — a
          // missing input, an environment that is down, a decision only a human
          // can make. Feeding that into retry/cycle spends laps re-proving what
          // the session already established; skip/warn phases still degrade
          // gracefully through afterFailure.
          claim({ kind: 'stop', status: 'blocked', reason: `${r.cfg.name}: ${r.out.blocked}` }, r.cfg.name);
        } else {
          claim(afterFailure(r.cfg, r.index, r.out.blocked ?? r.out.error ?? 'phase failed'), r.cfg.name);
        }
        continue;
      }

      prior[r.cfg.name] = r.out.data;
      // QA passing is what ends this run's exclusive claim on the demo box.
      if (r.cfg.name === 'qa') releasePromotion(runId);
      if (isMilestone(r.cfg)) await thread(j.slackTs ?? null, milestoneText(r.cfg, r.out.data, iid));
    }

    await updateCard(j.slackTs ?? '', cardState(j));

    // Publish whatever is now ready. Reconciling here rather than inside a
    // phase means the plan reaches the ticket while it is still cheap to argue
    // with, and evidence reaches the MR as it is produced instead of all at
    // once from `document` two phases before the end.
    await publishPending({ iid, runId, journal: j });
    j = readJournal(iid) ?? j;

    if (opts.signal?.aborted) {
      return finish(j, 'aborted', 'the conductor asked this run to stop');
    }

    const claimed = flow[0];
    const control = claimed?.control;
    if (control?.kind === 'stop') {
      const resumeAt = await resumeAfterRemediation(control, claimed!.from);
      if (resumeAt === null) return finish(j, control.status, stopReason(control));
      i = resumeAt;
      continue;
    }
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
      const leased = leasePortFor(runId);
      if (leased === null) {
        return `port: every port in PORT_POOL (${portPool().join(', ')}) is leased — ` +
          'the fleet is at its real capacity, whatever the concurrency setting says';
      }
      port = leased;
      j = updateJournal(iid, { port }) ?? j;
      updateRun(runId, { port });
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
  }

  async function runCodePhase(p: PhaseConfig, index: number): Promise<Control> {
    // Taken before the merge rather than after it: the window this protects
    // opens the moment anything of this run's lands on the base branch. The wait
    // can be long — the holder keeps the window through its own QA — so a run
    // told to stop while queued stops there rather than being dragged through a
    // merge it no longer has any reason to perform.
    if (p.name === 'merge'
      && !await acquirePromotion({ runId, iid, conductor: owner }, { signal: opts.signal })) {
      return {
        kind: 'stop', status: 'aborted',
        reason: 'stopped while waiting for the promotion window',
      };
    }

    const lap = lapsOf(iid, p.name);
    const startedAt = Date.now();
    await updateCard(j.slackTs ?? '', cardState(j, [p.name]));
    updateRun(runId, { phase: p.name, status: 'running', owner_seen_at: Date.now() });

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

    // The MR is created by the phase before merge, so this is the first pass
    // where anything targeted at the MR can actually land.
    await publishPending({ iid, runId, journal: j });
    j = readJournal(iid) ?? j;

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
   * The blocked reason a human will read, with the machine's own findings in it.
   *
   * A block that says only "qa: the demo account cannot see the page" sends
   * someone to look at exactly what the run already looked at. Saying what was
   * tried, what it concluded and what it wants a person to do turns the ticket
   * note into the first half of the investigation instead of the start of one.
   */
  function stopReason(control: Extract<Control, { kind: 'stop' }>): string {
    if (control.status !== 'blocked' || !remediationNote) return control.reason;
    return `${control.reason}\n\n${remediationNote}`;
  }

  /**
   * Offer a blocked stop to remediation, and turn a fix back into an index.
   *
   * The third conductor-side intervention, beside the deploy overrule and the
   * verify/qa salvage, and the same shape as both: the phase's verdict stands
   * as a statement about the phase, and the conductor decides what it means for
   * the RUN. Where the other two correct a phase that was wrong about itself,
   * this one accepts that the phase was right and disputes that the run is over.
   *
   * Everything from the resumed phase onwards is forced, for the reason a cycle
   * forces its window: a fix that reaches only the phase that failed never
   * reaches the box that rejected it. `testcases` is the same exception it is
   * there — the case list is written once and pinned, or verify and qa stop
   * being comparable.
   */
  async function resumeAfterRemediation(
    control: Extract<Control, { kind: 'stop' }>, from: string,
  ): Promise<number | null> {
    if (control.status !== 'blocked') return null;

    const resumeFrom = await attemptRemediation(from, control.reason);
    if (!resumeFrom) return null;

    const idx = list.findIndex((p) => p.name === resumeFrom);
    if (idx === -1) return null;

    for (let k = idx; k < list.length; k += 1) {
      const target = list[k]!;
      if (target.name === 'testcases' || target.onDemand) continue;
      forced.add(target.name);
    }
    log.ok(`remediation cleared the block — resuming from ${resumeFrom}`, {
      blockedIn: from, forced: [...forced].join(', '),
    });
    return idx;
  }

  /**
   * Try to remove the obstacle, rather than hand it to a person.
   *
   * Almost every block this pipeline produces is environmental — a credential
   * that was never provisioned, an account missing the group a feature is gated
   * behind, a wedged MCP server, a cap. None of those are defects in the
   * ticket's code, and all of them are diagnosable from the same box the run is
   * already on. So the run gets to look before it gives up.
   *
   * It runs through runPhase() like any other session phase, deliberately: the
   * tool policy, the write scopes, the guard hooks, the transcript and the
   * budget all apply to the phase that is allowed to change the environment
   * exactly as they apply to the ones that are not. A privileged side channel
   * here would be a hole in every guarantee the rest of the file makes.
   *
   * Returns the phase to resume from, or null when it could not help — and null
   * is the ordinary answer. The guards below all exist to make sure the run
   * reaches a person eventually: not while paused, not while dry, not more than
   * MAX_REMEDIATIONS times, and never twice for the same block, because a cause
   * that survives being fixed was not the cause.
   */
  async function attemptRemediation(blockedPhase: string, reason: string): Promise<string | null> {
    remediationNote = '';

    // A dry run changes nothing anywhere, and a pause is a freeze: neither is
    // the moment to start editing the machine's configuration.
    if (DRY_RUN || existsSync(PAUSE)) return null;

    const cfgR = list.find((p) => p.name === 'remediate');
    if (!cfgR || !isImplemented(cfgR.name) || !schemaFor(cfgR.name)) return null;

    const already = j.remediations ?? [];
    if (already.length >= MAX_REMEDIATIONS) {
      remediationNote =
        `Self-remediation was not attempted again: this run has already spent its ` +
        `${MAX_REMEDIATIONS} attempts (${already.map((r) => `${r.phase}/${r.category}`).join(', ')}).`;
      return null;
    }
    if (already.some((r) => r.phase === blockedPhase && r.reason === reason)) {
      remediationNote =
        'Self-remediation already fixed something for this exact block and it came back — ' +
        'whatever is wrong is not the environment.';
      return null;
    }

    const lap = already.length;
    const startedAt = Date.now();
    log.warn(`${blockedPhase} would block the run — diagnosing it first`, {
      attempt: lap + 1, of: MAX_REMEDIATIONS,
    });
    await updateCard(j.slackTs ?? '', cardState(j, [cfgR.name]));
    updateRun(runId, { phase: cfgR.name, status: 'running', owner_seen_at: Date.now() });

    // No worktree, whatever this run holds: the cause is almost never inside
    // the ticket's diff, and a phase that cannot see the diff cannot be tempted
    // to fix it. The block travels in its own field rather than in `prior`,
    // which is keyed by phase name and read by every later prompt.
    const ctx: PromptCtx = {
      ticket, runId, lap, branch, port, prior, journal: j,
      block: { phase: blockedPhase, reason },
    };

    const rowId = phaseStart(runId, cfgR.name, lap, modelFor(cfgR));
    const out = await runPhase({
      iid, runId, lap, cfg: cfgR,
      prompt: promptFor(cfgR, ctx),
      systemPrompt: systemPromptFor(cfgR, ctx),
      branch,
      signal: opts.signal,
    });
    phaseEnd(rowId, out.ok ? 'ok' : statusForFailure(cfgR), {
      turns: out.turns, weighted: out.weighted, sessionId: out.sessionId,
      detail: out.error ?? out.blocked ?? undefined,
    });

    const data = out.data ?? {};
    const category = typeof data.category === 'string' ? data.category : 'unknown';
    const changes = Array.isArray(data.changes) ? data.changes.map(String) : [];
    const diagnosis = typeof data.diagnosis === 'string' ? data.diagnosis.trim() : '';
    const humanNeeded = typeof data.humanNeeded === 'string' ? data.humanNeeded.trim() : '';
    const retryFrom = typeof data.retryFrom === 'string' ? data.retryFrom.trim() : '';
    const fixed = out.ok && data.fixed === true;

    // Recorded before anything is decided, and whatever it decided. The attempt
    // cost budget and may have changed the machine; a card and a ledger that
    // show neither would describe a run that did not happen.
    recordPhase(iid, {
      phase: cfgR.name,
      lap,
      status: out.ok ? 'ok' : statusForFailure(cfgR),
      startedAt,
      endedAt: Date.now(),
      model: modelFor(cfgR),
      turns: out.turns,
      weighted: out.weighted,
      sessionId: out.sessionId,
      error: out.error ?? out.blocked ?? undefined,
    });
    recordRemediation(iid, {
      phase: blockedPhase, reason, category, fixed, changes, at: Date.now(),
    });
    j = readJournal(iid) ?? j;
    await updateCard(j.slackTs ?? '', cardState(j));

    if (!fixed) {
      remediationNote = [
        `Self-remediation ran and could not clear this (${category}).`,
        diagnosis ? `Diagnosis: ${diagnosis}` : '',
        humanNeeded ? `It needs a person to: ${humanNeeded}` : '',
        changes.length ? `It did change: ${changes.join('; ')}` : '',
      ].filter(Boolean).join(' ');
      log.warn('remediation could not clear the block', {
        category, why: (diagnosis || out.error || out.blocked || '').slice(0, 160),
      });
      return null;
    }

    const target = list.find((p) => p.name === retryFrom);
    if (!target || target.onDemand) {
      // Fixed, but with nowhere to go — a real answer from the schema when the
      // repair only matters to the next run. The changes still go on the note,
      // because someone is about to look at a machine that has moved.
      remediationNote = [
        `Self-remediation fixed something (${category})`,
        changes.length ? `: ${changes.join('; ')}` : '',
        `, but named no phase this run could resume from${retryFrom ? ` ('${retryFrom}')` : ''}.`,
        humanNeeded ? ` It needs a person to: ${humanNeeded}` : '',
      ].join('');
      return null;
    }

    pruneFailedLaps(retryFrom);
    log.ok(`remediation fixed a ${category} problem`, {
      changes: changes.join('; ').slice(0, 200) || 'none listed', retryFrom,
    });
    return retryFrom;
  }

  /**
   * Make a phase genuinely re-enterable — the surgery `npm run unblock` performs
   * by hand, done in-process and scoped to one phase.
   *
   * Two rules, both taken from that script because both are load-bearing. A
   * succeeded record is never dropped: the journal is what makes the rest of the
   * run cost nothing, and re-running an Opus implement lap to arrive back where
   * it started costs more than the block did. And an artifact is deleted only
   * when its phase has no surviving success, because a stale artifact from a
   * failed lap is worse than none at all — the next lap reads it as fact — while
   * an artifact belonging to an EARLIER success is what every downstream phase
   * reading `prior[name]` depends on.
   */
  function pruneFailedLaps(phase: string): void {
    const journal = readJournal(iid);
    if (!journal) return;

    const survivors = journal.phases.filter(
      (rec) => rec.phase !== phase || KEPT_STATUSES.has(rec.status),
    );
    const dropped = journal.phases.length - survivors.length;
    journal.phases = survivors;
    writeJournal(journal);
    j = journal;

    const stillSucceeds = survivors.some(
      (rec) => rec.phase === phase && (rec.status === 'ok' || rec.status === 'warned'),
    );
    if (!stillSucceeds) {
      // The phase's own artifact — whose NAME comes from phases.json, not from
      // the phase name — and the `<phase>-partial.json` that verify and qa
      // rewrite after every case. Carried into a fresh lap the partial would
      // salvage results the new lap never produced.
      const configured = list.find((p) => p.name === phase)?.artifact ?? `${phase}.json`;
      for (const name of [configured, `${phase}-partial.json`]) {
        rmSync(artifactPath(iid, name), { force: true });
      }
      delete prior[phase];
    }

    log.info(`cleared ${dropped} failed record(s) for '${phase}'`, {
      artifacts: stillSucceeds ? 'kept — a later lap succeeded' : 'deleted',
    });
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
  /**
   * Open the merge request in code, reusing one if it is already there.
   *
   * Returns an MR_SCHEMA-shaped object so the artifact and `prior.mr` look
   * exactly the same whether the session or the conductor produced them —
   * `merge` reads mrIid and cannot tell the difference. Returns null only when
   * GitLab itself refuses, which is a real block rather than a missing tool.
   */
  async function ensureMergeRequest(
    fromSession: Record<string, unknown> | null,
  ): Promise<Record<string, unknown> | null> {
    const cfgLocal = projectConfig();
    const target = cfgLocal.branches.base;

    const existing = await findMergeRequests({ sourceBranch: branch, state: 'opened' });
    const found = existing.ok ? (existing.data ?? [])[0] : undefined;
    if (found) {
      return {
        summary: `Reused the merge request already open for ${branch}.`,
        blocked: null,
        mrIid: found.iid,
        mrUrl: found.web_url,
        title: found.title,
        targetBranch: found.target_branch,
      };
    }

    // The session's words when it produced any, because they are the half of
    // this phase that actually needed a model.
    const impl = readArtifact<{ commits?: string[]; filesChanged?: string[] }>(iid, 'implement.json');
    const title = String(fromSession?.title ?? '').trim()
      || `${ticket.title} (#${iid})`;
    const description = String(fromSession?.description ?? '').trim()
      || [
        ticket.description?.trim() ? `${ticket.description.trim()}\n` : '',
        `Closes #${iid}.`,
        '',
        `Files changed: ${(impl?.filesChanged ?? []).length}`,
        (impl?.filesChanged ?? []).map((f) => `- \`${f}\``).join('\n'),
        '',
        `_Opened by Oneshot run \`${runId}\`. Verification and QA evidence follow as notes._`,
      ].filter(Boolean).join('\n');

    const made = await createMergeRequest({
      sourceBranch: branch, targetBranch: target, title, description,
    });
    if (!made.ok || !made.data) {
      log.error('conductor could not open the merge request', {
        status: made.status, error: made.error?.slice(0, 160),
      });
      return null;
    }
    updateJournal(iid, { mrIid: made.data.iid, mrUrl: made.data.web_url });
    updateRun(runId, { mr_iid: made.data.iid });
    return {
      summary: `Opened !${made.data.iid} from ${branch} into ${target}.`,
      blocked: null,
      mrIid: made.data.iid,
      mrUrl: made.data.web_url,
      title: made.data.title,
      targetBranch: made.data.target_branch,
    };
  }

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
    updateRun(journal.runId, {
      status, ended_at: Date.now(), blocked_why: reason ?? null, owner_seen_at: Date.now(),
    });
    logEvent('run_finished', { status, reason }, { runId: journal.runId });

    // Both leases go back on EVERY terminal status. Holding a port for a
    // blocked run's forensics starves the pool with nothing to show for it —
    // the worktree is where the forensics actually are. Kill the dev server the
    // run left on that port BEFORE releasing the lease, so it dies while the
    // port is still provably this run's and not something a newer run has since
    // leased. Without this a blocked run's server outlives it and the next
    // verify to lease the port drives a stale one.
    reapPortServer(journal.port);
    releasePort(journal.runId);
    releasePromotion(journal.runId);

    await updateCard(journal.slackTs ?? '', cardState(journal));

    // A run that healed itself twice and then finished is a different story
    // from one that sailed through, and the card tells the second story: a row
    // of green phases, with nothing to say that the machine had to be changed
    // underneath them to get there. What was changed outside the worktree is
    // exactly the part somebody may need to undo.
    const healed = journal.remediations ?? [];
    if (healed.length) {
      await thread(journal.slackTs ?? null, remediationText(journal.iid, healed));
    }

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

    // The readable account of what happened: which phases ran, which subagents
    // each one dispatched, and the transcripts themselves. Written whether the
    // run finished or stopped, because a run that stopped is the one somebody
    // actually needs to read. Synchronous, never throws, and deliberately
    // BEFORE the teardown below — archiveRun moves the directory, and a report
    // written after that would land somewhere that no longer exists.
    const reportPath = writeRunReport(journal.iid);
    if (reportPath) log.ok(`report ${reportPath}`);

    // The run's own trace, written by the conductor rather than by the
    // sessions. Last, and never awaited for anything that matters: a Langfuse
    // that is down must not change how a run ends.
    await exportRun(journal);

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
 * What the run had to change about the machine to get where it got.
 *
 * Every change is listed rather than counted. The whole point of recording them
 * precisely enough to undo is that somebody can undo them, and a thread message
 * saying "3 changes" is a message that sends them to the journal to find out
 * which.
 */
function remediationText(iid: number, healed: Remediation[]): string {
  const lines = healed.map((r) => {
    const verdict = r.fixed ? 'fixed' : 'not fixed';
    const changes = r.changes.length ? `\n   ${r.changes.join('\n   ')}` : '';
    return `• \`${r.phase}\` blocked — ${r.category}, ${verdict}${changes}`;
  });
  return `*#${iid} self-remediation* — ${healed.length} intervention` +
    `${healed.length === 1 ? '' : 's'} during this run\n${lines.join('\n')}`;
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

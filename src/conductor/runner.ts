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
 * the interesting control flow all moves backwards. `review` and `verify` both
 * send work back to `implement`, and everything between the target and the
 * failure has to run again on the way forward. A linear loop can express none
 * of that. What the index buys, in order:
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
 * Two things are asserted here rather than believed. A ticket is driven only
 * by the conductor that can prove it owns the run — on a resumption as much as
 * on a fresh claim, since a live run and an abandoned one both read 'running'
 * from a journal. And a check phase's own account of itself is not evidence:
 * `verify` is overruled when it passed nothing, and `merge` re-derives what
 * `verify` and `review` concluded from their artifacts rather than from their
 * exit status.
 *
 * The pipeline ENDS AT THE MERGE. There is no deploy, no QA against a running
 * build and no demo: 'done' means the change is in the base branch, the ticket
 * carries the exit label, and a person takes it from there.
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
  DRY_RUN, gitlabUsername, MERGE_POLL_MS, PAUSE, WORK_REPO, modelFor,
  mrFeedbackConfig,
  bugReproductionEnabled, phases, portPool, projectConfig,
  operatorName,
  type PhaseConfig,
} from '../lib/config.js';
import {
  claimMarker, claimNoteBody, isMachineNote, readOwnership, settleMs,
} from '../lib/claims.js';
import { collectTicketDocs } from '../lib/ticketdocs.js';
import {
  archiveRun, artifactPath, ensureRunDirs, failedLapsOf, infraAttemptsOf, lapsOf,
  phaseSucceeded, readArtifact,
  readJournal, recordPhase, recordRemediation, reapScratch, updateJournal, writeArtifact,
  writeJournal,
  type PhaseRecord, type Remediation, type RunJournal,
} from '../lib/artifacts.js';
import { branchFor, newRunId, worktreeName } from '../lib/ids.js';
import {
  leasePortFor, leaseWorktree, reapPortServer, reapWorktree, releasePort, seedWorktree,
} from '../lib/worktrees.js';
import {
  addIssueNote, createMergeRequest, deleteIssueNote, findMergeRequests, getIssue, getIssueNote,
  allIssueNotes, issueUrl, swapLabel, type Issue,
} from '../lib/gitlab.js';
import { acquirePromotion, releasePromotion, sleep } from '../lib/promotion.js';
import { checkQuota } from '../lib/quota.js';
import { checkTestLogin } from '../lib/testlogin.js';
import {
  claimOwnership, claimTicket, getRun, logEvent, phaseEnd, phaseStart, updateRun,
} from '../lib/db.js';
import { postCard, thread, updateCard, alert, type CardState, type PhaseLine } from '../lib/slack.js';
import { declareNotABug, notABugDecision } from './reproduction.js';
import { log } from '../lib/log.js';
import { accountActionReason } from '../lib/accountgate.js';
import { exportRun } from '../lib/langfuse.js';
import { writeRunReport } from '../lib/report.js';
import { publishPending } from '../lib/publish.js';
import { startRunApp } from '../lib/appserver.js';
import { runPhase, type PhaseOutput } from './phase.js';
import { schemaFor } from './schemas.js';
import { mergePhase } from './codephases.js';
import {
  appendEdgeCases, checkApprovalGate, declaredFiles, designApprovalRequestBody,
  designApprovedRecordBody, designAttachments, designGateApplies, gatesApply,
  planApprovalRequestBody, planApprovedRecordBody, reviewAllRuns, reviewLabelPresent,
  testcasesApprovalRequestBody, testcasesApprovedRecordBody, triggerLine,
} from './reviewgate.js';
import { isImplemented, promptFor, systemPromptFor, type PromptCtx } from '../phases/prompts.js';
import type { Ticket, TestCase } from '../phases/types.js';
import {
  activeRound, addressedFeedbackOf, emptyLedger, normaliseItems, phasesOwedByRound, recordAddressed,
  roundsUsed, startRound,
} from '../mrfeedback/ledger.js';
import type { MrFeedbackSignal } from '../mrfeedback/types.js';

const exec = promisify(execFile);

/**
 * A Review-labelled ticket whose gates have no Slack to ask in. Blocked, not
 * parked: a park waits for a human reply, and there is no channel here for a
 * human to reply in — so the wait would never end, and the one status that
 * deliberately alerts nobody would be the one that needs somebody.
 */
const GATE_UNAVAILABLE =
  'this ticket carries the Review label, but Slack is not configured (token + channel), so its '
  + 'approval gates have nowhere to ask — configure Slack, or remove the Review label to run '
  + 'this ticket in the ordinary full-auto mode';

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
  status: 'done' | 'blocked' | 'aborted' | 'refused' | 'parked';
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
  ((ctx: CodePhaseCtx) => Promise<{
    ok: boolean; error?: string; data?: Record<string, unknown>;
    /**
     * Set only by `merge`'s Review-gate pre-check: "not ready yet, try again"
     * rather than an ordinary failure. Distinguished from `!ok` alone so the
     * run can PARK (auto-resumed by the next tick, no label change, no
     * BLOCKED alert) instead of following the phase's onFail policy, which
     * for `merge` is 'blocked' — i.e. Needs Human, which a missing approval
     * or a still-running pipeline is not.
     */
    park?: boolean;
    /** Set only by `merge`: new MR review threads for the runner to triage. */
    feedback?: MrFeedbackSignal;
  }>) | undefined
> = {
  merge: mergePhase,
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
      if (last.status === 'parked') return { phase: p.name, state: 'waiting' };
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
    owner: operatorName(),
  };
}

// ------------------------------------------------------------------ the ticket

async function fetchTicket(iid: number): Promise<Ticket | null> {
  const res = await getIssue(iid);
  if (!res.ok || !res.data) return null;
  const notes = await allIssueNotes(iid);
  if (!notes.ok) log.warn(`#${iid}: could not read the ticket's comments; phases see the description only`, { error: notes.error });
  // Every human comment, oldest first and unbounded: requirements are amended
  // and documents attached anywhere in a thread, and a window drops them
  // silently. GitLab's system notes (label swaps, assignments, "mentioned in")
  // are not comments and would only crowd the prompt. This system's own notes
  // are dropped too — by marker, and by the older 'Oneshot ' prefix — because
  // feeding its plan and test cases back in as ticket requirements is how a
  // phase ends up working on a summary of itself.
  const comments = notes.ok && notes.data
    ? notes.data
      .filter((n) => !n.system && n.body && !isMachineNote(n.body) && !n.body.startsWith('Oneshot '))
      .map((n) => n.body)
    : [];
  const docs = await collectTicketDocs(iid, [
    { where: 'description', body: res.data.description ?? '' },
    ...comments.map((body, i) => ({ where: `comment ${i + 1}`, body })),
  ]).catch((err: Error) => {
    log.warn(`#${iid}: could not collect the ticket's documents`, { error: err.message });
    return { documents: [], externalDocs: [] };
  });
  return {
    iid: res.data.iid,
    title: res.data.title,
    description: res.data.description,
    labels: res.data.labels,
    notes: comments,
    documents: docs.documents,
    externalDocs: docs.externalDocs,
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

  // 'parked' is the Review label's opt-in wait (plan approval, merge
  // test-case approval, merge) — an ordinary, human-caused resumption exactly
  // like 'running'/'aborted', not a block: no cooldown, no label swap, and
  // the next scan's claim is what re-checks it. See src/conductor/reviewgate.ts.
  if (existing.status === 'running' || existing.status === 'aborted' || existing.status === 'parked') {
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
  | {
    kind: 'stop'; status: 'blocked' | 'aborted' | 'parked'; reason: string;
    /** The block is a verdict for a person, not an environment fault — do not spend a remediation on it. */
    noRemediation?: boolean;
  };

/**
 * `labels` plus the in-review label, when one is configured — the set a run
 * takes off the ticket when it stops waiting on a reviewer.
 */
function withInReview(cfg: ReturnType<typeof projectConfig>, labels: string[]): string[] {
  return cfg.labels.inReview ? [...labels, cfg.labels.inReview] : labels;
}

function statusForFailure(p: PhaseConfig, infra = false): PhaseRecord['status'] {
  if (p.onFail === 'skip') return 'skipped';
  if (p.onFail === 'warn') return 'warned';
  // Recorded before the onFail policy is consulted, because the policy is about
  // what a WRONG RESULT means and an infra death produced no result at all.
  if (infra) return 'infra';
  return 'failed';
}

/**
 * The status a code phase's result is recorded under.
 *
 * A park is decided BEFORE the failure policy, because it is not a failure:
 * `merge` returns `ok: false, park: true` on every poll of a Review ticket's MR
 * that no person has merged yet. Recording those as 'failed' filled the ledger
 * with a failed merge per poll (32 of 37 merge rows), burying the handful of
 * real refusals and disagreeing with the `In Review` label on the ticket.
 */
export function codePhaseStatus(
  p: PhaseConfig, done: { ok: boolean; park?: boolean },
): PhaseRecord['status'] {
  if (done.ok) return 'ok';
  if (done.park) return 'parked';
  return statusForFailure(p);
}

/**
 * How long a resumed, merge-parked run should keep waiting before the merge
 * phase asks GitLab again — or null when it should run now.
 *
 * `wasParked` must be the run's status as it was CLAIMED, before the resume
 * flips the journal to 'running'. Checking the live journal instead is what
 * made this gate dead code: it always read 'running', so every conductor tick
 * walked the pipeline to `merge` and wrote another row, every ~3 minutes under
 * --follow and every minute under the loop, instead of once per poll window.
 */
export function mergePollWait(o: {
  wasParked: boolean; reviewMode: boolean; dryRun: boolean;
  lastCheckAt: number | undefined; mergeSucceeded: boolean; now: number;
}): number | null {
  if (!o.wasParked || !o.reviewMode || o.dryRun || o.mergeSucceeded) return null;
  if (typeof o.lastCheckAt !== 'number') return null;
  const dueIn = o.lastCheckAt + MERGE_POLL_MS - o.now;
  return dueIn > 0 ? dueIn : null;
}

/**
 * A phase that executed its case list and recorded failures did NOT succeed.
 *
 * `verify` returns ok for *running* the list, whatever the verdicts —
 * the schema's `ok` means "the session finished and produced its artifact", not
 * "the work is right". Until now the only thing that read the verdicts back was
 * `qualityGate()` inside the merge phase, which is three phases too late: a run
 * whose own cases fail still spends `ui-evidence`, still opens an MR, and only
 * then refuses to merge. The reviewer gets an MR nobody can merge, and the lap
 * that would have fixed the code is spent proving it is broken.
 *
 * The phase is already configured `onFail: cycle → implement`. This makes
 * that policy fire on the thing it was written for, so the failure returns to
 * `implement` while it is still cheap — before an MR exists. `qualityGate()`
 * stays where it is as a backstop: it re-derives the same fact deterministically
 * at the merge, and a check that only runs early is a check a resumed run skips.
 */
function failedCases(name: string, data: Record<string, unknown> | null | undefined): string | null {
  if (name !== 'verify') return null;
  const results = (data as { results?: Array<{ id?: string; result?: string }> } | null)?.results;
  if (!Array.isArray(results) || results.length === 0) return null;
  const failed = results.filter((r) => r.result === 'fail');
  if (failed.length === 0) return null;
  const ids = failed.map((r) => r.id ?? '?').join(', ');
  const other = results.filter((r) => r.result === 'blocked' || r.result === 'skipped').length;
  const tail = other ? ` (${other} further case(s) blocked or never run)` : '';
  return `${name} recorded ${failed.length} failing case(s) of ${results.length}: ${ids}${tail}`;
}

/**
 * The one-screen account of a run that did not finish.
 *
 * A stopped run previously said only what went wrong, on a single line that
 * long reasons truncate. What a person actually asks next is "which phase",
 * "how did it get there" and "what do I do" — so the phase history, the
 * attempts already spent and the recovery command are printed together, with
 * infra deaths marked as such so nobody spends time investigating a phase that
 * was merely cancelled.
 */
function logStopDetail(journal: RunJournal, headline: string): void {
  const laps = journal.phases.filter((p) => p.status === 'failed').length;
  const infra = journal.phases.filter((p) => p.status === 'infra').length;
  const trail = journal.phases.slice(-6)
    .map((p) => `${p.phase}:${p.status}${p.status === 'infra' ? '(no lap)' : ''}`)
    .join(' → ');

  log.info(`   ${headline} at '${journal.stoppedPhase ?? 'no phase'}'`, {
    run: journal.runId,
    failedLaps: laps,
    infraDeaths: infra,
  });
  if (trail) log.info(`   trail  ${trail}`);
  if (journal.blockedWhy) log.info(`   why    ${journal.blockedWhy.split('\n')[0]}`);
  if (journal.status === 'blocked') {
    log.info(`   next   npm run unblock -- ${journal.iid}   (drops the failed records, re-labels)`);
  }
}

/**
 * Move the index, or end the run.
 *
 * A cycle forces every phase from the target up to the one that failed, which
 * is the whole point: a qa cycle sits AFTER mr, merge and deploy, so unless
 * those re-run the fix never reaches the box that rejected it. `testcases` is
 * the single exception — that list is written once and pinned, because verify
 * and qa comparing runs against two different lists compares nothing.
 *
 * `list` and `forced` are passed in rather than closed over so the index
 * arithmetic can be single-stepped in a test without standing up a run — it
 * decides which phases re-run, which is the one thing here worth proving.
 */
/**
 * What a test-case gate round means, once its verdict is known.
 *
 * The same reviewer text means two different things depending on how the round
 * ended, which is why this cannot be decided when the text arrives. A comment
 * followed by `approved` is an ADDITION to a list the reviewer accepted — one
 * more case, appended, no session spent. The same comment with no sign-off is a
 * REVISION request, and append is the one verb that cannot express "TC-05 is
 * replaced by the three below": it leaves TC-05 in place and files the sentence
 * itself as a case. That is how workstreamai#87 reached 44 cases from 20.
 *
 * `revise` therefore cycles the `testcases` phase, the way the plan gate has
 * always cycled `plan` — a model re-reads the list with the reviewer's words in
 * its prompt, and the editing rules in erp-ticket-test-plan finally have a
 * reader.
 */
export type TestcaseGateRoute = 'blocked' | 'revise' | 'proceed' | 'park';

export function testcaseGateRoute(
  verdict: 'approved' | 'feedback' | 'pending' | 'unavailable',
  canCycle: boolean,
): TestcaseGateRoute {
  if (verdict === 'unavailable') return 'blocked';
  if (verdict === 'approved') return 'proceed';
  // A board with no `testcases` phase configured cannot cycle one. Parking is
  // the honest answer: the reviewer's revision is recorded and a person can
  // act on it, which beats silently treating a revision as an approval.
  if (verdict === 'feedback' && canCycle) return 'revise';
  return 'park';
}

export function nextIndex(
  control: Exclude<Control, { kind: 'stop' }>,
  current: number,
  lastMember: number,
  list: PhaseConfig[],
  forced: Set<string>,
): number {
  if (control.kind === 'retry') {
    // A retry means "run it again", and runOne() has already taken the phase
    // out of `forced` at its start. Without putting it back, a phase that
    // succeeded on an EARLIER lap reads as done and shouldSkip() passes the
    // retry by: #168's re-plan against reviewer feedback died of infra, was
    // skipped, and the old plan was re-published for approval as though it
    // were the revision. The same hole skips an implement retry inside a
    // review cycle, and an infra re-attempt of any phase that had passed.
    //
    // Only the retried phase is re-forced, and that is deliberate even though
    // a phase can belong to a `group` (testcases+review, ui-evidence+mr). The
    // group is rebuilt from scratch on the retry pass, and its rebuild breaks
    // on the first member shouldSkip() answers true for — a still-succeeded
    // sibling is not forced, so it is not re-run and the group collapses to a
    // solo run of the retried member. That is the intended shape: the sibling
    // passed and re-running it buys nothing. Forcing the whole group back in
    // would spend a fresh session on work that is already done.
    forced.add(list[control.at]!.name);
    return control.at;
  }
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
 * Free re-attempts a phase gets for deaths that were never its own verdict.
 *
 * Two, because the failures this exists for are one-offs — a conductor
 * restart, a cancelled session, a machine hiccup — and anything that survives
 * two clean re-attempts is a real problem that should reach a person through
 * the ordinary onFail policy rather than spin here.
 */
const MAX_INFRA_ATTEMPTS = 2;

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
  // Label-gated phases are FILTERED OUT, not skipped in place. A phase skipped
  // in place still occupies an index, and `nextIndex`, `cycleTo` and the group
  // batching all do arithmetic on those — so a phase nobody is running must
  // not be in the list they walk. See `labelGated` in src/lib/config.ts.
  const carried = new Set(issue.labels.map((l) => l.toLowerCase()));
  const list = phases().filter((p) => !p.labelGated || carried.has(p.labelGated.toLowerCase()));
  const owner = opts.conductor;

  if (issue.assignees.length > 0) {
    const me = gitlabUsername();
    if (!me) {
      log.info(`#${iid} — assigned ticket, but this desk has no GitLab identity`);
      return { runId: '', iid, status: 'refused', reason: 'assigned ticket, but this desk has no GitLab identity (npm run token:set)' };
    }
    if (!issue.assignees.some((a) => a.username === me)) {
      const owners = issue.assignees.map((a) => a.username).join(', ');
      log.info(`#${iid} — assigned to ${owners}, not to ${me}`);
      return { runId: '', iid, status: 'refused', reason: `assigned to ${owners}` };
    }
  }

  const decision = decideResume(readJournal(iid));
  if (decision.kind === 'refuse') {
    log.warn(`#${iid} — ${decision.reason}`);
    return { runId: '', iid, status: 'refused', reason: decision.reason };
  }

  const resuming = decision.kind === 'resume';
  // Read before the resume below overwrites both: `j` IS decision.journal.
  const wasParked = decision.kind === 'resume' && decision.journal.status === 'parked';
  const parkedWhy = wasParked ? decision.journal.blockedWhy : undefined;
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

  // Re-derived every run, fresh and resumed alike, so a human adding or
  // removing the Review label between conductor restarts takes effect on the
  // next claim rather than freezing whatever it was when the run started.
  // Stored on the journal (not just held locally) because the pure-code
  // `merge` phase has no ticket object of its own to read labels from.
  // Label OR guarded paths. On a fresh run only the label can be known here —
  // nothing has declared a file yet — so the path half is re-evaluated at each
  // gate below and persisted when it fires, which is what lets the pure-code
  // `merge` phase honour a gate that no label ever asked for.
  const reviewMode = reviewAllRuns() || reviewLabelPresent(ticket.labels)
    || gatesApply(ticket.labels, declaredFiles(readArtifact(iid, 'plan.json'),
      readArtifact(iid, 'implement.json'))).on;
  if (j.reviewMode !== reviewMode) { j = updateJournal(iid, { reviewMode }) ?? j; }

  // Waiting on a person to merge is the one park where re-entering the
  // pipeline costs more than it can possibly learn. MERGE_POLL_MS spares the
  // merge phase its GitLab round trip, but the tick still walks the whole
  // phase list to reach it, and every phase without a recorded success is
  // re-attempted on the way — a `skip`-on-fail phase like `recall` burns a
  // full model lap per tick, against a decision measured in hours. So the
  // window gates the RUN, not just the API call: until it is due, this
  // returns exactly where it left off, having spent nothing.
  //
  // Bounded to before `merge` records a success, so a later park (the qa
  // gate, which wants a prompt re-check every tick) is never held behind a
  // merge poll that has already served its purpose. Removing the Review
  // label still releases it immediately — `reviewMode` is re-derived above,
  // and this is skipped the moment it reads false.
  {
    const dueIn = mergePollWait({
      wasParked, reviewMode, dryRun: DRY_RUN, lastCheckAt: j.humanMergeCheckAt,
      mergeSucceeded: phaseSucceeded(iid, 'merge'), now: Date.now(),
    });
    if (dueIn !== null) {
      log.info(`#${iid} parked on a human merge — next check in ${Math.ceil(dueIn / 60_000)}m`);
      // Through finish(), not a bare return: the claim above has already
      // flipped the journal and the run row to 'running'. Leaving them there
      // would hold a dispatch slot with no phase behind it — the exact
      // starvation a park exists to avoid.
      return finish(j, 'parked', parkedWhy ?? 'awaiting a human merge');
    }
  }

  // The Slack card is posted once and edited in place for the rest of the run.
  if (!j.slackTs) {
    const ts = await postCard(cardState(j));
    if (ts) { j.slackTs = ts; writeJournal(j); updateRun(runId, { slack_ts: ts }); }
  }

  // The cross-machine claim (lib/claims.ts). The SQLite claim above proves
  // this ticket is ours on THIS machine; nothing on another laptop can see
  // that row. The claim note is the half every conductor can see, and the
  // rule is the oldest live note owns the ticket.
  //
  // Post, then WAIT before trusting it. Two conductors that scanned the same
  // tick post within the same second, and whichever re-reads first would see
  // only its own note and proceed. The settle window is how long a
  // simultaneous claimant's note is given to land before the decision is
  // made; after it, oldest wins and the loser deletes its note and stands
  // down. A resume whose own claim is still live re-asserts nothing — it only
  // re-checks that it is still the oldest.
  if (!DRY_RUN) {
    // Trust the journal's own record before asking issueNotes() to find it
    // again in a haystack sized for a different caller's needs. issueNotes()
    // returns only the newest hundred comments — fine for the things that
    // scan a bounded recent tail, but a claim note this run posted hours ago
    // ages out of that window the moment a busy ticket (a `--follow` watch
    // especially) accrues a hundred comments after it. The scan then finds
    // no claim of ours, mineLive reads false, and the run reposts — a note
    // that itself ages out a few ticks later, so it reposts again, visibly,
    // in the ticket's own thread. A direct lookup by id has no window: if
    // j.claimNoteId still resolves to a note that still names this run, the
    // claim is live, full stop, and nothing here needs re-deriving it from a
    // list.
    let mineLive = false;
    if (j.claimNoteId !== undefined) {
      const mine = await getIssueNote(iid, j.claimNoteId);
      mineLive = mine.ok && (mine.data?.body ?? '').includes(claimMarker(runId));
      if (!mineLive) j.claimNoteId = undefined;
    }
    if (!mineLive) {
      const posted = await addIssueNote(iid, claimNoteBody(runId, operatorName()));
      if (posted.ok && posted.data) {
        j.claimNoteId = posted.data.id;
        writeJournal(j);
      }
      await sleep(settleMs(), opts.signal);

      // Settled when the note was first posted — nothing that landed since
      // can be older than it, so a run whose own note the fast path just
      // confirmed has no later claim to yield to and needs no ownership
      // re-scan. Only a run that just (re-)posted, or found no journal
      // record at all, still needs this to find out where it landed.
      const after = await readOwnership(iid);
      if (!after) {
        log.warn(`#${iid} — could not read the ticket's claims; proceeding on the local claim alone`);
      } else if (after.earliest && after.earliest.runId !== runId) {
        // Lost. Not an error and not a block: the ticket is somebody's, and the
        // scan will skip it for as long as their claim is live. Take our note
        // off so the ticket shows one owner, then stand down with the leases
        // released. 'aborted' resumes if their claim ever goes stale.
        if (j.claimNoteId) {
          const del = await deleteIssueNote(iid, j.claimNoteId);
          if (!del.ok) {
            log.warn(`#${iid} — claim note ${j.claimNoteId} left on the ticket: ${del.error ?? del.kind}`);
          }
          j.claimNoteId = undefined;
          writeJournal(j);
        }
        const who = after.earliest.author ? ` (${after.earliest.author})` : '';
        log.warn(`#${iid} — yielding: run ${after.earliest.runId}${who} claimed this ticket first`);
        logEvent('claim_yielded', { iid, to: after.earliest.runId, author: after.earliest.author }, { runId });
        return finish(j, 'aborted', `yielded — run ${after.earliest.runId}${who} claimed this ticket first`);
      }
    }
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
  // A RESUMED run never leases: ensureLeases() only calls leaseWorktree() when
  // `worktree` is unset, and the line above just set it from the journal. So
  // the seeding that composes `.claude` — the skills, rules and agents every
  // phase reasons with — ran once, whenever this worktree was first created,
  // and never again. A worktree that outlives a change to those files keeps
  // serving the old ones, and a run resumed after an approval gate is exactly
  // that case. Re-seed here: it is idempotent by construction, and it is the
  // only point on the resume path that sees the worktree before a phase does.
  if (worktree) seedWorktree(worktree);
  let port: number | undefined = j.port;
  /** One background bring-up per run, whether the worktree was leased now or resumed. */
  let appStarting = false;
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

  // A review-feedback round that lost the process anywhere in its fix lap —
  // before implement succeeded, or after implement but before review, verify
  // or mr re-ran. `forced` above is in memory only, so without this a resume
  // would skip straight past whichever of those phases still holds a
  // pre-round record, and merge would answer reviewers about code nobody
  // re-reviewed, re-verified, or even re-pushed.
  {
    const from = list.findIndex((p) => p.name === 'implement');
    const to = list.findIndex((p) => p.name === 'merge');
    const window = from !== -1 && to !== -1
      ? list.slice(from, to).filter((p) => p.name !== 'testcases' && !p.onDemand).map((p) => p.name)
      : [];
    for (const name of phasesOwedByRound(j.mrFeedback, j.phases, window)) forced.add(name);
  }

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
      i = nextIndex(control, i, i, list, forced);
      continue;
    }

    if (shouldSkip(phase)) {
      prior[phase.name] = readArtifact(iid, phase.artifact ?? `${phase.name}.json`);
      log.info(`skip ${phase.name} — already succeeded this run`);
      i += 1;
      continue;
    }

    // The Design label's design-approval gate — between `design` and `plan`.
    //
    // It sits BEFORE `plan` rather than after it for the same reason the
    // test-case gate sits before `review`: this is the last point at which
    // approving still changes everything downstream. A design agreed here is
    // what `plan` plans and `implement` builds; the same approval taken after
    // the plan existed would be approving a picture of something already
    // decided.
    //
    // A design that found no UI to draw (`applicable: false`) never arms it.
    // Someone labels optimistically, or the ticket turns out backend-only, and
    // a mislabelled ticket should cost a re-read of one artifact rather than a
    // person — the same posture `bugReproduction` takes on 'inconclusive'.
    const design = prior.design ?? null;
    const designNeedsSignoff = design !== null && (design as { applicable?: unknown }).applicable !== false;
    if (phase.name === 'plan' && phaseSucceeded(iid, 'design')
      && designGateApplies(ticket.labels) && designNeedsSignoff && !j.designApproval?.approved) {
      const gate = await checkApprovalGate({
        iid,
        gate: 'design',
        requestBody: designApprovalRequestBody(design),
        attachments: designAttachments(iid, design),
        onApproved: async () => { await addIssueNote(iid, designApprovedRecordBody(design)); },
      });
      j = readJournal(iid) ?? j;
      if (gate.verdict === 'unavailable') return finish(j, 'blocked', GATE_UNAVAILABLE);
      if (gate.verdict === 'pending') {
        return finish(j, 'parked',
          'awaiting design approval — a dev reviewer comments `approved` on the ticket to continue, '
          + 'or comments there what to change to have the design redrawn');
      }
      if (gate.verdict === 'feedback') {
        const designIdx = list.findIndex((p) => p.name === 'design');
        if (designIdx !== -1) {
          forced.add('design');
          i = designIdx;
          continue;
        }
      }
      // 'approved' (or 'design' somehow absent from the list) — fall through
      // into 'plan' below, which now reads design.json as its specification.
    }

    // The Review label's plan-approval gate — opt-in, additive, and checked
    // only once per run: `planApproval.approved` latches true and every later
    // pass (including an ordinary review/verify cycle back to `implement`)
    // skips straight past this. One quick GitLab read, never a loop — see
    // src/conductor/reviewgate.ts's file header for why, and for why the
    // ticket rather than Slack is what this polls.
    const planGate = gatesApply(ticket.labels, declaredFiles(prior.plan ?? null, null));
    if (phase.name === 'implement' && phaseSucceeded(iid, 'plan')
      && planGate.on && !j.planApproval?.approved) {
      if (planGate.hits.length && !j.reviewMode) {
        j = updateJournal(iid, { reviewMode: true }) ?? j;
        log.warn('review gates armed by guarded paths, not by the label', { iid, hits: planGate.hits });
      }
      const gate = await checkApprovalGate({
        iid,
        gate: 'plan',
        requestBody: planApprovalRequestBody(prior.plan ?? null, triggerLine(planGate)),
        trigger: planGate,
        onApproved: async () => { await addIssueNote(iid, planApprovedRecordBody()); },
      });
      j = readJournal(iid) ?? j;
      if (gate.verdict === 'unavailable') return finish(j, 'blocked', GATE_UNAVAILABLE);
      if (gate.verdict === 'pending') {
        return finish(j, 'parked',
          'awaiting plan approval — a dev reviewer comments `approved` on the ticket to continue, ' +
          'or comments feedback there to have the plan revised');
      }
      if (gate.verdict === 'feedback') {
        const planIdx = list.findIndex((p) => p.name === 'plan');
        if (planIdx !== -1) {
          forced.add('plan');
          // The revised plan.json must be republished — the FIRST plan
          // already occupies the 'plan' key in `published`, so publishPending
          // would otherwise never post the reviewer's requested revision to
          // the ticket. This is the ordinary, Review-label-agnostic publish
          // flow (src/lib/publish.ts) doing what it always does; the gate
          // itself only ever posts its own request comment.
          const withoutPlan = (j.published ?? []).filter((k) => k !== 'plan');
          j = updateJournal(iid, { published: withoutPlan }) ?? j;
          i = planIdx;
          continue;
        }
      }
      // gate.verdict === 'approved' (or 'plan' is somehow absent from the
      // configured phase list) — fall through into 'implement' below.
    }

    // The Review label's test-case gate, sitting after phase 4 (`testcases`)
    // and before phase 5 (`review`).
    //
    // A reply is routed by what it ASKS FOR, and the two answers need different
    // machinery. A reviewer who signs off while naming one more case is asking
    // for an APPEND, and `appendEdgeCases` is exactly right for it: the list
    // they approved plus the case they added, no session, no cost. A reviewer
    // who replies instead of approving is asking for a REVISION — "TC-05 is
    // removed and replaced by the three cases below" — and append is the one
    // verb that cannot express it. Appending that sentence produced a case
    // reading `Verify that TC-05 is removed and replaced by...` while TC-05
    // itself stayed, and took workstreamai#87 from 20 cases to 44.
    //
    // So feedback cycles the phase, the way the plan gate already does: the
    // `testcases` session re-enters with the reviewer's words in its prompt and
    // its skill loaded, and re-authors the list. The editing rules live in
    // erp-ticket-test-plan, which is instruction for a MODEL — and until the
    // phase re-ran there was no model on this path to read them.
    //
    // Placed here rather than after `qa` so that approval still has leverage:
    // everything a reviewer adds is carried into `review`, the MR and the `qa`
    // run that follows. Taken after `qa`, the same reply would land on merged
    // code and could only become a follow-up ticket.
    const caseGate = gatesApply(ticket.labels,
      declaredFiles(prior.plan ?? null, prior.implement ?? null));
    const caseGatePending = caseGate.on && !j.testcasesApproval?.approved;
    if (phase.name === 'review' && phaseSucceeded(iid, 'testcases') && caseGatePending) {
      const cases = (prior.testcases as { cases?: TestCase[] } | null)?.cases ?? [];
      if (caseGate.hits.length && !j.reviewMode) {
        j = updateJournal(iid, { reviewMode: true }) ?? j;
        log.warn('review gates armed by guarded paths, not by the label', { iid, hits: caseGate.hits });
      }

      let roundFeedback = '';
      const gate = await checkApprovalGate({
        iid,
        gate: 'testcases',
        requestBody: testcasesApprovalRequestBody(cases, triggerLine(caseGate)),
        trigger: caseGate,
        // Appending runs on EVERY round that carried replies, approved or
        // not, and always before onApproved — a reviewer who lists an edge
        // case and signs off in the same breath gets the case recorded and
        // the audit note built from the list that now contains it.
        // Recorded, not applied: which of the two routes this round takes is
        // not knowable until the verdict is, because an `approved` later in
        // the same round turns the very same text from a revision request
        // into an addition.
        onFeedback: async (feedback) => { roundFeedback = feedback; },
        onApproved: async () => {
          // Signed off WITH a case named in the same breath — the append case,
          // and it must land before the audit note so the record shows the
          // list that was actually approved.
          if (roundFeedback) {
            const updated = appendEdgeCases(iid, roundFeedback);
            if (updated) prior.testcases = { ...(prior.testcases ?? {}), cases: updated };
          }
          const finalCases = (readArtifact<{ cases?: TestCase[] }>(iid, 'testcases.json')?.cases) ?? cases;
          await addIssueNote(iid, testcasesApprovedRecordBody(finalCases));
        },
      });
      j = readJournal(iid) ?? j;
      const casesIdx = list.findIndex((p) => p.name === 'testcases');
      const route = testcaseGateRoute(gate.verdict, casesIdx !== -1);
      if (route === 'blocked') return finish(j, 'blocked', GATE_UNAVAILABLE);
      if (route === 'revise') {
        forced.add('testcases');
        // The revised list must be republished: the first list already holds
        // the 'testcases' key in `published`, so publishPending would never
        // post the revision the reviewer asked for. Same reasoning, and the
        // same two lines, as the plan gate above.
        const withoutCases = (j.published ?? []).filter((k) => k !== 'testcases');
        j = updateJournal(iid, { published: withoutCases }) ?? j;
        i = casesIdx;
        continue;
      }
      if (route === 'park') {
        return finish(j, 'parked',
          'awaiting test-case approval — a QA reviewer comments `approved` on the ticket to ' +
          'continue to `review`, or comments changes to have the list revised');
      }
      // gate.verdict === 'approved' — fall through into 'review' below.
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
        // Batching 'review' in with 'testcases' would run it before the loop
        // ever visits 'review' on its own — the only place the gate above
        // fires. Hold it back so the next iteration lands on it solo.
        if (next.name === 'review' && caseGatePending) break;
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
      // Straight to finish(), not through the control flow: a missing account
      // is a credential nobody provisioned, which remediation hands back
      // anyway — spending an Opus session to say so is the cost this avoids.
      if (p.name === 'verify' && !DRY_RUN && worktree) {
        const login = await checkTestLogin(worktree);
        if (login.ok === false) {
          return finish(j, 'blocked', `verify: ${login.reason.replace('<iid>', String(iid))}`);
        }
        if (login.ok === null) {
          log.warn('test login not pre-checked — verify will find out for itself', { why: login.reason });
        } else {
          log.ok(`test login ${login.email} is provisioned`);
        }
      }
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

    // A check phase's own account of itself is not evidence. Overrule it before
    // anything is recorded, so the journal and the card show the verdict the
    // conductor reached rather than the one the session reported.
    // Salvage below must never hand back a verdict the conductor just overruled:
    // verify-partial.json can be a previous lap's, and reading its passes as
    // this session's would turn "ran nothing" back into a green phase.
    const overruled = new Set<PhaseResult>();
    for (const r of results) {
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
      //
      // Except when it executed nothing. A list that is ALL 'skipped' is not a
      // verdict on the environment or the change — it is a session that spent
      // its budget before the first case (ticket #189: the whole lap went on
      // server bring-up, and the block said the change was "broken end to end"
      // when the servers it left behind were answering correctly). That is the
      // shape of an infra death, so it takes the free re-attempt, and only a
      // session that keeps running nothing reaches a person — told the truth.
      if (r.cfg.name === 'verify' && r.out.ok) {
        const res = (r.out.data?.results ?? []) as Array<{ result: string; evidence?: string }>;
        const passes = res.filter((x) => x.result === 'pass').length;
        const skipped = res.filter((x) => x.result === 'skipped').length;
        if (res.length > 0 && skipped === res.length) {
          const first = String(res[0]?.evidence ?? '').split('\n')[0]!.slice(0, 200);
          const ranNothing = `verify ran none of its ${res.length} case(s) — every one is recorded ` +
            `'skipped', so nothing about the change was tested${first ? ` (${first})` : ''}`;
          r.out.ok = false;
          r.out.error = ranNothing;
          overruled.add(r);
          if (infraAttemptsOf(iid, 'verify') < MAX_INFRA_ATTEMPTS) {
            r.out.infra = true;
            log.warn(`verify overruled — ${ranNothing}`);
          } else {
            r.hardStop = `${ranNothing}. It has now done that ${MAX_INFRA_ATTEMPTS + 1} times, so ` +
              'the cause is outside the session: read the evidence above and the verify transcript.';
            log.error(`verify overruled — ${r.hardStop}`);
          }
        } else if (res.length > 0 && passes === 0) {
          const failed = res.filter((x) => x.result === 'fail').length;
          r.out.ok = false;
          overruled.add(r);
          r.hardStop = `verify recorded ${res.length} case(s) — ${failed} failed, ` +
            `${res.length - failed - skipped} blocked, ${skipped} skipped — and NONE passed. An ` +
            'all-negative local run means the environment or the change is broken end to end, and ' +
            'neither is something a merge should ride through. A human decides whether the ' +
            'demo-server QA gate alone is acceptable for this ticket.';
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
      // continue.
      //
      // This used to be underwritten by `qa`, which re-ran the whole list
      // against the deployed build; with the pipeline ending at the merge,
      // nothing re-runs the cases a dead session never reached. What still
      // holds is the part that matters — qualityGate refuses to merge over a
      // recorded FAILURE — so the residual risk is narrower and worth naming:
      // a change can merge with cases that were never executed, and the
      // artifact says exactly which, because they are recorded 'skipped'
      // rather than quietly dropped.
      if (r.cfg.name === 'verify' && !r.out.ok && !r.out.blocked && !overruled.has(r)) {
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
          r.out.data = {
            summary, blocked: null, serverStarted: true, port: port ?? 0, results, regressions: [],
          };
          r.out.ok = true;
          writeArtifact(iid, r.cfg.artifact ?? `${r.cfg.name}.json`, r.out.data);
          log.warn(`${r.cfg.name} salvaged from partial results — ${recorded.length} recorded, ${skipped.length} skipped`);
        }
      }

      // The same bargain for the phase that WRITES the list rather than executing
      // it. testcases is onFail 'abort', so a session that dies at its cap does
      // not cost a lap — it costs the whole run, and every turn it spent reading
      // is thrown away because reading leaves no artifact. Its prompt therefore
      // rewrites testcases-partial.json every few cases, and a list that got far
      // enough to be worth reviewing is better than a blocked run: in review mode
      // the QA gate shows this list to a person who can reject it or append the
      // cases it is missing, and the summary says outright that it is partial.
      // Below the floor there is nothing to review and blocking is the honest
      // answer, which is why this salvages a short list rather than any list.
      if (r.cfg.name === 'testcases' && !r.out.ok && !r.out.blocked) {
        const MIN_SALVAGEABLE_CASES = 5;
        const partial = readArtifact<{
          module?: string; lv?: string; cases?: Array<Record<string, unknown>>;
        }>(iid, 'testcases-partial.json');
        const cases = partial?.cases ?? [];
        if (cases.length >= MIN_SALVAGEABLE_CASES) {
          const module = String(
            partial?.module || readArtifact<{ module?: string }>(iid, 'research.json')?.module || '',
          );
          const summary = `Salvaged from testcases-partial.json: ${cases.length} case(s) written `
            + `before the session died (${r.out.error ?? 'no error text'}). The list is PARTIAL — `
            + 'the brainstorm passes were not all run, so treat a gap as unwritten, not as clean.';
          r.out.data = {
            summary,
            blocked: null,
            module,
            lv: String(partial?.lv || 'LV_TBD'),
            cases,
            // Deliberately empty: passesEmpty means "this pass ran and found
            // nothing", and a dead session cannot assert that about any pass.
            passesEmpty: [],
          };
          r.out.ok = true;
          writeArtifact(iid, r.cfg.artifact ?? 'testcases.json', r.out.data);
          log.warn(`testcases salvaged from partial results — ${cases.length} case(s) recorded`);
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
    //
    // KNOWN GAP, deliberately not fixed here: "first wins" is positional, and
    // the position is phase order. In a group, an earlier member failing
    // ordinarily out-claims a later member that hit an account gate — the run
    // then retries the earlier phase straight back into the same gate. It takes
    // BOTH members failing on the same pass to reach, so nothing does it today,
    // and the fix is a precedence rule over every control kind (a stop nothing
    // can retry past should outrank a retry) rather than anything about account
    // gates. That belongs in its own change, with its own tests.
    const flow: Array<{ control: Control; from: string }> = [];
    const claim = (c: Control, from: string): void => {
      if (c.kind !== 'advance' && flow.length === 0) flow.push({ control: c, from });
    };

    for (const r of results) {
      // Verdicts the phase itself reported are read BEFORE its record is
      // written, so a case list that failed is a failed phase rather than a
      // successful one whose artifact happens to say otherwise.
      const caseFail = r.out.ok ? failedCases(r.cfg.name, r.out.data) : null;
      const phaseOk = r.out.ok && caseFail === null;
      const accountAction = phaseOk ? undefined : r.out.accountAction;

      recordPhase(iid, {
        phase: r.cfg.name,
        lap: r.lap,
        status: phaseOk ? 'ok' : statusForFailure(r.cfg, r.out.infra),
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        model: modelFor(r.cfg),
        turns: r.out.turns,
        weighted: r.out.weighted,
        sessionId: r.out.sessionId,
        // The notice ahead of r.out.error, which for an account-gate exit is
        // the SDK's bare "Claude Code process exited with code 1" — a string
        // that says nothing and reads like a wedged spawn. The record's status
        // is still 'infra' (there is no account-gate member on PhaseRecord, and
        // adding one means touching infraAttemptsOf, the dashboard and unblock
        // for no decision any of them make differently), so this text is the
        // only thing in the journal that tells the two apart.
        error: accountAction ?? r.out.error ?? r.out.blocked ?? caseFail ?? undefined,
      });
      j = readJournal(iid) ?? j;

      // Ahead of the rate-limit park below, and ahead of the infra re-attempt
      // in afterFailure: a park is recoverable by waiting and an account gate
      // never is, so whichever of the two is real, stopping on the gate is the
      // answer that does not cost a run.
      //
      // Honestly: the two flags cannot both be set today. `rateLimited` needs a
      // mid-stream frame naming a limit, and a CLI that hard-exits on an
      // account notice emits no frames at all — the stderr text is never fed to
      // the limit detector either, so it cannot cross-trigger. What makes the
      // order matter is the check above it, which now runs on every failure
      // path instead of only on a session that produced nothing. A phase that
      // streamed, hit a limit frame, and had a gate notice in its stderr is now
      // expressible, and without this it would park on the recoverable one.
      if (accountAction) {
        prior[r.cfg.name] = null;
        logEvent('account_action', {
          phase: r.cfg.name, lap: r.lap, notice: accountAction,
        }, { runId, phase: r.cfg.name });
        claim({
          kind: 'stop',
          status: 'blocked',
          reason: `${r.cfg.name}: ${accountActionReason(accountAction, iid)}`,
          // Nothing on this machine can accept a notice on the account's
          // behalf, so offering the stop to remediation only spends a heavy
          // session establishing that.
          noRemediation: true,
        }, r.cfg.name);
        continue;
      }

      if (r.out.rateLimited) {
        prior[r.cfg.name] = null;
        claim({
          kind: 'stop',
          status: 'blocked',
          reason: 'subscription usage limit — parked until the window resets',
        }, r.cfg.name);
        continue;
      }

      if (!phaseOk) {
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
          claim(
            afterFailure(
              r.cfg, r.index,
              caseFail ?? r.out.blocked ?? r.out.error ?? 'phase failed',
              // A recorded case failure is a verdict about the work, never an
              // infra death: the session ran to completion and said so.
              caseFail ? false : r.out.infra,
            ),
            r.cfg.name,
          );
        }
        continue;
      }

      prior[r.cfg.name] = r.out.data;
      // Research reproduced (or failed to reproduce) the reported bug on the
      // unfixed base branch. Only a complete not-reproduced verdict stops the
      // run — see src/conductor/reproduction.ts for why the bar is that high.
      // Evaluated only on a research that RAN this pass: a resumed run skips
      // research, which is how a person overrules Not a Bug (remove the label,
      // add the entry label back) without the run re-stopping itself.
      if (r.cfg.name === 'research' && bugReproductionEnabled()) {
        const decision = notABugDecision(r.out.data);
        if (!decision.stop && decision.note) log.warn(`research: ${decision.note}`);
        if (decision.stop) {
          const reason = await declareNotABug(iid, ticket.title, runId, decision.repro);
          claim({ kind: 'stop', status: 'aborted', reason, noRemediation: true }, r.cfg.name);
          continue;
        }
      }
      if (r.cfg.name === 'implement' && activeRound(j.mrFeedback)?.status === 'fixing') {
        const addressed = addressedFeedbackOf(r.out.data);
        if (addressed.length) {
          j = updateJournal(iid, { mrFeedback: recordAddressed(j.mrFeedback!, addressed) }) ?? j;
        }
      }
      if (isMilestone(r.cfg)) await thread(j.slackTs ?? null, milestoneText(r.cfg, r.out.data, iid));
    }

    await updateCard(j.slackTs ?? '', cardState(j));

    // Publish whatever is now ready. Reconciling here rather than inside a
    // phase means the plan reaches the ticket while it is still cheap to argue
    // with, and evidence reaches the MR as it is produced rather than in one
    // dump at the end of the run.
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
    i = nextIndex(control ?? { kind: 'advance' }, i, members[members.length - 1]!, list, forced);
  }

  return finish(j, 'done');

  // ------------------------------------------------------------- run helpers

  function shouldSkip(p: PhaseConfig): boolean {
    return !forced.has(p.name) && phaseSucceeded(iid, p.name);
  }

  /**
   * The app for this run, started in the background as soon as there is a
   * worktree to start it in.
   *
   * Called once per run — including on a resume, where the worktree arrives from
   * the journal and is never re-leased, which is why the guard is a flag and not
   * `!worktree`. Nothing waits on it: `scripts/app.cjs` holds a per-worktree lock,
   * so the first phase that calls `ensure` itself is handed the finished instance
   * or joins the bring-up already in flight.
   *
   * A port that cannot be leased is NOT a failure here. It only means this run
   * does not get its head start; the later `needsPort` lease reports the empty
   * pool exactly as it always did, and that message is the one worth keeping.
   */
  function bringUpApp(): void {
    if (appStarting || !worktree) return;
    const leased = port ?? leasePortFor(runId);
    if (leased === null) {
      log.info(`#${iid} — no free port to warm the app on; verify will lease one when it runs`);
      return;
    }
    if (port !== leased) {
      port = leased;
      j = updateJournal(iid, { port }) ?? j;
      updateRun(runId, { port });
    }
    appStarting = true;
    startRunApp({ iid, runId, worktree, port: leased });
  }

  /**
   * Leases, taken at the last possible moment — with one deliberate exception.
   *
   * The worktree comes with the first phase that needs a checkout. The PORT used
   * to come with the first phase that actually runs a server, because holding one
   * of three across research, plan and implement was hours of a scarce resource
   * for phases that never bound a socket. It is now taken WITH the worktree, and
   * the resource it buys is worth more than the one it spends: the dev server
   * compiles through those same hours instead of inside `verify`'s clock, where a
   * model was paying for it out of a turn budget. The pool is still the fleet's
   * real concurrency limit — this just means one run holds one port for its whole
   * life, which is what "one app per run" costs.
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
    if (p.cwd === 'worktree') bringUpApp();
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
    phaseEnd(rowId, out.ok ? 'ok' : statusForFailure(p, out.infra), {
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
    const status = codePhaseStatus(p, done);
    phaseEnd(rowId, status, { detail: done.error });

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
      status,
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
    if (done.feedback) {
      // Nothing of this run has landed on the base branch — the MR is still
      // opened — so holding the promotion window through triage and a possibly
      // hours-long implement→verify→mr lap only starves every other run on the
      // machine for no reason. The next merge entry re-acquires in queue order.
      releasePromotion(runId);
      return feedbackRound(index, done.feedback);
    }
    // A parked code phase (currently only the Review label's merge-readiness
    // check) bypasses the phase's own onFail policy entirely — 'merge' is
    // configured 'blocked', which is right for a genuine merge failure and
    // wrong for "waiting on an approval/pipeline", which is neither an error
    // nor something remediation should touch.
    if (done.park) {
      return { kind: 'stop', status: 'parked', reason: done.error ?? `${p.name}: parked` };
    }
    return afterFailure(p, index, done.error ?? 'phase failed');
  }

  /**
   * What a failed phase means for the index: an infra re-attempt if the phase
   * died rather than judged, and otherwise the onFail policy and nothing else.
   */
  function afterFailure(p: PhaseConfig, index: number, why: string, infra = false): Control {
    // A pause is a freeze, not a failure. No label swap, no alert, no lap
    // spent: the run stops where it stands and the same journal resumes it.
    if (existsSync(PAUSE)) {
      return { kind: 'stop', status: 'aborted', reason: 'paused mid-phase — resumes when unpaused' };
    }

    // An infra death gets re-attempted AS IT WAS, ahead of the onFail policy.
    // The policy answers "the work came back wrong, now what" — cycle to
    // implement, block, abort — and none of those answers fit a phase that was
    // cancelled or killed before it could produce any work to be wrong about.
    //
    // Past the cap the run BLOCKS. It used to fall through to the onFail
    // policy, which was worse than stopping: failedLapsOf() does not count
    // infra records, so a phase that kept hanging never used up maxLaps or
    // maxRetries, and every further death cycled back to implement — a lap
    // that cannot fix a dead connection — forever. Seen on #179: four verify
    // hangs, 12h, and implement re-run with nothing to change.
    if (infra && p.onFail !== 'skip' && p.onFail !== 'warn') {
      const spent = infraAttemptsOf(iid, p.name);
      if (spent <= MAX_INFRA_ATTEMPTS) {
        log.warn(`${p.name} died of infrastructure — re-attempting, no lap spent`, {
          attempt: spent, of: MAX_INFRA_ATTEMPTS, why: why.slice(0, 120),
        });
        return { kind: 'retry', at: index };
      }
      log.warn(`${p.name} died of infrastructure ${spent} times in a row — stopping the run`, {
        why: why.slice(0, 120),
      });
      return {
        kind: 'stop', status: 'blocked',
        reason: `${p.name}: ${why} — died of infrastructure ${spent} times in a row. A code change `
          + 'cannot fix that, so the run stops here instead of cycling: check the network, disk '
          + 'and quota, then unblock it',
      };
    }

    if (p.onFail === 'skip' || p.onFail === 'warn') {
      log.warn(`${p.name} failed but is non-fatal — continuing`, { why: why.slice(0, 120) });
      return { kind: 'advance' };
    }

    // Inside an MR review round's fix lap the retry and cycle budgets start
    // over: a review that failed twice before the MR opened has not spent the
    // budget for revising a reviewer's requested change.
    const round = activeRound(j.mrFeedback);
    const since = round?.status === 'fixing' ? round.startedAt : 0;
    const failed = failedLapsOf(iid, p.name, since);

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
   * One round of MR review feedback: triage the new threads, then either cycle
   * back to `implement` (something needs a code change — every phase up to
   * merge re-runs) or re-enter `merge` at once so it posts the replies (nothing
   * does). Rounds are counted on their own, not as failures, so review and
   * verify keep their full lap budgets inside a round.
   */
  async function feedbackRound(mergeIndex: number, signal: MrFeedbackSignal): Promise<Control> {
    // A stop or pause asked for during merge must not be spent on a triage session.
    if (opts.signal?.aborted) {
      return { kind: 'stop', status: 'aborted', reason: 'the conductor asked this run to stop' };
    }
    if (existsSync(PAUSE)) {
      return { kind: 'stop', status: 'aborted', reason: 'paused mid-phase — resumes when unpaused' };
    }

    const fcfg = mrFeedbackConfig();
    const ledger = j.mrFeedback ?? emptyLedger();

    if (roundsUsed(ledger) >= fcfg.maxRounds) {
      const reason = `mr-feedback: ${signal.threads.length} new review thread(s) on !${signal.mrIid} after `
        + `${fcfg.maxRounds} round(s) — a person takes the review from here`;
      if (j.reviewMode) {
        // A human already owns the merge on a Review run; wait for them rather than alarm.
        j = updateJournal(iid, { humanMergeCheckAt: Date.now() }) ?? j;
        return { kind: 'stop', status: 'parked', reason: `${reason}; still awaiting a human merge` };
      }
      return { kind: 'stop', status: 'blocked', reason, noRemediation: true };
    }

    const cfgT = list.find((q) => q.name === 'mr-feedback');
    if (!cfgT || !isImplemented(cfgT.name)) {
      return { kind: 'stop', status: 'blocked', reason: 'mr-feedback: the phase is missing from config/phases.json', noRemediation: true };
    }
    const leaseError = ensureLeases(cfgT);
    if (leaseError) return { kind: 'stop', status: 'blocked', reason: leaseError };
    const lap = lapsOf(iid, cfgT.name);
    const quota = checkQuota(runId, cfgT.name, lap);
    if (!quota.allowed) return { kind: 'stop', status: 'blocked', reason: `quota: ${quota.reason}` };

    const startedAt = Date.now();
    await updateCard(j.slackTs ?? '', cardState(j, [cfgT.name]));
    updateRun(runId, { phase: cfgT.name, status: 'running', owner_seen_at: Date.now() });

    const ctx: PromptCtx = {
      ticket, runId, lap, branch, worktree, port, prior, journal: j, mrThreads: signal,
    };
    const rowId = phaseStart(runId, cfgT.name, lap, modelFor(cfgT));
    const out = await runPhase({
      iid, runId, lap, cfg: cfgT,
      prompt: promptFor(cfgT, ctx),
      systemPrompt: systemPromptFor(cfgT, ctx),
      worktree, port, branch,
      signal: opts.signal,
    });
    phaseEnd(rowId, out.ok ? 'ok' : statusForFailure(cfgT, out.infra), {
      turns: out.turns, weighted: out.weighted, sessionId: out.sessionId,
      detail: out.error ?? out.blocked ?? undefined,
    });
    recordPhase(iid, {
      phase: cfgT.name, lap,
      status: out.ok ? 'ok' : statusForFailure(cfgT, out.infra),
      startedAt, endedAt: Date.now(), model: modelFor(cfgT),
      turns: out.turns, weighted: out.weighted, sessionId: out.sessionId,
      error: out.accountAction ?? out.error ?? out.blocked ?? undefined,
    });
    j = readJournal(iid) ?? j;
    await updateCard(j.slackTs ?? '', cardState(j));

    // The same stop the reconciler makes above, on the other runPhase() call
    // site: an account gate is not something re-triaging gets past, and this
    // path would otherwise spend the free infra re-attempts below on it.
    if (out.accountAction) {
      logEvent('account_action', {
        phase: cfgT.name, lap, notice: out.accountAction,
      }, { runId, phase: cfgT.name });
      return {
        kind: 'stop',
        status: 'blocked',
        reason: `${cfgT.name}: ${accountActionReason(out.accountAction, iid)}`,
        noRemediation: true,
      };
    }

    // Retrying at merge re-detects the same threads, so an infra death re-triages for free.
    if (!out.ok) return afterFailure(cfgT, mergeIndex, out.blocked ?? out.error ?? 'triage failed', out.infra);

    const items = normaliseItems(out.data, signal.threads);
    const next = startRound(ledger, { mrIid: signal.mrIid, threads: signal.threads, items, now: startedAt });
    j = updateJournal(iid, { mrFeedback: next }) ?? j;
    const round = activeRound(next)!;
    const fixes = items.filter((x) => x.disposition === 'fix').length;
    await thread(j.slackTs ?? null,
      `#${iid} — review round ${round.n} on !${signal.mrIid}: ${signal.threads.length} thread(s), `
      + `${fixes} to fix, ${items.length - fixes} to answer`);

    if (round.status === 'fixing') {
      const jumpTo = list.findIndex((q) => q.name === 'implement');
      if (jumpTo === -1) {
        return { kind: 'stop', status: 'blocked', reason: 'mr-feedback: implement is not in the phase list', noRemediation: true };
      }
      return { kind: 'cycle', jumpTo, windowEnd: mergeIndex };
    }
    return { kind: 'retry', at: mergeIndex };
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
    if (control.status !== 'blocked' || control.noRemediation) return null;

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
    phaseEnd(rowId, out.ok ? 'ok' : statusForFailure(cfgR, out.infra), {
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
      status: out.ok ? 'ok' : statusForFailure(cfgR, out.infra),
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

  async function finish(
    journal: RunJournal, status: 'done' | 'blocked' | 'aborted' | 'parked', reason?: string,
  ): Promise<RunOutcome> {
    journal.status = status;
    if (reason) journal.blockedWhy = reason;
    if (status === 'blocked') journal.blockedAt = Date.now();
    // Where it stopped, not only why. The last record that is not a success is
    // the phase a person needs to look at; a run that stopped between phases
    // (a yielded claim, a pause) has none, and says so rather than guessing.
    const lastBad = [...journal.phases].reverse()
      .find((p) => p.status !== 'ok' && p.status !== 'skipped' && p.status !== 'warned');
    journal.stoppedPhase = lastBad?.phase ?? journal.phases[journal.phases.length - 1]?.phase;
    journal.stoppedAt = Date.now();
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
        // The testcases board label comes off too: a blocked ticket still
        // reading 'TestCase Review' tells the board it is waiting on QA when it
        // is waiting on a person to unblock it. Parked keeps it — parked at the
        // gate is the state it marks — and done is only reached via approval.
        await swapLabel(journal.iid,
          withInReview(cfg, [cfg.labels.entry, cfg.labels.testcaseReview].filter(Boolean)),
          [cfg.labels.blocked]);
        await addIssueNote(journal.iid, `Oneshot stopped: **${reason}**\n\nRun \`${journal.runId}\`.`);
        // The stop note just posted names this run and lands AFTER the claim
        // note, so every conductor reading the ticket (lib/claims.ts) now counts
        // that claim dead. Deleting it is what keeps this desk agreeing with
        // them: the resume's by-id fast path near the top of this file asks only
        // whether the note still carries this run's marker — no stop note, no
        // staleness — so a surviving note would have the resume call the claim
        // live and never re-post, while every other desk reads the ticket as
        // unowned. The fast path stays that cheap only because this delete
        // holds; do not drop it without first teaching the fast path to read
        // stop notes.
        if (!DRY_RUN && journal.claimNoteId) {
          // A failed delete is not worth stopping for — the note reads dead to
          // everyone either way — but nothing else ever comes back for it, so
          // say so rather than orphan it on the ticket in silence.
          const del = await deleteIssueNote(journal.iid, journal.claimNoteId);
          if (!del.ok) {
            log.warn(`#${journal.iid} — claim note ${journal.claimNoteId} left on the ticket: ${del.error ?? del.kind}`);
          }
          journal.claimNoteId = undefined;
          writeJournal(journal);
        }
      }
      log.error(`■ #${journal.iid} BLOCKED — ${reason}`);
      logStopDetail(journal, 'BLOCKED');
    } else if (status === 'done') {
      // The blocked label goes too. A run that was blocked and later resumed —
      // past the cooldown, through --ticket, or after a person answered it —
      // still carries it, and finishing with both "Needs Human" and "merged" on
      // the ticket tells the board a person is wanted on work that is done.
      if (!DRY_RUN) {
        await swapLabel(journal.iid, withInReview(cfg, [cfg.labels.entry, cfg.labels.blocked]), [cfg.labels.exit]);
      }
      // The claim note has done its job — with the exit label on, nothing
      // scans this ticket again — and a claim that outlives its run is exactly
      // the stale note lib/claims.ts otherwise has to age out. 'blocked'
      // removes it too (above); an aborted or parked run expects to resume,
      // and its place in line is the note.
      if (!DRY_RUN && journal.claimNoteId) {
        const del = await deleteIssueNote(journal.iid, journal.claimNoteId);
        if (!del.ok) {
          log.warn(`#${journal.iid} — claim note ${journal.claimNoteId} left on the ticket: ${del.error ?? del.kind}`);
        }
        journal.claimNoteId = undefined;
        writeJournal(journal);
      }
      log.ok(`■ #${journal.iid} done`);
    } else {
      log.warn(`■ #${journal.iid} stopped — ${reason ?? 'aborted'}`);
      logStopDetail(journal, status === 'parked' ? 'PARKED' : 'ABORTED');
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
  return `*#${iid} ${p.name}* — ${data.summary ?? 'done'}`;
}

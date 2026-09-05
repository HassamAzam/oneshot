/**
 * The deterministic phases: `merge` (9) and `close` (15).
 *
 * These are plain TypeScript because no model should ever hold a merge tool.
 * That is the whole reason the guardrail hooks have nothing to say about
 * merging — there is no tool call to intercept, only this file.
 *
 * Both phases run UNCONDITIONALLY on every pass, including a resume after a
 * crash, so neither may assume it is running for the first time. They are
 * idempotent BY RECHECK rather than by API: GitLab is the source of truth, and
 * a journal claiming "merged" while GitLab says "opened" must lose. Every step
 * below either re-derives its answer from GitLab or carries a guard forward in
 * its own artifact.
 *
 * Two consequences worth stating, because both are easy to get wrong:
 *
 *   - `recordPhase` re-reads the journal from disk before writing it back, so a
 *     phase that mutates its in-memory `ctx.journal` loses the mutation. All
 *     journal persistence here goes through `updateJournal`.
 *   - `writeArtifact` overwrites. Anything that must survive a resume — the
 *     rebase cap, the "already announced in Slack" flag — is read back out of
 *     the previous artifact before the new one is written.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { DRY_RUN, WORK_REPO, deployConfig, phaseByName, projectConfig } from '../lib/config.js';
import {
  artifactsDirFor, readArtifact, readJournal, updateJournal, writeArtifact, type RunJournal,
} from '../lib/artifacts.js';
import { logEvent, updateRun } from '../lib/db.js';
import { log } from '../lib/log.js';
import { alert, thread } from '../lib/slack.js';
import { releasePort } from '../lib/worktrees.js';
import {
  acceptMergeRequest, addIssueNote, addMergeRequestNote, compareRefs, createMergeRequest,
  failedJobs, findMergeRequests, getBranch, getMergeRequest, issueNotes, mergeRefusal,
  mergeRequestUrl, mrDiscussions, projectSettings, rebaseMergeRequest, updateMergeRequest,
  type MergeRequest, type ProjectSettings,
} from '../lib/gitlab.js';
import type { CodePhaseCtx } from './runner.js';

const POLL_MS = 8_000;
const CI_POLL_MS = 15_000;
const MAX_REBASES = 2;
const MAX_STALE_RETRIES = 1;
const MAX_CONFLICT_PATHS = 20;
const MAX_DISCUSSIONS_QUOTED = 5;
const DISCUSSION_QUOTE_CHARS = 120;
const NETWORK_FAILS_TO_ABORT = 2;
const DRY_RUN_NOTE_ID = -1;

/**
 * How the phase's own wall clock is divided. `timeoutMin` in config/phases.json
 * is enforced only for session phases, so a code phase that does not police
 * itself has no deadline at all — and an unbounded poll against a stuck
 * pipeline would hold the promotion window open for the rest of the day.
 */
const CI_BUDGET_FRACTION = 0.60;
const MERGE_BUDGET_FRACTION = 0.72;
const PROMOTION_BUDGET_FRACTION = 0.95;

const TRANSIENT_STATUSES = new Set([
  'unchecked', 'checking', 'preparing', 'approvals_syncing',
]);
const TERMINAL_BAD_PIPELINE = new Set(['failed', 'canceled', 'canceling']);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

function short(sha: string | null): string {
  return sha ? sha.slice(0, 8) : 'unknown';
}

function fmtElapsed(ms: number): string {
  const m = Math.floor(ms / 60_000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ----------------------------------------------------------------- artifacts

type PromotionRecord = {
  from: string;
  to: string;
  status: 'merged' | 'already-contained' | 'skipped' | 'failed' | 'conflict' | 'timeout' | 'dry-run';
  mrIid: number | null;
  mrUrl: string | null;
  mergedSha: string | null;
  detail: string;
};

type MergeArtifact = {
  mrIid: number | null;
  mrUrl: string | null;
  sourceBranch: string | null;
  targetBranch: string | null;
  mergedSha: string | null;
  /**
   * The tip of the base branch once the merge landed. `mergedSha` says what was
   * merged; this says what `deploy` will actually ship, since the deploy script
   * takes the TIP of a branch rather than a sha. They diverge exactly when a
   * second run merged into the same base inside this run's window, which makes
   * the pair a permanent, one-line audit of the promotion mutex.
   */
  baseTipAfterMerge: string | null;
  mergeMethod: string | null;
  squashed: boolean;
  squashForcedBy: string | null;
  alreadyMerged: boolean;
  undrafted: boolean;
  rebaseCount: number;
  rebasedFrom: string | null;
  rebasedTo: string | null;
  waitedForCiMs: number;
  pipeline: { id: number; status: string; url: string } | null;
  promotion: PromotionRecord | null;
  promotionsSkipped: Array<{ from: string; to: string; detail: string }>;
  threadPosted: boolean;
  dryRun: boolean;
  wouldAccept: { mrIid: number; sha: string | null; squash: boolean; targetBranch: string } | null;
  blockedWhy: string | null;
  summary: string;
};

type CloseArtifact = {
  ticketNoteId: number | null;
  ticketNotePosted: boolean;
  slackThreadPosted: boolean;
  portReleased: boolean;
  memoryCardWritten: boolean;
  mrNoteAdded: boolean;
  failures: string[];
  summary: string;
};

function blankMerge(): MergeArtifact {
  return {
    mrIid: null, mrUrl: null, sourceBranch: null, targetBranch: null,
    mergedSha: null, baseTipAfterMerge: null, mergeMethod: null,
    squashed: false, squashForcedBy: null, alreadyMerged: false, undrafted: false,
    rebaseCount: 0, rebasedFrom: null, rebasedTo: null,
    waitedForCiMs: 0, pipeline: null,
    promotion: null, promotionsSkipped: [],
    threadPosted: false, dryRun: false, wouldAccept: null,
    blockedWhy: null, summary: '',
  };
}

function sField(o: Record<string, unknown> | null, key: string): string | null {
  const v = o?.[key];
  return typeof v === 'string' && v !== '' ? v : null;
}

function aField(o: Record<string, unknown> | null, key: string): unknown[] {
  const v = o?.[key];
  return Array.isArray(v) ? v : [];
}

/** A prior phase's output, from memory if the runner has it and from disk otherwise. */
function artifactOf(
  ctx: CodePhaseCtx, phase: string, file = `${phase}.json`,
): Record<string, unknown> | null {
  const inMemory = ctx.prior[phase];
  if (inMemory) return inMemory;
  return readArtifact<Record<string, unknown>>(ctx.iid, file);
}

// ------------------------------------------------------------ conflict detail

/**
 * The conflicted paths between two remote refs, computed locally.
 *
 * GitLab exposes no endpoint for this and `merge_error` is one sentence that is
 * frequently null, so without it a BLOCKED message tells a human only that
 * something conflicts, and they have to reproduce the merge themselves to find
 * out where. Both commands are read-only, neither runs inside a leased
 * worktree, and any failure returns an empty list — a missing conflict list
 * must never be mistaken for "no conflict".
 */
function conflictingPaths(base: string, branch: string): string[] {
  try {
    execFileSync('git', ['-C', WORK_REPO, 'fetch', '--no-tags', 'origin', base, branch], {
      timeout: 120_000, stdio: 'ignore',
    });
    execFileSync('git', [
      '-C', WORK_REPO, 'merge-tree', '--write-tree', '--name-only',
      `origin/${base}`, `origin/${branch}`,
    ], { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
    return [];
  } catch (err) {
    // A conflicted merge-tree exits non-zero and prints the tree oid on the
    // first line, then the conflicted paths, then a blank line.
    const out = (err as { stdout?: unknown }).stdout;
    if (typeof out !== 'string') return [];
    const paths: string[] = [];
    for (const line of out.split('\n').slice(1)) {
      if (!line.trim()) break;
      paths.push(line.trim());
    }
    return paths.slice(0, MAX_CONFLICT_PATHS);
  }
}

// ---------------------------------------------------------------- phase 9
// merge

type Action =
  | { kind: 'accept' }
  | { kind: 'wait'; why: string }
  | { kind: 'ci'; wait: boolean }
  | { kind: 'rebase' }
  | { kind: 'undraft' }
  | { kind: 'conflict' }
  | { kind: 'discussions' }
  | { kind: 'block'; why: string };

/**
 * Classify a merge request's mergeability into one action.
 *
 * An unrecognised status BLOCKS rather than falling through to "assume
 * mergeable". A status this code has never seen is precisely the case where
 * guessing merges something it should not.
 */
function mergeabilityAction(mr: MergeRequest): Action {
  // An MR with no head sha has nothing to merge — its source branch is missing
  // on the remote or carries no commits. GitLab reports that state with
  // has_conflicts:true, so it MUST be classified before the conflict check or a
  // branch that was never pushed is reported as a merge conflict, which sends
  // whoever reads it looking for conflicting files that do not exist.
  if (!mr.sha) {
    return {
      kind: 'block',
      why: `!${mr.iid} has no head commit — source branch '${mr.source_branch}' is missing on `
        + 'the remote or carries no commits. This is NOT a conflict: nothing was pushed. '
        + 'Check whether the branch reached origin before looking for conflicting files.',
    };
  }
  if (mr.has_conflicts || mr.merge_status === 'cannot_be_merged') return { kind: 'conflict' };
  const status = mr.detailed_merge_status;
  if (!status) return legacyAction(mr);

  switch (status) {
    case 'mergeable': return { kind: 'accept' };
    case 'conflict': return { kind: 'conflict' };
    case 'need_rebase': return { kind: 'rebase' };
    case 'draft_status': return { kind: 'undraft' };
    case 'ci_still_running': return { kind: 'ci', wait: true };
    case 'ci_must_pass': return { kind: 'ci', wait: false };
    case 'discussions_not_resolved': return { kind: 'discussions' };
    default:
      if (TRANSIENT_STATUSES.has(status)) return { kind: 'wait', why: status };
      return { kind: 'block', why: `GitLab reports detailed_merge_status '${status}'` };
  }
}

/** Pre-15.6 GitLab, where only merge_status and has_conflicts exist. */
function legacyAction(mr: MergeRequest): Action {
  if (mr.draft) return { kind: 'undraft' };
  if (mr.merge_status === 'can_be_merged') return { kind: 'accept' };
  return { kind: 'wait', why: mr.merge_status };
}

function conflictMessage(mr: MergeRequest, base: string): string {
  const paths = conflictingPaths(base, mr.source_branch);
  const where = paths.length ? ` Conflicting paths: ${paths.join(', ')}.` : '';
  // Only assert a conflict when something actually evidences one — GitLab's own
  // merge_error, or conflicting paths we resolved ourselves. With neither, say
  // that the reason is unknown rather than inventing "X conflicts with Y": a
  // fabricated diagnosis reads exactly like a real one and is acted on as such.
  const why = mr.merge_error
    ?? (paths.length
      ? `'${mr.source_branch}' conflicts with '${base}'`
      : `GitLab reports it unmergeable but supplied no merge_error, and no conflicting paths `
        + `were found against '${base}' — the cause is undetermined`);
  return `!${mr.iid} cannot be merged: ${why}.${where} Resolve it on ${mr.web_url}`;
}

async function discussionsMessage(mr: MergeRequest): Promise<string> {
  const res = await mrDiscussions(mr.iid);
  const open = (res.data ?? [])
    .flatMap((d) => d.notes.filter((n) => n.resolvable && !n.resolved));
  const quoted = open.slice(0, MAX_DISCUSSIONS_QUOTED)
    .map((n) => `${n.author.username}: ${n.body.replace(/\s+/g, ' ').slice(0, DISCUSSION_QUOTE_CHARS)}`)
    .join(' | ');
  return `!${mr.iid} has ${open.length} unresolved discussion(s) — someone commented on this ` +
    `merge request, which is a human signal by definition.${quoted ? ` ${quoted}` : ''} ${mr.web_url}`;
}

async function ciMessage(mr: MergeRequest): Promise<string> {
  const pipe = mr.head_pipeline;
  if (!pipe) return `!${mr.iid} requires a passing pipeline and has none. ${mr.web_url}`;
  const jobs = await failedJobs(pipe.id);
  const names = (jobs.data ?? []).map((j) => `${j.stage}/${j.name}`);
  return `CI for !${mr.iid} is '${pipe.status}'` +
    `${names.length ? ` — failed: ${names.join(', ')}` : ''}. ${pipe.web_url}`;
}

function mergeCommitMessage(ctx: CodePhaseCtx, title: string, mr: MergeRequest): string {
  return `Merge branch '${mr.source_branch}' into '${mr.target_branch}'\n\n` +
    `${title} (#${ctx.iid})\n\nOneshot run ${ctx.runId}\nCloses #${ctx.iid}`;
}

type AcceptOutcome =
  | { kind: 'merged'; mr: MergeRequest }
  | { kind: 'accepted' }
  | { kind: 'retry-sha' }
  | { kind: 'retry-squash' }
  | { kind: 'blocked'; why: string };

/**
 * One accept attempt, with the refusal classified into something actionable.
 *
 * `sha` is passed deliberately: it pins the merge to the head this phase
 * actually evaluated, so a branch that moved while CI ran fails with a 409
 * rather than merging a head nothing reviewed.
 */
async function attemptAccept(
  ctx: CodePhaseCtx, title: string, mr: MergeRequest, squash: boolean,
): Promise<AcceptOutcome> {
  if (!mr.sha) {
    return {
      kind: 'blocked',
      why: `GitLab reports no head sha for !${mr.iid} — refusing to merge a head it cannot name`,
    };
  }

  const res = await acceptMergeRequest(mr.iid, {
    sha: mr.sha,
    squash,
    removeSourceBranch: false,
    mergeCommitMessage: mergeCommitMessage(ctx, title, mr),
  });
  if (res.ok) {
    return res.data?.state === 'merged' ? { kind: 'merged', mr: res.data } : { kind: 'accepted' };
  }

  switch (mergeRefusal(res)) {
    case 'sha-stale':
      return { kind: 'retry-sha' };
    case 'squash-policy':
      return { kind: 'retry-squash' };
    case 'not-mergeable': {
      const after = await getMergeRequest(mr.iid);
      if (after.ok && after.data?.state === 'merged') return { kind: 'merged', mr: after.data };
      return {
        kind: 'blocked',
        why: `!${mr.iid} was refused: ${after.data?.merge_error ?? res.error ?? 'not mergeable'}. ${mr.web_url}`,
      };
    }
    case 'auth':
      return {
        kind: 'blocked',
        why: `GITLAB_TOKEN may not merge into '${mr.target_branch}'. Merging a protected ` +
          'branch through the API requires the token to be an allowed MERGER, which is a ' +
          'different permission from push — a one-time project setting, not a ticket problem.',
      };
    case 'network':
      return {
        kind: 'blocked',
        why: `GitLab became unreachable while merging !${mr.iid} — resume with ` +
          `'npm start -- --ticket ${ctx.iid}' once it answers again`,
      };
    default:
      return {
        kind: 'blocked',
        why: `merging !${mr.iid} failed with ${res.status}: ${res.error ?? res.kind}`,
      };
  }
}

/**
 * Drive one merge request from wherever it is to `state === 'merged'`.
 *
 * The loop re-reads GitLab on every pass rather than trusting what it did last
 * pass, which is what makes a crash mid-accept recoverable: the resumed run
 * observes `merged` and completes without ever issuing a second accept.
 */
async function driveToMerged(
  ctx: CodePhaseCtx,
  title: string,
  mrIid: number,
  rec: MergeArtifact,
  base: string,
  policy: ProjectSettings | null,
  deadlines: { ci: number; merge: number },
): Promise<{ ok: true; mr: MergeRequest } | { ok: false; error: string }> {
  let squash = policy?.squash_option === 'always';
  let accepted = false;
  let awaitingRebase = false;
  let netFails = 0;
  let staleRetries = 0;
  let ciWaitStartedAt = 0;
  let lastStatus = 'unknown';

  for (;;) {
    // Checked BEFORE the call, never after: `call()` carries its own 30s abort,
    // so a single hung request would otherwise overshoot the budget by half a
    // minute and eat the promotion window.
    if (Date.now() >= (accepted ? deadlines.merge : deadlines.ci)) {
      return {
        ok: false,
        error: accepted
          ? `!${mrIid} was accepted but GitLab has not reported it merged — check ${mergeRequestUrl(mrIid)}`
          : `!${mrIid} did not become mergeable in time — last status '${lastStatus}', see ${mergeRequestUrl(mrIid)}`,
      };
    }

    const read = await getMergeRequest(mrIid, { rebaseProgress: awaitingRebase });
    if (!read.ok || !read.data) {
      if (read.kind === 'network' || read.kind === 'server') {
        netFails += 1;
        if (netFails >= NETWORK_FAILS_TO_ABORT) {
          return {
            ok: false,
            error: `GitLab is unreachable (${read.error ?? read.kind}) — resume with ` +
              `'npm start -- --ticket ${ctx.iid}' once the tunnel is back`,
          };
        }
        await sleep(POLL_MS);
        continue;
      }
      return { ok: false, error: `cannot read !${mrIid}: ${read.error ?? read.kind}` };
    }
    netFails = 0;

    const mr = read.data;
    lastStatus = mr.detailed_merge_status ?? mr.merge_status;
    if (mr.head_pipeline) {
      rec.pipeline = {
        id: mr.head_pipeline.id, status: mr.head_pipeline.status, url: mr.head_pipeline.web_url,
      };
    }

    if (mr.state === 'merged') return { ok: true, mr };
    if (mr.state === 'closed') {
      return { ok: false, error: `!${mrIid} was closed without merging — a human closed it. ${mr.web_url}` };
    }
    if (accepted || mr.state === 'locked') {
      await sleep(POLL_MS);
      continue;
    }

    if (awaitingRebase) {
      if (mr.rebase_in_progress) {
        await sleep(POLL_MS);
        continue;
      }
      awaitingRebase = false;
      rec.rebasedTo = mr.sha;
      if (mr.merge_error) {
        return { ok: false, error: `the rebase of !${mrIid} failed: ${mr.merge_error}. ${mr.web_url}` };
      }
      continue;
    }

    const action = mergeabilityAction(mr);
    switch (action.kind) {
      case 'accept': {
        const attempt = await attemptAccept(ctx, title, mr, squash);
        if (attempt.kind === 'merged') {
          rec.squashed = squash;
          return { ok: true, mr: attempt.mr };
        }
        if (attempt.kind === 'blocked') return { ok: false, error: attempt.why };
        if (attempt.kind === 'accepted') {
          accepted = true;
          rec.squashed = squash;
          await sleep(POLL_MS);
          break;
        }
        if (attempt.kind === 'retry-squash') {
          if (squash) {
            return { ok: false, error: `!${mrIid} was refused over squash policy with squash already on` };
          }
          squash = true;
          rec.squashForcedBy = 'project policy (squash_option)';
          break;
        }
        staleRetries += 1;
        if (staleRetries > MAX_STALE_RETRIES) {
          return {
            ok: false,
            error: `the head of '${mr.source_branch}' keeps moving under the merge of ` +
              `!${mrIid} — someone is pushing to it. ${mr.web_url}`,
          };
        }
        break;
      }

      case 'rebase': {
        if (rec.rebaseCount >= MAX_REBASES) {
          return {
            ok: false,
            error: `!${mrIid} still needs a rebase after ${rec.rebaseCount} attempts — ` +
              `a rebase rewrites the branch, so this run stops rather than keep rewriting it. ${mr.web_url}`,
          };
        }
        const probe = await getMergeRequest(mrIid, { rebaseProgress: true });
        if (probe.ok && probe.data?.rebase_in_progress) {
          awaitingRebase = true;
          await sleep(POLL_MS);
          break;
        }
        rec.rebasedFrom = mr.sha;
        rec.rebaseCount += 1;
        const res = await rebaseMergeRequest(mrIid);
        if (!res.ok && mergeRefusal(res) !== 'rebase-running') {
          return { ok: false, error: `rebasing !${mrIid} failed: ${res.error ?? res.kind}` };
        }
        awaitingRebase = true;
        await sleep(POLL_MS);
        break;
      }

      case 'undraft': {
        if (rec.undrafted) {
          return { ok: false, error: `!${mrIid} is still a draft after its title was cleaned. ${mr.web_url}` };
        }
        const stripped = mr.title.replace(/^\s*(draft:|wip:)\s*/i, '');
        if (stripped === mr.title) {
          return {
            ok: false,
            error: `GitLab reports !${mrIid} is a draft but its title carries no Draft: prefix. ${mr.web_url}`,
          };
        }
        const res = await updateMergeRequest(mrIid, { title: stripped });
        if (!res.ok) {
          return { ok: false, error: `could not clear the draft flag on !${mrIid}: ${res.error ?? res.kind}` };
        }
        rec.undrafted = true;
        break;
      }

      case 'ci': {
        const pipe = mr.head_pipeline;
        if (!action.wait || (pipe && TERMINAL_BAD_PIPELINE.has(pipe.status))) {
          return { ok: false, error: await ciMessage(mr) };
        }
        if (!ciWaitStartedAt) ciWaitStartedAt = Date.now();
        await sleep(CI_POLL_MS);
        rec.waitedForCiMs = Date.now() - ciWaitStartedAt;
        break;
      }

      case 'conflict':
        return { ok: false, error: conflictMessage(mr, base) };

      case 'discussions':
        return { ok: false, error: await discussionsMessage(mr) };

      case 'wait':
        await sleep(POLL_MS);
        break;

      case 'block':
        return { ok: false, error: `${action.why} — !${mrIid} ${mr.web_url}` };
    }
  }
}

// -------------------------------------------------------------- promotion

function promotionDescription(ctx: CodePhaseCtx, rec: MergeArtifact, from: string, to: string): string {
  return `Automatic promotion of \`${from}\` into \`${to}\`.\n\n` +
    `Opened by Oneshot run \`${ctx.runId}\` after merging ` +
    `${rec.mrUrl ?? `!${rec.mrIid ?? '?'}`} for ${ctx.journal.url}.\n\n` +
    'This merge request is reused rather than recreated: while it stays open, every ticket ' +
    `that merges into \`${from}\` promotes through it.`;
}

/** Reuse an open promotion MR before opening one — two tickets share one by design. */
async function promotionMr(
  ctx: CodePhaseCtx, rec: MergeArtifact, from: string, to: string, r: PromotionRecord,
): Promise<MergeRequest | null> {
  const open = await findMergeRequests({ sourceBranch: from, targetBranch: to, state: 'opened' });
  const existing = open.ok ? open.data?.[0] ?? null : null;
  if (existing) return existing;

  const created = await createMergeRequest({
    sourceBranch: from,
    targetBranch: to,
    title: `Promote ${from} → ${to}`,
    description: promotionDescription(ctx, rec, from, to),
    removeSourceBranch: false,
  });
  if (created.ok && created.data) return created.data;

  // Another process opened it between the search and the create.
  if (mergeRefusal(created) === 'duplicate-mr') {
    const again = await findMergeRequests({ sourceBranch: from, targetBranch: to, state: 'opened' });
    const found = again.ok ? again.data?.[0] ?? null : null;
    if (found) return found;
  }

  r.detail = `could not open the ${from} → ${to} merge request: ${created.error ?? created.kind}`;
  return null;
}

async function acceptPromotion(
  mrIid: number, r: PromotionRecord, deadline: number,
): Promise<PromotionRecord> {
  for (;;) {
    if (Date.now() >= deadline) {
      r.status = 'timeout';
      r.detail = `!${mrIid} was still open when the merge phase ran out of time`;
      return r;
    }

    const read = await getMergeRequest(mrIid);
    if (!read.ok || !read.data) {
      r.detail = `cannot read !${mrIid}: ${read.error ?? read.kind}`;
      return r;
    }
    const mr = read.data;

    if (mr.state === 'merged') {
      r.status = 'merged';
      r.mergedSha = mr.merge_commit_sha ?? mr.sha;
      r.detail = '';
      return r;
    }
    if (mr.state === 'closed') {
      r.detail = `!${mrIid} was closed without merging`;
      return r;
    }

    const action = mergeabilityAction(mr);
    if (action.kind === 'conflict') {
      r.status = 'conflict';
      r.detail = `${r.from} and ${r.to} have diverged: ` +
        `${mr.merge_error ?? 'the promotion branch conflicts'} — every later run hits this ` +
        'until a human resolves it';
      return r;
    }
    if (action.kind === 'accept') {
      if (!mr.sha) {
        r.detail = `GitLab reports no head sha for !${mrIid}`;
        return r;
      }
      // squash is false unconditionally: collapsing a whole base branch into
      // one commit on the target is the one place squash is purely destructive.
      const res = await acceptMergeRequest(mrIid, {
        sha: mr.sha, squash: false, removeSourceBranch: false,
      });
      if (!res.ok && mergeRefusal(res) !== 'sha-stale') {
        r.detail = `merging !${mrIid} failed with ${res.status}: ${res.error ?? res.kind}`;
        return r;
      }
      await sleep(POLL_MS);
      continue;
    }
    if (action.kind === 'wait' || (action.kind === 'ci' && action.wait)) {
      await sleep(POLL_MS);
      continue;
    }

    r.detail = `!${mrIid} is not mergeable: ${mr.detailed_merge_status ?? mr.merge_status}`;
    return r;
  }
}

async function promote(
  ctx: CodePhaseCtx, rec: MergeArtifact, from: string, to: string, deadline: number,
): Promise<PromotionRecord> {
  const r: PromotionRecord = {
    from, to, status: 'failed', mrIid: null, mrUrl: null, mergedSha: null, detail: '',
  };

  // Containment, not sha equality: the target may legitimately be AHEAD of the
  // source, and equality would then report work to promote for ever.
  const cmp = await compareRefs(to, from, true);
  if (!cmp.ok || !cmp.data) {
    r.detail = `could not compare ${to} with ${from}: ${cmp.error ?? cmp.kind}`;
    return r;
  }
  if (cmp.data.commits === 0) {
    r.status = 'already-contained';
    r.detail = `${to} already contains every commit of ${from}`;
    return r;
  }

  if (DRY_RUN) {
    r.status = 'dry-run';
    r.detail = `${cmp.data.commits} commit(s) would be promoted (${cmp.data.shas.join(', ')})`;
    return r;
  }

  const mr = await promotionMr(ctx, rec, from, to, r);
  if (!mr) return r;
  r.mrIid = mr.iid;
  r.mrUrl = mr.web_url;
  return acceptPromotion(mr.iid, r, deadline);
}

/**
 * Run the promotions config/project.json marks automatic.
 *
 * Read as data rather than hardcoded, because the entry a human owns
 * (`auto: false`) has to be skipped by the same loop that runs the automatic
 * one — that is what keeps "production release stays a human act" true when
 * somebody adds a hop.
 */
async function runPromotions(
  ctx: CodePhaseCtx, rec: MergeArtifact, deadline: number,
): Promise<void> {
  const cfg = projectConfig();
  rec.promotionsSkipped = [];
  for (const p of cfg.promotions) {
    if (!p.auto) {
      rec.promotionsSkipped.push({
        from: p.from, to: p.to, detail: 'auto:false — a human owns this hop',
      });
      continue;
    }
    if (p.from !== cfg.branches.base) {
      rec.promotionsSkipped.push({
        from: p.from, to: p.to, detail: `not this run's base branch (${cfg.branches.base})`,
      });
      continue;
    }
    rec.promotion = await promote(ctx, rec, p.from, p.to, deadline);
  }
}

function promotionLine(rec: MergeArtifact): string {
  const p = rec.promotion;
  if (!p) return 'no automatic promotion applies to this base.';
  switch (p.status) {
    case 'merged': return `${p.from} → ${p.to} promoted via !${p.mrIid}.`;
    case 'already-contained': return `${p.to} already contains ${p.from}.`;
    case 'dry-run': return `[dry-run] ${p.from} → ${p.to} not attempted.`;
    default: return `${p.from} → ${p.to} promotion ${p.status} — ${p.detail}`;
  }
}

/**
 * A promotion failure warns; it never fails the phase.
 *
 * The demo server ships the base branch, so nothing downstream of here — the
 * deploy, the QA pass, the demo — depends on the target of the promotion. The
 * cost of blocking would be a merged, working, deployable ticket parked as
 * Needs Human over branch plumbing. But silence would be worse than either: the
 * run ends with a green card, so the failure has to be visible somewhere.
 */
async function announceMerge(ctx: CodePhaseCtx, rec: MergeArtifact): Promise<void> {
  if (rec.threadPosted) return;
  const ts = (readJournal(ctx.iid) ?? ctx.journal).slackTs ?? null;
  await thread(ts, `*#${ctx.iid} merge* — ${rec.summary}`);
  if (rec.promotion?.status === 'conflict') {
    await alert(
      `#${ctx.iid} — ${rec.promotion.from} → ${rec.promotion.to} promotion is CONFLICTED. ` +
      'This is a standing breakage: every run from now on hits it. ' +
      `${rec.promotion.mrUrl ?? ''}`,
    );
  }
  rec.threadPosted = true;
}

// ------------------------------------------------------------------ phase 9

function persistMerge(ctx: CodePhaseCtx, rec: MergeArtifact): void {
  writeArtifact(ctx.iid, 'merge.json', rec);
  ctx.prior.merge = rec;
}

function failMerge(
  ctx: CodePhaseCtx, rec: MergeArtifact, error: string,
): { ok: false; error: string } {
  rec.blockedWhy = error;
  if (!rec.summary) rec.summary = `merge stopped: ${error}`;
  persistMerge(ctx, rec);
  log.error(`merge: ${error}`);
  return { ok: false, error };
}

function mergeSummary(rec: MergeArtifact): string {
  if (rec.dryRun) {
    return `[dry-run] !${rec.mrIid} would merge into ${rec.targetBranch}; ${promotionLine(rec)}`;
  }
  const verb = rec.alreadyMerged ? 'was already merged' : 'merged';
  return `!${rec.mrIid} ${verb} into ${rec.targetBranch} as ${short(rec.mergedSha)}; ` +
    promotionLine(rec);
}

/**
 * Resolve which merge request this run is merging.
 *
 * Three sources because the first two can both be gone: `mr.json` deleted by
 * hand, or a resume after the MR phase's artifact write failed. The branch name
 * is deterministic, so it remains an anchor when nothing else survived.
 */
async function resolveMrIid(ctx: CodePhaseCtx, journal: RunJournal): Promise<number | null> {
  const fromPhase = (ctx.prior.mr as { mrIid?: unknown } | null | undefined)?.mrIid;
  if (typeof fromPhase === 'number') return fromPhase;
  if (typeof journal.mrIid === 'number') return journal.mrIid;

  const branch = journal.branch;
  if (!branch) return null;
  const res = await findMergeRequests({ sourceBranch: branch, state: 'all' });
  if (!res.ok || !res.data?.length) return null;
  const merged = res.data.find((m) => m.state === 'merged');
  const opened = res.data.find((m) => m.state === 'opened');
  return (merged ?? opened ?? res.data[0])?.iid ?? null;
}

/**
 * What the run's own check phases concluded, re-read here rather than trusted
 * from their phase status.
 *
 * `verify` and `review` can both finish with status ok while their ARTIFACT
 * says the change is not ready: a verify salvaged from partial results records
 * ok no matter how many cases failed, and a review records ok while returning
 * verdict 'changes-requested'. Phase status answers "did the phase run", not
 * "did the change pass", and merge was reading the first as if it were the
 * second — so a branch with failing cases and unaddressed blockers reached the
 * accept call with nothing in the way.
 *
 * This is the same shape the deploy phase already uses: the conductor re-derives
 * the fact itself and overrules the phase rather than believing its verdict.
 */
function qualityGate(iid: number): string | null {
  const verify = readArtifact<{ results?: Array<{ id?: string; result?: string }> }>(iid, 'verify.json');
  const results = verify?.results ?? [];
  const failed = results.filter((r) => r.result === 'fail');
  if (failed.length) {
    const ids = failed.map((r) => r.id ?? '?').join(', ');
    const other = results.filter((r) => r.result === 'blocked' || r.result === 'skipped').length;
    const tail = other ? ` (${other} further case(s) blocked or never run)` : '';
    return `verify recorded ${failed.length} failing case(s) of ${results.length}: ${ids}${tail}. `
      + 'Refusing to merge a change its own test cases do not pass.';
  }

  const review = readArtifact<{
    verdict?: string; findings?: Array<{ id?: string; severity?: string }>;
  }>(iid, 'findings.json');
  const unaddressed = (review?.findings ?? [])
    .filter((f) => f.severity === 'blocker' || f.severity === 'major');
  if (review?.verdict === 'changes-requested' || unaddressed.length) {
    const ids = unaddressed.map((f) => `${f.id ?? '?'} [${f.severity}]`).join(', ') || 'none listed';
    return `review returned verdict '${review?.verdict ?? 'unknown'}' with ${unaddressed.length} `
      + `blocker/major finding(s): ${ids}. Refusing to merge over an unaddressed review.`;
  }

  return null;
}

/**
 * The Review label's merge gate: required approvals and a green pipeline,
 * checked BEFORE this phase drives the MR to merged. Pure code, deterministic,
 * no model — consistent with why `merge` is a code phase at all (docs/HOOKS.md
 * §1: no model holds a merge tool, so no hook is needed to stop one merging).
 *
 * `park: true` distinguishes "not ready yet, try again" from a real failure:
 * missing approvals and a pipeline still running are both ordinary, expected
 * states for a fresh MR that the next tick's re-check resolves on its own. A
 * definitively failed/cancelled pipeline is not something re-checking fixes,
 * so that one is a genuine block instead.
 */
function reviewMergeReadiness(mr: MergeRequest): { ready: boolean; park: boolean; why: string } {
  if (mr.detailed_merge_status === 'not_approved') {
    return {
      ready: false, park: true,
      why: `!${mr.iid} is missing required approvals — this ticket carries Review, so Oneshot ` +
        'waits for them rather than merging without a human sign-off.',
    };
  }

  const pipe = mr.head_pipeline;
  if (!pipe) {
    return {
      ready: false, park: true,
      why: `!${mr.iid} has no pipeline yet — this ticket carries Review, so Oneshot waits for ` +
        'one to run and pass before merging.',
    };
  }
  if (TERMINAL_BAD_PIPELINE.has(pipe.status)) {
    return {
      ready: false, park: false,
      why: `!${mr.iid}'s pipeline is '${pipe.status}' — this ticket carries Review and requires ` +
        `a green pipeline before merging. ${pipe.web_url}`,
    };
  }
  if (pipe.status !== 'success') {
    // Anything short of 'success' that is not one of the terminal-bad
    // statuses above is presumed still on its way there (running, pending,
    // scheduled, or a status this code has not seen) — park and let the
    // next tick re-read it rather than guess.
    return {
      ready: false, park: true,
      why: `!${mr.iid}'s pipeline is '${pipe.status}' — this ticket carries Review, so Oneshot ` +
        'waits for it to finish before merging.',
    };
  }

  return { ready: true, park: false, why: '' };
}

export async function mergePhase(
  ctx: CodePhaseCtx,
): Promise<{ ok: boolean; error?: string; park?: boolean }> {
  const cfg = projectConfig();
  const base = cfg.branches.base;
  const budgetMs = (phaseByName('merge')?.timeoutMin ?? 10) * 60_000;
  const t0 = Date.now();
  const deadlines = {
    ci: t0 + budgetMs * CI_BUDGET_FRACTION,
    merge: t0 + budgetMs * MERGE_BUDGET_FRACTION,
    promotion: t0 + budgetMs * PROMOTION_BUDGET_FRACTION,
  };

  const journal = readJournal(ctx.iid) ?? ctx.journal;
  // The rebase cap and the Slack guard are the two facts that must outlive an
  // overwrite of merge.json, so they are read back before the new one is built.
  const carried = readArtifact<MergeArtifact>(ctx.iid, 'merge.json');
  const rec = blankMerge();
  rec.rebaseCount = carried?.rebaseCount ?? 0;
  rec.threadPosted = carried?.threadPosted === true;
  rec.promotion = carried?.promotion ?? null;

  const gate = qualityGate(ctx.iid);
  if (gate !== null) return failMerge(ctx, rec, gate);

  const mrIid = await resolveMrIid(ctx, journal);
  if (mrIid === null) {
    return failMerge(ctx, rec,
      `no merge request found for branch '${journal.branch ?? '(none recorded)'}' — did the mr phase run?`);
  }

  // Persisted before anything is attempted: a crash during the accept must
  // still leave the iid recoverable without another search.
  rec.mrIid = mrIid;
  rec.mrUrl = mergeRequestUrl(mrIid);
  updateJournal(ctx.iid, { mrIid, mrUrl: rec.mrUrl });
  updateRun(ctx.runId, { mr_iid: mrIid });

  const settings = await projectSettings();
  const policy = settings.ok ? settings.data : null;
  rec.mergeMethod = policy?.merge_method ?? null;

  const first = await getMergeRequest(mrIid);
  if (!first.ok || !first.data) {
    return failMerge(ctx, rec, `cannot read !${mrIid}: ${first.error ?? first.kind}`);
  }
  rec.sourceBranch = first.data.source_branch;
  rec.targetBranch = first.data.target_branch;
  rec.alreadyMerged = first.data.state === 'merged';

  if (ctx.journal.reviewMode && !rec.alreadyMerged && !DRY_RUN) {
    const gate = reviewMergeReadiness(first.data);
    if (!gate.ready) {
      if (gate.park) {
        rec.summary = `[Review] parked: ${gate.why}`;
        persistMerge(ctx, rec);
        log.warn(`merge: parked awaiting Review gate — ${gate.why}`);
        return { ok: false, error: gate.why, park: true };
      }
      return failMerge(ctx, rec, gate.why);
    }
  }

  if (DRY_RUN) {
    // Every write below is a guarded no-op, so polling for a merged state that
    // can never arrive would burn the entire budget. Decide, record, stop.
    rec.dryRun = true;
    rec.wouldAccept = {
      mrIid,
      sha: first.data.sha,
      squash: policy?.squash_option === 'always',
      targetBranch: first.data.target_branch,
    };
  } else {
    const drive = await driveToMerged(
      ctx, journal.title, mrIid, rec, base, policy, deadlines,
    );
    if (!drive.ok) return failMerge(ctx, rec, drive.error);

    // Which field holds the merged commit depends on the merge method: a merge
    // commit for 'merge', the squash commit when squashed, and neither under
    // fast-forward — where the merged commit IS the merge request's head.
    const mergedSha = drive.mr.merge_commit_sha ?? drive.mr.squash_commit_sha ?? drive.mr.sha;
    rec.mergedSha = mergedSha;
    if (mergedSha) updateJournal(ctx.iid, { mergedSha });

    const tip = await getBranch(base);
    rec.baseTipAfterMerge = tip.ok && tip.data ? tip.data.commit.id : null;
  }

  await runPromotions(ctx, rec, deadlines.promotion);
  rec.summary = mergeSummary(rec);
  await announceMerge(ctx, rec);
  persistMerge(ctx, rec);
  log.ok(`merge: ${rec.summary}`);
  return { ok: true };
}

// ----------------------------------------------------------------- phase 15
// close

const ABSENT = '_not produced (phase warned)_';

async function step(rec: CloseArtifact, what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const why = (err as Error).message;
    rec.failures.push(`${what}: ${why}`);
    log.warn(`close: ${what} failed`, { error: why.slice(0, 160) });
  }
}

function artifactCount(iid: number): number {
  try {
    return readdirSync(artifactsDirFor(iid)).length;
  } catch {
    return 0;
  }
}

function qaLine(qa: Record<string, unknown> | null): string {
  if (!qa) return ABSENT;
  const results = aField(qa, 'results') as Array<{ result?: unknown }>;
  const tally = (name: string): number => results.filter((r) => r?.result === name).length;
  const parts = [`${tally('pass')}/${results.length} pass`];
  if (tally('fail')) parts.push(`${tally('fail')} failed`);
  if (tally('blocked')) parts.push(`${tally('blocked')} blocked`);
  if (tally('skipped')) parts.push(`${tally('skipped')} skipped`);
  return `${parts.join(', ')} — verdict: ${sField(qa, 'verdict') ?? 'unknown'}`;
}

function evidenceLine(
  ui: Record<string, unknown> | null, demo: Record<string, unknown> | null,
): string {
  if (!ui && !demo) return ABSENT;
  const shots = aField(ui, 'screenshots').length;
  const files = (aField(demo, 'files') as unknown[]).filter((f) => typeof f === 'string');
  return `${shots} screenshot${shots === 1 ? '' : 's'}` +
    `${files.length ? `, ${files.join(', ')}` : ''}`;
}

function phasesLine(journal: RunJournal): string {
  const laps = journal.phases.filter((p) => p.phase === 'implement').length;
  const weighted = journal.phases.reduce((a, p) => a + (p.weighted ?? 0), 0);
  return `${journal.phases.length} phase runs, ${laps} lap${laps === 1 ? '' : 's'} on implement` +
    ` · ${fmtElapsed(Date.now() - journal.createdAt)}` +
    ` · ${(weighted / 1e6).toFixed(1)}M weighted`;
}

/**
 * The run's one durable, human-readable record on the ticket.
 *
 * Absent sections are stated rather than omitted. `demo`, `document` and
 * `memorize` are all allowed to warn, so their artifacts are legitimately
 * missing sometimes — and a blank line reads as "nobody looked", while a stated
 * absence is information.
 */
function renderCloseNote(ctx: CodePhaseCtx, journal: RunJournal): string {
  const merge = artifactOf(ctx, 'merge');
  const qa = artifactOf(ctx, 'qa');
  const testcases = artifactOf(ctx, 'testcases');
  const review = artifactOf(ctx, 'review', 'findings.json');
  const ui = artifactOf(ctx, 'ui-evidence');
  const demo = artifactOf(ctx, 'demo');
  const memorize = artifactOf(ctx, 'memorize');

  const mergedSha = journal.mergedSha ?? sField(merge, 'mergedSha');
  const mrLine = journal.mrIid
    ? `!${journal.mrIid} — merged into \`${sField(merge, 'targetBranch') ?? projectConfig().branches.base}\`` +
      ` as \`${short(mergedSha)}\`${journal.mrUrl ? ` · ${journal.mrUrl}` : ''}`
    : ABSENT;

  const promotion = (merge?.promotion ?? null) as PromotionRecord | null;
  const promotionLineText = promotion
    ? `${promotion.from} → ${promotion.to}: ${promotion.status}` +
      `${promotion.detail ? ` — ${promotion.detail}` : ''}`
    : ABSENT;

  const deployedSha = journal.deployedSha ?? sField(artifactOf(ctx, 'deploy'), 'deployedSha');
  const cases = aField(testcases, 'cases') as Array<{ blast?: unknown }>;
  const highBlast = cases.filter((c) => c?.blast === 'high').length;
  const findings = aField(review, 'findings');
  const card = sField(memorize, 'card');

  return `## Oneshot run \`${ctx.runId}\` — complete

**MR** ${mrLine}
**Promotion** ${promotionLineText}
**Demo** ${deployConfig().demoUrl} on \`${short(deployedSha)}\`
**QA** ${qaLine(qa)}
**Test cases** ${testcases ? `${cases.length} authored (${highBlast} high blast)` : ABSENT}
**Review** ${review ? `${sField(review, 'verdict') ?? 'unknown'}, ${findings.length} findings` : ABSENT}
**Evidence** ${evidenceLine(ui, demo)} in \`${artifactsDirFor(ctx.iid)}\`
**Memory card** ${card ?? ABSENT}
**Phases** ${phasesLine(journal)}
<!-- oneshot:close:${ctx.runId} -->`;
}

/**
 * Phase 15. Records the run and lets go of what it holds.
 *
 * This phase NEVER returns ok:false. A false here would block a ticket whose
 * code is merged, deployed and QA-passed, swap it to Needs Human and make the
 * watcher skip it for ever — the worst outcome available on the last phase of a
 * successful run, and far worse than an inaccurate exit code. Failures are
 * collected into `failures[]` and said out loud instead.
 *
 * What it deliberately does NOT do: swap the label, re-render the Slack card,
 * delete the branch, close the issue, or touch the run's artifacts. The label
 * swap and the teardown belong to `finish()`, the branch is pushed work, and
 * the exit label — not a closed issue — is the run's contract.
 */
export async function closePhase(ctx: CodePhaseCtx): Promise<{ ok: boolean; error?: string }> {
  const journal = readJournal(ctx.iid) ?? ctx.journal;
  const carried = readArtifact<CloseArtifact>(ctx.iid, 'close.json');
  const memorize = artifactOf(ctx, 'memorize');
  const document = artifactOf(ctx, 'document');

  const rec: CloseArtifact = {
    ticketNoteId: journal.closeNoteId ?? carried?.ticketNoteId ?? null,
    ticketNotePosted:
      typeof journal.closeNoteId === 'number' || carried?.ticketNotePosted === true,
    slackThreadPosted: carried?.slackThreadPosted === true,
    portReleased: false,
    memoryCardWritten: sField(memorize, 'card') !== null,
    mrNoteAdded: carried?.mrNoteAdded === true,
    failures: [],
    summary: '',
  };

  await step(rec, 'final ticket note', async () => {
    if (rec.ticketNotePosted) return;
    // The journal flag is checked first because this scan is bounded to the
    // most recent 100 comments — on a long-lived ticket the marker can fall off
    // the end, and a second copy of this note would be the result.
    const marker = `<!-- oneshot:close:${ctx.runId} -->`;
    const notes = await issueNotes(ctx.iid);
    if (notes.ok && notes.data?.some((n) => n.body.includes(marker))) {
      rec.ticketNotePosted = true;
      return;
    }
    const res = await addIssueNote(ctx.iid, renderCloseNote(ctx, journal));
    if (!res.ok) throw new Error(res.error ?? res.kind);
    rec.ticketNoteId = res.data?.id ?? DRY_RUN_NOTE_ID;
    rec.ticketNotePosted = true;
    updateJournal(ctx.iid, { closeNoteId: rec.ticketNoteId });
  });

  await step(rec, 'slack thread', async () => {
    if (rec.slackThreadPosted) return;
    const qa = artifactOf(ctx, 'qa');
    await thread(journal.slackTs ?? null,
      `*#${ctx.iid} complete* — ${sField(artifactOf(ctx, 'merge'), 'summary') ?? 'merged'}\n` +
      `QA: ${qaLine(qa)}\n` +
      `Demo: ${deployConfig().demoUrl}\n` +
      `Artifacts: ${artifactsDirFor(ctx.iid)} (${artifactCount(ctx.iid)} files)`);
    rec.slackThreadPosted = true;
  });

  await step(rec, 'port release', async () => {
    // Unconditional, and not redundant with finish(): finish() reaps the port
    // only through reapWorktree, which it skips when the worktree directory is
    // already gone. That leaks one port per incident out of a pool of three,
    // and a drained pool kills every future run at its first worktree phase.
    releasePort(ctx.runId);
    rec.portReleased = true;
  });

  await step(rec, 'ledger backfill', async () => {
    if (typeof journal.mrIid === 'number') updateRun(ctx.runId, { mr_iid: journal.mrIid });
    // Appended, not deduped: a resume writing a second completion row is honest
    // history in a ledger, and hiding it would be the actual lie.
    logEvent('run_complete', {
      mrIid: journal.mrIid ?? null,
      mergedSha: journal.mergedSha ?? null,
      deployedSha: journal.deployedSha ?? null,
      qaVerdict: sField(artifactOf(ctx, 'qa'), 'verdict'),
      memoryCardWritten: rec.memoryCardWritten,
    }, { runId: ctx.runId });
  });

  await step(rec, 'merge request note', async () => {
    // The document phase owns the MR note. This fills in only when it warned.
    if (document || rec.mrNoteAdded || typeof journal.mrIid !== 'number') return;
    const res = await addMergeRequestNote(journal.mrIid,
      `Oneshot run \`${ctx.runId}\` — QA ${qaLine(artifactOf(ctx, 'qa'))}\n\n` +
      `Demo: ${deployConfig().demoUrl}\nTicket: ${journal.url}`);
    rec.mrNoteAdded = res.ok;
  });

  rec.summary = `Run complete: ${sField(artifactOf(ctx, 'merge'), 'summary') ?? 'merge not recorded'}` +
    `${rec.memoryCardWritten ? '' : ' No memory card was written.'}` +
    `${rec.failures.length ? ` ${rec.failures.length} close step(s) failed.` : ''}`;

  writeArtifact(ctx.iid, 'close.json', rec);
  ctx.prior.close = rec;
  log.ok(`close: ${rec.summary}`);
  return { ok: true };
}

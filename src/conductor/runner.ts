/**
 * Drive one ticket through the phase graph.
 *
 * This is the orchestrator, and it is deliberately plain TypeScript. It does
 * not think — it schedules, validates, retries and reaps. An LLM runs only
 * inside a phase. Three things fall out of that: there is no conductor context
 * to clear between tickets, control flow can be single-stepped, and the token
 * spend goes to the work rather than to an orchestrator re-reading its own
 * state.
 */
import { existsSync } from 'node:fs';
import {
  DRY_RUN, phases, projectConfig, type PhaseConfig,
} from '../lib/config.js';
import {
  ensureRunDirs, lapsOf, phaseSucceeded, readArtifact, readJournal,
  recordPhase, reapScratch, updateJournal, writeJournal, type RunJournal,
} from '../lib/artifacts.js';
import { branchFor, newRunId, worktreeName } from '../lib/ids.js';
import { leaseWorktree, reapWorktree } from '../lib/worktrees.js';
import { addIssueNote, getIssue, issueNotes, issueUrl, swapLabel, type Issue } from '../lib/gitlab.js';
import { checkQuota } from '../lib/quota.js';
import { createRun, isClaimed, logEvent, updateRun } from '../lib/db.js';
import { postCard, thread, updateCard, alert, type CardState, type PhaseLine } from '../lib/slack.js';
import { log } from '../lib/log.js';
import { runPhase } from './phase.js';
import { isImplemented, promptFor, systemPromptFor, type PromptCtx } from '../phases/prompts.js';
import type { Ticket } from '../phases/types.js';

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
 * Deterministic phases — merge, deploy, close. TypeScript, never a model.
 *
 * Registered here rather than assumed: an unregistered name stops the run. The
 * alternative (treat 'code' as "nothing to do") would let a run skip the merge
 * and the deploy and still finish labelled Ready For Deployment.
 *
 * M4/M5 populate this map.
 */
export const CODE_PHASES: Record<
  string,
  ((ctx: CodePhaseCtx) => Promise<{ ok: boolean; error?: string }>) | undefined
> = {};

function cardLines(j: RunJournal, current: string | null): PhaseLine[] {
  return phases()
    .filter((p) => isImplemented(p.name) || p.kind === 'code')
    .map((p): PhaseLine => {
      const recs = j.phases.filter((r) => r.phase === p.name);
      const last = recs[recs.length - 1];
      if (p.name === current) return { phase: p.name, state: 'running' };
      if (!last) return { phase: p.name, state: 'pending' };
      if (last.status === 'ok' || last.status === 'warned') {
        return { phase: p.name, state: 'done', detail: recs.length > 1 ? `${recs.length} laps` : undefined };
      }
      if (last.status === 'skipped') return { phase: p.name, state: 'skipped' };
      return { phase: p.name, state: 'failed' };
    });
}

function cardState(j: RunJournal, current: string | null): CardState {
  return {
    iid: j.iid,
    title: j.title,
    url: j.url,
    lines: cardLines(j, current),
    elapsedMs: Date.now() - j.createdAt,
    weighted: j.phases.reduce((a, p) => a + (p.weighted ?? 0), 0),
    status: j.status,
    blockedWhy: j.blockedWhy,
  };
}

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
    // research prompt's budget before it has read a line of code.
    notes: notes.ok && notes.data
      ? notes.data.map((n) => n.body).filter((b) => b && !b.startsWith('assigned to')).slice(-25)
      : [],
  };
}

/**
 * Run one ticket. Resumable: an existing journal means this is a RESUMPTION,
 * and phases that already succeeded are skipped rather than re-paid for.
 */
export async function runTicket(issue: Issue): Promise<RunOutcome> {
  const cfg = projectConfig();
  const iid = issue.iid;

  // Claim here, not in the watcher. --ticket dispatches straight to runTicket,
  // so a guard living only in the scan path is a guard that is not there on the
  // path most likely to be used for a manual re-run.
  const existing = readJournal(iid);
  const ours = existing?.status === 'running';
  if (!ours && isClaimed(iid)) {
    log.warn(`#${iid} is already claimed by an in-flight run — refusing`);
    return { runId: '', iid, status: 'aborted', reason: 'already claimed' };
  }

  let j = existing;
  const resuming = j !== null && j.status === 'running';
  const runId = resuming && j ? j.runId : newRunId();

  if (!j || !resuming) {
    j = {
      runId,
      iid,
      title: issue.title,
      url: issueUrl(iid),
      createdAt: Date.now(),
      status: 'running',
      phases: [],
    };
    ensureRunDirs(iid);
    writeJournal(j);
    createRun(runId, iid, issue.title);
    log.banner(`▶ #${iid} ${issue.title}`);
  } else {
    log.banner(`▶ #${iid} ${issue.title}  (resuming ${runId})`);
  }

  const ticket = await fetchTicket(iid);
  if (!ticket) {
    return finish(j, 'aborted', 'could not read the ticket from GitLab');
  }

  // The Slack card is posted once and edited in place for the rest of the run.
  if (!j.slackTs) {
    const ts = await postCard(cardState(j, null));
    if (ts) { j.slackTs = ts; writeJournal(j); updateRun(runId, { slack_ts: ts }); }
  }

  // Once per run, not once per resumption.
  if (!DRY_RUN && !resuming) {
    await addIssueNote(iid, `Oneshot claimed this ticket — run \`${runId}\`.`);
  }

  // Worktree is leased lazily: phases 0-3 do not need one, and leasing early
  // would hold a port through 40 minutes of research for nothing.
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

  for (const phase of phases()) {
    // A phase with no implementation STOPS the run — including 'code' phases.
    // Skipping them would let a run reach the end without merging or deploying
    // and still be labelled Ready For Deployment, which is the worst possible
    // failure mode: silent success on work that never happened.
    if (!isImplemented(phase.name) && !CODE_PHASES[phase.name]) {
      log.warn(`phase '${phase.name}' is not implemented yet — stopping here`);
      return finish(j, 'blocked',
        `not built yet: phase '${phase.name}'. Implemented so far: ` +
        `${phases().filter((p) => isImplemented(p.name) || CODE_PHASES[p.name]).map((p) => p.name).join(' → ')}`);
    }

    if (CODE_PHASES[phase.name]) {
      const done = await CODE_PHASES[phase.name]!({ iid, runId, journal: j, prior });
      recordPhase(iid, {
        phase: phase.name, lap: 0, status: done.ok ? 'ok' : 'failed',
        startedAt: Date.now(), endedAt: Date.now(), error: done.error,
      });
      j = readJournal(iid) ?? j;
      if (!done.ok) return finish(j, 'blocked', `${phase.name}: ${done.error}`);
      await updateCard(j.slackTs ?? '', cardState(j, null));
      continue;
    }

    if (phaseSucceeded(iid, phase.name)) {
      prior[phase.name] = readArtifact(iid, phase.artifact ?? `${phase.name}.json`);
      log.info(`skip ${phase.name} — already succeeded this run`);
      continue;
    }

    const quota = checkQuota(runId, phase.name);
    if (!quota.allowed) {
      return finish(j, 'blocked', `quota: ${quota.reason}`);
    }

    if (phase.cwd === 'worktree' && !worktree) {
      try {
        const lease = leaseWorktree(runId, branch, worktreeName(iid, runId));
        worktree = lease.worktree;
        port = lease.port;
        j = updateJournal(iid, { worktree, port, branch: lease.branch }) ?? j;
        updateRun(runId, { worktree, port, branch: lease.branch });
      } catch (err) {
        return finish(j, 'blocked', `worktree: ${(err as Error).message}`);
      }
    }

    const lap = lapsOf(iid, phase.name);
    await updateCard(j.slackTs ?? '', cardState(j, phase.name));
    updateRun(runId, { phase: phase.name, status: 'running' });

    const ctx: PromptCtx = { ticket, runId, lap, branch, worktree, port, prior };
    const started = Date.now();
    const out = await runPhase({
      iid, runId, lap, cfg: phase,
      prompt: promptFor(phase, ctx),
      systemPrompt: systemPromptFor(phase, ctx),
      worktree, port,
    });

    recordPhase(iid, {
      phase: phase.name,
      lap,
      status: out.ok ? 'ok' : (out.blocked ? 'failed' : 'failed'),
      startedAt: started,
      endedAt: Date.now(),
      model: undefined,
      turns: out.turns,
      weighted: out.weighted,
      sessionId: out.sessionId,
      error: out.error ?? out.blocked ?? undefined,
    });
    j = readJournal(iid) ?? j;

    if (out.rateLimited) {
      return finish(j, 'blocked', 'subscription usage limit — parked until the window resets');
    }

    if (!out.ok) {
      const why = out.blocked ?? out.error ?? 'phase failed';
      if (phase.onFail === 'skip' || phase.onFail === 'warn') {
        log.warn(`${phase.name} failed but is non-fatal — continuing`, { why: why.slice(0, 120) });
        prior[phase.name] = null;
        continue;
      }
      return finish(j, 'blocked', `${phase.name}: ${why}`);
    }

    prior[phase.name] = out.data;

    if (isMilestone(phase)) {
      await thread(j.slackTs ?? null, milestoneText(phase, out.data, iid));
    }
    await updateCard(j.slackTs ?? '', cardState(j, null));
  }

  return finish(j, 'done');

  async function finish(
    journal: RunJournal, status: 'done' | 'blocked' | 'aborted', reason?: string,
  ): Promise<RunOutcome> {
    journal.status = status;
    if (reason) journal.blockedWhy = reason;
    writeJournal(journal);
    updateRun(journal.runId, { status, ended_at: Date.now(), blocked_why: reason ?? null });
    logEvent('run_finished', { status, reason }, { runId: journal.runId });

    await updateCard(journal.slackTs ?? '', cardState(journal, null));

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
    }

    // Teardown. The worktree and scratch go; the journal, artifacts and
    // transcripts stay — those are the run's value.
    reapScratch(journal.iid);
    if (journal.worktree && existsSync(journal.worktree) && status !== 'blocked') {
      reapWorktree(journal.worktree, journal.runId);
    }

    return { runId: journal.runId, iid: journal.iid, status, reason };
  }
}

function isMilestone(p: PhaseConfig): boolean {
  return ['plan', 'testcases', 'review', 'verify', 'mr', 'qa'].includes(p.name);
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

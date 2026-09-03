/**
 * The run journal: `state/runs/<iid>/`.
 *
 * This is the handoff medium between phases and the reason runs are replayable.
 * A phase receives the ARTIFACTS of earlier phases — never their transcripts —
 * so context grows in kilobytes rather than conversation turns, and re-entering
 * a run at phase 11 costs nothing for phases 0-10.
 *
 * Layout:
 *   state/runs/<iid>/run.json         the journal (phases, laps, outcomes)
 *   state/runs/<iid>/<phase>.json     one phase's structured output
 *   state/runs/<iid>/artifacts/       screenshots, mp4, reports
 *   state/runs/<iid>/transcripts/     per-phase JSONL — the content record
 *   state/runs/<iid>/scratch/         reaped on teardown
 *
 * A ticket has ONE run directory, keyed by iid rather than by run id, because
 * that is what makes resumption a lookup instead of a search. A ticket that
 * comes back for a second run therefore has its finished directory moved aside
 * (`archiveRun`) rather than merged into — two runs' phase records in one
 * journal would make every lap counter and every resume check lie.
 */
import {
  cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { STATE, artifactDir, runDir } from './config.js';

const RUNS_ARCHIVE = join(STATE, 'runs-archive');

export interface PhaseRecord {
  phase: string;
  lap: number;
  status: 'ok' | 'failed' | 'skipped' | 'refused' | 'warned';
  startedAt: number;
  endedAt: number;
  model?: string;
  turns?: number;
  weighted?: number;
  sessionId?: string;
  error?: string;
}

/**
 * One conductor-side attempt at clearing a block without a person.
 *
 * Kept on the journal rather than only in an artifact because it is HISTORY,
 * not a handoff: the artifact is overwritten by the next attempt, and the two
 * facts that matter later — how many attempts this run has already spent, and
 * whether it has already tried this exact block — are counts over the whole
 * run. It is also the record of what was changed OUTSIDE the worktree, which
 * is the part nothing else in this system would otherwise remember.
 */
export interface Remediation {
  /** The phase whose failure was about to end the run. */
  phase: string;
  /** The blocked reason, verbatim — the dedupe key, with `phase`. */
  reason: string;
  category: string;
  fixed: boolean;
  /** Every change made, precise enough to undo by hand. */
  changes: string[];
  at: number;
}

/**
 * One review gate's state — the opt-in `Review` label's pause points.
 *
 * Slack is the primary approval channel (see src/conductor/reviewgate.ts):
 * `requestTs` is the "since" marker, and it names a Slack message now rather
 * than a GitLab note. Null means the run still owes a fresh request in the
 * ticket's Slack thread (armed the next time the gate is checked); non-null
 * means a request is standing there and the gate is polling
 * `conversations.replies` for a human reply newer than this ts. `feedback`
 * accumulates every non-`approved` reply, oldest first, uncapped — the whole
 * point is no limit on how many rounds a reviewer gets. GitLab receives only
 * an audit note once a round is actually approved; it is never where the
 * decision is read from.
 */
export interface ReviewGateState {
  requestTs: string | null;
  approved: boolean;
  feedback: string[];
}

export interface RunJournal {
  runId: string;
  iid: number;
  title: string;
  url: string;
  createdAt: number;
  /**
   * 'parked' is an opt-in-only, human-caused wait — the Review label's three
   * pause points (plan approval, merge readiness, qa approval) and nothing
   * else ever produces it. Unlike 'blocked' it swaps no label and alerts
   * nobody: the ticket keeps carrying the entry label throughout, so the next
   * tick's scan re-claims it and re-checks for a reply exactly like an
   * ordinary resumption. See src/conductor/reviewgate.ts.
   */
  status: 'running' | 'blocked' | 'done' | 'aborted' | 'parked';
  /**
   * True when the ticket carried the `Review` label the last time its
   * labels were read (at the top of `runTicket`). Read by the pure-code
   * `merge` phase, which has no ticket object of its own, to decide whether
   * to apply the approvals/pipeline pre-check. Re-derived every run (fresh
   * and resumed), so adding or removing the label between conductor restarts
   * takes effect on the next claim.
   */
  reviewMode?: boolean;
  /** Plan-approval gate state (Review label, between `plan` and `implement`). */
  planApproval?: ReviewGateState;
  /** QA-approval gate state (Review label, between `qa` and `demo`). */
  qaApproval?: ReviewGateState;
  branch?: string;
  worktree?: string;
  port?: number;
  mrIid?: number;
  mrUrl?: string;
  mergedSha?: string;
  deployedSha?: string;
  blockedWhy?: string;
  /**
   * When the run was blocked. A block is a request for a human, so a resume
   * that ignores it just burns the same budget on the same failure — the
   * conductor honours a cooldown against this stamp before it re-claims.
   */
  blockedAt?: number;
  /** The closing note on the ticket, so a re-run of `close` edits instead of repeating. */
  closeNoteId?: number;
  /** Publication keys already posted to GitLab — see lib/publish.ts. */
  published?: string[];
  slackTs?: string;
  phases: PhaseRecord[];
  /** Blocks this run diagnosed and tried to clear by itself, oldest first. */
  remediations?: Remediation[];
}

function journalPath(iid: number): string {
  return join(runDir(iid), 'run.json');
}

export function ensureRunDirs(iid: number): void {
  for (const d of ['', 'artifacts', 'transcripts', 'scratch']) {
    mkdirSync(d ? join(runDir(iid), d) : runDir(iid), { recursive: true });
  }
}

export function readJournal(iid: number): RunJournal | null {
  const p = journalPath(iid);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as RunJournal;
  } catch {
    return null;
  }
}

export function writeJournal(j: RunJournal): void {
  ensureRunDirs(j.iid);
  writeFileSync(journalPath(j.iid), `${JSON.stringify(j, null, 2)}\n`);
}

export function updateJournal(iid: number, patch: Partial<RunJournal>): RunJournal | null {
  const j = readJournal(iid);
  if (!j) return null;
  Object.assign(j, patch);
  writeJournal(j);
  return j;
}

export function recordPhase(iid: number, rec: PhaseRecord): void {
  const j = readJournal(iid);
  if (!j) return;
  j.phases.push(rec);
  writeJournal(j);
}

/**
 * Append a remediation attempt, whatever it concluded.
 *
 * A refused or useless attempt is recorded exactly like a successful one: the
 * budget was spent either way, and an attempt that is not on the journal is an
 * attempt the run is free to repeat.
 */
export function recordRemediation(iid: number, rec: Remediation): void {
  const j = readJournal(iid);
  if (!j) return;
  j.remediations = [...(j.remediations ?? []), rec];
  writeJournal(j);
}

/** How many times a phase has already run in this run — the lap counter. */
export function lapsOf(iid: number, phase: string): number {
  const j = readJournal(iid);
  if (!j) return 0;
  return j.phases.filter((p) => p.phase === phase).length;
}

/**
 * How many laps of a phase actually FAILED.
 *
 * Distinct from lapsOf: retry and cycle budgets are spent by failures, and a
 * phase that ran three times because an earlier phase cycled back to it has not
 * spent any of its own. Counting all laps would strand a run that was doing
 * exactly what it was told to.
 */
export function failedLapsOf(iid: number, phase: string): number {
  const j = readJournal(iid);
  if (!j) return 0;
  return j.phases.filter((p) => p.phase === phase && p.status === 'failed').length;
}

/** True if the phase completed successfully at any lap — the resume check. */
export function phaseSucceeded(iid: number, phase: string): boolean {
  const j = readJournal(iid);
  if (!j) return false;
  return j.phases.some((p) => p.phase === phase && (p.status === 'ok' || p.status === 'warned'));
}

/**
 * Move a finished run's directory to state/runs-archive/<iid>-<runId>.
 *
 * Called when a ticket carrying a COMPLETED journal is claimed again — a
 * re-labelled ticket is a new run, not a continuation of the one that already
 * shipped. Nothing is deleted: the previous run's journal, artifacts and
 * transcripts are the record of what was delivered last time, and the recall
 * phase is not the only thing that may want to read them.
 */
export function archiveRun(iid: number, runId: string): string | null {
  const from = runDir(iid);
  if (!existsSync(from)) return null;
  mkdirSync(RUNS_ARCHIVE, { recursive: true });

  let to = join(RUNS_ARCHIVE, `${iid}-${runId}`);
  if (existsSync(to)) to = `${to}-${Date.now().toString(36)}`;

  try {
    renameSync(from, to);
  } catch {
    // Rename fails across filesystems, which state/ on an external volume is.
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
  return to;
}

// ------------------------------------------------------------------ artifacts

export function artifactPath(iid: number, name: string): string {
  return join(runDir(iid), name);
}

export function writeArtifact(iid: number, name: string, data: unknown): string {
  ensureRunDirs(iid);
  const p = artifactPath(iid, name);
  writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`);
  return p;
}

export function readArtifact<T = unknown>(iid: number, name: string): T | null {
  const p = artifactPath(iid, name);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function transcriptPath(iid: number, phase: string, lap: number): string {
  ensureRunDirs(iid);
  return join(runDir(iid), 'transcripts', `${phase}-lap${lap}.jsonl`);
}

export function artifactsDirFor(iid: number): string {
  ensureRunDirs(iid);
  return artifactDir(iid);
}

/**
 * Teardown. Removes only what is regenerable.
 *
 * Deliberately KEPT: the journal (what happened), phase artifacts (the
 * decisions), transcripts (the content record), and artifacts/ (screenshots,
 * video). Those are the run's value; scratch is not.
 */
export function reapScratch(iid: number): void {
  try {
    rmSync(join(runDir(iid), 'scratch'), { recursive: true, force: true });
  } catch { /* already gone */ }
}

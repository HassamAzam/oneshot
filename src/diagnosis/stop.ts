/**
 * Which stops get a diagnosis, and how one stop is told from the next.
 *
 * A diagnosis is a model session, and the thing it watches is re-examined once
 * a minute: a blocked ticket sits blocked for days, and a run parked at a gate
 * is re-claimed on every conductor tick only to be put back. So "the run is
 * stopped" cannot be what starts a session. What starts one is a stop this run
 * has not had before, and everything here is about recognising that cheaply and
 * the same way every time.
 *
 * The key is the stop's CONTENT: the run, its status, the phase it stopped at,
 * the reason it gave and the kinds of trouble still standing on its record. Not
 * a timestamp, and not a count of phase records, because both move while
 * nothing happens. The runner rewrites `stoppedAt` whenever it re-parks a run,
 * and before it learned to step over a settled code phase a parked run gained a
 * record per tick (ticket 9174: 59 `mr-open` laps). A run that is unblocked and
 * blocks again for the same reason has the same key, and is not diagnosed
 * twice: the first answer still holds.
 *
 * A park is diagnosed only when something is still wrong behind it. A clean run
 * waiting for its plan to be approved has nothing to explain, and the gate's
 * own note already says what it is waiting for. So has a run whose review asked
 * for changes once and then passed: that is the pipeline working. And a park is
 * not diagnosed a second time for trouble an earlier diagnosis of the same run
 * already covered, however the wait is worded. With `reviewAllRuns` every run
 * ends parked for a person's merge, so anything looser than this is a session
 * and a comment on every healthy ticket.
 *
 * A stop that is a usage or budget limit is never diagnosed: it explains
 * itself, and it clears on its own.
 *
 * The caps are the last line, for whatever this missed: a run is diagnosed a
 * few times at most, never twice in quick succession, a session that keeps
 * dying is given up on, and no run starts more sessions than those two allow.
 */
import { createHash } from 'node:crypto';
import { envFlag, envOr } from '../lib/config.js';
import type { PhaseRecord, RunJournal } from '../lib/artifacts.js';
import type { DiagnosisFile } from './types.js';

/** Sessions this feature runs itself: never evidence about the run, and never trouble. */
export const OWN_PHASES = ['diagnose', 'fix-author', 'fix-review', 'fix-verify'] as const;
export const isOwnPhase = (phase: string): boolean => (OWN_PHASES as readonly string[]).includes(phase);

/** A code phase is one deterministic step; this many records of one means it is being re-run for nothing. */
export const CODE_REPEATS = 5;
export const SESSION_REPEATS = 6;

/**
 * Whether a journal record is the phase having RUN.
 *
 * `parked` is a poll that found a person had not acted yet (one `merge` record
 * every half hour for as long as a merge request waits), and `skipped` is a
 * phase stepped over. Neither is an attempt, so neither counts toward a phase
 * "repeating", and neither says how the phase last went.
 */
export function countsAsRun(status: string): boolean {
  return status !== 'parked' && status !== 'skipped';
}

const CANCELLED_RE = /cancelled by the conductor/;
/**
 * The conductor's record of a failure a person has since settled: verify's
 * failing case, once QA has ruled on it, is re-recorded `warned` with these
 * words (src/conductor/runner.ts). It is on the journal as history, not as
 * something still wrong, and stop.test.ts holds this wording to the runner's.
 */
export const RESOLVED_RE = /^resolved by /;

/**
 * Whether a record is the conductor's own verdict on a session it has already
 * recorded: the same phase, lap and session, written a second time with the
 * verdict's status and words (a review that finished and asked for changes; a
 * verify failure a gate resolved). It is one run of the phase, not two, and
 * its time and tokens are the first record's over again.
 */
export function isRerecord(prev: PhaseRecord | undefined, r: PhaseRecord): boolean {
  return !!prev && !!r.sessionId && prev.phase === r.phase && prev.lap === r.lap && prev.sessionId === r.sessionId;
}

/**
 * The kinds of trouble STILL STANDING on a run's journal, as a set.
 *
 * Read from `run.json` alone, so asking "is this a stop we have seen" costs one
 * small file and no transcript. And a set, not a count: a kind of trouble that
 * was already there does not change the answer by happening again, which is
 * what keeps a run that gains a record every tick from looking new every tick.
 *
 * A phase is judged by the last time it ran. A review that asked for changes
 * and then passed, or a session that died and was re-attempted successfully, is
 * the pipeline doing its job and leaves nothing here. What is left is what no
 * later lap put right. Two things count however the last lap went: a phase run
 * over and over, and a remediation.
 *
 * An `infra` death the conductor caused itself (a restart cancels the phase in
 * flight) is left out unless one phase has two: one is a shutdown, not a
 * problem.
 */
export function journalTrouble(
  j: Pick<RunJournal, 'phases' | 'remediations'>, isCode: (phase: string) => boolean = () => false,
): string[] {
  const out = new Set<string>();
  const cancelled = new Map<string, number>();
  const ran = new Map<string, number>();
  const last = new Map<string, { status: string; error: string }>();
  const before = new Map<string, PhaseRecord>();
  for (const r of j.phases ?? []) {
    if (isOwnPhase(r.phase) || !countsAsRun(r.status)) continue;
    // The verdict replaces what its session was first recorded as, and is not a second run.
    if (!isRerecord(before.get(r.phase), r)) ran.set(r.phase, (ran.get(r.phase) ?? 0) + 1);
    before.set(r.phase, r);
    last.set(r.phase, { status: r.status, error: r.error ?? '' });
    if (r.status === 'infra' && CANCELLED_RE.test(r.error ?? '')) cancelled.set(r.phase, (cancelled.get(r.phase) ?? 0) + 1);
  }
  for (const [phase, r] of last) {
    // Settled by a person at a gate: on the record, and no longer wrong.
    if (RESOLVED_RE.test(r.error)) continue;
    if (r.status === 'failed' || r.status === 'warned' || r.status === 'refused') out.add(`${r.status}:${phase}`);
    if (r.status === 'infra' && (!CANCELLED_RE.test(r.error) || (cancelled.get(phase) ?? 0) >= 2)) out.add(`infra:${phase}`);
  }
  for (const [phase, n] of ran) if (n >= (isCode(phase) ? CODE_REPEATS : SESSION_REPEATS)) out.add(`repeated:${phase}`);
  const healed = (j.remediations ?? []).length;
  if (healed) out.add(`remediated:${healed}`);
  return [...out].sort();
}

export interface DiagnosisConfig {
  /** ONESHOT_DIAGNOSIS: the mode runs at all. Off unless a desk turns it on. */
  enabled: boolean;
  /** ONESHOT_DIAGNOSIS_POST=0 keeps the diagnosis on the dashboard and off the ticket. */
  post: boolean;
  /** ONESHOT_DIAGNOSIS_FIX: open fix pull requests for harness defects without being asked. */
  fix: boolean;
  /** Diagnoses one run may have, over its whole life. */
  maxPerRun: number;
  /** Sessions one stop may spend before it is given up on. */
  maxAttempts: number;
  /** Least time between two diagnoses of one run. */
  minGapMs: number;
  /** How long a stop must have stood: finish() is still writing the report and swapping labels just after it. */
  settleMs: number;
  /** A stop older than this is history, not a queue. The CLI still diagnoses one on request. */
  maxAgeMs: number;
  /** Least time between two sessions for a stop whose last one failed. */
  retryGapMs: number;
}

function positive(name: string, fallback: number): number {
  const n = Number(envOr(name));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function diagnosisConfig(): DiagnosisConfig {
  return {
    enabled: envFlag('ONESHOT_DIAGNOSIS'),
    post: !['0', 'false', 'off', 'no'].includes(envOr('ONESHOT_DIAGNOSIS_POST').toLowerCase()),
    fix: envFlag('ONESHOT_DIAGNOSIS_FIX'),
    maxPerRun: positive('ONESHOT_DIAGNOSIS_MAX_PER_RUN', 4),
    maxAttempts: 2,
    minGapMs: positive('ONESHOT_DIAGNOSIS_MIN_GAP_MIN', 20) * 60_000,
    settleMs: 20_000,
    maxAgeMs: positive('ONESHOT_DIAGNOSIS_MAX_AGE_DAYS', 7) * 86_400_000,
    retryGapMs: 10 * 60_000,
  };
}

const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * The part of a stop reason that says WHICH stop it is.
 *
 * The first paragraph only: what follows a blank line is self-remediation's
 * account of what it tried, which reads differently the second time the same
 * block comes back. And counts and durations are flattened, because "next check
 * in 27m" and "timed out after 74 stream messages" are the same stop a minute
 * later. A number that is part of a name is kept: `F-05`, `TC-21`, `!11307`.
 */
export function reasonForKey(reason: string | undefined): string {
  const first = (reason ?? '').split(/\n\s*\n/)[0] ?? '';
  return flat(first).replace(/(?<![\w#!./-])\d+(?:\.\d+)?/g, '0').slice(0, 600);
}

/**
 * The identity of one stop. Twelve hex characters: it is compared within one
 * run's handful of stops, and it is printed in a note marker and a file name.
 */
export function stopKey(o: { runId: string; status: string; phase?: string; reason: string | undefined; trouble: string[] }): string {
  const body = JSON.stringify([o.runId, o.status, o.phase ?? '', reasonForKey(o.reason), [...o.trouble].sort()]);
  return createHash('sha256').update(body).digest('hex').slice(0, 12);
}

/**
 * A stop that is the account's usage limit or a budget ceiling.
 *
 * It says what it is and it clears by itself, so there is nothing to diagnose.
 * And the session would be asked to write about a rate limit while phase.ts
 * watches every session's words for one.
 */
export function isLimitStop(reason: string | undefined): boolean {
  return /^\s*(quota:|subscription usage limit)/i.test(reason ?? '');
}

export type Decision = { act: 'diagnose'; lap: number } | { act: 'skip'; why: string };

/**
 * Whether this stop is diagnosed now.
 *
 * `force` is the CLI: a person asking for one run skips the waits, the age
 * limit and the judgement about what is worth a session, and still never
 * repeats a stop that already has its diagnosis.
 */
export function decideDiagnosis(o: {
  status: string;
  key: string;
  trouble: string[];
  reason?: string;
  stoppedAt: number;
  now: number;
  file: DiagnosisFile | null;
  cfg: DiagnosisConfig;
  force?: boolean;
}): Decision {
  if (o.status !== 'blocked' && o.status !== 'parked') return { act: 'skip', why: `the run is ${o.status}, not stopped` };

  const stops = Object.values(o.file?.stops ?? {});
  const lap = o.file?.sessions ?? 0;
  const mine = o.file?.stops[o.key];

  if (mine && mine.state !== 'failed') return { act: 'skip', why: 'this stop already has its diagnosis' };
  if (mine && mine.attempts >= o.cfg.maxAttempts) {
    return { act: 'skip', why: `gave up on this stop after ${mine.attempts} sessions: ${mine.lastError ?? 'no result'}` };
  }

  if (o.force) return { act: 'diagnose', lap };

  if (o.status === 'parked' && o.trouble.length === 0) {
    return { act: 'skip', why: 'a routine wait: nothing is failed, warned or repeating behind it' };
  }

  if (isLimitStop(o.reason)) return { act: 'skip', why: 'the stop is a usage or budget limit, which explains itself' };

  // Without a time the age limit cannot be applied, and the age limit is what
  // keeps a desk's whole history from being diagnosed the day this is turned on.
  if (!o.stoppedAt) return { act: 'skip', why: 'the journal does not say when the run stopped' };

  // An attempt is recorded before its session starts, so this is also what holds a second process off one that is running.
  if (mine && o.now - mine.lastAttemptAt < o.cfg.retryGapMs) return { act: 'skip', why: 'a session for this stop is running, or failed minutes ago; retrying later' };

  const done = stops.filter((s) => s.state !== 'failed');
  if (done.length >= o.cfg.maxPerRun) return { act: 'skip', why: `this run has had its ${o.cfg.maxPerRun} diagnoses` };

  // Every session started for this run, whatever became of it: failed ones are in no other count.
  const sessionCap = o.cfg.maxPerRun * o.cfg.maxAttempts;
  if (lap >= sessionCap) return { act: 'skip', why: `this run has had its ${sessionCap} diagnosis sessions` };

  // A wait behind which nothing NEW has gone wrong since this run was last
  // diagnosed: the next gate, or the same gate worded differently.
  if (o.status === 'parked') {
    const covered = new Set(stops.filter((s) => s.state === 'diagnosed').flatMap((s) => s.trouble));
    if (covered.size && o.trouble.every((t) => covered.has(t))) {
      return { act: 'skip', why: 'a wait with nothing wrong behind it that an earlier diagnosis of this run did not cover' };
    }
  }

  const lastDone = Math.max(0, ...done.map((s) => s.diagnosedAt ?? 0));
  if (lastDone && o.now - lastDone < o.cfg.minGapMs) return { act: 'skip', why: 'this run was diagnosed minutes ago' };

  if (o.now - o.stoppedAt > o.cfg.maxAgeMs) {
    return { act: 'skip', why: `the stop is ${Math.round((o.now - o.stoppedAt) / 86_400_000)} days old` };
  }
  if (o.now - o.stoppedAt < o.cfg.settleMs) return { act: 'skip', why: 'the stop is still being written' };

  return { act: 'diagnose', lap };
}

/**
 * What a diagnosis that has just come back is worth, given where the run is now.
 *
 * The session takes minutes and the run does not wait for it: a gate is
 * answered, a person unblocks the ticket.
 *
 *   - `stands`: the run is at the stop that was diagnosed. Post it.
 *   - `owed`: the run reads `running`. That is a person having resumed it, or
 *     only the conductor's own tick: a parked run is re-claimed every minute
 *     and its journal says `running`, with no reason, for the seconds until it
 *     is parked again. The two cannot be told apart from here, so the diagnosis
 *     is kept as made and its note is posted by a later look that finds the run
 *     back at this stop, or never, if it has truly moved on.
 *   - `superseded`: the run has stopped somewhere else, or ended. Keep the
 *     diagnosis and leave the ticket alone.
 */
export function standing(o: { keyThen: string; statusNow: string; keyNow: string }): 'stands' | 'owed' | 'superseded' {
  // `aborted` is a run the conductor stopped mid-phase (a pause, a shutdown): it resumes by itself and stops again.
  if (o.statusNow === 'running' || o.statusNow === 'aborted') return 'owed';
  return (o.statusNow === 'blocked' || o.statusNow === 'parked') && o.keyNow === o.keyThen ? 'stands' : 'superseded';
}

/**
 * The assignee rule, as the watcher and the runner apply it before they claim.
 *
 * A diagnosis note is a write on the ticket, and a ticket can be handed to
 * someone else between the run stopping and the note being written. A desk
 * posts only where it would be allowed to run: an unassigned ticket, or one
 * assigned to the account it acts as.
 */
export function mayPostOn(issue: { assignees: Array<{ username: string }> }, me: string): { ok: true } | { ok: false; why: string } {
  if (issue.assignees.length === 0) return { ok: true };
  if (!me) return { ok: false, why: 'the ticket is assigned and this desk has no GitLab identity' };
  if (issue.assignees.some((a) => a.username === me)) return { ok: true };
  return { ok: false, why: `the ticket is assigned to ${issue.assignees.map((a) => a.username).join(', ')}, not to ${me}` };
}

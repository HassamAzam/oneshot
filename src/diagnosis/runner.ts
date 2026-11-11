/**
 * The failure diagnosis mode: when a run stops and a person is wanted, say why.
 *
 * A stopped run used to leave one sentence on the ticket, written by the last
 * phase to speak, and whatever self-remediation added to it. Working out what
 * had really gone wrong meant reading the journal and the transcripts by hand,
 * and on the first ticket run on the server that reading found that almost
 * every failure was the harness or the machine, and that the recorded error was
 * wrong for fifteen sessions. This mode does that reading for every stop.
 *
 * It is a MODE beside the Loop, like the local automation tests, and not a step
 * inside `finish()`:
 *
 *   - It never drives a run. It reads a stopped run's directory and writes one
 *     file beside it, so it holds no claim, no port and no dispatch slot, and a
 *     diagnosis in flight never delays the next ticket.
 *   - It survives restarts. A stop is found by looking, each tick, for a blocked
 *     or parked run with no diagnosis for that stop. A conductor that is
 *     stopped mid-session finds the same stop again when it comes back.
 *   - It covers stops that happened before it existed, within a week.
 *
 * It complements the on-demand `remediate` phase and does not repeat it.
 * `remediate` runs INSIDE a run that is about to block, looks at the one block
 * in front of it, may repair the environment and may resume the run. This runs
 * AFTER the stop, reads the whole run, changes nothing, and answers a different
 * question: across everything that failed, warned or repeated, what were the
 * causes and whose are they. Remediation's own account is one of its inputs.
 *
 * One stop, one session: see src/diagnosis/stop.ts for how a stop is recognised
 * and why a run re-parked every minute is not diagnosed every minute.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  DRY_RUN, PAUSE, ROOT, envOr, gitlabUsername, modelFor, phaseByName, phases, runDir, type PhaseConfig,
} from '../lib/config.js';
import type { RunJournal } from '../lib/artifacts.js';
import { db, logEvent, phaseEnd, phaseStart } from '../lib/db.js';
import { activeClaims } from '../lib/claims.js';
import { addIssueNote, allIssueNotes, getIssue, type GitlabResult, type Issue, type IssueNote } from '../lib/gitlab.js';
import { journalOwner } from '../lib/journalproject.js';
import { log } from '../lib/log.js';
import { checkQuota, quotaParked } from '../lib/quota.js';
import { isReachable } from '../lib/reachability.js';
import { CANCELLED_BY_CONDUCTOR, runPhase, type PhaseInput, type PhaseOutput } from '../conductor/phase.js';
import { systemPromptFor } from '../phases/prompts.js';
import { checkFindings } from './citations.js';
import {
  buildEvidence, renderEvidence, type DbEvent, type DbPhaseRun, type EvidenceInputs, type PhasePolicy,
} from './evidence.js';
import { diagnosisMarker, renderDiagnosisNote } from './note.js';
import { acquireLock, readDiagnosisFile, releaseLock, updateDiagnosisFile } from './record.js';
import { diagnosePrompt } from './prompt.js';
import {
  decideDiagnosis, diagnosisConfig, journalTrouble, mayPostOn, standing, stopKey, type Decision, type DiagnosisConfig,
} from './stop.js';
import {
  CATEGORIES, CONFIDENCE, FIX_BY, type DiagnosisFile, type Finding, type SessionDiagnosis, type StopDiagnosis,
} from './types.js';

const execFileP = promisify(execFile);

export const DIAGNOSE_PHASE = 'diagnose';
/** Posting is retried this many times for a diagnosis GitLab refused, outages aside. */
const MAX_NOTE_ATTEMPTS = 5;
/** A lock older than this is a process that died holding it: a session is at most the phase's half hour. */
const LOCK_STALE_MS = 60 * 60_000;
/**
 * Sessions one stop may have for free. A session the conductor cancelled, the
 * account refused or the usage limit cut is not the stop's fault and is not
 * counted against it, but only this many times: uncounted without limit, a
 * false alarm would start a session every ten minutes for a week.
 */
const MAX_FREE_ATTEMPTS = 2;

// ----------------------------------------------------------------------- deps

export interface StoppedRun { iid: number; runId: string; status: string }

/**
 * Every effect the mode has, injectable. The defaults are the real ones; the
 * tests replace GitLab, the session, the clock and the list of stopped runs.
 */
export interface DiagnosisDeps {
  cfg(): DiagnosisConfig;
  dryRun: boolean;
  now(): number;
  /** The GitLab account this desk acts as. */
  me(): string;
  /** The newest run of each ticket on this desk that is blocked or parked. */
  stopped(): StoppedRun[];
  runDir(iid: number): string;
  /** The Oneshot repository: where `repo:` citations resolve, and the session's working directory. */
  repo: string;
  phase(): PhaseConfig | undefined;
  policy(): Record<string, PhasePolicy>;
  /** Whether the journal belongs to the project this desk is pointed at. */
  ours(j: RunJournal): boolean;
  dbRows(runId: string): { phaseRuns: DbPhaseRun[]; events: DbEvent[] } | undefined;
  conductorLog(sinceMs: number, untilMs: number): Promise<NonNullable<EvidenceInputs['log']>>;
  session(input: PhaseInput): Promise<PhaseOutput>;
  /** Why no session may start now (paused, usage limit, budget), or null. */
  sessionHold(runId: string, lap: number): string | null;
  /** state/PAUSE is set: an operator has asked this desk to do nothing, which includes commenting. */
  paused(): boolean;
  /** The phase_runs row for the session, so its time and tokens show on the dashboard. */
  attempt: { start(runId: string, lap: number, model: string): number; end(id: number, status: string, out: PhaseOutput): void };
  gitlab: {
    getIssue(iid: number): Promise<GitlabResult<Issue>>;
    notes(iid: number): Promise<GitlabResult<IssueNote[]>>;
    addNote(iid: number, body: string): Promise<GitlabResult<{ id: number }>>;
  };
  /** The network breaker's word on GitLab: false means nothing is calling it right now. */
  reachable(): boolean;
  /** What the repository is checked out at, for the prompt: "branch @ sha". '' when it cannot be read. */
  repoHead(): Promise<string>;
  /** A link to the run on the fleet dashboard, for the note. */
  dashboardUrl(iid: number, runId: string): string | undefined;
  event(kind: string, detail: Record<string, unknown>, runId?: string): void;
  /** Open fix pull requests for the stop's harness findings. Absent where the fix pipeline is not wired. */
  fix?(o: { iid: number; dir: string; stop: StopDiagnosis; post: boolean; signal?: AbortSignal }): Promise<void>;
}

/** config/phases.json as the digest reads it: what each phase was allowed. */
export function phasePolicies(list: PhaseConfig[] = phases()): Record<string, PhasePolicy> {
  const out: Record<string, PhasePolicy> = {};
  for (const p of list) {
    out[p.name] = {
      kind: p.kind, onFail: p.onFail,
      ...(p.maxTurns !== undefined ? { maxTurns: p.maxTurns } : {}),
      ...(p.timeoutMin !== undefined ? { timeoutMin: p.timeoutMin } : {}),
      ...(p.maxLaps !== undefined ? { maxLaps: p.maxLaps } : {}),
      ...(p.maxRetries !== undefined ? { maxRetries: p.maxRetries } : {}),
      ...(p.cycleTo ? { cycleTo: p.cycleTo } : {}),
    };
  }
  return out;
}

/**
 * The conductor's own log for a run's window.
 *
 * On the server the conductor is a systemd unit and its stdout is the journal;
 * on a desk it is a terminal, and there is nothing to read unless the operator
 * tees it to a file and names that file. Either may be missing, and a diagnosis
 * without the log is still a diagnosis, so every failure here is a sentence in
 * the digest and never an error.
 */
async function readConductorLog(sinceMs: number, untilMs: number): Promise<NonNullable<EvidenceInputs['log']>> {
  const file = envOr('ONESHOT_CONDUCTOR_LOG');
  if (file) {
    try {
      const text = readFileSync(file, 'utf8');
      return { lines: text.slice(-8 * 1024 * 1024).split('\n'), source: file };
    } catch (err) {
      return { unavailable: `ONESHOT_CONDUCTOR_LOG=${file} could not be read: ${(err as Error).message}` };
    }
  }
  const unit = envOr('ONESHOT_CONDUCTOR_UNIT', 'oneshot-conductor');
  try {
    const { stdout } = await execFileP('journalctl', [
      '-u', unit, '--since', `@${Math.floor(sinceMs / 1000)}`, '--until', `@${Math.ceil(untilMs / 1000) + 60}`,
      '--no-pager', '-o', 'cat',
    ], { timeout: 20_000, maxBuffer: 64 * 1024 * 1024 });
    const lines = stdout.split('\n').filter(Boolean);
    if (!lines.length) return { unavailable: `journalctl -u ${unit} returned nothing for the run's window (is this user in systemd-journal?)` };
    return { lines, source: `journalctl -u ${unit}` };
  } catch (err) {
    return { unavailable: `no log file named in ONESHOT_CONDUCTOR_LOG, and journalctl -u ${unit} failed: ${(err as Error).message.split('\n')[0]}` };
  }
}

/**
 * Bounded by age in the query, a day wider than the limit the decision applies:
 * a desk keeps every blocked run it ever had, and none of the old ones should
 * cost a file read a minute.
 */
function stoppedRuns(): StoppedRun[] {
  const since = Date.now() - diagnosisConfig().maxAgeMs - 86_400_000;
  return (db.prepare(
    `SELECT run_id, iid, status FROM runs r WHERE status IN ('blocked','parked')
       AND COALESCE(ended_at, started_at) >= ?
       AND NOT EXISTS (SELECT 1 FROM runs n WHERE n.iid = r.iid AND n.started_at > r.started_at)
     ORDER BY COALESCE(ended_at, started_at) DESC`,
  ).all(since) as Array<{ run_id: string; iid: number; status: string }>)
    .map((r) => ({ iid: r.iid, runId: r.run_id, status: r.status }));
}

function runRows(runId: string): { phaseRuns: DbPhaseRun[]; events: DbEvent[] } {
  return {
    phaseRuns: db.prepare(
      'SELECT phase, lap, status, started_at, ended_at, turns, weighted, detail FROM phase_runs WHERE run_id = ? ORDER BY started_at, id',
    ).all(runId) as DbPhaseRun[],
    events: db.prepare('SELECT ts, kind, phase, detail FROM events WHERE run_id = ? ORDER BY ts').all(runId) as DbEvent[],
  };
}

export function defaultDiagnosisDeps(): DiagnosisDeps {
  return {
    cfg: diagnosisConfig,
    dryRun: DRY_RUN,
    now: () => Date.now(),
    me: gitlabUsername,
    stopped: stoppedRuns,
    runDir,
    repo: ROOT,
    phase: () => phaseByName(DIAGNOSE_PHASE),
    policy: () => phasePolicies(),
    ours: (j) => journalOwner(j).kind !== 'foreign',
    dbRows: runRows,
    conductorLog: readConductorLog,
    session: runPhase,
    sessionHold: (runId, lap) => {
      if (existsSync(PAUSE)) return 'paused (state/PAUSE)';
      if (quotaParked()) return 'parked after a subscription usage limit';
      const q = checkQuota(runId, DIAGNOSE_PHASE, lap);
      return q.allowed ? null : q.reason ?? 'over budget';
    },
    paused: () => existsSync(PAUSE),
    attempt: {
      start: (runId, lap, model) => phaseStart(runId, DIAGNOSE_PHASE, lap, model),
      end: (id, status, out) => phaseEnd(id, status, {
        turns: out.turns, weighted: out.weighted, sessionId: out.sessionId, detail: out.error ?? out.blocked ?? undefined,
      }),
    },
    gitlab: { getIssue, notes: allIssueNotes, addNote: addIssueNote },
    reachable: isReachable,
    repoHead: async () => {
      try {
        const git = (args: string[]): Promise<string> => execFileP('git', ['-C', ROOT, ...args], { timeout: 10_000 }).then((r) => r.stdout.trim());
        return `${await git(['rev-parse', '--abbrev-ref', 'HEAD'])} @ ${await git(['rev-parse', '--short', 'HEAD'])}`;
      } catch {
        return '';
      }
    },
    dashboardUrl: (iid, runId) => {
      const base = envOr('ONESHOT_DASHBOARD_URL').replace(/\/+$/, '');
      return base ? `${base}/run/${iid}?run=${encodeURIComponent(runId)}` : undefined;
    },
    event: (kind, detail, runId) => logEvent(kind, detail, { runId, phase: DIAGNOSE_PHASE }),
    // Imported when first needed: the pipeline reads this module's record helpers.
    fix: async ({ iid, dir, post, signal }) => {
      const { fixFromDiagnosis } = await import('./fix/pipeline.js');
      await fixFromDiagnosis({ iid, dir, post, signal });
    },
  };
}

// ----------------------------------------------------------------- the record

function readJournalAt(dir: string): RunJournal | null {
  try {
    const j = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as RunJournal;
    return j && Array.isArray(j.phases) ? j : null;
  } catch {
    return null;
  }
}

/** What stop the journal is at now: its key, and what went into it. */
export function stopOf(j: RunJournal, policy: Record<string, PhasePolicy>): { key: string; trouble: string[] } {
  const trouble = journalTrouble(j, (phase) => policy[phase]?.kind === 'code');
  return { key: stopKey({ runId: j.runId, status: j.status, phase: j.stoppedPhase, reason: j.blockedWhy, trouble }), trouble };
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
/** One argument of a command line a session will paste into a shell. */
const shellWord = (w: string): string => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  (allowed as readonly string[]).includes(String(v)) ? (v as T) : fallback;

/**
 * The session's output with every field the right shape.
 *
 * The SDK has already held it to the schema, so this is not validation. It is
 * the same refusal to trust erasure that salvagedReview() makes for a partial
 * file: a recorded diagnosis is read by a renderer and a dashboard, and neither
 * should have to ask whether `findings` is really an array.
 */
export function normaliseDiagnosis(data: Record<string, unknown>): SessionDiagnosis {
  const taken = new Set<string>();
  const findings = (Array.isArray(data.findings) ? data.findings : []).map((raw, i): Finding => {
    const f = (raw ?? {}) as Record<string, unknown>;
    // The id goes into a hidden marker, a branch name and a file name, so it is
    // held to its shape here; and two findings never share one.
    let id = /^D-\d{1,3}$/.test(text(f.id)) && !taken.has(text(f.id)) ? text(f.id) : '';
    for (let n = i + 1; !id; n += 1) if (!taken.has(`D-${n}`)) id = `D-${n}`;
    taken.add(id);
    return {
      id,
      title: text(f.title),
      category: oneOf(f.category, CATEGORIES, 'environment'),
      phases: text(f.phases),
      recorded: text(f.recorded),
      cause: text(f.cause),
      evidence: (Array.isArray(f.evidence) ? f.evidence : []).map((c) => {
        const x = (c ?? {}) as Record<string, unknown>;
        return { file: text(x.file), line: Number(x.line) || 1, quote: text(x.quote) };
      }),
      solution: text(f.solution),
      where: (Array.isArray(f.where) ? f.where : []).map((w) => text(w)).filter(Boolean),
      fix: oneOf(f.fix, FIX_BY, 'person'),
      confidence: oneOf(f.confidence, CONFIDENCE, 'probable'),
      // Only something shaped like a commit id: this is printed beside the word "commit".
      fixedBy: /^[0-9a-f]{7,40}$/i.test(text(f.fixedBy)) ? text(f.fixedBy) : '',
    };
  });
  return {
    summary: text(data.summary),
    headline: text(data.headline),
    account: text(data.account),
    findings,
    decisive: taken.has(text(data.decisive)) ? text(data.decisive) : '',
    nextStep: text(data.nextStep),
    resumeFrom: text(data.resumeFrom),
  };
}

/** Whether a session that produced nothing is counted against the stop's attempts. */
export function sessionCharged(out: PhaseOutput): boolean {
  if (out.error === CANCELLED_BY_CONDUCTOR || out.rateLimited || out.accountAction) return false;
  // Died before it reached the model: nothing was spent, so nothing is counted.
  return !(out.infra && out.turns === 0 && out.weighted === 0);
}

// -------------------------------------------------------------------- one run

export type Outcome =
  | { iid: number; act: 'diagnosed' | 'superseded'; key: string; findings: number; posted: boolean }
  /** `session` is set when a session was started for it, whatever came back. */
  | { iid: number; act: 'skipped' | 'held' | 'failed'; why: string; session?: true };

export interface DiagnoseOpts {
  signal?: AbortSignal;
  /** A person asked for this run: skip the waits and the age limit. */
  force?: boolean;
  /** Post the note, whatever ONESHOT_DIAGNOSIS_POST says. The CLI's `--post`. Default: the config's. */
  post?: boolean;
}

function withDefaults(over?: Partial<DiagnosisDeps>): DiagnosisDeps {
  const d = defaultDiagnosisDeps();
  return { ...d, ...over, gitlab: { ...d.gitlab, ...over?.gitlab }, attempt: { ...d.attempt, ...over?.attempt } };
}

/** Write this stop's entry into the record as it is on disk now. Never a copy held since before a session. */
function persist(dir: string, stop: StopDiagnosis, also?: (f: DiagnosisFile) => void): void {
  updateDiagnosisFile(dir, { iid: stop.iid, runId: stop.runId }, (f) => {
    f.stops[stop.key] = stop;
    also?.(f);
  });
}

/**
 * Post the note for a diagnosed stop, once.
 *
 * Once, in three ways: the record remembers the note id; before posting, the
 * ticket's own comments are searched for this stop's marker, so a process that
 * died between the POST and the write adopts its note rather than repeating it;
 * and a ticket this desk may not run on is never written to. Returns whether
 * the stop now has a note, and updates the record either way.
 */
async function postNote(iid: number, dir: string, stop: StopDiagnosis, deps: DiagnosisDeps, post: boolean): Promise<boolean> {
  if (stop.note || stop.noteSkipped) return !!stop.note;
  const skip = (why: string): boolean => {
    stop.noteSkipped = why;
    persist(dir, stop);
    log.info(`diagnose   #${iid} note not posted: ${why}`);
    return false;
  };
  if (!post) return skip('posting is off on this desk');
  if (deps.dryRun) return skip('dry run');
  // An operator has paused the desk, or the network breaker is open and nothing
  // is calling GitLab. Neither is a failed try: the note stays owed.
  if (deps.paused() || !deps.reachable()) return false;

  const issue = await deps.gitlab.getIssue(iid);
  if (!issue.ok || !issue.data) return transient(iid, dir, stop, `could not read the ticket (${issue.kind})`, issue.kind);
  const may = mayPostOn(issue.data, deps.me());
  if (!may.ok) return skip(may.why);
  if (issue.data.state === 'closed') return skip('the ticket is closed');

  const marker = diagnosisMarker(stop.key);
  const notes = await deps.gitlab.notes(iid);
  if (!notes.ok || !notes.data) return transient(iid, dir, stop, `could not read the ticket's comments (${notes.kind})`, notes.kind);
  const mine = notes.data.find((n) => (n.body ?? '').includes(marker));
  if (mine) {
    stop.note = { id: mine.id, postedAt: deps.now() };
    persist(dir, stop);
    return true;
  }
  // The ticket's owner is the oldest live claim (src/lib/claims.ts). When that
  // is another run, this stop is history and the comment would land in the
  // middle of somebody else's run.
  const owner = activeClaims(notes.data, deps.now())[0];
  if (owner && owner.runId !== stop.runId) return skip(`run ${owner.runId} has since claimed the ticket`);

  const body = renderDiagnosisNote(stop, { dashboardUrl: deps.dashboardUrl(iid, stop.runId) });
  const res = await deps.gitlab.addNote(iid, body);
  if (!res.ok) return transient(iid, dir, stop, `GitLab refused the note (${res.kind}${res.status ? ` ${res.status}` : ''})`, res.kind);
  stop.note = { id: res.data?.id ?? null, postedAt: deps.now() };
  delete stop.noteTries;
  persist(dir, stop);
  log.ok(`diagnose   #${iid} diagnosis posted on the ticket`, { findings: (stop.findings ?? []).length });
  deps.event('diagnosis_posted', { iid, key: stop.key, note: stop.note.id }, stop.runId);
  return true;
}

/**
 * A failure to post that a later look should retry.
 *
 * An outage is not counted: GitLab being unreachable or answering 5xx for an
 * afternoon must not use up the tries and leave a diagnosis off its ticket for
 * good. A refusal that is GitLab's considered answer (auth, not found, a bad
 * request) is counted, and after a handful the note is given up on.
 */
function transient(iid: number, dir: string, stop: StopDiagnosis, why: string, kind: string): boolean {
  if (kind === 'network' || kind === 'server') {
    log.warn(`diagnose   #${iid} note not posted yet: ${why}`);
    return false;
  }
  const tries = (stop.noteTries ?? 0) + 1;
  stop.noteTries = tries;
  if (tries >= MAX_NOTE_ATTEMPTS) stop.noteSkipped = `${why}, ${tries} times`;
  persist(dir, stop);
  log.warn(`diagnose   #${iid} note not posted yet: ${why}`, { attempt: tries, of: MAX_NOTE_ATTEMPTS });
  return false;
}

/**
 * Diagnose one stopped run, if its current stop is one that should be.
 *
 * The order is deliberate. The decision is made from the journal alone, so a
 * stop that needs nothing costs one small read. A lock is taken before anything
 * is paid for, because a desk can run several conductors over one state
 * directory and each makes this pass. The attempt is recorded BEFORE the
 * session starts, so a process killed mid-session has still used one. And the
 * run is looked at again after the session, because it did not wait.
 */
export async function diagnoseRun(iid: number, opts: DiagnoseOpts = {}, over?: Partial<DiagnosisDeps>): Promise<Outcome> {
  const deps = withDefaults(over);
  const cfg = deps.cfg();
  const dir = deps.runDir(iid);
  const j = readJournalAt(dir);
  if (!j) return { iid, act: 'skipped', why: 'no run journal on this desk' };

  const policy = deps.policy();
  const { key, trouble } = stopOf(j, policy);
  const post = opts.post ?? cfg.post;
  // Journals older than `stoppedAt` still say when their last phase ended.
  const stoppedAt = j.stoppedAt ?? j.blockedAt ?? j.phases[j.phases.length - 1]?.endedAt ?? 0;
  const record = (): DiagnosisFile | null => {
    const f = readDiagnosisFile(dir);
    return f && f.runId === j.runId ? f : null;
  };
  const decide = (): Decision => decideDiagnosis({
    status: j.status, key, trouble, reason: j.blockedWhy, stoppedAt, now: deps.now(), file: record(), cfg, force: opts.force,
  });
  // Asked only once something would be done. It runs git, and nearly every look ends before it.
  const foreign = (): Outcome | null => (deps.ours(j) ? null : { iid, act: 'skipped', why: 'the journal belongs to another project' });

  const decision = decide();
  if (decision.act === 'skip') {
    // A stop diagnosed earlier whose note is still owed: GitLab would not take
    // it then, the run was mid-tick when the session ended, or a person is
    // asking for it now with `--post`.
    const had = record()?.stops[key];
    const asked = opts.post === true;
    if (!had || !post || had.state !== 'diagnosed' || had.note || (had.noteSkipped && !asked)) {
      return { iid, act: 'skipped', why: decision.why };
    }
    const not = foreign();
    if (not) return not;
    // Under the stop's lock, and read again inside it: two conductors over one
    // state directory both see the note owed, and only one of them may post it.
    const noteLock = join(dir, 'diagnosis', `.lock-${key}`);
    if (!acquireLock(noteLock, LOCK_STALE_MS)) return { iid, act: 'skipped', why: 'another process is posting this stop\'s note' };
    try {
      const owed = record()?.stops[key];
      if (!owed || owed.state !== 'diagnosed' || owed.note) return { iid, act: 'skipped', why: decision.why };
      if (asked) { delete owed.noteSkipped; delete owed.noteTries; }
      if (owed.noteSkipped) return { iid, act: 'skipped', why: decision.why };
      if (await postNote(iid, dir, owed, deps, true)) {
        return { iid, act: 'diagnosed', key, findings: (owed.findings ?? []).length, posted: true };
      }
      return { iid, act: 'skipped', why: decision.why };
    } finally {
      releaseLock(noteLock);
    }
  }

  const phase = deps.phase();
  if (!phase || phase.kind !== 'session') return { iid, act: 'skipped', why: `config/phases.json has no '${DIAGNOSE_PHASE}' session phase` };
  const hold = deps.sessionHold(j.runId, decision.lap);
  if (hold) return { iid, act: 'held', why: hold };
  const not = foreign();
  if (not) return not;

  const lock = join(dir, 'diagnosis', `.lock-${key}`);
  if (!acquireLock(lock, LOCK_STALE_MS)) return { iid, act: 'skipped', why: 'another process is diagnosing this stop' };
  try {
    // Asked again now the lock is held: whoever had it a moment ago may have finished.
    const again = decide();
    if (again.act === 'skip') return { iid, act: 'skipped', why: again.why };
    return await diagnoseLocked({ iid, dir, j, key, trouble, policy, phase, lap: again.lap, post, deps, cfg, signal: opts.signal });
  } finally {
    releaseLock(lock);
  }
}

async function diagnoseLocked(c: {
  iid: number; dir: string; j: RunJournal; key: string; trouble: string[]; policy: Record<string, PhasePolicy>;
  phase: PhaseConfig; lap: number; post: boolean; deps: DiagnosisDeps; cfg: DiagnosisConfig; signal?: AbortSignal;
}): Promise<Outcome> {
  const { iid, dir, j, key, trouble, policy, phase, lap, deps } = c;
  const before = readDiagnosisFile(dir);
  const others = before && before.runId === j.runId ? before.stops : {};
  const stop: StopDiagnosis = {
    key, runId: j.runId, iid, status: j.status as 'blocked' | 'parked', stoppedPhase: j.stoppedPhase ?? '',
    reason: '', trouble, state: 'failed',
    attempts: (others[key]?.attempts ?? 0) + 1, lastAttemptAt: deps.now(),
    ...(others[key]?.free ? { free: others[key].free } : {}),
  };
  persist(dir, stop, (f) => { f.sessions += 1; });

  // The journal is the one the decision was made from, never a second read: a
  // parked run is re-claimed every tick, and a read that lands in those seconds
  // says `running` with no reason, which would be a digest of some other stop.
  const conductorLog = await deps.conductorLog(j.createdAt ?? 0, j.stoppedAt ?? deps.now());
  const evidence = buildEvidence({ dir, journal: j, policy, db: deps.dbRows(j.runId), log: conductorLog, now: deps.now() });
  if (!evidence) {
    stop.lastError = 'the run directory holds no readable journal';
    persist(dir, stop);
    return { iid, act: 'failed', why: stop.lastError };
  }
  stop.reason = evidence.run.reason;
  mkdirSync(join(dir, 'diagnosis'), { recursive: true });
  writeFileSync(join(dir, 'diagnosis', 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);

  const model = modelFor(phase);
  const earlier = Object.values(others)
    .filter((s) => s.key !== key && s.state !== 'failed' && s.headline)
    .sort((a, b) => (a.diagnosedAt ?? 0) - (b.diagnosedAt ?? 0))
    .map((s) => ({
      headline: s.headline ?? '', nextStep: s.nextStep ?? '',
      findings: (s.findings ?? []).map((f) => ({ id: f.id, category: f.category, title: f.title })),
    }));
  const peek = ['node', join(deps.repo, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(deps.repo, 'scripts', 'diagnose.ts'), 'peek', '--dir', dir]
    .map(shellWord).join(' ');
  const prompt = diagnosePrompt({
    evidence, digest: renderEvidence(evidence), runDir: dir, repo: deps.repo, peek, budgetMin: phase.timeoutMin, earlier,
    repoHead: await deps.repoHead(),
  });
  const systemPrompt = systemPromptFor(phase, {
    ticket: { iid, title: j.title ?? '', description: null, labels: [] }, runId: j.runId, lap, journal: j, prior: {},
  });

  log.info(`diagnose   #${iid} ${j.status} at ${j.stoppedPhase ?? '?'}: reading the run`, {
    transcripts: evidence.totals.transcripts, mb: Math.round(evidence.totals.transcriptBytes / (1024 * 1024)), facts: evidence.facts.length,
  });
  deps.event('diagnosis_started', { iid, key, status: j.status, phase: j.stoppedPhase, trouble }, j.runId);

  const rowId = deps.attempt.start(j.runId, lap, model);
  let out: PhaseOutput;
  try {
    // No GitLab server: everything it reads is on disk, and a session that
    // reads transcripts for a living should hold no tool a transcript could
    // talk it into using. And its own words are never read as a usage-limit
    // notice: writing about a run that hit one is its job, and that reading
    // parks the whole conductor.
    out = await deps.session({
      iid, runId: j.runId, lap, cfg: phase, prompt, systemPrompt, signal: c.signal, gitlabMcp: false, limitFromProse: false,
    });
  } catch (err) {
    out = {
      ok: false, data: null, blocked: null, summary: '', turns: 0, weighted: 0, sessionId: '',
      rateLimited: false, error: (err as Error).message,
    };
  }
  deps.attempt.end(rowId, out.ok && out.data ? 'ok' : out.infra ? 'infra' : 'failed', out);
  stop.model = model;
  stop.turns = out.turns;
  stop.weighted = out.weighted;

  if (!out.ok || !out.data) {
    const why = out.blocked ? `the session reported it was blocked: ${out.blocked}` : out.error ?? 'the session returned nothing';
    const charged = sessionCharged(out) || (stop.free ?? 0) >= MAX_FREE_ATTEMPTS;
    if (!charged) {
      stop.attempts -= 1;
      stop.free = (stop.free ?? 0) + 1;
    }
    stop.lastError = why.slice(0, 300);
    persist(dir, stop);
    deps.event('diagnosis_failed', { iid, key, why: stop.lastError, charged }, j.runId);
    log.warn(`diagnose   #${iid} no diagnosis: ${stop.lastError}`);
    return { iid, act: charged ? 'failed' : 'held', why: stop.lastError, session: true };
  }

  const said = normaliseDiagnosis(out.data);
  const checked = checkFindings(said.findings, { run: dir, repo: deps.repo });
  Object.assign(stop, {
    state: 'diagnosed' as const,
    diagnosedAt: deps.now(),
    headline: said.headline, account: said.account, findings: checked.findings,
    decisive: said.decisive, nextStep: said.nextStep, resumeFrom: said.resumeFrom,
    citations: { checked: checked.checked, verified: checked.verified },
    read: { transcripts: evidence.totals.transcripts, transcriptBytes: evidence.totals.transcriptBytes },
  });
  delete stop.lastError;

  // The run did not wait for the session: see standing() for the three answers.
  const jNow = readJournalAt(dir);
  const where = jNow ? standing({ keyThen: key, statusNow: jNow.status, keyNow: stopOf(jNow, policy).key }) : 'superseded';
  if (where === 'superseded') {
    stop.state = 'superseded';
    stop.noteSkipped = `the run moved on while it was being diagnosed (now ${jNow?.status ?? 'gone'})`;
    persist(dir, stop, (f) => { f.latest = key; });
    deps.event('diagnosis_superseded', { iid, key }, j.runId);
    log.info(`diagnose   #${iid} diagnosed, and the run had moved on: kept, not posted`);
    return { iid, act: 'superseded', key, findings: checked.findings.length, posted: false };
  }

  persist(dir, stop, (f) => { f.latest = key; });
  const evidenced = checked.findings.filter((f) => f.evidenced).length;
  log.ok(`diagnose   #${iid} ${said.headline.slice(0, 110)}`, {
    findings: checked.findings.length, evidenced, citations: `${checked.verified}/${checked.checked}`, turns: out.turns,
  });
  deps.event('diagnosis_done', {
    iid, key, findings: checked.findings.length, evidenced, citations: checked.verified, cited: checked.checked,
    categories: checked.findings.map((f) => f.category),
  }, j.runId);

  if (where === 'owed') {
    log.info(`diagnose   #${iid} the run reads running: the note waits for a look that finds it back at this stop`);
    return { iid, act: 'diagnosed', key, findings: checked.findings.length, posted: false };
  }
  const posted = await postNote(iid, dir, stop, deps, c.post);

  if (c.cfg.fix && deps.fix) {
    try {
      await deps.fix({ iid, dir, stop, post: c.post, signal: c.signal });
    } catch (err) {
      log.warn(`diagnose   #${iid} the fix step threw: ${(err as Error).message.slice(0, 200)}`);
    }
  }
  return { iid, act: 'diagnosed', key, findings: checked.findings.length, posted };
}

// ------------------------------------------------------------------- the tick

/**
 * One pass over this desk's stopped runs.
 *
 * At most ONE session per pass, newest stop first. Everything else in the pass
 * is a journal read and a comparison, so a desk with twenty blocked tickets
 * spends twenty small reads a minute and nothing more.
 */
export async function diagnosisTick(opts: { signal?: AbortSignal } = {}, over?: Partial<DiagnosisDeps>): Promise<Outcome[]> {
  const deps = withDefaults(over);
  if (!deps.cfg().enabled) return [];
  const outcomes: Outcome[] = [];
  for (const run of deps.stopped()) {
    if (opts.signal?.aborted) break;
    let o: Outcome;
    try {
      o = await diagnoseRun(run.iid, { signal: opts.signal }, deps);
    } catch (err) {
      // One run's broken directory must not hide every stop behind it in the list, every tick.
      o = { iid: run.iid, act: 'failed', why: `the diagnosis threw: ${(err as Error).message.slice(0, 200)}` };
      log.warn(`diagnose   #${run.iid} ${o.why}`);
    }
    outcomes.push(o);
    // A session ran: the next stop waits for the next pass. A run that was
    // skipped, or held by its own budget, cost a file read, and the one behind
    // it is looked at.
    if (o.act === 'diagnosed' || o.act === 'superseded' || ('session' in o && o.session)) break;
  }
  return outcomes;
}

export function outcomeLine(o: Outcome): string {
  if ('why' in o) return `#${o.iid} ${o.act}: ${o.why}`;
  return o.act === 'diagnosed'
    ? `#${o.iid} diagnosed: ${o.findings} finding(s)${o.posted ? ', note on the ticket' : ', no note'}`
    : `#${o.iid} diagnosed after the run moved on: kept, not posted`;
}

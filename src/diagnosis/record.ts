/**
 * `state/runs/<iid>/diagnosis.json`: where a run's diagnoses are kept.
 *
 * Its own file, beside the journal and never inside it. The runner holds the
 * journal in memory for as long as it drives a run and writes it back whole, so
 * a second writer of `run.json` would have one side's change lost. A parked run
 * is re-claimed every tick, which makes that a certainty, not a risk.
 *
 * This file has the same hazard on a smaller scale, and is written so that it
 * does not bite. Several things write it: the conductor's diagnosis pass, a
 * second conductor on the same desk, `npm run diagnose` by hand, and the fix
 * pipeline, which runs for an hour. So nothing writes back a copy it has been
 * holding. `updateDiagnosisFile` re-reads, changes the one entry the caller
 * owns and replaces the file in one rename; and a lock file, created
 * exclusively, is what stops two processes paying for the same session.
 *
 * WHAT IS READ BACK IS NOT TRUSTED. The record sits in a run directory, where
 * sessions of the run work, and the ticket note, the dashboard panel and the
 * fix pipeline are all driven from it. A guard keeps sessions from writing it
 * (hooks/artifact-guard.cjs); `readDiagnosisFile` is the second line: every
 * field comes back in its declared shape or not at all. A count is a number, a
 * key is a key, a finding's id is `D-n`, and a stop filed under one key that
 * claims to be another is dropped. Nothing downstream then has to ask whether
 * a number is really a string holding a GitLab command.
 *
 * This module imports nothing but the types and the filesystem, on purpose: the
 * dashboard reads the record too, and it must never import src/lib/db.ts, which
 * opens the database read-write on import.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CATEGORIES, CONFIDENCE, FIX_BY, type CheckedCitation, type CheckedFinding, type DiagnosisFile, type FixRecord, type StopDiagnosis,
} from './types.js';

export function diagnosisPath(dir: string): string { return join(dir, 'diagnosis.json'); }

// ------------------------------------------------------- reading it back, soundly

type Raw = Record<string, unknown>;

/** A stop's key as it is used in a file name and a hidden marker: word characters and dashes. */
export const STOP_KEY_RE = /^[\w-]{1,64}$/;
export const FINDING_ID_RE = /^D-\d{1,3}$/;

const obj = (v: unknown): Raw | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const optStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const optNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  ((allowed as readonly string[]).includes(String(v)) ? (v as T) : fallback);
const given = <T>(o: Record<string, T | undefined>): Record<string, T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Record<string, T>;

function soundNote(v: unknown): { id: number | null; postedAt: number } | undefined {
  const n = obj(v);
  return n ? { id: typeof n.id === 'number' && Number.isFinite(n.id) ? n.id : null, postedAt: num(n.postedAt) } : undefined;
}

function soundFinding(v: unknown, i: number): CheckedFinding | null {
  const f = obj(v);
  if (!f) return null;
  const evidence = (Array.isArray(f.evidence) ? f.evidence : []).map(obj).filter((c): c is Raw => c !== null)
    .map((c): CheckedCitation => ({ file: str(c.file), line: num(c.line) || 1, quote: str(c.quote), ok: c.ok === true, note: str(c.note) }));
  return {
    id: FINDING_ID_RE.test(str(f.id)) ? str(f.id) : `D-${i + 1}`,
    title: str(f.title), category: oneOf(f.category, CATEGORIES, 'environment'), phases: str(f.phases), recorded: str(f.recorded),
    cause: str(f.cause), evidence, solution: str(f.solution),
    where: (Array.isArray(f.where) ? f.where : []).filter((w): w is string => typeof w === 'string'),
    fix: oneOf(f.fix, FIX_BY, 'person'), confidence: oneOf(f.confidence, CONFIDENCE, 'probable'),
    fixedBy: /^[0-9a-f]{7,40}$/i.test(str(f.fixedBy)) ? str(f.fixedBy) : '',
    // Recomputed, never read: a finding is evidenced by its citations and by nothing it says of itself.
    evidenced: evidence.some((c) => c.ok),
  };
}

const FIX_STATES = ['opened', 'refused', 'failed', 'unavailable', 'held'] as const;

function soundFix(v: unknown): FixRecord | null {
  const f = obj(v);
  if (!f || !(FIX_STATES as readonly string[]).includes(String(f.state))) return null;
  const checks = obj(f.checks);
  const review = obj(f.review);
  return {
    state: f.state as FixRecord['state'], at: num(f.at),
    ...given({ why: optStr(f.why), prUrl: optStr(f.prUrl), branch: optStr(f.branch) }),
    ...given({ prNumber: optNum(f.prNumber) }),
    ...(checks ? { checks: { typecheck: str(checks.typecheck), tests: str(checks.tests), hooks: str(checks.hooks), redGreen: str(checks.redGreen) } } : {}),
    ...(review ? { review: { raised: num(review.raised), upheld: num(review.upheld), refuted: num(review.refuted), fixed: num(review.fixed), rounds: num(review.rounds) } } : {}),
    ...(soundNote(f.note) ? { note: soundNote(f.note) } : {}),
  };
}

/** One stop in its declared shape, or null when it is not a stop filed under its own key. */
function soundStop(key: string, v: unknown): StopDiagnosis | null {
  const s = obj(v);
  if (!s || !STOP_KEY_RE.test(key) || s.key !== key) return null;
  if (!['diagnosed', 'failed', 'superseded'].includes(String(s.state))) return null;
  const citations = obj(s.citations);
  const read = obj(s.read);
  const fixes = obj(s.fixes);
  const findings = Array.isArray(s.findings)
    ? s.findings.map(soundFinding).filter((f): f is CheckedFinding => f !== null)
    : undefined;
  return {
    key, runId: str(s.runId), iid: num(s.iid), status: s.status === 'parked' ? 'parked' : 'blocked', stoppedPhase: str(s.stoppedPhase),
    reason: str(s.reason), trouble: (Array.isArray(s.trouble) ? s.trouble : []).filter((t): t is string => typeof t === 'string'),
    state: s.state as StopDiagnosis['state'], attempts: num(s.attempts), lastAttemptAt: num(s.lastAttemptAt),
    ...given({
      lastError: optStr(s.lastError), model: optStr(s.model), headline: optStr(s.headline), account: optStr(s.account),
      decisive: optStr(s.decisive), nextStep: optStr(s.nextStep), resumeFrom: optStr(s.resumeFrom), noteSkipped: optStr(s.noteSkipped),
    }),
    ...given({ free: optNum(s.free), diagnosedAt: optNum(s.diagnosedAt), turns: optNum(s.turns), weighted: optNum(s.weighted), noteTries: optNum(s.noteTries) }),
    ...(findings ? { findings } : {}),
    ...(citations ? { citations: { checked: num(citations.checked), verified: num(citations.verified) } } : {}),
    ...(read ? { read: { transcripts: num(read.transcripts), transcriptBytes: num(read.transcriptBytes) } } : {}),
    ...(soundNote(s.note) ? { note: soundNote(s.note) } : {}),
    ...(fixes ? {
      fixes: Object.fromEntries(Object.entries(fixes)
        .filter(([id]) => FINDING_ID_RE.test(id))
        .map(([id, fix]) => [id, soundFix(fix)] as const)
        .filter((e): e is readonly [string, FixRecord] => e[1] !== null)),
    } : {}),
  };
}

export function readDiagnosisFile(dir: string): DiagnosisFile | null {
  let raw: Raw | null;
  try {
    raw = obj(JSON.parse(readFileSync(diagnosisPath(dir), 'utf8')));
  } catch {
    return null;
  }
  const kept = obj(raw?.stops);
  if (!raw || !kept) return null;
  const stops: Record<string, StopDiagnosis> = {};
  for (const [key, value] of Object.entries(kept)) {
    const stop = soundStop(key, value);
    if (stop) stops[key] = stop;
  }
  const latest = str(raw.latest);
  return { version: 1, iid: num(raw.iid), runId: str(raw.runId), latest: stops[latest] ? latest : null, sessions: num(raw.sessions), stops };
}

/** Replace the file in one step, so a reader never sees half of it. */
export function writeDiagnosisFile(dir: string, file: DiagnosisFile): void {
  const path = diagnosisPath(dir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * Change the record as it is on disk NOW.
 *
 * A record belonging to another run of the same ticket is not this run's: it is
 * started afresh, as the run directory itself would have been.
 */
export function updateDiagnosisFile(
  dir: string, run: { iid: number; runId: string }, mutate: (file: DiagnosisFile) => void,
): DiagnosisFile {
  let file = readDiagnosisFile(dir);
  if (!file || file.runId !== run.runId) file = { version: 1, iid: run.iid, runId: run.runId, latest: null, sessions: 0, stops: {} };
  mutate(file);
  writeDiagnosisFile(dir, file);
  return file;
}

/** The newest stop that has a diagnosis to show, or null. */
export function latestDiagnosis(file: DiagnosisFile | null, runId?: string): StopDiagnosis | null {
  if (!file || (runId && file.runId !== runId)) return null;
  const stop = file.latest ? file.stops[file.latest] : undefined;
  return stop && stop.state !== 'failed' ? stop : null;
}

/**
 * Take a lock by creating its file, which fails if the file is there.
 *
 * A desk can run several conductors over one state directory, and each makes
 * its own pass. Without this, two of them looking at one blocked run in the
 * same minute would each start a session for it. A lock older than `staleMs` is
 * a process that died holding it, and is taken over.
 */
export function acquireLock(path: string, staleMs: number): boolean {
  try { mkdirSync(dirname(path), { recursive: true }); } catch { return false; }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      try {
        if (Date.now() - statSync(path).mtimeMs < staleMs) return false;
        rmSync(path, { force: true });
      } catch {
        return false;
      }
    }
  }
  return false;
}

export function releaseLock(path: string): void {
  try { rmSync(path, { force: true }); } catch { /* already gone */ }
}

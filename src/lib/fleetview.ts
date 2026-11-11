/**
 * The dashboard's judgements about a run, kept pure so they can be tested
 * without a database: what a person looking at the board should read a run's
 * state as, whether the conductor is inside its run window, and how a run's
 * phase rows roll up.
 *
 * The runs table only knows claimed / running / parked / blocked / done /
 * aborted. "Waiting for the run window" and "standing down on quota" are not
 * statuses anything writes — they are what a claimed or running row MEANS when
 * its conductor has been stopped by the window timer or a quota park. Telling
 * them apart from a run whose conductor simply died is the point of this file.
 */

export type BoardStatus =
  | 'running'   // a live conductor is driving it
  | 'starting'  // claimed by a live conductor, no phase begun yet
  | 'gate'      // parked: a person must approve, answer or merge
  | 'blocked'   // stopped with a reason; needs a person to unblock
  | 'window'    // outside ONESHOT_WINDOW; resumes when the window opens
  | 'quota'     // the fleet is parked after a subscription usage limit
  | 'stalled'   // in flight, inside the window, but its conductor is gone
  | 'done'
  | 'aborted';

/** Minutes after local midnight. */
export interface Window { from: number; to: number }

const MINUTES_PER_DAY = 24 * 60;

/** `H` or `HH:MM` in 24h time, as minutes after midnight; null when it is neither. */
function clockMinutes(t: string): number | null {
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(t);
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2] ?? 0);
  return Number(m[2] ?? 0) > 59 || minutes > MINUTES_PER_DAY ? null : minutes;
}

/**
 * ONESHOT_WINDOW as scripts/window.sh reads it: `<from>-<to>` where each end is
 * an hour (`1-0`) or a clock time (`01:10-00:50`), or `always`. Returns null for
 * anything else, which window.sh refuses too.
 */
export function parseWindow(spec: string): Window | 'always' | null {
  const s = spec.trim();
  if (s === 'always') return 'always';
  const [a, b, ...rest] = s.split('-');
  if (a === undefined || b === undefined || rest.length) return null;
  const from = clockMinutes(a);
  const to = clockMinutes(b);
  return from === null || to === null ? null : { from, to };
}

/** True inside the window, by the local clock — the same test window.sh makes. */
export function inWindow(w: Window | 'always', at: Date): boolean {
  if (w === 'always') return true;
  const now = at.getHours() * 60 + at.getMinutes();
  return w.from <= w.to ? now >= w.from && now < w.to : now >= w.from || now < w.to;
}

/** When the window next opens (if closed) or closes (if open); null for `always` or a window that never changes. */
export function nextWindowChange(w: Window | 'always', at: Date): number | null {
  if (w === 'always' || w.from === w.to) return null;
  const open = inWindow(w, at);
  const t = new Date(at);
  t.setSeconds(0, 0);
  for (let i = 0; i <= MINUTES_PER_DAY; i++) {
    t.setMinutes(t.getMinutes() + 1);
    if (inWindow(w, t) !== open) return t.getTime();
  }
  return null;
}

export interface StatusInputs {
  status: string;
  ownerAlive: boolean;
  /** A phase_runs row is open for this run. */
  phaseRunning: boolean;
  inWindow: boolean;
  quotaParked: boolean;
}

export function boardStatus(r: StatusInputs): BoardStatus {
  switch (r.status) {
    case 'done': return 'done';
    case 'aborted': return 'aborted';
    case 'parked': return 'gate';
    case 'blocked': return 'blocked';
  }
  // claimed / running. A live owner is the only proof it is moving; without
  // one, the reason it is not moving is what the board must say.
  if (r.ownerAlive) return r.status === 'claimed' && !r.phaseRunning ? 'starting' : 'running';
  if (r.quotaParked) return 'quota';
  if (!r.inWindow) return 'window';
  return 'stalled';
}

/** Statuses that hold a conductor slot. */
export const IN_FLIGHT: ReadonlySet<BoardStatus> = new Set(['running', 'starting']);
/** Statuses waiting on a person, not on the machine. */
export const NEEDS_PERSON: ReadonlySet<BoardStatus> = new Set(['gate', 'blocked']);

export interface PhaseRow {
  phase: string; lap: number; status: string;
  started_at: number; ended_at: number | null;
  turns: number | null; weighted: number | null;
}

export interface PhaseRollup {
  phase: string;
  laps: number;
  /** The newest attempt's status. */
  status: string;
  firstStart: number;
  /** Wall-clock summed over attempts; an open attempt counts up to `now`. */
  ms: number;
  turns: number;
  weighted: number;
}

/** One line per phase, in the order the phases first ran. */
export function rollupPhases(rows: PhaseRow[], now: number): PhaseRollup[] {
  const by = new Map<string, PhaseRollup>();
  for (const p of [...rows].sort((a, b) => a.started_at - b.started_at)) {
    const r = by.get(p.phase) ?? { phase: p.phase, laps: 0, status: p.status, firstStart: p.started_at, ms: 0, turns: 0, weighted: 0 };
    r.laps += 1;
    r.status = p.status;
    r.ms += Math.max(0, (p.ended_at ?? now) - p.started_at);
    r.turns += p.turns ?? 0;
    r.weighted += p.weighted ?? 0;
    by.set(p.phase, r);
  }
  return [...by.values()];
}

/**
 * Since when the run has stood where it stands: the open phase's start while it
 * runs, the moment it stopped while it waits, otherwise the newest attempt at
 * its recorded phase.
 */
export function sinceFor(
  r: { status: string; phase: string | null; started_at: number; ended_at: number | null },
  rows: PhaseRow[],
): number {
  const open = rows.filter((p) => p.ended_at === null).map((p) => p.started_at);
  if (r.status === 'running' && open.length) return Math.min(...open);
  if (r.ended_at) return r.ended_at;
  const atPhase = rows.filter((p) => p.phase === r.phase).map((p) => p.started_at);
  return atPhase.length ? Math.max(...atPhase) : r.started_at;
}

/** `/-/issues/N` and `/-/merge_requests/N` under the project's web URL. */
export const issueUrl = (webUrl: string, iid: number): string => `${webUrl.replace(/\/+$/, '')}/-/issues/${iid}`;
export const mergeRequestUrl = (webUrl: string, iid: number): string => `${webUrl.replace(/\/+$/, '')}/-/merge_requests/${iid}`;

export function dur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h${m % 60 ? ` ${m % 60}m` : ''}` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** 1234567 → 1.2M; small numbers as they are. */
export function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

// ------------------------------------------------------------------ stats

/** Nearest-rank percentile, p in 0..100; null for no values. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

/** Local calendar day, `YYYY-MM-DD` — the server's day, like the run window. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Every local day from `from` to `to`, oldest first, both ends included. */
export function dayKeys(from: number, to: number): string[] {
  const out: string[] = [];
  const d = new Date(from);
  d.setHours(12, 0, 0, 0);
  for (let i = 0; i < 400 && dayKey(d.getTime()) <= dayKey(to); i++) {
    out.push(dayKey(d.getTime()));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/** A phase attempt that let the run go on — warned and skipped included. */
export const PASSED: ReadonlySet<string> = new Set(['ok', 'warned', 'skipped']);

export interface PhaseStat {
  phase: string;
  attempts: number;
  runs: number;
  passed: number;
  failed: number;
  infra: number;
  /** Runs that parked at this phase — waits, not attempts. */
  parked: number;
  /** Share of runs whose first attempt passed, of those whose first attempt finished. */
  firstPass: number | null;
  lapsPerRun: number;
  medianMs: number | null;
  weighted: number;
}

type StatRow = PhaseRow & { run_id: string };

/**
 * The rows that were real attempts. A parked wait is re-checked every tick and
 * each re-check writes a row (8652 had 1521 of them), as does a model-less
 * phase like mr-open re-confirming what it found. So `parked` rows are waits,
 * and a model-less row repeating its predecessor's outcome for the same run is
 * the same attempt seen again.
 */
function attemptsOf(rows: StatRow[]): StatRow[] {
  const last = new Map<string, string>();
  return [...rows].sort((a, b) => a.started_at - b.started_at).filter((r) => {
    if (r.status === 'parked') return false;
    const key = `${r.run_id}\u0000${r.phase}`;
    const repeat = !r.turns && last.get(key) === r.status;
    last.set(key, r.status);
    return !repeat;
  });
}

/** Per-phase outcome counts over phase_runs rows (run_id included), busiest first. */
export function phaseStats(rows: StatRow[], now: number): PhaseStat[] {
  const by = new Map<string, StatRow[]>();
  for (const r of rows) by.set(r.phase, [...(by.get(r.phase) ?? []), r]);
  return [...by.entries()].map(([phase, all]) => {
    const rs = attemptsOf(all);
    const runs = new Set(all.map((r) => r.run_id)).size;
    const firstByRun = new Map<string, StatRow>();
    for (const r of rs) if (!firstByRun.has(r.run_id)) firstByRun.set(r.run_id, r);
    const first = [...firstByRun.values()].filter((r) => r.status !== 'running');
    return {
      phase,
      attempts: rs.length,
      runs,
      passed: rs.filter((r) => PASSED.has(r.status)).length,
      failed: rs.filter((r) => r.status === 'failed' || r.status === 'refused').length,
      infra: rs.filter((r) => r.status === 'infra').length,
      parked: new Set(all.filter((r) => r.status === 'parked').map((r) => r.run_id)).size,
      firstPass: first.length ? first.filter((r) => PASSED.has(r.status)).length / first.length : null,
      lapsPerRun: runs ? rs.length / runs : 0,
      medianMs: percentile(rs.filter((r) => r.ended_at !== null).map((r) => r.ended_at! - r.started_at), 50),
      weighted: all.reduce((n, r) => n + (r.weighted ?? 0), 0),
    };
  }).sort((a, b) => b.runs - a.runs || b.attempts - a.attempts);
}

/** The phase a stop reason names — `review: …` → `review` — or `other`. */
export function stopPhase(why: string | null): string {
  const m = /^([a-z][a-z-]*):/.exec(why ?? '');
  return m ? m[1]! : 'other';
}

/**
 * The dashboard's read-only view of state/oneshot.db.
 *
 * Read-only on purpose: the conductors own this file, and a dashboard that held
 * a write lock — or created an empty database where none exists yet — would be
 * the one thing on the page able to break a run. A missing DB is an empty fleet,
 * not an error. For the same reason nothing here imports src/lib/db.ts or
 * src/lib/quota.ts: both open the database read-write and migrate it on import.
 */
import Database from 'better-sqlite3';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { DB_PATH, PAUSE_QUOTA, STATE, envOr, projectConfig, repoIdentity } from '../../src/lib/config.js';
import { readJournal } from '../../src/lib/artifacts.js';
import { redact } from '../../src/lib/report.js';
import {
  IN_FLIGHT, boardStatus, inWindow, issueUrl, mergeRequestUrl, nextWindowChange, parseWindow, rollupPhases, sinceFor,
  type BoardStatus, type PhaseRollup,
} from '../../src/lib/fleetview.js';

const ALIVE_MS = 60_000;
const QUOTA_WINDOW_MS = 5 * 3600_000;
const ACTIVE = ['claimed', 'running', 'parked', 'blocked'];
const FINISHED = ['done', 'aborted'];
const SIGNAL_MAX_AGE_MS = 90 * 60_000;
export const HISTORY_HOURS = 24;
const HISTORY_MAX_HOURS = 24 * 30;
const HISTORY_LIMIT = 200;

let handle: Database.Database | null = null;

function open(): Database.Database | null {
  if (handle) return handle;
  if (!existsSync(DB_PATH)) return null;
  handle = new Database(DB_PATH, { readonly: true, fileMustExist: false });
  handle.pragma('busy_timeout = 3000');
  return handle;
}

const all = <T>(sql: string, ...args: unknown[]): T[] => {
  const d = open();
  return d ? (d.prepare(sql).all(...args) as T[]) : [];
};

const R = (s: unknown): string | null => (s === null || s === undefined ? null : redact(String(s)));
const marks = (xs: readonly unknown[]): string => xs.map(() => '?').join(',') || 'NULL';
const safeUrl = (u: unknown): string | null => (typeof u === 'string' && /^https?:\/\//.test(u) ? redact(u) : null);

export interface PhaseRunRow {
  id: number; phase: string; lap: number; model: string | null; status: string;
  started_at: number; ended_at: number | null; turns: number | null; weighted: number | null; detail: string | null;
}

interface RunRow {
  run_id: string; iid: number; title: string | null; status: string; phase: string | null;
  mr_iid: number | null; started_at: number; ended_at: number | null; blocked_why: string | null;
  owner: string | null; owner_seen_at: number | null;
}

export interface RunView {
  runId: string; iid: number; title: string;
  /** What the runs table says. */
  status: string;
  /** What a person should read it as — see src/lib/fleetview.ts. */
  board: BoardStatus;
  phase: string | null;
  /** Since when it has stood in this phase / state. */
  since: number;
  url: string | null; mrUrl: string | null; mrIid: number | null;
  startedAt: number; endedAt: number | null; why: string | null;
  owner: string | null; ownerAlive: boolean;
  current: Array<{ phase: string; lap: number; startedAt: number }>;
  /** phase_runs rows: every attempt at every phase. */
  attempts: number;
  weighted: number;
}

export interface FleetState {
  now: number;
  dbFound: boolean;
  project: string | null;
  conductors: Array<{ id: string; pid: number; argv: string; startedAt: number; heartbeatAt: number }>;
  slots: { used: number; of: number | null };
  window: { spec: string; valid: boolean; open: boolean; nextChange: number | null };
  quota: {
    /** state/PAUSE-QUOTA in force: the fleet stands down until `until`. */
    parkedUntil: number | null;
    lastParkAt: number | null;
    /** Account 5h utilisation from the status-line harvester, when fresh. */
    accountPct: number | null;
    weighted5h: number;
    weightedToday: number;
  };
  pauses: string[];
  leases: Array<{ port: number; runId: string; leasedAt: number }>;
  /** Claimed / running / parked / blocked, newest run per ticket. */
  active: RunView[];
  /** Done or aborted inside the last `historyHours`. */
  finished: RunView[];
  historyHours: number;
}

function liveConductors(now: number): FleetState['conductors'] {
  return all<{ conductor_id: string; pid: number; argv: string | null; started_at: number; heartbeat_at: number }>(
    'SELECT * FROM conductors WHERE ended_at IS NULL AND heartbeat_at > ? ORDER BY started_at', now - ALIVE_MS,
  ).map((c) => ({ id: c.conductor_id, pid: c.pid, argv: R(c.argv) ?? '', startedAt: c.started_at, heartbeatAt: c.heartbeat_at }));
}

const weightedSince = (ts: number): number =>
  all<{ w: number | null }>('SELECT SUM(weighted) w FROM quota_usage WHERE ts >= ?', ts)[0]?.w ?? 0;

/** The quota park file, read and never removed — quotaParked() owns its expiry. */
function parkedUntil(now: number): number | null {
  if (!existsSync(PAUSE_QUOTA)) return null;
  try {
    const until = (JSON.parse(readFileSync(PAUSE_QUOTA, 'utf8')) as { until?: unknown }).until;
    return typeof until === 'number' && until > now ? until : null;
  } catch {
    return null;
  }
}

function accountPct(now: number): number | null {
  const path = envOr('ONESHOT_RATELIMIT_SIGNAL', `${process.env.HOME ?? ''}/.claude/state/ratelimit.json`);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { captured_at_ms?: number; rate_limits?: { five_hour?: { utilization?: unknown } } };
    if (now - (raw.captured_at_ms ?? 0) > SIGNAL_MAX_AGE_MS) return null;
    const u = raw.rate_limits?.five_hour?.utilization;
    return typeof u === 'number' ? u : null;
  } catch {
    return null;
  }
}

/** ONESHOT_CONCURRENCY, else project.json's — null if neither can be read. */
function concurrency(): number | null {
  const env = Number(envOr('ONESHOT_CONCURRENCY'));
  if (Number.isInteger(env) && env > 0) return env;
  try { return projectConfig().concurrency; } catch { return null; }
}

interface Context { now: number; alive: Set<string>; open: boolean; parked: boolean; webUrl: string | null }

function views(rows: RunRow[], ctx: Context): RunView[] {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.run_id);
  const phases = new Map<string, PhaseRunRow[]>();
  for (const p of all<PhaseRunRow & { run_id: string }>(
    `SELECT run_id, id, phase, lap, model, status, started_at, ended_at, turns, weighted, NULL detail FROM phase_runs WHERE run_id IN (${marks(ids)})`, ...ids,
  )) phases.set(p.run_id, [...(phases.get(p.run_id) ?? []), p]);
  const spent = new Map(all<{ run_id: string; w: number }>(
    `SELECT run_id, SUM(weighted) w FROM quota_usage WHERE run_id IN (${marks(ids)}) GROUP BY run_id`, ...ids,
  ).map((q) => [q.run_id, q.w ?? 0]));

  return rows.map((r) => {
    const attempts = phases.get(r.run_id) ?? [];
    const current = attempts.filter((p) => p.ended_at === null && p.status === 'running')
      .map((p) => ({ phase: p.phase, lap: p.lap, startedAt: p.started_at }));
    // The journal holds the ticket's real URLs; it describes this run only if
    // its runId matches — an older run of the same ticket has been archived.
    const j = readJournal(r.iid);
    const mine = j?.runId === r.run_id ? j : null;
    const ownerAlive = !!r.owner && ctx.alive.has(r.owner);
    return {
      runId: r.run_id, iid: r.iid, title: R(r.title ?? mine?.title ?? '') ?? '', status: r.status,
      board: boardStatus({ status: r.status, ownerAlive, phaseRunning: current.length > 0, inWindow: ctx.open, quotaParked: ctx.parked }),
      phase: r.phase, since: sinceFor(r, attempts),
      url: safeUrl(mine?.url) ?? (ctx.webUrl ? issueUrl(ctx.webUrl, r.iid) : null),
      mrUrl: safeUrl(mine?.mrUrl) ?? (ctx.webUrl && r.mr_iid ? mergeRequestUrl(ctx.webUrl, r.mr_iid) : null),
      mrIid: r.mr_iid, startedAt: r.started_at, endedAt: r.ended_at, why: R(r.blocked_why),
      owner: r.owner, ownerAlive, current,
      attempts: attempts.length,
      weighted: spent.get(r.run_id) ?? attempts.reduce((n, p) => n + (p.weighted ?? 0), 0),
    };
  });
}

function context(now: number, alive: Set<string>): Context & { spec: string; valid: boolean; nextChange: number | null; parkedUntil: number | null } {
  const spec = envOr('ONESHOT_WINDOW', '10-22');
  const w = parseWindow(spec);
  const until = parkedUntil(now);
  return {
    now, alive, spec, valid: w !== null,
    // An unreadable window is treated as open: window.sh refuses it, so the
    // conductor's own state is the better guide than a guess at the hours.
    open: w ? inWindow(w, new Date(now)) : true,
    nextChange: w ? nextWindowChange(w, new Date(now)) : null,
    parked: until !== null, parkedUntil: until,
    webUrl: repoIdentity().repo?.webUrl ?? null,
  };
}

export function fleetState(historyHours = HISTORY_HOURS): FleetState {
  const now = Date.now();
  const hours = Math.min(HISTORY_MAX_HOURS, Math.max(1, Math.round(historyHours) || HISTORY_HOURS));
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const conductors = liveConductors(now);
  const ctx = context(now, new Set(conductors.map((c) => c.id)));

  // A re-run leaves the ticket's older rows behind; only the newest describes
  // where the ticket stands now.
  const active = all<RunRow>(
    `SELECT * FROM runs r WHERE status IN (${marks(ACTIVE)})
       AND NOT EXISTS (SELECT 1 FROM runs n WHERE n.iid = r.iid AND n.started_at > r.started_at)
     ORDER BY started_at DESC`, ...ACTIVE,
  );
  const finished = all<RunRow>(
    `SELECT * FROM runs WHERE status IN (${marks(FINISHED)}) AND COALESCE(ended_at, started_at) >= ?
     ORDER BY COALESCE(ended_at, started_at) DESC LIMIT ?`, ...FINISHED, now - hours * 3600_000, HISTORY_LIMIT,
  );
  const activeViews = views(active, ctx);

  return {
    now,
    dbFound: open() !== null,
    project: ctx.webUrl,
    conductors,
    slots: { used: activeViews.filter((r) => IN_FLIGHT.has(r.board)).length, of: concurrency() },
    window: { spec: ctx.spec, valid: ctx.valid, open: ctx.open, nextChange: ctx.nextChange },
    quota: {
      parkedUntil: ctx.parkedUntil,
      lastParkAt: all<{ ts: number }>("SELECT MAX(ts) ts FROM events WHERE kind = 'quota_park'")[0]?.ts ?? null,
      accountPct: accountPct(now),
      weighted5h: weightedSince(now - QUOTA_WINDOW_MS),
      weightedToday: weightedSince(midnight),
    },
    // PAUSE-QUOTA is the quota park, shown as such; the rest are kill switches.
    pauses: existsSync(STATE) ? readdirSync(STATE).filter((f) => /^PAUSE/.test(f) && f !== basename(PAUSE_QUOTA)).sort() : [],
    leases: all<{ port: number; run_id: string; leased_at: number }>('SELECT * FROM port_leases ORDER BY port')
      .map((l) => ({ port: l.port, runId: l.run_id, leasedAt: l.leased_at })),
    active: activeViews,
    finished: views(finished, ctx),
    historyHours: hours,
  };
}

/** The newest run of a ticket, which is the one a bare `/run/:iid` means. */
export function latestRunId(iid: number): string | null {
  return all<{ run_id: string }>('SELECT run_id FROM runs WHERE iid = ? ORDER BY started_at DESC LIMIT 1', iid)[0]?.run_id ?? null;
}

export function phaseRuns(runId: string): PhaseRunRow[] {
  return all<PhaseRunRow>(
    'SELECT id, phase, lap, model, status, started_at, ended_at, turns, weighted, detail FROM phase_runs WHERE run_id = ? ORDER BY started_at, id', runId,
  ).map((p) => ({ ...p, detail: R(p.detail) }));
}

export interface EventRow { ts: number; kind: string; phase: string | null; detail: string | null }

export function recentEvents(runId: string, limit = 40): EventRow[] {
  return all<EventRow>(
    'SELECT ts, kind, phase, detail FROM events WHERE run_id = ? ORDER BY ts DESC LIMIT ?', runId, limit,
  ).map((e) => ({ ...e, detail: R(e.detail) }));
}

export interface PhaseTokens { phase: string; input: number; output: number; cacheRead: number; cacheCreation: number; weighted: number }

export function phaseTokens(runId: string): PhaseTokens[] {
  return all<PhaseTokens>(
    `SELECT COALESCE(phase, '—') phase, SUM(input) input, SUM(output) output, SUM(cache_read) cacheRead,
            SUM(cache_creation) cacheCreation, SUM(weighted) weighted
       FROM quota_usage WHERE run_id = ? GROUP BY phase ORDER BY MIN(ts)`, runId,
  );
}

export interface RunDetail {
  run: RunView;
  /** Every run of the same ticket, newest first, for switching between them. */
  runs: Array<{ runId: string; status: string; startedAt: number }>;
  phases: PhaseRunRow[];
  rollup: PhaseRollup[];
  tokens: PhaseTokens[];
  events: EventRow[];
}

/** One run of a ticket — `runId`, or the newest when null or not this ticket's. */
export function runDetail(iid: number, runId: string | null): RunDetail | null {
  const runs = all<{ run_id: string; status: string; started_at: number }>(
    'SELECT run_id, status, started_at FROM runs WHERE iid = ? ORDER BY started_at DESC', iid,
  ).map((r) => ({ runId: r.run_id, status: r.status, startedAt: r.started_at }));
  const id = runs.find((r) => r.runId === runId)?.runId ?? runs[0]?.runId;
  if (!id) return null;
  const row = all<RunRow>('SELECT * FROM runs WHERE run_id = ?', id)[0];
  if (!row) return null;
  const now = Date.now();
  const [run] = views([row], context(now, new Set(liveConductors(now).map((c) => c.id))));
  const phases = phaseRuns(id);
  return { run: run!, runs, phases, rollup: rollupPhases(phases, now), tokens: phaseTokens(id), events: recentEvents(id) };
}

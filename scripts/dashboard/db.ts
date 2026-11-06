/**
 * The dashboard's read-only view of state/oneshot.db.
 *
 * Read-only on purpose: the conductors own this file, and a dashboard that held
 * a write lock — or created an empty database where none exists yet — would be
 * the one thing on the page able to break a run. A missing DB is an empty fleet,
 * not an error.
 */
import Database from 'better-sqlite3';
import { existsSync, readdirSync } from 'node:fs';
import { DB_PATH, STATE } from '../../src/lib/config.js';
import { readJournal } from '../../src/lib/artifacts.js';
import { redact } from '../../src/lib/report.js';

const ALIVE_MS = 60_000;
const QUOTA_WINDOW_MS = 5 * 3600_000;
const ACTIVE = ['claimed', 'running', 'parked', 'blocked'];
const RECENT_FINISHED = 15;

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
  runId: string; iid: number; title: string; status: string; phase: string | null;
  url: string | null; mrUrl: string | null; mrIid: number | null;
  startedAt: number; endedAt: number | null; blockedWhy: string | null;
  owner: string | null; ownerSeenAt: number | null; ownerAlive: boolean;
  current: Array<{ phase: string; lap: number; startedAt: number }>;
}

export interface FleetState {
  now: number;
  dbFound: boolean;
  conductors: Array<{ id: string; pid: number; argv: string; startedAt: number; heartbeatAt: number }>;
  pauses: string[];
  leases: Array<{ port: number; runId: string; leasedAt: number }>;
  weighted5h: number;
  weightedToday: number;
  active: RunView[];
  finished: RunView[];
}

function liveConductors(now: number): FleetState['conductors'] {
  return all<{ conductor_id: string; pid: number; argv: string | null; started_at: number; heartbeat_at: number }>(
    'SELECT * FROM conductors WHERE ended_at IS NULL AND heartbeat_at > ? ORDER BY started_at', now - ALIVE_MS,
  ).map((c) => ({ id: c.conductor_id, pid: c.pid, argv: R(c.argv) ?? '', startedAt: c.started_at, heartbeatAt: c.heartbeat_at }));
}

const weightedSince = (ts: number): number =>
  all<{ w: number | null }>('SELECT SUM(weighted) w FROM quota_usage WHERE ts >= ?', ts)[0]?.w ?? 0;

function view(r: RunRow, alive: Set<string>): RunView {
  // The DB has no ticket or MR URL; the journal does. It only describes this run
  // if its runId matches — an older run of the same ticket has been archived.
  const j = readJournal(r.iid);
  const mine = j?.runId === r.run_id ? j : null;
  const current = all<{ phase: string; lap: number; started_at: number }>(
    "SELECT phase, lap, started_at FROM phase_runs WHERE run_id = ? AND status = 'running' ORDER BY started_at", r.run_id,
  ).map((p) => ({ phase: p.phase, lap: p.lap, startedAt: p.started_at }));
  return {
    runId: r.run_id, iid: r.iid, title: r.title ?? mine?.title ?? '', status: r.status, phase: r.phase,
    url: mine?.url ?? null, mrUrl: mine?.mrUrl ?? null, mrIid: r.mr_iid,
    startedAt: r.started_at, endedAt: r.ended_at, blockedWhy: R(r.blocked_why),
    owner: r.owner, ownerSeenAt: r.owner_seen_at, ownerAlive: !!r.owner && alive.has(r.owner), current,
  };
}

export function fleetState(): FleetState {
  const now = Date.now();
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const conductors = liveConductors(now);
  const alive = new Set(conductors.map((c) => c.id));
  const marks = ACTIVE.map(() => '?').join(',');
  const active = all<RunRow>(`SELECT * FROM runs WHERE status IN (${marks}) ORDER BY started_at DESC`, ...ACTIVE);
  const finished = all<RunRow>(
    `SELECT * FROM runs WHERE status NOT IN (${marks}) ORDER BY COALESCE(ended_at, started_at) DESC LIMIT ?`, ...ACTIVE, RECENT_FINISHED,
  );
  return {
    now,
    dbFound: open() !== null,
    conductors,
    pauses: existsSync(STATE) ? readdirSync(STATE).filter((f) => /^PAUSE/.test(f)).sort() : [],
    leases: all<{ port: number; run_id: string; leased_at: number }>('SELECT * FROM port_leases ORDER BY port')
      .map((l) => ({ port: l.port, runId: l.run_id, leasedAt: l.leased_at })),
    weighted5h: weightedSince(now - QUOTA_WINDOW_MS),
    weightedToday: weightedSince(midnight),
    active: active.map((r) => view(r, alive)),
    finished: finished.map((r) => view(r, alive)),
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

export function recentEvents(runId: string, limit = 40): Array<{ ts: number; kind: string; phase: string | null; detail: string | null }> {
  return all<{ ts: number; kind: string; phase: string | null; detail: string | null }>(
    'SELECT ts, kind, phase, detail FROM events WHERE run_id = ? ORDER BY ts DESC LIMIT ?', runId, limit,
  ).map((e) => ({ ...e, detail: R(e.detail) }));
}

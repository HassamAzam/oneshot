/**
 * SQLite state. Everything here is a CACHE and a LEDGER, never a source of
 * truth: GitLab owns ticket state, the filesystem owns run artifacts. Delete
 * state/oneshot.db and the next tick rebuilds what it needs from GitLab.
 *
 * WAL mode because the conductor, the Slack listener and the guardrail hooks
 * all open this file concurrently — the hooks via the `sqlite3` CLI, since
 * they must stay dependency-free.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { DB_PATH, STATE } from './config.js';

mkdirSync(STATE, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS runs (
  run_id      TEXT PRIMARY KEY,
  iid         INTEGER NOT NULL,
  title       TEXT,
  status      TEXT NOT NULL,            -- claimed|running|blocked|done|aborted
  phase       TEXT,
  branch      TEXT,
  worktree    TEXT,
  port        INTEGER,
  mr_iid      INTEGER,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  blocked_why TEXT,
  slack_ts    TEXT
);
CREATE INDEX IF NOT EXISTS runs_iid ON runs(iid);
CREATE INDEX IF NOT EXISTS runs_status ON runs(status);

CREATE TABLE IF NOT EXISTS phase_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL,
  phase       TEXT NOT NULL,
  lap         INTEGER NOT NULL DEFAULT 0,
  model       TEXT,
  status      TEXT NOT NULL,            -- running|ok|failed|skipped|refused
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  turns       INTEGER,
  weighted    INTEGER DEFAULT 0,
  session_id  TEXT,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS phase_runs_run ON phase_runs(run_id);

CREATE TABLE IF NOT EXISTS quota_usage (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  run_id      TEXT,
  phase       TEXT,
  model       TEXT,
  input       INTEGER DEFAULT 0,
  output      INTEGER DEFAULT 0,
  cache_creation INTEGER DEFAULT 0,
  cache_read  INTEGER DEFAULT 0,
  weighted    INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS quota_ts ON quota_usage(ts);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  run_id      TEXT,
  phase       TEXT,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS events_kind ON events(kind);

CREATE TABLE IF NOT EXISTS tickets_seen (
  iid         INTEGER PRIMARY KEY,
  title       TEXT,
  labels      TEXT,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  last_run_id TEXT
);
`);

const now = (): number => Date.now();

export function logEvent(
  kind: string,
  detail?: unknown,
  opts: { runId?: string; phase?: string } = {},
): void {
  db.prepare(
    'INSERT INTO events (ts, kind, run_id, phase, detail) VALUES (?, ?, ?, ?, ?)',
  ).run(now(), kind, opts.runId ?? null, opts.phase ?? null,
    detail === undefined ? null : JSON.stringify(detail));
}

export interface RunRow {
  run_id: string; iid: number; title: string | null; status: string;
  phase: string | null; branch: string | null; worktree: string | null;
  port: number | null; mr_iid: number | null; started_at: number;
  ended_at: number | null; blocked_why: string | null; slack_ts: string | null;
}

export function createRun(runId: string, iid: number, title: string): void {
  db.prepare(
    'INSERT INTO runs (run_id, iid, title, status, started_at) VALUES (?, ?, ?, ?, ?)',
  ).run(runId, iid, title, 'claimed', now());
}

export function updateRun(runId: string, fields: Partial<RunRow>): void {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const set = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => (fields as Record<string, unknown>)[k] ?? null);
  db.prepare(`UPDATE runs SET ${set} WHERE run_id = ?`).run(...values, runId);
}

export function getRun(runId: string): RunRow | undefined {
  return db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as RunRow | undefined;
}

/** Runs that are claimed or running — the in-flight set the queue respects. */
export function activeRuns(): RunRow[] {
  return db.prepare(
    "SELECT * FROM runs WHERE status IN ('claimed','running') ORDER BY started_at",
  ).all() as RunRow[];
}

/**
 * Bury the rows a dead conductor left behind. Returns how many were reaped.
 *
 * The PID-file singleton is what makes this safe: this process holds the lock,
 * so it is the only conductor, so every row still reading claimed/running at
 * boot belongs to one that died. Left alone such a row wedges dispatch
 * permanently — activeRuns() counts it against concurrency and isClaimed()
 * hides its ticket from the watcher, so each crash narrows the queue by one
 * until nothing is claimable at all and the console reports, truthfully and
 * uselessly, "no tickets carry the entry label".
 *
 * 'aborted' rather than 'blocked': the journal on disk is untouched, so the
 * next scan re-claims the ticket and the run resumes from the last phase that
 * actually succeeded.
 */
export function reconcileStaleRuns(): number {
  const info = db.prepare(
    "UPDATE runs SET status = 'aborted', ended_at = ? WHERE status IN ('claimed','running')",
  ).run(now());
  return info.changes;
}

/** True if this ticket already has an in-flight run — the whole claim protocol. */
export function isClaimed(iid: number): boolean {
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM runs WHERE iid = ? AND status IN ('claimed','running')",
  ).get(iid) as { n: number };
  return row.n > 0;
}

export function phaseStart(runId: string, phase: string, lap: number, model: string): number {
  const info = db.prepare(
    'INSERT INTO phase_runs (run_id, phase, lap, model, status, started_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(runId, phase, lap, model, 'running', now());
  return Number(info.lastInsertRowid);
}

export function phaseEnd(
  id: number,
  status: string,
  fields: { turns?: number; weighted?: number; sessionId?: string; detail?: unknown } = {},
): void {
  db.prepare(
    'UPDATE phase_runs SET status = ?, ended_at = ?, turns = ?, weighted = ?, session_id = ?, detail = ? WHERE id = ?',
  ).run(
    status, now(), fields.turns ?? null, fields.weighted ?? 0,
    fields.sessionId ?? null,
    fields.detail === undefined ? null : JSON.stringify(fields.detail),
    id,
  );
}

export function seeTicket(iid: number, title: string, labels: string[]): void {
  db.prepare(`
    INSERT INTO tickets_seen (iid, title, labels, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(iid) DO UPDATE SET title = excluded.title,
      labels = excluded.labels, last_seen = excluded.last_seen
  `).run(iid, title, JSON.stringify(labels), now(), now());
}

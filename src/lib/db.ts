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
import { log } from './log.js';
import { CONDUCTOR_TTL_MS, conductorLive } from './singleton.js';

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

CREATE TABLE IF NOT EXISTS conductors (
  conductor_id TEXT PRIMARY KEY,
  pid          INTEGER NOT NULL,
  argv         TEXT,
  started_at   INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  ended_at     INTEGER
);
CREATE INDEX IF NOT EXISTS conductors_heartbeat ON conductors(heartbeat_at);

CREATE TABLE IF NOT EXISTS port_leases (
  port        INTEGER PRIMARY KEY,
  run_id      TEXT NOT NULL,
  leased_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS port_leases_run ON port_leases(run_id);

CREATE TABLE IF NOT EXISTS promotion_lock (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  run_id      TEXT NOT NULL,
  owner       TEXT,
  acquired_at INTEGER NOT NULL
);
`);

const now = (): number => Date.now();

/**
 * Schema the original CREATE cannot express, because a database already exists.
 *
 * Additive only, and cheap enough to run on every open: ALTER TABLE ADD COLUMN
 * on SQLite rewrites no rows, and CREATE INDEX IF NOT EXISTS on an index that
 * is already there costs a catalogue lookup.
 */
function migrate(): void {
  const existing = new Set(
    (db.pragma('table_info(runs)') as Array<{ name: string }>).map((c) => c.name),
  );
  if (!existing.has('owner')) db.exec('ALTER TABLE runs ADD COLUMN owner TEXT');
  if (!existing.has('owner_seen_at')) db.exec('ALTER TABLE runs ADD COLUMN owner_seen_at INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS runs_owner ON runs(owner)');

  // The claim protocol's backstop. Ownership is what decides a claim; this
  // index is what makes a bug in that decision fail loudly at the INSERT rather
  // than quietly produce two conductors driving one ticket. It is partial on
  // purpose — a ticket accumulates as many finished rows as it has been
  // attempted, and only the in-flight one may be unique.
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_per_iid
      ON runs(iid) WHERE status IN ('claimed','running')`);
  } catch (err) {
    log.warn('could not create the active-run uniqueness index — a ticket already has two ' +
      'in-flight rows; run `npm run unblock` to bury them', { error: (err as Error).message });
  }
}

migrate();

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
  /** Which conductor drives this run. NULL means nobody claims it. */
  owner: string | null;
  /** Last time that conductor said so — the ledger half of the liveness test. */
  owner_seen_at: number | null;
}

/**
 * Write the row for a run this process is about to drive.
 *
 * Prefer claimTicket(): it does this INSERT with the ownership test around it,
 * which is the only way to be sure no peer is already on the ticket. This exists
 * for the path where the claim has already been decided — a resumption whose
 * database was wiped out from under a journal that survived.
 *
 * owner_seen_at is stamped even without an owner. An unowned row is reapable by
 * definition, and stamping it buys the TTL rather than having a peer bury a run
 * that started four statements ago.
 */
export function createRun(runId: string, iid: number, title: string, ownerId?: string): void {
  db.prepare(
    `INSERT INTO runs (run_id, iid, title, status, started_at, owner, owner_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(runId, iid, title, 'claimed', now(), ownerId ?? null, now());
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

/** Runs that are claimed or running, whoever owns them. */
export function activeRuns(): RunRow[] {
  return db.prepare(
    "SELECT * FROM runs WHERE status IN ('claimed','running') ORDER BY started_at",
  ).all() as RunRow[];
}

/**
 * The in-flight set the fleet's dispatch slots are measured against.
 *
 * Filtered to live owners, so a peer that died between ticks stops consuming
 * capacity the moment its heartbeat lapses rather than at the next boot, and
 * so slots can be a property of the machine rather than of each process.
 */
export function activeRunsFleet(): RunRow[] {
  const live = new Set(liveOwnerIds());
  return activeRuns().filter((r) => r.owner !== null && live.has(r.owner));
}

// ------------------------------------------------------------ the conductors

export interface ConductorRow {
  conductor_id: string; pid: number; argv: string | null;
  started_at: number; heartbeat_at: number; ended_at: number | null;
}

export function insertConductor(id: string, pid: number, argv: string[]): ConductorRow {
  const ts = now();
  const row: ConductorRow = {
    conductor_id: id, pid, argv: JSON.stringify(argv),
    started_at: ts, heartbeat_at: ts, ended_at: null,
  };
  db.prepare(
    `INSERT INTO conductors (conductor_id, pid, argv, started_at, heartbeat_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(row.conductor_id, row.pid, row.argv, row.started_at, row.heartbeat_at);
  return row;
}

/**
 * Say we are still here — for this conductor AND for every run it drives.
 *
 * The two move together deliberately. A conductor's heartbeat proves the
 * process is alive; owner_seen_at proves it is alive AND still standing behind
 * these particular rows. Refreshing one without the other gives a peer a
 * self-consistent reason to reap a run whose owner is answering perfectly well.
 */
export function touchConductor(id: string): void {
  const beat = db.transaction((): void => {
    const ts = now();
    db.prepare('UPDATE conductors SET heartbeat_at = ? WHERE conductor_id = ?').run(ts, id);
    db.prepare(
      "UPDATE runs SET owner_seen_at = ? WHERE owner = ? AND status IN ('claimed','running')",
    ).run(ts, id);
  });
  beat.immediate();
}

/**
 * Retire this conductor without deleting it.
 *
 * The row stays because the fleet's own history is worth keeping — it is what
 * tells a script whether this machine has ever run more than one conductor, and
 * therefore whether a log line needs to say which one it came from. Zeroing the
 * heartbeat is what makes it dead under the ordinary liveness rule, so nothing
 * has to learn a second one.
 */
export function endConductor(id: string): void {
  db.prepare('UPDATE conductors SET ended_at = ?, heartbeat_at = 0 WHERE conductor_id = ?')
    .run(now(), id);
}

/** Conductors that have not retired themselves. Liveness is decided by the caller. */
export function conductorRows(): ConductorRow[] {
  return db.prepare(
    'SELECT * FROM conductors WHERE ended_at IS NULL ORDER BY started_at',
  ).all() as ConductorRow[];
}

export function conductorsEverSeen(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM conductors').get() as { n: number }).n;
}

/**
 * The conductor ids answering right now.
 *
 * Computed in ordinary autocommit reads and never inside a transaction:
 * conductorLive() calls process.kill, and a syscall per row inside an IMMEDIATE
 * transaction would hold the write lock across the slowest thing in the
 * function while every peer's tick blocks behind it.
 */
function liveOwnerIds(): string[] {
  const at = now();
  return conductorRows()
    .filter((c) => conductorLive(c.pid, c.heartbeat_at, at))
    .map((c) => c.conductor_id);
}

// ------------------------------------------------------------ the claim

interface ActiveRow { run_id: string; owner: string | null }

function activeRowsFor(iid: number): ActiveRow[] {
  return db.prepare(
    "SELECT run_id, owner FROM runs WHERE iid = ? AND status IN ('claimed','running')",
  ).all(iid) as ActiveRow[];
}

/**
 * Bury one abandoned run, completely. Caller supplies the transaction.
 *
 * 'aborted' rather than 'blocked': the journal on disk is untouched, so the
 * ticket is claimable again and resumes from the last phase that succeeded.
 *
 * The two DELETEs are what makes it a bury rather than a relabel. A run holds a
 * port out of a three-wide pool and, in its promotion window, the mutex that
 * serialises merge→deploy→qa across the whole machine. Freeing the ticket while
 * leaving either behind retires a port permanently and hands the next run a
 * window held by a process that no longer exists — so they go together, in
 * whatever transaction the caller has already opened, or not at all.
 */
function buryRow(runId: string): void {
  db.prepare("UPDATE runs SET status = 'aborted', ended_at = ? WHERE run_id = ?")
    .run(now(), runId);
  db.prepare('DELETE FROM port_leases WHERE run_id = ?').run(runId);
  db.prepare('DELETE FROM promotion_lock WHERE run_id = ?').run(runId);
}

export type ClaimResult = 'claimed' | 'taken';

/**
 * Take a ticket, or find out somebody else already has it.
 *
 * One IMMEDIATE transaction, because a read-then-write pair is the whole
 * operation and a DEFERRED one does not merely lose the race — it throws
 * SQLITE_BUSY_SNAPSHOT without ever consulting busy_timeout, turning a silent
 * double-claim into an intermittent crash. IMMEDIATE takes the write lock up
 * front, so the loser waits and then reads the truth the winner wrote.
 *
 * "Already has it" is an OWNERSHIP test, not an existence test. An in-flight
 * row owned by a conductor that is gone is not a claim, it is litter, and
 * refusing on it is how a single crash used to narrow the queue by one ticket
 * permanently. So a dead owner's row is buried here and the ticket taken.
 *
 * The body stays tiny for the same reason it is IMMEDIATE: better-sqlite3 is
 * synchronous, so everything inside this transaction is time every peer spends
 * with its event loop stopped.
 */
export function claimTicket(
  iid: number, runId: string, title: string, ownerId: string,
): ClaimResult {
  const live = new Set(liveOwnerIds());
  const claim = db.transaction((): ClaimResult => {
    const rows = activeRowsFor(iid);
    if (rows.some((r) => r.owner !== null && live.has(r.owner))) return 'taken';
    for (const r of rows) buryRow(r.run_id);
    createRun(runId, iid, title, ownerId);
    return 'claimed';
  });
  return claim.immediate();
}

/**
 * Prove we may drive a run we did not just create.
 *
 * A resumption has to pass through the same gate as a fresh claim, and used not
 * to. The old check read "if this is not a resume, is the ticket claimed?" —
 * but a LIVE run's journal says 'running', which is exactly what makes a peer
 * decide it is resuming. Two conductors would both take the resume branch, skip
 * the claim entirely, and drive the same row. A uniqueness constraint cannot
 * catch that either: nothing is inserted, both are UPDATEs.
 *
 * Succeeding means the ticket's in-flight row is absent, already ours, or
 * owned by a conductor that is gone. Anything else belongs to a peer that is
 * still working, and the answer is no.
 *
 * The stamp at the end is a no-op when the row is missing — a journal can
 * outlive the database it was written beside — and the caller writes the row
 * itself in that case.
 */
export function claimOwnership(iid: number, runId: string, ownerId: string): boolean {
  const live = new Set(liveOwnerIds());
  const claim = db.transaction((): boolean => {
    const foreign = activeRowsFor(iid).filter((r) => r.owner !== ownerId);
    if (foreign.some((r) => r.owner !== null && live.has(r.owner))) return false;
    for (const r of foreign) if (r.run_id !== runId) buryRow(r.run_id);
    db.prepare('UPDATE runs SET owner = ?, owner_seen_at = ? WHERE run_id = ?')
      .run(ownerId, now(), runId);
    return true;
  });
  return claim.immediate();
}

/**
 * Bury what conductors that are gone left behind. Returns how many were reaped.
 *
 * Boot-time reconciliation used to abort every in-flight row on sight, which
 * was sound only while a second conductor was impossible. With a fleet the same
 * statement is an act of sabotage against two healthy peers, so the test is now
 * "not one of ours, and cold" — both halves, since a live owner is protected by
 * the first and a conductor briefly blocked inside a synchronous write is
 * protected by neither if the second stands alone.
 *
 * buryRow takes the run's port lease and promotion window with it, in this
 * transaction, so there is no window where the ticket is free and the resources
 * it was holding are not.
 */
export function reconcileForeignRuns(liveIds: string[]): number {
  const live = new Set(liveIds);
  const cutoff = now() - CONDUCTOR_TTL_MS;
  const reap = db.transaction((): number => {
    const rows = db.prepare(
      "SELECT run_id, owner, owner_seen_at FROM runs WHERE status IN ('claimed','running')",
    ).all() as Array<{ run_id: string; owner: string | null; owner_seen_at: number | null }>;

    const dead = rows.filter((r) => !(r.owner !== null && live.has(r.owner))
      && (r.owner_seen_at ?? 0) < cutoff);

    for (const r of dead) buryRow(r.run_id);
    return dead.length;
  });
  return reap.immediate();
}

/**
 * True if a LIVE conductor is on this ticket.
 *
 * What the watcher needs in order to skip a ticket, and deliberately not what
 * the claim uses: a row left by a conductor that died is not a reason to hide a
 * ticket from the board, it is a reason to reap the row and claim it.
 */
export function isClaimed(iid: number): boolean {
  const live = new Set(liveOwnerIds());
  return activeRowsFor(iid).some((r) => r.owner !== null && live.has(r.owner));
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

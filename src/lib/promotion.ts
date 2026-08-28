/**
 * The merge → deploy → qa window, held by exactly one run at a time — on this
 * machine, not merely in this process.
 *
 * Everything else in this pipeline may pipeline freely; this stretch may not.
 * The deploy script ships the TIP of a branch rather than a SHA, so if a second
 * run merges into the base while the first is between its merge and its QA, the
 * demo box carries both changes and the QA verdict stops being attributable to
 * either ticket.
 *
 * It used to be an in-process FIFO, justified by the conductor being a
 * singleton. That justification is gone: several conductors now share this
 * machine on purpose, and a mutex living in one process's heap is invisible to
 * the other two. So the lease is a row, and everything that follows is a
 * consequence of SQLite having neither fairness nor condition variables:
 *
 *   The QUEUE is explicit. A row per waiter with an AUTOINCREMENT key, because
 *   nothing about contending on a lock decides who gets it next — without the
 *   queue, three runs racing for one window would be served in whatever order
 *   their polls happened to land, and a long ticket could starve behind two
 *   short ones indefinitely.
 *
 *   The WAIT is a poll. There is no way to be woken by a row, and the
 *   alternative — blocking on the database until it is free — is worse than
 *   useless here: better-sqlite3 is synchronous, so a blocked acquire would
 *   freeze the conductor's tick, its abort signal and its Slack card for the
 *   duration.
 *
 *   Every read-then-write is IMMEDIATE. A deferred transaction takes its
 *   snapshot on the read and discovers the conflict on the write, which SQLite
 *   answers instantly with SQLITE_BUSY_SNAPSHOT rather than by waiting — so the
 *   deferred version of this file would trade a silent double-grant for an
 *   intermittent crash.
 *
 * The lock stays re-entrant per run and is still held ACROSS a qa → implement
 * cycle lap on purpose: the box is carrying this run's half-fixed change until
 * its QA passes, and admitting another ticket into that window would destroy the
 * attribution the lock exists to protect.
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PAUSE_DEPLOY, STATE } from './config.js';
import { readJournal } from './artifacts.js';
import { db, logEvent } from './db.js';
import { liveConductorIds } from './fleet.js';
import { log } from './log.js';

/**
 * The queue, and the two columns the lease needs that src/lib/db.ts does not
 * declare on it.
 *
 * promotion_lock is created there because burying a run has to take its window
 * with it in the same transaction. The columns are added here instead of moved
 * there because a database predating the fleet already exists on this machine —
 * ADD COLUMN on SQLite rewrites no rows, and the duplicate on the second open is
 * the expected answer rather than a failure.
 *
 * The single row is enforced by CHECK (id = 1) rather than by convention: there
 * is one demo box, so a second promotion row could only ever mean the invariant
 * had already been lost somewhere else.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS promotion_waiters (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT NOT NULL UNIQUE,
  iid        INTEGER NOT NULL,
  conductor  TEXT NOT NULL,
  since      INTEGER NOT NULL
);
`);

for (const column of ['iid INTEGER NOT NULL DEFAULT 0', 'renewed_at INTEGER NOT NULL DEFAULT 0']) {
  try {
    db.exec(`ALTER TABLE promotion_lock ADD COLUMN ${column}`);
  } catch { /* already present */ }
}

/**
 * How long a lease may go un-renewed before a live conductor may take it.
 *
 * Generous against the renewal interval (one heartbeat, 60s) rather than
 * against how long a promotion takes, because it is not a deadline for the
 * work — the holder renews for as long as it lives, however long its QA runs.
 * It only bounds how long a DEAD holder's window stays shut.
 */
const LEASE_TTL_MS = 5 * 60_000;

/** How often a waiter asks. Fast enough not to add latency, idle enough to ignore. */
const POLL_MS = 3_000;

const DEPLOY_LOCK = join(STATE, 'DEPLOY-LOCK');

export interface PromotionClaim {
  runId: string;
  iid: number;
  conductor: string;
}

interface LeaseRow {
  run_id: string;
  iid: number;
  owner: string | null;
  acquired_at: number;
  renewed_at: number;
}

function readLease(): LeaseRow | undefined {
  return db.prepare('SELECT * FROM promotion_lock WHERE id = 1').get() as LeaseRow | undefined;
}

export function promotionHolder(): string | null {
  return readLease()?.run_id ?? null;
}

// ------------------------------------------------------------- the projection

/**
 * state/DEPLOY-LOCK, as hooks/deploy-guard.cjs reads it.
 *
 * A PROJECTION of the lease and never a second source of truth: written when
 * the window is granted, refreshed by the same heartbeat that renews the row,
 * removed when it is released. The guard — not this module — is what a session's
 * `Bash` call actually meets, so without the file the whole cross-process
 * guarantee stops at the conductor's own front door.
 *
 * `since` carries the RENEWAL rather than the grant, because the guard treats a
 * lock older than the deploy deadline as stale. Stamping it once at grant time
 * would make a legitimately long window look abandoned halfway through; stamping
 * it every heartbeat makes staleness mean the only thing worth meaning — that
 * whoever holds this has stopped breathing.
 *
 * Being a projection is also what makes it safe for db.ts to delete a lease row
 * without saying so: nothing renews the file after that, so it ages past the
 * deploy deadline on its own, and the next conductor granted the window
 * overwrites it outright. Every intermediate state denies rather than permits.
 */
function project(lease: LeaseRow): void {
  try {
    writeFileSync(DEPLOY_LOCK, `${JSON.stringify({
      runId: lease.run_id,
      iid: lease.iid,
      conductor: lease.owner,
      pid: process.pid,
      grantedAt: lease.acquired_at,
      since: lease.renewed_at,
    })}\n`);
  } catch (err) {
    log.warn('could not write state/DEPLOY-LOCK', { error: (err as Error).message });
  }
}

function unproject(runId: string): void {
  try {
    if (!existsSync(DEPLOY_LOCK)) return;
    rmSync(DEPLOY_LOCK, { force: true });
  } catch (err) {
    log.warn('could not remove state/DEPLOY-LOCK', { runId, error: (err as Error).message });
  }
}

// ------------------------------------------------------------------ acquiring

/**
 * One attempt at the window: re-entry, or the head of the queue taking a free
 * lease, or joining the queue.
 *
 * Tiny and exclusive, and the two are the same requirement — this runs inside a
 * write lock on a synchronous database, so every statement in here is time no
 * conductor on this machine is doing anything else. That is also why the
 * liveness roll call arrives as an argument: deciding who is alive is a query,
 * and it belongs outside the lock that everybody is waiting behind. Judging a
 * lease BREAKABLE is outside for the same reason and one more — it reads the
 * orphan's journal off disk.
 *
 * Waiters belonging to conductors that are gone are dropped on the way past.
 * The queue is the only thing here with no owner watching it: a run buried by
 * reconciliation never reaches its own release, and one abandoned row at the
 * head of a FIFO stops the window from ever being granted again.
 */
const attempt = db.transaction((claim: PromotionClaim, live: string[]): 'granted' | 'waiting' => {
  const now = Date.now();
  const lease = readLease();

  if (lease?.run_id === claim.runId) {
    db.prepare('UPDATE promotion_lock SET renewed_at = ? WHERE id = 1').run(now);
    return 'granted';
  }

  const holes = live.map(() => '?').join(', ');
  db.prepare(`DELETE FROM promotion_waiters WHERE conductor NOT IN (${holes})`).run(...live);

  const enqueue = (): void => {
    db.prepare(`INSERT OR IGNORE INTO promotion_waiters (run_id, iid, conductor, since)
      VALUES (?, ?, ?, ?)`).run(claim.runId, claim.iid, claim.conductor, now);
  };

  if (lease) {
    enqueue();
    return 'waiting';
  }

  const head = db.prepare('SELECT run_id FROM promotion_waiters ORDER BY seq LIMIT 1')
    .get() as { run_id: string } | undefined;
  if (head && head.run_id !== claim.runId) {
    enqueue();
    return 'waiting';
  }

  db.prepare(`INSERT INTO promotion_lock (id, run_id, iid, owner, acquired_at, renewed_at)
    VALUES (1, ?, ?, ?, ?, ?)`).run(claim.runId, claim.iid, claim.conductor, now, now);
  db.prepare('DELETE FROM promotion_waiters WHERE run_id = ?').run(claim.runId);
  return 'granted';
});

/**
 * Whether a run that is not answering may have its window taken.
 *
 * Both conditions, never either. A TTL alone would break the lease of a healthy
 * holder whose QA legitimately outran it; liveness alone would break the lease
 * of a conductor that died one second ago, before anything had a chance to
 * notice and before its own restart could resume the run.
 */
function breakable(lease: LeaseRow, live: string[]): boolean {
  if (Date.now() - lease.renewed_at < LEASE_TTL_MS) return false;
  return lease.owner === null || !live.includes(lease.owner);
}

/**
 * What an abandoned window may have left on the demo box.
 *
 * A holder that got as far as a merge but never as far as a QA pass has put a
 * change on the base branch that nothing has attributed to anything — and the
 * deploy script ships a branch tip, so the next deploy carries it whether or not
 * that ticket is involved. Handing the window on without saying so is how a
 * later run's QA verdict quietly becomes a verdict on two tickets.
 *
 * PAUSE-DEPLOY rather than a log line, because this is exactly the situation the
 * deploy hold exists for: everything else continues, and the one irreversible
 * phase waits for a person who can look at what is on the box.
 */
function holdIfUnattributed(lease: LeaseRow): void {
  const journal = readJournal(lease.iid);
  if (!journal?.mergedSha) return;
  const qaPassed = journal.phases.some(
    (rec) => rec.phase === 'qa' && (rec.status === 'ok' || rec.status === 'warned'),
  );
  if (qaPassed) return;

  try {
    writeFileSync(PAUSE_DEPLOY, `${JSON.stringify({
      why: `#${lease.iid} merged ${journal.mergedSha} and its promotion window was abandoned ` +
        'before QA passed — the demo box may be carrying an unattributed change',
      runId: lease.run_id,
      iid: lease.iid,
      conductor: lease.owner,
      checked_at: Date.now(),
    }, null, 2)}\n`);
  } catch (err) {
    log.warn('could not write state/PAUSE-DEPLOY', { error: (err as Error).message });
  }
  log.error(`#${lease.iid} left the promotion window merged but un-QA'd — deploys are held`, {
    mergedSha: journal.mergedSha.slice(0, 8),
  });
  logEvent('promotion_orphan_hold', { iid: lease.iid, runId: lease.run_id }, { runId: lease.run_id });
}

/**
 * Take the window back from a dead holder.
 *
 * Conditioned on the renewal it was judged against, so a holder that came back
 * to life between the liveness check and this statement keeps what is his: the
 * DELETE simply matches nothing and the caller polls again.
 */
function reclaim(lease: LeaseRow): void {
  holdIfUnattributed(lease);
  const taken = db.prepare(
    'DELETE FROM promotion_lock WHERE id = 1 AND run_id = ? AND renewed_at = ?',
  ).run(lease.run_id, lease.renewed_at).changes > 0;
  if (!taken) return;

  unproject(lease.run_id);
  log.warn('broke an abandoned promotion lease', {
    holder: lease.run_id, conductor: (lease.owner ?? 'unowned').slice(0, 6),
    idleMin: Math.round((Date.now() - lease.renewed_at) / 60_000),
  });
  logEvent('promotion_lease_broken', {
    holder: lease.run_id, iid: lease.iid, conductor: lease.owner,
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/**
 * Hold the window, waiting our turn if somebody else has it.
 *
 * Returns false when the run was told to stop before its turn came — a queued
 * run must not be dragged through a merge just because it finally reached the
 * head of a queue nobody is waiting on any more.
 */
export async function acquirePromotion(
  claim: PromotionClaim, opts: { signal?: AbortSignal } = {},
): Promise<boolean> {
  let announced = false;

  for (;;) {
    if (opts.signal?.aborted) {
      dequeue(claim.runId);
      return false;
    }

    // This conductor is by definition live and may not have registered — the
    // --ticket path and the scripts both reach here — so it is added to the roll
    // call rather than looked up in it. Without that its own waiter row would be
    // pruned by the transaction it is queueing in.
    const live = [...new Set([claim.conductor, ...liveConductorIds()])];

    if (attempt.immediate(claim, live) === 'granted') {
      const lease = readLease();
      if (lease) project(lease);
      if (announced) log.ok(`#${claim.iid} has the promotion window`);
      return true;
    }

    const lease = readLease();
    if (lease && breakable(lease, live)) {
      reclaim(lease);
      continue;
    }

    if (!announced) {
      announced = true;
      const queued = db.prepare('SELECT COUNT(*) AS n FROM promotion_waiters')
        .get() as { n: number };
      log.info(`waiting for the promotion window — held by ${lease?.run_id ?? 'a run that just let go'}`, {
        queued: queued.n,
      });
    }
    await sleep(POLL_MS, opts.signal);
  }
}

// ------------------------------------------------------------------ releasing

function dequeue(runId: string): void {
  db.prepare('DELETE FROM promotion_waiters WHERE run_id = ?').run(runId);
}

/**
 * Renew every lease this conductor holds. Called from the heartbeat, and only
 * ever by the owner — a renewal is the one signal that separates a long
 * promotion from an abandoned one, so a process renewing somebody else's lease
 * would keep a dead run's window shut forever.
 */
export function renewPromotion(conductor: string): void {
  const renewed = db.prepare('UPDATE promotion_lock SET renewed_at = ? WHERE owner = ?')
    .run(Date.now(), conductor).changes > 0;
  if (!renewed) return;
  const lease = readLease();
  if (lease) project(lease);
}

/**
 * Let go of the window.
 *
 * ONE conditional statement, so finish() can call it blindly and a run can never
 * release a lease it does not hold: with a single row keyed on id = 1, `WHERE
 * run_id = ?` is both the ownership test and the release. The read-then-delete
 * this replaces was a genuine hazard once conductors multiplied — between the
 * read and the delete the lease can have been broken and re-granted, and the
 * departing run would then have freed the new holder's window.
 */
export function releasePromotion(runId: string): void {
  const released = db.prepare('DELETE FROM promotion_lock WHERE run_id = ?').run(runId).changes > 0;
  dequeue(runId);
  if (!released) return;
  unproject(runId);
  logEvent('promotion_released', { runId }, { runId });
}

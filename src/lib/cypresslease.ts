/**
 * One Cypress run on this desk at a time — across every conductor sharing it,
 * not merely within one process.
 *
 * `local-tests-run` copies the automation database, builds the ticket's app and
 * drives a browser through up to `maxSpecs` specs for up to `maxRunMinutes`.
 * Two of those at once on one laptop do not each take twice as long; they take
 * each other down — two webpack builds on one shared node_modules, two
 * Electrons fighting for the CPU until specs time out, and two template copies
 * racing for the same baseline, which Postgres refuses while anything is
 * connected to it. A failure that comes from the desk being busy reads, on
 * the ticket, exactly like a regression, and the developer approving the
 * results cannot tell the two apart. So the run step holds this lease for as
 * long as Cypress is up.
 *
 * Modelled on the promotion window (src/lib/promotion.ts) and simpler on
 * purpose. There is no queue and no wait: a run that finds the desk busy is
 * told so and decides for itself — the run step reports it and tries again on
 * a later tick — because a local test run is worth waiting minutes for, never
 * worth freezing a conductor's tick behind. And there is no renewal: the
 * conductor kills a run at a hard deadline (runDeadlineMs), so the age of a
 * lease alone says whether its holder has overrun, with no heartbeat to keep
 * honest.
 *
 * A lease is reclaimed when EITHER its holder's process is gone OR it is older
 * than the conductor's own kill deadline for the run plus a margin
 * (leaseMaxAgeMs). Either, unlike the promotion window's both: a promotion's
 * holder may legitimately run as long as it likes and renews to prove it,
 * while nothing legitimate holds this one past the moment the conductor kills
 * the script and cleans up after it. The pid half is what frees the desk the
 * moment a conductor is killed mid-run; the age half is what frees it when
 * that pid has since been handed to something else.
 *
 * The age limit and the kill are computed HERE, from the same numbers, and the
 * run step (src/conductor/localtests.ts) imports both. They used to be two
 * sums in two files — the kill at max(maxRunMinutes + 15, timeoutMin 120), the
 * lease at maxRunMinutes + 60 = 105 — so a second conductor took the lease
 * from a run still in its base re-run, and its own script then failed against
 * the first one's app.
 *
 * Every read-then-write is IMMEDIATE, for the reason promotion.ts gives: a
 * deferred transaction answers a race with SQLITE_BUSY_SNAPSHOT instead of
 * waiting. The liveness test stays outside it — it is a syscall, and the write
 * lock is time every peer on this desk spends with its event loop stopped.
 */
import { localTestsConfig, phaseByName } from './config.js';
import { db, logEvent } from './db.js';
import { log } from './log.js';
import { pidAlive } from './singleton.js';

/**
 * Minutes past `maxRunMinutes` before the conductor kills the script. The
 * script stops Cypress itself at `maxRunMinutes`; this is for the database
 * copy, the app build and the cleanup around it, and for a script that hangs.
 */
export const RUN_GRACE_MIN = 15;

/** How long a killed `run` group gets between SIGTERM and SIGKILL. The run's cleanup is the reason it is not shorter. */
export const RUN_KILL_GRACE_MS = 30_000;

/**
 * What the conductor still does with the lease held once the script is gone:
 * the start note before it (a GitLab round trip), the second kill grace a group
 * that keeps its pipes open is given, and the gc after a run that did not
 * finish cleanly. Generous, because a lease taken early fails a live run.
 */
const LEASE_MARGIN_MS = 10 * 60_000;

/**
 * The conductor's own wall clock for a `run` call: the script's deadline plus
 * RUN_GRACE_MIN, and never less than `floorMin` — local-tests-run's
 * `timeoutMin` in config/phases.json.
 *
 * The floor is there because the script's deadline bounds each CYPRESS run,
 * not the script: around it the script copies the database, migrates, builds
 * the ticket's app (25 minutes allowed cold) and, when tests failed, builds the
 * base app and re-runs the failures. A kill at the Cypress deadline plus a
 * quarter of an hour would cut exactly the runs that took the most building,
 * and would usually land in the base re-run that answers "is this failure mine?".
 */
export function runDeadlineMs(deadlineMin: number, floorMin = 0): number {
  return Math.max(deadlineMin + RUN_GRACE_MIN, floorMin) * 60_000;
}

/** runDeadlineMs for this desk: `deadlineMin` against local-tests-run's configured timeoutMin. */
export function localTestsRunDeadlineMs(deadlineMin = localTestsConfig().maxRunMinutes): number {
  return runDeadlineMs(deadlineMin, phaseByName('local-tests-run')?.timeoutMin ?? 0);
}

interface LeaseRow {
  run_id: string;
  pid: number;
  acquired_at: number;
}

function readLease(): LeaseRow | undefined {
  return db.prepare('SELECT run_id, pid, acquired_at FROM cypress_lease WHERE id = 1')
    .get() as LeaseRow | undefined;
}

/** Who holds the desk's Cypress lease right now, or null. For status lines. */
export function cypressLeaseHolder(): { runId: string; pid: number; acquiredAt: number } | null {
  const lease = readLease();
  return lease ? { runId: lease.run_id, pid: lease.pid, acquiredAt: lease.acquired_at } : null;
}

/**
 * How old a lease may be before it is taken whatever its pid says: the
 * moment the conductor kills its holder's script (localTestsRunDeadlineMs),
 * plus that kill's grace, plus LEASE_MARGIN_MS for what the conductor does with
 * the lease around the script. Nothing legitimate holds it longer, and nothing
 * legitimate is still running when it is taken.
 *
 * Read at call time, so a policy change applies to the next attempt. An
 * unusable `maxRunMinutes` reads as 0 from localTestsConfig(), which leaves the
 * phase's timeoutMin floor (or RUN_GRACE_MIN) and the margin.
 */
export function leaseMaxAgeMs(): number {
  return localTestsRunDeadlineMs() + RUN_KILL_GRACE_MS + LEASE_MARGIN_MS;
}

/**
 * One attempt: re-entry, or taking a free lease.
 *
 * Re-entry re-stamps the pid and the clock. The same run asking again is
 * either a retry inside one process or a conductor resuming the run after a
 * restart, and in the second case the recorded pid is the dead predecessor's —
 * leaving it would have the next caller reclaim a lease its owner is using.
 */
const attempt = db.transaction((runId: string, pid: number): 'granted' | 'busy' => {
  const now = Date.now();
  const lease = readLease();
  if (lease?.run_id === runId) {
    db.prepare('UPDATE cypress_lease SET pid = ?, acquired_at = ? WHERE id = 1').run(pid, now);
    return 'granted';
  }
  if (lease) return 'busy';
  db.prepare('INSERT INTO cypress_lease (id, run_id, pid, acquired_at) VALUES (1, ?, ?, ?)')
    .run(runId, pid, now);
  return 'granted';
});

/** Dead holder, or one past any deadline it could have had. See the module comment. */
function stale(lease: LeaseRow): boolean {
  return !pidAlive(lease.pid) || Date.now() - lease.acquired_at > leaseMaxAgeMs();
}

/**
 * Take the lease back from a stale holder.
 *
 * Conditioned on the exact grant it was judged against, so a holder that
 * re-entered between the judgement and this statement keeps its lease: the
 * DELETE matches nothing and the caller is told the desk is busy.
 */
function reclaim(lease: LeaseRow, claimant: string): boolean {
  const taken = db.prepare(
    'DELETE FROM cypress_lease WHERE id = 1 AND run_id = ? AND acquired_at = ?',
  ).run(lease.run_id, lease.acquired_at).changes > 0;
  if (!taken) return false;

  const ageMin = Math.round((Date.now() - lease.acquired_at) / 60_000);
  log.warn('broke an abandoned Cypress lease', { holder: lease.run_id, pid: lease.pid, ageMin });
  logEvent('cypress_lease_broken', {
    holder: lease.run_id, pid: lease.pid, ageMin, claimant,
  }, { runId: lease.run_id });
  return true;
}

/**
 * Hold the desk's Cypress lease. True when this run now holds it (or already
 * did), false when another live run is using Cypress.
 *
 * Async so a caller can await it beside the rest of the run step's setup, and
 * so a later version may wait without changing a single caller. The loop is
 * bounded: past one reclaim, a lease that keeps changing hands is a busy desk,
 * not a reason to spin.
 */
export async function acquireCypressLease(runId: string): Promise<boolean> {
  for (let tries = 0; tries < 3; tries += 1) {
    if (attempt.immediate(runId, process.pid) === 'granted') return true;

    const lease = readLease();
    // Released between the attempt and this read: ask again.
    if (!lease) continue;
    if (!stale(lease) || !reclaim(lease, runId)) return false;
  }
  return false;
}

/**
 * Let go of the lease.
 *
 * ONE conditional statement, for the reason releasePromotion() gives: the
 * caller's cleanup can run it blindly, twice, or after the lease was reclaimed
 * and granted to somebody else, and it can never free a lease this run does
 * not hold.
 */
export function releaseCypressLease(runId: string): void {
  const released = db.prepare('DELETE FROM cypress_lease WHERE run_id = ?').run(runId).changes > 0;
  if (!released) return;
  logEvent('cypress_lease_released', { runId }, { runId });
}

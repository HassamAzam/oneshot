/**
 * The conductor fleet: who is running on this machine right now.
 *
 * The design used to be one conductor, enforced by a PID file, and the promotion
 * mutex and the claim protocol were both written against that assumption. The
 * operator wants three sessions instead, each on a different ticket, which does
 * not weaken the guarantee that matters — one conductor per TICKET — it just
 * moves it. A refusal at boot cannot express it; a registry can.
 *
 * So this table is the answer to the only question the rest of the system
 * actually asks: given a run row that says somebody is working on ticket #N,
 * is that somebody still there? Every claim, every reap and every dispatch slot
 * resolves to that, and resolves it against rows rather than against a file.
 *
 * Liveness is computed HERE, outside every transaction, and passed in as a list
 * of ids. process.kill is a syscall, better-sqlite3 is synchronous, and holding
 * the write lock across one syscall per conductor would stop the event loop of
 * every peer waiting behind it — including the tick timer, the abort signal and
 * the Slack card that are the operator's only evidence anything is alive.
 */
import {
  ConductorRow, conductorRows, conductorsEverSeen, endConductor, insertConductor, touchConductor,
} from './db.js';
import { newRunId } from './ids.js';
import { clearMarker, conductorLive, writeMarker } from './singleton.js';

export type Conductor = ConductorRow;

let self: Conductor | null = null;

/**
 * Enter the fleet.
 *
 * The id comes from the run-id generator because identity here needs exactly
 * what it gives: derived from the clock, sortable by start, and unique without
 * coordination — three conductors booting from one `npm start &&` line still
 * get three ids.
 *
 * Idempotent, so a second call cannot leave this process holding two rows and
 * counting itself twice against the fleet's own slots.
 */
export function register(): Conductor {
  if (self) return self;
  const argv = process.argv.slice(2);
  const id = newRunId();
  self = insertConductor(id, process.pid, argv);
  writeMarker({ conductorId: id, pid: process.pid, startedAt: self.started_at, argv });
  return self;
}

/** Called from the tick loop. Silent before register(), so a script can call it. */
export function heartbeat(): void {
  if (!self) return;
  touchConductor(self.conductor_id);
}

/**
 * Leave the fleet on the way out.
 *
 * The row is retired rather than deleted — see endConductor. What must not
 * survive is the appearance of liveness, because the runs this conductor was
 * driving are only reapable once it stops answering, and a shutdown that waited
 * out its own TTL would leave those tickets frozen for five minutes.
 */
export function deregister(): void {
  if (!self) return;
  endConductor(self.conductor_id);
  clearMarker(self.conductor_id);
  self = null;
}

/** This process's registry row, or null before register(). */
export function selfConductor(): Conductor | null {
  return self;
}

/** The owner id every claim is made under. */
export function selfId(): string | null {
  return self ? self.conductor_id : null;
}

/**
 * Everyone answering right now, this process included once it has registered.
 *
 * The liveness rule is conjunctive and lives in singleton.ts; see the comment
 * there for why neither half is sufficient alone.
 */
export function liveConductors(): Conductor[] {
  const at = Date.now();
  return conductorRows().filter((c) => conductorLive(c.pid, c.heartbeat_at, at));
}

/** The argument reconcileForeignRuns() wants: reap anything owned by nobody in here. */
export function liveConductorIds(): string[] {
  return liveConductors().map((c) => c.conductor_id);
}

/**
 * Is any conductor up?
 *
 * For the scripts, which never register and so are never counted among the
 * live: preflight and unblock repair state by deciding from the runs table what
 * is abandoned, and that reasoning is only sound while nothing is writing to it.
 */
export function anyLive(): boolean {
  return liveConductors().length > 0;
}

/**
 * Has this machine ever run more than one conductor?
 *
 * The question behind it is presentational: a single-conductor machine should
 * not have every log line prefixed with which conductor said it, and a fleet
 * machine is unreadable without it. Answered from the whole history rather than
 * from who is live, so the prefix does not appear and disappear as peers come
 * and go mid-session.
 */
export function peersEverSeen(): boolean {
  return conductorsEverSeen() > 1;
}

/**
 * How this machine decides a conductor is gone, and the marker file that tells
 * a human where to look.
 *
 * This module used to be the whole concurrency story: a PID file that refused
 * the second conductor outright. Refusal cannot express what the operator
 * actually wants — three sessions, each working a different ticket — so the
 * conductors table in db.ts carries the fleet now. What survives here is the
 * part that was always correct, and one thing that never was.
 *
 * LIVENESS. It lives here so exactly one definition of "alive" exists, and it
 * is CONJUNCTIVE. A pid test alone is not enough: a SIGKILLed conductor's pid
 * is free for the OS to hand to anything, and a stranger's process answering
 * signal 0 would keep a dead conductor's tickets hostage forever — while also
 * making the heartbeat dead code nobody notices has stopped. A heartbeat alone
 * is not enough either: better-sqlite3 is synchronous, so a contended write
 * blocks the tick timer, and a conductor that is merely busy must not be
 * declared dead by a peer that is about to reap its runs. Both, or gone.
 *
 * THE MARKER. state/conductor.pid survives as a hint, not a lock. With a fleet
 * it is last-writer-wins by construction: three conductors write it and only
 * the third is named. That is fine for `ls state/` and fatal for anything else,
 * so nothing in the claim protocol may read it — the conductors table is the
 * record, and it is the only record.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE } from './config.js';
import type { Conductor } from './fleet.js';

const MARKER = join(STATE, 'conductor.pid');

/**
 * How long a conductor may go silent before the fleet treats it as gone.
 *
 * Five minutes against a 60s tick is not slack, it is the synchronous-write
 * reality: an IMMEDIATE transaction losing a race blocks the event loop for up
 * to busy_timeout, and one `git` call inside a phase can hold the process for
 * minutes with the timer frozen behind it. A tight TTL would have peers reaping
 * each other's healthy mid-phase runs — the exact failure the registry exists
 * to prevent.
 */
export const CONDUCTOR_TTL_MS = 300_000;

/** Signal 0 tests for existence without touching the process. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The conjunctive rule. Both halves, never one — see the module comment. */
export function conductorLive(pid: number, heartbeatAt: number, at = Date.now()): boolean {
  return pidAlive(pid) && at - heartbeatAt < CONDUCTOR_TTL_MS;
}

export interface ConductorMarker {
  conductorId: string;
  pid: number;
  startedAt: number;
  argv: string[];
}

/**
 * Best effort in the strict sense: a failure to write it is not a failure to
 * start. Nothing reads this to decide anything, so an unwritable state
 * directory must not cost the operator a conductor.
 */
export function writeMarker(marker: ConductorMarker): void {
  try {
    mkdirSync(STATE, { recursive: true });
    writeFileSync(MARKER, JSON.stringify(marker, null, 2));
  } catch { /* advisory only */ }
}

export function readMarker(): ConductorMarker | null {
  if (!existsSync(MARKER)) return null;
  try {
    return JSON.parse(readFileSync(MARKER, 'utf8')) as ConductorMarker;
  } catch {
    return null;
  }
}

/**
 * Clear the marker only when it still names us.
 *
 * A conductor that started after this one owns the file by then, and deleting
 * it on the way out would erase a live peer's only visible trace.
 */
export function clearMarker(conductorId: string): void {
  try {
    const held = readMarker();
    if (held && held.conductorId === conductorId) rmSync(MARKER, { force: true });
  } catch { /* nothing to clear */ }
}

export interface SoloRefusal {
  ok: boolean;
  heldBy?: Conductor;
}

/**
 * The old one-per-machine guarantee, kept for `--solo`.
 *
 * A fleet is the default because tickets are independent. `--solo` is for the
 * times they are not — a migration renumber, a base-branch move, anything where
 * a second conductor working a second ticket would be working against this one.
 *
 * Decided from the registry the caller passes in rather than from the marker
 * file, because the marker names at most one conductor and the whole point here
 * is to notice the other two.
 */
export function refuseIfAnotherConductor(peers: Conductor[], selfId?: string): SoloRefusal {
  const other = peers.find((c) => c.conductor_id !== selfId && c.pid !== process.pid);
  return other ? { ok: false, heldBy: other } : { ok: true };
}

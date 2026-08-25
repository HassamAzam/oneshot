/**
 * One conductor per machine, enforced.
 *
 * The design says "one process with a queue, so consensus is not a problem".
 * That is true of the intended path and false in practice: a `kill` on an
 * `npm start` wrapper leaves its tsx CHILD alive, and an orphaned conductor
 * keeps ticking every 60s. Two of them ran here simultaneously and both posted
 * a claim note on the same ticket.
 *
 * So "one process" has to be a guarantee, not an assumption. This is that
 * guarantee: a PID file holding a live process refuses the second start.
 *
 * Deliberately a PID file rather than a SQLite row: it survives a crash without
 * leaving a lock nobody can clear (a dead PID is detectable), and it works
 * before the database is even opened.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { STATE } from './config.js';
import { log } from './log.js';

const LOCK = join(STATE, 'conductor.pid');

interface LockFile { pid: number; startedAt: number; argv: string[] }

/** Signal 0 tests for existence without touching the process. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface LockResult {
  ok: boolean;
  heldBy?: { pid: number; startedAt: number; argv: string[] };
}

export function acquire(): LockResult {
  mkdirSync(STATE, { recursive: true });

  if (existsSync(LOCK)) {
    try {
      const held = JSON.parse(readFileSync(LOCK, 'utf8')) as LockFile;
      if (held.pid !== process.pid && alive(held.pid)) {
        return { ok: false, heldBy: held };
      }
      // Stale: the recorded process is gone. Reclaim rather than wedge — a
      // crashed conductor must not require manual cleanup to restart.
      log.warn('clearing a stale conductor lock', { pid: held.pid });
    } catch {
      log.warn('conductor lock was unreadable — reclaiming');
    }
  }

  writeFileSync(LOCK, JSON.stringify(
    { pid: process.pid, startedAt: Date.now(), argv: process.argv.slice(2) }, null, 2,
  ));
  return { ok: true };
}

export function release(): void {
  try {
    if (!existsSync(LOCK)) return;
    const held = JSON.parse(readFileSync(LOCK, 'utf8')) as LockFile;
    // Only ever release OUR lock: a crashed-then-restarted conductor must not
    // have its live lock deleted by the exit handler of the process it replaced.
    if (held.pid === process.pid) rmSync(LOCK, { force: true });
  } catch { /* nothing to release */ }
}

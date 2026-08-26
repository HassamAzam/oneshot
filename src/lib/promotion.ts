/**
 * The merge → deploy → qa window, held by exactly one run at a time.
 *
 * Everything else in this pipeline may pipeline freely; this stretch may not.
 * The deploy script ships the TIP of a branch rather than a SHA, so if a second
 * run merges into the base while the first is between its merge and its QA, the
 * demo box carries both changes and the QA verdict stops being attributable to
 * either ticket. Concurrency in config/project.json used to be pinned at 1 for
 * this one reason; the mutex carries it instead, which is what lets the cap rise.
 *
 * Deliberately IN-PROCESS. The conductor is a singleton (src/lib/singleton.ts),
 * so a second holder cannot exist without a second conductor, and a second
 * conductor is already refused at boot. A file lock would add a stale-lock
 * failure mode to guard against a case that cannot happen.
 *
 * The lock is re-entrant per run and held ACROSS a qa → implement cycle lap on
 * purpose: the box is carrying this run's half-fixed change until its QA passes,
 * and admitting another ticket into that window would destroy the attribution
 * the lock exists to protect.
 */
import { log } from './log.js';

let holder: string | null = null;
const waiting: Array<() => void> = [];

export function promotionHolder(): string | null {
  return holder;
}

export function acquirePromotion(runId: string): Promise<void> {
  if (holder === null || holder === runId) {
    holder = runId;
    return Promise.resolve();
  }
  log.info(`waiting for the promotion window — held by ${holder}`, { queued: waiting.length + 1 });
  return new Promise<void>((resolve) => {
    waiting.push(() => {
      holder = runId;
      resolve();
    });
  });
}

/** No-op unless this run actually holds it, so finish() can call it blindly. */
export function releasePromotion(runId: string): void {
  if (holder !== runId) return;
  holder = null;
  const next = waiting.shift();
  if (next) next();
}

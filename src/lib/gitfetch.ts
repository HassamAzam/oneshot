/**
 * Retry for the one git failure two conductors cause each other.
 *
 * Every run's worktree is cut from the single shared WORK_REPO, so two tickets
 * started seconds apart both `git fetch origin <base>` there at once. Git
 * updates refs/remotes/origin/<base> under a lock, and the loser fails with
 * "cannot lock ref ... is at <new> but expected <old>" — after the winner has
 * already moved the ref to the very commit the loser was fetching. Nothing is
 * wrong with the repo, yet the error surfaced as a block and parked a fresh run
 * under Needs Human before it had done anything. A second attempt finds the
 * ref current and succeeds.
 *
 * Only "cannot lock ref" is retried, and that one prefix is enough: git's files
 * backend wraps EVERY failure to take a ref lock in it, so the lost race, a
 * stale lockfile and a D/F conflict all arrive through the same words. The
 * "unable to update local ref" line git prints underneath was matched here too
 * at first and has been dropped — what it uniquely catches, without the lock
 * message above it, is a failed transaction commit or reflog write, and those
 * are real breakage that should surface on the first attempt rather than nine
 * seconds later. A network error or a missing branch is thrown on the first
 * attempt exactly as before, and a lock left behind by a crashed git still
 * fails after the last attempt. That last case warns on every attempt: losing
 * a race heals itself and costs nobody anything, a stale lockfile never heals
 * and costs 9s per worktree forever, and the log line is the only thing that
 * tells them apart from the outside.
 *
 * The sleep is synchronous and blocks the event loop, 1500 + 3000 + 4500 = 9s
 * at worst, and that is deliberate rather than tolerated. worktrees.ts gives
 * every git call a 120_000 timeout, so the fetch being retried may already hold
 * the loop for two minutes on its own, and CONDUCTOR_TTL_MS (300_000, see
 * singleton.ts) was sized around precisely that. 9s on top of a permitted 120s
 * sits inside the budget the fleet registry was designed with. Making the wait
 * async would buy nothing and cost a lot: leaseWorktree is synchronous, so is
 * its only caller in the runner, and the await would have to be threaded all
 * the way up through both.
 */
import { log } from './log.js';

const REF_LOCK_RACE = /cannot lock ref/;

export function isRefLockRace(err: unknown): boolean {
  const e = err as { stderr?: unknown; message?: unknown } | null;
  return REF_LOCK_RACE.test(`${e?.stderr ?? ''}\n${e?.message ?? ''}`);
}

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

export function retryRefLockRace<T>(
  run: () => T,
  { attempts = 4, waitMs = 1_500, sleep = sleepSync, warn = log.warn }: {
    attempts?: number; waitMs?: number; sleep?: (ms: number) => void; warn?: (msg: string, extra?: unknown) => void;
  } = {},
): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return run();
    } catch (err) {
      if (attempt >= attempts || !isRefLockRace(err)) throw err;
      const wait = waitMs * attempt;
      warn(`lost the ref lock on a base fetch — retrying (${attempt} of ${attempts - 1})`, {
        waitMs: wait, error: (err as Error).message,
      });
      sleep(wait);
    }
  }
}

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
 * Only that failure is retried. A network error or a missing branch is thrown
 * on the first attempt exactly as before, and a lock left behind by a crashed
 * git still fails after the last attempt, a few seconds later than it used to.
 */

const REF_LOCK_RACE = /cannot lock ref|unable to update local ref/;

export function isRefLockRace(err: unknown): boolean {
  const e = err as { stderr?: unknown; message?: unknown } | null;
  return REF_LOCK_RACE.test(`${e?.stderr ?? ''}\n${e?.message ?? ''}`);
}

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

export function retryRefLockRace<T>(
  run: () => T,
  { attempts = 4, waitMs = 1_500, sleep = sleepSync }: { attempts?: number; waitMs?: number; sleep?: (ms: number) => void } = {},
): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return run();
    } catch (err) {
      if (attempt >= attempts || !isRefLockRace(err)) throw err;
      sleep(waitMs * attempt);
    }
  }
}

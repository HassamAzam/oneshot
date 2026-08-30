/**
 * Per-ticket git worktrees, and the three things that make one actually usable.
 *
 * 1. SEED. A fresh worktree has none of the gitignored pieces a checkout needs
 *    to RUN — venv, node_modules, local_settings.py. A phase that cannot run
 *    the app writes code it cannot verify, so those are borrowed from an
 *    already-working repo: heavy read-mostly things symlinked, settings copied
 *    (so a worktree editing its settings does not edit the seed repo's).
 *
 * 2. SKILLS. `.claude/` is composed by ensureClaudeDir() so phases get the
 *    context repo's real, current skills with no vendoring and no sync step,
 *    plus the pipeline skills that live in the Oneshot repo. Note what the
 *    symlinks inside it imply: writes through one land in the context repo,
 *    which is exactly why hooks/write-scope.cjs realpath-resolves before
 *    comparing.
 *
 * 3. EXCLUDE. Those symlinks are untracked files in a real checkout, so they
 *    are written to .git/info/exclude — otherwise every `git status` a phase
 *    runs is noisy and `git add -A` would try to commit them.
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureClaudeDir } from './claudedir.js';
import {
  CONTEXT_REPO, WORK_REPO, WT_ROOT, envOr, expandPath, portPool, projectConfig,
} from './config.js';
import { db } from './db.js';
import { log } from './log.js';

function git(args: string[], cwd = WORK_REPO): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', timeout: 120_000,
    // stderr is piped, not inherited: `rev-parse --verify` on a branch that
    // does not exist yet is an expected probe, and letting its `fatal:` reach
    // the console makes a normal worktree creation look like a failure.
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export interface Lease {
  worktree: string;
  branch: string;
  /** Present only when the caller asked for one — see leaseWorktree's options. */
  port?: number;
  baseSha: string;
}

/**
 * Reclaim what is dead and take the first port still free — as ONE statement's
 * worth of exclusivity.
 *
 * The reclaim is not housekeeping, it is the pool's only repair path. A lease is
 * released in teardown, so a conductor that died mid-run leaves a row owning a
 * port forever, and the pool is three entries wide. Ownership is decided by the
 * runs table, which boot-time reconciliation has already truthed: a lease whose
 * run is no longer claimed or running cannot be in use by anyone.
 *
 * IMMEDIATE, and not merely a transaction. Read-then-write is exactly the shape
 * SQLite refuses to arbitrate on a deferred handle — the second writer takes its
 * snapshot on the read, discovers the world moved under it on the write, and
 * fails instantly with SQLITE_BUSY_SNAPSHOT without ever consulting
 * busy_timeout. Taking the write lock up front turns that into a wait the loser
 * survives, which is what makes the answer below trustworthy: with two
 * conductors leasing at once, both used to see the same port free and one died
 * on the primary key while two ports sat unused.
 *
 * The body is deliberately tiny for the same reason it is exclusive.
 * better-sqlite3 is synchronous, so everything inside this transaction is time
 * the event loop is not running — no tick, no abort, no Slack card. Two
 * statements and a set membership test is the whole budget.
 */
const takeFreePort = db.transaction((runId: string, pool: number[], unavailable: Set<number>) => {
  const reaped = db.prepare(`DELETE FROM port_leases WHERE run_id NOT IN
    (SELECT run_id FROM runs WHERE status IN ('claimed','running'))`).run().changes;
  const taken = new Set(
    (db.prepare('SELECT port FROM port_leases').all() as Array<{ port: number }>).map((r) => r.port),
  );
  for (const port of pool) {
    if (taken.has(port) || unavailable.has(port)) continue;
    db.prepare('INSERT INTO port_leases (port, run_id, leased_at) VALUES (?, ?, ?)')
      .run(port, runId, Date.now());
    return { port, reaped };
  }
  return { port: null as number | null, reaped };
});

/**
 * PIDs listening on a TCP port — empty when it is free.
 *
 * lsof is the probe: it is already on every macOS box this runs on and it tells
 * a LISTEN apart from a client connection. Any spawn error (no lsof, timeout)
 * returns [] — fail OPEN, because a lease that cannot probe must not refuse
 * every port. The cost of failing open is the bug this guards against; the cost
 * of failing closed is a run that can never lease a port at all.
 */
function portListeners(port: number): number[] {
  try {
    const out = execFileSync('lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out ? out.split('\n').map(Number).filter(Number.isInteger) : [];
  } catch {
    return [];
  }
}

/**
 * Kill whatever is listening on a run's leased port.
 *
 * Called from a run's terminal path: `releasePort` only drops the SQLite row,
 * so without this the dev server a phase started outlives the run, and the port
 * pool fills with orphans from crashed and blocked runs — which is how a later
 * verify came to drive a stale server and report on the wrong code. Best-effort
 * and never throws: a port with nothing on it is the normal case.
 *
 * Only the leased port is reaped, never the shared webpack port — a concurrent
 * run may be serving its own frontend there.
 */
export function reapPortServer(port: number | null | undefined): number {
  if (!port) return 0;
  let killed = 0;
  for (const pid of portListeners(port)) {
    try { process.kill(pid, 'SIGTERM'); killed += 1; } catch { /* already gone */ }
  }
  if (killed) log.info(`reaped ${killed} process(es) on port ${port}`);
  return killed;
}

/**
 * Lease a port for this run, or say plainly that there is none.
 *
 * Ports are the real concurrency limit for phases that run a dev server. Leased
 * through SQLite rather than by probing, because a port that is free *right now*
 * can be taken by the next phase two seconds later.
 *
 * null rather than a throw when the pool is exhausted: an empty pool is a
 * capacity answer the caller can act on, and dressing it as an exception put it
 * in the same catch as a genuinely broken database.
 */
export function leasePortFor(runId: string): number | null {
  db.exec(`CREATE TABLE IF NOT EXISTS port_leases (
    port INTEGER PRIMARY KEY, run_id TEXT NOT NULL, leased_at INTEGER NOT NULL)`);
  const pool = portPool();
  // A port that is free in the lease table but has a process listening on it is
  // either an orphan from a run that never reaped or a foreign dev server
  // sharing these ports. Leasing it anyway is exactly how a verify phase ends up
  // driving somebody else's server and reporting on the wrong code. Probe here —
  // outside the SQLite transaction, which must stay synchronous and tiny — and
  // never hand out a port something is already answering on.
  const occupied = new Set(pool.filter((p) => portListeners(p).length > 0));
  const { port, reaped } = takeFreePort.immediate(runId, pool, occupied);
  if (reaped) log.info(`reclaimed ${reaped} port lease(s) from finished runs`);
  if (occupied.size) {
    log.warn(`skipped occupied port(s) ${[...occupied].join(', ')} — a process is already listening there`);
  }
  return port;
}

export function releasePort(runId: string): void {
  try {
    db.prepare('DELETE FROM port_leases WHERE run_id = ?').run(runId);
  } catch { /* table may not exist yet */ }
}

/**
 * Copy a seed file by CONTENT, never with copyfile(3).
 *
 * cpSync() and copyFileSync() both go through copyfile(3), which replicates the
 * source's extended attributes. On macOS that is not a metadata nicety, it is a
 * failure mode: a file carrying `com.apple.provenance` — the TCC attribute the
 * OS stamps on files a sandboxed app has touched — cannot have that attribute
 * reproduced by a process without the matching entitlement, and the whole copy
 * fails EPERM. Nothing about the file is unreadable; only the xattr is
 * privileged.
 *
 * It is not fixable from the outside. Stripping the attribute works for exactly
 * as long as it takes something to read the file again, at which point macOS
 * puts it straight back, so any "clean the source once" repair is a repair that
 * un-does itself.
 *
 * Observed as four runs blocked at `recall` with
 * `EPERM: operation not permitted, copyfile '<seed>/frontend/src/constants/config.js'`
 * while hrdb/local_settings.py — same source repo, same process, same instant —
 * copied cleanly, because that one carries com.apple.macl instead. A whole
 * conductor stopped claiming tickets over an xattr on one config file.
 *
 * read + write moves the bytes and lets the destination take whatever
 * attributes the OS wants to give a newly created file, which is all a seeded
 * config was ever supposed to have. The mode is carried across because
 * local_settings.py and config.js are read by the app, not executed, but a seed
 * list is free to grow a script one day.
 */
function copyContents(src: string, dst: string): void {
  writeFileSync(dst, readFileSync(src));
  try { chmodSync(dst, statSync(src).mode & 0o777); } catch { /* mode is a nicety, content is not */ }
}

function seed(worktree: string): void {
  const from = expandPath(envOr('ONESHOT_SEED_FROM', ''));
  if (!from || !existsSync(from)) {
    log.warn('no seed repo — the worktree cannot run the app without npm ci / venv setup');
    return;
  }

  const links = envOr('ONESHOT_SEED_LINKS', '').split(',').map((s) => s.trim()).filter(Boolean);
  const copies = envOr('ONESHOT_SEED_COPIES', '').split(',').map((s) => s.trim()).filter(Boolean);
  const excluded: string[] = [];

  for (const rel of links) {
    const src = join(from, rel);
    const dst = join(worktree, rel);
    if (!existsSync(src) || existsSync(dst)) continue;
    mkdirSync(dirname(dst), { recursive: true });
    symlinkSync(src, dst);
    excluded.push(rel);
  }

  for (const rel of copies) {
    const src = join(from, rel);
    const dst = join(worktree, rel);
    if (!existsSync(src) || existsSync(dst)) continue;
    mkdirSync(dirname(dst), { recursive: true });
    copyContents(src, dst);
    excluded.push(rel);
  }

  excluded.push(...ensureClaudeDir(worktree));

  addExcludes(worktree, excluded);
}

/**
 * Keep seeded paths out of `git status`.
 *
 * .git/info/exclude rather than .gitignore: it is per-checkout and untracked,
 * so it cannot leak into a commit or an MR diff.
 */
function addExcludes(worktree: string, paths: string[]): void {
  if (!paths.length) return;
  try {
    const gitDir = git(['rev-parse', '--git-dir'], worktree);
    const abs = gitDir.startsWith('/') ? gitDir : join(worktree, gitDir);
    const file = join(abs, 'info', 'exclude');
    mkdirSync(dirname(file), { recursive: true });
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const missing = paths.filter((p) => !existing.includes(`\n${p}\n`));
    if (!missing.length) return;
    writeFileSync(file, `${existing}\n# oneshot seeded\n${missing.join('\n')}\n`);
  } catch (err) {
    log.warn('could not write .git/info/exclude', { error: (err as Error).message });
  }
}

/**
 * Where this branch left the base — the diff base every later phase reads
 * against.
 *
 * merge-base rather than the tip of origin/<base>, and computed WITHOUT a
 * fetch. A run lives for hours and the base branch moves under it; taking the
 * tip means the review, the evidence pack and the MR each describe a different
 * diff from the one implement wrote, and a resumed run's diff silently grows to
 * include whatever landed on dev while it was down. The merge-base is fixed by
 * the branch's own history, so it answers the same thing at every phase and on
 * every resumption.
 */
function forkPoint(worktree: string, base: string): string {
  try {
    return git(['merge-base', 'HEAD', `origin/${base}`], worktree);
  } catch (err) {
    log.warn(`no merge-base with origin/${base} — diffing against HEAD`, {
      error: (err as Error).message,
    });
    return git(['rev-parse', 'HEAD'], worktree);
  }
}

/**
 * Give this worktree a committer identity WITHOUT touching the shared config.
 *
 * `git -C <worktree> config user.name` does not write a per-worktree setting —
 * it writes .git/config, the one file every worktree of the repo shares, and
 * concurrent worktree creations serialise on its lock and mostly lose. Two
 * escapes exist and the repository decides which:
 *
 *   extensions.worktreeConfig on  — `config --worktree` writes
 *                                   .git/worktrees/<name>/config, which nobody
 *                                   else has open, so it is safe and it is what
 *                                   the option is for.
 *   otherwise                     — no file is written at all. Identity reaches
 *                                   every commit through GIT_AUTHOR_* /
 *                                   GIT_COMMITTER_* in the phase environment
 *                                   (src/lib/config.ts, BASE_ENV), which git
 *                                   honours ahead of any config and which
 *                                   cannot contend with anything.
 *
 * Enabling the extension from here is deliberately not done: it is a repository
 * -wide change to a repo Oneshot only borrows.
 */
function pinIdentity(worktree: string): void {
  const perWorktree = (() => {
    try { return git(['config', '--bool', 'extensions.worktreeConfig'], worktree) === 'true'; } catch { return false; }
  })();
  if (!perWorktree) return;

  const author = envOr('ONESHOT_GIT_AUTHOR_NAME', 'Oneshot');
  const email = envOr('ONESHOT_GIT_AUTHOR_EMAIL');
  try {
    git(['config', '--worktree', 'user.name', author], worktree);
    if (email) git(['config', '--worktree', 'user.email', email], worktree);
  } catch (err) {
    log.warn('could not write the per-worktree identity — the environment carries it', {
      error: (err as Error).message,
    });
  }
}

/**
 * Create (or re-attach to) the worktree for a ticket.
 *
 * Idempotent: a run resumed after a crash finds its existing worktree and
 * branch and continues in them rather than starting over. The fetch happens
 * only on creation — re-attaching must not move origin/<base> under a run that
 * is already mid-flight.
 *
 * A port is leased only when `withPort` is set. Leasing one with the worktree
 * held a scarce, pool-limited resource from the first worktree phase through
 * every phase that has no use for it; the runner asks for one when it first
 * reaches a phase that actually serves the app.
 */
export function leaseWorktree(
  runId: string, branch: string, name: string, opts: { withPort?: boolean } = {},
): Lease {
  const cfg = projectConfig();
  const base = cfg.branches.base;
  mkdirSync(WT_ROOT, { recursive: true });
  const worktree = join(WT_ROOT, name);

  if (!existsSync(worktree)) {
    git(['fetch', 'origin', base]);
    const branchExists = (() => {
      try { git(['rev-parse', '--verify', `refs/heads/${branch}`]); return true; } catch { return false; }
    })();
    if (branchExists) git(['worktree', 'add', worktree, branch]);
    // --no-track is not about upstreams, it is about the lock. Creating a
    // branch that tracks origin/<base> writes two keys into the SHARED
    // .git/config, and several worktrees being created at the same moment
    // contend for that one file: most of them fail with "could not lock config
    // file" AFTER the local branch has already been created, leaving an orphan
    // branch and no worktree. Nothing here ever pushes to the base or pulls
    // from it — the MR is what moves work — so the tracking entry buys nothing
    // and costs the only serialising write in the whole operation.
    else git(['worktree', 'add', '--no-track', '-b', branch, worktree, `origin/${base}`]);
    log.ok(`worktree ${worktree}`, { branch, base: `origin/${base}` });
  } else {
    log.info(`re-attached to existing worktree ${worktree}`);
  }

  seed(worktree);
  pinIdentity(worktree);

  const lease: Lease = { worktree, branch, baseSha: forkPoint(worktree, base) };
  if (opts.withPort) {
    const port = leasePortFor(runId);
    if (port === null) log.warn('no free port in the pool — the worktree is leased without one');
    else lease.port = port;
  }
  return lease;
}

/** Remove the worktree. The BRANCH is deliberately left alone — it is pushed work. */
export function reapWorktree(worktree: string, runId: string): void {
  releasePort(runId);
  if (!existsSync(worktree)) return;
  try {
    git(['worktree', 'remove', '--force', worktree]);
    log.ok(`reaped worktree ${worktree}`);
  } catch (err) {
    log.warn('worktree remove failed — leaving it on disk', { error: (err as Error).message });
  }
}

export function contextRepoPresent(): boolean {
  return existsSync(CONTEXT_REPO);
}

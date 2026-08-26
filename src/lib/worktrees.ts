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
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
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
 * Lease a port for this run.
 *
 * Ports are the real concurrency limit for phases that run a dev server.
 * Leased through SQLite rather than by probing, because a port that is free
 * *right now* can be taken by the next phase two seconds later.
 *
 * The DELETE first is not housekeeping, it is the pool's only repair path. A
 * lease is released in teardown, so a conductor that dies mid-run — or a run
 * that ended blocked before teardown released anything — leaves a row owning a
 * port forever, and the pool is three entries wide. Three such rows and every
 * later run fails at its first server-holding phase with "all leased" while
 * nothing at all is listening. Ownership is decided by the runs table, which
 * boot-time reconciliation has already truthed: a lease whose run is no longer
 * claimed or running cannot be in use by anyone.
 */
export function leasePortFor(runId: string): number {
  db.exec(`CREATE TABLE IF NOT EXISTS port_leases (
    port INTEGER PRIMARY KEY, run_id TEXT NOT NULL, leased_at INTEGER NOT NULL)`);
  const reaped = db.prepare(`DELETE FROM port_leases WHERE run_id NOT IN
    (SELECT run_id FROM runs WHERE status IN ('claimed','running'))`).run();
  if (reaped.changes) log.info(`reclaimed ${reaped.changes} port lease(s) from finished runs`);

  const taken = new Set(
    (db.prepare('SELECT port FROM port_leases').all() as Array<{ port: number }>).map((r) => r.port),
  );
  for (const p of portPool()) {
    if (!taken.has(p)) {
      db.prepare('INSERT INTO port_leases (port, run_id, leased_at) VALUES (?, ?, ?)')
        .run(p, runId, Date.now());
      return p;
    }
  }
  throw new Error(`No free port in PORT_POOL (${portPool().join(', ')}) — all leased`);
}

export function releasePort(runId: string): void {
  try {
    db.prepare('DELETE FROM port_leases WHERE run_id = ?').run(runId);
  } catch { /* table may not exist yet */ }
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
    cpSync(src, dst);
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
    else git(['worktree', 'add', '-b', branch, worktree, `origin/${base}`]);
    log.ok(`worktree ${worktree}`, { branch, base: `origin/${base}` });
  } else {
    log.info(`re-attached to existing worktree ${worktree}`);
  }

  seed(worktree);

  const author = envOr('ONESHOT_GIT_AUTHOR_NAME', 'Oneshot');
  const email = envOr('ONESHOT_GIT_AUTHOR_EMAIL');
  git(['config', 'user.name', author], worktree);
  if (email) git(['config', 'user.email', email], worktree);

  const lease: Lease = { worktree, branch, baseSha: forkPoint(worktree, base) };
  if (opts.withPort) lease.port = leasePortFor(runId);
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

/**
 * Per-ticket git worktrees, and the three things that make one actually usable.
 *
 * 1. SEED. A fresh worktree has none of the gitignored pieces a checkout needs
 *    to RUN — venv, node_modules, local_settings.py. A phase that cannot run
 *    the app writes code it cannot verify, so those are borrowed from an
 *    already-working repo: heavy read-mostly things symlinked, settings copied
 *    (so a worktree editing its settings does not edit the seed repo's).
 *
 * 2. SKILLS. `.claude/` is symlinked to the context repo so phases get the
 *    real, current skills with no vendoring and no sync step. Note what this
 *    implies: writes through that symlink land in the context repo, which is
 *    exactly why hooks/write-scope.cjs realpath-resolves before comparing.
 *
 * 3. EXCLUDE. Those symlinks are untracked files in a real checkout, so they
 *    are written to .git/info/exclude — otherwise every `git status` a phase
 *    runs is noisy and `git add -A` would try to commit them.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CONTEXT_REPO, SKILLS_ROOT, WORK_REPO, WT_ROOT, envOr, expandPath, portPool, projectConfig,
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
  port: number;
  baseSha: string;
}

/**
 * Ports are the real concurrency limit for phases that run a dev server.
 * Leased through SQLite rather than by probing, because a port that is free
 * *right now* can be taken by the next phase two seconds later.
 */
function leasePort(runId: string): number {
  db.exec(`CREATE TABLE IF NOT EXISTS port_leases (
    port INTEGER PRIMARY KEY, run_id TEXT NOT NULL, leased_at INTEGER NOT NULL)`);
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

  // Skills, agents and rules from the context repo — live, not vendored.
  if (existsSync(SKILLS_ROOT)) {
    const dotClaude = join(worktree, '.claude');
    if (!existsSync(dotClaude)) {
      symlinkSync(SKILLS_ROOT, dotClaude);
      excluded.push('.claude');
    }
  }

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
 * Create (or re-attach to) the worktree for a ticket.
 *
 * Idempotent: a run resumed after a crash finds its existing worktree and
 * branch and continues in them rather than starting over.
 */
export function leaseWorktree(runId: string, branch: string, name: string): Lease {
  const cfg = projectConfig();
  const base = cfg.branches.base;
  mkdirSync(WT_ROOT, { recursive: true });
  const worktree = join(WT_ROOT, name);

  git(['fetch', 'origin', base]);
  const baseSha = git(['rev-parse', `origin/${base}`]);

  if (!existsSync(worktree)) {
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

  return { worktree, branch, port: leasePort(runId), baseSha };
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

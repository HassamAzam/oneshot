/**
 * Is this machine actually pointed at the project GITLAB_REPO_URL names?
 *
 * The URL is the single source of truth for WHICH project, but two things on a
 * machine can still quietly disagree with it, and both are left over from
 * before it existed:
 *
 *   - a legacy selector line (ONESHOT_PROJECT and friends) still in .env. It
 *     selects nothing now, and a person reading .env would reasonably believe
 *     it does — so a disagreeing one refuses boot rather than being ignored.
 *
 *   - a WORK_REPO that is a clone of some other project. A plain WORK_REPO
 *     beats the derived default like any env var, so a line from the project
 *     this machine used to work on would cut every worktree from the wrong
 *     code while the tickets, labels and MRs went to the right project. The
 *     origin remote is the only fact on disk that says which project a
 *     checkout is, so it is compared, and a mismatch refuses boot. The same
 *     goes for ONESHOT_SEED_FROM when it is a different directory: at boot the
 *     conductor warms an app worktree cut from the seed, scripts/app.cjs
 *     fetches MR refs in it, and every run worktree links its node_modules and
 *     venv — a seed from another project serves that project's code.
 *
 * A stale WT_ROOT cannot be caught by an origin (it is not a clone), so it is
 * judged by the worktrees it already holds and by the legacy overlay line that
 * used to override it.
 *
 * Boot (src/index.ts), `npm run doctor` and `npm run preflight` all call
 * identityFindings() and checkoutFindings(), so the three cannot disagree about
 * what is wrong. The git call (which follows a local clone to its own origin)
 * is isolated in readOrigin() and the decision in judgeOrigin() is pure, which
 * is what the tests exercise.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  REPO_URL_VAR, defaultWtRoot, expandPath, judgeOrigin as judgeOriginCjs, legacySelectors, readOrigin as readOriginCjs,
  redactUrl, repoFromEnv, spellings,
  type Finding, type OriginRead, type OriginSubject, type ResolvedPath,
} from './repourl.cjs';

export type { Finding } from './repourl.cjs';

/**
 * GITLAB_REPO_URL itself, then every legacy selector still set, from `env`.
 *
 * A missing URL is reported together with the legacy lines that are set,
 * because on a machine upgrading from the old overlay those lines are exactly
 * the information the person needs to write the one line that replaces them.
 */
export function identityFindings(env: NodeJS.ProcessEnv = process.env): Finding[] {
  const { repo, error } = repoFromEnv(env);
  const legacy = legacySelectors(env, repo);
  const out: Finding[] = [];

  if (!repo) {
    const stale = legacy.map((l) => `${l.key}=${l.value}`).join(', ');
    out.push({
      level: 'fail',
      label: REPO_URL_VAR,
      detail: (error ?? `${REPO_URL_VAR} is not set`)
        + (stale ? ` (${stale} ${legacy.length === 1 ? 'is set but selects' : 'are set but select'} nothing any more)` : ''),
    });
    return out;
  }

  out.push({
    level: 'pass',
    label: REPO_URL_VAR,
    detail: `${redactUrl(repo.url)} -> ${repo.project} on ${repo.host} (target '${repo.name}')`,
  });
  for (const l of legacy) {
    if (l.conflict) {
      out.push({
        level: 'fail',
        label: `${l.key} conflicts with ${REPO_URL_VAR}`,
        detail: `${l.key}=${l.value} but ${REPO_URL_VAR}=${redactUrl(repo.url)} gives ${l.derived}. `
          + `${l.key} selects nothing any more — delete that line from .env; `
          + `${REPO_URL_VAR} alone says which project.`,
      });
    } else {
      out.push({
        level: 'warn',
        label: `${l.key} is redundant`,
        detail: l.derived === null
          ? `${l.key}=${l.value} selects nothing any more (the numeric id is asked of GitLab) — remove it from .env`
          : `${l.key}=${l.value} matches ${REPO_URL_VAR} and selects nothing any more — remove it from .env`,
      });
    }
  }
  return out;
}

export type { OriginRead, OriginSubject } from './repourl.cjs';

/**
 * The git call — `git remote get-url` for origin's fetch and push URLs,
 * following a local clone to its own origin (repourl.cjs has the rules) —
 * shared with scripts/app.cjs, so the two runtimes read a remote the same way.
 * Kept apart from the judgement so the judgement is testable.
 */
export function readOrigin(dir: string): OriginRead {
  return readOriginCjs(dir);
}

/**
 * Judge a checkout's origin against GITLAB_REPO_URL. Pure, and the same
 * function scripts/app.cjs refuses with (repourl.cjs).
 *
 * A proven mismatch — another project path — fails. Anything that cannot be
 * judged — no origin, not a git repository, git missing, a local-path origin
 * whose chain never reaches a GitLab URL, or the same path on another host —
 * only warns: it proves nothing either way, and a check that crashed or refused boot on an
 * unreadable remote would be blocking on its own blind spot rather than on the
 * danger it exists for. `subject` may be just the label; passing where the
 * path came from (`from`, a pathSources() entry) makes the fix-it text name
 * the line that actually has to change.
 */
export function judgeOrigin(subject: string | OriginSubject, repoUrl: string, read: OriginRead): Finding {
  return judgeOriginCjs(typeof subject === 'string' ? { label: subject } : subject, repoUrl, read);
}

/**
 * judgeOrigin() for `dir`, or null when there is nothing to judge: no usable
 * GITLAB_REPO_URL (reported on its own) or no directory (reported by the
 * caller's own existence check, which knows what to tell the person to set).
 */
export function originFinding(
  subject: string | Omit<OriginSubject, 'dir'>, dir: string, env: NodeJS.ProcessEnv = process.env,
  read: (d: string) => OriginRead = readOrigin,
): Finding | null {
  const { repo } = repoFromEnv(env);
  if (!repo || !dir || !existsSync(dir)) return null;
  const s = typeof subject === 'string' ? { label: subject } : subject;
  return judgeOrigin({ ...s, dir }, repo.url, read(dir));
}

/**
 * The origin findings for this machine's clones of the project: WORK_REPO,
 * then the seed when it is a directory of its own (an unset seed is seeding
 * off, and a seed that IS WORK_REPO has just been judged). Boot, preflight and
 * doctor all call this, so none of them can skip the seed the others check.
 */
export function checkoutFindings(
  p: { workRepo: string; seed: string; sources: Record<'WORK_REPO' | 'ONESHOT_SEED_FROM', ResolvedPath> },
  env: NodeJS.ProcessEnv = process.env, read: (d: string) => OriginRead = readOrigin,
): Finding[] {
  const out: Array<Finding | null> = [
    originFinding({ label: 'WORK_REPO', from: p.sources.WORK_REPO }, p.workRepo, env, read),
  ];
  if (p.seed && p.seed !== p.workRepo) {
    out.push(originFinding({ label: 'ONESHOT_SEED_FROM', from: p.sources.ONESHOT_SEED_FROM }, p.seed, env, read));
  }
  return out.filter((f): f is Finding => f !== null);
}

// ------------------------------------------------------------------ WT_ROOT

/** The git directory `dir` is a checkout or worktree of, real-pathed; null when it is not one. */
export function commonGitDir(dir: string): string | null {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', timeout: 15_000 });
  const out = r.status === 0 ? String(r.stdout || '').trim() : '';
  if (!out) return null;
  try { return realpathSync(resolve(dir, out)); } catch { return null; }
}

export interface WorktreeOwner { dir: string; gitDir: string | null }

/** Every worktree directly under `wtRoot`, with the git directory it was cut from. */
export function worktreeOwners(wtRoot: string): WorktreeOwner[] {
  let entries: string[];
  try { entries = readdirSync(wtRoot); } catch { return []; }
  return entries
    .map((e) => join(wtRoot, e))
    .filter((d) => existsSync(join(d, '.git')))
    .map((dir) => ({ dir, gitDir: commonGitDir(dir) }));
}

/**
 * Is WT_ROOT this project's own? Pure.
 *
 * WT_ROOT is the one project path the origin check cannot reach — it is a
 * directory of worktrees, not a clone — and a plain WT_ROOT line beats the
 * derived default like any other. Left over from the project this machine
 * worked on before, it silently puts this project's worktrees beside that
 * one's: ticket worktrees are named by iid and the app pool by port, so the two
 * collide, and scripts/app.cjs refuses an app-<port> worktree of another clone.
 *
 * Two cases fail. A root that already holds worktrees of some other clone —
 * the same thing scripts/app.cjs refuses. And a plain WT_ROOT that differs from
 * the derived default while a legacy ONESHOT_PROJECT line (`overlayKey`) is
 * still set: under the old named-target overlay that line replaced WT_ROOT
 * with ~/Documents/<name>-wt, so the root has moved without anyone choosing
 * it. A root set by hand that is merely not named for the target only warns.
 */
export function judgeWtRoot(p: {
  wtRoot: string; from: ResolvedPath; name: string; clones: string[]; owners: WorktreeOwner[]; overlayKey?: string;
}): Finding | null {
  const set = p.from.key ? ` (from ${p.from.key})` : '';
  const fix = `set WT_ROOT to a directory of its own${p.name ? ` — the default is ~/Documents/${p.name}-wt` : ''}`
    + (p.from.key ? `, which deleting the ${p.from.key} line gives` : '');
  const derived = p.name ? expandPath(defaultWtRoot(p.name), '/') : '';
  if (p.overlayKey && p.from.source === 'plain' && derived && p.wtRoot !== derived) {
    return {
      level: 'fail',
      label: 'WT_ROOT moved when the project overlay went away',
      detail: `${p.from.key}=${p.wtRoot} is in force, but with ${p.overlayKey} set the old overlay used `
        + `~/Documents/${p.name}-wt instead. Delete the ${p.from.key} line from .env to go back to it, `
        + `or delete the ${p.overlayKey} line (it selects nothing now) to keep ${p.wtRoot} on purpose.`,
    };
  }
  const foreign = p.clones.length ? p.owners.filter((o) => o.gitDir && !p.clones.includes(o.gitDir)) : [];
  if (foreign.length) {
    const from = [...new Set(foreign.map((o) => o.gitDir))].join(', ');
    return {
      level: 'fail',
      label: 'WT_ROOT is shared with another clone',
      detail: `${p.wtRoot}${set} holds ${foreign.length} worktree(s) cut from ${from}, not from this `
        + `project's clone (e.g. ${foreign[0]?.dir}). Worktrees are named by ticket iid and app-<port>, so two `
        + `projects in one root collide: ${fix}, or remove those worktrees.`,
    };
  }
  if (p.from.source !== 'default' && p.name && !basename(p.wtRoot).toLowerCase().includes(p.name)) {
    return {
      level: 'warn',
      label: 'WT_ROOT is not named for this project',
      detail: `${p.wtRoot}${set} — if it is left over from another project, its worktrees and this `
        + `project's collide by ticket iid; ${fix}.`,
    };
  }
  return null;
}

/**
 * judgeWtRoot() against what is on disk; without the worktrees when WT_ROOT
 * does not exist yet. `clones` are WORK_REPO and the seed; one whose origin is
 * provably another project is failed on its own and does not count as this
 * project's here, or a stale seed would vouch for the stale root it shares with.
 */
export function wtRootFinding(
  wtRoot: string, from: ResolvedPath, name: string, clones: string[], env: NodeJS.ProcessEnv = process.env,
): Finding | null {
  if (!wtRoot) return null;
  const overlayKey = legacySelectors(env, null).find((l) => spellings('ONESHOT_PROJECT').includes(l.key))?.key;
  if (!existsSync(wtRoot)) {
    const moved = judgeWtRoot({ wtRoot, from, name, clones: [], owners: [], overlayKey });
    return moved?.level === 'fail' ? moved : null;
  }
  const ours = clones.filter((c) => c && existsSync(c) && originFinding('clone', c, env)?.level !== 'fail');
  const gitDirs = [...new Set(ours.map(commonGitDir))]
    .filter((d): d is string => d !== null);
  return judgeWtRoot({ wtRoot, from, name, clones: gitDirs, owners: worktreeOwners(wtRoot), overlayKey });
}

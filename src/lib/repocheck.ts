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
 * judged by the worktrees on disk, each by its own origin: the ones it holds,
 * and this project's ones left in the derived default root it replaced.
 *
 * Boot (src/index.ts), `npm run doctor` and `npm run preflight` all call
 * identityFindings() and checkoutFindings(), so the three cannot disagree about
 * what is wrong. The git call (which follows a local clone to its own origin)
 * is isolated in readOrigin() and the decision in judgeOrigin() is pure, which
 * is what the tests exercise. Each consumer passes the findings through
 * relaxRepoChecks() before refusing on them, so ONESHOT_SKIP_REPO_CHECK turns
 * the same FAILs into WARNs everywhere, scripts/app.cjs included.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  REPO_URL_VAR, defaultWtRoot, expandPath, judgeOrigin as judgeOriginCjs, legacySelectors, originProject,
  readOrigin as readOriginCjs, redactUrl, relaxRepoChecks as relaxRepoChecksCjs,
  repoCheckOverrideNotice as overrideNoticeCjs, repoFromEnv,
  type Finding, type OriginProject, type OriginRead, type OriginSubject, type ResolvedPath,
} from './repourl.cjs';

export type { Finding } from './repourl.cjs';

/** repourl.cjs relaxRepoChecks() over this process's environment by default. */
export function relaxRepoChecks(findings: Finding[], env: NodeJS.ProcessEnv = process.env): Finding[] {
  return relaxRepoChecksCjs(findings, env);
}

/** The standing ONESHOT_SKIP_REPO_CHECK reminder, or null when the override is off. */
export function repoCheckOverrideNotice(env: NodeJS.ProcessEnv = process.env): string | null {
  return overrideNoticeCjs(env);
}

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

export type { OriginProject, OriginRead, OriginSubject } from './repourl.cjs';

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

/**
 * Which project the checkout at `dir` is: originProject() of what its origin
 * says. A worktree answers with its clone's remotes, which it shares — so any
 * clone of this project, not only WORK_REPO, answers 'same'. 'unknown' when
 * there is no directory, or no GITLAB_REPO_URL to compare with.
 */
export function checkoutProject(
  dir: string | undefined, repoUrl: string | undefined, read: (d: string) => OriginRead = readOrigin,
): OriginProject {
  if (!dir || !repoUrl || !existsSync(dir)) return { kind: 'unknown' };
  return originProject(repoUrl, read(dir));
}

export interface WorktreeOwner { dir: string; project: OriginProject }

/**
 * Every worktree directly under `wtRoot`, with the project its origin makes it.
 *
 * One git call per entry finds the clone it was cut from, and the origin is read
 * once per clone rather than once per worktree: every worktree of a clone shares
 * that clone's remotes, and a root holds dozens of worktrees of one or two
 * clones. An entry git does not recognise is 'unknown'.
 */
export function worktreeOwners(
  wtRoot: string, repoUrl: string, read: (d: string) => OriginRead = readOrigin,
): WorktreeOwner[] {
  let entries: string[];
  try { entries = readdirSync(wtRoot); } catch { return []; }
  const byClone = new Map<string, OriginProject>();
  return entries
    .map((e) => join(wtRoot, e))
    .filter((d) => existsSync(join(d, '.git')))
    .map((dir): WorktreeOwner => {
      const gitDir = commonGitDir(dir);
      if (!gitDir) return { dir, project: { kind: 'unknown' } };
      const known = byClone.get(gitDir) ?? checkoutProject(dir, repoUrl, read);
      byClone.set(gitDir, known);
      return { dir, project: known };
    });
}

/** The WT_ROOT GITLAB_REPO_URL derives, absolute; '' without a target name. */
function derivedWtRoot(name: string): string {
  return name ? expandPath(defaultWtRoot(name), '/') : '';
}

/**
 * Is WT_ROOT this project's own? Pure.
 *
 * WT_ROOT is the one project path the origin check cannot reach — it is a
 * directory of worktrees, not a clone — and a plain WT_ROOT line beats the
 * derived default like any other. So it is judged by the worktrees on disk,
 * each by its own origin: by PROJECT, never by clone. What goes wrong is two
 * projects in one root — ticket worktrees are named by iid and the app pool by
 * port, so project A's #100 and project B's #100 collide — and a worktree of a
 * second clone of THIS project collides with nothing. A worktree whose origin
 * cannot be judged proves nothing either way and never fails anything.
 *
 * A root holding worktrees provably of another project fails. So does a WT_ROOT
 * other than the derived ~/Documents/<name>-wt while that derived root still
 * holds worktrees of this project (`stranded`): nothing manages them, or an
 * app-<port> server running from one, once WT_ROOT points elsewhere. That rule
 * reads the disk and nothing else, and deliberately not whether a legacy
 * ONESHOT_PROJECT line is still set: doctor tells the operator to delete exactly
 * that line, and a rule keyed on it would then let a stale WT_ROOT take effect
 * in silence. A root set by hand that is merely not named for the target only
 * warns.
 */
export function judgeWtRoot(p: {
  wtRoot: string; from: ResolvedPath; name: string; owners: WorktreeOwner[]; stranded?: WorktreeOwner[];
}): Finding | null {
  const set = p.from.key ? ` (from ${p.from.key})` : '';
  const fix = `set WT_ROOT to a directory of its own${p.name ? ` — the default is ~/Documents/${p.name}-wt` : ''}`
    + (p.from.key ? `, which deleting the ${p.from.key} line gives` : '');
  const foreign = p.owners.filter((o) => o.project.kind === 'other');
  if (foreign.length) {
    const from = [...new Set(foreign.map((o) => (o.project.kind === 'other' ? o.project.url : '')))].join(', ');
    return {
      level: 'fail',
      label: 'WT_ROOT is shared with another project',
      detail: `${p.wtRoot}${set} holds ${foreign.length} worktree(s) of ${from}, not of this project `
        + `(e.g. ${foreign[0]?.dir}). Worktrees are named by ticket iid and app-<port>, so two `
        + `projects in one root collide: ${fix}, or remove those worktrees.`,
    };
  }
  const moved = strandedFinding(p);
  if (moved) return moved;
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
 * judgeWtRoot()'s finding for worktrees left in the derived root, or null.
 *
 * Only worktrees whose origin proves them this project's fail. Ones whose
 * origin cannot be judged — an ssh alias host, a local clone whose chain ends
 * nowhere — may be this project's just as well, so they warn with the same
 * advice when nothing provable is there; another project's are not this
 * move's concern at all.
 */
function strandedFinding(p: {
  wtRoot: string; from: ResolvedPath; name: string; stranded?: WorktreeOwner[];
}): Finding | null {
  const derived = derivedWtRoot(p.name);
  if (!derived || p.wtRoot === derived) return null;
  const ours = (p.stranded ?? []).filter((o) => o.project.kind === 'same');
  const unsure = (p.stranded ?? []).filter((o) => o.project.kind === 'unknown');
  const left = ours.length ? ours : unsure;
  if (!left.length) return null;
  const key = p.from.key || 'WT_ROOT';
  const lines = p.from.source === 'scoped' ? `the ${key} line (and a plain WT_ROOT line, if any)` : `the ${key} line`;
  const what = ours.length
    ? `${left.length} worktree(s) of this project`
    : `${left.length} worktree(s) whose origin cannot be matched to this project or another`;
  const unmanaged = ours.length ? 'nothing manages them' : 'if they are this project\'s, nothing manages them';
  return {
    level: ours.length ? 'fail' : 'warn',
    label: ours.length
      ? 'WT_ROOT moved away from this project\'s worktrees'
      : 'WT_ROOT moved away from worktrees that may be this project\'s',
    detail: `${key}=${p.wtRoot} is in force, but the default root ~/Documents/${p.name}-wt still holds `
      + `${what} (e.g. ${left[0]?.dir}), and ${unmanaged} — or an app-<port> server running from one — `
      + `while WT_ROOT points elsewhere. Delete ${lines} from .env to return to ${derived}, or finish or `
      + 'remove those worktrees first.',
  };
}

/**
 * Do two paths name one directory? Real-pathed where they exist, so a symlink and
 * its target match. The native call, because only it returns the name as stored:
 * on a case-insensitive filesystem (macOS's default) the JS one keeps whatever
 * case it was given, and ~/documents/erp-wt would not match ~/Documents/erp-wt.
 */
export function sameDir(a: string, b: string): boolean {
  const real = (p: string): string => { try { return realpathSync.native(p); } catch { return resolve(p); } };
  return real(a) === real(b);
}

/**
 * judgeWtRoot() against what is on disk; without WT_ROOT's own worktrees when it
 * does not exist yet. Nothing to judge without a usable GITLAB_REPO_URL (that is
 * reported on its own). The derived root is listed only when WT_ROOT is some
 * other directory (a symlink to it, or from it, is the same one): a listing,
 * one git call per entry and one origin read per clone, and usually no
 * directory at all.
 */
export function wtRootFinding(
  wtRoot: string, from: ResolvedPath, name: string, env: NodeJS.ProcessEnv = process.env,
  list: (root: string, repoUrl: string) => WorktreeOwner[] = worktreeOwners,
): Finding | null {
  const { repo } = repoFromEnv(env);
  if (!wtRoot || !repo) return null;
  const derived = derivedWtRoot(name);
  const stranded = derived && !sameDir(derived, wtRoot) ? list(derived, repo.url) : [];
  if (!existsSync(wtRoot)) return strandedFinding({ wtRoot, from, name, stranded });
  return judgeWtRoot({ wtRoot, from, name, owners: list(wtRoot, repo.url), stranded });
}

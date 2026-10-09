/**
 * The readiness verdict the local automation tests mode acts on, as TypeScript,
 * and the one call that asks for it.
 *
 * The verdict itself is made by hooks/local-tests-ready.cjs — dependency-free
 * CJS this module starts as its own process, the way the Ready For Automation
 * mode starts hooks/automation-ready.cjs. One implementation of "is this
 * ticket's change merged, and is it the real change" is the point: a second
 * copy here would drift. This module declares the shape that file prints under
 * `localTestsReadiness`, reads it back out of whatever the process printed, and
 * holds the process to a deadline.
 *
 * Anything short of a well-formed verdict for THIS ticket reads as `unknown`,
 * and the runner holds on `unknown`: a check that did not produce a verdict
 * must never be guessed into `ready`.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ONESHOT_HOME, ROOT, envOr, projectConfig } from '../lib/config.js';
import { readToken } from '../lib/gitlab.js';
import { log } from '../lib/log.js';

/** The readiness script, under hooks/. Not a registered hook. */
export const LOCAL_TESTS_READY = 'local-tests-ready.cjs';

/** The script gives up on GitLab at 20s; the process is killed at 30s, so its own answer always comes first. */
const READY_TIMEOUT_MS = 30_000;

/**
 * One merged MR's change as a commit range: `git diff <base> <head>`.
 * `base` null means the commit before is `<head>^1` — a merge or squash
 * commit's first parent, which git answers and GitLab does not.
 */
export interface MergedRange {
  mrIid: number;
  base: string | null;
  /** The merge commit, else the squash commit, else the MR's head (a fast-forward). */
  head: string;
}

/** The merge request the hook proved merged: the change the tests run against. */
export interface MergedMr {
  iid: number;
  title: string;
  /** The merge commit — or the squash or head commit, for a merge that made none (the hook warns). */
  mergeSha: string;
  /**
   * The commit before the change: GitLab's diff base for a merge that left no
   * merge or squash commit, else null and the runner takes `<mergeSha>^1`.
   * Use mergedBase(); optional only so a verdict or fixture made before it
   * existed still reads.
   */
  base?: string | null;
  sourceBranch: string;
  targetBranch: string;
  /** GitLab username, for the results note's FYI mention. Null when GitLab did not say. */
  author: string | null;
  mergedAt: string | null;
  url: string;
  /**
   * Every one of the ticket's own MRs merged into the base, oldest first, the
   * last being this one; just this one when nothing linked closes or names the
   * ticket. Use mergedRanges(); optional for the same reason as `base`.
   */
  ranges?: MergedRange[];
}

/** The commit before the tested change, or null for `<mergeSha>^1`. */
export function mergedBase(m: MergedMr): string | null {
  return m.base ?? null;
}

/** Every range to scope, oldest first. A verdict without ranges scopes the tested MR alone. */
export function mergedRanges(m: MergedMr): MergedRange[] {
  return m.ranges && m.ranges.length ? m.ranges : [{ mrIid: m.iid, base: mergedBase(m), head: m.mergeSha }];
}

export type ReadinessErrorKind = 'auth' | 'notfound' | 'server' | 'network' | 'config' | 'other';

export interface LocalTestsReadiness {
  v: 1;
  verdict: 'ready' | 'not-ready' | 'unknown';
  /** True only for `ready`, and then `mergedMr` is set. */
  ready: boolean;
  iid: number;
  checkedAt: string;
  issueUpdatedAt: string | null;
  /** The trigger label is on the ticket, or a dry run was told to assume it. */
  labelled: boolean;
  /** One line: what was proved, or what is missing. */
  reason: string;
  mergedMr: MergedMr | null;
  warnings: string[];
  /** unknown only. */
  error?: string;
  errorKind?: ReadinessErrorKind;
}

const VERDICTS = new Set(['ready', 'not-ready', 'unknown']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A commit id as GitLab gives one. These reach git as arguments, so nothing else (an `-x` option, a ref name) passes. */
function isSha(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{7,64}$/i.test(v);
}

function isRange(v: unknown): v is MergedRange {
  return isRecord(v) && typeof v.mrIid === 'number' && isSha(v.head) && (v.base === null || isSha(v.base));
}

/**
 * `base` and `ranges` may be missing (an older verdict); present, they must be
 * well formed, and the ranges must end with the tested commit.
 */
function isMergedMr(v: unknown): v is MergedMr {
  if (!(isRecord(v) && typeof v.iid === 'number' && isSha(v.mergeSha)
    && typeof v.sourceBranch === 'string' && typeof v.targetBranch === 'string')) return false;
  if (v.base !== undefined && v.base !== null && !isSha(v.base)) return false;
  if (v.ranges === undefined) return true;
  if (!Array.isArray(v.ranges) || v.ranges.length === 0 || !v.ranges.every(isRange)) return false;
  const last = v.ranges[v.ranges.length - 1] as MergedRange;
  return last.mrIid === v.iid && last.head === v.mergeSha;
}

/** Fill what an older verdict left out, so every reader sees `base` and `ranges`. */
function withRanges(m: MergedMr): MergedMr {
  return { ...m, base: mergedBase(m), ranges: mergedRanges(m) };
}

/** Well formed enough to act on. A `ready` without a merged MR is not a verdict anybody can run. */
function isReadiness(v: unknown): v is LocalTestsReadiness {
  if (!isRecord(v)) return false;
  return v.v === 1
    && typeof v.verdict === 'string' && VERDICTS.has(v.verdict)
    && typeof v.iid === 'number'
    && typeof v.labelled === 'boolean'
    && typeof v.reason === 'string'
    && Array.isArray(v.warnings)
    && (v.verdict !== 'ready' || (v.ready === true && isMergedMr(v.mergedMr)))
    && (v.verdict === 'ready' || v.mergedMr == null || isMergedMr(v.mergedMr));
}

/** The `unknown` verdict this side words, for a script that gave none. */
export function unknownVerdict(iid: number, error: string, errorKind: ReadinessErrorKind = 'other'): LocalTestsReadiness {
  return {
    v: 1, verdict: 'unknown', ready: false, iid, checkedAt: new Date().toISOString(), issueUpdatedAt: null,
    labelled: false, reason: `the readiness check could not be made: ${error}`, mergedMr: null, warnings: [],
    error, errorKind,
  };
}

/**
 * Read the script's stdout object into a verdict.
 * - `localTestsReadiness` present, well formed and about `iid` → returned as is;
 * - anything else (`{}`, `{ reason }`, garbage, another ticket's verdict) → `unknown`.
 * Never throws.
 */
export function readinessFromOutput(out: unknown, iid: number): LocalTestsReadiness {
  try {
    if (!isRecord(out)) return unknownVerdict(iid, 'the readiness check gave no verdict');
    const r = out.localTestsReadiness;
    if (isReadiness(r)) {
      if (r.iid !== iid) return unknownVerdict(iid, `the readiness check answered for #${r.iid}, not #${iid}`);
      return { ...r, ready: r.verdict === 'ready', mergedMr: r.mergedMr ? withRanges(r.mergedMr) : null };
    }
    const reason = typeof out.reason === 'string' && out.reason ? out.reason : 'the readiness check gave no verdict';
    return unknownVerdict(iid, reason);
  } catch {
    return unknownVerdict(iid, 'the readiness check gave no verdict');
  }
}

/** What the conductor already knows, handed to the script so it does not decide policy twice. */
export interface ReadyInputs {
  trigger: string;
  base: string;
  /** A dry run told to treat the trigger as present (`--assume-label`). */
  assumeLabel?: boolean;
}

/**
 * The script's environment: the GitLab coordinates, the read token and the
 * resolved policy. Merged into the script's process only, NEVER a session's: a
 * token in a session's environment is a token it can print. May throw (no
 * GITLAB_REPO_URL); checkLocalTestsReady catches.
 */
export function localTestsReadyEnv(iid: number, o: ReadyInputs): Record<string, string> {
  const cfg = projectConfig();
  let token = '';
  try { token = readToken(); } catch { token = ''; }
  const release = cfg.automation?.releaseBranchPattern ?? '';
  return {
    ONESHOT_HOME,
    ONESHOT_TICKET: String(iid),
    ONESHOT_LOCAL_TESTS_API: cfg.gitlab.apiUrl,
    ONESHOT_LOCAL_TESTS_PROJECT: cfg.gitlab.project,
    ONESHOT_LOCAL_TESTS_TOKEN: token,
    ONESHOT_LOCAL_TESTS_TRIGGER: o.trigger,
    ONESHOT_LOCAL_TESTS_BASE: o.base,
    ONESHOT_LOCAL_TESTS_PROTECTED: JSON.stringify(cfg.branches.protected ?? []),
    ONESHOT_LOCAL_TESTS_RELEASE: typeof release === 'string' ? release : '',
    ONESHOT_LOCAL_TESTS_ASSUME_LABEL: o.assumeLabel ? '1' : '',
  };
}

/**
 * Run hooks/local-tests-ready.cjs for one ticket and read its verdict.
 *
 * Never throws and never hangs: a script that cannot start, overruns
 * READY_TIMEOUT_MS or prints garbage is `unknown`. `override` is merged last,
 * so a test can point ONESHOT_HOME at a scratch home (the script appends its
 * verdict to $ONESHOT_HOME/state/hook-events.jsonl) and the API at a fixture.
 */
export function checkLocalTestsReady(
  iid: number, o: ReadyInputs, override: Record<string, string> = {},
): Promise<LocalTestsReadiness> {
  const script = join(ROOT, 'hooks', LOCAL_TESTS_READY);
  if (!existsSync(script)) return Promise.resolve(unknownVerdict(iid, `hooks/${LOCAL_TESTS_READY} is missing`, 'config'));
  let env: Record<string, string>;
  try {
    env = { ...localTestsReadyEnv(iid, o), ...override };
  } catch (err) {
    return Promise.resolve(unknownVerdict(iid, `the readiness check could not start (${(err as Error).message})`, 'config'));
  }
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const done = (r: LocalTestsReadiness): void => { if (!settled) { settled = true; resolve(r); } };
    const child = spawn(envOr('ONESHOT_NODE', process.execPath), [script], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      log.warn(`hooks/${LOCAL_TESTS_READY} timed out for #${iid}`);
      done(unknownVerdict(iid, `the readiness check gave no answer within ${READY_TIMEOUT_MS / 1000}s`, 'network'));
    }, READY_TIMEOUT_MS);
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.on('error', (err) => {
      clearTimeout(killer);
      done(unknownVerdict(iid, `the readiness check could not start (${err.message})`, 'other'));
    });
    child.on('close', () => {
      clearTimeout(killer);
      let parsed: unknown = null;
      try { parsed = JSON.parse(stdout); } catch { parsed = null; }
      done(readinessFromOutput(parsed, iid));
    });
  });
}

/**
 * From a diagnosed harness defect to a pull request a person can merge.
 *
 * Four agents and a referee. One session writes the fix and its test. Two read
 * the result independently, through different lenses. A fourth tries to refute
 * what those two raised and to confirm the change does what it is for. The
 * referee is this file, and it is code: it decides who goes next, and it
 * measures for itself everything a session could simply assert.
 *
 * What is measured here and never taken on a session's word:
 *
 *   - the typecheck and the whole suite, run on the author's commits;
 *   - the reproduction: the author's changed tests are run against the base
 *     branch WITHOUT the fix, in a second checkout, and must fail there. A test
 *     that passes on the base does not show the defect, however it reads;
 *   - the size and shape of the diff (decide.ts `diffGuard`).
 *
 * What only a person does: merge. The pipeline pushes one branch, opens one
 * pull request against the base branch, and stops. It never merges and never
 * turns auto-merge on, and nothing in it holds a command that could.
 *
 * Sessions run through runPhase() like every other, for the reason
 * attemptRemediation() gives: the guards, the tool policy, the transcript and
 * the quota accounting apply to the sessions that change Oneshot's own source
 * exactly as they apply to the ones that change the work repo.
 *
 * NOTHING A SESSION DOES CAN PUBLISH. The fix is written in a private clone of
 * the operator's clone, made for the one finding and deleted afterwards. Its
 * only remote is that local clone, so the pushes the guards allow a session
 * (its own branch, to `origin`) land on this disk and nowhere else, and
 * git-guard denies `gh` and any other destination. The one push to GitHub is
 * made here, after the review, by address, and it pushes the exact commit the
 * checks and the reviewers saw: not a branch name a session could have moved.
 *
 * WHERE IT RUNS. Wherever there is a clone whose origin is the GitHub
 * repository and a `gh` that is signed in. That is a desk. It is not the
 * server today: its checkout's origin is a git bundle and it holds no GitHub
 * credential, so there `readiness()` says exactly that and nothing else
 * happens. docs/DIAGNOSIS.md says what the server would need.
 *
 * The base is `main` (ONESHOT_FIX_BASE): the only branch of the GitHub
 * repository that is current, and the one every pull request there targets. A
 * defect in code that is not on the base gets no pull request: the author finds
 * the code is not there and refuses, which is the right answer.
 */
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DRY_RUN, PAUSE, PROJECT_TARGET, ROOT, envOr, expandPath, gitlabUsername, modelFor, phaseByName, type PhaseConfig,
} from '../../lib/config.js';
import { logEvent, phaseEnd, phaseStart } from '../../lib/db.js';
import { activeClaims } from '../../lib/claims.js';
import { addIssueNote, allIssueNotes, getIssue, type GitlabResult, type Issue, type IssueNote } from '../../lib/gitlab.js';
import { log } from '../../lib/log.js';
import { checkQuota, quotaParked } from '../../lib/quota.js';
import { CANCELLED_BY_CONDUCTOR, runPhase, type PhaseInput, type PhaseOutput } from '../../conductor/phase.js';
import { systemPromptFor } from '../../phases/prompts.js';
import type { RunJournal } from '../../lib/artifacts.js';
import { fixMarker, renderFixNote } from '../note.js';
import { acquireLock, readDiagnosisFile, releaseLock, updateDiagnosisFile } from '../record.js';
import { mayPostOn } from '../stop.js';
import type { CheckedFinding, FixRecord, StopDiagnosis } from '../types.js';
import {
  checksPass, diffGuard, fixBranch, fixEligibility, githubSlug, isRunnableTest, nextMove, parseTap, prTitle, repoPathOf,
  reviewPoints, rulingsOf, tally, upheld, type Checks, type DiffStat, type ReviewPoint, type Ruling,
} from './decide.js';
import { fixPrMarker, leaks, publicSafe, renderPrBody, type PrivateText } from './prbody.js';
import { fixAuthorPrompt, fixReviewPrompt, fixVerifyPrompt, type FixCtx } from './prompts.js';

export const FIX_AUTHOR = 'fix-author';
export const FIX_REVIEW = 'fix-review';
export const FIX_VERIFY = 'fix-verify';

/** Fixes one stop may have opened for it without a person asking. */
const MAX_FIXES_PER_STOP = 2;
/** A fix's lock older than this is a process that died holding it: three author laps, two reviews and three verifier laps fit well inside. */
const LOCK_STALE_MS = 6 * 60 * 60_000;

const TYPECHECK = ['node', 'node_modules/typescript/bin/tsc', '--noEmit', '-p', '.'];
const TSX = ['node', 'node_modules/tsx/dist/cli.mjs'];
const COMMANDS = {
  typecheck: TYPECHECK.join(' '),
  tests: `${TSX.join(' ')} --test $(find src -name "*.test.ts" | sort)`,
  oneTest: `${TSX.join(' ')} --test`,
  hooks: 'bash scripts/verify-hooks.sh',
};

// ----------------------------------------------------------------------- deps

export interface ExecResult { code: number; out: string }

/**
 * Every effect, injectable. `exec` is the one door to git, gh, the compiler
 * and the test runner, so a test scripts the whole outside world through it.
 */
export interface FixDeps {
  now(): number;
  dryRun: boolean;
  me(): string;
  /** A clone whose origin is the GitHub repository. */
  repo: string;
  base: string;
  /** Where fix worktrees are made. Outside the repo: write-scope denies every phase the conductor's own src/. */
  worktreeRoot: string;
  /** The work project's name, for `erp#9174`. */
  project: string;
  exec(cmd: string, args: string[], o: { cwd: string; timeoutMs?: number; signal?: AbortSignal }): Promise<ExecResult>;
  session(input: PhaseInput): Promise<PhaseOutput>;
  phase(name: string): PhaseConfig | undefined;
  sessionHold(runId: string, lap: number): string | null;
  /** state/PAUSE is set: an operator has asked this desk to do nothing. */
  paused(): boolean;
  /** What must not reach a public repository and can be named exactly: the work project's host, the ticket's title, this machine. */
  privateText(journal: RunJournal): PrivateText[];
  attempt: { start(runId: string, phase: string, lap: number, model: string): number; end(id: number, status: string, out: PhaseOutput): void };
  gitlab: {
    getIssue(iid: number): Promise<GitlabResult<Issue>>;
    notes(iid: number): Promise<GitlabResult<IssueNote[]>>;
    addNote(iid: number, body: string): Promise<GitlabResult<{ id: number }>>;
  };
  event(kind: string, detail: Record<string, unknown>, runId?: string): void;
}

function run(cmd: string, args: string[], o: { cwd: string; timeoutMs?: number; signal?: AbortSignal }): Promise<ExecResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', HUSKY: '0', NO_COLOR: '1' };
  // node:test marks its child processes with this, and a `node --test` that
  // inherits it reports to a parent runner instead of printing a summary. The
  // suite this pipeline runs is nobody's child test: it must print its own.
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve) => {
    execFile(cmd, args, {
      cwd: o.cwd, timeout: o.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024, env, ...(o.signal ? { signal: o.signal } : {}),
    }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, out: `${stdout ?? ''}${stderr ?? ''}` });
    });
  });
}

export function defaultFixDeps(): FixDeps {
  const repo = expandPath(envOr('ONESHOT_FIX_REPO', ROOT));
  return {
    now: () => Date.now(),
    dryRun: DRY_RUN,
    me: gitlabUsername,
    repo,
    base: envOr('ONESHOT_FIX_BASE', 'main'),
    worktreeRoot: expandPath(envOr('ONESHOT_FIX_WT_ROOT', join(dirname(repo), 'oneshot-fix-wt'))),
    project: PROJECT_TARGET || 'ticket',
    exec: run,
    session: runPhase,
    phase: phaseByName,
    sessionHold: (runId, lap) => {
      if (existsSync(PAUSE)) return 'paused (state/PAUSE)';
      if (quotaParked()) return 'parked after a subscription usage limit';
      const q = checkQuota(runId, FIX_AUTHOR, lap);
      return q.allowed ? null : q.reason ?? 'over budget';
    },
    paused: () => existsSync(PAUSE),
    privateText: (journal) => {
      let host = '';
      try { host = new URL(envOr('GITLAB_REPO_URL')).host; } catch { /* not configured */ }
      const machine = hostname();
      return [
        { what: 'the work project\'s host', text: host },
        { what: 'the ticket\'s title', text: (journal.title ?? '').trim().length >= 12 ? (journal.title ?? '').trim() : '' },
        { what: 'a home directory', text: homedir() },
        { what: 'this machine\'s name', text: /^(localhost|ip-|\d)/i.test(machine) ? '' : machine },
      ].filter((k) => k.text);
    },
    attempt: {
      start: (runId, phase, lap, model) => phaseStart(runId, phase, lap, model),
      end: (id, status, out) => phaseEnd(id, status, {
        turns: out.turns, weighted: out.weighted, sessionId: out.sessionId, detail: out.error ?? out.blocked ?? undefined,
      }),
    },
    gitlab: { getIssue, notes: allIssueNotes, addNote: addIssueNote },
    event: (kind, detail, runId) => logEvent(kind, detail, { runId, phase: FIX_AUTHOR }),
  };
}

// ------------------------------------------------------------------ readiness

export type Ready = { ok: true; slug: string; pushUrl: string } | { ok: false; why: string };

/**
 * Whether this machine can open a pull request at all, and against what.
 *
 * Asked before any session is paid for. The answers it refuses with are the
 * things an operator would have to change, said in those words.
 */
export async function readiness(deps: FixDeps): Promise<Ready> {
  if (!existsSync(join(deps.repo, '.git'))) return { ok: false, why: `${deps.repo} is not a git checkout (ONESHOT_FIX_REPO)` };
  const remote = await deps.exec('git', ['remote', 'get-url', 'origin'], { cwd: deps.repo });
  const slug = remote.code === 0 ? githubSlug(remote.out.trim()) : null;
  if (!slug) {
    return {
      ok: false,
      why: `the origin of ${deps.repo} is not a GitHub repository, so there is nowhere to open a pull request from here: `
        + 'point ONESHOT_FIX_REPO at a clone of the GitHub repository',
    };
  }
  const auth = await deps.exec('gh', ['auth', 'status'], { cwd: deps.repo });
  if (auth.code !== 0) return { ok: false, why: 'this machine has no GitHub credentials (`gh auth status` failed), so it cannot push or open a pull request' };
  const fetched = await deps.exec('git', ['fetch', '--quiet', 'origin', deps.base], { cwd: deps.repo, timeoutMs: 180_000 });
  if (fetched.code !== 0) return { ok: false, why: `could not fetch origin/${deps.base}: ${fetched.out.trim().split('\n')[0] ?? ''}` };
  const push = await deps.exec('git', ['remote', 'get-url', '--push', 'origin'], { cwd: deps.repo });
  return { ok: true, slug, pushUrl: push.code === 0 && push.out.trim() ? push.out.trim() : remote.out.trim() };
}

// ------------------------------------------------------------------ checkouts

/** `baseSha` is GitHub's base branch as readiness() fetched it: what the fix is cut from and measured against. */
interface Tree { path: string; branch: string; baseSha: string }

const ours = (deps: FixDeps, path: string): boolean => path.startsWith(`${deps.worktreeRoot}/`);

/**
 * A private clone of the operator's clone, on a new branch at the base.
 *
 * A clone and not a worktree, for one reason: its `origin` is the directory it
 * was cloned from. A worktree shares the operator's remotes, so the push the
 * guards allow a session would go to GitHub; from here it cannot. The base
 * branch is fetched under its usual name, so `origin/<base>` in a prompt or a
 * command means what it means everywhere else.
 */
async function makeCheckout(deps: FixDeps, path: string, branch: string): Promise<Tree | { error: string }> {
  const last = (r: ExecResult): string => r.out.trim().split('\n').slice(-1)[0] ?? '';
  if (!ours(deps, path)) return { error: `${path} is outside ${deps.worktreeRoot}` };
  rmSync(path, { recursive: true, force: true });
  mkdirSync(dirname(path), { recursive: true });
  const clone = await deps.exec('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--quiet', '--no-checkout', deps.repo, path], { cwd: deps.repo, timeoutMs: 300_000 });
  if (clone.code !== 0) return { error: `git clone failed: ${last(clone)}` };
  const ref = `refs/remotes/origin/${deps.base}`;
  const fetched = await deps.exec('git', ['fetch', '--quiet', 'origin', `+${ref}:${ref}`], { cwd: path, timeoutMs: 180_000 });
  if (fetched.code !== 0) return { error: `could not take origin/${deps.base} into the fix checkout: ${last(fetched)}` };
  const sha = await deps.exec('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: path });
  if (sha.code !== 0 || !sha.out.trim()) return { error: `origin/${deps.base} is not a commit in the fix checkout` };
  const out = await deps.exec('git', ['-c', 'core.hooksPath=/dev/null', 'checkout', '--quiet', '--no-track', '-B', branch, sha.out.trim()], { cwd: path, timeoutMs: 180_000 });
  if (out.code !== 0) return { error: `git checkout failed: ${last(out)}` };
  return { path, branch, baseSha: sha.out.trim() };
}

async function linkModules(deps: FixDeps, path: string, signal?: AbortSignal): Promise<string | null> {
  // The link is this pipeline's, not the fix's. `.gitignore` says
  // `node_modules/`, which matches a directory and not a link to one, so
  // without this the checkout is never clean and `git add -A` commits the link.
  try { appendFileSync(join(path, '.git', 'info', 'exclude'), '\n/node_modules\n'); } catch { /* a checkout without one is caught by the dirty check */ }
  // The base's own dependencies when they differ from this checkout's: a fix
  // tested against the wrong zod is a fix tested against nothing.
  const lock = await deps.exec('git', ['show', `origin/${deps.base}:package-lock.json`], { cwd: deps.repo });
  let same = false;
  try { same = lock.code === 0 && lock.out === readFileSync(join(deps.repo, 'package-lock.json'), 'utf8'); } catch { /* no lockfile here */ }
  if (same && existsSync(join(deps.repo, 'node_modules'))) {
    try { symlinkSync(join(deps.repo, 'node_modules'), join(path, 'node_modules')); } catch { /* already there */ }
    return null;
  }
  const ci = await deps.exec('npm', ['ci', '--no-audit', '--no-fund'], { cwd: path, timeoutMs: 15 * 60_000, signal });
  return ci.code === 0 ? null : `could not install the dependencies of origin/${deps.base}: ${ci.out.trim().split('\n').slice(-2).join(' ')}`;
}

/** Only ever a directory this file made, under the root it makes them in. */
function dropCheckout(deps: FixDeps, path: string): void {
  if (ours(deps, path)) rmSync(path, { recursive: true, force: true });
}

/**
 * Put the checkout back at a commit, exactly.
 *
 * Run after the read-only sessions: they hold no Write or Edit tool, and Bash
 * can still leave a scratch file or move a ref, which the next lap would find
 * as its own uncommitted work. Never run after the author, whose uncommitted
 * work is the author's to commit.
 */
async function restore(deps: FixDeps, tree: Tree, sha: string): Promise<void> {
  await deps.exec('git', ['-c', 'core.hooksPath=/dev/null', 'checkout', '--quiet', '--force', '--no-track', '-B', tree.branch, sha], { cwd: tree.path });
  await deps.exec('git', ['clean', '--quiet', '-fd'], { cwd: tree.path });
}

// --------------------------------------------------------------------- checks

async function diffStat(deps: FixDeps, tree: Tree): Promise<DiffStat> {
  const range = `${tree.baseSha}...HEAD`;
  // --no-renames: a file moved out of deploy/ is a change to deploy/, and a rename shows only where it went.
  const names = await deps.exec('git', ['diff', '--no-renames', '--name-only', range], { cwd: tree.path });
  const stat = await deps.exec('git', ['diff', '--no-renames', '--shortstat', range], { cwd: tree.path });
  return {
    files: names.out.split('\n').map((s) => s.trim()).filter(Boolean),
    insertions: Number(/(\d+) insertion/.exec(stat.out)?.[1] ?? 0),
    deletions: Number(/(\d+) deletion/.exec(stat.out)?.[1] ?? 0),
  };
}

const lastLine = (s: string): string => s.trim().split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 300) ?? '';

/**
 * Run the changed tests against the base branch without the fix.
 *
 * In a second checkout of the base, with only the test files taken from the
 * fix branch. They must fail there: the run exits non-zero AND its summary
 * counts a failure. A run with no summary proves nothing (a timeout and a
 * missing runner both look like that), so it is not a reproduction. This cannot
 * tell WHY they fail (a test that imports a module the fix adds fails at the
 * import), which is why the verifier is asked to read them; what it does
 * establish is the direction: a test that passes on the base is not a
 * reproduction.
 */
async function redCheck(deps: FixDeps, tree: Tree, files: string[], signal?: AbortSignal): Promise<Checks['red']> {
  const tests = files.filter(isRunnableTest);
  if (!tests.length) {
    return files.includes('scripts/verify-hooks.sh')
      ? { ok: true, text: 'not run: the change is to the hooks and is covered by scripts/verify-hooks.sh, which has no per-case runner' }
      : { ok: false, text: 'no test file was changed' };
  }
  const base = `${tree.path}-base`;
  if (!ours(deps, base)) return { ok: false, text: `${base} is outside ${deps.worktreeRoot}` };
  rmSync(base, { recursive: true, force: true });
  const added = await deps.exec('git', ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--quiet', '--detach', base, tree.baseSha], { cwd: tree.path, timeoutMs: 180_000 });
  if (added.code !== 0) return { ok: false, text: `could not check out origin/${deps.base} to run the tests against: ${lastLine(added.out)}` };
  try {
    try { symlinkSync(join(tree.path, 'node_modules'), join(base, 'node_modules')); } catch { /* already there */ }
    for (const f of tests) {
      const body = await deps.exec('git', ['show', `HEAD:${f}`], { cwd: tree.path });
      if (body.code !== 0) continue;
      mkdirSync(dirname(join(base, f)), { recursive: true });
      writeFileSync(join(base, f), body.out);
    }
    const res = await deps.exec(TSX[0]!, [TSX[1]!, '--test', ...tests], { cwd: base, timeoutMs: 15 * 60_000, signal });
    const tap = parseTap(res.out);
    const on = `${tests.length} changed test file(s) on origin/${deps.base} without the fix`;
    if (!tap) return { ok: false, text: `${on}: the run printed no summary, so it shows nothing (${lastLine(res.out) || `exit ${res.code}`})` };
    const red = tap.fail > 0 && res.code !== 0;
    return { ok: red, text: red ? `${on}: ${tap.fail} failing, ${tap.pass} passing` : `${on}: they PASS (${tap.pass} passing, ${tap.fail} failing, exit ${res.code})` };
  } finally {
    await deps.exec('git', ['worktree', 'remove', '--force', base], { cwd: tree.path });
    dropCheckout(deps, base);
  }
}

export async function runChecks(deps: FixDeps, tree: Tree, stat: DiffStat, signal?: AbortSignal): Promise<Checks> {
  const tc = await deps.exec(TYPECHECK[0]!, TYPECHECK.slice(1), { cwd: tree.path, timeoutMs: 10 * 60_000, signal });
  const typecheck = { ok: tc.code === 0, text: tc.code === 0 ? 'clean' : tc.out.trim().split('\n').slice(0, 6).join(' | ').slice(0, 500) };

  const found = await deps.exec('find', ['src', '-name', '*.test.ts'], { cwd: tree.path });
  const files = found.out.split('\n').map((s) => s.trim()).filter(Boolean).sort();
  const t = await deps.exec(TSX[0]!, [TSX[1]!, '--test', ...files], { cwd: tree.path, timeoutMs: 30 * 60_000, signal });
  const tap = parseTap(t.out);
  const tests = tap
    ? { ok: tap.fail === 0 && t.code === 0, pass: tap.pass, fail: tap.fail, text: `${tap.pass} pass, ${tap.fail} fail` }
    : { ok: false, pass: 0, fail: 0, text: `the suite printed no summary: ${lastLine(t.out)}` };

  const touchesHooks = stat.files.some((f) => f.startsWith('hooks/') || f === 'src/conductor/hooks.ts' || f === 'scripts/verify-hooks.sh');
  let hooks: Checks['hooks'] = { ok: true, ran: false, text: '' };
  if (touchesHooks) {
    const h = await deps.exec('bash', ['scripts/verify-hooks.sh'], { cwd: tree.path, timeoutMs: 15 * 60_000, signal });
    hooks = { ok: h.code === 0, ran: true, text: lastLine(h.out) || (h.code === 0 ? 'passed' : 'failed') };
  }

  return { typecheck, tests, hooks, red: await redCheck(deps, tree, stat.files, signal) };
}

function measuredText(c: Checks, base: string): string {
  return [
    `- typecheck (${COMMANDS.typecheck}): ${c.typecheck.text}`,
    `- whole suite (${COMMANDS.tests}): ${c.tests.text}`,
    c.hooks.ran ? `- ${COMMANDS.hooks}: ${c.hooks.text}` : '',
    `- reproduction, the changed tests run on origin/${base} WITHOUT the fix: ${c.red.text}`,
  ].filter(Boolean).join('\n');
}

// ------------------------------------------------------------------- sessions

interface SessionCtx {
  deps: FixDeps;
  iid: number;
  runId: string;
  journal: RunJournal;
  tree: Tree;
  artifacts: string;
  signal?: AbortSignal;
}

async function runSession(
  s: SessionCtx, phaseName: string, lap: number, artifact: string, prompt: string,
): Promise<PhaseOutput | { held: string }> {
  const cfg = s.deps.phase(phaseName);
  if (!cfg || cfg.kind !== 'session') return { held: `config/phases.json has no '${phaseName}' session phase` };
  const hold = s.deps.sessionHold(s.runId, lap);
  if (hold) return { held: hold };
  const model = modelFor(cfg);
  const row = s.deps.attempt.start(s.runId, phaseName, lap, model);
  let out: PhaseOutput;
  try {
    out = await s.deps.session({
      iid: s.iid, runId: s.runId, lap,
      cfg: { ...cfg, artifact: join(s.artifacts, artifact) },
      prompt,
      systemPrompt: systemPromptFor(cfg, {
        ticket: { iid: s.iid, title: s.journal.title ?? '', description: null, labels: [] },
        runId: s.runId, lap, journal: s.journal, prior: {}, worktree: s.tree.path, branch: s.tree.branch,
      }),
      worktree: s.tree.path,
      branch: s.tree.branch,
      signal: s.signal,
      // The fix is to this repository. Nothing about it needs the work project's GitLab.
      gitlabMcp: false,
      // These sessions read and write about failures, a usage limit among them.
      limitFromProse: false,
    });
  } catch (err) {
    out = {
      ok: false, data: null, blocked: null, summary: '', turns: 0, weighted: 0, sessionId: '',
      rateLimited: false, error: (err as Error).message,
    };
  }
  s.deps.attempt.end(row, out.ok && out.data ? 'ok' : out.infra ? 'infra' : 'failed', out);
  return out;
}

const failedWhy = (out: PhaseOutput): string =>
  (out.blocked ? `it reported it was blocked: ${out.blocked}` : out.error ?? 'it returned nothing').slice(0, 300);

/** Cut off by something that says nothing about the fix: a shutdown, the usage limit, an account notice. */
const interrupted = (out: PhaseOutput): boolean =>
  out.error === CANCELLED_BY_CONDUCTOR || out.rateLimited === true || !!out.accountAction;

// ---------------------------------------------------------------- one finding

export interface FixOpts {
  iid: number;
  /** The run directory holding diagnosis.json. */
  dir: string;
  /** One finding id; otherwise every eligible finding of the latest stop. */
  only?: string;
  /** A person asked: retry a finding that was refused or failed before. */
  force?: boolean;
  /** Say on the ticket that a fix was opened. Default false: by hand nothing is posted unless asked. */
  post?: boolean;
  signal?: AbortSignal;
}

/**
 * The whole pipeline for one finding. Returns what became of it; never throws
 * for anything a session or a command did.
 *
 * THE REVIEW, round by round. The two reviewers run once, on the first round
 * whose commits pass every check, whichever round that is. The verifier runs on
 * every round that passes them: first on everything the reviewers raised, then
 * on what is still `standing`, which is every blocker a verifier has not ruled
 * out, its own included. A blocker leaves `standing` only by a verifier ruling
 * that it does not hold. The author returning from a fix lap proves nothing,
 * and a round whose checks failed leaves the list as it was.
 */
export async function fixFinding(
  o: { iid: number; dir: string; journal: RunJournal; stop: StopDiagnosis; finding: CheckedFinding; signal?: AbortSignal },
  deps: FixDeps,
): Promise<FixRecord> {
  const { iid, finding, stop } = o;
  const at = deps.now();
  const refused = (why: string): FixRecord => ({ state: 'refused', why, at });
  const failed = (why: string): FixRecord => ({ state: 'failed', why, at });
  const held = (why: string): FixRecord => ({ state: 'held', why, at });

  // A dry run gives the author no Write or Edit tool and lets nothing be pushed: there is no fix to make, only sessions to pay for.
  if (deps.dryRun) return { state: 'unavailable', why: 'dry run: no fix is written and nothing is pushed', at };
  const ready = await readiness(deps);
  if (!ready.ok) return { state: 'unavailable', why: ready.why, at };

  // Free, and before anyone is paid: is the code the finding points at on the
  // base branch at all? A run is diagnosed against the code it used, which can
  // be branches ahead of the base, and a defect in a file the base does not
  // have is not one a pull request against the base can fix.
  const cited = [...new Set(finding.evidence.filter((c) => c.ok && c.file.startsWith('repo:')).map((c) => repoPathOf(c.file)).filter(Boolean))];
  const present: string[] = [];
  for (const file of cited) {
    if ((await deps.exec('git', ['cat-file', '-e', `origin/${deps.base}:${file}`], { cwd: deps.repo })).code === 0) present.push(file);
  }
  if (cited.length && !present.length) {
    return refused(`the code it shows (${cited.slice(0, 3).join(', ')}) is not on origin/${deps.base}: it is on a branch that has not landed there, so there is nothing on ${deps.base} to fix`);
  }

  const branch = fixBranch(iid, stop.key, finding.id);
  const marker = fixPrMarker(iid, stop.key, finding.id);
  const prs = await deps.exec('gh', [
    'pr', 'list', '--repo', ready.slug, '--head', branch, '--state', 'all', '--json', 'number,url,state,body,isCrossRepository',
  ], { cwd: deps.repo });
  if (prs.code !== 0) return failed(`could not ask GitHub whether a pull request already exists: ${lastLine(prs.out)}`);
  let listed: Array<{ number: number; url: string; state: string; body?: string; isCrossRepository?: boolean }>;
  try { listed = JSON.parse(prs.out || '[]') as typeof listed; } catch { return failed('GitHub\'s answer about existing pull requests could not be read'); }
  // Its own only: opened from this repository, with this finding's marker in its
  // description. `--head` matches by name, and a fork can name a branch anything.
  const mine = listed.find((p) => p.isCrossRepository !== true && (p.body ?? '').includes(marker));
  if (mine?.state === 'OPEN') return { state: 'opened', prUrl: mine.url, prNumber: mine.number, branch, at };
  if (mine) return refused(`a pull request for this finding already exists and is ${mine.state.toLowerCase()}: ${mine.url}`);
  const taken = async (): Promise<FixRecord | null> => {
    const remote = await deps.exec('git', ['ls-remote', '--heads', ready.pushUrl, branch], { cwd: deps.repo });
    if (remote.code !== 0) return failed(`could not ask GitHub whether ${branch} exists: ${lastLine(remote.out)}`);
    return remote.out.trim()
      ? refused(`a branch named ${branch} is already on GitHub and is not this pipeline's pull request: delete it, or open its pull request by hand`)
      : null;
  };
  const already = await taken();
  if (already) return already;

  const path = join(deps.worktreeRoot, branch.replace(/\//g, '-'));
  // A session may push its branch to `origin`, which from the fix checkout is this clone. Tidied afterwards, unless it was here first.
  const local = `refs/heads/${branch}`;
  const hadLocal = (await deps.exec('git', ['rev-parse', '--verify', '--quiet', local], { cwd: deps.repo })).code === 0;
  const made = await makeCheckout(deps, path, branch);
  if ('error' in made) {
    dropCheckout(deps, path);
    return failed(`could not make the fix checkout: ${made.error}`);
  }
  const tree = made;

  try {
    const modules = await linkModules(deps, tree.path, o.signal);
    if (o.signal?.aborted) return held('stopped while the fix checkout was being made');
    if (modules) return failed(modules);

    const n = Number(/\d+/.exec(finding.id)?.[0] ?? 0);
    const artifacts = join('diagnosis', 'fix', stop.key.replace(/[^\w-]/g, '_'), finding.id.replace(/[^\w-]/g, '_'));
    mkdirSync(join(o.dir, artifacts), { recursive: true });
    const s: SessionCtx = { deps, iid, runId: o.journal.runId, journal: o.journal, tree, artifacts, signal: o.signal };
    const ctx: FixCtx = {
      iid, ticketRef: `${deps.project}#${iid}`, finding, worktree: tree.path, branch, base: deps.base, commands: COMMANDS,
    };

    let round = 0;
    let blockers: ReviewPoint[] = [];
    let author: Record<string, unknown> = {};
    const points: ReviewPoint[] = [];
    let rulings: Ruling[] = [];
    const additional: ReviewPoint[] = [];
    let standing: ReviewPoint[] = [];
    const stood = new Set<string>();
    const fixed = new Set<string>();
    let reviewed = false;
    let checks: Checks;
    /** The commit the last passing checks ran on: the one the reviewers read, and the one that is pushed. */
    let measured = '';

    for (;;) {
      const a = await runSession(s, FIX_AUTHOR, n * 10 + round, `author-${round}.json`, fixAuthorPrompt(ctx, round, blockers));
      if ('held' in a) return held(a.held);
      if (interrupted(a)) return held(`the author session was interrupted: ${failedWhy(a)}`);
      if (!a.ok || !a.data) return failed(`the author session failed: ${failedWhy(a)}`);
      author = a.data;
      if (author.outcome === 'refused') return refused(`the author declined: ${String(author.refusal || author.summary || 'no reason given').slice(0, 400)}`);
      if (round === 0 && author.reproduced !== true) return refused('the author did not reproduce the defect with a failing test, so there is nothing to show it was there');

      const stat = await diffStat(deps, tree);
      const guard = diffGuard(stat);
      if (!guard.ok) return refused(guard.why);
      const dirty = (await deps.exec('git', ['status', '--porcelain'], { cwd: tree.path })).out.trim();
      const head = (await deps.exec('git', ['rev-parse', 'HEAD'], { cwd: tree.path })).out.trim();

      checks = await runChecks(deps, tree, stat, o.signal);
      if (o.signal?.aborted) return held('stopped while the checks were running');
      const uncommitted: ReviewPoint[] = dirty
        ? [{ id: 'C-0', severity: 'blocker', file: '', line: 0, what: 'there are uncommitted changes in the worktree', why: dirty.split('\n').slice(0, 5).join('; '), fix: 'commit them, or remove what is not part of the fix' }]
        : [];

      // Until a verifier rules this round, what stood still stands.
      let outstanding = [...uncommitted, ...standing];
      let shippable = true;
      let stopNow = false;
      let said = '';
      // Reviewing commits that do not compile or do not reproduce is paying
      // three sessions to be told what the checks already said.
      if (checksPass(checks) && !dirty) {
        measured = head;
        ctx.measured = measuredText(checks, deps.base);
        let open = standing;
        if (!reviewed) {
          const [ra, rb] = await Promise.all([
            runSession(s, FIX_REVIEW, n * 10, 'review-A.json', fixReviewPrompt(ctx, 'A')),
            runSession(s, FIX_REVIEW, n * 10 + 1, 'review-B.json', fixReviewPrompt(ctx, 'B')),
          ]);
          await restore(deps, tree, measured);
          for (const [lens, r] of [['A', ra], ['B', rb]] as const) {
            if ('held' in r) return held(r.held);
            if (interrupted(r)) return held(`reviewer ${lens} was interrupted: ${failedWhy(r)}`);
            if (!r.ok || !r.data) return failed(`reviewer ${lens} failed: ${failedWhy(r)}`);
            points.push(...reviewPoints(lens, r.data));
          }
          reviewed = true;
          // Everything they raised, on the round they raised it, whichever round that is.
          open = points;
        }
        const v = await runSession(s, FIX_VERIFY, n * 10 + round, `verify-${round}.json`, fixVerifyPrompt(ctx, open, round));
        await restore(deps, tree, measured);
        if ('held' in v) return held(v.held);
        if (interrupted(v)) return held(`the verifier was interrupted: ${failedWhy(v)}`);
        if (!v.ok || !v.data) return failed(`the verifier failed: ${failedWhy(v)}`);
        const ruled = rulingsOf(v.data);
        rulings = [...rulings.filter((r) => !ruled.some((x) => x.id === r.id)), ...ruled];
        const more = reviewPoints(`V${round}`, { findings: v.data.additional });
        additional.push(...more);
        const still = upheld(open, ruled, more);
        // Fixed is a verifier's word on a blocker that stood, never the author's.
        for (const p of standing) if (!still.some((x) => x.id === p.id)) fixed.add(p.id);
        for (const p of still) stood.add(p.id);
        standing = still;
        outstanding = standing;
        stopNow = v.data.verdict === 'do-not-ship';
        shippable = !stopNow && v.data.fixesTheCause === true;
        said = String(v.data.reason ?? '');
      }

      const move = nextMove({ round, checks, outstanding, shippable, verifierSaid: said, stop: stopNow });
      if (move.act === 'refuse') return refused(move.why);
      if (move.act === 'open') break;
      blockers = move.blockers;
      round += 1;
    }

    const sum = tally({ points, additional, stood, fixed });
    const review = { ...sum, rounds: round };
    const checkLine: FixRecord['checks'] = {
      typecheck: checks.typecheck.text, tests: checks.tests.text, hooks: checks.hooks.ran ? checks.hooks.text : '', redGreen: checks.red.text,
    };

    // The description is rewritten by publicSafe(). The commits cannot be, so
    // what they would publish is read back and a leak is a refusal.
    const known = deps.privateText(o.journal);
    const messages = await deps.exec('git', ['log', '--format=%B', `${tree.baseSha}..${measured}`], { cwd: tree.path });
    const patch = await deps.exec('git', ['diff', '--no-renames', '--unified=0', tree.baseSha, measured], { cwd: tree.path });
    if (messages.code !== 0 || patch.code !== 0) return failed('could not read the commits back to see what they would publish');
    const added = patch.out.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
    const leaked = [
      ...leaks(messages.out, known).map((what) => `${what} in a commit message`),
      ...leaks(added, known).map((what) => `${what} in the change itself`),
    ];
    if (leaked.length) return refused(`it would publish ${leaked.join(', and ')}, on a public repository`);

    if (o.signal?.aborted || deps.paused()) return held('stopped before anything was pushed');
    // Asked again this late: a branch of that name that has appeared since is somebody else's, and is left alone.
    const since = await taken();
    if (since) return since;

    // By its id: the commit every check ran on and the reviewers read. A branch
    // name is whatever the last session left it pointing at.
    const pushed = await deps.exec('git', ['push', ready.pushUrl, `${measured}:refs/heads/${branch}`], { cwd: tree.path, timeoutMs: 180_000 });
    if (pushed.code !== 0) return failed(`the push was refused: ${lastLine(pushed.out)}`);

    const bodyFile = join(o.dir, artifacts, 'pr-body.md');
    writeFileSync(bodyFile, renderPrBody({
      iid, project: deps.project, stopKey: stop.key, findingId: finding.id, known,
      summary: String(author.prSummary ?? ''), why: String(author.prWhy ?? ''), tests: String(author.prTests ?? ''),
      checks,
      commands: { typecheck: COMMANDS.typecheck, tests: COMMANDS.tests, red: `the changed tests, on origin/${deps.base} without the fix` },
      points, rulings, additional, stood, fixed, tally: sum, rounds: round,
    }));
    const title = prTitle(publicSafe(String(author.title ?? ''), known), publicSafe(finding.title, known));
    const pr = await deps.exec('gh', [
      'pr', 'create', '--repo', ready.slug, '--base', deps.base, '--head', branch, '--title', title, '--body-file', bodyFile,
    ], { cwd: deps.repo, timeoutMs: 120_000 });
    const url = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/.exec(pr.out);
    if (pr.code !== 0 || !url) return failed(`the branch ${branch} is pushed, and opening the pull request failed: ${lastLine(pr.out)}`);
    return { state: 'opened', prUrl: url[0], prNumber: Number(url[1]), branch, at, checks: checkLine, review };
  } finally {
    dropCheckout(deps, `${tree.path}-base`);
    dropCheckout(deps, tree.path);
    if (!hadLocal) await deps.exec('git', ['update-ref', '-d', local], { cwd: deps.repo });
  }
}

// ------------------------------------------------------------- the ticket note

/** The same doors the diagnosis note goes through: this desk's to write on, open, and not since taken by another run. */
async function postFixNote(iid: number, stop: StopDiagnosis, finding: CheckedFinding, fix: FixRecord, deps: FixDeps, post: boolean): Promise<void> {
  if (fix.state !== 'opened' || fix.note || !post || deps.dryRun || deps.paused()) return;
  const issue = await deps.gitlab.getIssue(iid);
  if (!issue.ok || !issue.data) return;
  if (!mayPostOn(issue.data, deps.me()).ok || issue.data.state === 'closed') return;
  const marker = fixMarker(stop.key, finding.id);
  const notes = await deps.gitlab.notes(iid);
  if (!notes.ok || !notes.data) return;
  const mine = notes.data.find((n) => (n.body ?? '').includes(marker));
  if (mine) { fix.note = { id: mine.id, postedAt: deps.now() }; return; }
  const owner = activeClaims(notes.data, deps.now())[0];
  if (owner && owner.runId !== stop.runId) return;
  const res = await deps.gitlab.addNote(iid, renderFixNote({ key: stop.key, finding, fix }));
  if (res.ok) fix.note = { id: res.data?.id ?? null, postedAt: deps.now() };
}

// ------------------------------------------------------------------ the entry

/**
 * Open fixes for the latest diagnosed stop of a run.
 *
 * A finding that was looked at gets a recorded answer, including the ones that
 * may not have a fix and why: the dashboard shows "no pull request: not a
 * harness defect" beside a finding as readily as it shows a link. One that was
 * not reached (the stop already has its two unattended fixes) has none.
 */
export async function fixFromDiagnosis(o: FixOpts, over?: Partial<FixDeps>): Promise<string[]> {
  const d = defaultFixDeps();
  const deps: FixDeps = { ...d, ...over, gitlab: { ...d.gitlab, ...over?.gitlab }, attempt: { ...d.attempt, ...over?.attempt } };
  const file = readDiagnosisFile(o.dir);
  const stop = file?.latest ? file.stops[file.latest] : undefined;
  if (!file || !stop || stop.state === 'failed') return [`#${o.iid} has no diagnosis to fix from`];
  let journal: RunJournal;
  try { journal = JSON.parse(readFileSync(join(o.dir, 'run.json'), 'utf8')) as RunJournal; } catch { return [`#${o.iid} has no run journal`]; }

  // Each answer is written into the record as it is on disk at that moment: a
  // fix runs for an hour, and the diagnosis pass writes the same file.
  const record = (findingId: string, fix: FixRecord): void => {
    stop.fixes = { ...stop.fixes, [findingId]: fix };
    updateDiagnosisFile(o.dir, { iid: o.iid, runId: stop.runId }, (f) => {
      const s = f.stops[stop.key];
      if (s) s.fixes = { ...s.fixes, [findingId]: fix };
    });
  };

  const lines: string[] = [];
  let attempted = Object.values(stop.fixes ?? {}).filter((f) => f.state === 'opened').length;
  for (const finding of stop.findings ?? []) {
    if (o.signal?.aborted) break;
    if (o.only && finding.id !== o.only) continue;
    const el = fixEligibility(finding, stop.fixes?.[finding.id], o.force === true);
    if (!el.ok) {
      // An answer already on record is not overwritten by the reason it is not retried.
      if (!stop.fixes?.[finding.id]) record(finding.id, { state: 'refused', why: el.why, at: deps.now() });
      lines.push(`${finding.id} no pull request: ${el.why}`);
      continue;
    }
    if (!o.only && attempted >= MAX_FIXES_PER_STOP) {
      lines.push(`${finding.id} not attempted: this stop has had its ${MAX_FIXES_PER_STOP} unattended fixes (npm run diagnose -- fix ${o.iid} ${finding.id})`);
      continue;
    }
    // One process per finding of a stop: two would make the same checkout and the same branch.
    const lock = join(o.dir, 'diagnosis', 'fix', `.lock-${stop.key.replace(/[^\w-]/g, '_')}-${finding.id.replace(/[^\w-]/g, '_')}`);
    if (!acquireLock(lock, LOCK_STALE_MS)) {
      lines.push(`${finding.id} not attempted: another process is fixing it`);
      continue;
    }
    attempted += 1;
    let fix: FixRecord;
    try {
      log.info(`fix        #${o.iid} ${finding.id}: ${finding.title.slice(0, 90)}`);
      deps.event('fix_started', { iid: o.iid, finding: finding.id }, journal.runId);
      try {
        fix = await fixFinding({ iid: o.iid, dir: o.dir, journal, stop, finding, signal: o.signal }, deps);
      } catch (err) {
        fix = { state: 'failed', why: `the pipeline threw: ${(err as Error).message.slice(0, 300)}`, at: deps.now() };
      }
      await postFixNote(o.iid, stop, finding, fix, deps, o.post === true);
      record(finding.id, fix);
    } finally {
      releaseLock(lock);
    }
    deps.event('fix_done', { iid: o.iid, finding: finding.id, state: fix.state, why: fix.why, pr: fix.prUrl }, journal.runId);
    const line = fix.state === 'opened' ? `${finding.id} pull request opened: ${fix.prUrl}` : `${finding.id} no pull request (${fix.state}): ${fix.why ?? ''}`;
    (fix.state === 'opened' ? log.ok : log.warn)(`fix        #${o.iid} ${line}`);
    lines.push(line);
    // Held is the desk, not the finding: the next one would be held the same way.
    if (fix.state === 'held') break;
  }
  return lines.length ? lines : [`#${o.iid} has no finding${o.only ? ` ${o.only}` : ''} to fix`];
}

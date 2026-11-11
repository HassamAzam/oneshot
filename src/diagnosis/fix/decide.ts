/**
 * The decisions of the fix pipeline, as pure functions.
 *
 * A fix pull request is the one thing this feature does that changes what
 * Oneshot IS, and it is opened without a person choosing to. So the pipeline is
 * built to refuse, and every refusal is decided here, by code, from facts:
 *
 *   - `fixEligibility` — which findings may have a fix attempted at all.
 *   - `diffGuard`      — whether what the author produced is small and tested
 *                        enough to be an unattended change.
 *   - `upheld`         — which review points survive the adversarial verifier.
 *   - `nextMove`       — open the pull request, go round again, or give up.
 *
 * The classes of refusal follow what this repository already learned about
 * autonomous pull requests: one that races an existing fix, one that answers a
 * design question with a patch, and one that "fixes" something nobody showed
 * was broken are each worse than no pull request.
 *
 * The verifier exists because reviewers over-report. A multi-lens review of
 * this repository once raised 39 blockers of which 13 survived being checked,
 * and reviewers agreeing with each other was correlated error, not evidence. So
 * a reviewer's blocker costs the author nothing until a third session has tried
 * to knock it down and failed.
 */
import type { CheckedFinding, FixRecord } from '../types.js';

export type Eligibility = { ok: true } | { ok: false; why: string };

/** A path inside this repository that a fix could be made in. */
const REPO_PATH_RE = /^(?:src|scripts|hooks|config|skills|context|docs)\/[\w./@-]+$|^(?:tsconfig\.json|README\.md)$/;

/**
 * The repository path a `where` entry or a citation names, or ''.
 *
 * Read generously, because the schema asks for "files or places" and a session
 * writes `src/conductor/phase.ts:762`, `\`src/x.ts\` (the catch branch)` or
 * `./src/x.ts` as readily as the bare path: the path is the first word, without
 * its quotes, its `repo:`, its `./` and its line number.
 */
export function repoPathOf(entry: string): string {
  const word = entry.trim().replace(/^[`'"]+/, '').split(/[\s`'"]/)[0] ?? '';
  const path = word.replace(/^repo:/, '').replace(/^\.\//, '').replace(/[,;.)]+$/, '').replace(/:\d+(?:-\d+)?$/, '');
  return REPO_PATH_RE.test(path) ? path : '';
}

export function isRepoPath(p: string): boolean {
  return repoPathOf(p) !== '';
}

/**
 * Whether a finding may have a fix attempted.
 *
 * Everything asked of it is something the diagnosis already had to show: that
 * it is the harness, that a code change is the remedy, that the cause is
 * confirmed and not merely likely, that the evidence was found where it was
 * said to be, and that one of those places is in this repository's code.
 */
export function fixEligibility(f: CheckedFinding, existing?: FixRecord, force = false): Eligibility {
  if (f.category !== 'harness') {
    const who = f.category === 'environment' ? 'an operator fixes the machine' : f.category === 'ticket' ? 'it goes back through the pipeline' : 'a person decides';
    return { ok: false, why: `not a harness defect (${f.category}): ${who}` };
  }
  // Before the question of who fixes it: nothing is left to fix. The author
  // works on the base branch, where the commit may not be, and would write the
  // same fix a second time.
  if (f.fixedBy) return { ok: false, why: `already fixed in the checkout that was diagnosed, by ${f.fixedBy}: deploy that, there is nothing to write` };
  if (f.fix !== 'pr') return { ok: false, why: `the diagnosis does not ask for a code change (fix: ${f.fix})` };
  if (!f.evidenced) return { ok: false, why: 'none of its evidence could be found where it was cited: it is a lead, not a finding' };
  if (f.confidence !== 'confirmed') return { ok: false, why: 'the cause is only probable, and a fix for an unconfirmed cause changes code that may be right' };
  if (!f.evidence.some((c) => c.ok && c.file.startsWith('repo:') && isRepoPath(c.file))) {
    return { ok: false, why: 'it does not show the place in this repository\'s code (no `repo:` citation that checked out)' };
  }
  if (!f.where.some(isRepoPath)) return { ok: false, why: 'it names no file of this repository to change' };
  if (existing?.state === 'opened') return { ok: false, why: `it already has a pull request: ${existing.prUrl ?? ''}` };
  // `held` is an attempt that was interrupted (a pause, the usage limit, a shutdown), not one that was tried and failed.
  if (existing && existing.state !== 'held' && !force) return { ok: false, why: `a fix was already attempted (${existing.state}): ${existing.why ?? 'no reason recorded'}` };
  return { ok: true };
}

// ----------------------------------------------------------------- the diff

export interface DiffStat { files: string[]; insertions: number; deletions: number }

export const MAX_FIX_FILES = 15;
export const MAX_FIX_LINES = 800;

const RUNNABLE_TEST_RE = /\.test\.(?:ts|mjs|cjs)$/;

/** A test the pipeline can run against the base branch on its own. */
export const isRunnableTest = (f: string): boolean => RUNNABLE_TEST_RE.test(f);
/** Any file that tests: a runnable one, or the hooks' one script of cases. */
export const isTestFile = (f: string): boolean => isRunnableTest(f) || f === 'scripts/verify-hooks.sh';
/** Source the suite covers: a change here needs a test the pipeline can run against the base. */
const isCode = (f: string): boolean => /^(?:src|scripts)\/.+\.(?:ts|mts|cts|js|mjs|cjs)$/.test(f) && !isRunnableTest(f);

/**
 * Whether the author's commits are an acceptable unattended change.
 *
 * Small, because a large diff is a redesign and a redesign wants a person
 * before it wants reviewers. Tested, because the test is what the pipeline
 * runs against the base branch to prove the defect was there. And nothing but
 * code and its docs: a change to the lockfile, the deploy units or the GitHub
 * configuration is somebody's decision about a machine, not a bug fix.
 */
export function diffGuard(d: DiffStat): Eligibility {
  if (!d.files.length) return { ok: false, why: 'the author committed nothing' };
  if (d.files.length > MAX_FIX_FILES) return { ok: false, why: `${d.files.length} files changed, over the ${MAX_FIX_FILES} an unattended fix may touch` };
  const lines = d.insertions + d.deletions;
  if (lines > MAX_FIX_LINES) return { ok: false, why: `${lines} lines changed, over the ${MAX_FIX_LINES} an unattended fix may touch` };
  const held = d.files.filter((f) => /^(?:\.github\/|deploy\/|node_modules(?:\/|$)|package-lock\.json$|package\.json$|config\/(?:project|reviewers|slack|models|budgets)\.json$)/.test(f));
  if (held.length) return { ok: false, why: `it changes ${held.join(', ')}: dependencies, deployment and team configuration are a person's to change` };
  if (!d.files.some(isTestFile)) return { ok: false, why: 'no test was added or changed, so nothing shows the defect or holds the fix' };
  // verify-hooks.sh covers the hooks. It says nothing about a change under src/.
  if (d.files.some(isCode) && !d.files.some(isRunnableTest)) {
    return { ok: false, why: 'it changes source and no test file, so nothing can be run against the base branch to show the defect' };
  }
  return { ok: true };
}

// --------------------------------------------------------------- the review

export type Severity = 'blocker' | 'nit' | 'note';

export interface ReviewPoint {
  id: string;
  severity: Severity;
  file: string;
  line: number;
  what: string;
  why: string;
  fix: string;
}

export interface Ruling { id: string; holds: boolean; reason: string }

/**
 * A reviewer's points, renumbered so two reviewers cannot collide: `A-1`, `B-3`.
 * Model output: every field is coerced, and a point with nothing to say is dropped.
 */
export function reviewPoints(lens: string, data: Record<string, unknown> | null | undefined): ReviewPoint[] {
  const list = Array.isArray(data?.findings) ? data.findings : [];
  const out: ReviewPoint[] = [];
  for (const raw of list) {
    const p = (raw ?? {}) as Record<string, unknown>;
    const what = typeof p.what === 'string' ? p.what.trim() : '';
    if (!what) continue;
    const sev = String(p.severity ?? '');
    out.push({
      id: `${lens}-${out.length + 1}`,
      severity: sev === 'blocker' || sev === 'nit' || sev === 'note' ? sev : 'nit',
      file: typeof p.file === 'string' ? p.file : '',
      line: Number(p.line) || 0,
      what,
      why: typeof p.why === 'string' ? p.why : '',
      fix: typeof p.fix === 'string' ? p.fix : '',
    });
  }
  return out;
}

export function rulingsOf(data: Record<string, unknown> | null | undefined): Ruling[] {
  const list = Array.isArray(data?.rulings) ? data.rulings : [];
  return list.map((raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    return { id: String(r.id ?? ''), holds: r.holds === true, reason: typeof r.reason === 'string' ? r.reason : '' };
  }).filter((r) => r.id);
}

/**
 * The blockers the author must answer: a reviewer's blocker the verifier could
 * not refute, and any blocker the verifier found for itself.
 *
 * A blocker with NO ruling is upheld. The verifier was asked about every one,
 * and silence is not a refutation: the cheap failure is an extra round, the
 * expensive one is a defect that left the building because nobody ruled on it.
 */
export function upheld(points: ReviewPoint[], rulings: Ruling[], additional: ReviewPoint[]): ReviewPoint[] {
  const ruled = new Map(rulings.map((r) => [r.id, r]));
  const fromReview = points.filter((p) => p.severity === 'blocker' && ruled.get(p.id)?.holds !== false);
  return [...fromReview, ...additional.filter((p) => p.severity === 'blocker')];
}

export interface ReviewTally { raised: number; upheld: number; refuted: number; fixed: number }

/**
 * What became of the review, from what the pipeline tracked and not from the
 * last rulings: a blocker that stood and was then fixed ends with a ruling of
 * "does not hold", and counting it as refuted would say the reviewer was wrong.
 *
 * `stood` is every blocker a verifier failed to refute at some point, `fixed`
 * those of them a later verifier found no longer hold.
 */
export function tally(o: { points: ReviewPoint[]; additional: ReviewPoint[]; stood: Set<string>; fixed: Set<string> }): ReviewTally {
  const blockers = [...o.points, ...o.additional].filter((p) => p.severity === 'blocker');
  return {
    raised: o.points.length + o.additional.length,
    upheld: blockers.filter((p) => o.stood.has(p.id)).length,
    refuted: blockers.filter((p) => !o.stood.has(p.id)).length,
    fixed: blockers.filter((p) => o.fixed.has(p.id)).length,
  };
}

// ---------------------------------------------------------------- the checks

export interface Checks {
  typecheck: { ok: boolean; text: string };
  tests: { ok: boolean; pass: number; fail: number; text: string };
  hooks: { ok: boolean; ran: boolean; text: string };
  /** The changed tests against the base branch without the fix: they must fail there. */
  red: { ok: boolean; text: string };
}

/**
 * `# pass N` and `# fail M` from node:test's summary. Null when the run printed
 * no summary. The LAST of each: the runner echoes what a test prints as `# …`
 * lines above its own summary, and a test may print anything.
 */
export function parseTap(out: string): { pass: number; fail: number } | null {
  const last = (re: RegExp): number | null => {
    const all = [...out.matchAll(re)];
    return all.length ? Number(all[all.length - 1]![1]) : null;
  };
  const pass = last(/^# pass (\d+)\s*$/gm);
  const fail = last(/^# fail (\d+)\s*$/gm);
  return pass === null || fail === null ? null : { pass, fail };
}

export function checksPass(c: Checks): boolean {
  return c.typecheck.ok && c.tests.ok && c.hooks.ok && c.red.ok;
}

/** What failed, as blockers the author can act on. */
export function checkBlockers(c: Checks): ReviewPoint[] {
  const out: ReviewPoint[] = [];
  const add = (what: string, why: string): void => {
    out.push({ id: `C-${out.length + 1}`, severity: 'blocker', file: '', line: 0, what, why, fix: '' });
  };
  if (!c.typecheck.ok) add('the typecheck fails', c.typecheck.text);
  if (!c.tests.ok) add('the test suite fails', c.tests.text);
  if (!c.hooks.ok) add('scripts/verify-hooks.sh fails', c.hooks.text);
  if (!c.red.ok) add('the changed tests do not fail on the base branch without the fix, so they do not show the defect', c.red.text);
  return out;
}

export const MAX_FIX_ROUNDS = 2;

export type Move = { act: 'open' } | { act: 'fix'; blockers: ReviewPoint[] } | { act: 'refuse'; why: string };

/**
 * After a round of checks and review: open, go again, or stop.
 *
 * `shippable` is the verifier's own verdict on the change as a whole. It can
 * stop a pull request that has no outstanding point against it: a verifier who
 * could not confirm the change fixes the diagnosed cause has said the one thing
 * this pipeline exists to establish is not established.
 */
export function nextMove(o: {
  round: number; checks: Checks; outstanding: ReviewPoint[]; shippable: boolean; verifierSaid: string;
  /** The verifier's `do-not-ship`: this change should not be opened at all, whatever is or is not outstanding. */
  stop?: boolean;
}): Move {
  if (o.stop) return { act: 'refuse', why: `the verifier said it should not be opened: ${o.verifierSaid || 'it gave no reason'}` };
  const blockers = [...checkBlockers(o.checks), ...o.outstanding];
  if (!blockers.length) {
    if (o.shippable) return { act: 'open' };
    return { act: 'refuse', why: `the verifier would not pass it: ${o.verifierSaid || 'it gave no reason'}` };
  }
  if (o.round >= MAX_FIX_ROUNDS) {
    return { act: 'refuse', why: `still blocked after ${o.round} fix round(s): ${blockers.map((b) => b.what).slice(0, 4).join('; ')}` };
  }
  return { act: 'fix', blockers };
}

// ------------------------------------------------------------------- naming

/**
 * `fix/diagnosed-9174-ec7d79-d-2`: where the fix for one finding of one stop lives.
 *
 * The stop's key is in the name because finding ids start again at D-1 in every
 * diagnosis: without it, the second stop of a ticket would find the first
 * stop's branch and pull request and take them for its own, different, D-1.
 */
export function fixBranch(iid: number, stopKey: string, findingId: string): string {
  const slug = (v: string): string => v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `fix/diagnosed-${iid}-${slug(stopKey).slice(0, 6)}-${slug(findingId)}`;
}

const CONVENTIONAL_PREFIX_RE = /^(?:feat|fix|chore|refactor|test|docs|style|perf|ci|build|revert)(?:\(.+?\))?!?:\s*/i;
const TRAILING_TICKET_RE = /\s*\(#\d+\)$/;
const SMALL_WORDS = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'of', 'in', 'on', 'at', 'to', 'by', 'as', 'is', 'with', 'from', 'vs']);
export const MAX_TITLE = 70;

/**
 * A pull request title by the rule this repository's `mr-metadata` skill
 * gives: a human-readable summary, never a raw commit subject. The
 * conventional-commit prefix and a trailing ticket reference come off, and the
 * rest is title-cased with short joining words left small.
 *
 * Only a plain lowercase word is capitalised. Anything that looks like a name
 * from the code (`phase.ts`, `StructuredOutput`, `$ONESHOT_HOME`, `mr-open` in
 * backticks) is left exactly as written: a title that renames a symbol sends a
 * reviewer searching for something that does not exist.
 */
export function prTitle(raw: string, fallback: string): string {
  const one = (raw.trim() || fallback).replace(/\s+/g, ' ').trim()
    .replace(CONVENTIONAL_PREFIX_RE, '').replace(/[.]+$/, '').replace(TRAILING_TICKET_RE, '');
  const words = one.split(' ').map((w, i) => {
    if (!/^[a-z]+(?:-[a-z]+)*[,:;.]?$/.test(w)) return w;
    if (i > 0 && SMALL_WORDS.has(w.replace(/[,:;.]$/, ''))) return w;
    return w.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('-');
  });
  const title = words.join(' ');
  return title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1).trimEnd()}…` : title;
}

/** `owner/name` from a GitHub remote URL, or null when the remote is not GitHub. */
export function githubSlug(remoteUrl: string): string | null {
  const m = /^(?:https?:\/\/(?:[^@/\s]+@)?|ssh:\/\/git@|git@)github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

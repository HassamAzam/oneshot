/**
 * The ticket-level evaluation of a generated test-case list, and the bounded
 * loop that sends its findings back to `testcases` for correction.
 *
 * Pure: the judge call, the `testcases` re-run and the write to disk are all
 * passed in, so every decision here — what counts as a gap worth a retry, when
 * the loop stops, which attempt's list survives — is testable without a model.
 *
 * The record belongs to the ticket, not to a phase run: it lives at
 * state/runs/<iid>/testcases-eval.json, carries every attempt, and is the same
 * record across every `testcases` re-run it causes.
 *
 * Three rules shape it:
 *
 *  - Requirements are frozen on the first evaluation. A judge asked to list the
 *    ticket's requirements afresh on every attempt returns a slightly different
 *    list each time, and comparing coverage across two different lists reports
 *    drops that never happened. Later attempts only map cases onto the frozen
 *    ids; a requirement first seen later is recorded as proposed, never added.
 *  - The judge judges; code compares. Whether a case covers a requirement is the
 *    judge's call. Whether a requirement covered last attempt is uncovered now
 *    is set arithmetic, and is done here — and a case that did not change keeps
 *    the coverage it had, so a judge answering differently twice is not a drop.
 *    Evidence is checked here too: a quote not in the ticket, or a file:line not
 *    in the worktree, makes a finding uncertain however the judge rated it.
 *  - Only a supported, in-scope, critical or major finding earns a retry.
 *    Uncertain, out-of-scope and minor findings are recorded and never retried:
 *    an evaluator that guesses at business rules must not spend a heavy
 *    `testcases` session on the guess.
 */

import type { TestCase } from '../phases/types.js';
import { mdText } from './gitlabmd.js';

/**
 * Retries after the first evaluation. A list that passes first time spends none.
 * Each retry is a full `testcases` session, so the cap is what bounds the cost.
 */
export const MAX_EVAL_RETRIES = 2;

/**
 * Judge passes per attempt in the live loop. Two passes that agree settle it;
 * a split on a coverage call or a retry-worthy gap earns one deciding pass.
 * A judge pass is far cheaper than the `testcases` session a false gap spends.
 */
export const JUDGE_SAMPLES = 2;

/**
 * What "covered" means — the one sentence that decides whether a gap exists and
 * so whether a heavy `testcases` session is spent.
 */
export const COVERAGE_RULE = 'name the ONE test case whose precondition, steps and expected result would FAIL '
  + 'if the software got it wrong, or "none" when no case would. A case that only visits the same screen, or '
  + 'checks it in a different state than the one that matters, does not cover it.';

/** The ticket's record, under state/runs/<iid>/. Not the judge phase's own artifact, which runPhase overwrites per attempt. */
export const EVAL_RECORD = 'testcases-eval.json';

/**
 * Thrown by an `evaluate` that was stopped or paused rather than answered. It
 * passes through the loop unfinalised, so the record stays open and the next
 * conductor resumes it — a stop is not the judge's verdict on the list.
 */
export class EvalInterrupted extends Error {}

/**
 * Whether a freshly written list is evaluated. Only the first generation is: a
 * finished record means this ticket's list was already judged, and a Review-gate
 * revision means a human has spoken — an evaluator re-adding a case the
 * reviewer deliberately removed would be fighting that decision. A record with
 * no `final` is a loop a stopped conductor left open.
 */
export function evalStart(record: EvalRecord | null, gateFeedbackRounds: number): 'fresh' | 'resume' | 'skip' {
  if (record?.final) return 'skip';
  if (gateFeedbackRounds > 0) return 'skip';
  return record ? 'resume' : 'fresh';
}

export type RequirementSource = 'ticket' | 'bug' | 'code';
export type Validity = 'supported' | 'unsupported' | 'uncertain';
export type Relevance = 'in-scope' | 'out-of-scope';
export type Severity = 'critical' | 'major' | 'minor';
export type FindingKind = 'missing' | 'incorrect' | 'redundant' | 'contradictory';
export type AttemptStatus = 'pass' | 'fail' | 'needs_review';
export type StopReason = 'passed' | 'retry-limit' | 'no-progress' | 'eval-error' | 'testcases-failed';

export interface Requirement {
  id: string;
  text: string;
  source: RequirementSource;
  /** A quote from the ticket, or a file:line in the changed code. */
  evidence: string;
  /** The research acceptance criterion it comes from, as AC1, AC2, …; absent when none. */
  criterion?: string;
  /** The attempt it was adopted on, for a requirement added after the first evaluation. */
  adoptedAt?: number;
}

/** A judge's claim that a frozen requirement is not one, with what shows it. */
export interface InvalidRequirement {
  requirement: string;
  evidence: string;
  reason: string;
}

export interface Finding {
  id: string;
  kind: FindingKind;
  requirement?: string;
  /** Case ids the finding is about, for incorrect / redundant / contradictory. */
  cases?: string[];
  gap: string;
  evidence: string;
  validity: Validity;
  relevance: Relevance;
  severity: Severity;
  rationale: string;
}

/** One judge pass over one list. `requirements` is read only on the first attempt. */
export interface Judgement {
  requirements: Requirement[];
  /** Requirement id -> the one case id that covers it, or null. */
  coverage: Record<string, string | null>;
  findings: Finding[];
  proposedRequirements: Requirement[];
  invalidRequirements?: InvalidRequirement[];
}

export interface AttemptCost {
  sessionId?: string;
  turns?: number;
  weighted?: number;
}

export interface Attempt {
  n: number;
  at: string;
  lap: number;
  salvaged: boolean;
  cases: TestCase[];
  coverage: Record<string, string | null>;
  findings: Finding[];
  proposedRequirements: Requirement[];
  dropped: string[];
  /** Requirement ids held covered because their case did not change, over this judgement's answer. */
  carried?: string[];
  status: AttemptStatus;
  feedbackSent: string | null;
  /** The judge session that produced this attempt's judgement. */
  cost?: AttemptCost;
  /** The `testcases` re-run that wrote this attempt's list. Absent on the first attempt. */
  generationCost?: AttemptCost;
  /** Judge passes merged into this attempt's judgement. */
  samples?: number;
  /** Requirement ids the passes named different covering cases for, held uncovered. */
  disputed?: string[];
  /** Requirement ids adopted on this attempt. */
  adopted?: string[];
  /** Requirement ids retired on this attempt. */
  retired?: string[];
}

/**
 * The live score of one ticket's evaluation: how much of the ticket the first
 * list covered, how much the kept list covers, what the retries cost, and what
 * is still open. Derived from the record alone, so any record can be re-scored.
 */
export interface EvalScore {
  requirements: number;
  firstCovered: number;
  keptCovered: number;
  retries: number;
  openCritical: number;
  openMajor: number;
  uncertain: number;
  judgeTurns: number;
  judgeWeighted: number;
  retryTurns: number;
  retryWeighted: number;
  /** Coverage calls made, and those the judge passes disagreed on. Absent on scores recorded before sampling. */
  coverageCalls?: number;
  disputed?: number;
  judgeSamples?: number;
}

export interface FinalOutcome {
  status: AttemptStatus | 'error';
  chosenAttempt: number | null;
  stopReason: StopReason;
  unresolved: Finding[];
  /** What stopped the loop early, when it was not the judge's verdict. */
  error?: string;
  score?: EvalScore;
}

export interface EvalRecord {
  iid: number;
  project: string;
  runId: string;
  requirements: Requirement[];
  attempts: Attempt[];
  final?: FinalOutcome;
  /** Set once the requirements are frozen, which may be before the first attempt is recorded. */
  frozen?: boolean;
  /** Research's acceptance criteria as they stood at the first evaluation, numbered AC1, AC2, … by position. */
  criteria?: string[];
  /** Findings that hold for every attempt: rejected and retired requirements. */
  standing?: Finding[];
  /** Requirements a later judgement showed were not requirements. */
  retired?: Requirement[];
  /** What the Review gate's reviewer changed in the list after the evaluation. */
  review?: ReviewOutcome;
}

/** Cases the reviewer added to or removed from the kept list before approving it, by scenario. */
export interface ReviewOutcome {
  added: string[];
  removed: string[];
  revisions: number;
}

/** The `testcases-eval` artifact as the SDK returns it (TESTCASES_EVAL_SCHEMA). */
export interface JudgementArtifact {
  requirements?: Requirement[];
  coverage?: Array<{ requirement: string; coveredBy: string }>;
  findings?: Array<Omit<Finding, 'requirement' | 'cases'> & { requirement?: string; cases?: string[] }>;
  proposedRequirements?: Requirement[];
  invalidRequirements?: InvalidRequirement[];
}

/** "AC2", "ac 2" or "2" as AC2; anything else as absent. */
export function criterionTag(raw: string | undefined): string | undefined {
  const m = /^\s*(?:ac\s*)?(\d+)\s*$/i.exec(raw ?? '');
  return m ? `AC${Number(m[1])}` : undefined;
}

/** Schema shape to loop shape: "none" and empty strings become absences, the coverage list a map. */
export function judgementFrom(a: JudgementArtifact): Judgement {
  const coverage: Record<string, string | null> = {};
  for (const c of a.coverage ?? []) {
    const by = c.coveredBy.trim();
    coverage[c.requirement] = by && by.toLowerCase() !== 'none' ? by : null;
  }
  const tagged = (r: Requirement): Requirement => {
    const { criterion, ...rest } = r;
    const tag = criterionTag(criterion);
    return tag ? { ...rest, criterion: tag } : rest;
  };
  const findings: Finding[] = (a.findings ?? []).map(({ requirement, cases, ...rest }) => ({
    ...rest,
    ...(requirement?.trim() ? { requirement: requirement.trim() } : {}),
    ...(cases?.length ? { cases } : {}),
  }));
  return {
    requirements: (a.requirements ?? []).map(tagged),
    coverage,
    findings,
    proposedRequirements: (a.proposedRequirements ?? []).map(tagged),
    invalidRequirements: (a.invalidRequirements ?? []).filter((i) => i.requirement.trim()),
  };
}

/**
 * Whether a piece of evidence checks out against the ticket and the worktree.
 * `claim` is what the evidence is offered for; when given, a quote must also
 * share a meaningful word with it, so a real but unrelated line does not pass.
 */
export type EvidenceCheck = (evidence: string, claim?: string) => boolean;

/** A changed line range on the new side of the diff, inclusive. */
export type LineRange = [number, number];

/**
 * What evidence is checked against. `lines` is a file's line count, or null
 * when no such file exists. `changed` is the file's changed ranges in the diff
 * against the base, or null when the diff does not touch it; absent when the
 * diff could not be read, and then any line the file has is accepted.
 */
export interface EvidenceSources {
  ticketText: string;
  lines: (path: string) => number | null;
  changed?: (path: string) => LineRange[] | null;
}

const FILE_REF = /([A-Za-z0-9_][A-Za-z0-9_./-]*\.[A-Za-z0-9]+):(\d+)/g;
const QUOTED = /"([^"]+)"|“([^”]+)”/g;
const ELLIPSIS = /\.{3}|…/;
const MIN_FRAGMENT_WORDS = 2;
const MIN_QUOTE_WORDS = 4;
const MIN_PARAPHRASE_WORDS = 4;
const PARAPHRASE_SHARE = 0.8;
const NEAR_CHANGE_LINES = 10;
const STEM_LENGTH = 5;
const MIN_WORD_LENGTH = 3;
const SAME_TEXT_SHARE = 0.6;
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'not', 'but', 'has', 'have', 'had',
  'will', 'would', 'should', 'must', 'can', 'could', 'may', 'when', 'then', 'than', 'into', 'onto', 'its', 'it\'s',
  'their', 'there', 'they', 'them', 'all', 'any', 'each', 'only', 'also', 'been', 'being', 'which', 'what', 'who',
  'how', 'why', 'where', 'does', 'did', 'done', 'out', 'our', 'you', 'your', 'per', 'via', 'case', 'cases', 'test',
  'ticket', 'user', 'users', 'page', 'screen', 'shown', 'show', 'shows', 'value', 'values',
]);

function normaliseText(s: string): string {
  return s.toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[*`#>]/g, '')
    .replace(/\s+/g, ' ').trim();
}

const wordCount = (s: string): number => s.split(' ').filter(Boolean).length;

/** The meaningful words of a text, cut to a short stem so "exports" meets "export". */
function stems(s: string): Set<string> {
  return new Set(normaliseText(s).split(/[^a-z0-9]+/)
    .filter((w) => w.length >= MIN_WORD_LENGTH && !STOP_WORDS.has(w))
    .map((w) => w.slice(0, STEM_LENGTH)));
}

function sharesWord(a: string, b: string): boolean {
  const left = stems(a);
  return [...stems(b)].some((w) => left.has(w));
}

/** Overlap of two texts' meaningful words over the smaller set. */
function overlap(a: string, b: string): number {
  const left = stems(a);
  const right = stems(b);
  const smaller = Math.min(left.size, right.size);
  if (!smaller) return 0;
  return [...left].filter((w) => right.has(w)).length / smaller;
}

/** Whether two requirement or finding texts say the same thing. */
export function sameText(a: string, b: string): boolean {
  return normaliseText(a) === normaliseText(b) || overlap(a, b) >= SAME_TEXT_SHARE;
}

/**
 * A quote holds when every "…"-separated fragment is in the ticket, each is at
 * least two words, and together they are at least four: a single common word
 * is in every ticket and proves nothing.
 */
function quoteHolds(quote: string, ticket: string): boolean {
  const fragments = quote.split(ELLIPSIS).map((f) => normaliseText(f).replace(/^[\s.,;:]+|[\s.,;:]+$/g, ''))
    .filter(Boolean);
  if (!fragments.length || fragments.some((f) => wordCount(f) < MIN_FRAGMENT_WORDS)) return false;
  if (fragments.reduce((n, f) => n + wordCount(f), 0) < MIN_QUOTE_WORDS) return false;
  return fragments.every((f) => ticket.includes(f));
}

/**
 * Unquoted prose that is not verbatim may still be a faithful paraphrase: it
 * holds when one sentence of the ticket carries most of its meaningful words.
 */
function paraphraseHolds(text: string, ticketText: string): boolean {
  const words = stems(text);
  if (words.size < MIN_PARAPHRASE_WORDS) return false;
  return ticketText.split(/[.!?\n]+/).some((sentence) => {
    const inSentence = stems(sentence);
    return [...words].filter((w) => inSentence.has(w)).length / words.size >= PARAPHRASE_SHARE;
  });
}

function lineHolds(path: string, line: number, sources: EvidenceSources): boolean {
  const count = sources.lines(path);
  if (count === null || line < 1 || line > count) return false;
  if (!sources.changed) return true;
  const ranges = sources.changed(path.replace(/^[ab]\//, ''));
  return Boolean(ranges?.some(([from, to]) => line >= from - NEAR_CHANGE_LINES && line <= to + NEAR_CHANGE_LINES));
}

/**
 * Evidence holds when it points at something real: a `file:line` the change
 * touched (within a few lines of a changed hunk, when the diff is known), or a
 * quote of four or more words found verbatim in the ticket. Quoting is matched
 * loosely — case, whitespace, markdown emphasis and "…" elisions. Evidence with
 * no quote marks and no file:line is taken as one whole quote, or failing that
 * as a paraphrase of one ticket sentence. With a `claim`, a ticket quote must
 * also share a meaningful word with it.
 */
export function evidenceHolds(evidence: string, sources: EvidenceSources, claim?: string): boolean {
  const text = evidence.trim();
  if (!text) return false;
  for (const [, path, line] of text.matchAll(FILE_REF)) {
    if (lineHolds(path!, Number(line), sources)) return true;
  }
  const ticket = normaliseText(sources.ticketText);
  const relevant = (q: string): boolean => !claim?.trim() || sharesWord(q, claim);
  const quotes = [...text.matchAll(QUOTED)].map((m) => m[1] ?? m[2] ?? '');
  if (quotes.length) return quotes.some((q) => quoteHolds(q, ticket) && relevant(q));
  if (text.match(FILE_REF)) return false;
  return (quoteHolds(text, ticket) || paraphraseHolds(text, sources.ticketText)) && relevant(text);
}

/** The new-side changed ranges per file of a `git diff -U0`. */
export function changedRanges(diff: string): Map<string, LineRange[]> {
  const out = new Map<string, LineRange[]>();
  let file: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).trim();
      file = path === '/dev/null' ? null : path.replace(/^b\//, '');
      if (file && !out.has(file)) out.set(file, []);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk || !file) continue;
    const start = Number(hunk[1]);
    const length = hunk[2] === undefined ? 1 : Number(hunk[2]);
    out.get(file)!.push([start, start + Math.max(length, 1) - 1]);
  }
  return out;
}

const caseBody = (c: TestCase): string => JSON.stringify([c.scenario, c.precondition, c.steps, c.expected]);

/**
 * The judge's coverage, held steady where the list did not change. A case that
 * covered a requirement last attempt and is still in the list word for word
 * still covers it, whatever this judgement says: the case is the same, so a
 * different answer is the judge's noise, and noise must not read as a drop and
 * spend a retry. Returns the coverage to use and the ids it kept steady.
 */
export function steadyCoverage(
  requirements: readonly Requirement[],
  before: Pick<Attempt, 'coverage' | 'cases'>,
  after: Pick<Attempt, 'coverage' | 'cases'>,
): { coverage: Record<string, string | null>; carried: string[] } {
  const now = coveredIds(requirements, after.coverage, after.cases);
  const was = coveredIds(requirements, before.coverage, before.cases);
  const beforeBody = new Map(before.cases.map((c) => [c.id, caseBody(c)]));
  const afterBody = new Map(after.cases.map((c) => [c.id, caseBody(c)]));
  const coverage = { ...after.coverage };
  const carried: string[] = [];
  for (const r of requirements) {
    if (now.has(r.id) || !was.has(r.id)) continue;
    const by = before.coverage[r.id]!;
    if (afterBody.get(by) !== beforeBody.get(by)) continue;
    coverage[r.id] = by;
    carried.push(r.id);
  }
  return { coverage, carried };
}

export function retryWorthy(f: Finding): boolean {
  return f.validity === 'supported' && f.relevance === 'in-scope'
    && (f.severity === 'critical' || f.severity === 'major');
}

/**
 * A requirement the judge could not tie to a quote or a file:line — or tied to
 * one that does not check out — is not a requirement, it is a guess. It leaves
 * the frozen list and comes back as an uncertain finding, so it is seen but
 * never retried.
 */
export function freezeRequirements(
  reqs: readonly Requirement[],
  holds: EvidenceCheck = () => true,
): { frozen: Requirement[]; rejected: Finding[] } {
  const frozen: Requirement[] = [];
  const rejected: Finding[] = [];
  const seen = new Set<string>();
  for (const r of reqs) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const given = Boolean(r.evidence.trim());
    if (given && holds(r.evidence, r.text)) {
      frozen.push(r);
      continue;
    }
    rejected.push({
      id: `U-${r.id}`,
      kind: 'missing',
      gap: r.text,
      evidence: r.evidence,
      validity: 'uncertain',
      relevance: 'in-scope',
      severity: r.source === 'code' ? 'major' : 'critical',
      rationale: given
        ? 'Proposed as a requirement with evidence found neither in the ticket nor in the worktree, so it is not held against the list.'
        : 'Proposed as a requirement with no quote from the ticket and no file:line, so it is not held against the list.',
    });
  }
  return { frozen, rejected };
}

/** The frozen ids a list covers: the judge named a case, and that case is in the list. */
export function coveredIds(
  requirements: readonly Requirement[],
  coverage: Readonly<Record<string, string | null>>,
  cases: readonly TestCase[],
): Set<string> {
  const ids = new Set(cases.map((c) => c.id));
  const out = new Set<string>();
  for (const r of requirements) {
    const by = coverage[r.id];
    if (by && ids.has(by)) out.add(r.id);
  }
  return out;
}

export function coverageDrops(
  requirements: readonly Requirement[],
  before: Pick<Attempt, 'coverage' | 'cases'>,
  after: Pick<Attempt, 'coverage' | 'cases'>,
): string[] {
  const was = coveredIds(requirements, before.coverage, before.cases);
  const now = coveredIds(requirements, after.coverage, after.cases);
  return requirements.filter((r) => was.has(r.id) && !now.has(r.id)).map((r) => r.id);
}

export function dropFindings(requirements: readonly Requirement[], dropped: readonly string[]): Finding[] {
  const byId = new Map(requirements.map((r) => [r.id, r]));
  return dropped.map((id) => ({
    id: `DROP-${id}`,
    kind: 'missing' as const,
    requirement: id,
    gap: `${id} was covered by the previous list and is not covered by this one: ${byId.get(id)?.text ?? ''}`,
    evidence: byId.get(id)?.evidence ?? '',
    validity: 'supported' as const,
    relevance: 'in-scope' as const,
    severity: 'critical' as const,
    rationale: 'A retry may add coverage; it may not trade away coverage the list already had.',
  }));
}

/**
 * Hold the judge's findings to the artifacts they describe. A "missing" finding
 * against a requirement the same judgement maps to a real case contradicts
 * itself — unless it names that very case: then the judge has looked at the
 * covering case and says it stops short of an edge under the requirement, which
 * is a narrower gap, not a contradiction. A finding about case ids the list
 * does not hold is about some other list; a "supported" finding with no
 * evidence, or with evidence that is not in the ticket or the worktree, is not
 * supported. None of these may spend a retry.
 */
export function reconcileFindings(
  findings: readonly Finding[],
  requirements: readonly Requirement[],
  coverage: Readonly<Record<string, string | null>>,
  cases: readonly TestCase[],
  holds: EvidenceCheck = () => true,
): Finding[] {
  const covered = coveredIds(requirements, coverage, cases);
  const caseIds = new Set(cases.map((c) => c.id));
  const textOf = new Map(requirements.map((r) => [r.id, r.text]));
  return findings.map((f) => {
    if (f.validity !== 'supported') return f;
    if (!f.evidence.trim()) {
      return { ...f, validity: 'uncertain', rationale: `${f.rationale} [no evidence given — held as uncertain]` };
    }
    if (!holds(f.evidence, [f.gap, f.requirement ? textOf.get(f.requirement) ?? '' : ''].join(' '))) {
      return {
        ...f,
        validity: 'uncertain',
        rationale: `${f.rationale} [evidence found neither in the ticket nor in the worktree — held as uncertain]`,
      };
    }
    if (f.kind === 'missing' && f.requirement && covered.has(f.requirement)
      && !(f.cases ?? []).includes(coverage[f.requirement]!)) {
      return {
        ...f,
        validity: 'unsupported',
        rationale: `${f.rationale} [coverage maps ${f.requirement} to ${coverage[f.requirement]} — not missing]`,
      };
    }
    const stray = (f.cases ?? []).filter((id) => !caseIds.has(id));
    if (stray.length) {
      return { ...f, validity: 'unsupported', rationale: `${f.rationale} [names case(s) not in the list: ${stray.join(', ')}]` };
    }
    return f;
  });
}

/** Passes needed to carry a decision: more than half of them. */
const majorityOf = (passes: number): number => Math.floor(passes / 2) + 1;

const caseKey = (f: Finding): string => [...(f.cases ?? [])].sort().join(',');

/**
 * Two passes' findings are the same finding when they are of one kind, about
 * one requirement and one set of cases — and, naming neither a requirement
 * nor a case, describe the same gap.
 */
function sameFinding(a: Finding, b: Finding): boolean {
  if (a.kind !== b.kind || (a.requirement ?? '') !== (b.requirement ?? '')) return false;
  if (caseKey(a) !== caseKey(b)) return false;
  return Boolean(caseKey(a) || a.requirement) || sameText(a.gap, b.gap);
}

function sameRequirement(a: Requirement, b: Requirement): boolean {
  const evidence = normaliseText(a.evidence);
  return sameText(a.text, b.text) || (Boolean(evidence) && evidence === normaliseText(b.evidence));
}

export interface MergedJudgement {
  judgement: Judgement;
  /** Requirement ids no majority of passes agreed a covering case for. */
  disputed: string[];
  /** Whether the passes split on something a retry depends on, so a deciding pass is worth its cost. */
  tiebreak: boolean;
  /** Each pass's proposals, kept apart so a proposal two passes make can be told from one pass's guess. */
  proposalsBySample: Requirement[][];
}

/**
 * Several judge passes over one list, reduced to one judgement by majority. A
 * requirement is covered only by the case most passes name; a finding counts
 * as a retry-worthy gap only when most passes raise it as one; one most passes
 * did not raise is kept as uncertain and at most major, so a single pass's
 * guess is shown to a person without holding the list for review; a requirement is claimed invalid only when most passes
 * claim it. One pass is returned as it is.
 */
export function mergeJudgements(passes: readonly Judgement[]): MergedJudgement {
  const first = passes[0]!;
  const proposalsBySample = passes.map((p) => p.proposedRequirements);
  if (passes.length === 1) return { judgement: first, disputed: [], tiebreak: false, proposalsBySample };
  const majority = majorityOf(passes.length);

  const coverage: Record<string, string | null> = {};
  const disputed: string[] = [];
  for (const id of new Set(passes.flatMap((p) => Object.keys(p.coverage)))) {
    const votes = new Map<string, number>();
    for (const p of passes) {
      const by = p.coverage[id] ?? '';
      votes.set(by, (votes.get(by) ?? 0) + 1);
    }
    const winner = [...votes].find(([, count]) => count >= majority);
    coverage[id] = winner?.[0] || null;
    if (!winner) disputed.push(id);
  }

  const clusters: Array<Array<{ pass: number; finding: Finding }>> = [];
  passes.forEach((p, pass) => {
    for (const finding of p.findings) {
      const home = clusters.find((c) => sameFinding(c[0]!.finding, finding) && !c.some((m) => m.pass === pass));
      if (home) home.push({ pass, finding });
      else clusters.push([{ pass, finding }]);
    }
  });
  let tiebreak = disputed.length > 0;
  const usedIds = new Set<string>();
  const findings = clusters.map((members) => {
    const worthy = members.filter((m) => retryWorthy(m.finding));
    if (worthy.length && worthy.length < majority) tiebreak = true;
    let chosen = worthy.length >= majority
      ? worthy[0]!.finding
      : (members.find((m) => !retryWorthy(m.finding)) ?? members[0]!).finding;
    if (members.length < majority && chosen.validity === 'supported') {
      chosen = {
        ...chosen,
        validity: 'uncertain',
        severity: chosen.severity === 'critical' ? 'major' : chosen.severity,
        rationale: `${chosen.rationale} [raised by ${members.length} of ${passes.length} judge passes — held as uncertain]`,
      };
    }
    let id = chosen.id;
    for (let k = 2; usedIds.has(id); k += 1) id = `${chosen.id}-${k}`;
    usedIds.add(id);
    return { ...chosen, id };
  });

  const proposed: Requirement[] = [];
  for (const r of passes.flatMap((p) => p.proposedRequirements)) {
    if (!proposed.some((q) => sameRequirement(q, r))) proposed.push(r);
  }
  const claims = passes.flatMap((p) => p.invalidRequirements ?? []);
  const invalidRequirements = [...new Set(claims.map((c) => c.requirement))]
    .filter((id) => passes.filter((p) => (p.invalidRequirements ?? []).some((c) => c.requirement === id)).length >= majority)
    .map((id) => claims.find((c) => c.requirement === id)!);

  return {
    judgement: { requirements: first.requirements, coverage, findings, proposedRequirements: proposed, invalidRequirements },
    disputed,
    tiebreak,
    proposalsBySample,
  };
}

function nextRequirementId(record: EvalRecord): string {
  const numbers = [...record.requirements, ...(record.retired ?? [])]
    .map((r) => /^R(\d+)$/.exec(r.id)?.[1]).filter(Boolean).map(Number);
  return `R${Math.max(0, ...numbers) + 1}`;
}

/**
 * Adopt into the frozen list a proposed requirement seen twice — by two passes
 * on this attempt, or on this attempt and an earlier one — whose evidence
 * checks out, and which no requirement already says. One sighting is a guess;
 * two independent ones with evidence are a requirement the first pass missed.
 * Each adoption comes back as an uncertain finding, since no case has been
 * mapped to it yet. Mutates `record.requirements`.
 */
export function adoptProposals(
  record: EvalRecord,
  proposalsBySample: readonly Requirement[][],
  holds: EvidenceCheck = () => true,
): { adopted: Requirement[]; findings: Finding[] } {
  const earlier = record.attempts.flatMap((a) => a.proposedRequirements);
  const adopted: Requirement[] = [];
  const findings: Finding[] = [];
  proposalsBySample.forEach((proposals, pass) => {
    for (const p of proposals) {
      if (!p.evidence.trim() || !holds(p.evidence, p.text)) continue;
      const known = [...record.requirements, ...(record.retired ?? [])];
      if (known.some((r) => sameRequirement(r, p))) continue;
      const otherPasses = proposalsBySample.filter((other, k) => k !== pass && other.some((o) => sameRequirement(o, p)));
      if (!otherPasses.length && !earlier.some((e) => sameRequirement(e, p))) continue;
      const requirement: Requirement = { ...p, id: nextRequirementId(record), adoptedAt: record.attempts.length };
      record.requirements.push(requirement);
      adopted.push(requirement);
      findings.push({
        id: `NEW-${requirement.id}`,
        kind: 'missing',
        requirement: requirement.id,
        gap: `${requirement.id} was added to the requirements on this evaluation and has no case mapped to it yet: ${requirement.text}`,
        evidence: requirement.evidence,
        validity: 'uncertain',
        relevance: 'in-scope',
        severity: requirement.source === 'code' ? 'major' : 'critical',
        rationale: 'Proposed twice with evidence that checks out, so adopted; a later evaluation maps a case to it.',
      });
    }
  });
  return { adopted, findings };
}

/**
 * Retire from the frozen list a requirement most passes showed, with evidence
 * that checks out, is not one. It is kept, with the reason, as a standing
 * uncertain finding for a person to confirm. Mutates the record; returns the
 * retired ids.
 */
export function retireRequirements(
  record: EvalRecord,
  claims: readonly InvalidRequirement[],
  holds: EvidenceCheck = () => true,
): string[] {
  const retired: string[] = [];
  for (const claim of claims) {
    const requirement = record.requirements.find((r) => r.id === claim.requirement);
    if (!requirement || !claim.evidence.trim()) continue;
    if (!holds(claim.evidence, `${claim.reason} ${requirement.text}`)) continue;
    record.requirements = record.requirements.filter((r) => r.id !== requirement.id);
    record.retired = [...(record.retired ?? []), requirement];
    record.standing = [...(record.standing ?? []), {
      id: `RET-${requirement.id}`,
      kind: 'incorrect',
      requirement: requirement.id,
      gap: `${requirement.id} was removed from the requirements (${requirement.text}): ${claim.reason}`,
      evidence: claim.evidence,
      validity: 'uncertain',
      relevance: 'in-scope',
      severity: 'major',
      rationale: 'Later judge passes agreed, with evidence, that this was not a requirement; a person should confirm.',
    }];
    retired.push(requirement.id);
  }
  return retired;
}

/**
 * Research's acceptance criteria that no frozen requirement comes from, each
 * as an uncertain critical finding: two readings of the ticket disagree, and
 * only a person can say which is right. A requirement counts for a criterion
 * when it is tagged with it, or says the same thing.
 */
export function unmatchedCriteria(criteria: readonly string[], requirements: readonly Requirement[]): Finding[] {
  return criteria.flatMap((text, i) => {
    const tag = `AC${i + 1}`;
    if (requirements.some((r) => r.criterion === tag || sameText(r.text, text))) return [];
    return [{
      id: `CRIT-${tag}`,
      kind: 'missing' as const,
      gap: `Research's acceptance criterion ${tag} has no matching requirement, so no case is checked against it: ${text}`,
      evidence: '',
      validity: 'uncertain' as const,
      relevance: 'in-scope' as const,
      severity: 'critical' as const,
      rationale: 'Research read this as an acceptance criterion and the evaluator did not list it; a person should decide whether it needs a case.',
    }];
  });
}

const scenarioKey = (c: TestCase): string => normaliseText(c.scenario);

/** What the reviewer changed between the kept list and the list they approved, matched by scenario. */
export function reviewOutcome(record: EvalRecord, approved: readonly TestCase[], revisions: number): ReviewOutcome {
  const kept = record.attempts.find((a) => a.n === record.final?.chosenAttempt)?.cases ?? [];
  const keptKeys = new Set(kept.map(scenarioKey));
  const approvedKeys = new Set(approved.map(scenarioKey));
  return {
    added: approved.filter((c) => !keptKeys.has(scenarioKey(c))).map((c) => c.scenario),
    removed: kept.filter((c) => !approvedKeys.has(scenarioKey(c))).map((c) => c.scenario),
    revisions,
  };
}

/** Whether the requirements are frozen: flagged, or older records that hold an attempt. */
export const isFrozen = (record: EvalRecord): boolean => Boolean(record.frozen) || record.attempts.length > 0;

export function attemptStatus(findings: readonly Finding[]): AttemptStatus {
  if (findings.some(retryWorthy)) return 'fail';
  if (findings.some((f) => f.validity === 'uncertain' && f.severity === 'critical')) return 'needs_review';
  return 'pass';
}

/**
 * The attempt whose list survives: the one covering the most frozen
 * requirements, the later one on a tie. A retry that made the list worse must
 * not replace a better one just because it came last.
 */
export function pickBest(requirements: readonly Requirement[], attempts: readonly Attempt[]): Attempt | null {
  let best: Attempt | null = null;
  let bestCount = -1;
  for (const a of attempts) {
    const count = coveredIds(requirements, a.coverage, a.cases).size;
    if (count >= bestCount) {
      best = a;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Whether a retry moved the list forward: it covers more frozen requirements, or
 * leaves fewer retry-worthy gaps. A retry that did neither will not be rescued by
 * another one, so it ends the loop instead of spending a further session.
 */
export function madeProgress(requirements: readonly Requirement[], before: Attempt, after: Attempt): boolean {
  const covered = (a: Attempt): number => coveredIds(requirements, a.coverage, a.cases).size;
  const gaps = (a: Attempt): number => a.findings.filter(retryWorthy).length;
  return covered(after) > covered(before) || gaps(after) < gaps(before);
}

/** What the next `testcases` session is told: the specific gaps, and what it must not lose. */
export function feedbackFor(requirements: readonly Requirement[], attempt: Attempt): string {
  const covered = coveredIds(requirements, attempt.coverage, attempt.cases);
  const gaps = attempt.findings.filter(retryWorthy).map((f) => {
    const req = f.requirement ? ` (${f.requirement})` : '';
    const about = f.cases?.length ? ` — about ${f.cases.join(', ')}` : '';
    return `- [${f.severity}] ${f.kind}${req}${about}: ${f.gap}\n  evidence: ${f.evidence}`;
  });
  const keep = requirements.filter((r) => covered.has(r.id))
    .map((r) => `- ${r.id} — kept covered by ${attempt.coverage[r.id]}: ${r.text}`);
  return [
    'Gaps to fix:',
    ...gaps,
    '',
    keep.length ? 'Already covered — keep these cases or an equivalent:' : 'No requirement is covered yet.',
    ...keep,
  ].join('\n');
}

export interface EvalLoopInput {
  record: EvalRecord;
  cases: TestCase[];
  lap: number;
  salvaged: boolean;
  /** One judge pass. `frozen` is null on the first attempt. Throws on failure. */
  evaluate: (cases: TestCase[], frozen: Requirement[] | null) => Promise<{ judgement: Judgement; cost?: AttemptCost }>;
  /** One `testcases` re-run with the feedback. Null when that session did not produce a list. */
  regenerate: (feedback: string) => Promise<{ cases: TestCase[]; lap: number; salvaged: boolean; cost?: AttemptCost } | null>;
  /** Called after every change to the record, so a restart resumes rather than restarts. */
  persist: (record: EvalRecord) => void;
  /** Checks evidence against the ticket and the worktree. Absent, all non-empty evidence is taken at its word. */
  evidenceHolds?: EvidenceCheck;
  /** Research's acceptance criteria, recorded at the first evaluation and checked against the requirements. */
  criteria?: string[];
  /** Judge passes per attempt; a split on what a retry depends on earns one deciding pass more. Default 1. */
  samples?: number;
  maxRetries?: number;
  now?: () => string;
}

export interface EvalLoopResult {
  record: EvalRecord;
  /** The list to keep. Equals the last evaluated list unless an earlier one covered more. */
  cases: TestCase[];
  /**
   * True when `testcases.json` must be written back with `cases`: an earlier
   * attempt won, or a failed re-run left the file in an unknown state.
   */
  rewrite: boolean;
}

/** Score a record from its attempts and its chosen one. Null when nothing was evaluated. */
export function scoreOf(record: EvalRecord): EvalScore | null {
  const first = record.attempts[0];
  if (!first) return null;
  const kept = record.attempts.find((a) => a.n === record.final?.chosenAttempt)
    ?? pickBest(record.requirements, record.attempts)!;
  const covered = (a: Attempt): number => coveredIds(record.requirements, a.coverage, a.cases).size;
  const open = kept.findings.filter(retryWorthy);
  const sum = (pick: (a: Attempt) => number | undefined): number =>
    record.attempts.reduce((total, a) => total + (pick(a) ?? 0), 0);
  return {
    requirements: record.requirements.length,
    firstCovered: covered(first),
    keptCovered: covered(kept),
    retries: record.attempts.length - 1,
    openCritical: open.filter((f) => f.severity === 'critical').length,
    openMajor: open.filter((f) => f.severity === 'major').length,
    uncertain: kept.findings.filter((f) => f.validity === 'uncertain' && f.severity !== 'minor').length,
    judgeTurns: sum((a) => a.cost?.turns),
    judgeWeighted: sum((a) => a.cost?.weighted),
    retryTurns: sum((a) => a.generationCost?.turns),
    retryWeighted: sum((a) => a.generationCost?.weighted),
    coverageCalls: sum((a) => Object.keys(a.coverage).length),
    disputed: sum((a) => a.disputed?.length),
    judgeSamples: sum((a) => a.samples ?? 1),
  };
}

function close(input: EvalLoopInput, stopReason: StopReason, current: TestCase[], error?: string): EvalLoopResult {
  const { record } = input;
  const best = pickBest(record.requirements, record.attempts);
  record.final = {
    status: best ? best.status : 'error',
    chosenAttempt: best ? best.n : null,
    stopReason,
    unresolved: best ? best.findings.filter(retryWorthy) : [],
    ...(error ? { error } : {}),
  };
  const score = scoreOf(record);
  if (score) record.final.score = score;
  input.persist(record);
  const cases = best ? best.cases : current;
  return { record, cases, rewrite: stopReason === 'testcases-failed' || cases !== current };
}

/**
 * Evaluate, and while a retry-worthy gap remains and retries are left, send the
 * diagnosis back to `testcases` and evaluate what comes back. Retries already
 * spent by an earlier, interrupted loop on the same record count against the cap.
 * A retry this loop ran that made no progress ends it early.
 */
export async function runEvalLoop(input: EvalLoopInput): Promise<EvalLoopResult> {
  const { record } = input;
  const max = input.maxRetries ?? MAX_EVAL_RETRIES;
  const wanted = Math.max(1, input.samples ?? 1);
  const now = input.now ?? (() => new Date().toISOString());
  const holds = input.evidenceHolds;
  let cases = input.cases;
  let lap = input.lap;
  let salvaged = input.salvaged;
  let generationCost: AttemptCost | undefined;
  let retried = false;

  const judge = async (list: TestCase[]): Promise<{ merged: MergedJudgement; cost?: AttemptCost; samples: number }> => {
    const passes: Array<{ judgement: Judgement; cost?: AttemptCost }> = [];
    const take = async (): Promise<void> => {
      const frozen = isFrozen(record) ? record.requirements : null;
      const pass = await input.evaluate(list, frozen);
      if (!frozen) {
        const { frozen: kept, rejected } = freezeRequirements(pass.judgement.requirements, holds);
        record.requirements = kept;
        record.standing = [...(record.standing ?? []), ...rejected];
        record.criteria = input.criteria ?? [];
        record.frozen = true;
        input.persist(record);
      }
      passes.push(pass);
    };
    const more = async (target: number): Promise<void> => {
      while (passes.length < target) {
        try {
          await take();
        } catch (err) {
          if (err instanceof EvalInterrupted) throw err;
          return;
        }
      }
    };
    await take();
    await more(wanted);
    let merged = mergeJudgements(passes.map((p) => p.judgement));
    if (merged.tiebreak && passes.length === wanted && wanted > 1) {
      await more(wanted + 1);
      merged = mergeJudgements(passes.map((p) => p.judgement));
    }
    const costs = passes.map((p) => p.cost).filter((c): c is AttemptCost => Boolean(c));
    const sessionIds = costs.map((c) => c.sessionId).filter(Boolean).join(',');
    const cost = costs.length ? {
      ...(sessionIds ? { sessionId: sessionIds } : {}),
      turns: costs.reduce((n, c) => n + (c.turns ?? 0), 0),
      weighted: costs.reduce((n, c) => n + (c.weighted ?? 0), 0),
    } : undefined;
    return { merged, cost, samples: passes.length };
  };

  for (;;) {
    let judged: Awaited<ReturnType<typeof judge>>;
    try {
      judged = await judge(cases);
    } catch (err) {
      if (err instanceof EvalInterrupted) throw err;
      return close(input, 'eval-error', cases, err instanceof Error ? err.message : String(err));
    }

    const { merged } = judged;
    const { judgement } = merged;
    const retired = retireRequirements(record, judgement.invalidRequirements ?? [], holds);
    const answered: Record<string, string | null> = {};
    for (const r of record.requirements) answered[r.id] = judgement.coverage[r.id] ?? null;

    const prev = record.attempts[record.attempts.length - 1];
    const { coverage, carried } = prev
      ? steadyCoverage(record.requirements, prev, { coverage: answered, cases })
      : { coverage: answered, carried: [] };
    const dropped = prev ? coverageDrops(record.requirements, prev, { coverage, cases }) : [];
    const reconciled = reconcileFindings(judgement.findings, record.requirements, coverage, cases, holds);
    const { adopted, findings: adoptedFindings } = adoptProposals(record, merged.proposalsBySample, holds);
    const findings = [
      ...reconciled,
      ...(record.standing ?? []),
      ...unmatchedCriteria(record.criteria ?? [], record.requirements),
      ...dropFindings(record.requirements, dropped),
      ...adoptedFindings,
    ];
    const attempt: Attempt = {
      n: record.attempts.length,
      at: now(),
      lap,
      salvaged,
      cases,
      coverage,
      findings,
      proposedRequirements: judgement.proposedRequirements,
      dropped,
      ...(carried.length ? { carried } : {}),
      status: attemptStatus(findings),
      feedbackSent: null,
      ...(judged.cost ? { cost: judged.cost } : {}),
      ...(generationCost ? { generationCost } : {}),
      ...(judged.samples > 1 ? { samples: judged.samples } : {}),
      ...(merged.disputed.length ? { disputed: merged.disputed } : {}),
      ...(adopted.length ? { adopted: adopted.map((r) => r.id) } : {}),
      ...(retired.length ? { retired } : {}),
    };
    record.attempts.push(attempt);
    input.persist(record);

    if (attempt.status !== 'fail') return close(input, 'passed', cases);
    if (record.attempts.length - 1 >= max) return close(input, 'retry-limit', cases);
    if (retried && prev && !madeProgress(record.requirements, prev, attempt)) return close(input, 'no-progress', cases);

    attempt.feedbackSent = feedbackFor(record.requirements, attempt);
    input.persist(record);
    const next = await input.regenerate(attempt.feedbackSent);
    if (!next) return close(input, 'testcases-failed', cases);
    ({ cases, lap, salvaged } = next);
    generationCost = next.cost;
    retried = true;
  }
}

function findingLine(f: Finding): string {
  const about = [f.requirement, ...(f.cases ?? [])].filter(Boolean).join(', ');
  const evidence = f.evidence.trim() ? ` — evidence: ${mdText(f.evidence)}` : '';
  return `- **${f.severity}** ${f.kind}${about ? ` (${mdText(about)})` : ''}: ${mdText(f.gap)}${evidence}`;
}

/**
 * The evaluation's outcome for a human reader: what is still missing after the
 * retries, and what only a person can settle. Rides inside the test-case note
 * and the Review gate's request rather than as a comment of its own. Empty when
 * there is nothing a reader needs to act on.
 */
export function unresolvedSection(record: EvalRecord | null): string {
  const final = record?.final;
  if (!final) return '';
  if (final.status === 'error') {
    return `**Automatic coverage check** could not finish (${mdText(final.error ?? final.stopReason)}); ` +
      'this list was not checked against the ticket.';
  }
  const chosen = record!.attempts.find((a) => a.n === final.chosenAttempt);
  const open = chosen?.findings.filter((f) => f.validity === 'uncertain' && f.severity !== 'minor') ?? [];
  const parts: string[] = [];
  if (final.unresolved.length) {
    const retries = Math.max(0, record!.attempts.length - 1);
    parts.push(`**Automatic coverage check — ${final.unresolved.length} gap(s) still open after ${retries} ` +
      `automatic revision(s):**\n${final.unresolved.map(findingLine).join('\n')}`);
  }
  if (open.length) {
    parts.push('**Not settled by the ticket — a person should decide whether these need a case:**\n' +
      open.map(findingLine).join('\n'));
  }
  const pending = pendingProposals(record!);
  if (pending.length) {
    parts.push('**Proposed as requirements but seen only once — a person should decide whether they are:**\n' +
      pending.map((r) => `- ${mdText(r.text)}${r.evidence.trim() ? ` — evidence: ${mdText(r.evidence)}` : ''}`).join('\n'));
  }
  return parts.join('\n\n');
}

/** Proposals from any attempt that were never adopted and that no requirement already says. */
function pendingProposals(record: EvalRecord): Requirement[] {
  const known = [...record.requirements, ...(record.retired ?? [])];
  const out: Requirement[] = [];
  for (const p of record.attempts.flatMap((a) => a.proposedRequirements)) {
    if (known.some((r) => sameRequirement(r, p)) || out.some((r) => sameRequirement(r, p))) continue;
    out.push(p);
  }
  return out;
}

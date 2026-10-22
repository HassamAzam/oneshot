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
}

/** The `testcases-eval` artifact as the SDK returns it (TESTCASES_EVAL_SCHEMA). */
export interface JudgementArtifact {
  requirements?: Requirement[];
  coverage?: Array<{ requirement: string; coveredBy: string }>;
  findings?: Array<Omit<Finding, 'requirement' | 'cases'> & { requirement?: string; cases?: string[] }>;
  proposedRequirements?: Requirement[];
}

/** Schema shape to loop shape: "none" and empty strings become absences, the coverage list a map. */
export function judgementFrom(a: JudgementArtifact): Judgement {
  const coverage: Record<string, string | null> = {};
  for (const c of a.coverage ?? []) {
    const by = c.coveredBy.trim();
    coverage[c.requirement] = by && by.toLowerCase() !== 'none' ? by : null;
  }
  const findings: Finding[] = (a.findings ?? []).map(({ requirement, cases, ...rest }) => ({
    ...rest,
    ...(requirement?.trim() ? { requirement: requirement.trim() } : {}),
    ...(cases?.length ? { cases } : {}),
  }));
  return {
    requirements: a.requirements ?? [],
    coverage,
    findings,
    proposedRequirements: a.proposedRequirements ?? [],
  };
}

/** Whether a piece of evidence checks out against the ticket and the worktree. */
export type EvidenceCheck = (evidence: string) => boolean;

/** What evidence is checked against. `lines` is a file's line count, or null when no such file exists. */
export interface EvidenceSources {
  ticketText: string;
  lines: (path: string) => number | null;
}

const FILE_REF = /([A-Za-z0-9_][A-Za-z0-9_./-]*\.[A-Za-z0-9]+):(\d+)/g;
const QUOTED = /"([^"]+)"|“([^”]+)”/g;
const ELLIPSIS = /\.{3}|…/;
const MIN_FRAGMENT = 3;

function normaliseText(s: string): string {
  return s.toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[*`#>]/g, '')
    .replace(/\s+/g, ' ').trim();
}

function quoteHolds(quote: string, ticket: string): boolean {
  const fragments = quote.split(ELLIPSIS).map((f) => normaliseText(f).replace(/^[\s.,;:]+|[\s.,;:]+$/g, ''))
    .filter((f) => f.length >= MIN_FRAGMENT);
  return fragments.length > 0 && fragments.every((f) => ticket.includes(f));
}

/**
 * Evidence holds when it points at something real: a `file:line` whose file
 * exists with at least that many lines, or a quote found verbatim in the
 * ticket. Quoting is matched loosely — case, whitespace, markdown emphasis and
 * "…" elisions — so a faithful quote is never failed on formatting. Evidence
 * with no quote marks and no file:line is taken as one whole quote.
 */
export function evidenceHolds(evidence: string, sources: EvidenceSources): boolean {
  const text = evidence.trim();
  if (!text) return false;
  for (const [, path, line] of text.matchAll(FILE_REF)) {
    const count = sources.lines(path!);
    if (count !== null && Number(line) >= 1 && Number(line) <= count) return true;
  }
  const ticket = normaliseText(sources.ticketText);
  const quotes = [...text.matchAll(QUOTED)].map((m) => m[1] ?? m[2] ?? '');
  if (quotes.length) return quotes.some((q) => quoteHolds(q, ticket));
  return !text.match(FILE_REF) && quoteHolds(text, ticket);
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
    if (given && holds(r.evidence)) {
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
  return findings.map((f) => {
    if (f.validity !== 'supported') return f;
    if (!f.evidence.trim()) {
      return { ...f, validity: 'uncertain', rationale: `${f.rationale} [no evidence given — held as uncertain]` };
    }
    if (!holds(f.evidence)) {
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
  const now = input.now ?? (() => new Date().toISOString());
  let cases = input.cases;
  let lap = input.lap;
  let salvaged = input.salvaged;
  let generationCost: AttemptCost | undefined;
  let retried = false;

  for (;;) {
    let judged: { judgement: Judgement; cost?: AttemptCost };
    try {
      judged = await input.evaluate(cases, record.attempts.length ? record.requirements : null);
    } catch (err) {
      if (err instanceof EvalInterrupted) throw err;
      return close(input, 'eval-error', cases, err instanceof Error ? err.message : String(err));
    }

    const { judgement } = judged;
    const holds = input.evidenceHolds;
    let extra: Finding[] = [];
    if (!record.attempts.length) {
      const { frozen, rejected } = freezeRequirements(judgement.requirements, holds);
      record.requirements = frozen;
      extra = rejected;
    }
    const answered: Record<string, string | null> = {};
    for (const r of record.requirements) answered[r.id] = judgement.coverage[r.id] ?? null;

    const prev = record.attempts[record.attempts.length - 1];
    const { coverage, carried } = prev
      ? steadyCoverage(record.requirements, prev, { coverage: answered, cases })
      : { coverage: answered, carried: [] };
    const dropped = prev ? coverageDrops(record.requirements, prev, { coverage, cases }) : [];
    const findings = [
      ...reconcileFindings(judgement.findings, record.requirements, coverage, cases, holds),
      ...extra,
      ...dropFindings(record.requirements, dropped),
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
  return parts.join('\n\n');
}

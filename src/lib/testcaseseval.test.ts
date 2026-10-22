/**
 * The evaluation loop decides three things a model must not: whether a finding
 * is worth a heavy `testcases` re-run, when to stop asking, and which list
 * survives. The judge and the re-run are stubbed so each decision is exercised
 * on fixed inputs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestCase } from '../phases/types.js';
import {
  EvalInterrupted, MAX_EVAL_RETRIES, attemptStatus, evalStart, coverageDrops, evidenceHolds, feedbackFor, freezeRequirements,
  judgementFrom, pickBest, reconcileFindings, retryWorthy, runEvalLoop, scoreOf, steadyCoverage, unresolvedSection,
  type Attempt, type EvalRecord, type Finding, type Judgement, type Requirement,
} from './testcaseseval.js';

const tc = (id: string): TestCase => ({
  id, scenario: `scenario ${id}`, precondition: 'p', steps: ['s'], expected: 'e', pass: ['happy'], blast: 'low',
});
const req = (id: string, evidence = `"quote for ${id}"`): Requirement => ({
  id, text: `requirement ${id}`, source: 'ticket', evidence,
});
const finding = (over: Partial<Finding> = {}): Finding => ({
  id: 'F1', kind: 'missing', requirement: 'R2', gap: 'R2 has no case', evidence: '"quote for R2"',
  validity: 'supported', relevance: 'in-scope', severity: 'critical', rationale: 'acceptance criterion', ...over,
});
const judgement = (coverage: Record<string, string | null>, findings: Finding[] = [], reqs = [req('R1'), req('R2')]): Judgement => ({
  requirements: reqs, coverage, findings, proposedRequirements: [],
});
const blank = (): EvalRecord => ({ iid: 7, project: 'p', runId: 'r', requirements: [], attempts: [] });

interface Script {
  judgements: Judgement[];
  lists?: Array<TestCase[] | null>;
}

function harness(script: Script, record = blank()) {
  const evaluated: Array<{ cases: string[]; frozen: string[] | null }> = [];
  const feedback: string[] = [];
  let persisted = 0;
  let j = 0;
  let l = 0;
  return {
    evaluated, feedback, record,
    persisted: () => persisted,
    input: (cases: TestCase[]) => ({
      record, cases, lap: 0, salvaged: false,
      now: () => '2026-10-22T00:00:00Z',
      persist: () => { persisted += 1; },
      evaluate: async (c: TestCase[], frozen: Requirement[] | null) => {
        evaluated.push({ cases: c.map((x) => x.id), frozen: frozen ? frozen.map((r) => r.id) : null });
        const next = script.judgements[j++];
        if (!next) throw new Error('judge unavailable');
        return { judgement: next };
      },
      regenerate: async (fb: string) => {
        feedback.push(fb);
        const next = script.lists?.[l++] ?? null;
        return next ? { cases: next, lap: l, salvaged: false } : null;
      },
    }),
  };
}

test('the judge artifact maps to a judgement: "none" is uncovered, empty links are absent', () => {
  const j = judgementFrom({
    requirements: [req('R1')],
    coverage: [{ requirement: 'R1', coveredBy: 'TC-01' }, { requirement: 'R2', coveredBy: 'none' }, { requirement: 'R3', coveredBy: ' ' }],
    findings: [{ ...finding(), requirement: '', cases: [] }],
  });
  assert.deepEqual(j.coverage, { R1: 'TC-01', R2: null, R3: null });
  assert.equal('requirement' in j.findings[0]!, false);
  assert.equal('cases' in j.findings[0]!, false);
  assert.deepEqual(j.proposedRequirements, []);
});

test('a finding earns a retry only when supported, in scope, and critical or major', () => {
  assert.equal(retryWorthy(finding()), true);
  assert.equal(retryWorthy(finding({ severity: 'major' })), true);
  assert.equal(retryWorthy(finding({ severity: 'minor' })), false);
  assert.equal(retryWorthy(finding({ validity: 'uncertain' })), false);
  assert.equal(retryWorthy(finding({ validity: 'unsupported' })), false);
  assert.equal(retryWorthy(finding({ relevance: 'out-of-scope' })), false);
});

test('a requirement with no evidence is not frozen and comes back as an uncertain finding', () => {
  const { frozen, rejected } = freezeRequirements([req('R1'), req('R2', '  '), req('R1')]);
  assert.deepEqual(frozen.map((r) => r.id), ['R1']);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]!.validity, 'uncertain');
  assert.equal(retryWorthy(rejected[0]!), false);
});

test('a missing finding against a requirement the judge itself maps to a real case is unsupported', () => {
  const [f] = reconcileFindings([finding()], [req('R1'), req('R2')], { R1: 'TC-01', R2: 'TC-02' }, [tc('TC-01'), tc('TC-02')]);
  assert.equal(f!.validity, 'unsupported');
});

test('a missing edge that names the covering case as stopping short of it is a narrower gap, not a contradiction', () => {
  const allSubcontractors = finding({
    requirement: 'R2', cases: ['TC-02'], severity: 'major',
    gap: 'No case reimburses a trip where every participant is a subcontractor; TC-02 has only 1 of 4.',
  });
  const [f] = reconcileFindings([allSubcontractors], [req('R1'), req('R2')], { R1: 'TC-01', R2: 'TC-02' }, [tc('TC-01'), tc('TC-02')]);
  assert.equal(f!.validity, 'supported');
  assert.equal(retryWorthy(f!), true);
});

test('a missing finding against a covered requirement that names only other cases still contradicts the coverage', () => {
  const [f] = reconcileFindings(
    [finding({ cases: ['TC-01'] })], [req('R1'), req('R2')], { R1: 'TC-01', R2: 'TC-02' }, [tc('TC-01'), tc('TC-02')],
  );
  assert.equal(f!.validity, 'unsupported');
});

test('a narrower edge under a covered requirement is sent back with the case it must go beyond', async () => {
  const cases = [tc('TC-01'), tc('TC-02')];
  const h = harness({
    judgements: [
      judgement({ R1: 'TC-01', R2: 'TC-02' }, [finding({ requirement: 'R2', cases: ['TC-02'], severity: 'major', gap: 'all-of-N edge' })]),
      judgement({ R1: 'TC-01', R2: 'TC-02' }),
    ],
    lists: [[...cases, tc('TC-03')]],
  });
  const out = await runEvalLoop(h.input(cases));
  assert.equal(out.record.attempts[0]!.status, 'fail');
  assert.match(h.feedback[0]!, /\[major\] missing \(R2\) — about TC-02: all-of-N edge/);
  assert.equal(out.record.final!.status, 'pass');
});

test('coverage pointing at a case the list does not hold does not count as covered', () => {
  const [f] = reconcileFindings([finding()], [req('R1'), req('R2')], { R2: 'TC-99' }, [tc('TC-01')]);
  assert.equal(f!.validity, 'supported');
});

test('a supported finding with no evidence is held as uncertain', () => {
  const [f] = reconcileFindings([finding({ evidence: '' })], [req('R2')], {}, [tc('TC-01')]);
  assert.equal(f!.validity, 'uncertain');
});

test('a finding about a case id the list does not hold is unsupported', () => {
  const [f] = reconcileFindings(
    [finding({ kind: 'incorrect', requirement: undefined, cases: ['TC-09'] })], [req('R1')], {}, [tc('TC-01')],
  );
  assert.equal(f!.validity, 'unsupported');
});

test('status: any retry-worthy finding fails, an uncertain critical one needs review, otherwise pass', () => {
  assert.equal(attemptStatus([finding()]), 'fail');
  assert.equal(attemptStatus([finding({ validity: 'uncertain' })]), 'needs_review');
  assert.equal(attemptStatus([finding({ validity: 'uncertain', severity: 'minor' })]), 'pass');
  assert.equal(attemptStatus([]), 'pass');
});

test('a requirement covered before and uncovered after is a drop; text changes alone are not', () => {
  const reqs = [req('R1'), req('R2')];
  const before = { coverage: { R1: 'TC-01', R2: 'TC-02' }, cases: [tc('TC-01'), tc('TC-02')] };
  assert.deepEqual(coverageDrops(reqs, before, { coverage: { R1: 'TC-01', R2: null }, cases: [tc('TC-01')] }), ['R2']);
  assert.deepEqual(coverageDrops(reqs, before, { coverage: { R1: 'TC-05', R2: 'TC-02' }, cases: [tc('TC-05'), tc('TC-02')] }), []);
});

test('the best attempt covers the most frozen requirements, the later one winning a tie', () => {
  const reqs = [req('R1'), req('R2')];
  const at = (n: number, coverage: Record<string, string | null>): Attempt => ({
    n, at: '', lap: n, salvaged: false, cases: [tc('TC-01'), tc('TC-02')], coverage,
    findings: [], proposedRequirements: [], dropped: [], status: 'pass', feedbackSent: null,
  });
  assert.equal(pickBest(reqs, [at(0, { R1: 'TC-01', R2: 'TC-02' }), at(1, { R1: 'TC-01', R2: null })])!.n, 0);
  assert.equal(pickBest(reqs, [at(0, { R1: 'TC-01', R2: null }), at(1, { R1: null, R2: 'TC-02' })])!.n, 1);
  assert.equal(pickBest(reqs, []), null);
});

test('feedback names each retry-worthy gap with its evidence and the coverage to keep, and nothing else', () => {
  const attempt: Attempt = {
    n: 0, at: '', lap: 0, salvaged: false, cases: [tc('TC-01')], coverage: { R1: 'TC-01', R2: null },
    findings: [finding(), finding({ id: 'F2', gap: 'a guess', validity: 'uncertain' })],
    proposedRequirements: [], dropped: [], status: 'fail', feedbackSent: null,
  };
  const fb = feedbackFor([req('R1'), req('R2')], attempt);
  assert.match(fb, /\[critical\] missing \(R2\): R2 has no case/);
  assert.match(fb, /evidence: "quote for R2"/);
  assert.match(fb, /R1 — kept covered by TC-01/);
  assert.doesNotMatch(fb, /a guess/);
});

test('a list with nothing missing passes on the first evaluation and is never retried', async () => {
  const h = harness({ judgements: [judgement({ R1: 'TC-01', R2: 'TC-02' })] });
  const cases = [tc('TC-01'), tc('TC-02')];
  const out = await runEvalLoop(h.input(cases));
  assert.equal(h.evaluated.length, 1);
  assert.equal(h.feedback.length, 0);
  assert.equal(out.record.final!.status, 'pass');
  assert.equal(out.record.final!.stopReason, 'passed');
  assert.equal(out.rewrite, false);
  assert.equal(out.cases, cases);
});

test('a missing edge case is diagnosed, sent back, and the corrected list passes on re-evaluation', async () => {
  const fixed = [tc('TC-01'), tc('TC-02')];
  const h = harness({
    judgements: [judgement({ R1: 'TC-01', R2: null }, [finding()]), judgement({ R1: 'TC-01', R2: 'TC-02' })],
    lists: [fixed],
  });
  const out = await runEvalLoop(h.input([tc('TC-01')]));
  assert.equal(h.feedback.length, 1);
  assert.match(h.feedback[0]!, /R2 has no case/);
  assert.equal(out.record.attempts[0]!.feedbackSent, h.feedback[0]);
  assert.equal(out.record.final!.status, 'pass');
  assert.equal(out.record.final!.chosenAttempt, 1);
  assert.equal(out.cases, fixed);
  assert.equal(out.rewrite, false);
});

test('requirements are frozen on the first attempt; later attempts are judged against those ids', async () => {
  const h = harness({
    judgements: [
      judgement({ R1: 'TC-01', R2: null }, [finding()]),
      judgement({ R1: 'TC-01', R2: 'TC-02', R9: 'TC-02' }, [], [req('R1'), req('R2'), req('R9')]),
    ],
    lists: [[tc('TC-01'), tc('TC-02')]],
  });
  const out = await runEvalLoop(h.input([tc('TC-01')]));
  assert.deepEqual(h.evaluated.map((e) => e.frozen), [null, ['R1', 'R2']]);
  assert.deepEqual(out.record.requirements.map((r) => r.id), ['R1', 'R2']);
  assert.deepEqual(Object.keys(out.record.attempts[1]!.coverage), ['R1', 'R2']);
});

test('a false positive the judgement contradicts does not trigger a retry', async () => {
  const h = harness({ judgements: [judgement({ R1: 'TC-01', R2: 'TC-02' }, [finding()])] });
  const out = await runEvalLoop(h.input([tc('TC-01'), tc('TC-02')]));
  assert.equal(h.feedback.length, 0);
  assert.equal(out.record.attempts[0]!.findings[0]!.validity, 'unsupported');
  assert.equal(out.record.final!.status, 'pass');
});

test('an uncertain finding is recorded and reported but does not trigger a retry', async () => {
  const h = harness({ judgements: [judgement({ R1: 'TC-01', R2: 'TC-02' }, [finding({ requirement: undefined, validity: 'uncertain' })])] });
  const out = await runEvalLoop(h.input([tc('TC-01'), tc('TC-02')]));
  assert.equal(h.feedback.length, 0);
  assert.equal(out.record.final!.status, 'needs_review');
  assert.equal(out.record.final!.stopReason, 'passed');
  assert.equal(out.record.attempts[0]!.findings.length, 1);
});

test(`the loop stops after ${MAX_EVAL_RETRIES} retries and keeps the unresolved findings`, async () => {
  const reqs = Array.from({ length: MAX_EVAL_RETRIES + 2 }, (_, k) => req(`R${k + 1}`));
  const listAt = (n: number): TestCase[] => Array.from({ length: n + 1 }, (_, k) => tc(`TC-${k + 1}`));
  const judgementAt = (n: number): Judgement => judgement(
    Object.fromEntries(reqs.map((r, k) => [r.id, k <= n ? `TC-${k + 1}` : null])),
    [finding({ requirement: `R${n + 2}`, gap: `R${n + 2} has no case`, evidence: `"quote for R${n + 2}"` })],
    reqs,
  );
  const h = harness({
    judgements: Array.from({ length: MAX_EVAL_RETRIES + 1 }, (_, n) => judgementAt(n)),
    lists: Array.from({ length: MAX_EVAL_RETRIES }, (_, n) => listAt(n + 1)),
  });
  const out = await runEvalLoop(h.input(listAt(0)));
  assert.equal(h.evaluated.length, MAX_EVAL_RETRIES + 1);
  assert.equal(h.feedback.length, MAX_EVAL_RETRIES);
  assert.equal(out.record.final!.stopReason, 'retry-limit');
  assert.equal(out.record.final!.status, 'fail');
  assert.deepEqual(out.record.final!.unresolved.map((f) => f.requirement), [`R${MAX_EVAL_RETRIES + 2}`]);
});

test('a retry that closes no gap ends the loop instead of spending another session', async () => {
  const failing = judgement({ R1: 'TC-01', R2: null }, [finding()]);
  const h = harness({ judgements: [failing, failing, failing], lists: [[tc('TC-01')], [tc('TC-01')]] });
  const out = await runEvalLoop({ ...h.input([tc('TC-01')]), maxRetries: 5 });
  assert.equal(h.evaluated.length, 2);
  assert.equal(h.feedback.length, 1);
  assert.equal(out.record.final!.stopReason, 'no-progress');
  assert.equal(out.record.final!.status, 'fail');
});

test('a resumed evaluation of an unchanged list is not taken for a retry without progress', async () => {
  const failing = judgement({ R1: 'TC-01', R2: null }, [finding()]);
  const record = blank();
  const first = harness({ judgements: [failing] }, record);
  await runEvalLoop({ ...first.input([tc('TC-01')]), maxRetries: 0 });
  delete record.final;
  const fixed = [tc('TC-01'), tc('TC-02')];
  const resumed = harness({ judgements: [failing, judgement({ R1: 'TC-01', R2: 'TC-02' })], lists: [fixed] }, record);
  const out = await runEvalLoop({ ...resumed.input([tc('TC-01')]), maxRetries: 5 });
  assert.equal(resumed.feedback.length, 1);
  assert.equal(out.record.final!.stopReason, 'passed');
  assert.equal(out.cases, fixed);
});

test('a retry that drops earlier coverage is a critical finding, and the better earlier list survives', async () => {
  const first = [tc('TC-01'), tc('TC-02')];
  const h = harness({
    judgements: [
      judgement({ R1: 'TC-01', R2: 'TC-02' }, [finding({ requirement: undefined, kind: 'incorrect', cases: ['TC-02'] })]),
      judgement({ R1: 'TC-01', R2: null }),
    ],
    lists: [[tc('TC-01')]],
  });
  const out = await runEvalLoop({ ...h.input(first), maxRetries: 1 });
  const second = out.record.attempts[1]!;
  assert.deepEqual(second.dropped, ['R2']);
  assert.equal(second.status, 'fail');
  assert.ok(second.findings.some((f) => f.id === 'DROP-R2' && retryWorthy(f)));
  assert.equal(out.record.final!.chosenAttempt, 0);
  assert.equal(out.cases, first);
  assert.equal(out.rewrite, true);
});

const TICKET = 'Export payroll\nThe **CSV export** must include   the employee code.\nManagers cannot see salaries of other teams.';
const sources = {
  ticketText: TICKET,
  lines: (path: string) => ({ 'apps/payroll/views.py': 120 } as Record<string, number>)[path] ?? null,
};

test('evidence holds for a verbatim quote, loosely matched on case, spacing and markdown', () => {
  assert.equal(evidenceHolds('"The CSV export must include the employee code."', sources), true);
  assert.equal(evidenceHolds('Ticket says: “managers cannot see salaries of other teams”', sources), true);
  assert.equal(evidenceHolds('the csv export must include the employee code', sources), true);
});

test('evidence holds across an elision only when every fragment is in the ticket', () => {
  assert.equal(evidenceHolds('"The CSV export … employee code"', sources), true);
  assert.equal(evidenceHolds('"The CSV export … department name"', sources), false);
});

test('an invented quote does not hold, even beside a real-looking one in prose', () => {
  assert.equal(evidenceHolds('"The export must be sorted by joining date"', sources), false);
  assert.equal(evidenceHolds('The ticket implies exports are sorted', sources), false);
});

test('a file:line holds only for a file in the worktree and a line it has', () => {
  assert.equal(evidenceHolds('apps/payroll/views.py:42', sources), true);
  assert.equal(evidenceHolds('see apps/payroll/views.py:120 (permission check)', sources), true);
  assert.equal(evidenceHolds('apps/payroll/views.py:121', sources), false);
  assert.equal(evidenceHolds('apps/payroll/serializers.py:10', sources), false);
});

test('one checking source is enough: a bad file:line beside a real quote holds', () => {
  assert.equal(evidenceHolds('"the employee code" — apps/payroll/nope.py:3', sources), true);
});

test('a supported finding whose evidence does not check out is held as uncertain and earns no retry', () => {
  const holds = (e: string) => evidenceHolds(e, sources);
  const [f] = reconcileFindings([finding({ evidence: '"exports are sorted by date"' })], [req('R2')], {}, [tc('TC-01')], holds);
  assert.equal(f!.validity, 'uncertain');
  assert.match(f!.rationale, /evidence found neither in the ticket nor in the worktree/);
  assert.equal(retryWorthy(f!), false);
  const [ok] = reconcileFindings([finding({ evidence: '"the employee code"' })], [req('R2')], {}, [tc('TC-01')], holds);
  assert.equal(ok!.validity, 'supported');
});

test('a requirement whose evidence does not check out is not frozen and comes back as uncertain', () => {
  const { frozen, rejected } = freezeRequirements(
    [req('R1', '"the employee code"'), req('R2', '"exports are sorted by date"')], (e) => evidenceHolds(e, sources),
  );
  assert.deepEqual(frozen.map((r) => r.id), ['R1']);
  assert.equal(rejected[0]!.validity, 'uncertain');
  assert.equal(rejected[0]!.evidence, '"exports are sorted by date"');
});

test('a judge that invents evidence for a gap does not spend a retry', async () => {
  const h = harness({
    judgements: [judgement({ R1: 'TC-01', R2: 'TC-02' }, [finding({ requirement: undefined, evidence: '"sorted by date"' })],
      [req('R1', '"the employee code"'), req('R2', '"cannot see salaries"')])],
  });
  const out = await runEvalLoop({ ...h.input([tc('TC-01'), tc('TC-02')]), evidenceHolds: (e) => evidenceHolds(e, sources) });
  assert.equal(h.feedback.length, 0);
  assert.equal(out.record.final!.status, 'needs_review');
});

test('an unchanged case keeps the coverage it had when the judge answers differently', () => {
  const reqs = [req('R1'), req('R2')];
  const before = { coverage: { R1: 'TC-01', R2: 'TC-02' }, cases: [tc('TC-01'), tc('TC-02')] };
  const out = steadyCoverage(reqs, before, { coverage: { R1: 'TC-01', R2: null }, cases: [tc('TC-01'), tc('TC-02'), tc('TC-03')] });
  assert.deepEqual(out.coverage, { R1: 'TC-01', R2: 'TC-02' });
  assert.deepEqual(out.carried, ['R2']);
});

test('a covering case that was edited or removed is not held steady', () => {
  const reqs = [req('R2')];
  const before = { coverage: { R2: 'TC-02' }, cases: [tc('TC-02')] };
  const edited = { ...tc('TC-02'), expected: 'something else' };
  assert.deepEqual(steadyCoverage(reqs, before, { coverage: { R2: null }, cases: [edited] }).carried, []);
  assert.deepEqual(steadyCoverage(reqs, before, { coverage: { R2: null }, cases: [tc('TC-01')] }).carried, []);
});

test('a re-mapping by the judge alone is not a drop and does not spend a retry', async () => {
  const kept = [tc('TC-01'), tc('TC-02'), tc('TC-03')];
  const h = harness({
    judgements: [
      judgement({ R1: 'TC-01', R2: 'TC-02' }, [finding({ requirement: undefined, kind: 'missing', gap: 'no empty-file case' })]),
      judgement({ R1: 'TC-01', R2: null }, [finding({ id: 'F2', requirement: 'R2', gap: 'R2 has no case' })]),
    ],
    lists: [kept],
  });
  const out = await runEvalLoop(h.input([tc('TC-01'), tc('TC-02')]));
  const second = out.record.attempts[1]!;
  assert.deepEqual(second.dropped, []);
  assert.deepEqual(second.carried, ['R2']);
  assert.equal(second.coverage.R2, 'TC-02');
  assert.equal(second.findings[0]!.validity, 'unsupported');
  assert.equal(second.status, 'pass');
  assert.equal(h.feedback.length, 1);
});

test('a judge failure ends the loop with eval-error and keeps the current list', async () => {
  const cases = [tc('TC-01')];
  const h = harness({ judgements: [] });
  const out = await runEvalLoop(h.input(cases));
  assert.equal(out.record.final!.stopReason, 'eval-error');
  assert.equal(out.record.final!.status, 'error');
  assert.equal(out.record.final!.error, 'judge unavailable');
  assert.equal(out.cases, cases);
  assert.equal(out.rewrite, false);
});

test('a re-run that produces no list stops the loop and asks for the chosen list to be written back', async () => {
  const cases = [tc('TC-01')];
  const h = harness({ judgements: [judgement({ R1: 'TC-01', R2: null }, [finding()])], lists: [null] });
  const out = await runEvalLoop(h.input(cases));
  assert.equal(out.record.final!.stopReason, 'testcases-failed');
  assert.equal(out.cases, cases);
  assert.equal(out.rewrite, true);
});

test('retries spent before an interruption count against the cap on the same ticket record', async () => {
  const failing = judgement({ R1: 'TC-01', R2: null }, [finding()]);
  const first = harness({ judgements: [failing, failing], lists: [[tc('TC-01')]] });
  const partial = await runEvalLoop({ ...first.input([tc('TC-01')]), maxRetries: 1 });
  const resumed: EvalRecord = { ...partial.record, attempts: partial.record.attempts.slice(0, 2), final: undefined };

  const second = harness({ judgements: [failing], lists: [[tc('TC-01')]] }, resumed);
  const out = await runEvalLoop({ ...second.input([tc('TC-01')]), maxRetries: 2 });
  assert.equal(second.evaluated.length, 1);
  assert.equal(second.feedback.length, 0);
  assert.equal(out.record.attempts.length, 3);
  assert.equal(out.record.final!.stopReason, 'retry-limit');
  assert.equal(out.record.iid, 7);
});

test('the record is persisted after every attempt and before every re-run', async () => {
  const h = harness({
    judgements: [judgement({ R1: 'TC-01', R2: null }, [finding()]), judgement({ R1: 'TC-01', R2: 'TC-02' })],
    lists: [[tc('TC-01'), tc('TC-02')]],
  });
  await runEvalLoop(h.input([tc('TC-01')]));
  assert.equal(h.persisted(), 4);
});

test('only a first generation is evaluated: a finished record or a Review-gate revision skips it', () => {
  assert.equal(evalStart(null, 0), 'fresh');
  assert.equal(evalStart(blank(), 0), 'resume');
  assert.equal(evalStart({ ...blank(), final: { status: 'pass', chosenAttempt: 0, stopReason: 'passed', unresolved: [] } }, 0), 'skip');
  assert.equal(evalStart(null, 1), 'skip');
  assert.equal(evalStart(blank(), 2), 'skip');
});

test('a stopped evaluation leaves the record open to resume instead of closing it as an eval error', async () => {
  const h = harness({ judgements: [] });
  const input = h.input([tc('TC-01')]);
  input.evaluate = async () => { throw new EvalInterrupted('stopped'); };
  await assert.rejects(runEvalLoop(input), EvalInterrupted);
  assert.equal(h.record.final, undefined);
  assert.equal(evalStart(h.record, 0), 'resume');
});

const closed = (over: Partial<EvalRecord> = {}, findings: Finding[] = []): EvalRecord => ({
  ...blank(),
  requirements: [req('R1'), req('R2')],
  attempts: [0, 1].map((n) => ({
    n, at: '', lap: n, salvaged: false, cases: [tc('TC-01')], coverage: { R1: 'TC-01', R2: null },
    findings, proposedRequirements: [], dropped: [], status: 'fail' as const, feedbackSent: null,
  })),
  final: { status: 'fail', chosenAttempt: 1, stopReason: 'retry-limit', unresolved: findings.filter(retryWorthy) },
  ...over,
});

test('nothing is shown for an unfinished record or a clean pass', () => {
  assert.equal(unresolvedSection(null), '');
  assert.equal(unresolvedSection(blank()), '');
  assert.equal(unresolvedSection(closed({ final: { status: 'pass', chosenAttempt: 1, stopReason: 'passed', unresolved: [] } })), '');
});

test('open gaps after the retries are listed with severity, requirement and evidence', () => {
  const md = unresolvedSection(closed({}, [finding()]));
  assert.match(md, /1 gap\(s\) still open after 1 automatic revision\(s\)/);
  assert.match(md, /- \*\*critical\*\* missing \(R2\): R2 has no case — evidence: "quote for R2"/);
});

test('uncertain findings that matter are shown for a person to settle; minor ones are not', () => {
  const md = unresolvedSection(closed({ final: { status: 'needs_review', chosenAttempt: 1, stopReason: 'passed', unresolved: [] } }, [
    finding({ id: 'U1', gap: 'zero balance behaviour', validity: 'uncertain' }),
    finding({ id: 'U2', gap: 'tooltip wording', validity: 'uncertain', severity: 'minor' }),
  ]));
  assert.match(md, /Not settled by the ticket/);
  assert.match(md, /zero balance behaviour/);
  assert.doesNotMatch(md, /tooltip wording/);
  assert.doesNotMatch(md, /still open/);
});

test('a check that could not finish says the list was not checked', () => {
  const md = unresolvedSection({ ...blank(), final: { status: 'error', chosenAttempt: null, stopReason: 'eval-error', unresolved: [], error: 'judge timed out' } });
  assert.match(md, /could not finish \(judge timed out\)/);
});

test('model-written text cannot inject markup into the ticket comment', () => {
  const md = unresolvedSection(closed({}, [finding({ gap: '<img src=x onerror=alert(1)>' })]));
  assert.doesNotMatch(md, /<img/);
});

test('a finished loop scores the first and the kept list, the retries and the cost of each session', async () => {
  const h = harness({
    judgements: [judgement({ R1: 'TC-01', R2: null }, [finding()]), judgement({ R1: 'TC-01', R2: 'TC-02' })],
    lists: [[tc('TC-01'), tc('TC-02')]],
  });
  const base = h.input([tc('TC-01')]);
  const out = await runEvalLoop({
    ...base,
    evaluate: async (c, frozen) => ({ ...(await base.evaluate(c, frozen)), cost: { turns: 4, weighted: 1.5 } }),
    regenerate: async (fb) => {
      const next = await base.regenerate(fb);
      return next && { ...next, cost: { turns: 20, weighted: 6 } };
    },
  });
  assert.deepEqual(out.record.attempts[1]!.generationCost, { turns: 20, weighted: 6 });
  assert.equal(out.record.attempts[0]!.generationCost, undefined);
  assert.deepEqual(out.record.final!.score, {
    requirements: 2, firstCovered: 1, keptCovered: 2, retries: 1, openCritical: 0, openMajor: 0, uncertain: 0,
    judgeTurns: 8, judgeWeighted: 3, retryTurns: 20, retryWeighted: 6,
  });
});

test('the score counts the gaps and uncertain points still open on the kept list', () => {
  const record = closed({}, [
    finding(),
    finding({ id: 'F2', severity: 'major', requirement: undefined }),
    finding({ id: 'F3', validity: 'uncertain', requirement: undefined }),
    finding({ id: 'F4', validity: 'uncertain', severity: 'minor', requirement: undefined }),
  ]);
  const score = scoreOf(record)!;
  assert.equal(score.firstCovered, 1);
  assert.equal(score.keptCovered, 1);
  assert.equal(score.retries, 1);
  assert.equal(score.openCritical, 1);
  assert.equal(score.openMajor, 1);
  assert.equal(score.uncertain, 1);
  assert.equal(scoreOf(blank()), null);
});

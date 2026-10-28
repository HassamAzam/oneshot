/**
 * The evaluation loop decides three things a model must not: whether a finding
 * is worth a heavy `testcases` re-run, when to stop asking, and which list
 * survives. The judge and the re-run are stubbed so each decision is exercised
 * on fixed inputs.
 *
 * The requirements are never the judge's: they are research's acceptance
 * criteria, fixed before the first evaluation, so every test here hands the
 * record its requirements and the judge only maps coverage onto them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestCase } from '../phases/types.js';
import {
  EvalInterrupted, MAX_EVAL_RETRIES, attemptStatus, changedRanges, coverageDrops, evalStart, evidenceHolds,
  feedbackFor, judgementFrom, pickBest, reconcileFindings, requirementsFrom, retryWorthy, reviewOutcome,
  runEvalLoop, scoreOf, steadyCoverage, unresolvedSection,
  type Attempt, type EvalRecord, type Finding, type Judgement, type Requirement,
} from './testcaseseval.js';

const tc = (id: string): TestCase => ({
  id, scenario: `scenario ${id}`, precondition: 'p', steps: ['s'], expected: 'e', pass: ['happy'], blast: 'low',
});
const req = (id: string): Requirement => ({ id, text: `requirement ${id}` });
const REQS = [req('AC1'), req('AC2')];
const finding = (over: Partial<Finding> = {}): Finding => ({
  id: 'F1', kind: 'missing', requirement: 'AC2', gap: 'AC2 has no case', evidence: '"quote for AC2"',
  validity: 'supported', relevance: 'in-scope', severity: 'critical', rationale: 'acceptance criterion', ...over,
});
const judgement = (coverage: Record<string, string | null>, findings: Finding[] = []): Judgement => ({
  coverage, findings,
});
const blank = (requirements: Requirement[] = REQS): EvalRecord =>
  ({ iid: 7, project: 'p', runId: 'r', requirements: requirements.map((r) => ({ ...r })), attempts: [] });

interface Script {
  judgements: Judgement[];
  lists?: Array<TestCase[] | null>;
}

function harness(script: Script, record = blank()) {
  const evaluated: Array<string[]> = [];
  const feedback: string[] = [];
  let persisted = 0;
  let judged = 0;
  let regenerated = 0;
  const input = {
    record,
    cases: [tc('TC-01')],
    lap: 0,
    salvaged: false,
    now: () => '2026-01-01T00:00:00.000Z',
    persist: () => { persisted += 1; },
    evaluate: async (cases: TestCase[]) => {
      evaluated.push(cases.map((c) => c.id));
      const next = script.judgements[judged];
      judged += 1;
      if (!next) throw new Error('the judge gave no judgement');
      return { judgement: next };
    },
    regenerate: async (fb: string) => {
      feedback.push(fb);
      const list = script.lists?.[regenerated];
      regenerated += 1;
      return list ? { cases: list, lap: regenerated, salvaged: false } : null;
    },
  };
  return {
    input,
    state: () => ({ evaluated, feedback, persisted, judged, regenerated }),
  };
}

// ------------------------------------------------- the requirements are given

test('the requirements are research\'s criteria, numbered by position, blanks dropped', () => {
  assert.deepEqual(requirementsFrom(['first thing', '  ', 'third thing']), [
    { id: 'AC1', text: 'first thing' },
    { id: 'AC3', text: 'third thing' },
  ]);
  assert.deepEqual(requirementsFrom([]), []);
});

test('an evaluation runs only on a first generation, and never with no requirement to judge', () => {
  assert.equal(evalStart(null, 0, 2), 'fresh');
  assert.equal(evalStart(null, 0, 0), 'skip');
  assert.equal(evalStart(blank(), 0, 2), 'resume');
  assert.equal(evalStart(blank(), 1, 2), 'skip');
  assert.equal(evalStart({ ...blank(), final: { status: 'pass', chosenAttempt: 0, stopReason: 'passed', unresolved: [] } }, 0, 2), 'skip');
});

test('the judge artifact maps to a judgement: "none" is uncovered, empty links are absent', () => {
  const j = judgementFrom({
    coverage: [{ requirement: 'AC1', coveredBy: 'TC-01' }, { requirement: 'AC2', coveredBy: 'none' }],
    findings: [{
      id: 'F1', kind: 'missing', requirement: '', cases: [], gap: 'g', evidence: 'e',
      validity: 'supported', relevance: 'in-scope', severity: 'major', rationale: 'r',
    }],
  });
  assert.deepEqual(j.coverage, { AC1: 'TC-01', AC2: null });
  assert.equal(j.findings[0]!.requirement, undefined);
  assert.equal(j.findings[0]!.cases, undefined);
});

// ------------------------------------------------------- what earns a retry

test('a finding earns a retry only when supported, in scope, and critical or major', () => {
  assert.ok(retryWorthy(finding()));
  assert.ok(retryWorthy(finding({ severity: 'major' })));
  assert.ok(!retryWorthy(finding({ severity: 'minor' })));
  assert.ok(!retryWorthy(finding({ validity: 'uncertain' })));
  assert.ok(!retryWorthy(finding({ validity: 'unsupported' })));
  assert.ok(!retryWorthy(finding({ relevance: 'out-of-scope' })));
});

test('a missing finding against a requirement the judge itself maps to a real case is unsupported', () => {
  const [f] = reconcileFindings([finding()], REQS, { AC2: 'TC-01' }, [tc('TC-01')]);
  assert.equal(f!.validity, 'unsupported');
  assert.match(f!.rationale, /coverage maps AC2 to TC-01/);
});

test('a missing edge that names the covering case as stopping short of it is a narrower gap, not a contradiction', () => {
  const [f] = reconcileFindings(
    [finding({ cases: ['TC-01'], gap: 'TC-01 never tries a zero balance' })],
    REQS, { AC2: 'TC-01' }, [tc('TC-01')],
  );
  assert.equal(f!.validity, 'supported');
  assert.ok(retryWorthy(f!));
});

test('a missing finding against a covered requirement that names only other cases still contradicts the coverage', () => {
  const [f] = reconcileFindings(
    [finding({ cases: ['TC-02'] })], REQS, { AC2: 'TC-01' }, [tc('TC-01'), tc('TC-02')],
  );
  assert.equal(f!.validity, 'unsupported');
});

test('coverage pointing at a case the list does not hold does not count as covered', () => {
  const drops = coverageDrops(REQS, { coverage: { AC1: 'TC-01' }, cases: [tc('TC-01')] },
    { coverage: { AC1: 'TC-09' }, cases: [tc('TC-01')] });
  assert.deepEqual(drops, ['AC1']);
});

test('a supported finding with no evidence is held as uncertain', () => {
  const [f] = reconcileFindings([finding({ evidence: '  ' })], REQS, {}, [tc('TC-01')]);
  assert.equal(f!.validity, 'uncertain');
  assert.match(f!.rationale, /no evidence given/);
});

test('a finding about a case id the list does not hold is unsupported', () => {
  const [f] = reconcileFindings(
    [finding({ kind: 'incorrect', requirement: undefined, cases: ['TC-77'] })], REQS, {}, [tc('TC-01')],
  );
  assert.equal(f!.validity, 'unsupported');
  assert.match(f!.rationale, /not in the list: TC-77/);
});

test('status: any retry-worthy finding fails, an uncertain critical one needs review, otherwise pass', () => {
  assert.equal(attemptStatus([finding()]), 'fail');
  assert.equal(attemptStatus([finding({ validity: 'uncertain' })]), 'needs_review');
  assert.equal(attemptStatus([finding({ validity: 'uncertain', severity: 'major' })]), 'pass');
  assert.equal(attemptStatus([]), 'pass');
});

// ------------------------------------------------- comparing one list to the next

test('a requirement covered before and uncovered after is a drop; text changes alone are not', () => {
  const before = { coverage: { AC1: 'TC-01' }, cases: [tc('TC-01')] };
  assert.deepEqual(coverageDrops(REQS, before, { coverage: { AC1: null }, cases: [tc('TC-01')] }), ['AC1']);
  assert.deepEqual(coverageDrops(REQS, before, { coverage: { AC1: 'TC-01' }, cases: [tc('TC-01')] }), []);
});

test('an unchanged case keeps the coverage it had when the judge answers differently', () => {
  const before = { coverage: { AC1: 'TC-01' }, cases: [tc('TC-01')] };
  const { coverage, carried } = steadyCoverage(REQS, before, { coverage: { AC1: null }, cases: [tc('TC-01')] });
  assert.equal(coverage.AC1, 'TC-01');
  assert.deepEqual(carried, ['AC1']);
});

test('a covering case that was edited or removed is not held steady', () => {
  const before = { coverage: { AC1: 'TC-01' }, cases: [tc('TC-01')] };
  const edited = { ...tc('TC-01'), expected: 'something else' };
  assert.deepEqual(steadyCoverage(REQS, before, { coverage: { AC1: null }, cases: [edited] }).carried, []);
  assert.deepEqual(steadyCoverage(REQS, before, { coverage: { AC1: null }, cases: [tc('TC-02')] }).carried, []);
});

test('the best attempt covers the most requirements, the later one winning a tie', () => {
  const attempt = (n: number, coverage: Record<string, string | null>): Attempt => ({
    n, at: '', lap: 0, salvaged: false, cases: [tc('TC-01')], coverage, findings: [], dropped: [],
    status: 'fail', feedbackSent: null,
  });
  assert.equal(pickBest(REQS, [attempt(0, { AC1: 'TC-01', AC2: 'TC-01' }), attempt(1, { AC1: 'TC-01' })])!.n, 0);
  assert.equal(pickBest(REQS, [attempt(0, { AC1: 'TC-01' }), attempt(1, { AC2: 'TC-01' })])!.n, 1);
  assert.equal(pickBest(REQS, []), null);
});

test('feedback names each retry-worthy gap with its evidence and the coverage to keep, and nothing else', () => {
  const attempt: Attempt = {
    n: 0, at: '', lap: 0, salvaged: false, cases: [tc('TC-01')], coverage: { AC1: 'TC-01' },
    findings: [finding(), finding({ id: 'F2', severity: 'minor', gap: 'cosmetic' })],
    dropped: [], status: 'fail', feedbackSent: null,
  };
  const text = feedbackFor(REQS, attempt);
  assert.match(text, /\[critical\] missing \(AC2\): AC2 has no case/);
  assert.match(text, /evidence: "quote for AC2"/);
  assert.match(text, /AC1 — kept covered by TC-01/);
  assert.doesNotMatch(text, /cosmetic/);
});

// ------------------------------------------------------------------ the loop

test('a list with nothing missing passes on the first evaluation and is never retried', async () => {
  const h = harness({ judgements: [judgement({ AC1: 'TC-01', AC2: 'TC-01' })] });
  const out = await runEvalLoop(h.input);
  assert.equal(out.record.final!.status, 'pass');
  assert.equal(out.record.final!.stopReason, 'passed');
  assert.equal(h.state().regenerated, 0);
  assert.equal(out.rewrite, false);
});

test('a missing edge case is diagnosed, sent back, and the corrected list passes on re-evaluation', async () => {
  const h = harness({
    judgements: [judgement({ AC1: 'TC-01', AC2: null }, [finding()]), judgement({ AC1: 'TC-01', AC2: 'TC-02' })],
    lists: [[tc('TC-01'), tc('TC-02')]],
  });
  const out = await runEvalLoop(h.input);
  assert.equal(out.record.final!.status, 'pass');
  assert.equal(out.record.attempts.length, 2);
  assert.deepEqual(h.state().evaluated, [['TC-01'], ['TC-01', 'TC-02']]);
  assert.match(h.state().feedback[0]!, /AC2 has no case/);
});

test('every attempt is judged against the same given ids, whatever the judge answers about others', async () => {
  const h = harness({
    judgements: [
      judgement({ AC1: 'TC-01', AC2: null, AC9: 'TC-01' }, [finding()]),
      judgement({ AC1: 'TC-01', AC2: 'TC-02' }),
    ],
    lists: [[tc('TC-01'), tc('TC-02')]],
  });
  const out = await runEvalLoop(h.input);
  assert.deepEqual(out.record.requirements.map((r) => r.id), ['AC1', 'AC2']);
  for (const attempt of out.record.attempts) {
    assert.deepEqual(Object.keys(attempt.coverage).sort(), ['AC1', 'AC2']);
  }
});

test('a false positive the judgement contradicts does not trigger a retry', async () => {
  const h = harness({ judgements: [judgement({ AC1: 'TC-01', AC2: 'TC-01' }, [finding()])] });
  const out = await runEvalLoop(h.input);
  assert.equal(out.record.final!.status, 'pass');
  assert.equal(h.state().regenerated, 0);
});

test('an uncertain finding is recorded and reported but does not trigger a retry', async () => {
  const h = harness({
    judgements: [judgement({ AC1: 'TC-01', AC2: 'TC-01' }, [finding({ validity: 'uncertain', requirement: undefined })])],
  });
  const out = await runEvalLoop(h.input);
  assert.equal(out.record.final!.status, 'needs_review');
  assert.equal(h.state().regenerated, 0);
});

test(`the loop stops after ${MAX_EVAL_RETRIES} retries and keeps the unresolved findings`, async () => {
  const gap = (id: string, text: string): Finding => finding({ id, requirement: undefined, gap: text });
  const h = harness({
    judgements: [
      judgement({ AC1: 'TC-01' }, [gap('F1', 'one'), gap('F2', 'two'), gap('F3', 'three')]),
      judgement({ AC1: 'TC-01' }, [gap('F2', 'two'), gap('F3', 'three')]),
      judgement({ AC1: 'TC-01' }, [gap('F3', 'three')]),
    ],
    lists: [[tc('TC-01'), tc('TC-02')], [tc('TC-01'), tc('TC-02'), tc('TC-03')]],
  });
  const out = await runEvalLoop(h.input);
  assert.equal(out.record.final!.stopReason, 'retry-limit');
  assert.equal(out.record.attempts.length, MAX_EVAL_RETRIES + 1);
  assert.equal(out.record.final!.unresolved.length, 1, 'the gap still open on the kept attempt');
});

test('a retry that closes no gap ends the loop instead of spending another session', async () => {
  const h = harness({
    judgements: [judgement({ AC1: 'TC-01' }, [finding()]), judgement({ AC1: 'TC-01' }, [finding()])],
    lists: [[tc('TC-01'), tc('TC-02')]],
  });
  const out = await runEvalLoop(h.input);
  assert.equal(out.record.final!.stopReason, 'no-progress');
  assert.equal(h.state().regenerated, 1);
});

test('a resumed evaluation of an unchanged list is not taken for a retry without progress', async () => {
  const record = blank();
  record.attempts.push({
    n: 0, at: '', lap: 0, salvaged: false, cases: [tc('TC-01')], coverage: { AC1: 'TC-01' },
    findings: [finding()], dropped: [], status: 'fail', feedbackSent: 'sent',
  });
  const h = harness({
    judgements: [judgement({ AC1: 'TC-01' }, [finding()]), judgement({ AC1: 'TC-01', AC2: 'TC-02' })],
    lists: [[tc('TC-01'), tc('TC-02')]],
  }, record);
  const out = await runEvalLoop(h.input);
  assert.equal(out.record.final!.stopReason, 'passed');
  assert.equal(h.state().regenerated, 1);
});

test('a retry that drops earlier coverage is a critical finding, and the better earlier list survives', async () => {
  const h = harness({
    judgements: [
      judgement({ AC1: 'TC-01', AC2: 'TC-01' }, [finding({ requirement: undefined, gap: 'a zero balance is untested' })]),
      judgement({ AC1: null, AC2: 'TC-02' }),
    ],
    lists: [[tc('TC-02')]],
  });
  const out = await runEvalLoop(h.input);
  const second = out.record.attempts[1]!;
  assert.deepEqual(second.dropped, ['AC1']);
  assert.ok(second.findings.some((f) => f.id === 'DROP-AC1' && retryWorthy(f)));
  assert.equal(out.record.final!.chosenAttempt, 0);
  assert.deepEqual(out.cases.map((c) => c.id), ['TC-01']);
  assert.equal(out.rewrite, true);
});

test('a re-mapping by the judge alone is not a drop and does not spend a retry', async () => {
  const h = harness({
    judgements: [
      judgement({ AC1: 'TC-01', AC2: 'TC-01' }),
    ],
  });
  const out = await runEvalLoop(h.input);
  assert.deepEqual(out.record.attempts[0]!.dropped, []);
  assert.equal(h.state().regenerated, 0);
});

test('a judge failure ends the loop with eval-error and keeps the current list', async () => {
  const h = harness({ judgements: [] });
  const out = await runEvalLoop(h.input);
  assert.equal(out.record.final!.status, 'error');
  assert.equal(out.record.final!.stopReason, 'eval-error');
  assert.match(out.record.final!.error!, /no judgement/);
  assert.deepEqual(out.cases.map((c) => c.id), ['TC-01']);
});

test('a re-run that produces no list stops the loop and asks for the chosen list to be written back', async () => {
  const h = harness({ judgements: [judgement({ AC1: null }, [finding()])], lists: [null] });
  const out = await runEvalLoop(h.input);
  assert.equal(out.record.final!.stopReason, 'testcases-failed');
  assert.equal(out.rewrite, true);
});

test('retries spent before an interruption count against the cap on the same ticket record', async () => {
  const record = blank();
  record.attempts.push({
    n: 0, at: '', lap: 0, salvaged: false, cases: [tc('TC-01')], coverage: {},
    findings: [finding()], dropped: [], status: 'fail', feedbackSent: 'sent',
  }, {
    n: 1, at: '', lap: 1, salvaged: false, cases: [tc('TC-01')], coverage: {},
    findings: [finding()], dropped: [], status: 'fail', feedbackSent: 'sent',
  });
  const h = harness({ judgements: [judgement({ AC1: null }, [finding()])] }, record);
  const out = await runEvalLoop(h.input);
  assert.equal(out.record.final!.stopReason, 'retry-limit');
  assert.equal(h.state().regenerated, 0);
});

test('the record is persisted before the first judgement, after every attempt and before every re-run', async () => {
  const h = harness({
    judgements: [judgement({ AC1: null }, [finding()]), judgement({ AC1: 'TC-02', AC2: 'TC-02' })],
    lists: [[tc('TC-02')]],
  });
  await runEvalLoop(h.input);
  assert.ok(h.state().persisted >= 5, `persisted ${h.state().persisted} times`);
});

test('a stopped evaluation leaves the record open to resume instead of closing it as an eval error', async () => {
  const record = blank();
  const input = {
    record,
    cases: [tc('TC-01')],
    lap: 0,
    salvaged: false,
    persist: () => {},
    evaluate: async () => { throw new EvalInterrupted('stopped'); },
    regenerate: async () => null,
  };
  await assert.rejects(runEvalLoop(input), (err) => err instanceof EvalInterrupted);
  assert.equal(record.final, undefined);
});

// --------------------------------------------------------- evidence checking

const SOURCES = {
  ticketText: 'The **balance** must carry forward\nat year end, for every person.',
  lines: (p: string) => (p === 'src/leave.py' ? 40 : null),
};

test('evidence holds for a verbatim quote, loosely matched on case, spacing and markdown', () => {
  assert.ok(evidenceHolds('"The balance must carry forward"', SOURCES));
  assert.ok(evidenceHolds('"the   BALANCE must carry   forward"', SOURCES));
});

test('evidence holds across an elision only when every fragment is in the ticket', () => {
  assert.ok(evidenceHolds('"The balance must … for every person"', SOURCES));
  assert.ok(!evidenceHolds('"The balance must … for every manager"', SOURCES));
});

test('an invented quote does not hold, even beside a real-looking one in prose', () => {
  assert.ok(!evidenceHolds('the ticket says "balances are deleted at year end"', SOURCES));
});

test('a quote of fewer than four words, or with a one-word fragment, does not hold', () => {
  assert.ok(!evidenceHolds('"year end"', SOURCES));
  assert.ok(!evidenceHolds('"balance … end"', SOURCES));
});

test('unquoted evidence holds when it is verbatim and not when it is a paraphrase', () => {
  assert.ok(evidenceHolds('The balance must carry forward', SOURCES));
  assert.ok(!evidenceHolds('balances should roll over when the year closes', SOURCES));
});

test('a file:line holds only for a file in the worktree and a line it has', () => {
  assert.ok(evidenceHolds('src/leave.py:12', SOURCES));
  assert.ok(!evidenceHolds('src/leave.py:99', SOURCES));
  assert.ok(!evidenceHolds('src/missing.py:1', SOURCES));
});

test('one checking source is enough: a bad file:line beside a real quote holds', () => {
  assert.ok(evidenceHolds('src/missing.py:1 — "The balance must carry forward"', SOURCES));
});

test('the diff parser reads the new-side ranges of every changed file', () => {
  const diff = [
    'diff --git a/src/a.py b/src/a.py',
    '--- a/src/a.py',
    '+++ b/src/a.py',
    '@@ -1 +1,3 @@',
    '@@ -20,0 +30 @@',
    'diff --git a/src/b.py b/src/b.py',
    '--- /dev/null',
    '+++ b/src/b.py',
    '@@ -0,0 +1,5 @@',
  ].join('\n');
  const ranges = changedRanges(diff);
  assert.deepEqual(ranges.get('src/a.py'), [[1, 3], [30, 30]]);
  assert.deepEqual(ranges.get('src/b.py'), [[1, 5]]);
});

test('with the diff known, a file:line holds only near a changed hunk', () => {
  const sources = { ...SOURCES, changed: (p: string) => (p === 'src/leave.py' ? [[20, 22] as [number, number]] : null) };
  assert.ok(evidenceHolds('src/leave.py:21', sources));
  assert.ok(evidenceHolds('src/leave.py:30', sources));
  assert.ok(!evidenceHolds('src/leave.py:2', sources));
});

test('a supported finding whose evidence does not check out is held as uncertain and earns no retry', () => {
  const [f] = reconcileFindings(
    [finding({ requirement: undefined, evidence: '"balances are deleted"' })], REQS, {}, [tc('TC-01')],
    (e) => evidenceHolds(e, SOURCES),
  );
  assert.equal(f!.validity, 'uncertain');
  assert.match(f!.rationale, /neither in the ticket nor in the worktree/);
  assert.ok(!retryWorthy(f!));
});

test('a judge that invents evidence for a gap does not spend a retry', async () => {
  const h = harness({
    judgements: [judgement({ AC1: 'TC-01', AC2: null },
      [finding({ requirement: undefined, evidence: '"balances are deleted at year end"' })])],
  });
  const out = await runEvalLoop({ ...h.input, evidenceHolds: (e) => evidenceHolds(e, SOURCES) });
  assert.equal(out.record.final!.status, 'needs_review');
  assert.equal(h.state().regenerated, 0);
});

// --------------------------------------------------------------- the score

test('a finished loop scores the first and the kept list, the retries and the cost of each session', async () => {
  const record = blank();
  const input = {
    record,
    cases: [tc('TC-01')],
    lap: 0,
    salvaged: false,
    persist: () => {},
    evaluate: async (cases: TestCase[]) => ({
      judgement: cases.length > 1
        ? judgement({ AC1: 'TC-01', AC2: 'TC-02' })
        : judgement({ AC1: 'TC-01', AC2: null }, [finding()]),
      cost: { turns: 3, weighted: 1.5 },
    }),
    regenerate: async () => ({ cases: [tc('TC-01'), tc('TC-02')], lap: 1, salvaged: false, cost: { turns: 9, weighted: 4 } }),
  };
  const out = await runEvalLoop(input);
  const score = out.record.final!.score!;
  assert.deepEqual(
    [score.requirements, score.firstCovered, score.keptCovered, score.retries],
    [2, 1, 2, 1],
  );
  assert.deepEqual([score.judgeTurns, score.judgeWeighted, score.retryTurns, score.retryWeighted], [6, 3, 9, 4]);
});

test('the score counts the gaps and uncertain points still open on the kept list', () => {
  const record = blank();
  record.attempts.push({
    n: 0, at: '', lap: 0, salvaged: false, cases: [tc('TC-01')], coverage: { AC1: 'TC-01' },
    findings: [
      finding(),
      finding({ id: 'F2', requirement: undefined, severity: 'major' }),
      finding({ id: 'F3', requirement: undefined, validity: 'uncertain' }),
      finding({ id: 'F4', requirement: undefined, validity: 'uncertain', severity: 'minor' }),
    ],
    dropped: [], status: 'fail', feedbackSent: null,
  });
  record.final = { status: 'fail', chosenAttempt: 0, stopReason: 'retry-limit', unresolved: [] };
  const score = scoreOf(record)!;
  assert.deepEqual([score.openCritical, score.openMajor, score.uncertain], [1, 1, 1]);
});

// ------------------------------------------------- what a person is shown

const closed = (findings: Finding[], unresolved: Finding[]): EvalRecord => {
  const record = blank();
  record.attempts.push({
    n: 0, at: '', lap: 0, salvaged: false, cases: [tc('TC-01')], coverage: {}, findings,
    dropped: [], status: 'fail', feedbackSent: null,
  });
  record.final = { status: 'fail', chosenAttempt: 0, stopReason: 'retry-limit', unresolved };
  return record;
};

test('nothing is shown for an unfinished record or a clean pass', () => {
  assert.equal(unresolvedSection(null), '');
  assert.equal(unresolvedSection(blank()), '');
  assert.equal(unresolvedSection(closed([], [])), '');
});

test('open gaps after the retries are listed with severity, requirement and evidence', () => {
  const md = unresolvedSection(closed([finding()], [finding()]));
  assert.match(md, /1 gap\(s\) still open after 0 automatic revision\(s\)/);
  assert.match(md, /\*\*critical\*\* missing \(AC2\): AC2 has no case — evidence: "quote for AC2"/);
});

test('uncertain findings that matter are shown for a person to settle; minor ones are not', () => {
  const md = unresolvedSection(closed([
    finding({ validity: 'uncertain', gap: 'UNSETTLED-POINT' }),
    finding({ id: 'F2', validity: 'uncertain', severity: 'minor', gap: 'COSMETIC-POINT' }),
  ], []));
  assert.match(md, /a person should decide/);
  assert.match(md, /UNSETTLED-POINT/);
  assert.doesNotMatch(md, /COSMETIC-POINT/);
});

test('a check that could not finish says the list was not checked', () => {
  const record = blank();
  record.final = { status: 'error', chosenAttempt: null, stopReason: 'eval-error', unresolved: [], error: 'the judge died' };
  assert.match(unresolvedSection(record), /could not finish \(the judge died\)/);
});

test('model-written text cannot inject markup into the ticket comment', () => {
  const md = unresolvedSection(closed([], [finding({ gap: 'a | b <script>' })]));
  assert.doesNotMatch(md, /<script>/);
});

// ---------------------------------------------- what the reviewer changed

test('the reviewer outcome lists cases added and removed against the kept list, by scenario', () => {
  const record = blank();
  record.attempts.push({
    n: 0, at: '', lap: 0, salvaged: false, cases: [tc('TC-01'), tc('TC-02')], coverage: {}, findings: [],
    dropped: [], status: 'pass', feedbackSent: null,
  });
  record.final = { status: 'pass', chosenAttempt: 0, stopReason: 'passed', unresolved: [] };
  const approved = [tc('TC-01'), { ...tc('TC-09'), scenario: 'a reviewer\'s own case' }];
  const out = reviewOutcome(record, approved, 2);
  assert.deepEqual(out.added, ['a reviewer\'s own case']);
  assert.deepEqual(out.removed, ['scenario TC-02']);
  assert.equal(out.revisions, 2);
});

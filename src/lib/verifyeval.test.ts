/**
 * The verify-eval verdict is graded on hand-built case lists so the rules
 * "every reported case is a real case" and "every reported case carries an
 * evidence line" cannot drift. The scoped-re-run wiring lives in the runner;
 * these cover the pure logic it stands on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DRIFT_ID, MAX_ORPHAN_DROP_SHARE, MAX_VERIFY_EVAL_RETRIES, appendRound, dropOrphans, evalPasses,
  evidenceRubric, feedbackNote, formatVerifyEval, gradeVerify, orphanIds, reconcileOrphans, rerunnable,
  summariseVerifyEval,
  type CaseLike, type VerifyEvalIssue, type VerifyEvalRecord, type VerifyEvalRound,
} from './verifyeval.js';

const cases = (n: number, pad = 2): CaseLike[] => Array.from(
  { length: n },
  (_, i) => ({ id: `TC-${String(i + 1).padStart(pad, '0')}`, result: 'pass', evidence: 'observed' }),
);

const tc = (...ids: string[]): Set<string> => new Set(ids);

const round = (over: Partial<VerifyEvalRound> = {}): VerifyEvalRound => ({
  at: '2026-10-27T00:00:00.000Z', attempt: 0, droppedOrphans: [], issues: [], pass: true, unresolved: false, ...over,
});

test('a run whose every case is real and evidenced passes', () => {
  const results: CaseLike[] = [
    { id: 'TC-01', result: 'pass', evidence: 'row visible, salary present=true' },
    { id: 'TC-02', result: 'fail', evidence: 'broke', screenshot: 'TC-02-fail.png' },
  ];
  const issues = gradeVerify(results, tc('TC-01', 'TC-02'));
  assert.equal(issues.length, 0);
  assert.ok(evalPasses(issues));
});

test('an id not in testcases is an orphan (the #259 TC-15 shape)', () => {
  const results: CaseLike[] = [
    { id: 'TC-14', result: 'pass', evidence: 'processed row readable' },
    { id: 'TC-15', result: 'fail', evidence: 'is_increment_processed stayed false', screenshot: 'TC-15-fail.png' },
  ];
  const testcases = tc('TC-14', 'TC-16');
  assert.deepEqual(orphanIds(results, testcases), ['TC-15']);
  const issues = gradeVerify(results, testcases);
  assert.equal(issues.filter((i) => i.kind === 'orphan-id').length, 1);
  assert.ok(!evalPasses(issues));
});

test('dropOrphans removes exactly the orphan rows and keeps the rest', () => {
  const results: CaseLike[] = [
    { id: 'TC-14', result: 'pass' },
    { id: 'TC-15', result: 'fail' },
    { id: 'TC-16', result: 'pass' },
  ];
  const kept = dropOrphans(results, tc('TC-14', 'TC-16'));
  assert.deepEqual(kept.map((r) => r.id), ['TC-14', 'TC-16']);
});

test('null testcaseIds disables the orphan check — nothing is dropped or flagged', () => {
  const results: CaseLike[] = [{ id: 'TC-99', result: 'pass', evidence: 'observed' }];
  assert.deepEqual(orphanIds(results, null), []);
  assert.deepEqual(dropOrphans(results, null).map((r) => r.id), ['TC-99']);
  assert.equal(gradeVerify(results, null).length, 0);
});

// The rule is the same one for every verdict, so the grader reads the same one
// rubric the verify prompt showed the session that wrote these results.
test('every verdict is flagged when it arrives with no evidence', () => {
  const results: CaseLike[] = [
    { id: 'TC-01', result: 'pass', evidence: '', screenshot: 'TC-01.png' },
    { id: 'TC-02', result: 'fail', evidence: '   ', screenshot: '' },
    { id: 'TC-03', result: 'blocked' },
    { id: 'TC-04', result: 'skipped', evidence: '' },
    { id: 'TC-05', result: 'pre-existing', evidence: '' },
  ];
  const issues = gradeVerify(results, tc('TC-01', 'TC-02', 'TC-03', 'TC-04', 'TC-05'));
  assert.deepEqual(issues.map((i) => i.id), ['TC-01', 'TC-02', 'TC-03', 'TC-04', 'TC-05']);
  assert.deepEqual([...new Set(issues.map((i) => i.kind))], ['no-evidence']);
  assert.match(issues[0]!.detail, /reported 'pass' with no evidence/);
});

test('the detail names the verdict even when the case carries none', () => {
  const issues = gradeVerify([{ id: 'TC-03', result: 'blocked' }], tc('TC-03'));
  assert.match(issues[0]!.detail, /reported 'blocked' with no evidence/);
});

// A screenshot is not asked for here. The verify prompt tells the session to
// leave `screenshot` empty when the asserted value is not in the viewport — a
// <title>, an aria value, a header, a redirect — so a grader that demanded one
// would fail a case for obeying its own instructions.
test('a case with evidence and no screenshot passes', () => {
  const results: CaseLike[] = [
    { id: 'TC-07', result: 'pre-existing', evidence: 'HTTP 500 on base @ abc1234', screenshot: '' },
    { id: 'TC-08', result: 'pass', evidence: 'title reads "Payroll"', screenshot: '' },
  ];
  assert.ok(evalPasses(gradeVerify(results, tc('TC-07', 'TC-08'))));
});

// An orphan is already leaving verify.json, so asking a session to re-run it
// would scope the re-run to a case testcases.json does not list.
test('an orphan being dropped is never also flagged for its missing evidence', () => {
  const results: CaseLike[] = [
    { id: 'TC-01', result: 'pass', evidence: 'ok' },
    { id: 'TC-15', result: 'fail', evidence: '' },
  ];
  const issues = gradeVerify(results, tc('TC-01'));
  assert.deepEqual(issues.map((i) => i.kind), ['orphan-id']);
  assert.deepEqual(rerunnable(issues), []);
});

test('the rubric states the rule and anchors it with an example either way', () => {
  const rubric = evidenceRubric();
  assert.match(rubric, /Every case you report carries an `evidence` line/);
  assert.match(rubric, /^Evidence:$/m);
  assert.match(rubric, /^Not evidence:$/m);
  assert.match(rubric, /did not work/);
});

test('the re-run feedback carries the rubric verbatim, not a paraphrase of it', () => {
  const issues: VerifyEvalIssue[] = [{ id: 'TC-07', kind: 'no-evidence', detail: 'no evidence' }];
  assert.ok(feedbackNote(issues).includes(evidenceRubric()));
});

test('a minority of unknown ids is salvage — reconcileOrphans drops them', () => {
  const verdict = reconcileOrphans(cases(10), tc(...cases(10).slice(3).map((c) => c.id as string)));
  assert.deepEqual(verdict.drop, ['TC-01', 'TC-02', 'TC-03']);
  assert.equal(verdict.drift, null);
});

test('an empty testcases list is drift, not a drop of every case', () => {
  const results = cases(20);
  const verdict = reconcileOrphans(results, tc());
  assert.deepEqual(verdict.drop, []);
  assert.equal(verdict.drift?.kind, 'id-drift');
  assert.equal(verdict.drift?.id, DRIFT_ID);
  assert.match(verdict.drift!.detail, /20 of 20/);
  const issues = gradeVerify(results, tc());
  assert.deepEqual(issues.map((i) => i.kind), ['id-drift']);
  assert.ok(!evalPasses(issues));
});

test('wholesale id drift (TC-1..TC-9 against TC-01..TC-09) keeps the list and flags it once', () => {
  const results = cases(9, 1);
  const testcases = tc(...cases(9).map((c) => c.id as string));
  assert.equal(orphanIds(results, testcases).length, 9);
  const verdict = reconcileOrphans(results, testcases);
  assert.deepEqual(verdict.drop, []);
  assert.equal(verdict.drift?.kind, 'id-drift');
  assert.deepEqual(gradeVerify(results, testcases).map((i) => i.kind), ['id-drift']);
});

test('the drop floor is a share of the reported list, and the share itself still drops', () => {
  assert.equal(MAX_ORPHAN_DROP_SHARE, 0.5);
  const results = cases(10);
  const half = tc(...cases(10).slice(5).map((c) => c.id as string));
  assert.equal(reconcileOrphans(results, half).drop.length, 5);
  const overHalf = tc(...cases(10).slice(6).map((c) => c.id as string));
  assert.equal(reconcileOrphans(results, overHalf).drop.length, 0);
  assert.equal(reconcileOrphans(results, overHalf).drift?.kind, 'id-drift');
});

test('a drift finding is handed to no re-run — nothing to prove and no case to scope to', () => {
  const issues = gradeVerify(cases(9, 1), tc(...cases(9).map((c) => c.id as string)));
  assert.deepEqual(rerunnable(issues), []);
  assert.doesNotMatch(feedbackNote(issues), new RegExp(DRIFT_ID.replace(/[()]/g, '\\$&')));
});

test('rerunnable returns the no-evidence ids and never an orphan', () => {
  const issues: VerifyEvalIssue[] = [
    { id: 'TC-15', kind: 'orphan-id', detail: '' },
    { id: DRIFT_ID, kind: 'id-drift', detail: '' },
    { id: 'TC-07', kind: 'no-evidence', detail: '' },
    { id: 'TC-09', kind: 'no-evidence', detail: '' },
  ];
  assert.deepEqual(rerunnable(issues), ['TC-07', 'TC-09']);
});

test('feedbackNote names the cases to re-run and omits the orphans', () => {
  const issues: VerifyEvalIssue[] = [
    { id: 'TC-15', kind: 'orphan-id', detail: 'orphan' },
    { id: 'TC-07', kind: 'no-evidence', detail: 'TC-07 is labelled pre-existing with no evidence' },
  ];
  const note = feedbackNote(issues);
  assert.match(note, /\*\*TC-07\*\*/);
  assert.doesNotMatch(note, /TC-15/);
});

test('appendRound keeps earlier rounds in order', () => {
  const rec: VerifyEvalRecord = appendRound(null, 259, round({ attempt: 0, droppedOrphans: ['TC-15'] }));
  const rec2 = appendRound(rec, 259, round({ attempt: 1, pass: false, unresolved: true, issues: [{ id: 'TC-07', kind: 'no-evidence', detail: '' }] }));
  assert.equal(rec2.rounds.length, 2);
  assert.deepEqual(rec2.rounds.map((r) => r.attempt), [0, 1]);
});

test('summarise reports the last round per ticket, orphans across all rounds', () => {
  const records: VerifyEvalRecord[] = [
    { iid: 259, rounds: [round({ attempt: 0, droppedOrphans: ['TC-15'], pass: true })] },
    {
      iid: 300,
      rounds: [
        round({ attempt: 0, pass: false, issues: [{ id: 'TC-07', kind: 'no-evidence', detail: '' }] }),
        round({ attempt: 1, pass: false, unresolved: true, issues: [{ id: 'TC-07', kind: 'no-evidence', detail: '' }] }),
      ],
    },
  ];
  const t = summariseVerifyEval(records);
  assert.equal(t.tickets, 2);
  assert.equal(t.rounds, 3);
  assert.equal(t.passed, 1);
  assert.equal(t.unresolved, 1);
  assert.equal(t.orphansDropped, 1);
  assert.equal(t.noEvidence, 1);
  assert.equal(t.idDrift, 0);
});

test('summarise counts an open drift finding under its own kind', () => {
  const records: VerifyEvalRecord[] = [{
    iid: 400,
    rounds: [round({ pass: false, unresolved: true, issues: [{ id: DRIFT_ID, kind: 'id-drift', detail: '' }] })],
  }];
  const t = summariseVerifyEval(records);
  assert.equal(t.idDrift, 1);
  assert.equal(t.issuesOpen, 1);
  assert.equal(t.orphansDropped, 0);
  assert.ok(formatVerifyEval(records).some((l) => l.includes('UNRESOLVED') && l.includes('id-drift')));
});

test('format lists a verdict per ticket and never crashes on an empty set', () => {
  assert.deepEqual(formatVerifyEval([]), ['no verify-eval records']);
  const out = formatVerifyEval([{ iid: 259, rounds: [round({ droppedOrphans: ['TC-15'] })] }]);
  assert.ok(out.some((l) => l.includes('#259') && l.includes('PASS') && l.includes('TC-15')));
});

test('the retry cap is one', () => {
  assert.equal(MAX_VERIFY_EVAL_RETRIES, 1);
});

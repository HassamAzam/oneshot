/**
 * The verify-eval verdict is graded on hand-built case lists so the rules
 * "every reported case is a real case" and "every pre-existing label is proven"
 * cannot drift. The scoped-re-run wiring lives in the runner; these cover the
 * pure logic it stands on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_VERIFY_EVAL_RETRIES, appendRound, dropOrphans, evalPasses, feedbackNote, formatVerifyEval,
  gradeVerify, orphanIds, rerunnable, summariseVerifyEval,
  type CaseLike, type VerifyEvalIssue, type VerifyEvalRecord, type VerifyEvalRound,
} from './verifyeval.js';

const tc = (...ids: string[]): Set<string> => new Set(ids);
const never = (): boolean => false;
const always = (): boolean => true;

const round = (over: Partial<VerifyEvalRound> = {}): VerifyEvalRound => ({
  at: '2026-10-27T00:00:00.000Z', attempt: 0, droppedOrphans: [], issues: [], pass: true, unresolved: false, ...over,
});

test('a clean run with no pre-existing labels passes', () => {
  const results: CaseLike[] = [
    { id: 'TC-01', result: 'pass' },
    { id: 'TC-02', result: 'fail', evidence: 'broke', screenshot: 'TC-02-fail.png' },
  ];
  const issues = gradeVerify(results, tc('TC-01', 'TC-02'), always);
  assert.equal(issues.length, 0);
  assert.ok(evalPasses(issues));
});

test('an id not in testcases is an orphan (the #259 TC-15 shape)', () => {
  const results: CaseLike[] = [
    { id: 'TC-14', result: 'pass' },
    { id: 'TC-15', result: 'fail', evidence: 'is_increment_processed stayed false', screenshot: 'TC-15-fail.png' },
  ];
  const testcases = tc('TC-14', 'TC-16');
  assert.deepEqual(orphanIds(results, testcases), ['TC-15']);
  const issues = gradeVerify(results, testcases, always);
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
  const results: CaseLike[] = [{ id: 'TC-99', result: 'pass' }];
  assert.deepEqual(orphanIds(results, null), []);
  assert.deepEqual(dropOrphans(results, null).map((r) => r.id), ['TC-99']);
  assert.equal(gradeVerify(results, null, never).length, 0);
});

test('a pre-existing label with no evidence is flagged', () => {
  const results: CaseLike[] = [{ id: 'TC-07', result: 'pre-existing', evidence: '', screenshot: 'TC-07.png' }];
  const issues = gradeVerify(results, tc('TC-07'), always);
  assert.deepEqual(issues.map((i) => i.kind), ['no-evidence']);
});

test('a pre-existing label whose screenshot is missing on disk is flagged', () => {
  const results: CaseLike[] = [{ id: 'TC-07', result: 'pre-existing', evidence: 'fails on base too', screenshot: 'TC-07.png' }];
  const onDisk = (f: string): boolean => f === 'present.png';
  const issues = gradeVerify(results, tc('TC-07'), onDisk);
  assert.deepEqual(issues.map((i) => i.kind), ['no-screenshot']);
  assert.match(issues[0]!.detail, /not on disk/);
});

test('a pre-existing label with an empty screenshot field is flagged', () => {
  const results: CaseLike[] = [{ id: 'TC-07', result: 'pre-existing', evidence: 'fails on base too', screenshot: '' }];
  const issues = gradeVerify(results, tc('TC-07'), always);
  assert.deepEqual(issues.map((i) => i.kind), ['no-screenshot']);
});

test('a well-proven pre-existing label passes', () => {
  const results: CaseLike[] = [{ id: 'TC-07', result: 'pre-existing', evidence: 'HTTP 500 on base @ abc1234', screenshot: 'TC-07.png' }];
  assert.ok(evalPasses(gradeVerify(results, tc('TC-07'), (f) => f === 'TC-07.png')));
});

test('fail/pass/blocked labels are not required to carry evidence or a screenshot', () => {
  const results: CaseLike[] = [
    { id: 'TC-01', result: 'fail', evidence: '', screenshot: '' },
    { id: 'TC-02', result: 'blocked', evidence: '', screenshot: '' },
    { id: 'TC-03', result: 'pass' },
  ];
  assert.equal(gradeVerify(results, tc('TC-01', 'TC-02', 'TC-03'), never).length, 0);
});

test('rerunnable returns the pre-existing ids and never an orphan', () => {
  const issues: VerifyEvalIssue[] = [
    { id: 'TC-15', kind: 'orphan-id', detail: '' },
    { id: 'TC-07', kind: 'no-evidence', detail: '' },
    { id: 'TC-07', kind: 'no-screenshot', detail: '' },
    { id: 'TC-09', kind: 'no-screenshot', detail: '' },
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
        round({ attempt: 1, pass: false, unresolved: true, issues: [{ id: 'TC-07', kind: 'no-screenshot', detail: '' }] }),
      ],
    },
  ];
  const t = summariseVerifyEval(records);
  assert.equal(t.tickets, 2);
  assert.equal(t.rounds, 3);
  assert.equal(t.passed, 1);
  assert.equal(t.unresolved, 1);
  assert.equal(t.orphansDropped, 1);
  assert.equal(t.noScreenshot, 1);
  assert.equal(t.noEvidence, 0);
});

test('format lists a verdict per ticket and never crashes on an empty set', () => {
  assert.deepEqual(formatVerifyEval([]), ['no verify-eval records']);
  const out = formatVerifyEval([{ iid: 259, rounds: [round({ droppedOrphans: ['TC-15'] })] }]);
  assert.ok(out.some((l) => l.includes('#259') && l.includes('PASS') && l.includes('TC-15')));
});

test('the retry cap is one', () => {
  assert.equal(MAX_VERIFY_EVAL_RETRIES, 1);
});

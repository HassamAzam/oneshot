/**
 * The report sums per-ticket scores; its arithmetic is checked on hand-built
 * rows so a change to the score cannot quietly change what the totals mean.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EvalRecord, EvalScore } from './testcaseseval.js';
import {
  formatGold, formatReport, gradeAgainstGold, reportRow, summarise, type GoldLabel, type ReportRow,
} from './testcasesevalreport.js';

const score = (over: Partial<EvalScore> = {}): EvalScore => ({
  requirements: 4, firstCovered: 4, keptCovered: 4, retries: 0, openCritical: 0, openMajor: 0, uncertain: 0,
  judgeTurns: 5, judgeWeighted: 1, retryTurns: 0, retryWeighted: 0, ...over,
});
const row = (iid: number, over: Partial<ReportRow> = {}): ReportRow => ({
  iid, status: 'pass', stopReason: 'passed', score: score(), ...over,
});

test('coverage is pooled over requirements, and a retry counts as improving only when it covered more', () => {
  const t = summarise([
    row(1),
    row(2, { score: score({ requirements: 6, firstCovered: 3, keptCovered: 6, retries: 1, retryWeighted: 4 }) }),
    row(3, {
      status: 'fail', stopReason: 'no-progress',
      score: score({ requirements: 2, firstCovered: 1, keptCovered: 1, retries: 1, openCritical: 1 }),
    }),
  ]);
  assert.equal(t.requirements, 12);
  assert.equal(t.firstCovered, 8);
  assert.equal(t.keptCovered, 11);
  assert.equal(t.passedFirstTime, 1);
  assert.equal(t.retried, 2);
  assert.equal(t.improved, 1);
  assert.equal(t.retries, 2);
  assert.equal(t.openCritical, 1);
  assert.equal(t.retryWeighted, 4);
  assert.deepEqual(t.byStatus, { fail: 1, pass: 2 });
  assert.deepEqual(t.byStop, { 'no-progress': 1, passed: 2 });
});

test('an unfinished record is listed as open and adds nothing to the coverage totals', () => {
  const open = reportRow({ iid: 9, project: 'p', runId: 'r', requirements: [], attempts: [] });
  assert.deepEqual(open, { iid: 9, status: 'open', stopReason: null, score: null });
  const t = summarise([open, row(1)]);
  assert.equal(t.tickets, 2);
  assert.equal(t.requirements, 4);
  assert.deepEqual(t.byStatus, { open: 1, pass: 1 });
});

test('the printed report has a row per ticket and the pooled coverage', () => {
  const lines = formatReport([row(2, { score: score({ firstCovered: 2, keptCovered: 4, retries: 1 }) }), row(1)]);
  assert.match(lines[1]!, /^#1 /);
  assert.match(lines[2]!, /^#2 .*2\/4 → 4\/4/);
  assert.ok(lines.some((l) => l.includes('first list 75% → kept list 100%')));
  assert.deepEqual(formatReport([]), ['No ticket has a test-case evaluation yet.']);
});

test('reviewer additions are summed across tickets', () => {
  const t = summarise([
    row(1, { review: { added: ['a', 'b'], removed: [], revisions: 1 } }),
    row(2, { review: { added: [], removed: ['c'], revisions: 0 } }),
    row(3),
  ]);
  assert.equal(t.reviewed, 2);
  assert.equal(t.reviewerAddedOn, 1);
  assert.equal(t.reviewerAdded, 2);
  assert.ok(formatReport([row(1, { review: { added: ['a'], removed: [], revisions: 1 } })])
    .some((l) => l.includes('reviewers added cases after the evaluation on 1/1')));
});

test('the report no longer claims a judge-agreement figure, which measured self-consistency', () => {
  assert.ok(!formatReport([row(1)]).some((l) => l.includes('judge agreement')));
});

const tc = (id: string) => ({ id, scenario: id, precondition: '', steps: [], expected: '', pass: ['happy' as const], blast: 'low' as const });
const graded = (): EvalRecord => ({
  iid: 5, project: 'p', runId: 'run-1',
  requirements: ['AC1', 'AC2', 'AC3', 'AC4'].map((id) => ({ id, text: id })),
  attempts: [{
    n: 0, at: '', lap: 0, salvaged: false, cases: [tc('TC-01'), tc('TC-02')],
    coverage: { AC1: 'TC-01', AC2: 'TC-02', AC3: null, AC4: 'TC-09' }, findings: [], dropped: [],
    status: 'pass', feedbackSent: null,
  }],
  final: { status: 'pass', chosenAttempt: 0, stopReason: 'passed', unresolved: [] },
});

test('a record is graded against labels for its run: real, missed and coverage calls', () => {
  const gold: GoldLabel = {
    project: 'p', runId: 'run-1', real: { AC1: 'TC-01', AC2: null, AC3: 'TC-02' }, notReal: ['AC4'], missed: ['Sorted by date'],
  };
  const g = gradeAgainstGold(graded(), gold);
  assert.notEqual(typeof g, 'string');
  assert.deepEqual(g, {
    iid: 5, real: 3, notReal: 1, missed: 1, unlabelled: [],
        coverageLabelled: 3, coverageAgree: 1, falseCovered: 1, falseGap: 1, misattributed: 0,
  });
  const lines = formatGold([g as Exclude<typeof g, string>]);
  assert.ok(lines.some((l) => l.includes(
    '75% of those judged against are real requirements, 75% of the real requirements are stated as one')));
  assert.ok(lines.some((l) => l.includes(
    '33% of 3 labelled call(s) agree — 1 falsely covered, 1 falsely missing, 0 on the wrong case')));
});

test('a judge that covers a requirement with the wrong case is counted apart from overclaiming', () => {
  const g = gradeAgainstGold(graded(), {
    project: 'p', runId: 'run-1', real: { AC1: 'TC-07' }, notReal: [], missed: [],
  }) as Exclude<ReturnType<typeof gradeAgainstGold>, string>;
  assert.equal(g.coverageAgree, 0);
  assert.equal(g.misattributed, 1);
  assert.equal(g.falseCovered, 0);
  assert.equal(g.falseGap, 0);
  assert.ok(formatGold([g]).some((l) => l.includes('1 on the wrong case')));
});

test('labels are refused when the requirement they were written against changed', () => {
  const WORDED = 'Every amount renders with at most two decimals.';
  const record = (): EvalRecord => {
    const r = graded();
    return { ...r, requirements: [{ ...r.requirements[0]!, text: WORDED }, ...r.requirements.slice(1)] };
  };
  const texts = { project: 'p', runId: 'run-1', real: { AC1: 'TC-01' }, notReal: [], missed: [] };
  assert.match(
    String(gradeAgainstGold(record(), { ...texts, requirements: { AC1: 'Something else entirely' } })),
    /AC1 has been reworded/,
  );
  assert.match(
    String(gradeAgainstGold(record(), { ...texts, requirements: { AC9: 'Gone' } })),
    /AC9 was labelled but the record no longer holds it/,
  );
  const reflowed = gradeAgainstGold(record(), {
    ...texts, requirements: { AC1: `  ${WORDED.replace(/ /g, '\n   ')}  ` },
  });
  assert.notEqual(typeof reflowed, 'string', 're-wrapping is not a rewording');
});

test('labels written for another run are refused, and unlabelled ids are named', () => {
  assert.match(String(gradeAgainstGold(graded(), { project: 'p', runId: 'run-0', real: {}, notReal: [], missed: [] })), /run-0/);
  const g = gradeAgainstGold(graded(), { project: 'p', runId: 'run-1', real: { AC1: 'TC-01' }, notReal: [], missed: [] });
  assert.deepEqual((g as { unlabelled: string[] }).unlabelled, ['AC2', 'AC3', 'AC4']);
});


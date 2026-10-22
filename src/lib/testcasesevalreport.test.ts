/**
 * The report sums per-ticket scores; its arithmetic is checked on hand-built
 * rows so a change to the score cannot quietly change what the totals mean.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EvalScore } from './testcaseseval.js';
import { formatReport, reportRow, summarise, type ReportRow } from './testcasesevalreport.js';

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

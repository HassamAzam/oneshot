/**
 * outcomeOf turns what a run recorded into the row the live eval counts. The
 * headline, realFailureAtHandoff, has to agree with the merge gate about what
 * a failure is, or the weekly number measures something the gate does not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendOutcome, outcomeOf, passesMissing, readOutcomes, type OutcomeInputs } from './outcomes.js';
import { TEST_PASSES } from '../phases/types.js';
import type { RunJournal } from './artifacts.js';

const journal = (patch: Partial<RunJournal> = {}): RunJournal => ({
  runId: 'r-1', iid: 7, title: 't', url: 'https://gitlab.example/g/p/-/issues/7',
  createdAt: 0, status: 'done', phases: [], ...patch,
});

const verify = (...results: Array<[string, string, string?]>): OutcomeInputs['verify'] =>
  ({ results: results.map(([id, result, evidence = 'seen']) => ({ id, result, evidence })), regressions: [] });

const none: OutcomeInputs = { verify: null, testcases: null, findings: null };

test('a handed-off run with a failing case is a real failure at handoff', () => {
  const row = outcomeOf(journal({ mrIid: 3 }), { ...none, verify: verify(['TC-1', 'pass'], ['TC-2', 'fail']) });
  assert.deepEqual(row.failing, ['TC-2']);
  assert.equal(row.realFailureAtHandoff, true);
});

test('pre-existing with evidence is not this change\'s failure', () => {
  const row = outcomeOf(journal({ mrIid: 3 }), { ...none, verify: verify(['TC-1', 'pre-existing', 'base fails too']) });
  assert.deepEqual(row.failing, []);
  assert.equal(row.realFailureAtHandoff, false);
  assert.equal(row.cases.preExisting, 1);
});

test('pre-existing with no evidence counts as the failure it hides, as the merge gate does', () => {
  const row = outcomeOf(journal({ mrIid: 3 }), { ...none, verify: verify(['TC-1', 'pre-existing', ' ']) });
  assert.deepEqual(row.failing, ['TC-1']);
  assert.equal(row.realFailureAtHandoff, true);
});

test('a regression alone makes a handed-off run a real failure', () => {
  const row = outcomeOf(journal({ mrIid: 3 }), { ...none, verify: { results: [], regressions: ['login broke'] } });
  assert.equal(row.realFailureAtHandoff, true);
});

test('a run with no MR was never handed off, whatever failed', () => {
  const row = outcomeOf(journal(), { ...none, verify: verify(['TC-1', 'fail']) });
  assert.equal(row.handedOff, false);
  assert.equal(row.realFailureAtHandoff, false);
});

test('a fail whose evidence blames the base is flagged as blamed elsewhere', () => {
  const row = outcomeOf(journal(), {
    ...none,
    verify: verify(['TC-1', 'fail', 'traced to a backend annotation issue pre-existing and untouched by this diff'], ['TC-2', 'fail']),
  });
  assert.deepEqual(row.failBlamedElsewhere, ['TC-1']);
});

test('pre-existing on a happy-path case is flagged as the ticket\'s own case dismissed', () => {
  const row = outcomeOf(journal(), {
    ...none,
    verify: verify(['TC-1', 'pre-existing', 'base'], ['TC-2', 'pre-existing', 'base']),
    testcases: { cases: [{ id: 'TC-1', pass: ['happy'] }, { id: 'TC-2', pass: ['edge'] }] },
  });
  assert.deepEqual(row.ownCaseDismissed, ['TC-1']);
});

test('implement laps and review blockers are counted from the journal and findings', () => {
  const row = outcomeOf(
    journal({ phases: [{ phase: 'implement', lap: 0, status: 'ok' }, { phase: 'implement', lap: 1, status: 'ok' }] as RunJournal['phases'] }),
    { ...none, findings: { findings: [{ severity: 'major' }, { severity: 'minor' }, { severity: 'blocker' }] } },
  );
  assert.equal(row.implementLaps, 2);
  assert.equal(row.reviewBlockers, 2);
});

test('readOutcomes keeps the last row per run and skips a torn line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'outcomes-'));
  const path = join(dir, 'outcomes.jsonl');
  try {
    appendOutcome(outcomeOf(journal({ status: 'parked' }), none, 1), path);
    writeFileSync(path, '{"torn', { flag: 'a' });
    writeFileSync(path, '\n', { flag: 'a' });
    appendOutcome(outcomeOf(journal({ status: 'done' }), none, 2), path);
    const rows = readOutcomes(path);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, 'done');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a pass with no case and no passesEmpty note is missing; a declared-empty one is not', () => {
  const cases = TEST_PASSES.filter((p) => p !== 'hostile' && p !== 'cross-module').map((p, i) => ({ id: `TC-${i}`, pass: [p] }));
  assert.deepEqual(passesMissing({ cases, passesEmpty: ['cross-module: the change touches one module'] }), ['hostile']);
});

test('no test list means nothing was skipped', () => {
  assert.deepEqual(passesMissing(null), []);
  assert.deepEqual(passesMissing({ cases: [] }), []);
});

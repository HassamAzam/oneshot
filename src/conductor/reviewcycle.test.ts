/**
 * A review that asks for changes sends the work back to implement.
 *
 * `review` is configured `onFail: cycle -> implement, maxLaps: 3`, but it
 * returns ok for *producing* its artifact whatever the verdict, so the policy
 * never fired on the thing it was written for: a 'changes-requested' travelled
 * to the merge gate, three phases and one MR later, and the lap that would have
 * fixed the finding was spent opening an MR nobody could merge.
 *
 * The invariant worth protecting is not which condition cycles, it is that the
 * condition MATCHES the one that refuses the merge. Anything that blocks the
 * merge without cycling implement is a dead end: the run can neither proceed
 * nor fix itself, and a person has to unblock it by hand.
 */
import '../lib/test-project-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failedCases, salvagedReview } from './runner.js';

const finding = (id: string, severity: string) => ({ id, severity, what: 'something', file: 'a.py', line: 1 });

test('a completed review asking for changes fails, and names the findings', () => {
  const why = failedCases('review', {
    verdict: 'changes-requested',
    findings: [finding('F-01', 'major'), finding('F-02', 'minor')],
  });
  assert.ok(why, 'it must fail so `cycle -> implement` fires');
  assert.match(why, /F-01 \[major\]/);
  assert.match(why, /changes-requested/);
});

test('an approved review does not fail', () => {
  assert.equal(failedCases('review', { verdict: 'approved', findings: [finding('F-01', 'suggestion')] }), null);
});

test('a blocker on record fails even if the verdict says otherwise', () => {
  // The merge gate refuses on either, so cycling must too — see the dead-end
  // invariant in the header.
  const why = failedCases('review', { verdict: 'approved', findings: [finding('F-01', 'blocker')] });
  assert.ok(why, 'a recorded blocker is a fact about the code whatever the verdict says');
});

test('changes-requested with only minors still fails, because the merge still refuses', () => {
  // Deliberately NOT narrowed to serious findings. Narrowing it would leave a
  // run that the merge gate blocks and the cycle ignores, which is the dead end
  // this file exists to prevent.
  const why = failedCases('review', { verdict: 'changes-requested', findings: [finding('F-02', 'minor')] });
  assert.ok(why);
  assert.match(why, /0 blocker\/major/);
});

test('a SALVAGED review records its verdict and spends no lap', () => {
  // A session that died cannot say what it did not read, so an implement lap
  // would be aimed at part of a list. These stop at the merge for a person.
  const salvaged = salvagedReview([finding('F-01', 'major')], 'exited with code 1');
  assert.ok(salvaged);
  assert.equal(salvaged.verdict, 'changes-requested');
  assert.equal(salvaged.partial, true);
  assert.equal(failedCases('review', salvaged as unknown as Record<string, unknown>), null,
    'the salvage marks itself, and the cycle skips it');
});

test('a review with nothing recorded does not fail', () => {
  assert.equal(failedCases('review', { verdict: 'approved', findings: [] }), null);
  assert.equal(failedCases('review', null), null);
  assert.equal(failedCases('review', undefined), null);
});

test('no other phase is affected by the review rule', () => {
  for (const phase of ['implement', 'plan', 'mr', 'ui-evidence']) {
    assert.equal(failedCases(phase, { verdict: 'changes-requested', findings: [finding('F-01', 'major')] }), null, phase);
  }
});

test('verify keeps the behaviour it already had', () => {
  assert.ok(failedCases('verify', { results: [{ id: 'TC-01', result: 'fail' }] }));
  assert.equal(failedCases('verify', { results: [{ id: 'TC-01', result: 'pass' }] }), null);
});

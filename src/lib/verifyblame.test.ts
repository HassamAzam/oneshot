/**
 * blameOf reads what verify said about each failing case. It has to agree
 * with the merge gate about what a failure is, and it has to recover verify's
 * own label from a case the base check rescored.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blameOf, verifyLabel, type VerifyArtifact } from './verifyblame.js';
import { OVERRULED_PRE_EXISTING } from '../phases/types.js';

const verify = (...results: Array<[string, string, string?]>): VerifyArtifact =>
  ({ results: results.map(([id, result, evidence = 'seen']) => ({ id, result, evidence })), regressions: [] });

const overruled = (why: string): string => `${OVERRULED_PRE_EXISTING} — ${why} — verify: base fails the same way, pre-existing`;

test('a failing case counts as this change\'s failure', () => {
  assert.deepEqual(blameOf(verify(['TC-1', 'pass'], ['TC-2', 'fail']), null).failing, ['TC-2']);
});

test('pre-existing with evidence is not this change\'s failure', () => {
  assert.deepEqual(blameOf(verify(['TC-1', 'pre-existing', 'base fails too']), null).failing, []);
});

test('pre-existing with no evidence counts as the failure it hides, as the merge gate does', () => {
  assert.deepEqual(blameOf(verify(['TC-1', 'pre-existing', ' ']), null).failing, ['TC-1']);
});

test('a fail whose evidence blames the base is flagged as blamed elsewhere', () => {
  const blame = blameOf(verify(
    ['TC-1', 'fail', 'traced to a backend annotation issue pre-existing and untouched by this diff'],
    ['TC-2', 'fail'],
  ), null);
  assert.deepEqual(blame.failBlamedElsewhere, ['TC-1']);
});

test('a fail whose evidence says "not pre-existing" is not blamed elsewhere', () => {
  const blame = blameOf(verify(['TC-1', 'fail', 'confirmed not pre-existing: the diff introduces the crash']), null);
  assert.deepEqual(blame.failBlamedElsewhere, []);
});

test('pre-existing on a happy-path case is flagged as the ticket\'s own case dismissed', () => {
  const blame = blameOf(
    verify(['TC-1', 'pre-existing', 'base'], ['TC-2', 'pre-existing', 'base']),
    { cases: [{ id: 'TC-1', pass: ['happy'] }, { id: 'TC-2', pass: ['edge'] }] },
  );
  assert.deepEqual(blame.ownCaseDismissed, ['TC-1']);
});

test('a pre-existing label the base check overruled is verify\'s pre-existing, not its fail', () => {
  assert.equal(verifyLabel({ result: 'fail', evidence: overruled('passes on dev') }), 'pre-existing');
  assert.equal(verifyLabel({ result: 'fail', evidence: 'pre-existing on dev' }), 'fail');
});

test('an overruled pre-existing label still fails the case but is not blamed elsewhere', () => {
  const blame = blameOf(verify(['TC-1', 'fail', overruled('passes on dev')]), null);
  assert.deepEqual(blame.failing, ['TC-1']);
  assert.deepEqual(blame.failBlamedElsewhere, []);
});

test('a happy-path case verify called pre-existing is dismissed even after the base check rescored it', () => {
  const blame = blameOf(
    verify(['TC-1', 'fail', overruled('tagged \'happy\'')], ['TC-2', 'fail', overruled('passes on dev')]),
    { cases: [{ id: 'TC-1', pass: ['happy'] }, { id: 'TC-2', pass: ['state'] }] },
  );
  assert.deepEqual(blame.ownCaseDismissed, ['TC-1']);
});

test('no verify artifact means nothing to blame', () => {
  assert.deepEqual(blameOf(null, null), { failing: [], failBlamedElsewhere: [], ownCaseDismissed: [] });
});

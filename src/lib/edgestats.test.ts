/**
 * tallyTrials folds k judge trials of one ticket into a pass rate per edge and
 * a noise band. It has to tell an edge the judge always covers from one it
 * covers only sometimes, and report the spread a real change has to beat.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tallyTrials, majorityCovered, beyondNoise } from './edgestats.js';

const trial = (...ids: string[]): Set<string> => new Set(ids);

test('one trial reduces to the single-run counts, with no spread', () => {
  const s = tallyTrials(['E1', 'E2', 'E3'], [trial('E1', 'E2')]);
  assert.equal(s.trials, 1);
  assert.deepEqual(s.coveredEveryTrial, ['E1', 'E2']);
  assert.deepEqual(s.missingEveryTrial, ['E3']);
  assert.deepEqual(s.flaky, []);
  assert.equal(s.spread, 0);
  assert.equal(s.meanCovered, 2);
});

test('an edge covered in every trial is solid, one covered in some is flaky, one in none is missing', () => {
  const s = tallyTrials(['E1', 'E2', 'E3'], [trial('E1', 'E2'), trial('E1'), trial('E1', 'E2')]);
  assert.deepEqual(s.coveredEveryTrial, ['E1']);
  assert.deepEqual(s.flaky, ['E2']);
  assert.deepEqual(s.missingEveryTrial, ['E3']);
  assert.equal(s.perEdge.find((e) => e.id === 'E2')?.hits, 2);
});

test('spread is the gap between the best and worst trial, and mean is fractional', () => {
  const s = tallyTrials(['E1', 'E2', 'E3'], [trial('E1', 'E2', 'E3'), trial('E1')]);
  assert.equal(s.minCovered, 1);
  assert.equal(s.maxCovered, 3);
  assert.equal(s.spread, 2);
  assert.equal(s.meanCovered, 2);
});

test('zero trials leaves every edge missing and no spread', () => {
  const s = tallyTrials(['E1', 'E2'], []);
  assert.deepEqual(s.missingEveryTrial, ['E1', 'E2']);
  assert.deepEqual(s.coveredEveryTrial, []);
  assert.equal(s.spread, 0);
});

test('majority vote needs more than half the trials', () => {
  assert.equal(majorityCovered({ id: 'E', hits: 2, trials: 3 }), true);
  assert.equal(majorityCovered({ id: 'E', hits: 1, trials: 3 }), false);
  assert.equal(majorityCovered({ id: 'E', hits: 1, trials: 2 }), false);
});

test('a change counts only when it clears the noise band', () => {
  assert.equal(beyondNoise(3, 2), true);
  assert.equal(beyondNoise(2, 2), false);
  assert.equal(beyondNoise(-3, 2), true);
  assert.equal(beyondNoise(0, 0), false);
});

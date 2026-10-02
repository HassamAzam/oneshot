import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseShotsFor } from './publish.js';

/**
 * base-check saves `base-<case-id>.png` for every case it scores 'fails', and
 * that image is the proof the MR note asks a reviewer to confirm. It used to be
 * captured and then dropped, so the note claimed "confirmed on <base>" with
 * nothing to look at.
 */
const result = (id: string, r: string) => ({ id, result: r, evidence: 'e', screenshot: `${id}.png` });

test('a confirmed pre-existing case brings its base-branch screenshot to the MR', () => {
  const shots = baseShotsFor(
    [result('TC-01', 'pass'), result('TC-15', 'pre-existing')],
    { results: [{ id: 'TC-15', onBase: 'fails', inTicketScope: false, evidence: 'x', screenshot: 'base-TC-15.png' }] },
  );
  assert.deepEqual(shots.map((s) => [s.id, s.screenshot]), [['TC-15', 'base-TC-15.png']]);
});

test('a label the conductor refused shows no base shot, whatever the check saved', () => {
  const shots = baseShotsFor(
    [result('TC-15', 'fail')],
    { results: [{ id: 'TC-15', onBase: 'fails', inTicketScope: true, evidence: 'x', screenshot: 'base-TC-15.png' }] },
  );
  assert.deepEqual(shots, []);
});

test('only an entry the check scored fails, with a file named, contributes a shot', () => {
  const labelled = [result('TC-15', 'pre-existing'), result('TC-16', 'pre-existing')];
  assert.deepEqual(baseShotsFor(labelled, {
    results: [
      { id: 'TC-15', onBase: 'passes', screenshot: 'base-TC-15.png' },
      { id: 'TC-16', onBase: 'fails', screenshot: '  ' },
    ],
  }), []);
  assert.deepEqual(baseShotsFor(labelled, null), []);
});

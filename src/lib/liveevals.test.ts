/**
 * The live verify record must carry exactly what eval:live compares: the
 * failing and passing case ids, and each gold-free flag tied to its case.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyRecord } from './liveevals.js';

test('a verify record lists failing and passing cases and ties each flag to its case', () => {
  const rec = verifyRecord(7, 2, {
    results: [
      { id: 'TC-1', result: 'pass', evidence: 'ok' },
      { id: 'TC-2', result: 'fail', evidence: 'root cause is pre-existing and untouched by this diff' },
      { id: 'TC-3', result: 'fail', evidence: 'crash in the new serializer' },
    ],
  }, { cases: [{ id: 'TC-1', pass: ['happy'] }, { id: 'TC-2', pass: ['state'] }, { id: 'TC-3', pass: ['state'] }] });
  assert.equal(rec.phase, 'verify');
  assert.equal(rec.lap, 2);
  assert.deepEqual(rec.failing, ['TC-2', 'TC-3']);
  assert.deepEqual(rec.passing, ['TC-1']);
  assert.deepEqual(rec.flags, [{ mode: 'blamed-elsewhere', caseId: 'TC-2' }]);
});

test('a verify record with no artifact is empty, not an error', () => {
  const rec = verifyRecord(7, 0, null, null);
  assert.deepEqual([rec.failing, rec.passing, rec.flags], [[], [], []]);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driveSyncDue } from './drivesync.js';

test('without hand-off at merge every pass may write the folder', () => {
  delete process.env.ONESHOT_HANDOFF_AT_MERGE;
  assert.equal(driveSyncDue({}), true);
  assert.equal(driveSyncDue({ handedOff: true }), true);
});

test('with hand-off at merge the folder is written only once the run is handed off', () => {
  process.env.ONESHOT_HANDOFF_AT_MERGE = '1';
  try {
    assert.equal(driveSyncDue({}), false);
    assert.equal(driveSyncDue({ handedOff: false }), false);
    assert.equal(driveSyncDue({ handedOff: true }), true);
  } finally {
    delete process.env.ONESHOT_HANDOFF_AT_MERGE;
  }
});

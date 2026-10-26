import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crashIsInfra } from './phase.js';

const EXIT_1 = 'Claude Code process exited with code 1';

test('a session that worked and then crashed with no result frame is infra, not a lap', () => {
  assert.equal(crashIsInfra(EXIT_1, 1128, { data: null, resultSubtype: null }), true);
});

test('a crash whose only result frame is error_during_execution is infra', () => {
  assert.equal(crashIsInfra(EXIT_1, 1128, { data: null, resultSubtype: 'error_during_execution' }), true);
});

test('a crash before any stream message, or by signal, stays infra', () => {
  assert.equal(crashIsInfra(EXIT_1, 0, { data: null, resultSubtype: null }), true);
  assert.equal(crashIsInfra('terminated by signal SIGKILL', 50, { data: { ok: 1 }, resultSubtype: 'success' }), true);
});

test('a session that ran out of its budget is a failure, because a re-run lands in the same place', () => {
  assert.equal(crashIsInfra(EXIT_1, 300, { data: null, resultSubtype: 'error_max_turns' }), false);
  assert.equal(crashIsInfra(EXIT_1, 300, { data: null, resultSubtype: 'error_max_structured_output_retries' }), false);
});

test('a session that already returned its verdict is never re-attempted for the exit code after it', () => {
  assert.equal(crashIsInfra(EXIT_1, 300, { data: { verdict: 'approve' }, resultSubtype: 'success' }), false);
});

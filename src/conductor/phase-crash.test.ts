import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crashIsInfra, throwAfterSettle } from './phase.js';

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

// #9174: the CLI exits 1 after a finished session whenever a background task
// outlives the final answer, and the SDK's "exited with code 1" then replaced
// what fifteen sessions had really reported.
test('a session that succeeded keeps its result when the stream fails after it', () => {
  const out = { ok: true, data: { verdict: 'approve' } as Record<string, unknown>, error: undefined as string | undefined };
  throwAfterSettle(out, EXIT_1, 300, 'success');
  assert.deepEqual(out, { ok: true, data: { verdict: 'approve' }, error: undefined });
});

test('a session that ran out of a budget keeps that as its error, and is not infra', () => {
  const out = {
    ok: false, data: null,
    error: 'error_max_structured_output_retries: Failed to provide valid structured output after 5 attempts',
    infra: undefined as boolean | undefined,
  };
  throwAfterSettle(out, EXIT_1, 245, 'error_max_structured_output_retries');
  assert.match(out.error, /structured output/);
  assert.equal(out.infra, undefined);
});

test('a session settled by error_during_execution is still infra after the exit', () => {
  const out = { ok: false, data: null, infra: undefined as boolean | undefined };
  throwAfterSettle(out, EXIT_1, 120, 'error_during_execution');
  assert.equal(out.infra, true);
});

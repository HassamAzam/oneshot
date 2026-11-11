import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crashIsInfra, isLimitNotice } from './phase.js';

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

test('a tagged frame is a usage-limit notice whatever it says, and prose is one only where prose counts', () => {
  assert.equal(isLimitNotice('rate_limit', '', false), true);
  assert.equal(isLimitNotice('rate_limit', "You've hit your limit · resets 4:30pm", true), true);
  assert.equal(isLimitNotice('', "You've hit your limit · resets 4:30pm", true), true);
  // A diagnosis session quoting the run it is explaining.
  const quoting = 'review lap 2 was recorded as `rate_limit: You\'ve hit your session limit · resets 4:30pm`; that is the cause.';
  assert.equal(isLimitNotice('', quoting, true), true, 'which is why the Loop keeps the text match and these sessions do not');
  assert.equal(isLimitNotice('', quoting, false), false);
  assert.equal(isLimitNotice('', 'ordinary words', true), false);
});

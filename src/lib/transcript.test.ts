import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skillsInvoked, transcriptResult } from './transcript.js';

const frame = (o: Record<string, unknown>): string => JSON.stringify(o);

test('transcriptResult reads the result frame, not an earlier assistant line', () => {
  const jsonl = [
    frame({ type: 'assistant', structured_output: { plan: 'a draft nobody kept' } }),
    frame({ type: 'result', structured_output: { plan: 'final' }, num_turns: 27, total_cost_usd: 1.78 }),
  ].join('\n');

  const r = transcriptResult(jsonl);

  assert.deepEqual(r.output, { plan: 'final' });
  assert.equal(r.turns, 27);
  assert.equal(r.costUsd, 1.78);
});

test('a trailing error_during_execution frame does not overwrite the real result', () => {
  // Observed live and handled the same way in src/conductor/phase.ts: the SDK
  // emits the success frame carrying the turns and usage, then an
  // error_during_execution frame carrying zero of both. The conductor settles
  // the phase on the FIRST frame for exactly this reason, and a reader that
  // takes the last one records a session that cost $1.93 as free.
  const jsonl = [
    frame({
      type: 'result', subtype: 'success', structured_output: { plan: 'final' },
      num_turns: 41, total_cost_usd: 1.93,
    }),
    frame({ type: 'result', subtype: 'error_during_execution', num_turns: 0, total_cost_usd: 0 }),
  ].join('\n');

  const r = transcriptResult(jsonl);

  assert.deepEqual(r.output, { plan: 'final' });
  assert.equal(r.turns, 41);
  assert.equal(r.costUsd, 1.93);
});

test('a transcript with no result frame reports zeroes instead of throwing', () => {
  // A session killed mid-flight. The caller decides what that means; this is
  // not the place a run ends.
  const r = transcriptResult(frame({ type: 'assistant', text: 'still working' }));

  assert.equal(r.output, null);
  assert.equal(r.turns, 0);
  assert.equal(r.costUsd, 0);
});

test('an unparseable line is stepped over, not fatal', () => {
  const jsonl = [
    frame({ type: 'result', structured_output: { ok: true }, num_turns: 3 }),
    '{ truncated mid-write',
  ].join('\n');

  assert.deepEqual(transcriptResult(jsonl).output, { ok: true });
});

test('skillsInvoked lists each launched skill once, in launch order', () => {
  const jsonl = [
    frame({ commandName: 'change-scoping' }),
    frame({ commandName: 'frontend-accessibility' }),
    frame({ commandName: 'change-scoping' }),
  ].join('\n');

  assert.deepEqual(skillsInvoked(jsonl), ['change-scoping', 'frontend-accessibility']);
});

test('a session that launched nothing reports nothing, which is the interesting case', () => {
  // Configured is not loaded: this empty list beside a phase whose config names
  // five skills is the whole reason the field is recorded.
  assert.deepEqual(skillsInvoked(frame({ type: 'result', num_turns: 41 })), []);
});

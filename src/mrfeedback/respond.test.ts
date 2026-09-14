import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeRound, emptyLedger, markReplied, normaliseItems, recordAddressed, startRound } from './ledger.js';
import { executeResponses, planResponses } from './respond.js';
import { REPLY_MARKER } from './threads.js';
import type { FeedbackRound, FeedbackThread, ResolvePolicy } from './types.js';

const thread = (id: string, lastNoteId: number): FeedbackThread =>
  ({ discussionId: id, file: null, line: null, notes: [{ id: lastNoteId, author: 'hira.ijaz', body: '…' }], lastNoteId });

/** d1: one fix (addressed unless told otherwise). d2: a question. d3: triage produced nothing. */
function round(opts: { addressed?: boolean } = {}): FeedbackRound {
  const threads = [thread('d1', 1), thread('d2', 2), thread('d3', 3)];
  const items = normaliseItems({ items: [
    { discussionId: 'd1', disposition: 'fix', request: 'rename foo', plan: 'rename', reply: '' },
    { discussionId: 'd2', disposition: 'question', request: 'why', plan: '', reply: 'Because a.py:9 streams.' },
  ] }, threads);
  let l = startRound(emptyLedger(), { mrIid: 7, threads, items, now: 1 });
  if (opts.addressed !== false) l = recordAddressed(l, [{ id: 'MRF-01', note: 'renamed foo to bar' }]);
  return activeRound(l)!;
}

const plan = (policy: ResolvePolicy, r = round()) =>
  Object.fromEntries(planResponses(r, { headSha: 'abcdef1234567890', policy }).map((a) => [a.discussionId, a]));

test('every reply cites the verified head and carries the marker', () => {
  const a = plan('fixed');
  assert.match(a.d1!.body, /Addressed: renamed foo to bar/);
  assert.match(a.d1!.body, /`abcdef12`/);
  assert.ok(a.d1!.body.includes(REPLY_MARKER));
  assert.match(a.d2!.body, /Because a\.py:9 streams\./);
});

test("policy 'fixed' resolves only all-fix threads whose fixes were made", () => {
  const a = plan('fixed');
  assert.deepEqual([a.d1!.resolve, a.d1!.handled], [true, true]);
  assert.deepEqual([a.d2!.resolve, a.d2!.handled], [false, true]);
});

test("policy 'all' also resolves answered questions", () => {
  const a = plan('all');
  assert.equal(a.d1!.resolve, true);
  assert.equal(a.d2!.resolve, true);
});

test("policy 'never' replies without resolving", () => {
  const a = plan('never');
  assert.equal(a.d1!.resolve, false);
  assert.equal(a.d1!.handled, true);
});

test('a fix that was not made is never resolved and stays actionable, whatever the policy', () => {
  const a = plan('all', round({ addressed: false }));
  assert.match(a.d1!.body, /Not addressed yet: rename foo/);
  assert.deepEqual([a.d1!.resolve, a.d1!.handled], [false, false]);
});

test('a thread triage produced nothing for is replied to but left actionable', () => {
  const a = plan('all');
  assert.deepEqual([a.d3!.resolve, a.d3!.handled], [false, false]);
});

test('executeResponses skips threads already replied to and never resolves after a failed reply', async () => {
  const r0 = round();
  const r = activeRound(markReplied({ rounds: [r0], handled: {} }, 'd1'))!;
  const calls: string[] = [];
  const out = await executeResponses(r, planResponses(r, { headSha: 'abcdef12', policy: 'all' }), {
    reply: async (id) => { calls.push(`reply ${id}`); return id !== 'd2'; },
    resolve: async (id) => { calls.push(`resolve ${id}`); return true; },
  });
  assert.deepEqual(calls, ['resolve d1', 'reply d2', 'reply d3']);
  assert.deepEqual(out, { replied: ['d3'], resolved: ['d1'], failures: ['reply to d2'] });
});

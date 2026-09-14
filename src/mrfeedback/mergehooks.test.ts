import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeRound, emptyLedger, normaliseItems, recordAddressed, startRound } from './ledger.js';
import { createMergeHooks, type MergeHookDeps } from './mergehooks.js';
import type { FeedbackThread, MrFeedbackLedger } from './types.js';

const t1: FeedbackThread = { discussionId: 'd1', file: 'a.py', line: 1, notes: [{ id: 11, author: 'hira.ijaz', body: 'rename' }], lastNoteId: 11 };

function fixingLedger(mrIid = 7): MrFeedbackLedger {
  const items = normaliseItems({ items: [{ discussionId: 'd1', disposition: 'fix', request: 'rename', plan: 'p', reply: '' }] }, [t1]);
  const l = startRound(emptyLedger(), { mrIid, threads: [t1], items, now: 1 });
  return recordAddressed(l, [{ id: 'MRF-01', note: 'renamed' }]);
}

function harness(over: Partial<MergeHookDeps> = {}, initial?: MrFeedbackLedger) {
  const state = { ledger: initial, calls: [] as string[] };
  const deps: MergeHookDeps = {
    config: { enabled: true, resolve: 'fixed', maxRounds: 3, authors: ['hira.ijaz'] },
    readLedger: () => state.ledger,
    writeLedger: (l) => { state.ledger = l; },
    discussions: async () => [],
    headSha: async () => 'abcdef1234567890',
    reply: async (_mr, id) => { state.calls.push(`reply ${id}`); return true; },
    resolve: async (_mr, id) => { state.calls.push(`resolve ${id}`); return true; },
    ...over,
  };
  return { hooks: createMergeHooks(deps), state };
}

test('nothing to answer when no round is active', async () => {
  const { hooks, state } = harness();
  assert.deepEqual(await hooks.respondToActiveRound(7), { kind: 'none' });
  assert.deepEqual(state.calls, []);
});

test('a fixed round is answered, resolved, closed and watermarked', async () => {
  const { hooks, state } = harness({}, fixingLedger());
  assert.deepEqual(await hooks.respondToActiveRound(7), { kind: 'done', replied: 1, resolved: 1 });
  assert.deepEqual(state.calls, ['reply d1', 'resolve d1']);
  assert.equal(activeRound(state.ledger), null);
  assert.deepEqual(state.ledger?.handled, { d1: 11 });
});

test('a failed resolve keeps the round open, and the retry does not double-post the reply', async () => {
  let resolveWorks = false;
  const { hooks, state } = harness({ resolve: async () => resolveWorks }, fixingLedger());
  const first = await hooks.respondToActiveRound(7);
  assert.equal(first.kind, 'retry-later');
  assert.deepEqual(activeRound(state.ledger)?.replied, ['d1']);

  resolveWorks = true;
  assert.equal((await hooks.respondToActiveRound(7)).kind, 'done');
  assert.deepEqual(state.calls, ['reply d1']);
  assert.deepEqual(state.ledger?.rounds[0]?.resolved, ['d1']);
});

test('an unreadable head sha defers the answer', async () => {
  const { hooks } = harness({ headSha: async () => null }, fixingLedger());
  assert.equal((await hooks.respondToActiveRound(7)).kind, 'retry-later');
});

test('a round that belonged to a different MR is closed without posting', async () => {
  const { hooks, state } = harness({}, fixingLedger(99));
  assert.deepEqual(await hooks.respondToActiveRound(7), { kind: 'none' });
  assert.deepEqual(state.calls, []);
  assert.equal(activeRound(state.ledger), null);
  assert.deepEqual(state.ledger?.handled, {});
});

test('newFeedbackThreads applies the author list and the watermark', async () => {
  const note = (id: number, by: string) => ({ id, body: 'x', resolvable: true, resolved: false, author: { username: by } });
  const { hooks } = harness({
    discussions: async () => [
      { id: 'd1', notes: [note(11, 'hira.ijaz')] },
      { id: 'd2', notes: [note(12, 'hira.ijaz')] },
      { id: 'd3', notes: [note(13, 'stranger')] },
    ],
  }, { rounds: [], handled: { d1: 11 } });
  assert.deepEqual((await hooks.newFeedbackThreads(7)).map((t) => t.discussionId), ['d2']);
});

test('newFeedbackThreads is empty when discussions cannot be read', async () => {
  const { hooks } = harness({ discussions: async () => null });
  assert.deepEqual(await hooks.newFeedbackThreads(7), []);
});

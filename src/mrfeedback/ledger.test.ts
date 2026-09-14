import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeRound, addressedFeedbackOf, completeRound, emptyLedger, markReplied, markResolved,
  normaliseItems, phasesOwedByRound, recordAddressed, roundsUsed, startRound,
} from './ledger.js';
import type { FeedbackThread } from './types.js';

const t1: FeedbackThread = { discussionId: 'd1', file: 'a.py', line: 3, notes: [{ id: 7, author: 'hira.ijaz', body: 'rename' }], lastNoteId: 7 };
const t2: FeedbackThread = { discussionId: 'd2', file: null, line: null, notes: [{ id: 9, author: 'hira.ijaz', body: 'why?' }], lastNoteId: 9 };

const triage = {
  items: [
    { id: 'x', discussionId: 'd1', disposition: 'fix', request: 'rename foo', plan: 'rename foo to bar in a.py', reply: '' },
    { id: 'y', discussionId: 'd2', disposition: 'question', request: 'why a loop', plan: '', reply: 'Because a.py:9 streams.' },
    { id: 'z', discussionId: 'unknown', disposition: 'fix', request: 'x', plan: 'x', reply: '' },
    { id: 'w', discussionId: 'd1', disposition: 'rewrite-everything', request: '', plan: '', reply: '' },
  ],
};

test('normaliseItems keeps valid items for known threads and renumbers them', () => {
  const items = normaliseItems(triage, [t1, t2]);
  assert.deepEqual(items.map((i) => [i.id, i.discussionId, i.disposition]), [
    ['MRF-01', 'd1', 'fix'], ['MRF-02', 'd2', 'question'],
  ]);
  assert.deepEqual(normaliseItems(null, [t1]), []);
});

test('a round with a fix starts in fixing; one without starts in replying', () => {
  const items = normaliseItems(triage, [t1, t2]);
  const fixing = startRound(emptyLedger(), { mrIid: 4, threads: [t1, t2], items, now: 100 });
  assert.equal(activeRound(fixing)?.status, 'fixing');
  assert.equal(activeRound(fixing)?.n, 1);
  assert.equal(roundsUsed(fixing), 1);

  const replyOnly = startRound(emptyLedger(), { mrIid: 4, threads: [t2], items: items.slice(1), now: 100 });
  assert.equal(activeRound(replyOnly)?.status, 'replying');
});

test('only one round may be active', () => {
  const l = startRound(emptyLedger(), { mrIid: 4, threads: [t1], items: normaliseItems(triage, [t1]), now: 1 });
  assert.throws(() => startRound(l, { mrIid: 4, threads: [t1], items: [], now: 2 }), /already in progress/);
});

test('addressed fixes accumulate across implement laps; unknown and non-fix ids are ignored', () => {
  let l = startRound(emptyLedger(), { mrIid: 4, threads: [t1, t2], items: normaliseItems(triage, [t1, t2]), now: 1 });
  l = recordAddressed(l, addressedFeedbackOf({ addressedFeedback: [{ id: 'MRF-01', note: 'renamed' }, { id: 'MRF-02', note: 'n/a' }] }));
  l = recordAddressed(l, addressedFeedbackOf({ addressedFeedback: [{ id: 'MRF-01', note: 'renamed foo to bar' }, { id: 'MRF-99', note: '?' }] }));
  assert.deepEqual(activeRound(l)?.addressed, [{ id: 'MRF-01', note: 'renamed foo to bar' }]);
  assert.deepEqual(addressedFeedbackOf({}), []);
});

test('replied/resolved marks are idempotent and completing a round advances watermarks', () => {
  let l = startRound(emptyLedger(), { mrIid: 4, threads: [t1, t2], items: normaliseItems(triage, [t1, t2]), now: 1 });
  l = markReplied(markReplied(l, 'd1'), 'd1');
  l = markResolved(l, 'd1');
  assert.deepEqual(activeRound(l)?.replied, ['d1']);
  assert.deepEqual(activeRound(l)?.resolved, ['d1']);

  const done = completeRound({ ...l, handled: { d1: 3 } }, [{ discussionId: 'd1', lastNoteId: 7 }]);
  assert.equal(activeRound(done), null);
  assert.equal(done.rounds[0]?.status, 'done');
  assert.deepEqual(done.handled, { d1: 7 });
});

const FIX_WINDOW = ['implement', 'review', 'verify', 'ui-evidence', 'mr'];

test('phasesOwedByRound is empty with no ledger, or a round that is not fixing', () => {
  assert.deepEqual(phasesOwedByRound(undefined, [], FIX_WINDOW), []);
  const replyOnly = startRound(emptyLedger(), { mrIid: 4, threads: [t2], items: normaliseItems(triage, [t2]), now: 500 });
  assert.deepEqual(phasesOwedByRound(replyOnly, [], FIX_WINDOW), []);
});

test('a stale implement success (before the round started) owes the whole window', () => {
  const l = startRound(emptyLedger(), { mrIid: 4, threads: [t1], items: normaliseItems(triage, [t1]), now: 500 });
  assert.deepEqual(
    phasesOwedByRound(l, [{ phase: 'implement', status: 'ok', startedAt: 100 }], FIX_WINDOW),
    FIX_WINDOW,
  );
});

test('an implement success since the round started still owes every later phase', () => {
  const l = startRound(emptyLedger(), { mrIid: 4, threads: [t1], items: normaliseItems(triage, [t1]), now: 500 });
  assert.deepEqual(
    phasesOwedByRound(l, [{ phase: 'implement', status: 'ok', startedAt: 600 }], FIX_WINDOW),
    ['review', 'verify', 'ui-evidence', 'mr'],
  );
});

test('a warned record since the round started counts as done; a failed one does not', () => {
  const l = startRound(emptyLedger(), { mrIid: 4, threads: [t1], items: normaliseItems(triage, [t1]), now: 500 });
  const records = [
    { phase: 'implement', status: 'ok', startedAt: 600 },
    { phase: 'review', status: 'warned', startedAt: 700 },
    { phase: 'verify', status: 'failed', startedAt: 700 },
  ];
  assert.deepEqual(phasesOwedByRound(l, records, FIX_WINDOW), ['verify', 'ui-evidence', 'mr']);
});

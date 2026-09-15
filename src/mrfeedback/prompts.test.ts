import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyLedger, normaliseItems, recordAddressed, startRound } from './ledger.js';
import { implementFeedbackBlock, reviewFeedbackBlock, triagePrompt } from './prompts.js';
import type { FeedbackThread } from './types.js';

const t1: FeedbackThread = { discussionId: 'abc123', file: 'apps/x.py', line: 12, notes: [{ id: 1, author: 'hira.ijaz', body: 'rename ```foo``` please' }], lastNoteId: 1 };
const t2: FeedbackThread = { discussionId: 'def456', file: null, line: null, notes: [{ id: 2, author: 'arsal.tariq', body: 'why?' }], lastNoteId: 2 };
const items = normaliseItems({ items: [
  { discussionId: 'abc123', disposition: 'fix', request: 'rename foo', plan: 'rename foo to bar', reply: '' },
  { discussionId: 'def456', disposition: 'question', request: 'why', plan: '', reply: 'because' },
] }, [t1, t2]);

test('triage prompt names every discussion and cannot be broken out of its fences', () => {
  const p = triagePrompt({ ticketHead: '## Ticket #5', criteria: '  - works', changeSummary: 'commits: a1', mrIid: 9, branch: 'oneshot/ticket-5-x', base: 'dev', threads: [t1, t2] });
  assert.match(p, /discussion abc123 — apps\/x\.py:12/);
  assert.match(p, /discussion def456 — general comment on the MR/);
  assert.ok(!p.includes('```foo```'));
  assert.match(p, /git diff origin\/dev\.\.\.HEAD/);
});

test('implement and review blocks are empty unless a round is fixing', () => {
  assert.equal(implementFeedbackBlock(undefined), '');
  const replying = startRound(emptyLedger(), { mrIid: 9, threads: [t2], items: items.slice(1), now: 1 });
  assert.equal(implementFeedbackBlock(replying), '');
  assert.equal(reviewFeedbackBlock(replying, []), '');
});

test('implement block lists only fixes, with location, and what earlier laps already fixed', () => {
  let l = startRound(emptyLedger(), { mrIid: 9, threads: [t1, t2], items, now: 1 });
  const first = implementFeedbackBlock(l);
  assert.match(first, /MRF-01 apps\/x\.py:12/);
  assert.match(first, /change: rename foo to bar/);
  assert.ok(!first.includes('MRF-02'));
  l = recordAddressed(l, [{ id: 'MRF-01', note: 'done' }]);
  assert.match(implementFeedbackBlock(l), /Already fixed on an earlier lap of this round: MRF-01/);
});

test('review block marks each fix as claimed or not', () => {
  const l = startRound(emptyLedger(), { mrIid: 9, threads: [t1, t2], items, now: 1 });
  assert.match(reviewFeedbackBlock(l, []), /MRF-01 \[NOT claimed\]/);
  assert.match(reviewFeedbackBlock(l, [{ id: 'MRF-01', note: 'x' }]), /MRF-01 \[claimed fixed\]/);
});

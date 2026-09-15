import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderCandidates } from './watcher.js';
import type { Issue } from '../lib/gitlab.js';

function issue(iid: number): Issue {
  return {
    iid,
    title: `#${iid}`,
    description: null,
    labels: ['Loop'],
    assignees: [{ username: 'hassam.azam' }],
    state: 'opened',
    web_url: `https://example/${iid}`,
    updated_at: '2026-09-15T00:00:00.000Z',
  };
}

const iids = (list: Issue[]): number[] => list.map((i) => i.iid);

test('a parked head ticket no longer starves fresh work behind it', () => {
  const candidates = [issue(87), issue(235), issue(237)];
  const status = (iid: number): string | null =>
    ({ 87: 'parked', 237: 'blocked' } as Record<number, string>)[iid] ?? null;

  assert.deepEqual(iids(orderCandidates(candidates, status)), [235, 87, 237]);
});

test('order is preserved within the ready and stalled halves', () => {
  const candidates = [issue(10), issue(11), issue(12), issue(13)];
  const status = (iid: number): string | null =>
    ({ 10: 'parked', 12: 'blocked' } as Record<number, string>)[iid] ?? null;

  assert.deepEqual(iids(orderCandidates(candidates, status)), [11, 13, 10, 12]);
});

test('all-ready and all-stalled lists are returned unchanged', () => {
  const ready = [issue(1), issue(2)];
  assert.deepEqual(iids(orderCandidates(ready, () => null)), [1, 2]);

  const stalled = [issue(3), issue(4)];
  assert.deepEqual(iids(orderCandidates(stalled, () => 'parked')), [3, 4]);
});

test('resumable in-progress work counts as ready, not stalled', () => {
  const candidates = [issue(50), issue(51)];
  const status = (iid: number): string | null =>
    ({ 50: 'parked', 51: 'aborted' } as Record<number, string>)[iid] ?? null;

  assert.deepEqual(iids(orderCandidates(candidates, status)), [51, 50]);
});

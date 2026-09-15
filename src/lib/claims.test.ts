import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeClaims, claimNoteBody, stoppedRuns } from './claims.js';
import type { IssueNote } from './gitlab.js';

const NOW = Date.parse('2026-09-15T12:00:00Z');
const at = (min: number): string => new Date(NOW - min * 60_000).toISOString();

const claim = (id: number, runId: string, min: number): IssueNote =>
  ({ id, body: claimNoteBody(runId, 'op'), author: { username: 'op' }, created_at: at(min) });
const stop = (id: number, runId: string, min: number): IssueNote =>
  ({ id, body: `Oneshot stopped: **worktree: git fetch failed**\n\nRun \`${runId}\`.`, created_at: at(min) });

test('a claim with no stop note is live', () => {
  assert.deepEqual(activeClaims([claim(1, 'r-a', 10)], NOW).map((c) => c.noteId), [1]);
});

test('a stop note after the claim ends it', () => {
  assert.deepEqual(activeClaims([claim(1, 'r-a', 10), stop(2, 'r-a', 5)], NOW), []);
});

// Ticket #168: blocked once, resumed under the same run id, then parked. The old
// stop note killed every later claim too, so each re-entry posted another one.
test('a stop note does not end a claim the same run posted after it', () => {
  const notes = [claim(1, 'r-a', 60), stop(2, 'r-a', 55), claim(3, 'r-a', 50)];
  assert.deepEqual(activeClaims(notes, NOW).map((c) => c.noteId), [3]);
});

test('a resumed run that is blocked again is stopped again', () => {
  const notes = [claim(1, 'r-a', 60), stop(2, 'r-a', 55), claim(3, 'r-a', 50), stop(4, 'r-a', 40)];
  assert.deepEqual(activeClaims(notes, NOW), []);
});

test("one run's stop note leaves another run's claim alone", () => {
  const notes = [claim(1, 'r-a', 60), claim(2, 'r-b', 59), stop(3, 'r-a', 30)];
  assert.deepEqual(activeClaims(notes, NOW).map((c) => c.runId), ['r-b']);
});

test('stoppedRuns records the latest stop note per run', () => {
  const notes = [stop(2, 'r-a', 55), stop(4, 'r-a', 40), stop(5, 'r-b', 30)];
  assert.deepEqual([...stoppedRuns(notes)], [['r-a', 4], ['r-b', 5]]);
});

test('a claim past the stale bound is not live', () => {
  assert.deepEqual(activeClaims([claim(1, 'r-a', 25 * 60)], NOW), []);
});

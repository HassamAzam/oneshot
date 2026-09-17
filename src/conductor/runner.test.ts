import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codePhaseStatus, mergePollWait, nextIndex } from './runner.js';
import { MERGE_POLL_MS, type PhaseConfig } from '../lib/config.js';

function phase(name: string, n: number, group?: string): PhaseConfig {
  return { name, n, kind: 'session', timeoutMin: 30, onFail: 'abort', ...(group ? { group } : {}) };
}

/** config/phases.json, trimmed to the names the index arithmetic moves between. */
const LIST: PhaseConfig[] = [
  phase('research', 1),
  phase('plan', 2),
  phase('implement', 3),
  phase('testcases', 4, 'check'),
  phase('review', 5, 'check'),
  phase('verify', 6),
];
const at = (name: string): number => LIST.findIndex((p) => p.name === name);

/**
 * runner.ts's shouldSkip(), which is what decides whether a phase the index
 * lands on is actually RUN. Asserting on this rather than on the `forced` set
 * is the point: the defect below was invisible from the set alone.
 */
const skips = (forced: Set<string>, succeeded: string[], name: string): boolean =>
  !forced.has(name) && succeeded.includes(name);

test('a retry re-runs a phase that already succeeded on an earlier lap', () => {
  const forced = new Set<string>();
  // #168: plan passed, the run cycled back, and the re-plan against reviewer
  // feedback died of infra. afterFailure() returns a retry at plan's index —
  // which reached a phase with a succeeded record on it.
  const i = nextIndex({ kind: 'retry', at: at('plan') }, at('plan'), at('plan'), LIST, forced);

  assert.equal(i, at('plan'));
  assert.equal(skips(forced, ['research', 'plan'], 'plan'), false,
    'the retried phase was skipped as already-done — this is the #168 defect');
});

test('a retry forces only the retried phase, so a grouped retry runs solo', () => {
  // testcases and review share group "check". The group is rebuilt on the
  // retry pass and breaks on the first member shouldSkip() answers true for,
  // so a still-succeeded testcases collapses the group to review alone.
  const forced = new Set<string>();
  nextIndex({ kind: 'retry', at: at('review') }, at('review'), at('review'), LIST, forced);

  assert.deepEqual([...forced], ['review']);
  assert.equal(skips(forced, ['testcases', 'review'], 'testcases'), true);
});

test('a cycle forces its whole window and leaves the pinned case list alone', () => {
  const forced = new Set<string>();
  const i = nextIndex(
    { kind: 'cycle', jumpTo: at('implement'), windowEnd: at('verify') },
    at('verify'), at('verify'), LIST, forced,
  );

  assert.equal(i, at('implement'));
  assert.deepEqual([...forced].sort(), ['implement', 'review', 'verify']);
  assert.equal(skips(forced, ['implement', 'testcases', 'review'], 'testcases'), true);
});

test('an advance steps past the last member of a group, not past the current index', () => {
  const forced = new Set<string>();
  // testcases+review dispatched together: the loop is at testcases, the group
  // ends at review, and the next phase to run is verify.
  assert.equal(
    nextIndex({ kind: 'advance' }, at('testcases'), at('review'), LIST, forced),
    at('verify'),
  );
  assert.deepEqual([...forced], []);
});

// ------------------------------------------------ merge parked on a human merge

const MERGE: PhaseConfig = { name: 'merge', n: 9, kind: 'code', timeoutMin: 10, onFail: 'blocked' };

test('a merge waiting on a human is recorded parked, not failed', () => {
  assert.equal(codePhaseStatus(MERGE, { ok: false, park: true }), 'parked');
});

test('a genuine merge refusal is still recorded failed, and a merge ok', () => {
  assert.equal(codePhaseStatus(MERGE, { ok: false }), 'failed');
  assert.equal(codePhaseStatus(MERGE, { ok: true }), 'ok');
  // A success wins over a stray park flag.
  assert.equal(codePhaseStatus(MERGE, { ok: true, park: true }), 'ok');
});

const T0 = 1_800_000_000_000;
const poll = (o: Partial<Parameters<typeof mergePollWait>[0]> = {}): number | null => mergePollWait({
  wasParked: true, reviewMode: true, dryRun: false,
  lastCheckAt: T0, mergeSucceeded: false, now: T0 + 3 * 60_000, ...o,
});

test('a merge-parked run inside its poll window is held until the window is up', () => {
  assert.equal(poll(), MERGE_POLL_MS - 3 * 60_000);
});

test('the hold is keyed on the CLAIMED status, so a resumed parked run is held', () => {
  // The defect: the gate read the journal after the resume had set it to
  // 'running', so wasParked was effectively always false and every tick
  // walked to merge. Only the claimed status can hold the run.
  assert.equal(poll({ wasParked: false }), null);
  assert.notEqual(poll({ wasParked: true }), null);
});

test('the run goes through once the poll window is due', () => {
  assert.equal(poll({ now: T0 + MERGE_POLL_MS }), null);
  assert.equal(poll({ now: T0 + MERGE_POLL_MS + 1 }), null);
});

test('nothing holds a run that is not waiting on a human merge', () => {
  assert.equal(poll({ reviewMode: false }), null, 'Review label removed: release at once');
  assert.equal(poll({ dryRun: true }), null);
  assert.equal(poll({ mergeSucceeded: true }), null, 'a later park must not wait behind a finished merge');
  assert.equal(poll({ lastCheckAt: undefined }), null, 'never asked GitLab yet: ask now');
});

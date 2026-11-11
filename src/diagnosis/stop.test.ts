import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../lib/test-project-env.js';
import {
  decideDiagnosis, isLimitStop, journalTrouble, mayPostOn, reasonForKey, standing, stopKey, type DiagnosisConfig,
} from './stop.js';
import type { PhaseRecord } from '../lib/artifacts.js';
import type { DiagnosisFile, StopDiagnosis } from './types.js';

const rec = (phase: string, status: PhaseRecord['status'] = 'ok', error?: string): PhaseRecord => ({
  phase, lap: 0, status, startedAt: 0, endedAt: 1, ...(error ? { error } : {}),
});
const isCode = (p: string): boolean => p === 'mr-open' || p === 'merge';

const CFG: DiagnosisConfig = {
  enabled: true, post: true, fix: false, maxPerRun: 4, maxAttempts: 2,
  minGapMs: 20 * 60_000, settleMs: 20_000, maxAgeMs: 7 * 86_400_000, retryGapMs: 10 * 60_000,
};
const NOW = 1_800_000_000_000;

const stop = (over: Partial<StopDiagnosis>): StopDiagnosis => ({
  key: 'k', runId: 'r-1', iid: 1, status: 'blocked', stoppedPhase: 'merge', reason: '', trouble: [],
  state: 'diagnosed', attempts: 1, lastAttemptAt: NOW - 3_600_000, diagnosedAt: NOW - 3_600_000, ...over,
});
const fileOf = (...stops: StopDiagnosis[]): DiagnosisFile => ({
  version: 1, iid: 1, runId: 'r-1', latest: stops[0]?.key ?? null, sessions: stops.reduce((n, s) => n + s.attempts, 0),
  stops: Object.fromEntries(stops.map((s) => [s.key, s])),
});
const decide = (over: Partial<Parameters<typeof decideDiagnosis>[0]> = {}) => decideDiagnosis({
  status: 'blocked', key: 'k', trouble: ['failed:verify'], stoppedAt: NOW - 60_000, now: NOW, file: null, cfg: CFG, ...over,
});

// ------------------------------------------------------------------- trouble

test('trouble is a set of kinds, so the same failure happening again changes nothing', () => {
  const once = journalTrouble({ phases: [rec('verify', 'failed', 'x')] }, isCode);
  const sixTimes = journalTrouble({ phases: [rec('verify', 'failed', 'x'), rec('verify', 'failed', 'x'), rec('verify', 'failed', 'y')] }, isCode);
  assert.deepEqual(once, ['failed:verify']);
  assert.deepEqual(sixTimes, once);
});

test('a clean run has no trouble, and neither does one the conductor restarted once', () => {
  assert.deepEqual(journalTrouble({ phases: [rec('recall'), rec('research'), rec('plan')] }, isCode), []);
  assert.deepEqual(journalTrouble({ phases: [rec('plan', 'infra', 'cancelled by the conductor'), rec('plan')] }, isCode), []);
});

test('a phase is judged by the last time it ran: a review that asked for changes and then passed leaves nothing', () => {
  // The pipeline working as designed. With reviewAllRuns every run then parks
  // for a person's merge, and this must not be a session on each of them.
  const cycled = [rec('implement'), rec('review', 'failed', 'changes requested'), rec('implement'), rec('review')];
  assert.deepEqual(journalTrouble({ phases: cycled }, isCode), []);
  assert.deepEqual(journalTrouble({ phases: [rec('verify', 'infra', 'timed out after 150m'), rec('verify')] }, isCode), []);
  assert.deepEqual(journalTrouble({ phases: [rec('implement', 'failed', 'x'), rec('implement')] }, isCode), []);
});

test('what no later lap put right is still trouble', () => {
  const j = { phases: [rec('review', 'failed', 'x'), rec('review', 'warned', 'still outstanding'), rec('verify'), rec('ui-evidence', 'warned', 'x'), rec('mr')] };
  assert.deepEqual(journalTrouble(j, isCode), ['warned:review', 'warned:ui-evidence']);
  assert.deepEqual(journalTrouble({ phases: [rec('merge', 'refused', 'x')] }, isCode), ['refused:merge']);
});

test('two restarts of one phase, or any other infra death left standing, do count', () => {
  const cancelled = rec('plan', 'infra', 'cancelled by the conductor');
  assert.deepEqual(journalTrouble({ phases: [cancelled, cancelled] }, isCode), ['infra:plan']);
  assert.deepEqual(journalTrouble({ phases: [rec('verify', 'infra', 'timed out after 150m')] }, isCode), ['infra:verify']);
});

test('a code phase re-run five times is trouble though every lap said ok; a session phase needs six', () => {
  const laps = (phase: string, n: number): PhaseRecord[] => Array.from({ length: n }, () => rec(phase));
  assert.deepEqual(journalTrouble({ phases: laps('mr-open', 4) }, isCode), []);
  assert.deepEqual(journalTrouble({ phases: laps('mr-open', 5) }, isCode), ['repeated:mr-open']);
  assert.deepEqual(journalTrouble({ phases: laps('testcases', 5) }, isCode), []);
  assert.deepEqual(journalTrouble({ phases: laps('testcases', 6) }, isCode), ['repeated:testcases']);
});

test('a merge request waiting hours for a person is not a phase repeating', () => {
  // `merge` writes one `parked` record per poll, every half hour, for as long as
  // nobody has merged. Counted as runs, a clean run was diagnosed at the fifth.
  const polls = (n: number): PhaseRecord[] => Array.from({ length: n }, () => rec('merge', 'parked', 'awaiting a human merge'));
  assert.deepEqual(journalTrouble({ phases: [rec('mr'), ...polls(5)] }, isCode), []);
  assert.deepEqual(journalTrouble({ phases: [rec('mr'), ...polls(40)] }, isCode), []);
  assert.deepEqual(journalTrouble({ phases: Array.from({ length: 9 }, () => rec('design', 'skipped')) }, isCode), []);
  // A poll after a failure does not hide the failure.
  assert.deepEqual(journalTrouble({ phases: [rec('verify', 'failed', 'x'), rec('merge', 'parked')] }, isCode), ['failed:verify']);
});

test('a remediation is trouble, and a second one is new trouble', () => {
  const healed = { phase: 'merge', reason: 'r', category: 'code', fixed: false, changes: [], at: 1 };
  assert.deepEqual(journalTrouble({ phases: [], remediations: [healed] }), ['remediated:1']);
  assert.deepEqual(journalTrouble({ phases: [], remediations: [healed, healed] }), ['remediated:2']);
});

test('this feature\'s own sessions are never trouble', () => {
  assert.deepEqual(journalTrouble({ phases: [rec('diagnose', 'failed', 'x'), rec('fix-author', 'warned')] }, isCode), []);
});

// ----------------------------------------------------------------------- key

test('a parked run that gains a record every tick keeps one key', () => {
  // Before the runner learned to step over a settled code phase, a parked run
  // added an mr-open record a minute. Its stop must not look new each time.
  const base = [rec('implement'), rec('verify', 'failed', 'TC-21')];
  const key = (extra: number): string => stopKey({
    runId: 'r-1', status: 'parked', reason: 'awaiting test-case approval',
    trouble: journalTrouble({ phases: [...base, ...Array.from({ length: extra }, () => rec('verify', 'failed', 'TC-21'))] }, isCode),
  });
  assert.equal(key(0), key(1));
  assert.equal(key(1), key(3));
});

test('the key changes with the reason, the status, the run and a new kind of trouble', () => {
  const k = (o: Partial<Parameters<typeof stopKey>[0]>): string => stopKey({ runId: 'r-1', status: 'blocked', reason: 'merge refused', trouble: ['failed:merge'], ...o });
  const base = k({});
  assert.match(base, /^[0-9a-f]{12}$/);
  assert.notEqual(k({ reason: 'merge refused: F-07' }), base);
  assert.notEqual(k({ status: 'parked' }), base);
  assert.notEqual(k({ runId: 'r-2' }), base);
  assert.notEqual(k({ trouble: ['failed:merge', 'failed:verify'] }), base);
  assert.notEqual(k({ phase: 'verify' }), base, 'the same words at another phase are another stop');
  assert.equal(k({ reason: '  merge   refused\n' }), base, 'whitespace is not a different reason');
  assert.equal(k({ trouble: ['failed:merge'] }), base);
});

test('the same stop worded differently a minute later keeps its key', () => {
  const k = (reason: string): string => stopKey({ runId: 'r-1', status: 'blocked', phase: 'merge', reason, trouble: [] });
  // What self-remediation appends is its own account, and it differs the second time the block comes back.
  assert.equal(
    k('merge: refused over F-05 [major]\n\nSelf-remediation looked: the findings are in the change itself.'),
    k('merge: refused over F-05 [major]\n\nSelf-remediation already fixed something for this exact block and it came back.'),
  );
  // Counts and durations move while nothing happens.
  assert.equal(k('!11307 is not merged yet. Next check in 27m.'), k('!11307 is not merged yet. Next check in 3m.'));
  assert.equal(k('timed out after 150m while still working (74 stream messages)'), k('timed out after 150m while still working (1128 stream messages)'));
  // A number that is part of a name is the stop's identity.
  assert.notEqual(k('merge: refused over F-05 [major]'), k('merge: refused over F-07 [major]'));
  assert.notEqual(k('verify recorded a failing case: TC-21'), k('verify recorded a failing case: TC-04'));
  assert.equal(reasonForKey('2 blocker/major finding(s): F-05, TC-21, !11307, #9174 after 150m'), '0 blocker/major finding(s): F-05, TC-21, !11307, #9174 after 0m');
});

// ------------------------------------------------------------------ decision

test('a blocked stop that has stood a moment is diagnosed, at the next free lap', () => {
  assert.deepEqual(decide(), { act: 'diagnose', lap: 0 });
  assert.deepEqual(decide({ key: 'new', file: fileOf(stop({ key: 'old', attempts: 2 })) }), { act: 'diagnose', lap: 2 });
});

test('a run that is not stopped is left alone', () => {
  for (const status of ['running', 'done', 'aborted']) assert.equal(decide({ status }).act, 'skip', status);
});

test('a routine park, with nothing failed on the way, is not diagnosed; a troubled one is', () => {
  const clean = decide({ status: 'parked', trouble: [] });
  assert.equal(clean.act, 'skip');
  assert.match((clean as { why: string }).why, /routine wait/);
  assert.equal(decide({ status: 'parked', trouble: [], force: true }).act, 'skip', 'and asking does not make a clean wait a failure');
  assert.equal(decide({ status: 'parked', trouble: ['failed:verify'] }).act, 'diagnose');
  assert.equal(decide({ status: 'blocked', trouble: [] }).act, 'diagnose', 'a block is always a request for a person');
});

test('a stop already diagnosed is never diagnosed again, forced or not', () => {
  for (const state of ['diagnosed', 'superseded'] as const) {
    const file = fileOf(stop({ state }));
    assert.equal(decide({ file }).act, 'skip');
    assert.equal(decide({ file, force: true }).act, 'skip');
  }
});

test('a stop whose session failed is retried after a wait, and given up on after two', () => {
  const failedOnce = fileOf(stop({ state: 'failed', attempts: 1, lastAttemptAt: NOW - 60_000, diagnosedAt: undefined }));
  assert.match((decide({ file: failedOnce }) as { why: string }).why, /retrying later/);
  failedOnce.stops.k!.lastAttemptAt = NOW - 11 * 60_000;
  assert.deepEqual(decide({ file: failedOnce }), { act: 'diagnose', lap: 1 });
  const failedTwice = fileOf(stop({ state: 'failed', attempts: 2, lastError: 'error_max_turns', diagnosedAt: undefined }));
  assert.match((decide({ file: failedTwice, force: true }) as { why: string }).why, /gave up on this stop after 2 sessions: error_max_turns/);
});

test('a run is diagnosed a few times at most, and never twice in quick succession', () => {
  const four = fileOf(...['a', 'b', 'c', 'd'].map((key) => stop({ key })));
  assert.match((decide({ key: 'e', file: four }) as { why: string }).why, /has had its 4 diagnoses/);
  const justNow = fileOf(stop({ key: 'a', diagnosedAt: NOW - 5 * 60_000 }));
  assert.match((decide({ key: 'b', file: justNow }) as { why: string }).why, /diagnosed minutes ago/);
  assert.equal(decide({ key: 'b', file: justNow, force: true }).act, 'diagnose', 'a person asking skips the wait');
});

test('a failed session does not use up one of the run\'s diagnoses', () => {
  const file = fileOf(stop({ key: 'a', state: 'failed', attempts: 2, diagnosedAt: undefined }), ...['b', 'c', 'd'].map((key) => stop({ key })));
  assert.equal(decide({ key: 'e', file }).act, 'diagnose');
});

test('a journal that does not say when it stopped is left alone unless a person asks', () => {
  assert.match((decide({ stoppedAt: 0 }) as { why: string }).why, /does not say when the run stopped/);
  assert.equal(decide({ stoppedAt: 0, force: true }).act, 'diagnose');
});

test('a stop still being written waits, and one a week old is history unless a person asks', () => {
  assert.match((decide({ stoppedAt: NOW - 5_000 }) as { why: string }).why, /still being written/);
  const old = { stoppedAt: NOW - 9 * 86_400_000 };
  assert.match((decide(old) as { why: string }).why, /9 days old/);
  assert.equal(decide({ ...old, force: true }).act, 'diagnose');
});

test('a stop that is the usage limit or a budget ceiling explains itself and is never diagnosed', () => {
  for (const reason of [
    'subscription usage limit — parked until the window resets',
    'quota: parked after a subscription usage limit',
    'quota: per-ticket ceiling reached',
    "quota: phase 'verify' ceiling reached on attempt 3\n\nSelf-remediation was not attempted.",
  ]) {
    assert.equal(isLimitStop(reason), true, reason);
    assert.match((decide({ reason }) as { why: string }).why, /usage or budget limit/);
    assert.equal(decide({ reason, force: true }).act, 'diagnose', 'a person may still ask');
  }
  assert.equal(isLimitStop('verify: the page said "usage limit reached" in a toast'), false, 'only a reason that IS the limit');
  assert.equal(decide({ reason: 'merge: refused' }).act, 'diagnose');
});

test('a wait is not diagnosed again for trouble an earlier diagnosis of the run already covered', () => {
  // One unresolved warning, then the test-case gate, the merge wait and the same wait worded anew:
  // one diagnosis, not four.
  const first = fileOf(stop({ key: 'gate-1', status: 'parked', trouble: ['warned:ui-evidence'] }));
  const later = decide({ status: 'parked', key: 'gate-2', trouble: ['warned:ui-evidence'], file: first });
  assert.match((later as { why: string }).why, /nothing wrong behind it that an earlier diagnosis/);
  assert.equal(decide({ status: 'parked', key: 'gate-2', trouble: ['warned:ui-evidence', 'failed:verify'], file: first }).act, 'diagnose', 'new trouble is new');
  assert.equal(decide({ status: 'blocked', key: 'block-1', trouble: ['warned:ui-evidence'], file: first }).act, 'diagnose', 'a block is always new');
  assert.equal(decide({ status: 'parked', key: 'gate-2', trouble: ['warned:ui-evidence'], file: first, force: true }).act, 'diagnose');
  const lost = fileOf(stop({ key: 'gate-1', status: 'parked', trouble: ['warned:ui-evidence'], state: 'superseded' }));
  assert.equal(decide({ status: 'parked', key: 'gate-2', trouble: ['warned:ui-evidence'], file: lost }).act, 'diagnose', 'a diagnosis nobody saw covers nothing');
});

test('no run starts more sessions than its diagnoses and their retries allow, however they ended', () => {
  // Failed stops are in no other count: twelve stops that each failed once were twelve sessions.
  const failing = fileOf(...Array.from({ length: 8 }, (_, i) => stop({ key: `f${i}`, state: 'failed', attempts: 1, diagnosedAt: undefined })));
  assert.equal(failing.sessions, 8);
  assert.match((decide({ key: 'next', file: failing }) as { why: string }).why, /has had its 8 diagnosis sessions/);
  assert.equal(decide({ key: 'next', file: failing, force: true }).act, 'diagnose');
});

// ------------------------------------------------------------ after the fact

test('a diagnosis is posted only while the run is at the stop it was made for', () => {
  assert.equal(standing({ keyThen: 'k', statusNow: 'blocked', keyNow: 'k' }), 'stands');
  assert.equal(standing({ keyThen: 'k', statusNow: 'parked', keyNow: 'k' }), 'stands');
  assert.equal(standing({ keyThen: 'k', statusNow: 'blocked', keyNow: 'other' }), 'superseded', 'it stopped again, differently');
  assert.equal(standing({ keyThen: 'k', statusNow: 'done', keyNow: 'k' }), 'superseded');
});

test('a run that reads running is not written off: it is a resume, or only the tick that re-parks it', () => {
  // A parked run's journal says `running`, with no reason, for the seconds of
  // every tick between being re-claimed and being put back.
  assert.equal(standing({ keyThen: 'k', statusNow: 'running', keyNow: 'whatever' }), 'owed');
});

test('a note goes only where this desk would be allowed to run', () => {
  assert.deepEqual(mayPostOn({ assignees: [] }, 'bot'), { ok: true });
  assert.deepEqual(mayPostOn({ assignees: [{ username: 'bot' }] }, 'bot'), { ok: true });
  const theirs = mayPostOn({ assignees: [{ username: 'teammate' }] }, 'bot');
  assert.equal(theirs.ok, false);
  assert.match((theirs as { why: string }).why, /assigned to teammate, not to bot/);
  assert.equal(mayPostOn({ assignees: [{ username: 'teammate' }] }, '').ok, false, 'no identity, no write on an assigned ticket');
});

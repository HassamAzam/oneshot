import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boardStatus, compact, dayKey, dayKeys, dur, inWindow, issueUrl, mergeRequestUrl, nextWindowChange, parseWindow, percentile,
  phaseStats, rollupPhases, sinceFor, stopPhase,
  type PhaseRow, type StatusInputs,
} from './fleetview.js';

const at = (h: number, m = 0): Date => new Date(2026, 10, 10, h, m);

test('parseWindow reads hours, clock times and always, and refuses the rest', () => {
  assert.deepEqual(parseWindow('10-22'), { from: 600, to: 1320 });
  assert.deepEqual(parseWindow(' 22-6 '), { from: 1320, to: 360 });
  assert.deepEqual(parseWindow('01:10-00:50'), { from: 70, to: 50 });
  assert.deepEqual(parseWindow('10:00-22'), { from: 600, to: 1320 });
  assert.equal(parseWindow('always'), 'always');
  assert.equal(parseWindow('25-3'), null);
  assert.equal(parseWindow('01:60-02:00'), null);
  assert.equal(parseWindow('1-2-3'), null);
  assert.equal(parseWindow(''), null);
});

test('inWindow matches window.sh: from inclusive, to exclusive, wrapping past midnight', () => {
  const day = { from: 600, to: 1320 };
  assert.equal(inWindow(day, at(9, 59)), false);
  assert.equal(inWindow(day, at(10)), true);
  assert.equal(inWindow(day, at(21, 59)), true);
  assert.equal(inWindow(day, at(22)), false);
  const night = { from: 1320, to: 360 };
  assert.equal(inWindow(night, at(23)), true);
  assert.equal(inWindow(night, at(5)), true);
  assert.equal(inWindow(night, at(12)), false);
  assert.equal(inWindow('always', at(3)), true);
});

test('a 20-minute stop around a 01:00 reboot is closed from 00:50 to 01:10 only', () => {
  const w = parseWindow('01:10-00:50')!;
  assert.equal(inWindow(w, at(0, 49)), true);
  assert.equal(inWindow(w, at(0, 50)), false);
  assert.equal(inWindow(w, at(1, 0)), false);
  assert.equal(inWindow(w, at(1, 9)), false);
  assert.equal(inWindow(w, at(1, 10)), true);
  assert.equal(inWindow(w, at(13)), true);
});

test('nextWindowChange names the next opening or closing minute', () => {
  const day = { from: 600, to: 1320 };
  assert.equal(nextWindowChange(day, at(8, 30)), at(10).getTime());
  assert.equal(nextWindowChange(day, at(15, 5)), at(22).getTime());
  assert.equal(nextWindowChange(day, at(23)), new Date(2026, 10, 11, 10).getTime());
  assert.equal(nextWindowChange(parseWindow('01:10-00:50')!, at(14)), new Date(2026, 10, 11, 0, 50).getTime());
  assert.equal(nextWindowChange(parseWindow('01:10-00:50')!, at(0, 55)), at(1, 10).getTime());
  assert.equal(nextWindowChange('always', at(3)), null);
});

const base: StatusInputs = { status: 'running', ownerAlive: true, phaseRunning: true, inWindow: true, quotaParked: false };

test('boardStatus keeps the terminal and waiting statuses as they are', () => {
  assert.equal(boardStatus({ ...base, status: 'done' }), 'done');
  assert.equal(boardStatus({ ...base, status: 'aborted' }), 'aborted');
  assert.equal(boardStatus({ ...base, status: 'parked', ownerAlive: false }), 'gate');
  assert.equal(boardStatus({ ...base, status: 'blocked', ownerAlive: false }), 'blocked');
});

test('boardStatus: a live owner means running, or starting before its first phase', () => {
  assert.equal(boardStatus(base), 'running');
  assert.equal(boardStatus({ ...base, status: 'claimed', phaseRunning: false }), 'starting');
  // A live owner wins over a quota park or a closed window: it is draining.
  assert.equal(boardStatus({ ...base, inWindow: false, quotaParked: true }), 'running');
});

test('boardStatus explains an ownerless in-flight run: quota, then window, then stalled', () => {
  const gone = { ...base, ownerAlive: false };
  assert.equal(boardStatus({ ...gone, quotaParked: true, inWindow: false }), 'quota');
  assert.equal(boardStatus({ ...gone, inWindow: false }), 'window');
  assert.equal(boardStatus(gone), 'stalled');
});

const row = (phase: string, lap: number, start: number, end: number | null, status = 'ok', weighted = 100): PhaseRow =>
  ({ phase, lap, status, started_at: start, ended_at: end, turns: 3, weighted });

test('rollupPhases sums laps per phase in first-run order, counting an open lap up to now', () => {
  const r = rollupPhases([
    row('implement', 1, 300, 400, 'ok'),
    row('plan', 0, 100, 200),
    row('implement', 0, 200, 250, 'failed'),
    row('review', 0, 400, null, 'running', 0),
  ], 1000);
  assert.deepEqual(r.map((p) => [p.phase, p.laps, p.status, p.ms, p.weighted]), [
    ['plan', 1, 'ok', 100, 100],
    ['implement', 2, 'ok', 150, 200],
    ['review', 1, 'running', 600, 0],
  ]);
});

test('sinceFor: open phase while running, the stop while waiting, else the newest attempt at its phase', () => {
  const rows = [row('plan', 0, 100, 200), row('implement', 0, 200, 300), row('implement', 1, 300, null, 'running')];
  assert.equal(sinceFor({ status: 'running', phase: 'implement', started_at: 50, ended_at: null }, rows), 300);
  assert.equal(sinceFor({ status: 'parked', phase: 'plan', started_at: 50, ended_at: 777 }, rows), 777);
  assert.equal(sinceFor({ status: 'claimed', phase: 'plan', started_at: 50, ended_at: null }, rows.slice(0, 2)), 100);
  assert.equal(sinceFor({ status: 'claimed', phase: null, started_at: 50, ended_at: null }, []), 50);
});

test('issue and MR URLs are full links under the project, never a bare #iid', () => {
  assert.equal(issueUrl('https://gitlab.example.com/group/erp', 9161), 'https://gitlab.example.com/group/erp/-/issues/9161');
  assert.equal(mergeRequestUrl('https://gitlab.example.com/group/erp/', 11251), 'https://gitlab.example.com/group/erp/-/merge_requests/11251');
});

test('dur and compact format for a glance', () => {
  assert.equal(dur(42_000), '42s');
  assert.equal(dur(5 * 60_000), '5m');
  assert.equal(dur(125 * 60_000), '2h 5m');
  assert.equal(dur(50 * 3600_000), '2d 2h');
  assert.equal(compact(950), '950');
  assert.equal(compact(12_345), '12k');
  assert.equal(compact(3_450_000), '3.5M');
});

test('percentile is nearest-rank, and null for nothing', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5], 90), 5);
  assert.equal(percentile([4, 1, 3, 2], 50), 2);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
});

test('dayKeys covers every local day inclusive', () => {
  assert.equal(dayKey(new Date(2026, 0, 5, 23, 59).getTime()), '2026-01-05');
  assert.deepEqual(dayKeys(new Date(2026, 9, 30, 23).getTime(), new Date(2026, 10, 2, 1).getTime()),
    ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
});

test('phaseStats counts outcomes, first-try pass rate and laps per run', () => {
  const r = (run_id: string, phase: string, lap: number, status: string, ms: number | null) =>
    ({ run_id, phase, lap, status, started_at: 0, ended_at: ms, turns: 1, weighted: 10 });
  const [impl, plan] = phaseStats([
    r('a', 'implement', 0, 'failed', 100), r('a', 'implement', 1, 'ok', 300),
    r('b', 'implement', 0, 'ok', 200), r('c', 'implement', 0, 'running', null),
    r('a', 'plan', 0, 'warned', 50),
  ], 1000);
  assert.deepEqual([impl!.phase, impl!.attempts, impl!.runs, impl!.passed, impl!.failed], ['implement', 4, 3, 2, 1]);
  assert.equal(impl!.firstPass, 0.5);
  assert.equal(impl!.lapsPerRun, 4 / 3);
  assert.equal(impl!.medianMs, 200);
  assert.equal(impl!.weighted, 40);
  assert.equal(plan!.firstPass, 1);
});

test('stopPhase reads the phase off a stop reason', () => {
  assert.equal(stopPhase('review: verdict changes-requested'), 'review');
  assert.equal(stopPhase('mr-open: x'), 'mr-open');
  assert.equal(stopPhase('awaiting plan approval'), 'other');
  assert.equal(stopPhase(null), 'other');
});

test('phaseStats does not count parked re-checks or repeated model-less rows as attempts', () => {
  const r = (run_id: string, lap: number, status: string, turns: number | null, start: number) =>
    ({ run_id, phase: 'merge', lap, status, started_at: start, ended_at: start + 1, turns, weighted: 0 });
  const [merge] = phaseStats([
    r('a', 0, 'failed', null, 1), r('a', 1, 'failed', null, 2), r('a', 2, 'parked', null, 3), r('a', 3, 'parked', null, 4),
    r('a', 4, 'ok', null, 5), r('a', 5, 'ok', null, 6),
    r('b', 0, 'parked', null, 1), r('b', 1, 'ok', 4, 2), r('b', 2, 'ok', 4, 3),
  ], 100);
  assert.deepEqual([merge!.attempts, merge!.passed, merge!.failed, merge!.parked, merge!.runs], [4, 3, 1, 2, 2]);
  // a's first real attempt failed, b's passed.
  assert.equal(merge!.firstPass, 0.5);
});

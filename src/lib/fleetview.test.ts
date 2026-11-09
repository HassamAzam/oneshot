import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boardStatus, compact, dur, inWindow, issueUrl, mergeRequestUrl, nextWindowChange, parseWindow, rollupPhases, sinceFor,
  type PhaseRow, type StatusInputs,
} from './fleetview.js';

const at = (h: number, m = 0): Date => new Date(2026, 10, 10, h, m);

test('parseWindow reads <from>-<to> and always, and refuses the rest', () => {
  assert.deepEqual(parseWindow('10-22'), { from: 10, to: 22 });
  assert.deepEqual(parseWindow(' 22-6 '), { from: 22, to: 6 });
  assert.equal(parseWindow('always'), 'always');
  assert.equal(parseWindow('10:00-22:00'), null);
  assert.equal(parseWindow('25-3'), null);
  assert.equal(parseWindow(''), null);
});

test('inWindow matches window.sh: from inclusive, to exclusive, wrapping past midnight', () => {
  const day = { from: 10, to: 22 };
  assert.equal(inWindow(day, at(9, 59)), false);
  assert.equal(inWindow(day, at(10)), true);
  assert.equal(inWindow(day, at(21, 59)), true);
  assert.equal(inWindow(day, at(22)), false);
  const night = { from: 22, to: 6 };
  assert.equal(inWindow(night, at(23)), true);
  assert.equal(inWindow(night, at(5)), true);
  assert.equal(inWindow(night, at(12)), false);
  assert.equal(inWindow('always', at(3)), true);
});

test('nextWindowChange names the next opening or closing hour', () => {
  const day = { from: 10, to: 22 };
  assert.equal(nextWindowChange(day, at(8, 30)), at(10).getTime());
  assert.equal(nextWindowChange(day, at(15, 5)), at(22).getTime());
  assert.equal(nextWindowChange(day, at(23)), new Date(2026, 10, 11, 10).getTime());
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

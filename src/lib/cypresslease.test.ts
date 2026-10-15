import { after, beforeEach, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  RUN_KILL_GRACE_MS, acquireCypressLease, cypressLeaseHolder, leaseMaxAgeMs, localTestsRunDeadlineMs,
  releaseCypressLease, runDeadlineMs,
} from './cypresslease.js';
import { localTestsConfig, phaseByName } from './config.js';
import { db } from './db.js';

/**
 * These run against the desk's own state/oneshot.db, like every other test that
 * imports db.ts, so every row they make is named with this prefix and removed
 * afterwards — and a lease held by a REAL run is never touched: the tests skip
 * instead. The lease is one row for the whole desk, so a test that cleared it
 * to get a clean slate would free a live Cypress run's desk under it.
 */
const PREFIX = `test-cypress-lease-${process.pid}-`;
const run = (name: string): string => `${PREFIX}${name}`;

function clearOurs(): void {
  db.prepare('DELETE FROM cypress_lease WHERE run_id LIKE ?').run(`${PREFIX}%`);
  db.prepare("DELETE FROM events WHERE kind LIKE 'cypress_lease_%' AND run_id LIKE ?").run(`${PREFIX}%`);
}

beforeEach(clearOurs);
after(clearOurs);

/** True (and the test skipped) when somebody real holds the lease right now. */
function realHolder(t: TestContext): boolean {
  const holder = cypressLeaseHolder();
  if (!holder || holder.runId.startsWith(PREFIX)) return false;
  t.skip(`a real run holds the Cypress lease (${holder.runId}); not touching it`);
  return true;
}

/** A row written as if another process had taken the lease. */
function plant(runId: string, pid: number, acquiredAt: number): void {
  db.prepare('INSERT INTO cypress_lease (id, run_id, pid, acquired_at) VALUES (1, ?, ?, ?)')
    .run(runId, pid, acquiredAt);
}

/** A pid that existed a moment ago and does not now. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  assert.ok(child.pid);
  return child.pid;
}

test('a free desk is granted, and the same run asking again is granted again', async (t) => {
  if (realHolder(t)) return;
  assert.equal(await acquireCypressLease(run('a')), true);
  assert.equal(cypressLeaseHolder()?.runId, run('a'));
  assert.equal(cypressLeaseHolder()?.pid, process.pid);
  // Re-entry: a retry, or a resumed run after its conductor restarted.
  assert.equal(await acquireCypressLease(run('a')), true);
});

test('a second run is told the desk is busy while a live holder is inside its deadline', async (t) => {
  if (realHolder(t)) return;
  assert.equal(await acquireCypressLease(run('a')), true);
  assert.equal(await acquireCypressLease(run('b')), false);
  assert.equal(cypressLeaseHolder()?.runId, run('a'), 'the busy answer must not move the lease');
});

test('release frees the desk for the next run', async (t) => {
  if (realHolder(t)) return;
  assert.equal(await acquireCypressLease(run('a')), true);
  releaseCypressLease(run('a'));
  assert.equal(cypressLeaseHolder(), null);
  assert.equal(await acquireCypressLease(run('b')), true);
});

test('release is idempotent, and never frees a lease the caller does not hold', async (t) => {
  if (realHolder(t)) return;
  releaseCypressLease(run('nobody'));
  assert.equal(await acquireCypressLease(run('a')), true);
  releaseCypressLease(run('b'));
  assert.equal(cypressLeaseHolder()?.runId, run('a'), 'another run\'s release freed this lease');
  releaseCypressLease(run('a'));
  releaseCypressLease(run('a'));
  assert.equal(cypressLeaseHolder(), null);
});

test('a lease whose holder process is gone is reclaimed', async (t) => {
  if (realHolder(t)) return;
  plant(run('dead'), deadPid(), Date.now());
  assert.equal(await acquireCypressLease(run('b')), true);
  assert.equal(cypressLeaseHolder()?.runId, run('b'));
  const broken = db.prepare("SELECT detail FROM events WHERE kind = 'cypress_lease_broken' AND run_id = ?")
    .get(run('dead')) as { detail: string } | undefined;
  assert.match(broken?.detail ?? '', new RegExp(run('b')));
});

test('a lease older than the conductor\'s kill plus its margin is reclaimed even when its pid still answers', async (t) => {
  if (realHolder(t)) return;
  // process.pid answers signal 0 — the case where the holder's pid was reused.
  plant(run('old'), process.pid, Date.now() - leaseMaxAgeMs() - 60_000);
  assert.equal(await acquireCypressLease(run('b')), true);
  assert.equal(cypressLeaseHolder()?.runId, run('b'));
});

test('a live lease just inside the age limit is not reclaimed', async (t) => {
  if (realHolder(t)) return;
  plant(run('busy'), process.pid, Date.now() - leaseMaxAgeMs() + 60_000);
  assert.equal(await acquireCypressLease(run('b')), false);
  assert.equal(cypressLeaseHolder()?.runId, run('busy'));
});

test('a run the conductor has not killed yet keeps its lease, however long its base re-run takes', async (t) => {
  if (realHolder(t)) return;
  // The same sum the run step kills by: never under the phase's timeoutMin.
  const kill = runDeadlineMs(localTestsConfig().maxRunMinutes, phaseByName('local-tests-run')?.timeoutMin ?? 0);
  assert.equal(localTestsRunDeadlineMs(), kill);
  assert.ok(leaseMaxAgeMs() > kill + RUN_KILL_GRACE_MS, 'the lease outlives the kill and its grace');
  // Alive at the very end of its kill grace: still the desk's.
  plant(run('slow'), process.pid, Date.now() - kill - RUN_KILL_GRACE_MS);
  assert.equal(await acquireCypressLease(run('b')), false);
  assert.equal(cypressLeaseHolder()?.runId, run('slow'));
});

test('the age limit follows the deadline it is derived from', () => {
  assert.equal(runDeadlineMs(45), 60 * 60_000);
  assert.equal(runDeadlineMs(45, 120), 120 * 60_000);
  assert.equal(localTestsRunDeadlineMs(150) >= 165 * 60_000, true);
});

/**
 * The Ready For Automation mode's journal, versions and per-ticket lock.
 *
 * These write real files under STATE/automation, in the reserved 990000+ iid
 * band the other fixture tests use, and remove them afterwards (the archive
 * directory included).
 */
import '../lib/test-project-env.js';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { RUNS, STATE } from '../lib/config.js';
import {
  acquireTicketLock, archiveAutoJournal, automationDir, automationHome, listAutoJournals, newAutoJournal,
  readAutoJournal, readVersion, saveVersion, writeAutoJournal,
} from './journal.js';
import type { AutomationArtifact } from './types.js';

const IIDS = [990001, 990002, 990003, 990004, 990005, 990006, 990007];
const archived: string[] = [];
const ARCHIVE = join(STATE, 'automation-archive');
/** Parents this test run creates, removed again when it leaves them empty. */
const createdParents = [automationHome(), ARCHIVE].filter((p) => !existsSync(p));

after(() => {
  for (const iid of IIDS) rmSync(automationDir(iid), { recursive: true, force: true });
  for (const p of archived) rmSync(p, { recursive: true, force: true });
  for (const p of createdParents) {
    if (existsSync(p) && readdirSync(p).length === 0) rmSync(p, { recursive: true, force: true });
  }
});

const artifact: AutomationArtifact = {
  summary: 'Eight cases for the profile preferences fix.',
  module: 'Profile',
  cases: [{
    id: 'TC-01', scenario: 'Verify that the preference is saved', precondition: '', steps: ['Open Profile', 'Click Save'],
    expected: 'A success toast shows', automatable: 'yes', reason: 'UI state backed by an API',
  }],
  changes: [],
  sources: ['!501 apps/profile/views.py'],
};

test('the automation home is under STATE/automation, never the Loop\'s runs', () => {
  assert.equal(automationHome(), join(STATE, 'automation'));
  assert.equal(automationDir(990001), join(STATE, 'automation', '990001'));
  assert.ok(!automationDir(990001).startsWith(RUNS + sep));
  assert.ok(!automationHome().startsWith(RUNS + sep));
});

test('the journal round-trips and is written atomically', () => {
  const j = newAutoJournal(990002, 'Profile preferences');
  assert.match(j.runId, /^a-[a-z0-9]+-[0-9a-f]{6}$/);
  assert.equal(j.project, 'gitlab.example.com/acme/erp');
  assert.equal(j.state, 'new');
  j.watermark = 512;
  writeAutoJournal(j);
  const back = readAutoJournal(990002);
  assert.deepEqual(back, j);
  // Only the journal itself: the temp file it was written through is gone.
  assert.deepEqual(readdirSync(automationDir(990002)), ['journal.json']);

  saveVersion(990002, 1, artifact);
  assert.deepEqual(readVersion(990002, 1), artifact);
  assert.equal(readVersion(990002, 2), null);

  writeFileSync(join(automationDir(990002), 'journal.json'), '{ half a journ');
  assert.equal(readAutoJournal(990002), null, 'an unreadable journal reads as none');
  assert.equal(readAutoJournal(990003), null, 'no journal reads as none');
});

test('a ticket lock is exclusive, and a dead owner\'s lock is taken over', () => {
  const release = acquireTicketLock(990004, 'conductor-a');
  assert.ok(release);
  assert.equal(acquireTicketLock(990004, 'conductor-b'), null, 'a live owner keeps it');
  release();
  const again = acquireTicketLock(990004, 'conductor-b');
  assert.ok(again, 'released means free');
  again();

  // A pid that has certainly exited.
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const lock = join(automationDir(990004), 'lock');
  writeFileSync(lock, JSON.stringify({ pid: dead, owner: 'gone', at: Date.now(), token: 'x' }));
  const taken = acquireTicketLock(990004, 'conductor-c');
  assert.ok(taken, 'a dead owner\'s lock is stale');
  taken();

  // A live pid, but older than any session could be.
  writeFileSync(lock, JSON.stringify({ pid: process.pid, owner: 'old', at: Date.now() - 4 * 3_600_000, token: 'y' }));
  const old = acquireTicketLock(990004, 'conductor-d');
  assert.ok(old, 'a lock older than three hours is stale');

  // Releasing a lock someone else has since taken over does not remove theirs.
  writeFileSync(lock, JSON.stringify({ pid: process.pid, owner: 'thief', at: Date.now(), token: 'z' }));
  old();
  assert.ok(existsSync(lock));
  rmSync(lock);
});

test('archiving moves the journal aside and leaves the lock in place', () => {
  const j = newAutoJournal(990005, 'Leave balance');
  writeAutoJournal(j);
  saveVersion(990005, 1, artifact);
  const release = acquireTicketLock(990005, 'conductor-a');
  assert.ok(release);

  const to = archiveAutoJournal(990005, j.runId);
  assert.ok(to);
  archived.push(to);
  assert.ok(to.startsWith(ARCHIVE + sep));
  assert.ok(to.endsWith(`990005-${j.runId}`));
  assert.deepEqual(readdirSync(to).sort(), ['cases-v1.json', 'journal.json']);
  assert.deepEqual(readdirSync(automationDir(990005)), ['lock']);
  assert.equal(readAutoJournal(990005), null);
  assert.equal(acquireTicketLock(990005, 'conductor-b'), null, 'the lock the advancer holds is still valid');
  release();
  assert.equal(archiveAutoJournal(990005, j.runId), null, 'nothing left to move');
});

test('listAutoJournals returns every readable journal and skips a broken one', () => {
  writeAutoJournal(newAutoJournal(990006, 'one'));
  writeAutoJournal(newAutoJournal(990007, 'two'));
  mkdirSync(automationDir(990001), { recursive: true });
  writeFileSync(join(automationDir(990001), 'journal.json'), 'not json');
  const mine = listAutoJournals().filter((x) => IIDS.includes(x.iid)).map((x) => x.iid);
  assert.deepEqual(mine, [990006, 990007]);
});

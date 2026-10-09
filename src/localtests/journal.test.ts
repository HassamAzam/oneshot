/**
 * The local automation tests mode's journal, lists and per-ticket lock.
 *
 * These write real files under STATE/localtests, in the reserved 990000+ iid
 * band the other fixture tests use, and remove them afterwards (the archive
 * directory included).
 */
import '../lib/test-project-env.js';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE, runDir } from '../lib/config.js';
import {
  acquireLtLock, archiveLtJournal, erpCheckoutDir, heldLtIids, keepPatch, listLtJournals, localTestsDir, localTestsHome,
  newLtJournal, readList, readLtJournal, readRunRecord, saveList, saveRunRecord, writeLtJournal,
} from './journal.js';

const IIDS = [990701, 990702, 990703, 990704, 990705, 990706, 990707, 990708];
const archived: string[] = [];
const ARCHIVE = join(STATE, 'localtests-archive');
const createdParents = [localTestsHome(), ARCHIVE].filter((p) => !existsSync(p));

after(() => {
  for (const iid of IIDS) {
    rmSync(localTestsDir(iid), { recursive: true, force: true });
    rmSync(runDir(iid), { recursive: true, force: true });
  }
  for (const p of archived) rmSync(p, { recursive: true, force: true });
  for (const p of createdParents) {
    if (existsSync(p) && readdirSync(p).length === 0) rmSync(p, { recursive: true, force: true });
  }
});

test('a fresh journal is `new`, stamped with this project and an l- run id, and reads back as written', () => {
  const j = newLtJournal(990701, 'Leave form');
  assert.equal(j.state, 'new');
  assert.match(j.runId, /^l-[a-z0-9]+-[0-9a-f]{6}$/);
  assert.equal(j.project, 'gitlab.example.com/acme/erp');
  assert.deepEqual(j.lists, []);
  writeLtJournal(j);
  const back = readLtJournal(990701)!;
  assert.equal(back.runId, j.runId);
  assert.ok(back.updatedAt >= j.createdAt);
  assert.equal(erpCheckoutDir(990701), join(localTestsDir(990701), 'erp'));
});

test('an unreadable or foreign journal reads as none, and missing counters read as zero', () => {
  mkdirSync(localTestsDir(990702), { recursive: true });
  writeFileSync(join(localTestsDir(990702), 'journal.json'), '{ not json');
  assert.equal(readLtJournal(990702), null);
  writeFileSync(join(localTestsDir(990702), 'journal.json'), JSON.stringify({ v: 1, iid: 1, runId: 'l-x', state: 'new', lists: [] }));
  assert.equal(readLtJournal(990702), null, 'another ticket\'s journal is not this one');
  writeFileSync(join(localTestsDir(990702), 'journal.json'), JSON.stringify({ v: 1, iid: 990702, runId: 'l-x', state: 'waiting', lists: [] }));
  const j = readLtJournal(990702)!;
  assert.deepEqual([j.attempts, j.sessions, j.freeRetries, j.watermark], [0, 0, 0, 0]);
});

test('lists are saved beside the journal exactly as put to QA', () => {
  const scope = { applicable: true, specs: [{ file: 'cypress/e2e/leaves/a.cy.ts' }] };
  saveList(990703, 1, scope);
  assert.deepEqual(readList(990703, 1), scope);
  assert.equal(readList(990703, 2), null);
});

test('every readable journal is listed, by iid', () => {
  writeLtJournal(newLtJournal(990705, 'B'));
  writeLtJournal(newLtJournal(990704, 'A'));
  const iids = listLtJournals().map((j) => j.iid).filter((n) => IIDS.includes(n));
  assert.deepEqual(iids.filter((n) => n === 990704 || n === 990705), [990704, 990705]);
});

test('archiving moves everything but the lock and the ERP checkout, and deletes nothing', () => {
  const j = newLtJournal(990706, 'C');
  writeLtJournal(j);
  saveList(990706, 1, { specs: [] });
  mkdirSync(erpCheckoutDir(990706), { recursive: true });
  const release = acquireLtLock(990706, 'test')!;
  const to = archiveLtJournal(990706, j.runId)!;
  archived.push(to);
  assert.ok(existsSync(join(to, 'journal.json')));
  assert.ok(existsSync(join(to, 'list-r1.json')));
  assert.ok(existsSync(join(localTestsDir(990706), 'lock')), 'the advance doing the archiving keeps its lock');
  assert.ok(existsSync(erpCheckoutDir(990706)), 'a git worktree is gc\'s to remove, through git');
  assert.equal(readLtJournal(990706), null);
  release();
  assert.equal(archiveLtJournal(990706, j.runId), null, 'nothing left to move');
});

test('one advancer per ticket: a live lock is refused, a dead one taken over, and gc sees who holds what', () => {
  const release = acquireLtLock(990701, 'tick')!;
  assert.ok(release);
  assert.equal(acquireLtLock(990701, '--local-tests'), null, 'a live owner holds it');
  assert.ok(heldLtIids().includes(990701), 'gc keeps what a live advance holds');
  release();
  assert.ok(!heldLtIids().includes(990701));

  // A lock left by a process that is gone is stale.
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  writeFileSync(join(localTestsDir(990701), 'lock'), JSON.stringify({ pid: Number(dead.stdout), owner: 'gone', at: Date.now(), token: 'x' }));
  assert.ok(!heldLtIids().includes(990701), 'a dead owner holds nothing');
  const again = acquireLtLock(990701, 'tick');
  assert.ok(again, 'taken over');
  again!();
});

test('a list\'s patch is copied beside the journal, so archiving state/runs/<iid> cannot take it; a kept one stays put', () => {
  const src = join(runDir(990707), 'artifacts', 'local-tests', 'temporary-changes.patch');
  mkdirSync(join(runDir(990707), 'artifacts', 'local-tests'), { recursive: true });
  writeFileSync(src, 'diff --git a/x b/x\n');
  const kept = keepPatch(990707, 1, src)!;
  assert.equal(kept, join(localTestsDir(990707), 'patch-r1.patch'));
  rmSync(runDir(990707), { recursive: true, force: true });
  assert.equal(readFileSync(kept, 'utf8'), 'diff --git a/x b/x\n', 'still there after the run directory is gone');
  assert.equal(keepPatch(990707, 2, kept), kept, 'already beside the journal: the same file, not a second copy');
  assert.ok(!existsSync(join(localTestsDir(990707), 'patch-r2.patch')));
  assert.equal(keepPatch(990707, 3, src), null, 'nothing to copy: the caller keeps the path it had');
});

test('the run\'s record is kept beside the journal, reads back as written, and is archived with it', () => {
  assert.equal(readRunRecord(990708), null);
  saveRunRecord(990708, { status: 'failed', cacheKey: 'k1' });
  assert.deepEqual(readRunRecord(990708), { status: 'failed', cacheKey: 'k1' });
  writeFileSync(join(localTestsDir(990708), 'run.json'), '{ not json');
  assert.equal(readRunRecord(990708), null, 'an unreadable record reads as none');
  saveRunRecord(990708, { status: 'passed', cacheKey: 'k2' });
  const j = newLtJournal(990708, 'D');
  writeLtJournal(j);
  const to = archiveLtJournal(990708, j.runId)!;
  archived.push(to);
  assert.ok(existsSync(join(to, 'run.json')), 'a new request never reports the last one\'s run');
  assert.equal(readRunRecord(990708), null);
});

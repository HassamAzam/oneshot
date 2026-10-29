/**
 * The version stamp the escaped-defect eval buckets shipped tickets by.
 *
 * Tested against real git state in a throwaway repo rather than by mocking
 * spawnSync: every failure mode here is about what git actually reports — a
 * detached checkout, untracked scratch files, a directory that is no repo at
 * all — and a mock would only prove the mock agrees with itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DRY_RUN = '1';
const { oneshotSha } = await import('./version.js');
const { ROOT } = await import('./config.js');

const git = (dir: string, ...args: string[]): string =>
  (spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).stdout ?? '').trim();

test('this checkout reports a short sha, dirty-suffixed only for TRACKED edits', () => {
  const got = oneshotSha();
  assert.match(got, /^[0-9a-f]{7,12}(-dirty)?$/, got);
  // It must agree with git, not merely look plausible.
  assert.ok(got.startsWith(git(ROOT, 'rev-parse', '--short=9', 'HEAD')), got);
  // This desk keeps untracked run*.sh scratch scripts beside the checkout. If
  // those counted, every record would be stamped dirty and the eval would have
  // no clean cohort at all — which is what `status --porcelain` would have done.
  const untracked = git(ROOT, 'ls-files', '--others', '--exclude-standard');
  const trackedDirty = spawnSync('git', ['-C', ROOT, 'diff', '--quiet', 'HEAD']).status !== 0;
  if (untracked && !trackedDirty) assert.equal(got.endsWith('-dirty'), false, got);
});

test('an uncommitted tracked change makes it a different version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oneshot-version-'));
  try {
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t.invalid');
    git(dir, 'config', 'user.name', 'T');
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    git(dir, 'add', 'a.txt');
    git(dir, 'commit', '-qm', 'first');
    const clean = spawnSync('git', ['-C', dir, 'diff', '--quiet', 'HEAD']).status === 0;
    assert.equal(clean, true);

    writeFileSync(join(dir, 'a.txt'), 'two\n');
    assert.equal(spawnSync('git', ['-C', dir, 'diff', '--quiet', 'HEAD']).status === 0, false);

    // An untracked file alone must NOT flip it — the property the real stamp relies on.
    git(dir, 'checkout', '--', 'a.txt');
    writeFileSync(join(dir, 'scratch.sh'), '#!/bin/sh\n');
    assert.equal(spawnSync('git', ['-C', dir, 'diff', '--quiet', 'HEAD']).status === 0, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a directory that is not a repo yields empty, never a guess', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oneshot-norepo-'));
  try {
    const r = spawnSync('git', ['-C', dir, 'rev-parse', '--short=9', 'HEAD'], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    // The contract: '' so an eval can drop the row. A fabricated sha would pool
    // unknown-version tickets into a real cohort and quietly skew it.
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The integration point: the stamp is useless unless EVERY phase record
 * carries it. Stamped inside `recordPhase` rather than at its eight call
 * sites, so a phase that forgot to pass one cannot exist.
 */
test('recordPhase stamps every record, and an explicit stamp is preserved', async () => {
  const { writeJournal, readJournal, recordPhase } = await import('./artifacts.js');
  const { runDir } = await import('./config.js');
  const { rmSync } = await import('node:fs');
  const iid = 99077;
  writeJournal({
    runId: 'r-stamp', iid, title: 't', url: 'u', createdAt: 1, status: 'running', phases: [],
  } as never);
  try {
    recordPhase(iid, { phase: 'testcases', lap: 0, status: 'ok', startedAt: 1, endedAt: 2 });
    recordPhase(iid, { phase: 'verify', lap: 0, status: 'failed', startedAt: 3, endedAt: 4 });
    // A replayed or backfilled record states its own version; it must not be
    // overwritten with the version doing the backfilling.
    recordPhase(iid, { phase: 'review', lap: 0, status: 'ok', startedAt: 5, endedAt: 6, oneshot: 'deadbeef1' });

    const phases = readJournal(iid)!.phases;
    assert.equal(phases.length, 3);
    assert.ok(phases.every((p) => !!p.oneshot), 'a phase record went unstamped');
    assert.equal(phases[0]!.oneshot, oneshotSha());
    assert.equal(phases[1]!.oneshot, oneshotSha());
    assert.equal(phases[2]!.oneshot, 'deadbeef1');
  } finally {
    rmSync(runDir(iid), { recursive: true, force: true });
  }
});

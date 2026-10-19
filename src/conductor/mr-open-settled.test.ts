/**
 * mr-open is owed a turn only while there is something to push or to open.
 *
 * Code phases run on every pass because the recheck IS their idempotency: a
 * journal that says "merged" while GitLab says "opened" must lose. For mr-open
 * the recheck was a `git push` plus a GitLab search, and a lap was recorded
 * every time. A run parked at the test-case gate is re-claimed on every
 * conductor tick, so ticket 8652 recorded 1521 mr-open laps, one a minute —
 * each a push, two Slack card updates, a journal write and a publish sweep,
 * none of which had anything left to do. The recheck now happens BEFORE the
 * lap is spent: the branch tip is already what origin holds and the journal
 * records the MR, so the phase is settled and the loop steps over it.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUNS } from '../lib/config.js';
import { writeJournal, type RunJournal } from '../lib/artifacts.js';
import { mrOpenSettled } from './codephases.js';
import { CODE_PHASE_SETTLED } from './runner.js';

/** An iid no ticket will ever have, so a real run's journal is never touched. */
const IID = 99900002;
const BRANCH = 'oneshot/ticket-99900002-settled';
let root: string;
let worktree: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
}

function commit(name: string): void {
  writeFileSync(join(worktree, `${name}.txt`), name);
  git(worktree, 'add', '.');
  git(worktree, '-c', 'user.name=t', '-c', 'user.email=t@t.test', 'commit', '-qm', name);
}

function journal(overrides: Partial<RunJournal>): RunJournal {
  const j = {
    runId: 'r-test', iid: IID, title: 't', url: '', createdAt: 0, status: 'running', phases: [],
    branch: BRANCH, worktree, mrIid: 7, ...overrides,
  } as unknown as RunJournal;
  writeJournal(j);
  return j;
}

const ctx = (j: RunJournal) => ({ iid: IID, runId: j.runId, journal: j, prior: {} });

before(() => {
  root = mkdtempSync(join(tmpdir(), 'oneshot-mr-open-'));
  const origin = join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', origin]);
  worktree = join(root, 'wt');
  execFileSync('git', ['init', '-q', '-b', BRANCH, worktree]);
  git(worktree, 'remote', 'add', 'origin', origin);
  commit('first');
  git(worktree, 'push', '-q', '-u', 'origin', BRANCH);
});

after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(join(RUNS, String(IID)), { recursive: true, force: true });
});

test('a pushed branch with an MR on record has nothing left to do', () => {
  assert.equal(mrOpenSettled(ctx(journal({}))), true);
});

test('a commit origin has not seen owes the phase a turn, until it is pushed', () => {
  // The implement→mr-open re-push after a review or verify cycle: the lap the
  // phase exists for, and the one a skip-by-memory would have lost.
  const j = journal({});
  commit('second');
  assert.equal(mrOpenSettled(ctx(j)), false);
  git(worktree, 'push', '-q', 'origin', BRANCH);
  assert.equal(mrOpenSettled(ctx(j)), true);
});

test('no MR on record is never settled, however up to date the push', () => {
  assert.equal(mrOpenSettled(ctx(journal({ mrIid: undefined }))), false);
});

test('no lease is never settled', () => {
  assert.equal(mrOpenSettled(ctx(journal({ branch: undefined }))), false);
  assert.equal(mrOpenSettled(ctx(journal({ worktree: undefined }))), false);
});

test('the loop consults it for mr-open and for nothing else', () => {
  // merge keeps its every-pass recheck: GitLab decides whether an MR is merged,
  // and nothing on disk is allowed to answer for it.
  assert.equal(CODE_PHASE_SETTLED['mr-open'], mrOpenSettled);
  assert.equal(CODE_PHASE_SETTLED.merge, undefined);
});

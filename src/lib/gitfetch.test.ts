import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRefLockRace, retryRefLockRace } from './gitfetch.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});

/** The exact stderr that blocked a run when two conductors fetched dev together. */
const raceStderr = "error: cannot lock ref 'refs/remotes/origin/dev': is at 7a21bb0 but expected 21cd869\n"
  + ' ! 21cd869..7a21bb0  dev        -> origin/dev  (unable to update local ref)\n';

test('a concurrent-fetch ref lock is recognised; other git failures are not', () => {
  assert.equal(isRefLockRace({ stderr: raceStderr }), true);
  assert.equal(isRefLockRace(new Error(`Command failed: git fetch origin dev\n${raceStderr}`)), true);
  assert.equal(isRefLockRace({ stderr: "fatal: couldn't find remote ref nope" }), false);
  // Without the lock failure above it, this line is a transaction or reflog
  // write that went wrong — fatal, and deliberately not retried.
  assert.equal(isRefLockRace({ stderr: "error: unable to update local ref 'refs/remotes/origin/dev'" }), false);
  assert.equal(isRefLockRace({ stderr: 'ssh: Could not resolve hostname gitlab.arbisoft.com' }), false);
  assert.equal(isRefLockRace(null), false);
});

test('the race is retried until the fetch goes through', () => {
  const waits: number[] = [];
  let calls = 0;
  const out = retryRefLockRace(() => {
    calls++;
    if (calls < 3) throw Object.assign(new Error('Command failed'), { stderr: raceStderr });
    return 'fetched';
  }, { sleep: (ms) => waits.push(ms), waitMs: 10 });
  assert.equal(out, 'fetched');
  assert.equal(calls, 3);
  assert.deepEqual(waits, [10, 20]);
});

/**
 * Every other test here injects its own attempts/waitMs, so the numbers a real
 * conductor actually runs with were never observed by anything: shrinking
 * waitMs to a tenth kept the suite green. This is the one test that passes no
 * options but the spy.
 */
test('left to its own defaults it backs off 1.5s, 3s, 4.5s over four attempts', () => {
  const waits: number[] = [];
  let calls = 0;
  assert.throws(() => retryRefLockRace(() => {
    calls++;
    throw Object.assign(new Error('Command failed'), { stderr: raceStderr });
  }, { sleep: (ms) => waits.push(ms) }), /Command failed/);
  assert.equal(calls, 4);
  assert.deepEqual(waits, [1_500, 3_000, 4_500]);
});

test('any other failure is thrown on the first attempt', () => {
  let calls = 0;
  assert.throws(() => retryRefLockRace(() => {
    calls++;
    throw Object.assign(new Error('Command failed'), { stderr: 'fatal: unable to access remote' });
  }, { sleep: () => {} }), /Command failed/);
  assert.equal(calls, 1);
});

test('a lock that never clears still fails once the attempts run out', () => {
  let calls = 0;
  assert.throws(() => retryRefLockRace(() => {
    calls++;
    throw Object.assign(new Error('Command failed'), { stderr: raceStderr });
  }, { attempts: 3, sleep: () => {} }), /Command failed/);
  assert.equal(calls, 3);
});

test('real git: a fetch that loses the ref lock succeeds on retry once the holder lets go', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gitfetch-'));
  try {
    const up = join(dir, 'up');
    const down = join(dir, 'down');
    execFileSync('git', ['init', '-q', '-b', 'dev', up]);
    git(up, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'a');
    execFileSync('git', ['clone', '-q', up, down]);
    git(up, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'b');
    const head = git(up, 'rev-parse', 'dev').trim();

    // Another fetch holding the ref lock, released while this one waits.
    const lock = join(down, '.git', 'refs', 'remotes', 'origin', 'dev.lock');
    writeFileSync(lock, '');
    let calls = 0;
    retryRefLockRace(() => { calls++; git(down, 'fetch', 'origin', 'dev'); }, { sleep: () => rmSync(lock) });

    assert.equal(calls, 2);
    assert.equal(git(down, 'rev-parse', 'origin/dev').trim(), head);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

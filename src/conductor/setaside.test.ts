/**
 * What a fixer session edited and did not commit is not a fix.
 *
 * The review loop counts a fix by its commit (src/review/ledger.ts, applyFix).
 * A session that ran out of turns mid-change, or answered "fixed" without
 * committing, leaves its edits in the worktree — where the re-check reviewer
 * would read them as the code at HEAD and verify would test them, although the
 * branch and the merge request hold none of it. setAsideUncommitted moves them
 * out, keeps them, and leaves everything that is untracked on purpose alone.
 */
import '../lib/test-project-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setAsideUncommitted } from './codephases.js';

let root: string;
let main: string;
let wt: string;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();

before(() => {
  root = mkdtempSync(join(tmpdir(), 'oneshot-aside-'));
  main = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'dev', main]);
  git(main, 'config', 'user.name', 't');
  git(main, 'config', 'user.email', 't@t.test');
  mkdirSync(join(main, 'apps'), { recursive: true });
  writeFileSync(join(main, 'apps', 'admin.py'), 'x = 1\n');
  writeFileSync(join(main, 'apps', 'models.py'), 'y = 1\n');
  git(main, 'add', '.');
  git(main, 'commit', '-qm', 'base');
  // A LINKED worktree, as a run's is: the stash stack it would use is the main repo's.
  wt = join(root, 'wt');
  git(main, 'worktree', 'add', '-q', '-b', 'oneshot/ticket-1', wt);
});

after(() => { rmSync(root, { recursive: true, force: true }); });

test('a clean tree has nothing to set aside', () => {
  assert.deepEqual(setAsideUncommitted(wt, 'r-1 review-fix lap 1'), []);
  assert.equal(git(main, 'for-each-ref', 'refs/oneshot/aside'), '');
});

test('uncommitted edits to tracked files leave the tree, are kept, and never sit on the shared stash stack', () => {
  writeFileSync(join(wt, 'apps', 'admin.py'), 'x = 2  # the fix, never committed\n');
  git(wt, 'add', 'apps/admin.py');                                     // staged
  writeFileSync(join(wt, 'apps', 'models.py'), 'y = 2\n');             // unstaged
  mkdirSync(join(wt, '.verify-scratch'), { recursive: true });
  writeFileSync(join(wt, '.verify-scratch', 'django.log'), 'untracked on purpose\n');
  const head = git(wt, 'rev-parse', 'HEAD');

  const moved = setAsideUncommitted(wt, 'r-1 review-fix lap 1');

  assert.deepEqual(moved.sort(), ['apps/admin.py', 'apps/models.py']);
  // The tree is what HEAD holds, and HEAD has not moved.
  assert.equal(readFileSync(join(wt, 'apps', 'admin.py'), 'utf8'), 'x = 1\n');
  assert.equal(readFileSync(join(wt, 'apps', 'models.py'), 'utf8'), 'y = 1\n');
  assert.equal(git(wt, 'status', '--porcelain', '--untracked-files=no'), '');
  assert.equal(git(wt, 'rev-parse', 'HEAD'), head);
  // Untracked files are not this function's to touch.
  assert.ok(existsSync(join(wt, '.verify-scratch', 'django.log')));
  // Kept under a ref of its own…
  const refs = git(main, 'for-each-ref', '--format=%(refname)', 'refs/oneshot/aside').split('\n').filter(Boolean);
  assert.equal(refs.length, 1);
  assert.match(refs[0]!, /^refs\/oneshot\/aside\/r-1-review-fix-lap-1-[0-9a-f]{8}$/);
  assert.match(git(main, 'show', '--stat', '--format=%s', refs[0]!), /oneshot set aside: r-1 review-fix lap 1/);
  assert.match(git(main, 'diff', `${head}`, refs[0]!, '--', 'apps/admin.py'), /the fix, never committed/);
  // …and not on the stash stack every worktree of this repo shares.
  assert.equal(git(main, 'stash', 'list'), '');
});

test('a stash somebody else left on the shared stack is not disturbed', () => {
  writeFileSync(join(main, 'apps', 'models.py'), 'y = 99\n');
  git(main, 'stash', 'push', '-q', '-m', 'a person\'s own work');
  writeFileSync(join(wt, 'apps', 'admin.py'), 'x = 3\n');

  assert.deepEqual(setAsideUncommitted(wt, 'r-1 review-fix lap 2'), ['apps/admin.py']);

  assert.match(git(main, 'stash', 'list'), /^stash@\{0\}: On dev: a person's own work$/);
  assert.equal(git(main, 'for-each-ref', '--format=%(refname)', 'refs/oneshot/aside').split('\n').filter(Boolean).length, 2);
  git(main, 'stash', 'drop', '-q');
});

test('a directory that is not a git checkout is reported as nothing moved, not thrown', () => {
  assert.deepEqual(setAsideUncommitted(join(root, 'nowhere'), 'r-1 x'), []);
});

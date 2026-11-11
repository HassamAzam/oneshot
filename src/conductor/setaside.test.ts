/**
 * What a fixer session changed and did not commit is not a fix.
 *
 * The review loop counts a fix by its commit (src/review/ledger.ts, applyFix).
 * A session that ran out of turns mid-change, or answered "fixed" without
 * committing, leaves its work in the worktree — where the re-check reviewer
 * would read it as the code at HEAD, verify would test it, and a staged
 * deletion would ride the next lap's commit onto the merge request.
 * setAsideUncommitted puts the tree back to HEAD, keeps what was there under a
 * ref of its own, and leaves alone everything that is untracked on purpose.
 *
 * Every test builds its own repository with a LINKED worktree, as a run's is:
 * the stash stack it must not touch is the main repo's.
 */
import '../lib/test-project-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createdUntracked, porcelainPaths, setAsideUncommitted, untrackedFiles } from './codephases.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();

function fixture(run: (o: { main: string; wt: string; head: string }) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'oneshot-aside-'));
  try {
    const main = join(root, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'dev', main]);
    git(main, 'config', 'user.name', 't');
    git(main, 'config', 'user.email', 't@t.test');
    mkdirSync(join(main, 'apps'), { recursive: true });
    for (const [name, body] of [['admin.py', 'x = 1\n'], ['models.py', 'y = 1\n'], ['old_name.py', 'z = 1\n'], ['dead.py', 'd = 1\n'], ['café.py', 'c = 1\n'], ['ports.js', 'port = 8000\n']]) {
      writeFileSync(join(main, 'apps', name!), body!);
    }
    git(main, 'add', '.');
    git(main, 'commit', '-qm', 'base');
    const wt = join(root, 'wt');
    git(main, 'worktree', 'add', '-q', '-b', 'oneshot/ticket-1', wt);
    run({ main, wt, head: git(wt, 'rev-parse', 'HEAD') });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const asideRefs = (main: string): string[] =>
  git(main, 'for-each-ref', '--format=%(refname)', 'refs/oneshot/aside').split('\n').filter(Boolean);
const clean = (wt: string): string => git(wt, 'status', '--porcelain', '--untracked-files=no');

test('status paths are read NUL-separated: a rename gives both sides, and no name is quoted', () => {
  assert.deepEqual(porcelainPaths(' M apps/admin.py\0R  apps/new.py\0apps/old.py\0D  apps/dead.py\0 M apps/café.py\0'),
    ['apps/admin.py', 'apps/new.py', 'apps/old.py', 'apps/dead.py', 'apps/café.py']);
  assert.deepEqual(porcelainPaths(''), []);
});

test('a clean tree has nothing to set aside', () => fixture(({ main, wt }) => {
  assert.deepEqual(setAsideUncommitted(wt, 'r-1 review-fix lap 1'), []);
  assert.deepEqual(asideRefs(main), []);
}));

test('staged and unstaged edits leave the tree, are kept, and never touch the shared stash stack', () => fixture(({ main, wt, head }) => {
  writeFileSync(join(wt, 'apps', 'admin.py'), 'x = 2  # the fix, never committed\n');
  git(wt, 'add', 'apps/admin.py');
  writeFileSync(join(wt, 'apps', 'models.py'), 'y = 2\n');
  // Somebody's own stash, on the stack every worktree of this repo shares.
  writeFileSync(join(main, 'apps', 'dead.py'), 'd = 99\n');
  git(main, 'stash', 'push', '-q', '-m', 'a person\'s own work');
  const stackBefore = git(main, 'stash', 'list');

  const moved = setAsideUncommitted(wt, 'r-1 review-fix lap 1');

  assert.deepEqual(moved.sort(), ['apps/admin.py', 'apps/models.py']);
  assert.equal(readFileSync(join(wt, 'apps', 'admin.py'), 'utf8'), 'x = 1\n');
  assert.equal(readFileSync(join(wt, 'apps', 'models.py'), 'utf8'), 'y = 1\n');
  assert.equal(clean(wt), '');
  assert.equal(git(wt, 'rev-parse', 'HEAD'), head);
  assert.equal(git(main, 'stash', 'list'), stackBefore, 'the shared stack is exactly as it was');
  const refs = asideRefs(main);
  assert.equal(refs.length, 1);
  assert.match(refs[0]!, /^refs\/oneshot\/aside\/r-1-review-fix-lap-1-[0-9a-f]{8}$/);
  // And it comes back, staged part and all.
  git(wt, 'stash', 'apply', '--index', '-q', refs[0]!);
  assert.equal(readFileSync(join(wt, 'apps', 'admin.py'), 'utf8'), 'x = 2  # the fix, never committed\n');
  assert.match(git(wt, 'status', '--porcelain'), /^M  apps\/admin\.py\n M apps\/models\.py$/);
}));

test('a staged rename is moved whole — no deletion is left in the index for the next commit to carry', () => fixture(({ wt, head }) => {
  git(wt, 'mv', 'apps/old_name.py', 'apps/new_name.py');
  writeFileSync(join(wt, 'apps', 'admin.py'), 'x = 2\n');

  const moved = setAsideUncommitted(wt, 'r-1 review-fix lap 1');

  assert.deepEqual(moved.sort(), ['apps/admin.py', 'apps/new_name.py', 'apps/old_name.py']);
  assert.equal(git(wt, 'status', '--porcelain'), '', 'neither half of the rename is left behind');
  assert.ok(existsSync(join(wt, 'apps', 'old_name.py')));
  assert.ok(!existsSync(join(wt, 'apps', 'new_name.py')));
  // The next lap stages its own file by path and commits: only that file is in the commit.
  writeFileSync(join(wt, 'apps', 'models.py'), 'y = 3\n');
  git(wt, 'add', 'apps/models.py');
  git(wt, 'commit', '-qm', 'fix(review): next lap');
  assert.equal(git(wt, 'diff', '--name-status', head, 'HEAD'), 'M\tapps/models.py');
}));

test('a staged deletion, a non-ASCII name and a new staged file are all moved in one go', () => fixture(({ main, wt }) => {
  git(wt, 'rm', '-q', 'apps/dead.py');
  writeFileSync(join(wt, 'apps', 'café.py'), 'c = 2\n');
  writeFileSync(join(wt, 'apps', 'brand_new.py'), 'n = 1\n');
  git(wt, 'add', 'apps/brand_new.py');
  writeFileSync(join(wt, 'apps', 'admin.py'), 'x = 2\n');

  const moved = setAsideUncommitted(wt, 'r-1 review-fix lap 2');

  assert.deepEqual(moved.sort(), ['apps/admin.py', 'apps/brand_new.py', 'apps/café.py', 'apps/dead.py'].sort());
  assert.equal(git(wt, 'status', '--porcelain'), '');
  assert.ok(existsSync(join(wt, 'apps', 'dead.py')), 'the deleted file is back');
  assert.ok(!existsSync(join(wt, 'apps', 'brand_new.py')), 'the file that is not on the branch is gone from the tree');
  assert.equal(readFileSync(join(wt, 'apps', 'café.py'), 'utf8'), 'c = 1\n');
  assert.equal(asideRefs(main).length, 1);
}));

test('a file the lap created and never staged is moved; one that was there before is not', () => fixture(({ wt }) => {
  mkdirSync(join(wt, '.verify-scratch'), { recursive: true });
  writeFileSync(join(wt, '.verify-scratch', 'driver.js'), 'left by verify\n');
  const before = untrackedFiles(wt);
  // The lap: one new test file it forgot to add, nothing else.
  writeFileSync(join(wt, 'apps', 'test_new.py'), 'def test(): pass\n');
  const created = createdUntracked(before, untrackedFiles(wt));
  assert.deepEqual(created, ['apps/test_new.py']);

  const moved = setAsideUncommitted(wt, 'r-1 review-fix lap 1', created);

  assert.deepEqual(moved, ['apps/test_new.py']);
  assert.ok(!existsSync(join(wt, 'apps', 'test_new.py')));
  assert.ok(existsSync(join(wt, '.verify-scratch', 'driver.js')), 'what was untracked before the lap stays');
  assert.equal(git(wt, 'status', '--porcelain', '--untracked-files=no'), '');
}));

test('a file the harness keeps patched (skip-worktree) is not touched', () => fixture(({ wt }) => {
  writeFileSync(join(wt, 'apps', 'ports.js'), 'port = 8100\n');
  git(wt, 'update-index', '--skip-worktree', 'apps/ports.js');
  writeFileSync(join(wt, 'apps', 'admin.py'), 'x = 2\n');

  assert.deepEqual(setAsideUncommitted(wt, 'r-1 review-fix lap 1'), ['apps/admin.py']);

  assert.equal(readFileSync(join(wt, 'apps', 'ports.js'), 'utf8'), 'port = 8100\n');
  assert.equal(readFileSync(join(wt, 'apps', 'admin.py'), 'utf8'), 'x = 1\n');
}));

test('"created by the lap" is empty whenever the comparison cannot be trusted', () => {
  // The answer decides which files leave the tree; "every untracked file" is never it.
  assert.deepEqual(createdUntracked(null, ['a.py']), [], 'the listing before the lap failed');
  assert.deepEqual(createdUntracked(['a.py'], null), [], 'the listing after it failed');
  assert.deepEqual(createdUntracked([], ['vendor/lib/', 'apps/new.py']), ['apps/new.py'], 'a nested repository is not a file');
  const many = Array.from({ length: 300 }, (_, i) => `f${i}.py`);
  assert.deepEqual(createdUntracked([], many), [], 'hundreds at once is an ignore rule that changed, not a fix lap');
});

test('an intent-to-add entry does not stop the move, and nothing the conductor staged is left staged', () => fixture(({ wt }) => {
  writeFileSync(join(wt, 'apps', 'admin.py'), 'x = 2\n');
  writeFileSync(join(wt, 'apps', 'ita.py'), 'i = 1\n');
  git(wt, 'add', '-N', 'apps/ita.py');
  const before = untrackedFiles(wt);
  writeFileSync(join(wt, 'apps', 'helper.py'), 'h = 1\n');

  const moved = setAsideUncommitted(wt, 'r-1 review-fix lap 1', createdUntracked(before, untrackedFiles(wt)));

  assert.deepEqual(moved.sort(), ['apps/admin.py', 'apps/helper.py', 'apps/ita.py']);
  assert.equal(git(wt, 'status', '--porcelain'), '');
}));

test('when the move cannot be made, a file that was only untracked is not left in the index', () => fixture(({ wt, head }) => {
  // A nested repository with no commit makes `git add` of it die; an unmerged
  // path makes `stash create` refuse. Either way the conductor must not leave
  // its own staging behind for the next lap's commit to carry to the MR.
  const before = untrackedFiles(wt);
  writeFileSync(join(wt, 'apps', 'helper.py'), 'h = 1\n');
  mkdirSync(join(wt, 'scaffold'), { recursive: true });
  execFileSync('git', ['init', '-q', join(wt, 'scaffold')]);
  const created = createdUntracked(before, untrackedFiles(wt));
  assert.deepEqual(created, ['apps/helper.py'], 'the nested repository is not in the list at all');

  // Force the failure after the add: an unmerged path, which `stash create` refuses.
  writeFileSync(join(wt, 'apps', 'admin.py'), 'x = 2\n');
  const blob = git(wt, 'rev-parse', 'HEAD:apps/models.py');
  execFileSync('git', ['-C', wt, 'update-index', '--index-info'], {
    input: `100644 ${blob} 1\tapps/conflict.py\n100644 ${blob} 2\tapps/conflict.py\n`, stdio: ['pipe', 'pipe', 'pipe'],
  });

  setAsideUncommitted(wt, 'r-1 review-fix lap 1', created);

  assert.doesNotMatch(git(wt, 'status', '--porcelain'), /^A  apps\/helper\.py$/m, 'not staged by the conductor');
  assert.match(git(wt, 'status', '--porcelain'), /^\?\? apps\/helper\.py$/m, 'still merely untracked');
  assert.equal(git(wt, 'rev-parse', 'HEAD'), head);
}));

test('a tracked file replaced by a directory comes back as the file', () => fixture(({ wt }) => {
  rmSync(join(wt, 'apps', 'admin.py'));
  mkdirSync(join(wt, 'apps', 'admin.py'));
  const before: string[] = [];
  writeFileSync(join(wt, 'apps', 'admin.py', 'inner.py'), 'x = 3\n');

  const moved = setAsideUncommitted(wt, 'r-1 review-fix lap 1', createdUntracked(before, untrackedFiles(wt)));

  assert.ok(moved.includes('apps/admin.py'));
  assert.equal(git(wt, 'status', '--porcelain'), '');
  assert.equal(readFileSync(join(wt, 'apps', 'admin.py'), 'utf8'), 'x = 1\n');
}));

test('when the move fails after a tracked file was replaced by a directory, the index is exactly as the session left it', () => fixture(({ wt }) => {
  rmSync(join(wt, 'apps', 'admin.py'));
  mkdirSync(join(wt, 'apps', 'admin.py'));
  writeFileSync(join(wt, 'apps', 'admin.py', 'inner.py'), 'x = 3\n');
  const blob = git(wt, 'rev-parse', 'HEAD:apps/models.py');
  execFileSync('git', ['-C', wt, 'update-index', '--index-info'], {
    input: `100644 ${blob} 1\tapps/conflict.py\n100644 ${blob} 2\tapps/conflict.py\n`, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const before = git(wt, 'status', '--porcelain');

  assert.deepEqual(setAsideUncommitted(wt, 'r-1 review-fix lap 1', ['apps/admin.py/inner.py']), []);

  assert.equal(git(wt, 'status', '--porcelain'), before);
  assert.doesNotMatch(before, /^D  apps\/admin\.py$/m);
}));

test('a file whose name looks like a pattern is moved as the file it is', () => fixture(({ wt }) => {
  writeFileSync(join(wt, 'apps', 'a*.py'), 'star = 1\n');
  git(wt, '--literal-pathspecs', 'add', 'apps/a*.py');
  writeFileSync(join(wt, 'apps', 'admin.py'), 'x = 2\n');
  git(wt, 'add', 'apps/admin.py');
  git(wt, 'commit', '-qm', 'a file named like a glob, and admin at 2');
  writeFileSync(join(wt, 'apps', 'a*.py'), 'star = 2\n');

  assert.deepEqual(setAsideUncommitted(wt, 'r-1 review-fix lap 1'), ['apps/a*.py']);

  assert.equal(readFileSync(join(wt, 'apps', 'a*.py'), 'utf8'), 'star = 1\n');
  assert.equal(readFileSync(join(wt, 'apps', 'admin.py'), 'utf8'), 'x = 2\n', 'a file the pattern would also match is untouched');
}));

test('a directory that is not a git checkout is reported as nothing moved, not thrown', () => {
  assert.deepEqual(setAsideUncommitted(join(tmpdir(), 'oneshot-aside-nowhere'), 'r-1 x'), []);
});

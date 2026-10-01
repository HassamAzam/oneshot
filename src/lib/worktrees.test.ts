import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readlinkSync } from 'node:fs';
import { answerKeyCommits, detachTrackedClaude, runForkPoint, seedWorktree } from './worktrees.js';
import { SKILLS_ROOT } from './config.js';

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A checkout that COMMITS `.claude`, the way the work repo does. */
function repoWithCommittedClaude(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oneshot-wt-'));
  git(['init', '-q', '-b', 'dev'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  mkdirSync(join(dir, '.claude', 'skills', 'frontend-accessibility'), { recursive: true });
  mkdirSync(join(dir, '.claude', 'rules'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'skills', 'frontend-accessibility', 'SKILL.md'), 'work repo copy\n');
  writeFileSync(join(dir, '.claude', 'rules', 'security.md'), 'work repo rules\n');
  writeFileSync(join(dir, 'README.md'), 'app\n');
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'app with committed .claude'], dir);
  return dir;
}

test('the work repo\'s committed .claude is cleared so ours can take its place', () => {
  const dir = repoWithCommittedClaude();
  try {
    assert.ok(existsSync(join(dir, '.claude', 'skills', 'frontend-accessibility', 'SKILL.md')));

    detachTrackedClaude(dir);

    // Gone from the working tree, so ensureClaudeDir() composes onto a clean
    // slate instead of finding a real directory at every name and backing off.
    assert.ok(!existsSync(join(dir, '.claude')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('git does not see the removal, so it cannot reach a commit or an MR diff', () => {
  const dir = repoWithCommittedClaude();
  try {
    detachTrackedClaude(dir);
    assert.equal(git(['status', '--porcelain'], dir), '');
    // Still in the index and still in HEAD — we shadow the checkout, we do not
    // delete the work repo's files.
    assert.match(git(['ls-files', '.claude'], dir), /skills\/frontend-accessibility\/SKILL\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a second lease over the same worktree is a no-op', () => {
  const dir = repoWithCommittedClaude();
  try {
    detachTrackedClaude(dir);
    mkdirSync(join(dir, '.claude', 'skills'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'skills', 'ours.md'), 'composed by oneshot\n');

    detachTrackedClaude(dir);

    assert.equal(git(['status', '--porcelain'], dir), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a skill the work repo also ships still resolves to THIS repo\'s copy', () => {
  // The requirement in one assertion: a phase invokes the skill that lives
  // here, whatever the work repo happens to have committed under the same name.
  const dir = repoWithCommittedClaude();
  try {
    seedWorktree(dir);

    const entry = join(dir, '.claude', 'skills', 'frontend-accessibility');
    assert.equal(
      readlinkSync(entry),
      join(SKILLS_ROOT, 'skills', 'frontend-accessibility'),
      'the work repo\'s committed copy must not shadow ours',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('seeding again — as a resumed run does — picks up a skill changed since', () => {
  const dir = repoWithCommittedClaude();
  try {
    seedWorktree(dir);
    // Whatever a first seed produced, a second must still leave the link
    // pointing here. This is the resume path: the worktree already exists, and
    // the files behind it may have moved on.
    seedWorktree(dir);

    const entry = join(dir, '.claude', 'skills', 'frontend-accessibility');
    assert.equal(readlinkSync(entry), join(SKILLS_ROOT, 'skills', 'frontend-accessibility'));
    assert.equal(git(['status', '--porcelain'], dir), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('what we compose stays out of git status in a LINKED worktree', () => {
  // The exclude git consults lives in the common dir, not in
  // .git/worktrees/<name>/. Writing the right file to the wrong path left every
  // composed symlink showing as untracked, one `git add -A` from an MR.
  const main = repoWithCommittedClaude();
  const linked = join(main, '..', `wt-${Date.now()}`);
  try {
    git(['worktree', 'add', '-q', '--detach', linked], main);

    seedWorktree(linked);

    assert.equal(git(['status', '--porcelain'], linked), '');
  } finally {
    try { git(['worktree', 'remove', '--force', linked], main); } catch { /* best effort */ }
    rmSync(main, { recursive: true, force: true });
    rmSync(linked, { recursive: true, force: true });
  }
});

test('a checkout that does not commit .claude is left alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oneshot-wt-'));
  try {
    git(['init', '-q', '-b', 'dev'], dir);
    git(['config', 'user.email', 'test@example.com'], dir);
    git(['config', 'user.name', 'Test'], dir);
    writeFileSync(join(dir, 'README.md'), 'app\n');
    git(['add', '-A'], dir);
    git(['commit', '-qm', 'app'], dir);
    mkdirSync(join(dir, '.claude', 'skills'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'skills', 'ours.md'), 'composed by oneshot\n');

    detachTrackedClaude(dir);

    assert.ok(existsSync(join(dir, '.claude', 'skills', 'ours.md')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A repo with `dev`, a branch cut from it, and a settable origin/dev. */
function repoWithBranch(): { dir: string; base: string; tip: string } {
  const dir = mkdtempSync(join(tmpdir(), 'oneshot-fp-'));
  git(['init', '-q', '-b', 'dev'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  writeFileSync(join(dir, 'a.txt'), 'base\n');
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'base'], dir);
  const base = git(['rev-parse', 'HEAD'], dir);
  git(['checkout', '-q', '-b', 'oneshot/ticket-1-x'], dir);
  writeFileSync(join(dir, 'a.txt'), 'the fix\n');
  git(['commit', '-qam', 'the fix the plan is scored on finding'], dir);
  const tip = git(['rev-parse', 'HEAD'], dir);
  git(['update-ref', 'refs/remotes/origin/dev', base], dir);
  return { dir, base, tip };
}

test('runForkPoint returns where the branch left the base, not its tip', () => {
  const { dir, base, tip } = repoWithBranch();
  try {
    const got = runForkPoint('oneshot/ticket-1-x', dir);
    assert.equal(got, base);
    assert.notEqual(got, tip);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runForkPoint refuses a branch the base already contains, rather than returning its tip', () => {
  // Once the run's MR lands, merge-base(branch, base) IS the branch tip, so the
  // replay would build its worktree on top of the implementation it is meant to
  // be re-planning from scratch. Wrong silently is the one outcome a
  // measurement rig cannot have.
  const { dir, tip } = repoWithBranch();
  try {
    git(['update-ref', 'refs/remotes/origin/dev', tip], dir);

    assert.throws(
      () => runForkPoint('oneshot/ticket-1-x', dir),
      /contained in/,
      'a landed branch must not silently yield its own tip',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------- the replay declares what it can see

/** A repo where the ticket's fix has LANDED on dev, as it has for any finished run. */
function repoWithLandedFix(iid: number): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), 'oneshot-ak-'));
  git(['init', '-q', '-b', 'dev'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  writeFileSync(join(dir, 'a.txt'), 'base\n');
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'unrelated groundwork'], dir);
  const base = git(['rev-parse', 'HEAD'], dir);
  writeFileSync(join(dir, 'a.txt'), 'the fix\n');
  git(['commit', '-qam', `fix: give the page a title (#${iid})`], dir);
  git(['update-ref', 'refs/remotes/origin/dev', git(['rev-parse', 'HEAD'], dir)], dir);
  return { dir, base };
}

test('a fix that landed after the base is reported as reachable', () => {
  // The worktree is detached at `base`, but `git worktree add` shares the object
  // store: `git log --all --grep` still reaches the fix. The run has to say so.
  const { dir, base } = repoWithLandedFix(189);
  try {
    const got = answerKeyCommits(189, base, dir);
    assert.equal(got.length, 1);
    assert.match(got[0] ?? '', /give the page a title \(#189\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a ticket with no commits naming it has no answer key to find', () => {
  const { dir, base } = repoWithLandedFix(189);
  try {
    assert.deepEqual(answerKeyCommits(256, base, dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a source run\'s own unlanded branch is an answer key at its fork point', () => {
  // The default path, with no --base: runForkPoint answers for a branch that
  // never landed, and that branch still sits in the shared repo carrying the
  // `(#77)` commits implement wrote. Reading "never landed" as "blind" is the
  // mistake this pins.
  const { dir, base } = repoWithLandedFix(189);
  try {
    git(['checkout', '-qb', 'oneshot/ticket-77-x', base], dir);
    writeFileSync(join(dir, 'b.txt'), 'the run\'s own implementation\n');
    git(['add', 'b.txt'], dir);
    git(['commit', '-qm', 'fix: thing (#77)'], dir);
    git(['checkout', '-q', 'dev'], dir);

    const forkPoint = runForkPoint('oneshot/ticket-77-x', dir);
    assert.equal(forkPoint, base);
    const got = answerKeyCommits(77, forkPoint, dir);
    assert.equal(got.length, 1);
    assert.match(got[0] ?? '', /#77/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('history already inside the base is not an answer key', () => {
  // A commit the phase is entitled to read: it is part of what it checked out.
  const { dir } = repoWithLandedFix(189);
  try {
    const tip = git(['rev-parse', 'HEAD'], dir);
    assert.deepEqual(answerKeyCommits(189, tip, dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a ticket number that is a prefix of another does not match it', () => {
  // #18 must not be answered by #189's fix, or every low-numbered ticket reads
  // as contaminated and the warning stops meaning anything.
  const { dir, base } = repoWithLandedFix(189);
  try {
    assert.deepEqual(answerKeyCommits(18, base, dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

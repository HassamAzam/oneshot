import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detachTrackedClaude } from './worktrees.js';

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

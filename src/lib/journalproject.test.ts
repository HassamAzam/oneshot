/**
 * Run journals are keyed by ticket iid alone, and an iid is only unique within
 * a project. After GITLAB_REPO_URL moves, the previous project's journals are
 * still on disk under the same numbers; resuming one would drive the new
 * project's ticket in the old project's worktree against the old project's MR.
 * A journal written before the project stamp existed still names its project
 * in its ticket url, and that is what proves it ours — not its worktree, which
 * a prune, a crash or an unreadable WORK_REPO can take away.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgeJournalProject, worktreeFromWorkRepo } from './journalproject.js';

const ERP = 'gitlab.example.com/acme/erp';
const ERP_ISSUE = 'https://gitlab.example.com/acme/erp/-/issues/237';
const OLD_ISSUE = 'https://gitlab.example.com/acme/workstream/-/issues/237';

test('a journal stamped with this project is ours', () => {
  assert.deepEqual(judgeJournalProject({ project: ERP, url: ERP_ISSUE }, ERP, null), { kind: 'ours', adopt: false });
  assert.deepEqual(judgeJournalProject({ project: ERP, url: ERP_ISSUE, worktree: '/wt/t1' }, ERP, true), { kind: 'ours', adopt: false });
});

test('a journal stamped with another project is foreign, naming both', () => {
  const o = judgeJournalProject({ project: 'gitlab.example.com/acme/workstream', url: OLD_ISSUE }, ERP, null);
  assert.equal(o.kind, 'foreign');
  assert.match(o.kind === 'foreign' ? o.why : '', /acme\/workstream, not gitlab\.example\.com\/acme\/erp/);
});

test('an unstamped journal is adopted when its ticket url is this project, worktree or not', () => {
  // Worktree gone, never leased, or WORK_REPO unreadable: nothing to ask, the url decides.
  assert.deepEqual(judgeJournalProject({ url: ERP_ISSUE }, ERP, null), { kind: 'ours', adopt: true });
  assert.deepEqual(judgeJournalProject({ url: ERP_ISSUE, worktree: '/gone' }, ERP, null), { kind: 'ours', adopt: true });
  assert.deepEqual(judgeJournalProject({ url: ERP_ISSUE, worktree: '/wt/t237' }, ERP, true), { kind: 'ours', adopt: true });
});

test('an unstamped journal whose ticket is another project is foreign, even in a worktree of ours', () => {
  for (const ours of [true, null]) {
    const o = judgeJournalProject({ url: OLD_ISSUE, worktree: '/wt/t237' }, ERP, ours);
    assert.equal(o.kind, 'foreign');
    assert.match(o.kind === 'foreign' ? o.why : '', /acme\/workstream\/-\/issues\/237 is not in gitlab\.example\.com\/acme\/erp/);
  }
});

test('a worktree cut from another clone makes any journal foreign, stamped or not', () => {
  for (const j of [{ url: ERP_ISSUE, worktree: '/wt/t237' }, { project: ERP, url: ERP_ISSUE, worktree: '/wt/t237' }]) {
    const o = judgeJournalProject(j, ERP, false);
    assert.equal(o.kind, 'foreign', JSON.stringify(j));
    assert.match(o.kind === 'foreign' ? o.why : '', /\/wt\/t237 was not cut from WORK_REPO's clone/);
  }
});

test('worktreeFromWorkRepo answers only when both sides can be read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'journalproject-'));
  const git = (...args: string[]): void => {
    const r = spawnSync('git', args, { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  try {
    const main = join(dir, 'erp');
    const other = join(dir, 'other');
    for (const repo of [main, other]) {
      git('init', '-q', repo);
      git('-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
    }
    git('-C', main, 'worktree', 'add', '-q', join(dir, 'wt-main'));
    git('-C', other, 'worktree', 'add', '-q', join(dir, 'wt-other'));
    assert.equal(worktreeFromWorkRepo(join(dir, 'wt-main'), main), true);
    assert.equal(worktreeFromWorkRepo(join(dir, 'wt-other'), main), false);
    assert.equal(worktreeFromWorkRepo(join(dir, 'gone'), main), null);
    assert.equal(worktreeFromWorkRepo(undefined, main), null);
    assert.equal(worktreeFromWorkRepo(join(dir, 'wt-main'), join(dir, 'missing')), null);
    assert.equal(worktreeFromWorkRepo(join(dir, 'wt-main'), ''), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Run journals are keyed by ticket iid alone, and an iid is only unique within
 * a project. After GITLAB_REPO_URL moves, the previous project's journals are
 * still on disk under the same numbers; resuming one would drive the new
 * project's ticket in the old project's worktree against the old project's MR.
 *
 * Whose a journal is comes from its own record — the stamp, or for an older
 * journal its ticket url — and never from its worktree. A worktree cut from a
 * second clone of the same project is a perfectly good place to resume; calling
 * its journal foreign would archive the run and open a second MR. The worktree
 * is judged by PROJECT, and only decides whether an ours journal keeps it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  judgeJournalHome, judgeJournalProject, worktreeToResume, type JournalOwner,
} from './journalproject.js';
import { checkoutProject } from './repocheck.js';
import type { OriginProject } from './repourl.cjs';

const URL = 'https://gitlab.example.com/acme/erp';
const ERP = 'gitlab.example.com/acme/erp';
const ERP_ISSUE = 'https://gitlab.example.com/acme/erp/-/issues/237';
const OLD_ISSUE = 'https://gitlab.example.com/acme/workstream/-/issues/237';

const same = (): OriginProject => ({ kind: 'same' });
const unknown = (): OriginProject => ({ kind: 'unknown' });
const other = (): OriginProject => ({ kind: 'other', url: 'https://gitlab.example.com/acme/workstream.git' });
const never = (): OriginProject => { throw new Error('a foreign journal\'s worktree must not be read'); };

test('a journal stamped with this project is ours, and keeps a worktree of this project or of unknown origin', () => {
  assert.deepEqual(judgeJournalProject({ project: ERP, url: ERP_ISSUE }, ERP, never), { kind: 'ours', adopt: false });
  for (const wt of [same, unknown]) {
    assert.deepEqual(judgeJournalProject({ project: ERP, url: ERP_ISSUE, worktree: '/wt/t1' }, ERP, wt),
      { kind: 'ours', adopt: false });
  }
});

test('a journal stamped with another project is foreign, naming both, and its worktree is never read', () => {
  const o = judgeJournalProject({ project: 'gitlab.example.com/acme/workstream', url: OLD_ISSUE, worktree: '/wt/t1' }, ERP, never);
  assert.equal(o.kind, 'foreign');
  assert.match(o.kind === 'foreign' ? o.why : '', /acme\/workstream, not gitlab\.example\.com\/acme\/erp/);
});

test('an unstamped journal is adopted when its ticket url is this project, worktree or not', () => {
  assert.deepEqual(judgeJournalProject({ url: ERP_ISSUE }, ERP, never), { kind: 'ours', adopt: true });
  assert.deepEqual(judgeJournalProject({ url: ERP_ISSUE, worktree: '/gone' }, ERP, unknown), { kind: 'ours', adopt: true });
  assert.deepEqual(judgeJournalProject({ url: ERP_ISSUE, worktree: '/wt/t237' }, ERP, same), { kind: 'ours', adopt: true });
});

test('an unstamped journal with a ticket url elsewhere, no url, or one that does not parse is foreign', () => {
  const cases: Array<[string | undefined, RegExp]> = [
    [OLD_ISSUE, /acme\/workstream\/-\/issues\/237 is not in gitlab\.example\.com\/acme\/erp/],
    [undefined, /\(no url\) is not in/],
    ['', /\(no url\) is not in/],
    ['not a url at all', /not a url at all is not in/],
  ];
  for (const [url, why] of cases) {
    const j = { url: url as string, worktree: '/wt/t237' };
    const o = judgeJournalProject(j, ERP, never);
    assert.equal(o.kind, 'foreign', String(url));
    assert.match(o.kind === 'foreign' ? o.why : '', why, String(url));
    assert.deepEqual(judgeJournalHome(j, ERP), o, String(url));
  }
});

test('a worktree provably of another project never makes a journal foreign — it is dropped instead', () => {
  for (const j of [{ project: ERP, url: ERP_ISSUE, worktree: '/wt/t237' }, { url: ERP_ISSUE, worktree: '/wt/t237' }]) {
    const o = judgeJournalProject(j, ERP, other);
    assert.equal(o.kind, 'ours', JSON.stringify(j));
    assert.ok('dropWorktree' in o && o.dropWorktree, JSON.stringify(o));
    assert.equal(o.kind === 'ours' && o.adopt, !j.project);
    assert.match('why' in o ? o.why : '',
      /worktree \/wt\/t237 is a checkout of https:\/\/gitlab\.example\.com\/acme\/workstream\.git, not of gitlab\.example\.com\/acme\/erp/);
  }
});

/** A temp directory holding real git repos, removed afterwards. */
function withRepos(fn: (base: string, git: (...args: string[]) => void) => void): void {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'journalproject-')));
  const git = (...args: string[]): void => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  try { fn(base, git); } finally { rmSync(base, { recursive: true, force: true }); }
}

test('real repos: a worktree of a second clone of this project is kept; one of another project is dropped', () => {
  withRepos((base, git) => {
    // One project, reached through a local mirror whose own origin is the GitLab URL.
    const origin = join(base, 'origin.git');
    git('init', '-q', '--bare', origin);
    git('-C', origin, 'remote', 'add', 'origin', `${URL}.git`);
    const seed = join(base, 'seed');
    git('init', '-q', seed);
    git('-C', seed, 'commit', '-q', '--allow-empty', '-m', 'x');
    git('-C', seed, 'push', '-q', origin, 'HEAD:refs/heads/dev');
    const cloneA = join(base, 'cloneA');
    const cloneB = join(base, 'cloneB');
    git('clone', '-q', '-b', 'dev', origin, cloneA);
    git('clone', '-q', '-b', 'dev', origin, cloneB);
    const fromA = join(base, 'wt', 't237-r1');
    git('-C', cloneA, 'worktree', 'add', '-q', '-b', 'oneshot/237', fromA);

    // Another project entirely.
    const theirs = join(base, 'workstream');
    git('init', '-q', theirs);
    git('-C', theirs, 'commit', '-q', '--allow-empty', '-m', 'x');
    git('-C', theirs, 'remote', 'add', 'origin', 'git@gitlab.example.com:acme/workstream.git');
    const fromTheirs = join(base, 'wt', 't238-r2');
    git('-C', theirs, 'worktree', 'add', '-q', '--detach', fromTheirs);

    const notGit = join(base, 'wt', 't239-r3');
    mkdirSync(notGit, { recursive: true });

    const worktreeOf = (dir: string): OriginProject => checkoutProject(dir, URL);
    const stamped = { project: ERP, url: ERP_ISSUE };

    // WORK_REPO is cloneB; the run's worktree was cut from cloneA. Nothing here asks
    // which clone, only which project — both clones are this one.
    assert.deepEqual([cloneA, cloneB].map(worktreeOf), [{ kind: 'same' }, { kind: 'same' }]);
    const leaseAt = join(base, 'wt-root', 't237-r1');
    const kept = judgeJournalProject({ ...stamped, worktree: fromA }, ERP, worktreeOf);
    assert.deepEqual(kept, { kind: 'ours', adopt: false });
    assert.deepEqual(worktreeToResume({ worktree: fromA }, kept, leaseAt), { kind: 'keep', worktree: fromA });
    const adopted = judgeJournalProject({ url: ERP_ISSUE, worktree: fromA }, ERP, worktreeOf);
    assert.deepEqual(adopted, { kind: 'ours', adopt: true });
    assert.deepEqual(worktreeToResume({ worktree: fromA }, adopted, leaseAt), { kind: 'keep', worktree: fromA });

    const dropped = judgeJournalProject({ ...stamped, worktree: fromTheirs }, ERP, worktreeOf);
    assert.equal(dropped.kind, 'ours');
    assert.ok('dropWorktree' in dropped, JSON.stringify(dropped));
    assert.match('why' in dropped ? dropped.why : '', /is a checkout of git@gitlab\.example\.com:acme\/workstream\.git/);
    assert.equal(worktreeToResume({ worktree: fromTheirs }, dropped, leaseAt).kind, 'drop');

    // Unreadable or gone proves nothing: the journal is ours and keeps what it has.
    for (const wt of [notGit, join(base, 'wt', 'gone')]) {
      const o = judgeJournalProject({ ...stamped, worktree: wt }, ERP, worktreeOf);
      assert.deepEqual(o, { kind: 'ours', adopt: false }, wt);
      assert.notEqual(worktreeToResume({ worktree: wt }, o, leaseAt).kind, 'drop', wt);
    }
    assert.deepEqual(worktreeToResume({ worktree: notGit }, { kind: 'ours', adopt: false }, leaseAt), { kind: 'keep', worktree: notGit });

    // And a stamped-foreign journal stays foreign even in a worktree of this project.
    assert.equal(judgeJournalProject({ project: 'gitlab.example.com/acme/workstream', url: OLD_ISSUE, worktree: fromA },
      ERP, worktreeOf).kind, 'foreign');
  });
});

test('worktreeToResume keeps, re-leases, drops, or blocks — and never keeps another project\'s checkout', () => {
  withRepos((base) => {
    const here = join(base, 'wt', 't237-r1');
    mkdirSync(here, { recursive: true });
    const ours: JournalOwner = { kind: 'ours', adopt: false };
    const why = 'its recorded worktree is a checkout of x';
    const drop: JournalOwner = { kind: 'ours', adopt: false, dropWorktree: true, why };
    const leaseAt = join(base, 'wt-now', 't237-r1');

    assert.deepEqual(worktreeToResume({}, ours, leaseAt), { kind: 'none' });
    assert.deepEqual(worktreeToResume({ worktree: here }, ours, leaseAt), { kind: 'keep', worktree: here });
    assert.deepEqual(worktreeToResume({ worktree: here }, null, leaseAt), { kind: 'keep', worktree: here });
    const gone = join(base, 'wt', 'gone');
    assert.deepEqual(worktreeToResume({ worktree: gone }, ours, leaseAt), { kind: 'gone', was: gone });
    assert.deepEqual(worktreeToResume({ worktree: here }, drop, leaseAt), { kind: 'drop', was: here, why });

    // Where the re-lease would land is the dropped checkout itself: re-attaching would keep it.
    const blocked = worktreeToResume({ worktree: here }, drop, here);
    assert.equal(blocked.kind, 'block');
    assert.match(blocked.kind === 'block' ? blocked.why : '', /^worktree: its recorded worktree is a checkout of x, and it sits where this run's worktree is leased\. Move it aside/);
    // Through a symlinked root too.
    const alias = join(base, 'alias');
    symlinkSync(join(base, 'wt'), alias);
    assert.equal(worktreeToResume({ worktree: here }, drop, join(alias, 't237-r1')).kind, 'block');
  });
});

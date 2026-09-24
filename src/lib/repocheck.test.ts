/**
 * The checks that make GITLAB_REPO_URL the real single source of truth rather
 * than one opinion among several: a legacy selector left in .env may never move
 * the conductor, nor be quietly ignored when it disagrees, and a WORK_REPO cloned
 * from another project may never have worktrees cut from it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  checkoutFindings, identityFindings, judgeOrigin, judgeWtRoot, originFinding, readOrigin, wtRootFinding,
  type OriginRead,
} from './repocheck.js';

const URL = 'https://gitlab.example.com/acme/erp';

// ------------------------------------------------------------ the URL itself

test('an unset URL fails, and names the legacy lines that no longer select anything', () => {
  const [f, ...rest] = identityFindings({ GITLAB_REPO_URL: '', ONESHOT_PROJECT: 'erp' });
  assert.equal(f?.level, 'fail');
  assert.equal(f?.label, 'GITLAB_REPO_URL');
  assert.match(f?.detail ?? '', /GITLAB_REPO_URL is not set/);
  assert.match(f?.detail ?? '', /ONESHOT_PROJECT=erp is set but selects nothing/);
  // Nothing is judged against a URL that is not there.
  assert.deepEqual(rest, []);
});

test('an invalid URL fails with the parser\'s reason', () => {
  const [f] = identityFindings({ GITLAB_REPO_URL: 'https://gitlab.example.com/erp' });
  assert.equal(f?.level, 'fail');
  assert.match(f?.detail ?? '', /needs a namespace and a project/);
});

test('a good URL passes and says what it resolved to', () => {
  const found = identityFindings({ GITLAB_REPO_URL: URL });
  assert.deepEqual(found.map((f) => f.level), ['pass']);
  assert.match(found[0]?.detail ?? '', /acme\/erp on gitlab\.example\.com \(target 'erp'\)/);
});

// ----------------------------------------------------------- legacy selectors

test('a legacy selector that disagrees fails, naming both values and the line to delete', () => {
  const found = identityFindings({ GITLAB_REPO_URL: URL, ONESHOT_PROJECT: 'workstream' });
  const f = found.find((x) => x.level === 'fail');
  assert.equal(f?.label, 'ONESHOT_PROJECT conflicts with GITLAB_REPO_URL');
  assert.match(f?.detail ?? '', /ONESHOT_PROJECT=workstream/);
  assert.match(f?.detail ?? '', /gives erp/);
  assert.match(f?.detail ?? '', /delete that line from \.env/);
});

test('every legacy selector is judged, in either spelling', () => {
  const found = identityFindings({
    GITLAB_REPO_URL: URL,
    ONELOOP_GITLAB_PROJECT: 'acme/workstream',
    ONESHOT_GITLAB_API: 'https://gitlab.other.com/api/v4',
  });
  assert.deepEqual(found.filter((f) => f.level === 'fail').map((f) => f.label), [
    'ONELOOP_GITLAB_PROJECT conflicts with GITLAB_REPO_URL',
    'ONESHOT_GITLAB_API conflicts with GITLAB_REPO_URL',
  ]);
});

test('an agreeing legacy selector, and the unverifiable id, only warn to remove the line', () => {
  const found = identityFindings({
    GITLAB_REPO_URL: URL, ONESHOT_PROJECT: 'erp', ONESHOT_PROJECT_ID: '304',
  });
  assert.deepEqual(found.map((f) => [f.level, f.label]), [
    ['pass', 'GITLAB_REPO_URL'],
    ['warn', 'ONESHOT_PROJECT is redundant'],
    ['warn', 'ONESHOT_PROJECT_ID is redundant'],
  ]);
  assert.match(found[2]?.detail ?? '', /numeric id is asked of GitLab/);
});

test('blank legacy lines are not set at all', () => {
  const found = identityFindings({
    GITLAB_REPO_URL: URL, ONESHOT_PROJECT: '', ONESHOT_GITLAB_API: '', ONESHOT_PROJECT_ID: '',
  });
  assert.deepEqual(found.map((f) => f.level), ['pass']);
});

// ------------------------------------------------------------ WORK_REPO origin

test('an origin that is the same project, in any spelling, passes', () => {
  for (const url of ['git@gitlab.example.com:acme/erp.git', 'https://gitlab.example.com/Acme/ERP.git']) {
    assert.equal(judgeOrigin('WORK_REPO', URL, { url }).level, 'pass', url);
  }
});

test('an origin that is another project fails, naming both', () => {
  const f = judgeOrigin('WORK_REPO', URL, { url: 'git@gitlab.example.com:acme/workstream.git' });
  assert.equal(f.level, 'fail');
  assert.equal(f.label, 'WORK_REPO is a clone of another project');
  assert.match(f.detail, /git@gitlab\.example\.com:acme\/workstream\.git/);
  assert.match(f.detail, /https:\/\/gitlab\.example\.com\/acme\/erp/);
});

test('a prefix of the project name is another project', () => {
  assert.equal(judgeOrigin('WORK_REPO', URL, { url: 'git@gitlab.example.com:acme/erp-archive.git' }).level, 'fail');
});

test('an origin that cannot be read only warns — it proves nothing either way', () => {
  const f = judgeOrigin('WORK_REPO', URL, { error: "error: No such remote 'origin'" });
  assert.equal(f.level, 'warn');
  assert.match(f.detail, /No such remote/);
});

test('originFinding judges nothing without a URL or a directory', () => {
  const read = (): OriginRead => { throw new Error('must not be called'); };
  assert.equal(originFinding('WORK_REPO', tmpdir(), { GITLAB_REPO_URL: '' }, read), null);
  assert.equal(originFinding('WORK_REPO', '', { GITLAB_REPO_URL: URL }, read), null);
  assert.equal(originFinding('WORK_REPO', join(tmpdir(), 'no-such-dir-oneshot'), { GITLAB_REPO_URL: URL }, read), null);
  const f = originFinding('WORK_REPO', tmpdir(), { GITLAB_REPO_URL: URL },
    () => ({ url: 'git@gitlab.example.com:acme/erp.git' }));
  assert.equal(f?.level, 'pass');
});

test('readOrigin reports a real repo\'s origin, and never throws on a directory that is not one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oneshot-origin-'));
  try {
    const notRepo = readOrigin(dir);
    assert.ok('error' in notRepo);
    spawnSync('git', ['init', '-q', dir]);
    assert.ok('error' in readOrigin(dir), 'a repo with no origin');
    spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@gitlab.example.com:acme/erp.git']);
    assert.deepEqual(readOrigin(dir), { url: 'git@gitlab.example.com:acme/erp.git', pushUrls: [] });
    // A push URL is where the branches actually go, so it is read too.
    spawnSync('git', ['-C', dir, 'remote', 'set-url', '--push', 'origin', 'git@gitlab.example.com:acme/workstream.git']);
    assert.deepEqual(readOrigin(dir), {
      url: 'git@gitlab.example.com:acme/erp.git', pushUrls: ['git@gitlab.example.com:acme/workstream.git'],
    });
    const f = originFinding('WORK_REPO', dir, { GITLAB_REPO_URL: URL });
    assert.equal(f?.level, 'fail');
    assert.match(f?.detail ?? '', /pushes to git@gitlab\.example\.com:acme\/workstream\.git/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------- origin: edge cases

test('an origin that is not a GitLab URL and could not be followed only warns', () => {
  for (const url of ['/Users/x/Documents/erp', 'file:///Users/x/Documents/erp', '../erp']) {
    const f = judgeOrigin('WORK_REPO', URL, { url });
    assert.equal(f.level, 'warn', url);
    assert.equal(f.label, 'WORK_REPO origin unknown', url);
    assert.match(f.detail, /not a GitLab project URL/, url);
  }
});

test('the same path on another host only warns — an ssh alias is the right project by another name', () => {
  for (const url of ['git@gitlab-work:acme/erp.git', 'git@ssh.gitlab.example.com:acme/erp.git']) {
    const f = judgeOrigin('WORK_REPO', URL, { url });
    assert.equal(f.level, 'warn', url);
    assert.equal(f.label, 'WORK_REPO origin on another host', url);
    assert.match(f.detail, /ssh alias/, url);
  }
  // A different path is another project whatever the host.
  assert.equal(judgeOrigin('WORK_REPO', URL, { url: 'git@gitlab-work:acme/workstream.git' }).level, 'fail');
});

test('a local clone is followed to its own origin, and judged by that', () => {
  const root = mkdtempSync(join(tmpdir(), 'oneshot-localclone-'));
  try {
    const upstream = join(root, 'workstream');
    spawnSync('git', ['init', '-q', upstream]);
    spawnSync('git', ['-C', upstream, 'remote', 'add', 'origin', 'https://gitlab.example.com/acme/workstream.git']);
    const clone = join(root, 'erp-local');
    spawnSync('git', ['init', '-q', clone]);
    spawnSync('git', ['-C', clone, 'remote', 'add', 'origin', upstream]);

    const read = readOrigin(clone);
    assert.ok(!('error' in read));
    assert.equal(read.url, 'https://gitlab.example.com/acme/workstream.git');
    assert.deepEqual(read.via, [upstream]);
    const f = originFinding('WORK_REPO', clone, { GITLAB_REPO_URL: URL });
    assert.equal(f?.level, 'fail');
    assert.match(f?.detail ?? '', /the local clone .*workstream, whose origin is https:\/\/gitlab\.example\.com\/acme\/workstream/);

    // file:// and a local clone of the RIGHT project pass.
    spawnSync('git', ['-C', upstream, 'remote', 'set-url', 'origin', 'git@gitlab.example.com:acme/erp.git']);
    spawnSync('git', ['-C', clone, 'remote', 'set-url', 'origin', `file://${upstream}`]);
    assert.equal(originFinding('WORK_REPO', clone, { GITLAB_REPO_URL: URL })?.level, 'pass');

    // A chain that never reaches a GitLab URL stays a warning, never a crash.
    spawnSync('git', ['-C', upstream, 'remote', 'remove', 'origin']);
    assert.equal(originFinding('WORK_REPO', clone, { GITLAB_REPO_URL: URL })?.level, 'warn');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('following local clones stops after a few hops, even round a cycle', () => {
  const root = mkdtempSync(join(tmpdir(), 'oneshot-localcycle-'));
  try {
    const a = join(root, 'a');
    const b = join(root, 'b');
    for (const d of [a, b]) spawnSync('git', ['init', '-q', d]);
    spawnSync('git', ['-C', a, 'remote', 'add', 'origin', b]);
    spawnSync('git', ['-C', b, 'remote', 'add', 'origin', a]);
    const read = readOrigin(a);
    assert.ok(!('error' in read));
    assert.equal(judgeOrigin('WORK_REPO', URL, read).level, 'warn');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a push URL to another project fails even when the fetch URL is right', () => {
  const f = judgeOrigin('WORK_REPO', URL, {
    url: 'git@gitlab.example.com:acme/erp.git', pushUrls: ['git@gitlab.example.com:acme/workstream.git'],
  });
  assert.equal(f.level, 'fail');
  assert.match(f.detail, /pushes to git@gitlab\.example\.com:acme\/workstream\.git/);
  assert.match(f.detail, /remote\.origin\.pushurl/);
  assert.equal(judgeOrigin('WORK_REPO', URL, {
    url: 'git@gitlab.example.com:acme/erp.git', pushUrls: ['https://gitlab.example.com/acme/erp.git'],
  }).level, 'pass');
});

test('credentials in an origin never reach the finding', () => {
  const secret = 'https://oauth2:glpat-SECRET@gitlab.example.com/acme/';
  for (const url of [`${secret}erp.git`, `${secret}workstream.git`]) {
    const f = judgeOrigin('WORK_REPO', URL, { url });
    assert.doesNotMatch(f.detail, /SECRET|oauth2/, url);
  }
  const [id] = identityFindings({ GITLAB_REPO_URL: 'https://oauth2:glpat-SECRET@gitlab.example.com/acme/erp' });
  assert.equal(id?.level, 'pass');
  assert.doesNotMatch(id?.detail ?? '', /SECRET/);
});

test('the fix-it text names the line that actually chose the path', () => {
  const other = { url: 'git@gitlab.example.com:acme/workstream.git' };
  const scoped = judgeOrigin({
    label: 'WORK_REPO', dir: '/w', from: { path: '/w', source: 'scoped', key: 'ONESHOT_ERP_WORK_REPO' },
  }, URL, other);
  assert.match(scoped.detail, /delete the ONESHOT_ERP_WORK_REPO line/);
  assert.doesNotMatch(scoped.detail, /delete the WORK_REPO line/);

  const plain = judgeOrigin({ label: 'WORK_REPO', from: { path: '/w', source: 'plain', key: 'WORK_REPO' } }, URL, other);
  assert.match(plain.detail, /delete the WORK_REPO line from \.env to use the default/);

  // The derived default has no line to delete: the directory itself is wrong.
  const dflt = judgeOrigin({
    label: 'WORK_REPO', dir: '/home/x/Documents/erp', from: { path: '/home/x/Documents/erp', source: 'default', key: '' },
  }, URL, other);
  assert.match(dflt.detail, /^\/home\/x\/Documents\/erp: /);
  assert.match(dflt.detail, /move it aside and clone/);
  assert.doesNotMatch(dflt.detail, /delete/);
});

test('a seed from another project is told to point at a clone, never to delete the line', () => {
  const f = judgeOrigin({
    label: 'ONESHOT_SEED_FROM', from: { path: '/s', source: 'plain', key: 'ONESHOT_SEED_FROM' },
  }, URL, { url: 'git@gitlab.example.com:acme/workstream.git' });
  assert.equal(f.level, 'fail');
  assert.equal(f.label, 'ONESHOT_SEED_FROM is a clone of another project');
  assert.match(f.detail, /Point ONESHOT_SEED_FROM at an installed clone/);
  assert.match(f.detail, /Deleting the line is not the fix/);
});

test('checkoutFindings judges the seed as strictly as WORK_REPO, and only when it is a directory of its own', () => {
  const env = { GITLAB_REPO_URL: URL };
  const work = mkdtempSync(join(tmpdir(), 'oneshot-work-'));
  const seed = mkdtempSync(join(tmpdir(), 'oneshot-seed-'));
  const origins: Record<string, string> = {
    [work]: 'git@gitlab.example.com:acme/erp.git',
    [seed]: 'git@gitlab.example.com:acme/workstream.git',
  };
  const read = (d: string): OriginRead => ({ url: origins[d] ?? '' });
  const sources = {
    WORK_REPO: { path: work, source: 'default' as const, key: '' },
    ONESHOT_SEED_FROM: { path: seed, source: 'plain' as const, key: 'ONESHOT_SEED_FROM' },
  };
  try {
    assert.deepEqual(checkoutFindings({ workRepo: work, seed, sources }, env, read).map((f) => [f.level, f.label]), [
      ['pass', 'WORK_REPO origin'],
      ['fail', 'ONESHOT_SEED_FROM is a clone of another project'],
    ]);
    assert.deepEqual(checkoutFindings({ workRepo: work, seed: work, sources }, env, read).map((f) => f.label),
      ['WORK_REPO origin']);
    assert.deepEqual(checkoutFindings({ workRepo: work, seed: '', sources }, env, read).map((f) => f.label),
      ['WORK_REPO origin']);
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(seed, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ WT_ROOT

const plainWt = { path: '/r/oneshot-wt', source: 'plain' as const, key: 'WT_ROOT' };

test('a WT_ROOT holding another clone\'s worktrees fails, as scripts/app.cjs does, naming the line that set it', () => {
  const f = judgeWtRoot({
    wtRoot: '/r/oneshot-wt', from: plainWt, name: 'erp', clones: ['/r/erp/.git'],
    owners: [
      { dir: '/r/oneshot-wt/app-8010', gitDir: '/r/workstream/.git' },
      { dir: '/r/oneshot-wt/123', gitDir: '/r/erp/.git' },
    ],
  });
  assert.equal(f?.level, 'fail');
  assert.equal(f?.label, 'WT_ROOT is shared with another clone');
  assert.match(f?.detail ?? '', /\(from WT_ROOT\) holds 1 worktree\(s\) cut from \/r\/workstream\/\.git/);
  assert.match(f?.detail ?? '', /~\/Documents\/erp-wt/);
});

test('a hand-set WT_ROOT not named for the project warns softly; the derived default never does', () => {
  const f = judgeWtRoot({ wtRoot: '/r/oneshot-wt', from: plainWt, name: 'erp', clones: [], owners: [] });
  assert.equal(f?.label, 'WT_ROOT is not named for this project');
  assert.equal(judgeWtRoot({
    wtRoot: '/r/erp-wt', from: { ...plainWt, path: '/r/erp-wt' }, name: 'erp', clones: [], owners: [],
  }), null);
  assert.equal(judgeWtRoot({
    wtRoot: '/r/anything', from: { path: '/r/anything', source: 'default', key: '' }, name: 'erp',
    clones: ['/r/erp/.git'], owners: [{ dir: '/r/anything/1', gitDir: '/r/erp/.git' }],
  }), null);
});

test('a plain WT_ROOT the old overlay used to replace fails while ONESHOT_PROJECT is still set', () => {
  const erpWt = join(homedir(), 'Documents', 'erp-wt');
  const f = judgeWtRoot({
    wtRoot: '/r/oneshot-wt', from: plainWt, name: 'erp', clones: [], owners: [], overlayKey: 'ONESHOT_PROJECT',
  });
  assert.equal(f?.level, 'fail');
  assert.equal(f?.label, 'WT_ROOT moved when the project overlay went away');
  assert.match(f?.detail ?? '', /~\/Documents\/erp-wt/);
  assert.match(f?.detail ?? '', /Delete the WT_ROOT line/);
  // The derived root, a scoped line (it beat the overlay too), or no overlay line: nothing moved.
  assert.equal(judgeWtRoot({
    wtRoot: erpWt, from: { ...plainWt, path: erpWt }, name: 'erp', clones: [], owners: [], overlayKey: 'ONESHOT_PROJECT',
  }), null);
  assert.notEqual(judgeWtRoot({
    wtRoot: '/r/oneshot-wt', from: { ...plainWt, source: 'scoped', key: 'ONESHOT_ERP_WT_ROOT' }, name: 'erp',
    clones: [], owners: [], overlayKey: 'ONESHOT_PROJECT',
  })?.level, 'fail');
  assert.notEqual(judgeWtRoot({ wtRoot: '/r/oneshot-wt', from: plainWt, name: 'erp', clones: [], owners: [] })?.level,
    'fail');
  // Caught before the root exists, which is exactly when the move has not been noticed yet.
  const env = { GITLAB_REPO_URL: URL, ONESHOT_PROJECT: 'erp' };
  assert.equal(wtRootFinding('/no/such/oneshot-wt', { ...plainWt, path: '/no/such/oneshot-wt' }, 'erp', [], env)?.level,
    'fail');
  assert.equal(wtRootFinding('/no/such/oneshot-wt', { ...plainWt, path: '/no/such/oneshot-wt' }, 'erp', [],
    { GITLAB_REPO_URL: URL }), null);
});

test('wtRootFinding reads real worktrees and tells this project\'s clone from another', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'oneshot-wtroot-')));
  const git = (...a: string[]): void => { spawnSync('git', a, { encoding: 'utf8' }); };
  try {
    const mine = join(base, 'erp');
    const theirs = join(base, 'workstream');
    const root = join(base, 'shared-wt');
    for (const r of [mine, theirs]) {
      git('init', '-q', r);
      git('-C', r, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
    }
    mkdirSync(root);
    git('-C', mine, 'worktree', 'add', '-q', '--detach', join(root, '1'));
    assert.equal(wtRootFinding(root, { path: root, source: 'default', key: '' }, 'erp', [mine]), null);
    git('-C', theirs, 'worktree', 'add', '-q', '--detach', join(root, 'app-8010'));
    const f = wtRootFinding(root, { path: root, source: 'plain', key: 'WT_ROOT' }, 'erp', [mine]);
    assert.equal(f?.label, 'WT_ROOT is shared with another clone');
    assert.ok((f?.detail ?? '').includes(`cut from ${join(theirs, '.git')}`), f?.detail);
    assert.equal(wtRootFinding(join(base, 'no-such'), { path: '', source: 'default', key: '' }, 'erp', [mine]), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

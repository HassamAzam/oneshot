/**
 * The checks that make GITLAB_REPO_URL the real single source of truth rather
 * than one opinion among several: a legacy selector left in .env may never move
 * the conductor, nor be quietly ignored when it disagrees, and a WORK_REPO cloned
 * from another project may never have worktrees cut from it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  checkoutFindings, identityFindings, judgeOrigin, judgeWtRoot, originFinding, readOrigin, relaxRepoChecks,
  repoCheckOverrideNotice, sameDir, worktreeOwners, wtRootFinding, type Finding, type OriginProject, type OriginRead,
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
    assert.deepEqual(readOrigin(dir), { url: 'git@gitlab.example.com:acme/erp.git', pushUrls: [], remotes: [] });
    // A push URL is where the branches actually go, so it is read too.
    spawnSync('git', ['-C', dir, 'remote', 'set-url', '--push', 'origin', 'git@gitlab.example.com:acme/workstream.git']);
    assert.deepEqual(readOrigin(dir), {
      url: 'git@gitlab.example.com:acme/erp.git', pushUrls: ['git@gitlab.example.com:acme/workstream.git'], remotes: [],
    });
    const f = originFinding('WORK_REPO', dir, { GITLAB_REPO_URL: URL });
    assert.equal(f?.level, 'fail');
    assert.match(f?.detail ?? '', /pushes to git@gitlab\.example\.com:acme\/workstream\.git/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------- origin: forks, renames

const FORK = 'git@gitlab.example.com:someone/erp.git';

test('a fork as origin fails, names the remote that is the project, and gives the two renames', () => {
  const f = judgeOrigin({ label: 'WORK_REPO', dir: '/w', from: { path: '/w', source: 'plain', key: 'WORK_REPO' } }, URL, {
    url: FORK, remotes: [{ name: 'upstream', url: 'https://gitlab.example.com/acme/erp.git' }],
  });
  assert.equal(f.level, 'fail');
  assert.equal(f.label, 'WORK_REPO origin is a fork or another project');
  assert.match(f.detail, /someone\/erp\.git/);
  assert.match(f.detail, /remote 'upstream' \(https:\/\/gitlab\.example\.com\/acme\/erp\.git\) is the project/);
  assert.match(f.detail, /pushes ticket branches to origin and fetches the base branch from origin/);
  assert.ok(f.detail.includes('git -C /w remote rename origin fork && git -C /w remote rename upstream origin'), f.detail);
  assert.match(f.detail, /point WORK_REPO at a clone of/);
  assert.doesNotMatch(f.detail, /renamed or moved/);
  // An existing `fork` remote is not clobbered by the suggested rename.
  const taken = judgeOrigin({ label: 'WORK_REPO', dir: '/w' }, URL, {
    url: FORK, remotes: [{ name: 'fork', url: 'git@gitlab.example.com:x/y.git' }, { name: 'up', url: URL }],
  });
  assert.ok(taken.detail.includes('remote rename origin fork2 && git -C /w remote rename up origin'), taken.detail);
});

test('with no remote that is the project, the fix also covers a project renamed or moved on GitLab', () => {
  const ssh = judgeOrigin({ label: 'WORK_REPO', dir: '/w' }, URL, {
    url: 'git@gitlab.example.com:acme/workstream.git', remotes: [{ name: 'mirror', url: 'git@gitlab.example.com:x/y.git' }],
  });
  assert.equal(ssh.level, 'fail');
  assert.equal(ssh.label, 'WORK_REPO is a clone of another project');
  assert.ok(ssh.detail.includes('renamed or moved on GitLab'), ssh.detail);
  assert.ok(ssh.detail.includes('git -C /w remote set-url origin git@gitlab.example.com:acme/erp.git'), ssh.detail);
  // The set-url keeps the transport the checkout already uses.
  const https = judgeOrigin({ label: 'WORK_REPO', dir: '/w' }, URL, { url: 'https://gitlab.example.com/acme/old-erp.git' });
  assert.ok(https.detail.includes('remote set-url origin https://gitlab.example.com/acme/erp.git'), https.detail);
  const hint = (url: string): string => judgeOrigin({ label: 'WORK_REPO', dir: '/w' }, URL, { url }).detail;
  assert.ok(hint('ssh://git@gitlab.example.com:2222/oldgroup/erp.git')
    .includes('remote set-url origin ssh://git@gitlab.example.com:2222/acme/erp.git'), 'custom ssh port kept');
  assert.ok(hint('gl:oldgroup/erp.git').includes('remote set-url origin gl:acme/erp.git'), 'ssh alias kept');
  assert.ok(hint('https://oauth2:glpat-SECRET@gitlab.example.com:8443/old/erp.git')
    .includes('remote set-url origin https://gitlab.example.com:8443/acme/erp.git'), 'https port kept');
  assert.doesNotMatch(hint('https://oauth2:glpat-SECRET@gitlab.example.com/old/erp.git'), /SECRET|oauth2/);
  assert.ok(hint('git@github.com:someone/erp-old.git')
    .includes('remote set-url origin git@gitlab.example.com:acme/erp.git'), 'another host gets the project\'s own URL');
});

test('the remote named as the project is the one on GITLAB_REPO_URL\'s host, not a same-path mirror listed first', () => {
  const f = judgeOrigin({ label: 'WORK_REPO', dir: '/w' }, URL, {
    url: FORK, remotes: [
      { name: 'github', url: 'https://github.com/acme/erp.git' },
      { name: 'upstream', url: 'https://gitlab.example.com/acme/erp' },
    ],
  });
  assert.equal(f.level, 'fail');
  assert.ok(f.detail.includes("remote 'upstream'"), f.detail);
  assert.ok(f.detail.includes('git -C /w remote rename upstream origin'), f.detail);
  assert.doesNotMatch(f.detail, /rename github origin/);
  // With only the same path elsewhere, it is still named — with the host caveat.
  const only = judgeOrigin({ label: 'WORK_REPO', dir: '/w' }, URL, {
    url: FORK, remotes: [{ name: 'github', url: 'https://github.com/acme/erp.git' }],
  });
  assert.ok(only.detail.includes("remote rename github origin"), only.detail);
  assert.match(only.detail, /on host 'github\.com', not 'gitlab\.example\.com'/);
});

test('credentials in the other remotes are never echoed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oneshot-remotes-'));
  try {
    spawnSync('git', ['init', '-q', dir]);
    spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', FORK]);
    spawnSync('git', ['-C', dir, 'remote', 'add', 'upstream', 'https://oauth2:glpat-SECRET@gitlab.example.com/acme/erp.git']);
    spawnSync('git', ['-C', dir, 'remote', 'add', 'other', 'https://bot:glpat-OTHER@gitlab.example.com/x/y.git']);
    const read = readOrigin(dir);
    assert.ok(!('error' in read));
    assert.deepEqual(read.remotes, [
      { name: 'upstream', url: 'https://gitlab.example.com/acme/erp.git' },
      { name: 'other', url: 'https://gitlab.example.com/x/y.git' },
    ]);
    const f = originFinding('WORK_REPO', dir, { GITLAB_REPO_URL: URL });
    assert.equal(f?.level, 'fail');
    assert.match(f?.detail ?? '', /remote rename upstream origin/);
    assert.doesNotMatch(f?.detail ?? '', /SECRET|OTHER|oauth2|bot:/);
    // Even handed an unredacted read, the judgement redacts what it prints.
    const raw = judgeOrigin('WORK_REPO', URL, {
      url: FORK, remotes: [{ name: 'upstream', url: 'https://oauth2:glpat-SECRET@gitlab.example.com/acme/erp.git' }],
    });
    assert.doesNotMatch(raw.detail, /SECRET|oauth2/);
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
const SAME: OriginProject = { kind: 'same' };
const UNKNOWN: OriginProject = { kind: 'unknown' };
const WORKSTREAM: OriginProject = { kind: 'other', url: 'git@gitlab.example.com:acme/workstream.git' };
const DERIVED = join(homedir(), 'Documents', 'erp-wt');

test('a WT_ROOT holding another project\'s worktrees fails, naming that project and the line that set it', () => {
  const f = judgeWtRoot({
    wtRoot: '/r/oneshot-wt', from: plainWt, name: 'erp',
    owners: [
      { dir: '/r/oneshot-wt/app-8010', project: WORKSTREAM },
      { dir: '/r/oneshot-wt/t123-r1', project: SAME },
    ],
  });
  assert.equal(f?.level, 'fail');
  assert.equal(f?.label, 'WT_ROOT is shared with another project');
  assert.match(f?.detail ?? '', /\(from WT_ROOT\) holds 1 worktree\(s\) of git@gitlab\.example\.com:acme\/workstream\.git/);
  assert.match(f?.detail ?? '', /e\.g\. \/r\/oneshot-wt\/app-8010/);
  assert.match(f?.detail ?? '', /~\/Documents\/erp-wt, which deleting the WT_ROOT line gives/);
});

test('worktrees of any clone of this project, or of an origin that cannot be judged, never make WT_ROOT shared', () => {
  const erpWt = { ...plainWt, path: '/r/erp-wt' };
  const owners = [
    { dir: '/r/erp-wt/t1-r1', project: SAME },
    { dir: '/r/erp-wt/app-8010', project: SAME },
    { dir: '/r/erp-wt/t2-r2', project: UNKNOWN },
  ];
  assert.equal(judgeWtRoot({ wtRoot: '/r/erp-wt', from: erpWt, name: 'erp', owners }), null);
});

test('a hand-set WT_ROOT not named for the project warns softly; the derived default never does', () => {
  const f = judgeWtRoot({ wtRoot: '/r/oneshot-wt', from: plainWt, name: 'erp', owners: [] });
  assert.equal(f?.label, 'WT_ROOT is not named for this project');
  assert.equal(f?.level, 'warn');
  assert.equal(judgeWtRoot({
    wtRoot: '/r/erp-wt', from: { ...plainWt, path: '/r/erp-wt' }, name: 'erp', owners: [],
  }), null);
  assert.equal(judgeWtRoot({
    wtRoot: '/r/anything', from: { path: '/r/anything', source: 'default', key: '' }, name: 'erp',
    owners: [{ dir: '/r/anything/1', project: SAME }],
  }), null);
});

test('a WT_ROOT moved away from the derived root while it still holds this project\'s worktrees fails', () => {
  const moved = { wtRoot: '/r/oneshot-wt', from: plainWt, name: 'erp', owners: [] };
  const left = [{ dir: join(DERIVED, 't123-r1'), project: SAME }, { dir: join(DERIVED, 'app-8010'), project: SAME }];
  const f = judgeWtRoot({ ...moved, stranded: left });
  assert.equal(f?.level, 'fail');
  assert.equal(f?.label, 'WT_ROOT moved away from this project\'s worktrees');
  assert.match(f?.detail ?? '', /^WT_ROOT=\/r\/oneshot-wt is in force, but the default root ~\/Documents\/erp-wt still holds 2 worktree\(s\) of this project/);
  assert.ok((f?.detail ?? '').includes(`Delete the WT_ROOT line from .env to return to ${DERIVED}`), f?.detail);
  assert.match(f?.detail ?? '', /app-<port> server/);
  // A scoped line chose it: that line, and a plain one under it, are what to delete.
  const scoped = judgeWtRoot({ ...moved, from: { ...plainWt, source: 'scoped', key: 'ONESHOT_ERP_WT_ROOT' }, stranded: left });
  assert.equal(scoped?.level, 'fail');
  assert.match(scoped?.detail ?? '', /Delete the ONESHOT_ERP_WT_ROOT line \(and a plain WT_ROOT line, if any\)/);
});

test('what the derived root holds decides the move: nothing, another project\'s, or only unjudgeable ones', () => {
  const moved = { wtRoot: '/r/erp-elsewhere', from: { ...plainWt, path: '/r/erp-elsewhere' }, name: 'erp', owners: [] };
  assert.equal(judgeWtRoot({ ...moved, stranded: [] }), null);
  assert.equal(judgeWtRoot(moved), null);
  assert.equal(judgeWtRoot({ ...moved, stranded: [{ dir: join(DERIVED, 'app-8010'), project: WORKSTREAM }] }), null);
  // Maybe this project's (an ssh alias origin reads as unknown): the same advice, never a refusal.
  const w = judgeWtRoot({ ...moved, stranded: [{ dir: join(DERIVED, 't9-r9'), project: UNKNOWN }] });
  assert.equal(w?.level, 'warn');
  assert.equal(w?.label, 'WT_ROOT moved away from worktrees that may be this project\'s');
  assert.match(w?.detail ?? '', /origin cannot be matched/);
  assert.ok((w?.detail ?? '').includes(`Delete the WT_ROOT line from .env to return to ${DERIVED}`), w?.detail);
  // One provable worktree is enough to fail, whatever else is there.
  const mixed = judgeWtRoot({
    ...moved, stranded: [{ dir: join(DERIVED, 't9-r9'), project: UNKNOWN }, { dir: join(DERIVED, 't8-r8'), project: SAME }],
  });
  assert.equal(mixed?.level, 'fail');
  assert.ok((mixed?.detail ?? '').includes(join(DERIVED, 't8-r8')), mixed?.detail);
  // WT_ROOT IS the derived root: nothing moved.
  assert.equal(judgeWtRoot({
    wtRoot: DERIVED, from: { ...plainWt, path: DERIVED }, name: 'erp', owners: [],
    stranded: [{ dir: join(DERIVED, 't8-r8'), project: SAME }],
  }), null);
});

test('the move rule never hides a WT_ROOT holding another project\'s worktrees', () => {
  const f = judgeWtRoot({
    wtRoot: '/r/oneshot-wt', from: plainWt, name: 'erp',
    owners: [{ dir: '/r/oneshot-wt/app-8010', project: WORKSTREAM }],
    stranded: [{ dir: join(DERIVED, 't8-r8'), project: SAME }],
  });
  assert.equal(f?.level, 'fail');
  assert.equal(f?.label, 'WT_ROOT is shared with another project');
});

test('wtRootFinding gives the same verdict whether or not a legacy ONESHOT_PROJECT line is still set', () => {
  const gone = { ...plainWt, path: '/no/such/oneshot-wt' };
  const holding = (d: string) => (d === DERIVED ? [{ dir: join(DERIVED, 't8-r8'), project: SAME }] : []);
  const verdicts = [
    { GITLAB_REPO_URL: URL },
    { GITLAB_REPO_URL: URL, ONESHOT_PROJECT: 'erp' },
    { GITLAB_REPO_URL: URL, ONELOOP_PROJECT: 'erp' },
  ].map((env) => wtRootFinding('/no/such/oneshot-wt', gone, 'erp', env, holding));
  assert.equal(verdicts[0]?.level, 'fail');
  assert.equal(verdicts[0]?.label, 'WT_ROOT moved away from this project\'s worktrees');
  assert.deepEqual(verdicts[1], verdicts[0]);
  assert.deepEqual(verdicts[2], verdicts[0]);
});

test('wtRootFinding lists the derived root only when WT_ROOT is elsewhere, and judges nothing without a URL', () => {
  const listed: string[] = [];
  const empty = (d: string): [] => { listed.push(d); return []; };
  const env = { GITLAB_REPO_URL: URL };
  // Elsewhere and not created yet: the derived root is still looked at, and empty (or absent) is nothing.
  assert.equal(wtRootFinding('/no/such/oneshot-wt', { ...plainWt, path: '/no/such/oneshot-wt' }, 'erp', env, empty), null);
  assert.deepEqual(listed, [DERIVED]);
  // WT_ROOT is the derived root: listed once, as itself.
  listed.length = 0;
  wtRootFinding(DERIVED, { path: DERIVED, source: 'default', key: '' }, 'erp', env, empty);
  assert.ok(listed.every((d) => d === DERIVED) && listed.length <= 1, listed.join(', '));
  // No usable URL: nothing is listed and nothing is said (the URL's own FAIL says why).
  const never = (): never => { throw new Error('must not list'); };
  for (const bad of [{}, { GITLAB_REPO_URL: '' }, { GITLAB_REPO_URL: 'not a url' }]) {
    assert.equal(wtRootFinding('/r/oneshot-wt', plainWt, 'erp', bad, never), null, JSON.stringify(bad));
  }
});

/** Real repos under a temp dir: one project reached through two clones, and another project. */
function withProjects(fn: (p: {
  base: string; cloneA: string; cloneB: string; theirs: string; git: (...a: string[]) => void;
}) => void): void {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'oneshot-wtroot-')));
  const git = (...a: string[]): void => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  try {
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
    const theirs = join(base, 'workstream');
    git('init', '-q', theirs);
    git('-C', theirs, 'commit', '-q', '--allow-empty', '-m', 'x');
    git('-C', theirs, 'remote', 'add', 'origin', 'git@gitlab.example.com:acme/workstream.git');
    fn({ base, cloneA, cloneB, theirs, git });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test('wtRootFinding reads real worktrees by project: two clones of this one share a root, another project does not', () => {
  withProjects(({ base, cloneA, cloneB, theirs, git }) => {
    const root = join(base, 'erp-wt');
    mkdirSync(root);
    // The derived root is redirected into the temp dir, so the machine's real one is never read.
    const derived = join(base, 'derived-erp-wt');
    const list = (d: string, url: string) => worktreeOwners(d === DERIVED ? derived : d, url);
    const from = { path: root, source: 'plain' as const, key: 'WT_ROOT' };
    git('-C', cloneA, 'worktree', 'add', '-q', '--detach', join(root, 't1-r1'));
    git('-C', cloneB, 'worktree', 'add', '-q', '--detach', join(root, 'app-8010'));
    mkdirSync(join(root, 'not-a-worktree'));
    assert.deepEqual(worktreeOwners(root, URL).map((o) => o.project), [SAME, SAME]);
    assert.equal(wtRootFinding(root, from, 'erp', { GITLAB_REPO_URL: URL }, list), null);

    git('-C', theirs, 'worktree', 'add', '-q', '--detach', join(root, 'app-8011'));
    const f = wtRootFinding(root, from, 'erp', { GITLAB_REPO_URL: URL }, list);
    assert.equal(f?.level, 'fail');
    assert.equal(f?.label, 'WT_ROOT is shared with another project');
    assert.ok((f?.detail ?? '').includes(`holds 1 worktree(s) of git@gitlab.example.com:acme/workstream.git`), f?.detail);
    assert.ok((f?.detail ?? '').includes(join(root, 'app-8011')), f?.detail);
  });
});

test('wtRootFinding reads real worktrees left in the derived root, by project and not by clone', () => {
  withProjects(({ base, cloneA, theirs, git }) => {
    const derived = join(base, 'derived-erp-wt');
    mkdirSync(derived);
    const list = (d: string, url: string) => worktreeOwners(d === DERIVED ? derived : d, url);
    const elsewhere = join(base, 'elsewhere');
    const from = { path: elsewhere, source: 'plain' as const, key: 'WT_ROOT' };
    const env = { GITLAB_REPO_URL: URL };
    // Empty derived root, then one holding only another project's worktree: nothing to say.
    assert.equal(wtRootFinding(elsewhere, from, 'erp', env, list), null);
    git('-C', theirs, 'worktree', 'add', '-q', '--detach', join(derived, 'app-8011'));
    assert.equal(wtRootFinding(elsewhere, from, 'erp', env, list), null);
    // One of this project's, cut from a clone that is not WORK_REPO: the move strands it.
    git('-C', cloneA, 'worktree', 'add', '-q', '--detach', join(derived, 't5-r5'));
    const f = wtRootFinding(elsewhere, from, 'erp', env, list);
    assert.equal(f?.level, 'fail');
    assert.equal(f?.label, 'WT_ROOT moved away from this project\'s worktrees');
    assert.ok((f?.detail ?? '').includes(join(derived, 't5-r5')), f?.detail);
  });
});

test('a WT_ROOT that is a symlink to the derived root, or its target, has not moved', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'oneshot-wtlink-')));
  const home = process.env.HOME;
  try {
    process.env.HOME = base;
    const derived = join(base, 'Documents', 'erp-wt');
    const target = join(base, 'ssd', 'erp-wt');
    mkdirSync(target, { recursive: true });
    mkdirSync(join(base, 'Documents'));
    symlinkSync(target, derived);
    const holding = (d: string) => [{ dir: join(d, 't8-r8'), project: SAME }];
    const env = { GITLAB_REPO_URL: URL };
    assert.equal(wtRootFinding(target, { path: target, source: 'plain', key: 'WT_ROOT' }, 'erp', env, holding), null);
    // A different directory beside it has moved.
    const other = join(base, 'ssd', 'erp-wt-2');
    mkdirSync(other);
    assert.equal(wtRootFinding(other, { path: other, source: 'plain', key: 'WT_ROOT' }, 'erp', env, holding)?.level, 'fail');
  } finally {
    if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
    rmSync(base, { recursive: true, force: true });
  }
});

test('a WT_ROOT naming the derived root in another letter case, on a case-insensitive disk, has not moved', (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'oneshot-wtcase-')));
  const home = process.env.HOME;
  try {
    const derived = join(base, 'Documents', 'erp-wt');
    mkdirSync(derived, { recursive: true });
    const lower = join(base, 'documents', 'erp-wt');
    if (!existsSync(lower)) { t.skip('the temp filesystem is case-sensitive'); return; }
    assert.ok(sameDir(lower, derived));
    process.env.HOME = base;
    const holding = (d: string) => [{ dir: join(d, 't9-r9'), project: SAME }];
    const from = { path: lower, source: 'plain' as const, key: 'WT_ROOT' };
    assert.equal(wtRootFinding(lower, from, 'erp', { GITLAB_REPO_URL: URL }, holding), null);
  } finally {
    if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
    rmSync(base, { recursive: true, force: true });
  }
});

// ------------------------------------------------- ONESHOT_SKIP_REPO_CHECK

const OVERRIDE = { ONESHOT_SKIP_REPO_CHECK: '1' };

test('the override turns every repo-check FAIL into a WARN, keeping its text behind the variable\'s name', () => {
  const conflict = identityFindings({ GITLAB_REPO_URL: URL, ONESHOT_PROJECT: 'workstream' });
  const origin = judgeOrigin('WORK_REPO', URL, { url: 'git@gitlab.example.com:acme/workstream.git' });
  const shared = judgeWtRoot({
    wtRoot: '/r/oneshot-wt', from: plainWt, name: 'erp',
    owners: [{ dir: '/r/oneshot-wt/app-8010', project: WORKSTREAM }],
  });
  const moved = judgeWtRoot({
    wtRoot: '/r/oneshot-wt', from: plainWt, name: 'erp', owners: [],
    stranded: [{ dir: join(DERIVED, 't1-r1'), project: SAME }],
  });
  const fails = [...conflict.filter((f) => f.level === 'fail'), origin, shared, moved] as Finding[];
  assert.equal(fails.length, 4);
  assert.ok(fails.every((f) => f.level === 'fail'));
  const relaxed = relaxRepoChecks(fails, OVERRIDE);
  relaxed.forEach((r, i) => {
    assert.equal(r.level, 'warn', r.label);
    assert.equal(r.label, fails[i]?.label);
    assert.equal(r.detail, `ONESHOT_SKIP_REPO_CHECK is set — not refusing: ${fails[i]?.detail}`);
  });
  // PASS and WARN findings are untouched, and the input is not mutated.
  const pass = conflict.find((f) => f.level === 'pass') as Finding;
  assert.deepEqual(relaxRepoChecks([pass], OVERRIDE), [pass]);
  assert.equal(fails[0]?.level, 'fail');
});

test('the override never excuses a missing or invalid GITLAB_REPO_URL', () => {
  for (const url of ['', 'not a url']) {
    const env = { GITLAB_REPO_URL: url, ...OVERRIDE };
    const [f] = relaxRepoChecks(identityFindings(env), env);
    assert.equal(f?.level, 'fail', url);
    assert.doesNotMatch(f?.detail ?? '', /not refusing/);
  }
});

test('the override is parsed like any flag, in either spelling, and off changes nothing', () => {
  const origin = judgeOrigin('WORK_REPO', URL, { url: 'git@gitlab.example.com:acme/workstream.git' });
  for (const v of ['1', 'true', 'YES', 'on']) {
    assert.equal(relaxRepoChecks([origin], { ONESHOT_SKIP_REPO_CHECK: v })[0]?.level, 'warn', v);
  }
  const legacy = relaxRepoChecks([origin], { ONELOOP_SKIP_REPO_CHECK: 'true' })[0];
  assert.equal(legacy?.level, 'warn');
  assert.match(legacy?.detail ?? '', /^ONELOOP_SKIP_REPO_CHECK is set — not refusing: /);
  for (const env of [{}, { ONESHOT_SKIP_REPO_CHECK: '' }, { ONESHOT_SKIP_REPO_CHECK: '0' }, { ONESHOT_SKIP_REPO_CHECK: 'no' }]) {
    assert.deepEqual(relaxRepoChecks([origin], env), [origin], JSON.stringify(env));
    assert.equal(repoCheckOverrideNotice(env), null, JSON.stringify(env));
  }
  assert.equal(repoCheckOverrideNotice(OVERRIDE), 'repo checks downgraded by ONESHOT_SKIP_REPO_CHECK — remove it once fixed');
});

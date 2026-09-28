/**
 * GITLAB_REPO_URL is the single statement of which project Oneshot works on, so
 * its parser is the one piece of configuration code whose mistakes cannot be
 * caught by a second source: every host, API call, path default and origin check
 * downstream is derived from what it returns. It is also typed into .env by a
 * person, from whatever URL they had open — hence the breadth of shapes below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  envEntry, isPlaceholder, legacySelectors, localRemotePath, parseRepoUrl, readEnv, redactUrl, repoFromEnv, repoKey,
  resolvePath, resolveTarget, scopedEnvName,
} from './repourl.cjs';

const ROOT = '/opt/oneshot';

test('a plain web URL yields every derived field', () => {
  assert.deepEqual(parseRepoUrl('https://gitlab.example.com/acme/erp'), {
    url: 'https://gitlab.example.com/acme/erp',
    scheme: 'https',
    host: 'gitlab.example.com',
    hostname: 'gitlab.example.com',
    origin: 'https://gitlab.example.com',
    apiUrl: 'https://gitlab.example.com/api/v4',
    project: 'acme/erp',
    webUrl: 'https://gitlab.example.com/acme/erp',
    sshUrl: 'git@gitlab.example.com:acme/erp.git',
    name: 'erp',
  });
});

test('a trailing slash, a .git suffix and surrounding whitespace change nothing', () => {
  for (const raw of [
    'https://gitlab.example.com/acme/erp/',
    'https://gitlab.example.com/acme/erp.git',
    'https://gitlab.example.com/acme/erp.git/',
    '  https://gitlab.example.com/acme/erp  ',
    'https://gitlab.example.com/acme/erp?tab=readme#top',
  ]) {
    const r = parseRepoUrl(raw);
    assert.equal(r.project, 'acme/erp', raw);
    assert.equal(r.apiUrl, 'https://gitlab.example.com/api/v4', raw);
    assert.equal(r.name, 'erp', raw);
  }
});

test('a pasted browser URL is cut at /-/', () => {
  for (const raw of [
    'https://gitlab.example.com/acme/erp/-/issues/12',
    'https://gitlab.example.com/acme/erp/-/merge_requests/7/diffs',
    'https://gitlab.example.com/acme/erp/-/tree/dev',
    'https://gitlab.example.com/acme/erp/-',
  ]) {
    assert.equal(parseRepoUrl(raw).project, 'acme/erp', raw);
  }
});

test('an old-style browser URL without /-/ is refused, suggesting the project URL', () => {
  // Accepted, these parse as a deeper subgroup project named '12' or 'main', and
  // every later message (WORK_REPO ~/Documents/12, a correct ONESHOT_PROJECT=erp
  // reported as the conflict) points away from the real mistake.
  for (const [raw, seg] of [
    ['https://gitlab.example.com/acme/erp/issues/12', 'issues'],
    ['https://gitlab.example.com/acme/erp/merge_requests/7', 'merge_requests'],
    ['https://gitlab.example.com/acme/erp/tree/main', 'tree'],
    ['https://gitlab.example.com/acme/erp/blob/dev/README.md', 'blob'],
    ['https://gitlab.example.com/acme/sub/erp/commits/dev', 'commits'],
  ] as const) {
    assert.throws(() => parseRepoUrl(raw), (err: Error) => {
      assert.match(err.message, new RegExp(`'${seg}' is a GitLab page`), raw);
      assert.match(err.message, /did you mean https:\/\/gitlab\.example\.com\/acme\/(sub\/)?erp\?/, raw);
      return true;
    });
  }
  // A group page, with or without /-/, is not a project either.
  for (const raw of ['https://gitlab.example.com/groups/acme/-/issues', 'https://gitlab.example.com/projects/acme/erp']) {
    assert.throws(() => parseRepoUrl(raw), /is a GitLab page, not a project/, raw);
  }
  // The route names only count past the namespace/project prefix.
  assert.equal(parseRepoUrl('https://gitlab.example.com/issues/tracker').project, 'issues/tracker');
});

test('subgroups are part of the project path, and the name is the last segment', () => {
  const r = parseRepoUrl('https://gitlab.example.com/acme/platform/backend/erp-core/-/issues/3');
  assert.equal(r.project, 'acme/platform/backend/erp-core');
  assert.equal(r.webUrl, 'https://gitlab.example.com/acme/platform/backend/erp-core');
  assert.equal(r.name, 'erp-core');
});

test('the scp-style SSH clone URL means https on the same host', () => {
  const r = parseRepoUrl('git@gitlab.example.com:acme/erp.git');
  assert.equal(r.scheme, 'https');
  assert.equal(r.host, 'gitlab.example.com');
  assert.equal(r.apiUrl, 'https://gitlab.example.com/api/v4');
  assert.equal(r.webUrl, 'https://gitlab.example.com/acme/erp');
  assert.equal(r.project, 'acme/erp');
  assert.equal(parseRepoUrl('gitlab.example.com:acme/sub/erp').project, 'acme/sub/erp');
});

test('an ssh:// URL drops the SSH port — it belongs to sshd, not to the API', () => {
  const r = parseRepoUrl('ssh://git@gitlab.example.com:2222/acme/erp.git');
  assert.equal(r.host, 'gitlab.example.com');
  assert.equal(r.apiUrl, 'https://gitlab.example.com/api/v4');
  assert.equal(r.sshUrl, 'git@gitlab.example.com:acme/erp.git');
  assert.equal(parseRepoUrl('ssh://gitlab.example.com/acme/erp').project, 'acme/erp');
});

test('an http URL keeps its scheme, and an explicit https port is kept everywhere', () => {
  const http = parseRepoUrl('http://gitlab.internal/acme/erp');
  assert.equal(http.apiUrl, 'http://gitlab.internal/api/v4');
  assert.equal(http.webUrl, 'http://gitlab.internal/acme/erp');

  const port = parseRepoUrl('https://gitlab.example.com:8443/acme/erp');
  assert.equal(port.host, 'gitlab.example.com:8443');
  assert.equal(port.hostname, 'gitlab.example.com');
  assert.equal(port.apiUrl, 'https://gitlab.example.com:8443/api/v4');
  assert.equal(port.webUrl, 'https://gitlab.example.com:8443/acme/erp');
  // The clone hint uses SSH, which cannot carry the web port.
  assert.equal(port.sshUrl, 'git@gitlab.example.com:acme/erp.git');
});

test('the host is lower-cased; the path keeps its case but the name does not', () => {
  const r = parseRepoUrl('https://GitLab.Example.com/Acme/ERP');
  assert.equal(r.host, 'gitlab.example.com');
  assert.equal(r.project, 'Acme/ERP');
  assert.equal(r.name, 'erp');
});

test('unset, blank and placeholder values are refused, naming the variable', () => {
  for (const raw of ['', '   ']) {
    assert.throws(() => parseRepoUrl(raw), /GITLAB_REPO_URL is not set.*e\.g\. GITLAB_REPO_URL=https:\/\//);
  }
  for (const raw of ['REPLACE_ME', 'https://gitlab.example.com/<group>/<project>']) {
    assert.throws(() => parseRepoUrl(raw), /GITLAB_REPO_URL is still the placeholder/);
  }
});

test('placeholder words inside a real project URL are not the placeholder', () => {
  for (const raw of ['https://gitlab.example.com/acme/exchangemedia', 'https://gitlab.example.com/acme/your-shop-here']) {
    assert.equal(parseRepoUrl(raw).url, raw);
  }
});

test('any other env value carrying a template word counts as unset', () => {
  for (const v of ['someone@arbisoft.com:changeme', 'CHANGE_ME', 'xoxb-changeme', 'your-token-here', 'glpat-REPLACE_ME', 'a<project>b']) {
    assert.equal(isPlaceholder(v), true, v);
  }
  assert.equal(readEnv({ ONESHOT_TEST_LOGIN: 'someone@arbisoft.com:changeme' }, 'ONESHOT_TEST_LOGIN'), '');
  assert.equal(isPlaceholder('/srv/erp'), false);
});

test('anything that is not a project URL is refused with the reason and an example', () => {
  const cases: Array<[string, RegExp]> = [
    ['https://gitlab.example.com', /needs a namespace and a project/],
    ['https://gitlab.example.com/erp', /needs a namespace and a project/],
    ['ftp://gitlab.example.com/acme/erp', /unsupported scheme 'ftp'/],
    ['acme/erp', /neither an http\(s\) URL nor an SSH clone URL/],
    ['just some words', /neither an http\(s\) URL nor an SSH clone URL/],
    ['https://gitlab.example.com/acme/e rp', /not a valid GitLab path segment/],
    ['https://gitlab.example.com/acme/../erp', /needs a namespace|not a valid GitLab path segment/],
    // One slash, or none: read as scp form these would be SSH to a host called "https".
    ['https:/gitlab.example.com/acme/erp', /malformed URL — did you mean https:\/\//],
    ['https:gitlab.example.com/acme/erp', /malformed URL/],
    ['ssh:/git@gitlab.example.com/acme/erp.git', /malformed URL/],
  ];
  for (const [raw, why] of cases) {
    assert.throws(() => parseRepoUrl(raw), (err: Error) => {
      assert.match(err.message, /GITLAB_REPO_URL/, raw);
      assert.match(err.message, why, raw);
      assert.match(err.message, /e\.g\. GITLAB_REPO_URL=https:\/\/gitlab\.example\.com\/group\/project/, raw);
      return true;
    });
  }
});

test('credentials in a URL are never printed back', () => {
  assert.equal(redactUrl('https://oauth2:glpat-SECRET@gitlab.example.com/acme/erp.git'),
    'https://gitlab.example.com/acme/erp.git');
  // A bare token as the username is still a token.
  assert.equal(redactUrl('https://glpat-SECRET@gitlab.example.com/acme/erp'), 'https://gitlab.example.com/acme/erp');
  assert.equal(redactUrl('ssh://git:pw@gitlab.example.com/acme/erp.git'), 'ssh://gitlab.example.com/acme/erp.git');
  // An SSH user is not a secret, and an scp-form URL has no password to carry.
  assert.equal(redactUrl('ssh://git@gitlab.example.com:2222/acme/erp.git'), 'ssh://git@gitlab.example.com:2222/acme/erp.git');
  assert.equal(redactUrl('git@gitlab.example.com:acme/erp.git'), 'git@gitlab.example.com:acme/erp.git');
  assert.throws(() => parseRepoUrl('https://oauth2:glpat-SECRET@gitlab.example.com/erp'), (err: Error) => {
    assert.doesNotMatch(err.message, /SECRET/);
    return true;
  });
});

test('repoFromEnv never throws: it hands back the error instead', () => {
  assert.equal(repoFromEnv({ GITLAB_REPO_URL: 'https://gitlab.example.com/acme/erp' }).repo?.name, 'erp');
  const missing = repoFromEnv({});
  assert.equal(missing.repo, null);
  assert.match(missing.error ?? '', /GITLAB_REPO_URL is not set/);
  assert.match(repoFromEnv({ GITLAB_REPO_URL: 'nope' }).error ?? '', /not a GitLab project URL/);
});

// ------------------------------------------------------------ same project?

test('ssh and https spellings of one project are the same project', () => {
  const url = 'https://gitlab.example.com/acme/erp';
  for (const origin of [
    'git@gitlab.example.com:acme/erp.git',
    'git@gitlab.example.com:acme/erp',
    'ssh://git@gitlab.example.com:2222/acme/erp.git',
    'https://gitlab.example.com/acme/erp.git',
    'https://oauth2:tok@gitlab.example.com/acme/erp.git',
    'https://gitlab.example.com:443/acme/erp/',
    'git@GITLAB.example.com:Acme/ERP.git',
  ]) {
    assert.equal(repoKey(origin), repoKey(url), origin);
  }
});

test('a different project, host or a mere prefix is not the same project', () => {
  const url = 'https://gitlab.example.com/acme/erp';
  for (const origin of [
    'git@gitlab.example.com:acme/erp-archive.git',
    'git@gitlab.example.com:acme/workstream.git',
    'git@gitlab.example.com:other/erp.git',
    'git@gitlab.example.com:acme/sub/erp.git',
    'git@mirror.example.com:acme/erp.git',
    '/Users/someone/Documents/erp',
    '',
  ]) {
    assert.notEqual(repoKey(origin), repoKey(url), origin);
  }
});

test('an unparseable URL has no key, so cannot tell never reads as a match', () => {
  assert.equal(repoKey('not a url'), null);
  assert.equal(repoKey(''), null);
});

// ------------------------------------------------------------ env and paths

test('readEnv treats blank and placeholder values as unset and honours ONELOOP_', () => {
  assert.equal(readEnv({ X: '' }, 'X', 'd'), 'd');
  assert.equal(readEnv({ X: 'glpat-REPLACE_ME' }, 'X', 'd'), 'd');
  assert.equal(readEnv({ ONELOOP_SEED_FROM: '/a' }, 'ONESHOT_SEED_FROM'), '/a');
  assert.equal(readEnv({ ONESHOT_SEED_FROM: '/b', ONELOOP_SEED_FROM: '/a' }, 'ONESHOT_SEED_FROM'), '/b');
  assert.deepEqual(envEntry({ ONELOOP_SEED_FROM: '/a' }, 'ONESHOT_SEED_FROM'), { key: 'ONELOOP_SEED_FROM', value: '/a' });
  assert.equal(envEntry({ WORK_REPO: '' }, 'WORK_REPO'), null);
});

test('scopedEnvName strips a leading ONESHOT_, and has no spelling without a name', () => {
  assert.equal(scopedEnvName('erp', 'WORK_REPO'), 'ONESHOT_ERP_WORK_REPO');
  assert.equal(scopedEnvName('erp', 'ONESHOT_SEED_FROM'), 'ONESHOT_ERP_SEED_FROM');
  assert.equal(scopedEnvName('erp-core', 'WT_ROOT'), 'ONESHOT_ERP_CORE_WT_ROOT');
  assert.equal(scopedEnvName('', 'WORK_REPO'), '');
});

test('a path is scoped, else plain, else the default', () => {
  const opts = { name: 'erp', envName: 'WORK_REPO', fallback: '~/Documents/erp', root: ROOT };
  assert.deepEqual(resolvePath({}, opts),
    { path: join(homedir(), 'Documents', 'erp'), source: 'default', key: '' });
  assert.deepEqual(resolvePath({ WORK_REPO: '/srv/plain' }, opts),
    { path: '/srv/plain', source: 'plain', key: 'WORK_REPO' });
  assert.deepEqual(resolvePath({ WORK_REPO: '/srv/plain', ONESHOT_ERP_WORK_REPO: '/srv/scoped' }, opts),
    { path: '/srv/scoped', source: 'scoped', key: 'ONESHOT_ERP_WORK_REPO' });
  // Another project's scoped name is somebody else's line, not this one's.
  assert.equal(resolvePath({ ONESHOT_OTHER_WORK_REPO: '/srv/other' }, opts).source, 'default');
});

test('relative paths resolve against the Oneshot root, never the cwd, and trailing slashes go', () => {
  const opts = { name: 'erp', envName: 'WT_ROOT', fallback: '', root: ROOT };
  assert.equal(resolvePath({ WT_ROOT: 'wt' }, opts).path, '/opt/oneshot/wt');
  assert.equal(resolvePath({ WT_ROOT: '../wt/' }, opts).path, '/opt/wt');
  assert.equal(resolvePath({ WT_ROOT: '~/wt' }, opts).path, join(homedir(), 'wt'));
  assert.equal(resolvePath({}, opts).path, '');
});

test('resolveTarget derives the name and both default paths from the URL alone', () => {
  const t = resolveTarget({ GITLAB_REPO_URL: 'git@gitlab.example.com:acme/erp.git' }, ROOT);
  assert.equal(t.error, null);
  assert.equal(t.name, 'erp');
  assert.equal(t.workRepo.path, join(homedir(), 'Documents', 'erp'));
  assert.equal(t.wtRoot.path, join(homedir(), 'Documents', 'erp-wt'));
});

test('resolveTarget without a URL resolves nothing by default, and ignores scoped names', () => {
  const t = resolveTarget({ ONESHOT_ERP_WORK_REPO: '/srv/erp' }, ROOT);
  assert.equal(t.repo, null);
  assert.match(t.error ?? '', /GITLAB_REPO_URL is not set/);
  assert.equal(t.name, '');
  assert.equal(t.workRepo.path, '');
  assert.equal(t.wtRoot.path, '');
  // An explicit plain path still stands on its own.
  assert.equal(resolveTarget({ WORK_REPO: '/srv/erp' }, ROOT).workRepo.path, '/srv/erp');
});

// --------------------------------------------------------- legacy selectors

const REPO = parseRepoUrl('https://gitlab.example.com/acme/erp');

test('legacy selectors that agree with the URL are reported, not conflicting', () => {
  const found = legacySelectors({
    ONESHOT_PROJECT: 'ERP',
    ONESHOT_GITLAB_PROJECT: '/Acme/Erp.git',
    ONESHOT_GITLAB_API: 'https://gitlab.example.com/api/v4/',
  }, REPO);
  assert.deepEqual(found.map((f) => [f.key, f.conflict]), [
    ['ONESHOT_PROJECT', false], ['ONESHOT_GITLAB_PROJECT', false], ['ONESHOT_GITLAB_API', false],
  ]);
});

test('legacy selectors that disagree are conflicts, carrying both values', () => {
  const found = legacySelectors({
    ONESHOT_PROJECT: 'workstream',
    ONESHOT_GITLAB_PROJECT: 'acme/workstream',
    ONESHOT_GITLAB_API: 'https://gitlab.other.com/api/v4',
  }, REPO);
  assert.ok(found.every((f) => f.conflict));
  assert.deepEqual(found[0], { key: 'ONESHOT_PROJECT', value: 'workstream', derived: 'erp', conflict: true });
  assert.equal(found[1]?.derived, 'acme/erp');
  assert.equal(found[2]?.derived, 'https://gitlab.example.com/api/v4');
});

test('the numeric id cannot be checked offline, so it is never a conflict', () => {
  assert.deepEqual(legacySelectors({ ONESHOT_PROJECT_ID: '304' }, REPO),
    [{ key: 'ONESHOT_PROJECT_ID', value: '304', derived: null, conflict: false }]);
});

test('both spellings are judged, so an ONELOOP_ line cannot hide behind an ONESHOT_ one', () => {
  const found = legacySelectors({ ONESHOT_PROJECT: 'erp', ONELOOP_PROJECT: 'workstream' }, REPO);
  assert.deepEqual(found.map((f) => [f.key, f.conflict]), [['ONESHOT_PROJECT', false], ['ONELOOP_PROJECT', true]]);
});

test('blank and placeholder legacy lines are not set; with no URL nothing conflicts', () => {
  assert.deepEqual(legacySelectors({ ONESHOT_PROJECT: '', ONESHOT_GITLAB_API: 'REPLACE_ME' }, REPO), []);
  const noUrl = legacySelectors({ ONESHOT_PROJECT: 'workstream' }, null);
  assert.deepEqual(noUrl, [{ key: 'ONESHOT_PROJECT', value: 'workstream', derived: null, conflict: false }]);
});

test('localRemotePath recognises a local clone, and only a local clone', () => {
  assert.equal(localRemotePath('/srv/erp', '/x'), '/srv/erp');
  assert.equal(localRemotePath('../erp', '/srv/work'), '/srv/erp');
  assert.equal(localRemotePath('file:///srv/erp', '/x'), '/srv/erp');
  for (const url of ['https://gitlab.example.com/acme/erp.git', 'git@gitlab.example.com:acme/erp.git',
    'ssh://git@gitlab.example.com:2222/acme/erp.git', 'gitlab.example.com:acme/erp.git']) {
    assert.equal(localRemotePath(url, '/x'), null, url);
  }
});

/**
 * The project switch: ONE line in .env — GITLAB_REPO_URL — says which project the
 * conductor works on, and everything else about the project is derived from it.
 *
 * Three properties matter more than the mechanism. Importing config must never
 * throw without the URL, because tests and tooling import it on machines that
 * have not set one; asking WHICH project must then throw, naming the variable,
 * because quietly working on some default project would claim tickets and open
 * MRs against a project nobody chose. And the variables that used to select the
 * project must select nothing now — a stale one may not move the conductor.
 *
 * Hermetic from this machine's .env: config.js loads it on import, and dotenv
 * fills only keys ABSENT from process.env. So every key a case does not set is
 * set to '' rather than deleted — deleting it would hand the case whatever the
 * .env on the machine running the tests says.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_URL = 'https://gitlab.example.com/acme/erp';

/** Every key a case could be influenced by, in both spellings where there are two. */
const KEYS = [
  'GITLAB_REPO_URL', 'WORK_REPO', 'WT_ROOT', 'ONESHOT_SEED_FROM', 'ONELOOP_SEED_FROM',
  'ONESHOT_PROJECT', 'ONELOOP_PROJECT', 'ONESHOT_GITLAB_PROJECT', 'ONELOOP_GITLAB_PROJECT',
  'ONESHOT_GITLAB_API', 'ONELOOP_GITLAB_API', 'ONESHOT_PROJECT_ID', 'ONELOOP_PROJECT_ID',
  'ONESHOT_ERP_WORK_REPO', 'ONESHOT_ERP_WT_ROOT', 'ONESHOT_ERP_SEED_FROM',
  'ONELOOP_ERP_WORK_REPO', 'ONELOOP_ERP_WT_ROOT', 'ONELOOP_ERP_SEED_FROM', 'ONESHOT_BASE_BRANCH',
];

function hermetic(vars: Record<string, string>): Record<string, string> {
  return { ...Object.fromEntries(KEYS.map((k) => [k, ''])), ...vars };
}

type Config = Record<string, unknown> & {
  PROJECT_TARGET: string;
  WORK_REPO: string;
  WT_ROOT: string;
  seedFrom: () => string;
  scopedEnvName: (n: string) => string;
  projectConfig: () => {
    gitlab: Record<string, unknown>;
    labels: Record<string, unknown>;
    branches: { base: string };
  };
  repoIdentity: () => { repo: { project: string } | null; error: string | null };
  pathSources: () => Record<string, { path: string; source: string; key: string }>;
  projectSessionEnv: () => Record<string, string>;
};

let seq = 0;

/**
 * Each case re-imports config.js under a fresh module instance: PROJECT_TARGET,
 * WORK_REPO and WT_ROOT are constants resolved at load, so a cache-busting query
 * string is the only way to observe a different environment.
 *
 * `within` runs while the variables are STILL set. The project itself is read
 * lazily, on first access, and seedFrom(), pathSources() and the legacy check
 * read the environment when called — asserting on any of them after the restore
 * would test this machine's .env rather than the case.
 */
async function loadWith(vars: Record<string, string>, within?: (m: Config) => void): Promise<Config> {
  const all = hermetic(vars);
  const before = new Map(Object.keys(all).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(all)) process.env[k] = v;
  try {
    seq += 1;
    const m = await import(`./config.js?repo=${seq}`) as Config;
    within?.(m);
    return m;
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const docs = (...p: string[]): string => join(homedir(), 'Documents', ...p);

test('without GITLAB_REPO_URL, importing works and nothing names a project', async () => {
  await loadWith({}, (m) => {
    assert.equal(m.PROJECT_TARGET, '');
    assert.equal(m.WORK_REPO, '');
    assert.equal(m.WT_ROOT, '');
    assert.equal(m.seedFrom(), '');
    assert.equal(m.scopedEnvName('WORK_REPO'), '');
    // Labels and branches stay readable: only asking which project throws.
    const cfg = m.projectConfig();
    assert.equal(cfg.labels.entry, 'Loop');
    assert.throws(() => cfg.gitlab, /GITLAB_REPO_URL is not set.*e\.g\. GITLAB_REPO_URL=/);
    assert.match(m.repoIdentity().error ?? '', /GITLAB_REPO_URL is not set/);
  });
});

test('an invalid URL is not an import-time crash either; asking which project is', async () => {
  await loadWith({ GITLAB_REPO_URL: 'https://gitlab.example.com/erp' }, (m) => {
    assert.equal(m.PROJECT_TARGET, '');
    assert.throws(() => m.projectConfig().gitlab, /GITLAB_REPO_URL='https:\/\/gitlab\.example\.com\/erp' is not a GitLab project URL/);
  });
});

test('the URL alone sets the project, its API, and every derived path', async () => {
  await loadWith({ GITLAB_REPO_URL: REPO_URL }, (m) => {
    assert.equal(m.PROJECT_TARGET, 'erp');
    const { gitlab } = m.projectConfig();
    assert.equal(gitlab.project, 'acme/erp');
    assert.equal(gitlab.host, 'gitlab.example.com');
    assert.equal(gitlab.apiUrl, 'https://gitlab.example.com/api/v4');
    assert.equal(gitlab.webUrl, REPO_URL);
    // The numeric id is asked of GitLab, never configured.
    assert.equal('projectId' in gitlab, false);
    assert.equal(m.WORK_REPO, docs('erp'));
    // Per project, because worktrees are named by ticket iid: one root shared by
    // two projects would collide issue 100 with issue 100.
    assert.equal(m.WT_ROOT, docs('erp-wt'));
    // Seeding stays opt-in on the conductor side.
    assert.equal(m.seedFrom(), '');
    assert.deepEqual(Object.fromEntries(Object.entries(m.pathSources()).map(([k, v]) => [k, v.source])),
      { WORK_REPO: 'default', WT_ROOT: 'default', ONESHOT_SEED_FROM: 'default' });
  });
});

test('the name follows whatever project the URL names — no project is built in', async () => {
  await loadWith({ GITLAB_REPO_URL: 'git@gitlab.example.com:acme/platform/Billing-Service.git' }, (m) => {
    assert.equal(m.PROJECT_TARGET, 'billing-service');
    assert.equal(m.projectConfig().gitlab.project, 'acme/platform/Billing-Service');
    assert.equal(m.WORK_REPO, docs('billing-service'));
    assert.equal(m.WT_ROOT, docs('billing-service-wt'));
    assert.equal(m.scopedEnvName('WORK_REPO'), 'ONESHOT_BILLING_SERVICE_WORK_REPO');
    assert.equal(m.scopedEnvName('ONESHOT_SEED_FROM'), 'ONESHOT_BILLING_SERVICE_SEED_FROM');
  });
});

test('the base config is the ERP one: its labels, its base branch', async () => {
  await loadWith({ GITLAB_REPO_URL: REPO_URL }, (m) => {
    const { labels, branches } = m.projectConfig();
    // Every label check is a case-sensitive Array.includes, so 'merged' would be
    // a label that silently never matches 'Merged'.
    assert.equal(labels.entry, 'Loop');
    assert.equal(labels.exit, 'Merged');
    assert.equal(labels.blocked, 'Needs Human');
    assert.equal(labels.inReview, 'In Review');
    // Optional labels the project does not have are off, not pointing at a name
    // that does not exist there.
    for (const off of ['review', 'testcaseReview', 'notABug', 'designReview']) {
      assert.equal(labels[off], '', off);
    }
    assert.equal(branches.base, 'dev');
  });
});

test('config/project.json names no project', () => {
  const raw = readFileSync(new URL('../../config/project.json', import.meta.url), 'utf8');
  const cfg = JSON.parse(raw) as Record<string, unknown>;
  assert.equal('gitlab' in cfg, false);
  assert.equal('targets' in cfg, false);
  assert.doesNotMatch(raw, /workstreamai|1491/i);
});

test('a plain path variable beats the derived default, and says so', async () => {
  await loadWith({ GITLAB_REPO_URL: REPO_URL, WORK_REPO: '/tmp/elsewhere/erp', ONESHOT_SEED_FROM: '/tmp/seed' }, (m) => {
    assert.equal(m.WORK_REPO, '/tmp/elsewhere/erp');
    assert.equal(m.seedFrom(), '/tmp/seed');
    assert.deepEqual(m.pathSources().WORK_REPO, { path: '/tmp/elsewhere/erp', source: 'plain', key: 'WORK_REPO' });
  });
});

test('the scoped ONESHOT_<NAME>_<VAR> is still honoured, above the plain one', async () => {
  await loadWith({
    GITLAB_REPO_URL: REPO_URL,
    WORK_REPO: '/tmp/plain/erp',
    ONESHOT_ERP_WORK_REPO: '/tmp/scoped/erp',
    ONESHOT_ERP_SEED_FROM: '/tmp/scoped/seed',
    ONESHOT_ERP_WT_ROOT: '/tmp/scoped/erp-wt',
  }, (m) => {
    assert.equal(m.WORK_REPO, '/tmp/scoped/erp');
    assert.equal(m.seedFrom(), '/tmp/scoped/seed');
    assert.equal(m.WT_ROOT, '/tmp/scoped/erp-wt');
    assert.deepEqual(m.pathSources().WORK_REPO, { path: '/tmp/scoped/erp', source: 'scoped', key: 'ONESHOT_ERP_WORK_REPO' });
  });
});

test('a scoped name is keyed by the URL\'s project, so another project\'s is ignored', async () => {
  await loadWith({ GITLAB_REPO_URL: 'https://gitlab.example.com/acme/billing', ONESHOT_ERP_WORK_REPO: '/tmp/erp' }, (m) => {
    assert.equal(m.WORK_REPO, docs('billing'));
  });
  await loadWith({ ONESHOT_ERP_WORK_REPO: '/tmp/erp' }, (m) => {
    assert.equal(m.WORK_REPO, '');
  });
});

test('a legacy selector moves nothing', async () => {
  await loadWith({
    GITLAB_REPO_URL: REPO_URL,
    ONESHOT_PROJECT: 'workstream',
    ONESHOT_GITLAB_PROJECT: 'acme/workstream',
    ONESHOT_GITLAB_API: 'https://gitlab.other.com/api/v4',
    ONESHOT_PROJECT_ID: '1',
  }, (m) => {
    assert.equal(m.PROJECT_TARGET, 'erp');
    const { gitlab } = m.projectConfig();
    assert.equal(gitlab.project, 'acme/erp');
    assert.equal(gitlab.apiUrl, 'https://gitlab.example.com/api/v4');
    assert.equal(m.WORK_REPO, docs('erp'));
  });
});

test('without a URL, a legacy selector does not stand in for one', async () => {
  await loadWith({ ONESHOT_PROJECT: 'erp', ONESHOT_GITLAB_PROJECT: 'acme/erp' }, (m) => {
    assert.equal(m.PROJECT_TARGET, '');
    assert.equal(m.WORK_REPO, '');
    assert.throws(() => m.projectConfig().gitlab, /GITLAB_REPO_URL is not set/);
  });
});

test('scripts/app.cjs resolves exactly the paths the conductor does', async () => {
  const cases: Array<Record<string, string>> = [
    { GITLAB_REPO_URL: REPO_URL },
    { GITLAB_REPO_URL: REPO_URL, WORK_REPO: '/tmp/plain/erp', WT_ROOT: 'relative-wt' },
    { GITLAB_REPO_URL: REPO_URL, WORK_REPO: '/tmp/plain/erp', ONESHOT_ERP_WORK_REPO: '/tmp/scoped/erp',
      ONESHOT_SEED_FROM: '/tmp/seed' },
  ];
  const root = new URL('../..', import.meta.url).pathname;
  for (const vars of cases) {
    const env = { ...process.env, ...hermetic(vars) };
    // Run from `/` on purpose: a relative path must mean the Oneshot checkout to
    // both sides, never the cwd of whoever ran the script.
    const app = JSON.stringify(join(root, 'scripts', 'app.cjs'));
    const child = spawnSync(process.execPath,
      ['-e', `process.stdout.write(JSON.stringify(require(${app}).config))`],
      { cwd: '/', env, encoding: 'utf8' },
    );
    assert.equal(child.status, 0, child.stderr);
    const cjs = JSON.parse(child.stdout.replace(/^[^{]*/, '')) as Record<string, string | null>;
    await loadWith(vars, (m) => {
      assert.equal(cjs.name, m.PROJECT_TARGET, JSON.stringify(vars));
      assert.equal(cjs.WORK_REPO, m.WORK_REPO, JSON.stringify(vars));
      assert.equal(cjs.WT_ROOT, m.WT_ROOT, JSON.stringify(vars));
      // The one deliberate difference: app.cjs needs a seed to fetch from, so an
      // unset one is WORK_REPO there and "seeding off" in the conductor.
      assert.equal(cjs.SEED_FROM, m.seedFrom() || m.WORK_REPO, JSON.stringify(vars));
      assert.equal(cjs.BASE_BRANCH, m.projectConfig().branches.base);
      assert.equal(cjs.error, null);
    });
  }
});

/** Run scripts/app.cjs as a phase session would, with only `vars` from the project's keys. */
function runApp(
  vars: Record<string, string>, args: string[] | string,
): { status: number | null; stdout: string; last: string } {
  const root = new URL('../..', import.meta.url).pathname;
  const app = join(root, 'scripts', 'app.cjs');
  const argv = typeof args === 'string' ? ['-e', args.replace('APP', JSON.stringify(app))] : [app, ...args];
  const child = spawnSync(process.execPath, argv, { cwd: '/', env: { ...process.env, ...hermetic(vars) }, encoding: 'utf8' });
  // Only the last line: a dotenv that logs its injection must not break the parse.
  return { status: child.status, stdout: child.stdout, last: child.stdout.trim().split('\n').pop() ?? '' };
}

test('scripts/app.cjs refuses without GITLAB_REPO_URL even when every path is spelled out', () => {
  // This machine's .env shape before the switch: the paths alone are somebody's
  // project, and ONESHOT_PROJECT selects nothing any more — so boot refuses it,
  // and app.cjs must not quietly go back to the old clone instead.
  const vars = {
    ONESHOT_PROJECT: 'erp', WORK_REPO: '/tmp/old-clone', WT_ROOT: '/tmp/old-wt', ONESHOT_SEED_FROM: '/tmp/old-clone',
  };
  const cfg = JSON.parse(runApp(vars, 'process.stdout.write(JSON.stringify(require(APP).config))').last) as
    Record<string, string | null>;
  assert.match(cfg.error ?? '', /GITLAB_REPO_URL is not set/);
  for (const cmd of ['ensure', 'warm']) {
    const run = runApp(vars, [cmd]);
    assert.equal(run.status, 1, cmd);
    assert.match(run.stdout, /"code": "E_CONFIG"/, cmd);
  }
});

test('scripts/app.cjs still lets gc look for orphans while the config is broken', () => {
  // Mid-switch is exactly when servers need reaping, and app.cjs's own errors
  // say to run gc/down. gc checks nothing out, so it runs; dry-run by default.
  const run = runApp({ ONESHOT_PROJECT: 'erp', WORK_REPO: '/tmp/old-clone' }, ['gc']);
  assert.equal(run.status, 0, run.stdout);
  assert.doesNotMatch(run.stdout, /E_CONFIG/);
  assert.match(run.stdout, /"wouldKill"/);
});

test('scripts/app.cjs refuses a seed or WORK_REPO that is a clone of another project', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oneshot-appseed-'));
  try {
    spawnSync('git', ['init', '-q', dir]);
    spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@gitlab.example.com:acme/workstream.git']);
    const checkout = 'process.stdout.write(JSON.stringify(require(APP).checkoutError()))';
    const shapes: Array<Record<string, string>> = [
      { GITLAB_REPO_URL: REPO_URL, WORK_REPO: '/tmp/no-such-erp', ONESHOT_SEED_FROM: dir },
      { GITLAB_REPO_URL: REPO_URL, WORK_REPO: dir },
    ];
    for (const vars of shapes) {
      const err = JSON.parse(runApp(vars, checkout).last) as string | null;
      assert.match(err ?? '', /is a clone of another project/, JSON.stringify(vars));
      assert.match(err ?? '', /acme\/workstream/, JSON.stringify(vars));
      const run = runApp(vars, ['ensure']);
      assert.equal(run.status, 1);
      assert.match(run.stdout, /"code": "E_CONFIG"/);
    }
    // The right project, and an origin that cannot be judged, are not refused.
    spawnSync('git', ['-C', dir, 'remote', 'set-url', 'origin', 'git@gitlab.example.com:acme/erp.git']);
    assert.equal(JSON.parse(runApp({ GITLAB_REPO_URL: REPO_URL, WORK_REPO: dir }, checkout).last), null);
    spawnSync('git', ['-C', dir, 'remote', 'set-url', 'origin', '/some/local/clone']);
    assert.equal(JSON.parse(runApp({ GITLAB_REPO_URL: REPO_URL, WORK_REPO: dir }, checkout).last), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a phase session\'s app.cjs resolves the conductor\'s project, whatever ONESHOT_HOME/.env says', async () => {
  // A session's environment is an allowlist and app.cjs inside it fills the
  // rest from ONESHOT_HOME/.env. The conductor booted from the SHELL here —
  // .env names another project and another clone — so without the resolved
  // values handed over, the session would seed and check out the wrong one.
  const root = new URL('../..', import.meta.url).pathname;
  const home = mkdtempSync(join(tmpdir(), 'oneshot-sessionenv-'));
  try {
    symlinkSync(join(root, 'skills'), join(home, 'skills'));
    writeFileSync(join(home, '.env'), [
      'GITLAB_REPO_URL=https://gitlab.example.com/acme/workstream',
      'WORK_REPO=/tmp/env/workstream', 'ONESHOT_ERP_WORK_REPO=/tmp/env/scoped-erp',
      'ONESHOT_SEED_FROM=/tmp/env/workstream', 'ONESHOT_PROJECT=workstream', '',
    ].join('\n'));
    let session: Record<string, string> = {};
    await loadWith({ GITLAB_REPO_URL: REPO_URL, WORK_REPO: '/tmp/shell/erp' }, (m) => {
      session = m.projectSessionEnv();
    });
    assert.equal(session.GITLAB_REPO_URL, REPO_URL);
    assert.equal(session.WORK_REPO, '/tmp/shell/erp');
    const app = JSON.stringify(join(root, 'scripts', 'app.cjs'));
    const child = spawnSync(process.execPath,
      ['-e', `process.stdout.write(JSON.stringify(require(${app}).config))`],
      { cwd: '/', env: { PATH: process.env.PATH ?? '', HOME: homedir(), ONESHOT_HOME: home, ...session }, encoding: 'utf8' },
    );
    assert.equal(child.status, 0, child.stderr);
    const cjs = JSON.parse(child.stdout.trim().split('\n').pop() ?? '{}') as Record<string, string | null>;
    assert.equal(cjs.name, 'erp');
    assert.equal(cjs.WORK_REPO, '/tmp/shell/erp');
    // Seeding off in the conductor is WORK_REPO in app.cjs, as ever — not .env's seed.
    assert.equal(cjs.SEED_FROM, '/tmp/shell/erp');
    assert.equal(cjs.error, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('without a usable URL the conductor hands a session nothing to override .env with', async () => {
  await loadWith({ GITLAB_REPO_URL: '' }, (m) => assert.deepEqual(m.projectSessionEnv(), {}));
});

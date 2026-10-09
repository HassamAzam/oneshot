/**
 * scripts/localtests.cjs — the local automation run's pure helpers, its config parity
 * with localTestsConfig(), and the commands that need no database or app: prepare-scope,
 * capture, gc and status against a throwaway ONESHOT_HOME and a temp automation repo.
 *
 * Lives under src/ because that is the only tree `npm test` globs. Nothing here touches
 * the desk's Postgres (the port is pointed at a closed one, or psql/createdb are fakes on
 * PATH), Redis, the developer's checkouts, or ports 8030/9030: `run` end to end uses fakes
 * for psql, createdb, the venv's python, harness.cjs and Cypress, on two free ports, under
 * a temp ONESHOT_HOME. The in-process helpers that read ONESHOT_HOME get a temp one too
 * (withHome), so no answer depends on the desk's .env.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ROOT, localTestsConfig } from './config.js';

const SCRIPT = join(ROOT, 'scripts/localtests.cjs');
const require = createRequire(import.meta.url);

interface Row { spec: string; title: string; state: string; durationMs: number; error?: string; failingOnDev?: boolean | null; flaky?: boolean }
interface FileState { mtimeMs: number; json: unknown }
interface StaleCtx { run: string; iid: number; ports: { be: number; fe: number }; dbPrefix: string; baselineDb: string; gitDirs: string[] }
const lt = require(SCRIPT) as {
  applyRetryResults: (results: Row[], retry: Row[]) => string[];
  guardProblem: (got: Record<string, unknown> | null, expected: string) => string | null;
  semverSatisfies: (version: string, range: string) => boolean | null;
  depDrift: (pkg: unknown, installed: (name: string) => string | null) => { missing: string[]; mismatched: Array<{ name: string; want: string; have: string }> };
  globEscape: (spec: string) => string;
  sanitizeStale: (prev: Record<string, unknown>, ctx: StaleCtx) => { data: Record<string, unknown>; ignored: string[] };
  scrubEnv: (source: Record<string, string | undefined>, dotenvKeys: string[], opts?: { keepPg?: boolean }) => Record<string, string>;
  secretValuesFrom: (envs: Array<Record<string, string | undefined>>, creds: unknown) => string[];
  redactWith: (secrets: string[], value: unknown) => unknown;
  webpackReadiness: (s: { logText: string; entrypoints: FileState | null; stats: FileState | null; sinceMs: number }) => string;
  portHolderIsOurs: (cwd: string | null, command: string) => boolean;
  runsDir: () => string;
  LT_BROKER: string;
  BASE_RERUN_NEEDS_MS: number;
  parseDotenv: (text: string) => Record<string, string>;
  settingsFrom: (project: unknown, env: Record<string, string | undefined>) => unknown;
  dbName: (prefix: string, iid: number, seq: number) => string;
  dbNameProblem: (name: string, prefix: string, baseline: string) => string | null;
  parseOurDb: (name: string, prefix: string) => { iid: number; seq: number } | null;
  nextSeq: (iid: number, names: string[], prefix: string, counter?: number) => number;
  isAllowedPath: (rel: string, allowed: string[]) => boolean;
  diffFiles: (diff: string) => Array<{ file: string; added: boolean; deleted: boolean }>;
  patchAddedFiles: (diff: string) => string[];
  weakenedFindings: (diff: string) => Array<{ file: string; why: string }>;
  parseMochawesome: (report: unknown) => Row[];
  assembleResults: (specs: string[], rows: Row[], opts?: { deadlineHit?: boolean; deadlineMin?: number }) => Row[];
  applyBaseResults: (results: Row[], base: Row[]) => Row[];
  cacheKey: (k: { ticketSha: string; automationSha: string; patchSha: string | null; specs: string[]; baseline: string }) => string;
  mergeEnv: (committed: unknown, creds: unknown) => Record<string, unknown>;
  rewriteLocalSettings: (src: string, db: { name: string; host: string; port: number | string; user: string }) => string;
  missingDeps: (pkg: unknown, has: (name: string) => boolean) => string[];
  parseSpecs: (data: unknown) => { specs: string[]; notRunnable: Array<{ spec: string; why: string }> };
  statusSpecs: (porcelainZ: string) => { added: string[]; removed: string[] };
  isOurWorktreePath: (p: string) => boolean;
};

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/* ------------------------------------------------------------------ database names */

test('a run copy is <prefix><iid>_<n>, and the baseline or any other name is refused', () => {
  const prefix = 'oneshot_lt_';
  const baseline = 'hrdb_automation_baseline_20261002';
  assert.equal(lt.dbName(prefix, 8800, 3), 'oneshot_lt_8800_3');
  assert.equal(lt.dbNameProblem('oneshot_lt_8800_3', prefix, baseline), null);
  assert.match(String(lt.dbNameProblem(baseline, prefix, baseline)), /does not start with|baseline/);
  assert.match(String(lt.dbNameProblem('oneshot_lt_8800_3', prefix, 'oneshot_lt_8800_3')), /baseline/);
  assert.match(String(lt.dbNameProblem('hrdb_local', prefix, baseline)), /does not start with/);
  assert.match(String(lt.dbNameProblem('oneshot_lt_8800', prefix, baseline)), /<iid>_<n>/);
  assert.match(String(lt.dbNameProblem('oneshot_lt_8800_1x', prefix, baseline)), /<iid>_<n>/);
  assert.match(String(lt.dbNameProblem('Oneshot_lt_1_1', prefix, baseline)), /lower-case/);
  assert.match(String(lt.dbNameProblem('oneshot_lt_1_1"; drop database x; --', prefix, baseline)), /lower-case/);
  assert.match(String(lt.dbNameProblem(`oneshot_lt_1_${'1'.repeat(60)}`, prefix, baseline)), /lower-case/);
  assert.match(String(lt.dbNameProblem('oneshot_lt_1_1', '', baseline)), /dbPrefix/);
});

test('copies are parsed back to their ticket, and the next sequence clears both server and counter', () => {
  assert.deepEqual(lt.parseOurDb('oneshot_lt_8800_12', 'oneshot_lt_'), { iid: 8800, seq: 12 });
  assert.equal(lt.parseOurDb('oneshot_lt_8800', 'oneshot_lt_'), null);
  assert.equal(lt.parseOurDb('hrdb_pilot_8800', 'oneshot_lt_'), null);
  const names = ['oneshot_lt_8800_1', 'oneshot_lt_8800_4', 'oneshot_lt_77_9', 'other_8800_20'];
  assert.equal(lt.nextSeq(8800, names, 'oneshot_lt_'), 5);
  assert.equal(lt.nextSeq(8800, names, 'oneshot_lt_', 7), 8);
  assert.equal(lt.nextSeq(1, [], 'oneshot_lt_'), 1);
});

/* ------------------------------------------------------------------ allowed paths */

test('an allowed path is a directory prefix; climbing out or a look-alike folder is not', () => {
  const allowed = ['cypress/Pages/', 'cypress/fixtures/', 'cypress/e2e/'];
  assert.equal(lt.isAllowedPath('cypress/e2e/leaves/a.cy.ts', allowed), true);
  assert.equal(lt.isAllowedPath('cypress/Pages/leaves/page.ts', allowed), true);
  assert.equal(lt.isAllowedPath('./cypress/fixtures/x.json', allowed), true);
  assert.equal(lt.isAllowedPath('cypress/e2e-old/a.cy.ts', allowed), false);
  assert.equal(lt.isAllowedPath('cypress.config.ts', allowed), false);
  assert.equal(lt.isAllowedPath('cypress/e2e/../../package.json', allowed), false);
  assert.equal(lt.isAllowedPath('/cypress/e2e/a.ts', allowed), false);
  assert.equal(lt.isAllowedPath('cypress/e2e', ['cypress/e2e']), true);
  assert.equal(lt.isAllowedPath('', allowed), false);
});

/* ------------------------------------------------------------------ weakening */

function diffOf(file: string, removed: string[], added: string[], opts: { newFile?: boolean; deleted?: boolean } = {}): string {
  return [
    `diff --git a/${file} b/${file}`,
    ...(opts.newFile ? ['new file mode 100644'] : []),
    ...(opts.deleted ? ['deleted file mode 100644'] : []),
    'index 1111111..2222222 100644',
    opts.newFile ? '--- /dev/null' : `--- a/${file}`,
    opts.deleted ? '+++ /dev/null' : `+++ b/${file}`,
    `@@ -1,${removed.length + 1} +1,${added.length + 1} @@`,
    ' context line',
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
  ].join('\n');
}

const whyOf = (diff: string): string[] => lt.weakenedFindings(diff).map((f) => f.why);

test('a renamed testid on an assertion line is an edit, not a weakened test', () => {
  const d = diffOf('cypress/e2e/a.cy.ts',
    ["    cy.get('[data-testid=\"old-banner\"]').should('be.visible');"],
    ["    cy.get('[data-testid=\"evidence-notice-banner\"]').should('be.visible');"]);
  assert.deepEqual(lt.weakenedFindings(d), []);
});

test('removing a test case, a describe, an expect, a should or an assert is reported', () => {
  assert.deepEqual(whyOf(diffOf('a.ts', ["  it('applies a leave', () => {"], [])), ['removes an it( test case']);
  assert.deepEqual(whyOf(diffOf('a.ts', ["describe('Leaves', () => {"], [])), ['removes a describe( block']);
  assert.deepEqual(whyOf(diffOf('a.ts', ['    expect(total).to.eq(3);'], [])), ['removes an expect( assertion']);
  assert.deepEqual(whyOf(diffOf('a.ts', ["    cy.get('x').should('exist');", "    cy.get('y').should('exist');"], [])),
    ['removes 2 × a .should( assertion']);
  assert.deepEqual(whyOf(diffOf('a.ts', ['    assert.isTrue(ok);'], [])), ['removes an assert']);
});

test('commenting a test out counts as removing it; cy.wait( is not an it(', () => {
  assert.deepEqual(whyOf(diffOf('a.ts', ["  it('applies', () => {"], ["  // it('applies', () => {"])), ['removes an it( test case']);
  assert.deepEqual(whyOf(diffOf('a.ts', ['    cy.submit();'], ['    cy.submit({});'])), []);
  // `wait(` ends in `it(`: a naive match would read this as a test case added.
  assert.deepEqual(whyOf(diffOf('a.ts', [], ["    cy.wait('@save');"])), ['adds cy.wait(']);
});

test('skip, only, force: true, cy.wait and a long timeout are reported when added', () => {
  assert.deepEqual(whyOf(diffOf('a.ts', ["  it('x', () => {"], ["  it.skip('x', () => {"])), ['removes an it( test case', 'adds .skip(']);
  assert.deepEqual(whyOf(diffOf('a.ts', ["  describe('x', () => {"], ["  describe.only('x', () => {"])), ['removes a describe( block', 'adds .only(']);
  assert.deepEqual(whyOf(diffOf('a.ts', ["    cy.get('b').click();"], ["    cy.get('b').click({ force: true });"])), ['adds force: true']);
  assert.deepEqual(whyOf(diffOf('a.ts', [], ['    cy.wait(5000);'])), ['adds cy.wait(']);
  assert.deepEqual(whyOf(diffOf('a.ts', ["    cy.get('b', { timeout: 4000 });"], ["    cy.get('b', { timeout: 30000 });"])),
    ['raises a timeout to 30000 ms']);
  assert.deepEqual(whyOf(diffOf('a.ts', ["    cy.get('b', { timeout: 4000 });"], ["    cy.get('c', { timeout: 6000 });"])), []);
  // An existing long timeout carried across an edit is not a raise.
  assert.deepEqual(whyOf(diffOf('a.ts', ["    cy.get('b', { timeout: 60000 });"], ["    cy.get('c', { timeout: 60000 });"])), []);
  // force: true already on the line before the edit is not new.
  assert.deepEqual(whyOf(diffOf('a.ts', ["    cy.get('b').click({ force: true });"], ["    cy.get('c').click({ force: true });"])), []);
});

test('reaching outside the browser — cy.exec, cy.task, cy.writeFile, Cypress.env — arms the gate too', () => {
  // The shape of the leak the review found: no it( added, no assertion removed.
  assert.deepEqual(whyOf(diffOf('cypress/e2e/a.cy.ts', [],
    ["    cy.exec('printenv GITLAB_TOKEN').then((r) => { throw new Error(r.stdout); });"])), ['adds cy.exec(']);
  assert.deepEqual(whyOf(diffOf('a.ts', [], ["    cy.task('readFile', '/etc/hosts');"])), ['adds cy.task(']);
  assert.deepEqual(whyOf(diffOf('a.ts', [], ["    cy.writeFile('out.json', Cypress.env());"])), ['adds cy.writeFile(', 'adds Cypress.env(']);
  // An existing Cypress.env( line carried across an edit is not new.
  assert.deepEqual(whyOf(diffOf('a.ts', ["    login(Cypress.env('hrEmail'));"], ["    loginAs(Cypress.env('hrEmail'));"])), []);
});

test('a deleted spec is a weakened test; a new file is checked on its own lines', () => {
  const deleted = diffOf('cypress/e2e/old.cy.ts', ["describe('Old', () => {", "  it('one', () => {", "    cy.get('a').should('exist');"], [], { deleted: true });
  assert.deepEqual(lt.weakenedFindings(deleted).map((f) => f.file), ['cypress/e2e/old.cy.ts', 'cypress/e2e/old.cy.ts', 'cypress/e2e/old.cy.ts']);
  const added = diffOf('cypress/e2e/TR_LOCAL_x.cy.ts', [], ["it('new', () => {", "  cy.get('a').click({ force: true });"], { newFile: true });
  assert.deepEqual(lt.weakenedFindings(added), [{ file: 'cypress/e2e/TR_LOCAL_x.cy.ts', why: 'adds force: true' }]);
  assert.deepEqual(lt.patchAddedFiles(`${deleted}\n${added}\n`), ['cypress/e2e/TR_LOCAL_x.cy.ts']);
  assert.deepEqual(lt.diffFiles(`${deleted}\n${added}\n`).map((f) => [f.file, f.added, f.deleted]),
    [['cypress/e2e/old.cy.ts', false, true], ['cypress/e2e/TR_LOCAL_x.cy.ts', true, false]]);
});

test('a removed content line that starts with -- is content, not a header', () => {
  const d = diffOf('a.ts', ['-- not a header', "  it('x', () => {"], []);
  assert.deepEqual(lt.diffFiles(d).map((f) => f.file), ['a.ts']);
  assert.deepEqual(whyOf(d), ['removes an it( test case']);
});

/* ------------------------------------------------------------------ mochawesome */

/** Shaped like the pilot's cypress/results/.jsons/mochawesome*.json. */
const REPORT = {
  stats: { tests: 5, passes: 1, failures: 2, pending: 1 },
  results: [{
    uuid: 'root', title: '', root: true,
    file: 'cypress/e2e/teamReviewB/TR_108.ts', fullFile: 'cypress/e2e/teamReviewB/TR_108.ts',
    beforeHooks: [], afterHooks: [], tests: [],
    suites: [{
      uuid: 's1', title: 'TR_108 page checks', file: '', fullFile: '',
      beforeHooks: [{
        uuid: 'h1', title: '"before all" hook', fullTitle: 'TR_108 page checks "before all" hook', state: 'failed', fail: true,
        duration: 12, err: { message: 'CypressError: cy.request() failed\nwith a stack', estack: '...' },
      }],
      afterHooks: [],
      tests: [
        { uuid: 't1', title: 'loads', fullTitle: 'TR_108 page checks loads', state: 'passed', pass: true, fail: false, duration: '2500', err: {} },
        {
          uuid: 't2', title: 'team dropdown', fullTitle: 'TR_108 page checks team dropdown', state: 'failed', pass: false, fail: true,
          duration: 103198, err: { message: 'AssertionError: Timed out retrying after 60000ms: Team dropdown disabled\n  at stack', estack: 'x' },
        },
        { uuid: 't3', title: 'later', fullTitle: 'TR_108 page checks later', state: null, pass: false, fail: false, pending: true, duration: 0, err: {} },
        { uuid: 't4', title: 'skipped', fullTitle: 'TR_108 page checks skipped', state: null, skipped: true, duration: 0, err: {} },
      ],
      suites: [{
        uuid: 's2', title: 'nested', file: '', beforeHooks: [], afterHooks: [], suites: [],
        tests: [{ uuid: 't5', title: 'deep', fullTitle: 'TR_108 page checks nested deep', state: 'failed', fail: true, duration: 7, err: {} }],
      }],
    }],
  }],
};

test('mochawesome rows: spec from the root suite, full titles, four states mapped to three, first error line', () => {
  const rows = lt.parseMochawesome(REPORT);
  assert.deepEqual(rows.map((r) => [r.title, r.state]), [
    ['TR_108 page checks loads', 'passed'],
    ['TR_108 page checks team dropdown', 'failed'],
    ['TR_108 page checks later', 'skipped'],
    ['TR_108 page checks skipped', 'skipped'],
    ['TR_108 page checks "before all" hook', 'failed'],
    ['TR_108 page checks nested deep', 'failed'],
  ]);
  assert.ok(rows.every((r) => r.spec === 'cypress/e2e/teamReviewB/TR_108.ts'));
  assert.equal(rows[0]!.durationMs, 2500);
  assert.equal(rows[1]!.error, 'AssertionError: Timed out retrying after 60000ms: Team dropdown disabled');
  assert.equal(rows[4]!.error, 'CypressError: cy.request() failed');
  assert.equal(rows[5]!.error, 'failed without an error message');
  assert.equal(rows[0]!.error, undefined);
  assert.deepEqual(lt.parseMochawesome(null), []);
  assert.deepEqual(lt.parseMochawesome({ results: 'nope' }), []);
});

test('every planned spec is accounted for: cut off by the deadline, or a failure when it never reported', () => {
  const rows: Row[] = [{ spec: 'cypress/e2e/a.ts', title: 'a ok', state: 'passed', durationMs: 1 }];
  const plain = lt.assembleResults(['cypress/e2e/a.ts', 'cypress/e2e/b.ts'], rows);
  assert.deepEqual(plain.map((r) => [r.spec, r.state]), [['cypress/e2e/a.ts', 'passed'], ['cypress/e2e/b.ts', 'failed']]);
  assert.match(String(plain[1]!.error), /recorded no results/);
  const cut = lt.assembleResults(['cypress/e2e/a.ts', 'cypress/e2e/b.ts'], rows, { deadlineHit: true, deadlineMin: 55 });
  assert.deepEqual(cut[1], {
    spec: 'cypress/e2e/b.ts', title: '(not finished)', state: 'skipped', durationMs: 0,
    error: 'not finished: Cypress was stopped at the 55-minute deadline',
  });
});

test('failingOnDev: same test on base, else the spec as a whole, else unknown', () => {
  const results: Row[] = [
    { spec: 's1', title: 't1', state: 'failed', durationMs: 0 },
    { spec: 's1', title: 't2', state: 'failed', durationMs: 0 },
    { spec: 's2', title: 't3', state: 'failed', durationMs: 0 },
    { spec: 's3', title: 't4', state: 'failed', durationMs: 0 },
    { spec: 's4', title: 't5', state: 'failed', durationMs: 0 },
    { spec: 's1', title: 'ok', state: 'passed', durationMs: 0 },
  ];
  lt.applyBaseResults(results, [
    { spec: 's1', title: 't1', state: 'failed', durationMs: 0 },
    { spec: 's1', title: 't2', state: 'passed', durationMs: 0 },
    { spec: 's2', title: 'renamed on base', state: 'failed', durationMs: 0 },
    { spec: 's3', title: 'other', state: 'passed', durationMs: 0 },
  ]);
  assert.deepEqual(results.map((r) => r.failingOnDev), [true, false, true, false, null, undefined]);
});

/* ------------------------------------------------------------------ keys, env, settings */

test('the cache key ignores spec order and duplicates, and changes with every input', () => {
  const k = { ticketSha: 'a'.repeat(40), automationSha: 'b'.repeat(40), patchSha: null, specs: ['s2', 's1', 's1'], baseline: 'base' };
  const key = lt.cacheKey(k);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(lt.cacheKey({ ...k, specs: ['s1', 's2'] }), key);
  for (const change of [{ ticketSha: 'c'.repeat(40) }, { automationSha: 'c'.repeat(40) }, { patchSha: 'p' }, { specs: ['s1'] }, { baseline: 'other' }]) {
    assert.notEqual(lt.cacheKey({ ...k, ...change }), key, JSON.stringify(change));
  }
});

test('cypress.env.json for the run: committed keys kept, credentials win', () => {
  assert.deepEqual(lt.mergeEnv({ SERVER: 'x', A_CREDENTIALS: 'committed', keep: 1 }, { A_CREDENTIALS: 'desk', B: 2 }),
    { SERVER: 'x', A_CREDENTIALS: 'desk', keep: 1, B: 2 });
  assert.deepEqual(lt.mergeEnv(null, ['not', 'an', 'object']), {});
});

const SEED_SETTINGS = `from .config import *

DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.postgresql_psycopg2',
        'NAME': 'hrdb_dev',
        'USER': 'someone',
        'PASSWORD': 'SEED-SECRET',
        'HOST': 'db.example',
        'PORT': '6543',
    }
}

CELERY_BROKER_URL = 'redis://localhost:6379'
USE_WEB_SHELL = True
`;

test('local_settings.py: the DATABASES block points at the copy, the seed password goes, the E2E flags are appended', () => {
  const out = lt.rewriteLocalSettings(SEED_SETTINGS, { name: 'oneshot_lt_8800_1', host: '127.0.0.1', port: 5432, user: 'arsal.tariq' });
  assert.match(out, /'ENGINE': 'django\.db\.backends\.postgresql_psycopg2'/);
  assert.match(out, /'NAME': 'oneshot_lt_8800_1'/);
  assert.match(out, /'USER': 'arsal\.tariq'/);
  assert.match(out, /'PASSWORD': ''/);
  assert.match(out, /'HOST': '127\.0\.0\.1'/);
  assert.match(out, /'PORT': '5432'/);
  assert.doesNotMatch(out, /SEED-SECRET|hrdb_dev|db\.example/);
  assert.match(out, /CELERY_BROKER_URL = 'redis:\/\/localhost:6379'\nUSE_WEB_SHELL = True\n/);
  // The copy's own broker and cache prefix come AFTER the seed's lines, so they win on import.
  assert.match(out, /\nDATABASE_NAME = 'oneshot_lt_8800_1'\nCELERY_BROKER_URL = 'redis:\/\/127\.0\.0\.1:6379\/15'\n/);
  assert.ok(out.lastIndexOf("CELERY_BROKER_URL = 'redis://127.0.0.1:6379/15'") > out.indexOf("CELERY_BROKER_URL = 'redis://localhost:6379'"));
  assert.equal(lt.LT_BROKER, 'redis://127.0.0.1:6379/15');
  assert.match(out, /\nEXPOSE_E2E_API = True\nEXPIRE_TOKEN = False\n$/);
  assert.throws(() => lt.rewriteLocalSettings('X = 1\n', { name: 'oneshot_lt_1_1', host: 'h', port: 1, user: '' }), /0 DATABASES blocks/);
  assert.throws(() => lt.rewriteLocalSettings(`${SEED_SETTINGS}\n${SEED_SETTINGS}`, { name: 'oneshot_lt_1_1', host: 'h', port: 1, user: '' }), /2 DATABASES blocks/);
  assert.throws(() => lt.rewriteLocalSettings(SEED_SETTINGS, { name: "x'; import os", host: 'h', port: 1, user: '' }), /cannot be written/);
  // A seed already on the run's Redis DB would share the queue after all.
  assert.throws(() => lt.rewriteLocalSettings(SEED_SETTINGS.replace("'redis://localhost:6379'", "'redis://localhost:6379/15'"),
    { name: 'oneshot_lt_1_1', host: 'h', port: 1, user: '' }), /already redis:\/\/127\.0\.0\.1:6379\/15/);
});

test('the database guard: the copy, the run\'s own broker and a cache keyed by the copy, or the run stops', () => {
  const ok = { name: 'oneshot_lt_1_1', host: '127.0.0.1', port: '5432', e2e: true, broker: lt.LT_BROKER, keyPrefix: 'oneshot_lt_1_1' };
  assert.equal(lt.guardProblem(ok, 'oneshot_lt_1_1'), null);
  assert.match(String(lt.guardProblem({ ...ok, name: 'hrdb' }, 'oneshot_lt_1_1')), /database "hrdb", not the run copy/);
  assert.match(String(lt.guardProblem({ ...ok, broker: 'redis://localhost:6379' }, 'oneshot_lt_1_1')), /the seed's broker/);
  assert.doesNotMatch(String(lt.guardProblem({ ...ok, broker: 'redis://:pw@localhost:6379' }, 'oneshot_lt_1_1')), /pw/, 'a broker URL is never echoed');
  assert.match(String(lt.guardProblem({ ...ok, broker: null }, 'oneshot_lt_1_1')), /no broker setting/);
  assert.match(String(lt.guardProblem({ ...ok, keyPrefix: 'hrdb' }, 'oneshot_lt_1_1')), /KEY_PREFIX is "hrdb"/);
  assert.match(String(lt.guardProblem(null, 'oneshot_lt_1_1')), /did not load/);
});

test('node_modules drift: every dependency and devDependency name that is not installed', () => {
  const pkg = { dependencies: { react: '^18', 'posthog-js': '^1' }, devDependencies: { '@babel/core': '^7', react: '^18' } };
  const installed = new Set(['react', '@babel/core']);
  assert.deepEqual(lt.missingDeps(pkg, (n) => installed.has(n)), ['posthog-js']);
  assert.deepEqual(lt.missingDeps({}, () => false), []);
});

test('semver satisfies: caret, tilde, exact and x-ranges; anything else is unknown', () => {
  const cases: Array<[string, string, boolean | null]> = [
    ['18.2.0', '^18.2.0', true], ['18.9.1', '^18.2.0', true], ['19.0.0', '^18.2.0', false], ['18.1.9', '^18.2.0', false],
    ['0.2.9', '^0.2.3', true], ['0.3.0', '^0.2.3', false], ['0.0.3', '^0.0.3', true], ['0.0.4', '^0.0.3', false],
    ['0.0.9', '^0.0', true], ['0.1.0', '^0.0', false], ['0.9.0', '^0.x', true], ['1.0.0', '^0.x', false],
    ['1.2.9', '~1.2.3', true], ['1.3.0', '~1.2.3', false], ['1.9.0', '~1', true], ['2.0.0', '~1', false],
    ['1.2.3', '1.2.3', true], ['1.2.4', '1.2.3', false], ['1.2.3', '=1.2.3', true], ['1.2.3', 'v1.2.3', true],
    ['1.9.9', '1.x', true], ['2.0.0', '1', false], ['1.2.7', '1.2.*', true], ['1.3.0', '1.2', false], ['5.0.0', '*', true], ['5.0.0', '', true],
    ['18.3.0-rc.1', '^18.2.0', true], ['7.0.0', '^6 || ^7', true], ['8.0.0', '^6 || ^7', false],
    ['1.0.0', '>=1.0.0', null], ['1.0.0', 'latest', null], ['1.0.0', 'npm:other@^1', null], ['1.0.0', 'file:../x', null],
    ['1.0.0', 'github:org/repo', null], ['1.0.0', '1.0.0 - 2.0.0', null], ['8.0.0', '^6 || >=7', null],
    ['not-a-version', '^1.0.0', null],
  ];
  for (const [v, range, want] of cases) assert.equal(lt.semverSatisfies(v, range), want, `${v} in ${JSON.stringify(range)}`);
});

test('node_modules drift is version-aware: missing, out of range, or (for a range it cannot read) present', () => {
  const pkg = {
    dependencies: { react: '^18.2.0', 'posthog-js': '^1.0.0', lodash: '4.17.21', aliased: 'npm:other@^2' },
    devDependencies: { '@babel/core': '~7.20.0', cypress: '^14.0.0' },
  };
  const installed: Record<string, string> = { react: '17.0.2', lodash: '4.17.21', aliased: '9.9.9', '@babel/core': '7.20.12', cypress: '' };
  const drift = lt.depDrift(pkg, (n) => (n in installed ? installed[n]! : null));
  assert.deepEqual(drift.missing, ['posthog-js']);
  assert.deepEqual(drift.mismatched, [{ name: 'react', want: '^18.2.0', have: '17.0.2' }],
    'an alias is checked for presence only, and a package.json with no version counts as installed');
  assert.deepEqual(lt.depDrift({}, () => null), { missing: [], mismatched: [] });
});

test('spec paths are escaped for --spec, the way fast-glob escapes a literal path', () => {
  assert.equal(lt.globEscape('cypress/e2e/a/plain_spec.cy.ts'), 'cypress/e2e/a/plain_spec.cy.ts');
  assert.equal(lt.globEscape('cypress/e2e/allowance/allowance_18_user_(team lead)_review.ts'),
    'cypress/e2e/allowance/allowance_18_user_\\(team lead\\)_review.ts');
  assert.equal(lt.globEscape('cypress/e2e/x/[draft]*?{a|b}.ts'), 'cypress/e2e/x/\\[draft\\]\\*\\?\\{a\\|b\\}.ts');
  assert.equal(lt.globEscape('cypress/e2e/x/a+(b).ts'), 'cypress/e2e/x/a\\+\\(b\\).ts');
  assert.equal(lt.globEscape('cypress/e2e/x/a+b@c!.ts'), 'cypress/e2e/x/a+b@c!.ts', 'extglob characters only before (');
});

test('the specs file: paths, {file} objects or a scope; only cypress/e2e paths; notRunnable left out of the run', () => {
  assert.deepEqual(lt.parseSpecs(['cypress/e2e/a.ts', 'cypress/e2e/a.ts', { file: 'cypress/e2e/b.ts' }]).specs, ['cypress/e2e/a.ts', 'cypress/e2e/b.ts']);
  const scope = lt.parseSpecs({
    specs: [{ file: 'cypress/e2e/a.ts', module: 'm' }, { file: 'cypress/e2e/mail.ts', module: 'm' }],
    notRunnable: [{ spec: 'cypress/e2e/mail.ts', why: 'needs a mailbox' }],
  });
  assert.deepEqual(scope, { specs: ['cypress/e2e/a.ts'], notRunnable: [{ spec: 'cypress/e2e/mail.ts', why: 'needs a mailbox' }] });
  for (const bad of [['cypress/e2e/../x.ts'], ['/abs/cypress/e2e/a.ts'], ['cypress/support/e2e.ts'], ['cypress/e2e/a,b.ts'], [7]]) {
    assert.throws(() => lt.parseSpecs(bad), /E_SPECS|spec/, JSON.stringify(bad));
  }
  assert.throws(() => lt.parseSpecs({ nope: true }), /neither a list/);
});

test('the specs file the conductor writes: {specs: string[], notRunnable}, notRunnable carried and never run', () => {
  const parsed = lt.parseSpecs({
    specs: ['cypress/e2e/a.ts', 'cypress/e2e/mail.ts', 'cypress/e2e/b(s).ts'],
    notRunnable: [
      { spec: 'cypress/e2e/mail.ts', why: '  needs a mailbox  ' },
      { spec: 'cypress/e2e/sso.ts' },
      { spec: 'cypress/e2e/mail.ts', why: 'duplicate' },
      { why: 'no spec' }, 'nope',
    ],
  });
  assert.deepEqual(parsed.specs, ['cypress/e2e/a.ts', 'cypress/e2e/b(s).ts']);
  assert.deepEqual(parsed.notRunnable, [
    { spec: 'cypress/e2e/mail.ts', why: 'needs a mailbox' },
    { spec: 'cypress/e2e/sso.ts', why: 'needs something a local machine does not have' },
  ]);
});

test('retry before blame: a test that passes on the retry is flaky and passed; one that fails twice stays failed', () => {
  const results: Row[] = [
    { spec: 's1', title: 'a', state: 'failed', durationMs: 1, error: 'AssertionError: first\nstack' },
    { spec: 's1', title: 'b', state: 'failed', durationMs: 1, error: 'AssertionError: again' },
    { spec: 's2', title: '(no results recorded)', state: 'failed', durationMs: 0, error: 'Cypress recorded no results' },
    { spec: 's3', title: '"before all" hook', state: 'failed', durationMs: 0, error: 'boom' },
    { spec: 's4', title: 'never retried', state: 'failed', durationMs: 0, error: 'x' },
    { spec: 's1', title: 'ok', state: 'passed', durationMs: 1 },
  ];
  const notes = lt.applyRetryResults(results, [
    { spec: 's1', title: 'a', state: 'passed', durationMs: 1 },
    { spec: 's1', title: 'b', state: 'failed', durationMs: 1, error: 'AssertionError: again' },
    { spec: 's2', title: 'real test', state: 'passed', durationMs: 1 },
    { spec: 's3', title: 'one', state: 'passed', durationMs: 1 },
    { spec: 's3', title: 'two', state: 'failed', durationMs: 1, error: 'y' },
  ]);
  assert.deepEqual(results.map((r) => [r.spec, r.title, r.state, r.flaky ?? null]), [
    ['s1', 'a', 'passed', true],
    ['s1', 'b', 'failed', null],
    ['s2', '(no results recorded)', 'passed', true],
    ['s3', '"before all" hook', 'failed', null],
    ['s4', 'never retried', 'failed', null],
    ['s1', 'ok', 'passed', null],
  ]);
  assert.equal(results[0]!.error, undefined, 'a flaky row is a pass: its first error lives in the note only');
  assert.equal(notes.length, 2);
  assert.match(notes[0]!, /^flaky: s1 › a failed on the first run \(AssertionError: first\) and passed on the retry/);
});

/* ------------------------------------------------------------------ child environment and redaction */

test('a child\'s environment: no Oneshot .env key and nothing named like a secret, PATH and libpq kept', () => {
  const source = {
    PATH: '/bin', HOME: '/h', GITLAB_TOKEN: 'glpat-x', SLACK_BOT_TOKEN: 'xoxb', CLAUDE_CODE_OAUTH_TOKEN: 'o', LANGFUSE_SECRET_KEY: 'k',
    LANGFUSE_PUBLIC_KEY: 'pk', GITLAB_PAT: 'p', MY_PASSWORD: 'pw', PGPASSWORD: 'pg', PGHOST: 'h', WORK_REPO: '/erp',
    ONESHOT_TEST_LOGIN: 'a@b:c', ONESHOT_HOME: '/home', CYPRESS_CACHE_FOLDER: '/c', FAKE_LOG: '/l', PATTERN: 'kept',
  };
  const dotenvKeys = ['WORK_REPO', 'ONESHOT_TEST_LOGIN', 'ONESHOT_HOME', 'PATH', 'PGHOST'];
  const strict = lt.scrubEnv(source, dotenvKeys);
  assert.deepEqual(Object.keys(strict).sort(), ['CYPRESS_CACHE_FOLDER', 'FAKE_LOG', 'HOME', 'ONESHOT_HOME', 'PATH', 'PATTERN']);
  const pg = lt.scrubEnv(source, dotenvKeys, { keepPg: true });
  assert.equal(pg.PGPASSWORD, 'pg');
  assert.equal(pg.PGHOST, 'h');
  assert.equal(pg.GITLAB_TOKEN, undefined);
});

test('redaction: every credential value and every secret-named variable\'s value becomes ***, anywhere in the output', () => {
  const secrets = lt.secretValuesFrom(
    [{ GITLAB_TOKEN: 'glpat-abcdef123', DRY_RUN: '1', ONESHOT_DAY_TOKENS: '5000000', ONESHOT_TEST_LOGIN: 'qa@x.com:Hunter22', WORK_REPO: '/Users/me/erp' }],
    { hrEmail: 'hr@arbisoft.example', nested: { password: 'S3cret!pw', short: 'abc' }, list: ['token-in-a-list'], flag: true },
  );
  for (const want of ['glpat-abcdef123', 'qa@x.com:Hunter22', 'Hunter22', 'hr@arbisoft.example', 'S3cret!pw', 'token-in-a-list']) {
    assert.ok(secrets.includes(want), want);
  }
  for (const not of ['1', '5000000', '/Users/me/erp', 'abc']) assert.ok(!secrets.includes(not), `${not} is not a secret`);
  const out = lt.redactWith(secrets, {
    status: 'failed', reason: 'saw glpat-abcdef123', notes: ['flaky: x (as hr@arbisoft.example)'],
    results: [{ spec: 's', title: 't', state: 'failed', durationMs: 1, error: 'Error: S3cret!pw rejected for qa@x.com:Hunter22' }],
    totals: { failed: 1 },
  }) as { reason: string; notes: string[]; results: Row[]; totals: { failed: number } };
  assert.equal(out.reason, 'saw ***');
  assert.deepEqual(out.notes, ['flaky: x (as ***)']);
  assert.equal(out.results[0]!.error, 'Error: *** rejected for ***');
  assert.equal(out.totals.failed, 1);
});

/* ------------------------------------------------------------------ webpack readiness, port holders */

test('webpack readiness: a fresh entrypoints file AND a last "Compiled" line; a failed compile or an old file is not ready', () => {
  const since = 1_000_000;
  const ep = (mtimeMs: number): FileState => ({ mtimeMs, json: { hash: 'h', entrypoints: { main: ['/static/js/bundle.js'] } } });
  const ready = (logText: string, entrypoints: FileState | null, stats: FileState | null = null): string =>
    lt.webpackReadiness({ logText, entrypoints, stats, sinceMs: since });
  assert.equal(ready('Compiling...\n\u001b[32mCompiled successfully!\u001b[39m\n', ep(since + 5)), 'compiled');
  assert.equal(ready('Compiling...\nCompiled with warnings.\n', ep(since + 5)), 'compiled');
  assert.equal(ready('Compiling...\n', ep(since + 5)), 'compiling', 'the plugin writes the file on a failed build too');
  assert.equal(ready('Compiled successfully!\n', ep(since - 60_000)), 'compiling', 'a file from before this app started proves nothing');
  assert.equal(ready('Compiled successfully!\n', null), 'compiling');
  assert.equal(ready('Compiled successfully!\nCompiling...\nFailed to compile.\n', ep(since + 5)), 'failed');
  assert.equal(ready('Failed to compile.\nCompiling...\nCompiled successfully!\n', ep(since + 5)), 'compiled', 'the LAST compile line counts');
  assert.equal(ready('Compiled successfully!\n', { mtimeMs: since + 5, json: { hash: 'h', entrypoints: {} } }), 'compiling');
  // A branch from before the switch still writes webpack-bundle-tracker's stats file.
  assert.equal(ready('Compiled successfully!\n', null, { mtimeMs: since + 5, json: { status: 'done' } }), 'compiled');
  assert.equal(ready('Compiling...\n', null, { mtimeMs: since + 5, json: { status: 'error' } }), 'failed');
});

test('a port held by another local-tests run or a harness is "try later"; anything else needs a person', () => {
  withHome((home) => {
    assert.equal(lt.portHolderIsOurs(join(home, 'state', 'runs', '12', 'erp-lt'), 'python manage.py runserver'), true);
    assert.equal(lt.portHolderIsOurs('/Users/x/oneshot-wt/state/runs/88/erp-base-lt/frontend', 'node start.js'), true, 'another home\'s run');
    assert.equal(lt.portHolderIsOurs('/Users/x', 'node /o/skills/local-browser-verify/scripts/harness.cjs up'), true);
    assert.equal(lt.portHolderIsOurs('/Users/x', '/Applications/Cypress.app/Contents/MacOS/Cypress'), true);
    assert.equal(lt.portHolderIsOurs('/Users/x/erp', 'python manage.py runserver 8030'), false);
    assert.equal(lt.portHolderIsOurs(null, ''), false);
  });
});

test('porcelain -z status: new and intent-to-add files are added specs, deletions removed', () => {
  const z = ['?? cypress/e2e/new.cy.ts', ' A cypress/e2e/ita.cy.ts', 'A  cypress/e2e/staged.cy.ts', ' D cypress/e2e/gone.cy.ts', ' M cypress/e2e/edit.cy.ts', ''].join('\0');
  assert.deepEqual(lt.statusSpecs(z), {
    added: ['cypress/e2e/ita.cy.ts', 'cypress/e2e/new.cy.ts', 'cypress/e2e/staged.cy.ts'],
    removed: ['cypress/e2e/gone.cy.ts'],
  });
});

test('.env parsing: comments, export, quotes and inline comments', () => {
  assert.deepEqual(lt.parseDotenv([
    '# comment', 'export A=1', 'B="two words"', "C='x # not a comment'", 'D=plain # trailing', 'E=', 'bad line', '=nokey',
  ].join('\n')), { A: '1', B: 'two words', C: 'x # not a comment', D: 'plain', E: '' });
});

test('settingsFrom agrees with localTestsConfig() in src/lib/config.ts, field for field and message for message', () => {
  const project = JSON.parse(readFileSync(join(ROOT, 'config/project.json'), 'utf8')) as Record<string, unknown>;
  const block = project.localTests as Record<string, unknown>;
  const cases: Array<[string, Record<string, unknown>, Record<string, string | undefined>]> = [
    ['desk on', project, { ONESHOT_LOCAL_TESTS_REPO: '/tmp/wsa' }],
    ['repo unset', project, {}],
    ['legacy spelling and overrides', project, {
      ONELOOP_LOCAL_TESTS_REPO: '~/wsa', ONESHOT_LOCAL_TESTS_PG_PORT: '6543', ONESHOT_LOCAL_TESTS_PG_USER: 'qa',
      ONESHOT_LOCAL_TESTS_BASELINE_DB: 'hrdb_other', ONESHOT_LOCAL_TESTS_CREDS: 'creds.json',
    }],
    ['placeholder repo', project, { ONESHOT_LOCAL_TESTS_REPO: '<your/path/to>/wsa' }],
    ['disabled', { ...project, localTests: { ...block, enabled: false } }, { ONESHOT_LOCAL_TESTS_REPO: '/tmp/wsa' }],
    ['no block', { ...project, localTests: undefined }, { ONESHOT_LOCAL_TESTS_REPO: '/tmp/wsa' }],
    ['bad fields', { ...project, localTests: { ...block, baselineDb: 'Bad-Name', maxSpecs: 0, allowedPaths: [], devApproval: 'most', failuresBlock: 'no' } },
      { ONESHOT_LOCAL_TESTS_REPO: '/tmp/wsa', ONESHOT_LOCAL_TESTS_PG_PORT: '99999' }],
    ['prefix matches baseline', { ...project, localTests: { ...block, dbPrefix: 'hrdb_' } }, { ONESHOT_LOCAL_TESTS_REPO: '/tmp/wsa' }],
  ];
  for (const [name, cfg, env] of cases) {
    assert.deepEqual(lt.settingsFrom(cfg, env), localTestsConfig(cfg as never, env), name);
  }
});

/**
 * The in-process helpers that resolve state/runs read ONESHOT_HOME at call time. Pinned
 * to a temp home for the call, so the answer never depends on the desk's .env (a
 * DRY_RUN=1 there would move the runs dir to state-dry/).
 */
function withHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), 'lt-home-'));
  const was = { h: process.env.ONESHOT_HOME, l: process.env.ONELOOP_HOME };
  process.env.ONESHOT_HOME = home;
  try {
    return fn(home);
  } finally {
    if (was.h === undefined) delete process.env.ONESHOT_HOME; else process.env.ONESHOT_HOME = was.h;
    if (was.l === undefined) delete process.env.ONELOOP_HOME; else process.env.ONELOOP_HOME = was.l;
    rmSync(home, { recursive: true, force: true });
  }
}

test('only state/runs/<iid>/{wsa,wsa-run,erp-lt,erp-base-lt} counts as a worktree this script may remove', () => {
  withHome((home) => {
    const runs = join(home, 'state', 'runs');
    assert.equal(lt.runsDir(), runs);
    assert.equal(lt.isOurWorktreePath(join(runs, '12', 'wsa')), true);
    assert.equal(lt.isOurWorktreePath(join(runs, '12', 'erp-base-lt')), true);
    assert.equal(lt.isOurWorktreePath(join(runs, '12', 'harness')), false);
    assert.equal(lt.isOurWorktreePath(join(runs, '12', 'wsa', 'cypress')), false);
    assert.equal(lt.isOurWorktreePath(join(runs, 'adhoc', 'wsa')), false);
    assert.equal(lt.isOurWorktreePath(join(ROOT, 'wsa')), false);
  });
});

test('a stale resources file is cut down to what this ticket could have recorded before anything acts on it', () => {
  withHome((home) => {
    const run = join(home, 'state', 'runs', '12');
    const ctx: StaleCtx = {
      run, iid: 12, ports: { be: 8030, fe: 9030 }, dbPrefix: 'oneshot_lt_', baselineDb: 'hrdb_automation_baseline_20261002',
      gitDirs: [join(home, 'wsa.git')],
    };
    const { data, ignored } = lt.sanitizeStale({
      pid: 999999,
      worktrees: [
        { path: join(run, 'wsa-run'), gitDir: join(home, 'wsa.git') },
        { path: join(run, 'erp-lt'), gitDir: '/somewhere/else.git' },
        { path: '/' }, { path: join(home, 'state', 'runs', '13', 'erp-lt') }, 'nope',
      ],
      harnessDirs: [join(run, 'lt-harness'), '/tmp', join(run, 'harness')],
      cypressPgids: [4242, -1, 1, '77'],
      ports: { be: 5433, fe: 9030 },
      db: 'oneshot_lt_12_3',
      baseDb: 'oneshot_lt_13_1',
    }, ctx);
    assert.deepEqual(data.worktrees, [{ path: join(run, 'wsa-run'), gitDir: join(home, 'wsa.git') }, { path: join(run, 'erp-lt') }],
      'only this ticket\'s worktree names survive; an unknown git dir is dropped, to be worked out from the worktree');
    assert.deepEqual(data.harnessDirs, [join(run, 'lt-harness')]);
    assert.deepEqual(data.cypressPgids, [4242]);
    assert.deepEqual(data.ports, { be: null, fe: 9030 }, 'the Postgres port is never "ours"');
    assert.equal(data.db, 'oneshot_lt_12_3');
    assert.equal(data.baseDb, null, 'another ticket\'s copy is not this run\'s to drop');
    assert.equal(data.pid, 999999);
    assert.equal(ignored.length, 10, ignored.join(' | '));
    assert.deepEqual(lt.sanitizeStale({ db: 'hrdb_automation_baseline_20261002', worktrees: 'x' }, ctx).data.db, null);
  });
});

/* ------------------------------------------------------------------ commands, against temp repos */

function write(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
}

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

/** A workstream-automation stand-in: specs, a page object, a committed cypress.env.json. */
function automationRepo(): { repo: string; sha: string } {
  const repo = mkdtempSync(join(tmpdir(), 'lt-wsa-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  write(repo, {
    '.gitignore': 'node_modules\ncypress/results\ncypress/videos\n',
    'cypress.config.ts': 'export default {};\n',
    'cypress.env.json': '{\n  "SERVER": "http://localhost:8000",\n  "HR_CREDENTIALS": "committed-placeholder"\n}\n',
    'cypress/Pages/leaves/page.ts': "export const open = () => {\n  cy.get('[data-testid=\"leaves\"]').click();\n};\n",
    'cypress/e2e/leaves/apply.cy.ts': "describe('Leaves', () => {\n  it('applies', () => {\n    cy.get('[data-testid=\"old-id\"]').should('be.visible');\n  });\n});\n",
    'cypress/e2e/leaves/old.cy.ts': "describe('Old', () => {\n  it('one', () => {\n    cy.get('a').should('exist');\n  });\n});\n",
    'node_modules/dummy/package.json': '{}\n',
  });
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  return { repo, sha: git(repo, 'rev-parse', 'HEAD') };
}

interface Cli { code: number | null; json: Record<string, unknown>; stderr: string }

function cli(env: Record<string, string>, ...args: string[]): Cli {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60000,
  });
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(r.stdout) as Record<string, unknown>; } catch {
    assert.fail(`stdout was not one JSON object: ${r.stdout}\nstderr: ${r.stderr}`);
  }
  return { code: r.status, json, stderr: r.stderr };
}

/** A throwaway desk: its own state/, the temp repo as both clones, Postgres on a closed port. */
function deskEnv(repo: string): { home: string; env: Record<string, string> } {
  const home = mkdtempSync(join(tmpdir(), 'lt-home-'));
  return {
    home,
    env: {
      ONESHOT_HOME: home,
      ONESHOT_LOCAL_TESTS_REPO: repo,
      WORK_REPO: repo,
      ONESHOT_SEED_FROM: repo,
      ONESHOT_LOCAL_TESTS_PG_HOST: '127.0.0.1',
      ONESHOT_LOCAL_TESTS_PG_PORT: '1',
      ONESHOT_LOCAL_TESTS_CREDS: join(home, 'creds.json'),
      DRY_RUN: '',
    },
  };
}

test('prepare-scope then capture: the edits become a checked patch, and the worktree is gone', () => {
  const { repo, sha } = automationRepo();
  const { home, env } = deskEnv(repo);
  try {
    const prep = cli(env, 'prepare-scope', '--iid', '4242', '--automation-ref', 'main');
    assert.equal(prep.code, 0, prep.stderr);
    const wsa = join(home, 'state/runs/4242/wsa');
    assert.deepEqual(prep.json, { wsa, automationSha: sha });
    assert.equal(git(wsa, 'rev-parse', 'HEAD'), sha);
    assert.ok(lstatSync(join(wsa, 'node_modules')).isSymbolicLink());

    // The scope session's edits: one legitimate, the rest each something capture must see.
    write(wsa, {
      'cypress/e2e/leaves/apply.cy.ts': "describe('Leaves', () => {\n  it('applies', () => {\n    cy.get('[data-testid=\"new-id\"]').should('be.visible');\n  });\n});\n",
      'cypress/e2e/leaves/TR_LOCAL_banner.cy.ts': "it('dismisses', () => {\n  cy.get('b').click({ force: true });\n});\n",
      'cypress/Pages/leaves/page.ts': "export const open = () => {\n  cy.get('[data-testid=\"leaves\"]').click();\n  cy.wait(5000);\n};\n",
      'cypress.env.json': '{ "SERVER": "x", "HR_CREDENTIALS": "SESSION-WROTE-THIS" }\n',
      'cypress.config.ts': 'export default { retries: 5 };\n',
    });
    rmSync(join(wsa, 'cypress/e2e/leaves/old.cy.ts'));

    const cap = cli(env, 'capture', '--iid', '4242');
    assert.equal(cap.code, 0, cap.stderr);
    const patchFile = join(home, 'state/runs/4242/artifacts/local-tests/temporary-changes.patch');
    const patch = readFileSync(patchFile);
    assert.equal(cap.json.patchFile, patchFile);
    assert.equal(cap.json.patchSha, sha256(patch));
    assert.equal(cap.json.automationSha, sha);
    assert.deepEqual(cap.json.changedFiles, [
      'cypress.config.ts', 'cypress/Pages/leaves/page.ts', 'cypress/e2e/leaves/TR_LOCAL_banner.cy.ts',
      'cypress/e2e/leaves/apply.cy.ts', 'cypress/e2e/leaves/old.cy.ts',
    ]);
    assert.deepEqual(cap.json.outsideAllowed, ['cypress.config.ts', 'cypress.env.json']);
    assert.deepEqual(cap.json.weakened, [
      'cypress/Pages/leaves/page.ts', 'cypress/e2e/leaves/TR_LOCAL_banner.cy.ts', 'cypress/e2e/leaves/old.cy.ts',
    ]);
    assert.deepEqual(cap.json.addedSpecs, ['cypress/e2e/leaves/TR_LOCAL_banner.cy.ts']);
    assert.deepEqual(cap.json.removedSpecs, ['cypress/e2e/leaves/old.cy.ts']);

    // The credentials file never travels, and the worktree and its registration are gone.
    assert.doesNotMatch(patch.toString(), /cypress\.env\.json|SESSION-WROTE-THIS|committed-placeholder/);
    assert.equal(existsSync(wsa), false);
    assert.equal(git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 1);
    assert.equal(git(repo, 'status', '--porcelain'), '');
    const record = JSON.parse(readFileSync(join(home, 'state/runs/4242/local-tests-capture.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(record.patchSha, cap.json.patchSha);

    // The patch is exactly what a fresh worktree at that commit can take.
    const check = join(home, 'check');
    git(repo, 'worktree', 'add', '-q', '--detach', check, sha);
    git(check, 'apply', '--check', patchFile);
    git(check, 'apply', patchFile);
    assert.match(readFileSync(join(check, 'cypress/e2e/leaves/apply.cy.ts'), 'utf8'), /new-id/);
    assert.ok(existsSync(join(check, 'cypress/e2e/leaves/TR_LOCAL_banner.cy.ts')));
    assert.equal(existsSync(join(check, 'cypress/e2e/leaves/old.cy.ts')), false);
    git(repo, 'worktree', 'remove', '--force', check);

    // A second round with no edits: no patch, and the first round's file is not left to be mistaken for it.
    assert.equal(cli(env, 'prepare-scope', '--iid', '4242', '--automation-ref', sha).code, 0);
    const empty = cli(env, 'capture', '--iid', '4242');
    assert.equal(empty.code, 0, empty.stderr);
    assert.equal(empty.json.patchSha, null);
    assert.equal(empty.json.patchFile, null);
    assert.deepEqual(empty.json.changedFiles, []);
    assert.equal(existsSync(patchFile), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('capture without a prepared worktree, and prepare-scope on an unknown ref, are named errors', () => {
  const { repo } = automationRepo();
  const { home, env } = deskEnv(repo);
  try {
    const cap = cli(env, 'capture', '--iid', '77');
    assert.equal(cap.code, 1);
    assert.equal(cap.json.code, 'E_NO_WSA');
    const prep = cli(env, 'prepare-scope', '--iid', '77', '--automation-ref', 'no-such-branch');
    assert.equal(prep.code, 1);
    assert.equal(prep.json.code, 'E_REF_UNRESOLVED');
    assert.deepEqual(Object.keys(prep.json).sort(), ['code', 'hint', 'message']);
    assert.equal(cli(env, 'prepare-scope').json.code, 'E_ARGS');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('status and gc: leftovers listed, --dry-run and --keep spare them, gc removes them', () => {
  const { repo, sha } = automationRepo();
  const { home, env } = deskEnv(repo);
  try {
    assert.equal(cli(env, 'prepare-scope', '--iid', '5151', '--automation-ref', 'main').code, 0);
    const wsa = join(home, 'state/runs/5151/wsa');

    const st = cli(env, 'status');
    assert.equal(st.code, 0, st.stderr);
    assert.deepEqual(st.json.worktrees, [{ iid: 5151, name: 'wsa', path: wsa, head: sha }]);
    assert.deepEqual(st.json.dbs, []);
    assert.match(String((st.json.errors as string[])[0]), /^databases: /);

    const dry = cli(env, 'gc', '--dry-run');
    assert.equal(dry.code, 0, dry.stderr);
    assert.deepEqual(dry.json.removed, [wsa]);
    assert.ok(existsSync(wsa));

    const kept = cli(env, 'gc', '--keep', '5151');
    assert.deepEqual(kept.json.removed, []);
    assert.ok(existsSync(wsa));

    const gone = cli(env, 'gc');
    assert.equal(gone.code, 0, gone.stderr);
    assert.deepEqual(gone.json.removed, [wsa]);
    assert.equal(existsSync(wsa), false);
    assert.equal(git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 1);
    assert.ok(existsSync(join(repo, 'node_modules/dummy/package.json')), 'the symlinked node_modules was not followed');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('run refuses or skips before taking anything: step off, bad specs, a changed patch, nothing to run', () => {
  const { repo, sha } = automationRepo();
  const { home, env } = deskEnv(repo);
  try {
    const specs = join(home, 'specs.json');
    const base = ['run', '--iid', '6161', '--worktree', repo, '--ref', sha, '--automation-sha', sha, '--specs-file', specs];

    writeFileSync(specs, JSON.stringify(['cypress/e2e/leaves/apply.cy.ts']));
    const off = cli({ ...env, ONESHOT_LOCAL_TESTS_REPO: '' }, ...base);
    assert.equal(off.code, 1);
    assert.equal(off.json.code, 'E_CONFIG');
    assert.match(String(off.json.message), /ONESHOT_LOCAL_TESTS_REPO is not set/);

    writeFileSync(specs, JSON.stringify(['cypress/e2e/../../etc/passwd']));
    assert.equal(cli(env, ...base).json.code, 'E_SPECS');

    writeFileSync(specs, JSON.stringify(['cypress/e2e/leaves/apply.cy.ts']));
    const patch = join(home, 'p.patch');
    writeFileSync(patch, 'diff --git a/x b/x\n');
    const changed = cli(env, ...base, '--patch', patch, '--patch-sha', 'f'.repeat(64));
    assert.equal(changed.json.code, 'E_PATCH_MISMATCH');

    writeFileSync(specs, JSON.stringify({ specs: [{ file: 'cypress/e2e/mail.cy.ts' }], notRunnable: [{ spec: 'cypress/e2e/mail.cy.ts', why: 'needs a mailbox' }] }));
    const skipped = cli(env, ...base);
    assert.equal(skipped.code, 0, skipped.stderr);
    assert.equal(skipped.json.status, 'skipped');
    assert.equal(skipped.json.ticketSha, sha);
    assert.equal(skipped.json.automationSha, sha);
    assert.match(String(skipped.json.cacheKey), /^[0-9a-f]{64}$/);
    assert.deepEqual(skipped.json.notRunnable, [{ spec: 'cypress/e2e/mail.cy.ts', why: 'needs a mailbox' }]);
    assert.equal(existsSync(join(home, 'state/runs/6161/local-tests-resources.json')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ run, end to end, with fakes */

/**
 * `run` driven through every step with stand-ins for the five things it shells out to —
 * psql, createdb, the venv's python, harness.cjs and Cypress — so the orchestration is
 * proven without a database, an app, a browser or the desk's ports: the resources file,
 * the order of cleanup, the retry, the base re-run's verdicts, the deadline and a SIGTERM.
 *
 * The fakes log what they were asked into FAKE_LOG, which is how the tests see that the
 * copies were created from the baseline and dropped by name, and that Cypress found a
 * mode-600 cypress.env.json with the desk's credentials merged in — as a boolean, so not
 * even a fake secret reaches a log.
 */
const FAKE_PSQL = `#!/bin/sh
echo "$@" >> "$FAKE_LOG/psql.log"
for a in "$@"; do sql="$a"; done
case "$sql" in
  "SELECT 1") echo 1 ;;
  *"FROM pg_database WHERE datname ="*) echo 1 ;;
  *pg_stat_activity*)
    if [ -n "$FAKE_BUSY_DB" ] && printf '%s' "$sql" | grep -q "$FAKE_BUSY_DB"; then echo 1; else echo 0; fi ;;
  *"left(datname"*) cat "$FAKE_LOG/dbs" 2>/dev/null ;;
esac
exit 0
`;

const FAKE_CREATEDB = `#!/bin/sh
echo "$@" >> "$FAKE_LOG/createdb.log"
echo "$PGAPPNAME" >> "$FAKE_LOG/createdb-appname.log"
for a in "$@"; do db="$a"; done
echo "$db" >> "$FAKE_LOG/dbs"
exit 0
`;

/** Prints what the worktree's settings would give Django: the copy, the broker and the cache prefix it was handed. */
const FAKE_PYTHON = `#!/bin/sh
case "$*" in
  *ONESHOT_DB*)
    name=$(sed -n "s/.*'NAME': '\\([^']*\\)'.*/\\1/p" hrdb/local_settings.py)
    broker=$(sed -n "s/^CELERY_BROKER_URL = '\\(.*\\)'$/\\1/p" hrdb/local_settings.py | tail -1)
    prefix=$(sed -n "s/^DATABASE_NAME = '\\(.*\\)'$/\\1/p" hrdb/local_settings.py | tail -1)
    echo "ONESHOT_DB {\\"name\\": \\"$name\\", \\"host\\": \\"127.0.0.1\\", \\"port\\": \\"5432\\", \\"e2e\\": true, \\"broker\\": \\"$broker\\", \\"keyPrefix\\": \\"$prefix\\"}" ;;
  *migrate*) echo "Running migrations: OK" ; echo "migrate $(pwd)" >> "$FAKE_LOG/python.log" ;;
esac
exit 0
`;

/**
 * harness.cjs up/down. `up` on live servers reuses them, as the real one does. With
 * FAKE_HARNESS_SLOW the first `up` gives up the way the real one does past its 20 min
 * (E_WEBPACK_DEAD) while "webpack" carries on: it logs "Compiled successfully!" and writes
 * static/webpack-entrypoints.dev.json a moment later.
 */
const FAKE_HARNESS = `const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const h = path.join(process.env.ONESHOT_RUN_DIR, 'harness');
const servers = path.join(h, 'servers.json');
const log = (o) => fs.appendFileSync(path.join(process.env.FAKE_LOG, 'harness.log'), JSON.stringify(o) + '\\n');
const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
if (process.argv[2] === 'up') {
  fs.mkdirSync(h, { recursive: true });
  const prev = fs.existsSync(servers) ? JSON.parse(fs.readFileSync(servers, 'utf8')) : null;
  if (prev && alive(prev.djangoPid) && alive(prev.webpackPid)) {
    log({ reuse: prev.worktree, pids: [prev.djangoPid, prev.webpackPid] });
    console.log(JSON.stringify({ baseUrl: 'http://localhost:' + prev.bePort, bePort: prev.bePort, fePort: prev.fePort }));
    return;
  }
  const wt = process.env.ONESHOT_WORKTREE;
  const mk = () => { const c = spawn('sleep', ['300'], { cwd: wt, detached: true, stdio: 'ignore' }); c.unref(); return c.pid; };
  let webpackPid;
  if (process.env.FAKE_HARNESS_SLOW) {
    const wlog = path.join(h, 'webpack.log');
    fs.writeFileSync(wlog, 'Compiling...\\n');
    const code = "const fs = require('fs'); setTimeout(() => { fs.appendFileSync(process.env.WLOG, 'Compiled successfully!\\\\n');"
      + " fs.mkdirSync('static', { recursive: true }); fs.writeFileSync('static/webpack-entrypoints.dev.json', JSON.stringify({ hash: 'h', entrypoints: { main: ['b.js'] } })); }, 1500);"
      + ' setInterval(() => {}, 1000);';
    const c = spawn(process.execPath, ['-e', code], { cwd: wt, detached: true, stdio: 'ignore', env: { ...process.env, WLOG: wlog } });
    c.unref();
    webpackPid = c.pid;
  } else webpackPid = mk();
  const s = { djangoPid: mk(), webpackPid, bePort: Number(process.env.ONESHOT_PORT), fePort: Number(process.env.ONESHOT_FE_PORT), worktree: wt, startedAt: Date.now() };
  fs.writeFileSync(servers, JSON.stringify(s));
  fs.writeFileSync(path.join(process.env.FAKE_LOG, 'current-app'), wt);
  log({ up: wt, pids: [s.djangoPid, s.webpackPid] });
  if (process.env.FAKE_HARNESS_SLOW) {
    console.log(JSON.stringify({ code: 'E_WEBPACK_DEAD', message: 'webpack did not finish within 20 min', hint: 'still compiling' }));
    process.exit(1);
  }
  console.log(JSON.stringify({ baseUrl: 'http://localhost:' + s.bePort, bePort: s.bePort, fePort: s.fePort }));
} else if (process.argv[2] === 'down') {
  const s = JSON.parse(fs.readFileSync(servers, 'utf8'));
  for (const p of [s.webpackPid, s.djangoPid]) { try { process.kill(-p, 'SIGTERM'); } catch { /* gone */ } }
  fs.rmSync(servers, { force: true });
  console.log('{"stopped":[]}');
}
`;

/**
 * Cypress, reading what it was given like the real one: --spec as globs (an escaped
 * character is the character). fail_both fails on every app; fail_ticket on the ticket's
 * app only; flaky only on the very first Cypress run of the whole `run`. fail_both and
 * flaky put the desk's credential in their error, as a careless spec would.
 */
const FAKE_CYPRESS = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const log = process.env.FAKE_LOG;
fs.writeFileSync(path.join(log, 'cypress-started'), String(process.pid));
const args = process.argv.slice(2);
const arg = args[args.indexOf('--spec') + 1].split(',');
const specs = arg.map((s) => s.replace(/\\\\(.)/g, '$1'));
const server = args[args.indexOf('--env') + 1];
const countFile = path.join(log, 'cypress-count');
const n = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, 'utf8') : 0) + 1;
fs.writeFileSync(countFile, String(n));
const app = fs.existsSync(path.join(log, 'current-app')) ? fs.readFileSync(path.join(log, 'current-app'), 'utf8') : '';
const onBase = app.endsWith('erp-base-lt');
const envFile = path.join(process.cwd(), 'cypress.env.json');
const e = JSON.parse(fs.readFileSync(envFile, 'utf8'));
fs.appendFileSync(path.join(log, 'cypress.log'), JSON.stringify({
  run: n, arg, specs, server, onBase, mode: (fs.statSync(envFile).mode & 0o777).toString(8),
  merged: e.HR_CREDENTIALS === 'desk-secret' && e.SERVER === 'committed-server',
  sawToken: Boolean(process.env.GITLAB_TOKEN || process.env.SLACK_BOT_TOKEN || process.env.LT_TEST_PASSWORD),
  sawPath: Boolean(process.env.PATH),
}) + '\\n');
if (process.env.FAKE_CYPRESS_HANG) { setInterval(() => {}, 1000); return; }
const dir = path.join('cypress', 'results', '.jsons');
fs.mkdirSync(dir, { recursive: true });
let failures = 0;
specs.forEach((spec, i) => {
  const fail = spec.includes('fail_both') || (spec.includes('fail_ticket') && !onBase) || (spec.includes('flaky') && n === 1);
  if (fail) failures += 1;
  const leak = spec.includes('fail_both') || spec.includes('flaky') ? ' (logged in as ' + e.HR_CREDENTIALS + ')' : '';
  const test = { uuid: n + '-' + i, title: 't', fullTitle: 'S ' + path.basename(spec), state: fail ? 'failed' : 'passed', duration: 10, err: fail ? { message: 'AssertionError: boom' + leak + '\\n  at stack' } : {} };
  fs.writeFileSync(path.join(dir, 'mochawesome_' + String(i).padStart(3, '0') + '.json'),
    JSON.stringify({ results: [{ file: spec, tests: [], suites: [{ title: 'S', tests: [test], suites: [] }] }] }));
  if (fail) {
    const v = path.join('cypress', 'videos', spec.replace(/^cypress\\/e2e\\//, '') + '.mp4');
    fs.mkdirSync(path.dirname(v), { recursive: true });
    fs.writeFileSync(v, 'video');
  }
});
process.exit(failures);
`;

const SPECS3 = ['cypress/e2e/m/pass.cy.ts', 'cypress/e2e/m/fail_both.cy.ts', 'cypress/e2e/m/fail_ticket.cy.ts'];
/** The end-to-end set: the three above, a flaky one, and one whose name Cypress would read as a glob. */
const SPECS5 = [...SPECS3, 'cypress/e2e/m/flaky.cy.ts', 'cypress/e2e/m/pass_(team lead).cy.ts'];

async function freePort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

function exe(file: string, body: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body, { mode: 0o755 });
}

interface FakeDesk {
  root: string; home: string; logs: string; erp: string; wsa: string; seed: string; ticketSha: string; autoSha: string;
  env: Record<string, string>; specsFile: string;
}

async function fakeDesk(): Promise<FakeDesk> {
  const root = mkdtempSync(join(tmpdir(), 'lt-run-'));
  const home = join(root, 'home');
  const logs = join(root, 'logs');
  mkdirSync(logs, { recursive: true });

  // The ERP clone: `dev` is the base, the ticket is one commit on top.
  const erp = join(root, 'erp');
  mkdirSync(erp);
  git(erp, 'init', '-q', '-b', 'dev');
  git(erp, 'config', 'user.email', 'test@example.com');
  git(erp, 'config', 'user.name', 'Test');
  write(erp, { 'package.json': '{"dependencies":{"react":"^18.2.0"},"devDependencies":{"@babel/core":"7"}}\n', 'hrdb/__init__.py': '', 'manage.py': '' });
  git(erp, 'add', '.');
  git(erp, 'commit', '-q', '-m', 'base');
  git(erp, 'checkout', '-q', '-b', 'ticket');
  write(erp, { 'apps/x.py': 'x = 1\n' });
  git(erp, 'add', '.');
  git(erp, 'commit', '-q', '-m', 'ticket');
  const ticketSha = git(erp, 'rev-parse', 'HEAD');

  // The installed seed checkout the throwaway borrows from.
  const seed = join(root, 'seed');
  exe(join(seed, 'venv/bin/python'), FAKE_PYTHON);
  write(seed, {
    'node_modules/react/package.json': '{"name":"react","version":"18.3.1"}', 'node_modules/@babel/core/package.json': '{}',
    'node_modules/react-dev-utils/package.json': '{}',
    'staticfiles/staticfiles.json': '{}',
    'frontend/src/constants/config.js': "export const apiUrl = 'http://localhost:8000/';\n",
    'hrdb/local_settings.py': SEED_SETTINGS,
  });

  // The automation clone, its Cypress a fake that reads the specs and writes reports.
  const wsa = join(root, 'wsa');
  mkdirSync(wsa);
  git(wsa, 'init', '-q', '-b', 'master');
  git(wsa, 'config', 'user.email', 'test@example.com');
  git(wsa, 'config', 'user.name', 'Test');
  write(wsa, {
    '.gitignore': 'node_modules\ncypress/results\ncypress/videos\n',
    'package.json': '{"name":"wsa-fake","version":"1.0.0","devDependencies":{"cypress":"^14.0.0"}}\n',
    'cypress.env.json': '{"SERVER":"committed-server","HR_CREDENTIALS":"committed-placeholder"}\n',
    ...Object.fromEntries(SPECS5.map((s) => [s, "it('t', () => {});\n"])),
  });
  exe(join(wsa, 'node_modules/.bin/cypress'), FAKE_CYPRESS);
  write(wsa, { 'node_modules/cypress/package.json': '{"name":"cypress","version":"14.5.4"}' });
  git(wsa, 'add', '.');
  git(wsa, 'commit', '-q', '-m', 'init');
  const autoSha = git(wsa, 'rev-parse', 'HEAD');

  const bin = join(root, 'bin');
  exe(join(bin, 'psql'), FAKE_PSQL);
  exe(join(bin, 'createdb'), FAKE_CREATEDB);
  const harness = join(root, 'fake-harness.cjs');
  writeFileSync(harness, FAKE_HARNESS);
  const creds = join(root, 'creds.json');
  writeFileSync(creds, '{"HR_CREDENTIALS":"desk-secret"}\n', { mode: 0o600 });
  const specsFile = join(root, 'specs.json');
  writeFileSync(specsFile, JSON.stringify({ specs: SPECS3.map((file) => ({ file, module: 'm', cases: 1, why: 'x' })) }));

  return {
    root, home, logs, erp, wsa, seed, ticketSha, autoSha, specsFile,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_LOG: logs,
      ONESHOT_HOME: home,
      ONESHOT_LOCAL_TESTS_REPO: wsa,
      ONESHOT_LOCAL_TESTS_CREDS: creds,
      ONESHOT_LOCAL_TESTS_HARNESS: harness,
      ONESHOT_LOCAL_TESTS_PG_HOST: '127.0.0.1',
      ONESHOT_LOCAL_TESTS_PG_PORT: '5432',
      ONESHOT_LOCAL_TESTS_PG_USER: 'tester',
      ONESHOT_LOCAL_TESTS_PORT: String(await freePort()),
      ONESHOT_LOCAL_TESTS_FE_PORT: String(await freePort()),
      ONESHOT_SEED_FROM: seed,
      WORK_REPO: erp,
      DRY_RUN: '',
      // What the conductor's own environment carries: never for Cypress, never printed.
      GITLAB_TOKEN: 'glpat-fake-token-0001',
      SLACK_BOT_TOKEN: 'xoxb-fake-token-0002',
      LT_TEST_PASSWORD: 'fake-password-0003',
    },
  };
}

const lines = (f: string): string[] => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : []);
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const worktreeCount = (repo: string): number => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length;

/** Nothing of the run is left: copies dropped, servers stopped, worktrees gone, resources file gone. */
function assertReleased(f: FakeDesk, iid: number, ...dbs: string[]): void {
  const run = join(f.home, 'state/runs', String(iid));
  const drops = lines(join(f.logs, 'psql.log')).filter((l) => /DROP DATABASE/.test(l));
  for (const db of dbs) assert.ok(drops.some((l) => l.includes(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`)), `${db} was dropped by name`);
  assert.ok(drops.every((l) => dbs.some((db) => l.includes(`"${db}"`))), `nothing else was dropped: ${drops.join(' | ')}`);
  for (const l of lines(join(f.logs, 'harness.log'))) {
    for (const pid of (JSON.parse(l) as { pids: number[] }).pids) assert.equal(alive(pid), false, `server ${pid} stopped`);
  }
  for (const name of ['wsa-run', 'erp-lt', 'erp-base-lt']) assert.equal(existsSync(join(run, name)), false, `${name} removed`);
  assert.equal(worktreeCount(f.erp), 1);
  assert.equal(worktreeCount(f.wsa), 1);
  assert.equal(existsSync(join(run, 'local-tests-resources.json')), false);
  assert.ok(existsSync(join(f.root, 'seed/venv/bin/python')), 'the seed behind the symlinks is untouched');
}

interface RunOut { status: string; reason?: string; db: string; results: Row[]; totals: Record<string, number>; notes?: string[]; [k: string]: unknown }
interface CypressRun { run: number; arg: string[]; specs: string[]; mode: string; merged: boolean; server: string; onBase: boolean; sawToken: boolean; sawPath: boolean }

function runScript(f: FakeDesk, iid: number, extra: string[], env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [SCRIPT, 'run', '--iid', String(iid), '--worktree', f.erp, '--ref', f.ticketSha,
    '--specs-file', f.specsFile, '--automation-sha', f.autoSha, ...extra],
  { encoding: 'utf8', env: { ...process.env, ...f.env, ...env }, timeout: 120000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const cypressRuns = (f: FakeDesk): CypressRun[] => lines(join(f.logs, 'cypress.log')).map((l) => JSON.parse(l) as CypressRun);

test('run, end to end with fakes: checks first, copy, migrate, app, Cypress, retry, base re-run on its own copy, results, everything released', async () => {
  const f = await fakeDesk();
  try {
    // What the conductor writes: {specs: string[], notRunnable}.
    writeFileSync(f.specsFile, JSON.stringify({ specs: SPECS5, notRunnable: [{ spec: 'cypress/e2e/m/mail.cy.ts', why: 'needs a mailbox' }] }));
    const r = runScript(f, 7171, ['--base', 'dev']);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout) as RunOut;

    assert.equal(out.status, 'failed');
    assert.equal(out.db, 'oneshot_lt_7171_1');
    assert.equal(out.ticketSha, f.ticketSha);
    assert.equal(out.automationSha, f.autoSha);
    assert.equal(out.patchSha, null);
    assert.equal(out.cacheKey, lt.cacheKey({ ticketSha: f.ticketSha, automationSha: f.autoSha, patchSha: null, specs: SPECS5, baseline: 'hrdb_automation_baseline_20261002' }));
    assert.deepEqual(out.notRunnable, [{ spec: 'cypress/e2e/m/mail.cy.ts', why: 'needs a mailbox' }]);
    assert.deepEqual(out.totals, { specs: 5, tests: 5, passed: 3, failed: 2, skipped: 0 });
    const bySpec = Object.fromEntries(out.results.map((x) => [x.spec, x]));
    assert.equal(bySpec['cypress/e2e/m/pass.cy.ts']!.state, 'passed');
    assert.equal(bySpec['cypress/e2e/m/pass.cy.ts']!.failingOnDev, undefined);
    assert.equal(bySpec['cypress/e2e/m/pass_(team lead).cy.ts']!.state, 'passed', 'found through the escaped --spec, reported by its real path');
    assert.equal(bySpec['cypress/e2e/m/fail_both.cy.ts']!.failingOnDev, true);
    assert.equal(bySpec['cypress/e2e/m/fail_ticket.cy.ts']!.failingOnDev, false);
    assert.equal(bySpec['cypress/e2e/m/fail_ticket.cy.ts']!.error, 'AssertionError: boom');
    // Retry before blame: failed first, passed on the retry on the ticket's code.
    assert.deepEqual(bySpec['cypress/e2e/m/flaky.cy.ts'], {
      spec: 'cypress/e2e/m/flaky.cy.ts', title: 'S flaky.cy.ts', state: 'passed', durationMs: 10, flaky: true,
    });
    const flakyNotes = (out.notes || []).filter((n) => n.startsWith('flaky: '));
    assert.equal(flakyNotes.length, 1);
    assert.match(flakyNotes[0]!, /cypress\/e2e\/m\/flaky\.cy\.ts › S flaky\.cy\.ts failed on the first run \(AssertionError: boom \(logged in as \*\*\*\)\)/);
    // The credential a spec put in its error is ***, in the row and in the note.
    assert.equal(bySpec['cypress/e2e/m/fail_both.cy.ts']!.error, 'AssertionError: boom (logged in as ***)');
    const video = (bySpec['cypress/e2e/m/fail_both.cy.ts'] as Row & { video?: string }).video;
    assert.equal(video, 'local-tests/videos/m/fail_both.cy.ts.mp4');
    assert.ok(existsSync(join(f.home, 'state/runs/7171/artifacts', String(video))));

    // Two copies from the baseline as the configured role, each createdb findable by name.
    assert.deepEqual(lines(join(f.logs, 'createdb.log')), [
      '-h 127.0.0.1 -p 5432 -U tester -w -T hrdb_automation_baseline_20261002 oneshot_lt_7171_1',
      '-h 127.0.0.1 -p 5432 -U tester -w -T hrdb_automation_baseline_20261002 oneshot_lt_7171_2',
    ]);
    assert.deepEqual(lines(join(f.logs, 'createdb-appname.log')), ['oneshot_lt_7171_1', 'oneshot_lt_7171_2']);
    // Each copy migrated by its own code: the ticket's, then the base's on the fresh one.
    assert.deepEqual(lines(join(f.logs, 'python.log')).map((l) => l.split('/').pop()), ['erp-lt', 'erp-base-lt']);
    // Three Cypress runs: everything on the ticket, the failures again on the ticket, what failed twice on base.
    const runs = cypressRuns(f);
    assert.deepEqual(runs.map((x) => [x.specs, x.onBase]), [
      [SPECS5, false],
      [['cypress/e2e/m/fail_both.cy.ts', 'cypress/e2e/m/fail_ticket.cy.ts', 'cypress/e2e/m/flaky.cy.ts'], false],
      [['cypress/e2e/m/fail_both.cy.ts', 'cypress/e2e/m/fail_ticket.cy.ts'], true],
    ]);
    assert.equal(runs[0]!.arg[4], 'cypress/e2e/m/pass_\\(team lead\\).cy.ts', 'Cypress got the glob-escaped path');
    assert.ok(runs.every((x) => x.mode === '600' && x.merged), 'mode-600 cypress.env.json with the desk credentials over the committed file');
    assert.ok(runs.every((x) => !x.sawToken && x.sawPath), 'Cypress never sees the conductor\'s tokens, and still has PATH');
    assert.equal(runs[0]!.server, `SERVER=http://localhost:${f.env.ONESHOT_LOCAL_TESTS_PORT}`);
    const ups = lines(join(f.logs, 'harness.log')).map((l) => (JSON.parse(l) as { up: string }).up);
    assert.deepEqual(ups.map((u) => u.split('/').pop()), ['erp-lt', 'erp-base-lt']);

    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /desk-secret|glpat-fake-token-0001|xoxb-fake-token-0002|fake-password-0003/);
    // Before each DROP, a createdb still running for that copy is looked for by its application_name.
    const psqlLog = lines(join(f.logs, 'psql.log'));
    for (const db of ['oneshot_lt_7171_1', 'oneshot_lt_7171_2']) {
      const look = psqlLog.findIndex((l) => l.includes(`application_name = '${db}'`));
      const drop = psqlLog.findIndex((l) => l.includes(`DROP DATABASE IF EXISTS "${db}"`));
      assert.ok(look >= 0 && look < drop, `${db}: createdb looked for before the drop`);
    }
    assertReleased(f, 7171, 'oneshot_lt_7171_1', 'oneshot_lt_7171_2');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('run: Cypress past its deadline is stopped, unfinished specs are skipped with the reason, and all is released', async () => {
  const f = await fakeDesk();
  try {
    // 12 s: the fake writes its marker as its first statement, and npx alone can take seconds on a loaded desk.
    const r = runScript(f, 7272, ['--deadline-min', '0.2'], { FAKE_CYPRESS_HANG: '1' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout) as RunOut;
    assert.equal(out.status, 'failed');
    assert.match(String(out.reason), /stopped at the 0\.2-minute deadline; 3 spec\(s\) did not finish/);
    assert.deepEqual(out.results.map((x) => x.state), ['skipped', 'skipped', 'skipped']);
    const started = join(f.logs, 'cypress-started');
    assert.ok(existsSync(started), 'Cypress started before the deadline');
    const pid = Number(readFileSync(started, 'utf8'));
    assert.equal(alive(pid), false, 'the Cypress process group was killed');
    assert.equal(cypressRuns(f).length, 1, 'nothing is retried after a deadline');
    assertReleased(f, 7272, 'oneshot_lt_7272_1');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('run: a SIGTERM mid-run prints E_ABORTED, exits 143 and still releases everything', async () => {
  const f = await fakeDesk();
  try {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, [SCRIPT, 'run', '--iid', '7373', '--worktree', f.erp, '--ref', f.ticketSha,
      '--specs-file', f.specsFile, '--automation-sha', f.autoSha], { env: { ...process.env, ...f.env, FAKE_CYPRESS_HANG: '1' } });
    let stdout = '';
    child.stdout.on('data', (b: Buffer) => { stdout += b; });
    child.stderr.resume();
    const started = join(f.logs, 'cypress-started');
    for (let i = 0; i < 600 && !existsSync(started); i += 1) await new Promise((res) => setTimeout(res, 100));
    assert.ok(existsSync(started), 'Cypress started');
    const code = await new Promise<number | null>((resolve) => { child.on('close', (c) => resolve(c)); child.kill('SIGTERM'); });
    assert.equal(code, 143);
    const out = JSON.parse(stdout) as { code: string; message: string };
    assert.equal(out.code, 'E_ABORTED');
    assert.equal(alive(Number(readFileSync(started, 'utf8'))), false, 'Cypress stopped');
    assertReleased(f, 7373, 'oneshot_lt_7373_1');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('run: a stale resources file is checked, then cleaned up; node_modules drift is refused by version, before any copy', async () => {
  const f = await fakeDesk();
  const { spawn } = await import('node:child_process');
  // A process the stale file names as "Cypress" that is not Cypress: a recycled pid.
  const bystander = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
  bystander.unref();
  try {
    // A crashed run's record: a copy and an automation worktree that really exist, and
    // entries this ticket's run could never have written.
    const run = join(f.home, 'state/runs/7474');
    const stale = join(run, 'wsa-run');
    mkdirSync(run, { recursive: true });
    git(f.wsa, 'worktree', 'add', '-q', '--detach', stale, f.autoSha);
    writeFileSync(join(run, 'local-tests-resources.json'), JSON.stringify({
      pid: 999999, db: 'oneshot_lt_7474_1', baseDb: 'oneshot_lt_9999_1',
      worktrees: [{ path: stale, gitDir: join(f.wsa, '.git') }, { path: '/' }, { path: f.erp }],
      harnessDirs: [f.root], cypressPgids: [bystander.pid], ports: { be: 5432, fe: 1 },
    }));
    writeFileSync(join(f.logs, 'dbs'), 'oneshot_lt_7474_1\n');
    // The ticket now needs a package the seed never installed, and a newer React than it has.
    write(f.erp, { 'package.json': '{"dependencies":{"react":"^19.0.0","posthog-js":"1"}}\n' });
    git(f.erp, 'commit', '-q', '-am', 'needs posthog and react 19');
    const sha = git(f.erp, 'rev-parse', 'HEAD');

    const r = spawnSync(process.execPath, [SCRIPT, 'run', '--iid', '7474', '--worktree', f.erp, '--ref', sha,
      '--specs-file', f.specsFile, '--automation-sha', f.autoSha],
    { encoding: 'utf8', env: { ...process.env, ...f.env }, timeout: 120000 });
    assert.equal(r.status, 1, r.stdout);
    const out = JSON.parse(r.stdout) as { code: string; message: string; hint: string };
    assert.equal(out.code, 'E_NODE_MODULES_DRIFT');
    assert.match(out.message, /1 not installed \(posthog-js\)/);
    assert.match(out.message, /react 18\.3\.1, wants \^19\.0\.0/);
    assert.match(out.hint, /run npm ci in .*seed on the base branch/);
    assert.deepEqual(lines(join(f.logs, 'createdb.log')), [], 'refused before the database was copied');
    assert.ok(lines(join(f.logs, 'psql.log')).some((l) => l.includes('DROP DATABASE IF EXISTS "oneshot_lt_7474_1" WITH (FORCE)')), 'the stale copy was dropped');
    assert.ok(alive(bystander.pid!), 'a pid that is not Cypress is never signalled from a stale file');
    assert.match(r.stderr, /ignoring what this run could never have recorded/);
    assert.ok(existsSync(f.erp) && existsSync(f.root), 'paths outside this ticket\'s run dir are left alone');
    assertReleased(f, 7474, 'oneshot_lt_7474_1');
  } finally {
    try { process.kill(bystander.pid!, 'SIGKILL'); } catch { /* gone */ }
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('run: the automation clone\'s node_modules is checked against package.json at the automation sha, before any copy', async () => {
  const f = await fakeDesk();
  try {
    // origin moved Cypress a major ahead of what the clone has installed.
    write(f.wsa, { 'package.json': '{"name":"wsa-fake","version":"1.0.0","devDependencies":{"cypress":"^15.0.0"}}\n' });
    git(f.wsa, 'commit', '-q', '-am', 'cypress 15');
    const sha = git(f.wsa, 'rev-parse', 'HEAD');
    const r = runScript(f, 7575, ['--automation-sha', sha]);
    assert.equal(r.status, 1, r.stdout);
    const out = JSON.parse(r.stdout) as { code: string; message: string; hint: string };
    assert.equal(out.code, 'E_NODE_MODULES_DRIFT');
    assert.match(out.message, /cypress 14\.5\.4, wants \^15\.0\.0/);
    assert.match(out.hint, /run npm ci in /);
    assert.deepEqual(lines(join(f.logs, 'createdb.log')), []);
    assertReleased(f, 7575);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('run --until: budgets fit the conductor\'s deadline, and a base re-run that would not fit is skipped with a note', async () => {
  const f = await fakeDesk();
  try {
    const until = Date.now() + 20 * 60000;
    const r = runScript(f, 7676, ['--base', 'dev', '--deadline-min', '50', '--until', String(until)]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout) as RunOut;
    assert.equal(out.status, 'failed');
    const failed = out.results.filter((x) => x.state === 'failed');
    assert.equal(failed.length, 2);
    assert.ok(failed.every((x) => x.failingOnDev === null), 'unknown, not guessed');
    const notes = out.notes || [];
    assert.ok(notes.some((n) => /^Cypress was given 1[45](\.\d+)? min, not 50/.test(n)), notes.join(' | '));
    assert.ok(notes.some((n) => new RegExp(`not re-run on dev: only \\d+ min were left before the conductor's deadline and a base re-run needs about ${Math.round(lt.BASE_RERUN_NEEDS_MS / 60000)}`).test(n)), notes.join(' | '));
    assert.equal(cypressRuns(f).length, 2, 'the ticket run and its retry; no base run');
    assert.equal(lines(join(f.logs, 'createdb.log')).length, 1);
    assertReleased(f, 7676, 'oneshot_lt_7676_1');

    const bad = runScript(f, 7676, ['--until', 'soon']);
    assert.equal(JSON.parse(bad.stdout).code, 'E_ARGS');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('run: webpack still compiling past the harness\'s wait is watched (entrypoints file + "Compiled" log line), then the app is reused', async () => {
  const f = await fakeDesk();
  try {
    const r = runScript(f, 7777, [], { FAKE_HARNESS_SLOW: '1' });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const out = JSON.parse(r.stdout) as RunOut;
    assert.equal(out.totals.tests, 3);
    assert.match(r.stderr, /webpack is still compiling past the harness's own wait/);
    const h = lines(join(f.logs, 'harness.log')).map((l) => JSON.parse(l) as { up?: string; reuse?: string });
    assert.deepEqual(h.map((x) => (x.up ? 'up' : 'reuse')), ['up', 'reuse']);
    assertReleased(f, 7777, 'oneshot_lt_7777_1');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('gc drops a leftover copy with a plain DROP, and leaves alone one that something is still connected to', async () => {
  const f = await fakeDesk();
  try {
    writeFileSync(join(f.logs, 'dbs'), 'oneshot_lt_8181_1\noneshot_lt_8282_1\n');
    const r = spawnSync(process.execPath, [SCRIPT, 'gc'], {
      encoding: 'utf8', env: { ...process.env, ...f.env, FAKE_BUSY_DB: 'oneshot_lt_8181_1' }, timeout: 60000,
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout) as { dropped: string[]; skipped: Array<{ iid: number; db?: string; why: string }>; errors: string[] };
    assert.deepEqual(out.dropped, ['oneshot_lt_8282_1']);
    assert.deepEqual(out.skipped, [{ iid: 8181, db: 'oneshot_lt_8181_1', why: '1 session(s) are connected to it' }],
      'it may be another Oneshot home\'s live run');
    assert.deepEqual(out.errors, []);
    const drops = lines(join(f.logs, 'psql.log')).filter((l) => /DROP DATABASE/.test(l)).map((l) => l.replace(/^.* -c /, ''));
    assert.deepEqual(drops, ['DROP DATABASE IF EXISTS "oneshot_lt_8282_1"'], 'never WITH (FORCE) from gc');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

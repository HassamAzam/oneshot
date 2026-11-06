/**
 * appenv decides whether a host is fit to run tickets, so the parts that do
 * not need a live Postgres/Redis are pinned here: env-file parsing and
 * precedence, the settings derived from env, the platform-aware Playwright
 * cache, and the shape and verdicts of the offline checks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appSettings, checkPrereqs, formatResult, loadEnvFiles, parseEnvText, playwrightCaches, SEED_PARTS,
} from './appenv.cjs';

const scratch = (): string => mkdtempSync(join(tmpdir(), 'appenv-'));

test('parseEnvText reads plain, quoted, exported and commented lines, keeping a trailing # as systemd does', () => {
  const parsed = parseEnvText([
    '# comment', 'A=1', 'export B=two', 'C="quoted # not a comment"', "D='single'",
    'E=value # trailing comment', '# F=commented-out', 'not a line', 'G=',
  ].join('\n'));
  assert.deepEqual(parsed, { A: '1', B: 'two', C: 'quoted # not a comment', D: 'single', E: 'value # trailing comment', G: '' });
});

test('loadEnvFiles never overrides a key already in the environment, and the first file wins', () => {
  const dir = scratch();
  const first = join(dir, 'first.env');
  const second = join(dir, 'second.env');
  writeFileSync(first, 'X=from-first\nY=from-first\n');
  writeFileSync(second, 'X=from-second\nZ=from-second\n');
  const target: Record<string, string | undefined> = { Y: 'from-process' };
  const read = loadEnvFiles([first, join(dir, 'missing.env'), second], target);
  assert.deepEqual(read, [first, second]);
  assert.deepEqual(target, { X: 'from-first', Y: 'from-process', Z: 'from-second' });
});

test('appSettings takes paths and database from env, with the seed defaulting to WORK_REPO', () => {
  const s = appSettings({
    GITLAB_REPO_URL: 'https://gitlab.example.com/acme/erp',
    WORK_REPO: '/srv/erp', DB_NAME: 'hrdb_server', DB_USER: 'oneshot', DB_PORT: '5433',
    REDIS_URL: 'redis://127.0.0.1:6379/3', ONESHOT_TEST_LOGIN: 'qa@example.com:pa:ss',
    ONESHOT_APP_ALLOWED_HOSTS: 'a.example.com, b.example.com',
  });
  assert.equal(s.workRepo, '/srv/erp');
  assert.equal(s.seed, '/srv/erp');
  assert.deepEqual(s.db, { name: 'hrdb_server', user: 'oneshot', password: '', host: '127.0.0.1', port: '5433' });
  assert.equal(s.redisUrl, 'redis://127.0.0.1:6379/3');
  assert.equal(s.testLogin, 'qa@example.com:pa:ss');
  assert.deepEqual(s.allowedHosts, ['a.example.com', 'b.example.com']);
});

test('appSettings: ONESHOT_SEED_FROM outranks WORK_REPO, and a login without a colon is unusable', () => {
  const s = appSettings({ WORK_REPO: '/srv/erp', ONESHOT_SEED_FROM: '/srv/seed', ONESHOT_TEST_LOGIN: 'qa@example.com' });
  assert.equal(s.seed, '/srv/seed');
  assert.equal(s.testLogin, '');
});

test('playwrightCaches honours PLAYWRIGHT_BROWSERS_PATH, else the platform default', () => {
  assert.deepEqual(playwrightCaches({ PLAYWRIGHT_BROWSERS_PATH: '/opt/pw' }), ['/opt/pw']);
  const [def] = playwrightCaches({});
  if (process.platform === 'darwin') assert.equal(def, join(homedir(), 'Library', 'Caches', 'ms-playwright'));
  if (process.platform === 'linux') assert.equal(def, join(homedir(), '.cache', 'ms-playwright'));
});

test('every check answers the same shape, and a failing one carries a fix line', () => {
  const results = checkPrereqs({ env: {}, only: ['node', 'git', 'portProbe', 'seed', 'testUser'] });
  assert.equal(results.length, 5);
  for (const r of results) {
    assert.equal(typeof r.name, 'string');
    assert.equal(typeof r.ok, 'boolean');
    assert.equal(typeof r.detail, 'string');
    assert.equal(typeof r.required, 'boolean');
    if (!r.ok) assert.ok(r.fix.length > 0, `${r.name} failed without a fix`);
    else assert.equal(r.fix, '');
  }
  const seed = results.find((r) => r.id === 'seed');
  assert.equal(seed?.ok, false);
  const login = results.find((r) => r.id === 'testUser');
  assert.match(login?.detail ?? '', /ONESHOT_TEST_LOGIN/);
});

test('the seed check names exactly the parts that are missing', () => {
  const seed = scratch();
  mkdirSync(join(seed, '.git'));
  mkdirSync(join(seed, 'node_modules'));
  const [r] = checkPrereqs({ env: { WORK_REPO: seed }, only: ['seed'] });
  assert.equal(r?.ok, false);
  const absent = SEED_PARTS.map(([rel]) => rel).filter((rel) => rel !== '.git' && rel !== 'node_modules');
  for (const rel of absent) assert.ok(r?.detail.includes(rel), `detail should name ${rel}`);
  assert.ok(!r?.detail.includes('node_modules'));
  assert.equal(r?.fix, 'node scripts/provision-seed.cjs');
});

test('skip removes a check, and formatResult prints PASS/FAIL/WARN with the fix', () => {
  const ids = checkPrereqs({ env: {}, only: ['node', 'git'], skip: ['git'] }).map((r) => r.id);
  assert.deepEqual(ids, ['node']);
  const base = { id: 'x', name: 'thing', detail: 'd', fix: 'do it' };
  assert.match(formatResult({ ...base, ok: false, required: true }), /FAIL {2}thing — d\n {8}fix: do it/);
  assert.match(formatResult({ ...base, ok: false, required: false }), /WARN/);
  assert.match(formatResult({ ...base, ok: true, fix: '', required: true }), /^ {2}PASS {2}thing — d$/);
});

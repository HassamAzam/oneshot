/**
 * A worktree gets Django test settings that can reach this machine's database.
 *
 * The app repo's `hrdb/test_settings.py` hardcodes a `postgres` superuser. On
 * the server that login does not exist, so on #9174 no phase could run the MR's
 * own tests: five implement laps reported a database error in place of a test
 * result, six verify laps each improvised a scratch settings file, and
 * self-remediation handed it back as needing a database admin. seedTestSettings
 * writes `hrdb/test_settings_oneshot.py` — the repo's settings with the
 * connection the checkout's own `local_settings.py` already carries.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEST_SETTINGS_FILE, TEST_SETTINGS_MODULE, seedTestSettings } from './worktrees.js';

const made: string[] = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** A checkout shaped like the app repo: tracked test settings, and (optionally) seeded local settings. */
function checkout(opts: { testSettings?: boolean; localSettings?: string | null } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'oneshot-ts-'));
  made.push(dir);
  mkdirSync(join(dir, 'hrdb'), { recursive: true });
  writeFileSync(join(dir, 'hrdb', '__init__.py'), '');
  if (opts.testSettings !== false) {
    writeFileSync(join(dir, 'hrdb', 'test_settings.py'), [
      'SECRET_KEY = "SECRET_KEY"',
      'DATABASES = {"default": {"ENGINE": "django.db.backends.postgresql", "NAME": "test_hrdb",',
      '    "USER": "postgres", "PASSWORD": "postgres", "HOST": "localhost", "PORT": "5432",',
      '    "TEST": {"MIGRATE": False}}}',
      '',
    ].join('\n'));
  }
  if (opts.localSettings !== null) {
    writeFileSync(join(dir, 'hrdb', 'local_settings.py'), opts.localSettings ?? [
      'DATABASES = {"default": {"ENGINE": "django.db.backends.postgresql_psycopg2",',
      '    "NAME": "oneshot_run_9174_cce3f8", "USER": "oneshot", "PASSWORD": "s3cret",',
      '    "HOST": "127.0.0.1", "PORT": "5433"}}',
      '',
    ].join('\n'));
  }
  return dir;
}

test('a checkout with the repo\'s test settings and seeded local settings gets the module', () => {
  const dir = checkout();
  assert.deepEqual(seedTestSettings(dir), [TEST_SETTINGS_FILE]);
  const text = readFileSync(join(dir, TEST_SETTINGS_FILE), 'utf8');
  assert.ok(text.startsWith('# ONESHOT-GENERATED hrdb/test_settings_oneshot.py'));
  assert.match(text, /from hrdb\.test_settings import \*/);
  assert.equal(TEST_SETTINGS_MODULE, 'hrdb.test_settings_oneshot');
});

test('seeding again is a no-op that still reports the path to keep out of git status', () => {
  const dir = checkout();
  seedTestSettings(dir);
  const before = readFileSync(join(dir, TEST_SETTINGS_FILE), 'utf8');
  assert.deepEqual(seedTestSettings(dir), [TEST_SETTINGS_FILE]);
  assert.equal(readFileSync(join(dir, TEST_SETTINGS_FILE), 'utf8'), before);
});

test('a stale generated copy is rewritten from the template', () => {
  const dir = checkout();
  writeFileSync(join(dir, TEST_SETTINGS_FILE), '# ONESHOT-GENERATED hrdb/test_settings_oneshot.py — older text\nX = 1\n');
  assert.deepEqual(seedTestSettings(dir), [TEST_SETTINGS_FILE]);
  assert.match(readFileSync(join(dir, TEST_SETTINGS_FILE), 'utf8'), /from hrdb\.test_settings import \*/);
});

test('a file somebody else put at that path is left alone, and not excluded as ours', () => {
  const dir = checkout();
  writeFileSync(join(dir, TEST_SETTINGS_FILE), '# hand-written\nDATABASES = {}\n');
  assert.deepEqual(seedTestSettings(dir), []);
  assert.equal(readFileSync(join(dir, TEST_SETTINGS_FILE), 'utf8'), '# hand-written\nDATABASES = {}\n');
});

test('a checkout that is not this app, or has no local settings, is left alone', () => {
  assert.deepEqual(seedTestSettings(checkout({ testSettings: false })), []);
  assert.deepEqual(seedTestSettings(checkout({ localSettings: null })), []);
});

const python = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);

test('loaded by Python, it is the repo\'s test settings on the checkout\'s own connection', { skip: !python }, () => {
  const dir = checkout();
  seedTestSettings(dir);
  const out = execFileSync(python!, ['-c', [
    'import json, hrdb.test_settings_oneshot as s',
    'print(json.dumps({"db": s.DATABASES["default"], "secret": s.SECRET_KEY}))',
  ].join('\n')], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', PYTHONDONTWRITEBYTECODE: '1' } });
  const got = JSON.parse(out) as { db: Record<string, unknown>; secret: string };
  // The connection is the checkout's; NAME travels so Django's test database is test_<the run's own>.
  assert.equal(got.db.USER, 'oneshot');
  assert.equal(got.db.PASSWORD, 's3cret');
  assert.equal(got.db.HOST, '127.0.0.1');
  assert.equal(got.db.PORT, '5433');
  assert.equal(got.db.NAME, 'oneshot_run_9174_cce3f8');
  // Everything else is still the repo's test settings: its engine, its TEST block, its other names.
  assert.equal(got.db.ENGINE, 'django.db.backends.postgresql');
  assert.deepEqual(got.db.TEST, { MIGRATE: false });
  assert.equal(got.secret, 'SECRET_KEY');
});

test('local settings that name only some of the connection override only those', { skip: !python }, () => {
  const dir = checkout({ localSettings: 'DATABASES = {"default": {"USER": "dev", "PASSWORD": "pw"}}\n' });
  seedTestSettings(dir);
  const out = execFileSync(python!, ['-c',
    'import json, hrdb.test_settings_oneshot as s\nprint(json.dumps(s.DATABASES["default"]))',
  ], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', PYTHONDONTWRITEBYTECODE: '1' } });
  const db = JSON.parse(out) as Record<string, unknown>;
  assert.equal(db.USER, 'dev');
  assert.equal(db.NAME, 'test_hrdb');
  assert.equal(db.HOST, 'localhost');
});

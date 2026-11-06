import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SECTION_START, brokerFor, commands, dropRunDb, ensureRunDb, parseRunDbName, perRunDbMode, pgClient, pgTarget,
  readSeedDb, redisIndexForSlot, refreshBaseline, rewriteRunSettings, runDbName, runDbNameProblem, runFromWorktree,
  sweepRunDbs, type PgTarget, type SpawnLike,
} from './rundb.cjs';

const SEED = `from .config import *

DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.postgresql_psycopg2',
        'NAME': 'hrdb',
        'USER': 'someone',
        'PASSWORD': 'SEED-SECRET',
        'HOST': 'localhost',
        'PORT': '5432',
    }
}

CELERY_BROKER_URL = 'redis://localhost:6379'
MEDIA_ROOT = '/var/erp/media'
USE_WEB_SHELL = True
`;

const PG: PgTarget = { host: 'localhost', port: '5432', user: 'someone', seed: 'hrdb', baseline: 'hrdb_baseline' };

test('run database names: derived from the worktree, prefixed, and the prefix is the guard', () => {
  assert.equal(runDbName(8790, 'r-mabc12-1a2b3c'), 'oneshot_run_8790_1a2b3c');
  assert.deepEqual(runFromWorktree('/srv/erp-wt/t8790-r-mabc12-1a2b3c'), { iid: 8790, runId: 'r-mabc12-1a2b3c' });
  assert.equal(runFromWorktree('/srv/erp-wt/app-8010'), null, 'the app pool is not a run');
  assert.equal(runFromWorktree('/Users/me/Documents/erp'), null);
  assert.deepEqual(parseRunDbName('oneshot_run_8790_1a2b3c'), { iid: 8790, shortId: '1a2b3c' });
  assert.equal(runDbNameProblem('oneshot_run_8790_1a2b3c'), null);
  for (const bad of ['hrdb', 'hrdb_baseline', 'oneshot_lt_1_1', 'oneshot_run_', 'oneshot_run_x_1', 'Oneshot_run_1_a', 'oneshot_run_1_a; DROP', '']) {
    assert.ok(runDbNameProblem(bad), `${bad} must be refused`);
  }
  assert.match(String(runDbNameProblem('oneshot_run_1_a', { baseline: 'oneshot_run_1_a' })), /baseline/);
});

test('settings rewrite: NAME, DATABASE_NAME, the run\'s Redis DB and a per-worktree media root; the seed\'s secrets stay where they were', () => {
  const out = rewriteRunSettings(SEED, { name: 'oneshot_run_8790_1a2b3c', redisIndex: 3, worktree: '/srv/erp-wt/t8790-r-mabc12-1a2b3c' });
  assert.match(out, /'NAME': 'oneshot_run_8790_1a2b3c',/);
  assert.doesNotMatch(out, /'NAME': 'hrdb'/);
  assert.match(out, /'PASSWORD': 'SEED-SECRET'/, 'the connection is the seed\'s own, only the name changes');
  assert.match(out, /\nDATABASE_NAME = 'oneshot_run_8790_1a2b3c'\n/);
  assert.match(out, /\nCELERY_BROKER_URL = 'redis:\/\/localhost:6379\/3'\n/);
  assert.ok(out.lastIndexOf("redis://localhost:6379/3") > out.indexOf("CELERY_BROKER_URL = 'redis://localhost:6379'"), 'appended after the seed line, so it wins');
  assert.match(out, /\nMEDIA_ROOT = '\/srv\/erp-wt\/t8790-r-mabc12-1a2b3c\/media'\n/);
  assert.match(out, /USE_WEB_SHELL = True/);
});

test('settings rewrite is idempotent, and a second rewrite with another slot replaces rather than stacks', () => {
  const o = { name: 'oneshot_run_8790_1a2b3c', redisIndex: 3, worktree: '/srv/wt' };
  const once = rewriteRunSettings(SEED, o);
  assert.equal(rewriteRunSettings(once, o), once);
  const moved = rewriteRunSettings(once, { ...o, redisIndex: 4 });
  assert.equal(moved.split(SECTION_START).length, 2, 'one managed section');
  assert.match(moved, /redis:\/\/localhost:6379\/4'/);
  assert.doesNotMatch(moved, /\/3'/);
  const nameOnly = rewriteRunSettings(SEED, { name: o.name });
  assert.doesNotMatch(nameOnly.slice(nameOnly.indexOf(SECTION_START)), /CELERY_BROKER_URL/);
  const relative = rewriteRunSettings(SEED.replace("'/var/erp/media'", "'media'"), o);
  assert.doesNotMatch(relative.slice(relative.indexOf(SECTION_START)), /MEDIA_ROOT/, 'a relative media root is already per checkout');
});

test('settings rewrite refuses what it does not understand', () => {
  assert.throws(() => rewriteRunSettings('X = 1\n', { name: 'oneshot_run_1_a' }), /0 DATABASES blocks/);
  assert.throws(() => rewriteRunSettings(`${SEED}\n${SEED}`, { name: 'oneshot_run_1_a' }), /2 DATABASES blocks/);
  assert.throws(() => rewriteRunSettings(SEED, { name: 'hrdb' }), /refusing to point settings at hrdb/);
  assert.throws(() => rewriteRunSettings(SEED.replace("'redis://localhost:6379'", "'redis://localhost:6379/3'"),
    { name: 'oneshot_run_1_a', redisIndex: 3 }), /already on Redis DB 3/);
  assert.throws(() => brokerFor("CELERY_BROKER_URL = 'amqp://x'\n", 1), /not a redis:\/\/ URL/);
  assert.equal(brokerFor('', 2), 'redis://127.0.0.1:6379/2', 'no broker line: the tracked config.py default');
});

test('Redis DB per port slot: 1 + slot, never 15 (local tests), never past 31', () => {
  assert.deepEqual([0, 1, 9].map(redisIndexForSlot), [1, 2, 10]);
  assert.equal(redisIndexForSlot(13), 14);
  assert.equal(redisIndexForSlot(14), 16);
  assert.throws(() => redisIndexForSlot(30), /past 31/);
  assert.throws(() => redisIndexForSlot(-1), /not a pool index/);
});

test('pg target: the seed\'s literals, env overrides, and a baseline that is never the seed', () => {
  assert.deepEqual(readSeedDb(SEED), { name: 'hrdb', host: 'localhost', port: '5432', user: 'someone' });
  assert.deepEqual(pgTarget({}, SEED), PG);
  assert.deepEqual(pgTarget({ ONESHOT_RUN_DB_PG_HOST: '10.0.0.5', ONESHOT_DB_BASELINE: 'erp_tpl' }, SEED),
    { ...PG, host: '10.0.0.5', baseline: 'erp_tpl' });
  assert.throws(() => pgTarget({ ONESHOT_DB_BASELINE: 'hrdb' }, SEED), /is the seed database/);
  assert.throws(() => pgTarget({ ONESHOT_DB_BASELINE: 'oneshot_run_1_a' }, SEED), /may not start with oneshot_run_/);
  assert.equal(JSON.stringify(pgTarget({}, SEED)).includes('SEED-SECRET'), false, 'no password is ever read');
});

/** A spawnSync stand-in: records every call, answers psql from `answer`. */
function fakeSpawn(answer: (sql: string) => string, opts: { createErr?: string } = {}) {
  const calls: Array<{ cmd: string; args: string[]; env: Record<string, string> }> = [];
  const spawn: SpawnLike = (cmd, args, o) => {
    calls.push({ cmd, args, env: (o as { env: Record<string, string> }).env });
    if (cmd === 'createdb') return opts.createErr ? { status: 1, stdout: '', stderr: opts.createErr } : { status: 0, stdout: '', stderr: '' };
    return { status: 0, stdout: answer(args[args.length - 1] ?? ''), stderr: '' };
  };
  return { spawn, calls };
}

test('create: the exact createdb command, from the baseline, -w, named for the run', () => {
  const { spawn, calls } = fakeSpawn((sql) => {
    if (/datname = 'oneshot_run_8790_1a2b3c'/.test(sql) && /pg_database/.test(sql)) return '';
    if (/pg_database WHERE datname = 'hrdb_baseline'/.test(sql)) return '1';
    if (/pg_stat_activity/.test(sql)) return '0';
    return '';
  });
  assert.deepEqual(ensureRunDb(PG, 'oneshot_run_8790_1a2b3c', { spawn }), { name: 'oneshot_run_8790_1a2b3c', created: true });
  const create = calls.find((c) => c.cmd === 'createdb');
  assert.deepEqual(create?.args, ['-h', 'localhost', '-p', '5432', '-U', 'someone', '-w', '-T', 'hrdb_baseline', 'oneshot_run_8790_1a2b3c']);
  assert.equal(create?.env.PGAPPNAME, 'oneshot_run_8790_1a2b3c');
  assert.deepEqual(commands.create({ ...PG, host: '', port: '', user: '' }, 'hrdb_baseline', 'oneshot_run_1_a'),
    ['createdb', ['-w', '-T', 'hrdb_baseline', 'oneshot_run_1_a']], 'socket defaults: no -h/-p/-U');
});

test('create is idempotent: an existing run database is reused, nothing is copied', () => {
  const { spawn, calls } = fakeSpawn(() => '1');
  assert.deepEqual(ensureRunDb(PG, 'oneshot_run_8790_1a2b3c', { spawn }), { name: 'oneshot_run_8790_1a2b3c', created: false });
  assert.equal(calls.filter((c) => c.cmd === 'createdb').length, 0);
});

test('create refuses a missing or busy baseline, and any name the guard refuses — before any command', () => {
  const missing = fakeSpawn(() => '');
  assert.throws(() => ensureRunDb(PG, 'oneshot_run_1_a', { spawn: missing.spawn }), (e: { code?: string }) => e.code === 'E_NO_BASELINE');
  const busy = fakeSpawn((sql) => (/pg_stat_activity/.test(sql) ? '2' : (/'hrdb_baseline'/.test(sql) ? '1' : '')));
  assert.throws(() => ensureRunDb(PG, 'oneshot_run_1_a', { spawn: busy.spawn }), (e: { code?: string }) => e.code === 'E_BASELINE_BUSY');
  for (const name of ['hrdb', 'hrdb_baseline', 'oneshot_lt_1_1']) {
    const f = fakeSpawn(() => '');
    assert.throws(() => ensureRunDb(PG, name, { spawn: f.spawn }), /refusing to create/);
    assert.throws(() => dropRunDb(PG, name, { spawn: f.spawn }), /refusing to drop/);
    assert.equal(f.calls.length, 0, `${name}: no command ran`);
  }
});

test('drop: one DROP ... WITH (FORCE) of exactly the run database', () => {
  const { spawn, calls } = fakeSpawn(() => '');
  dropRunDb(PG, 'oneshot_run_8790_1a2b3c', { spawn });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.cmd, 'psql');
  assert.deepEqual(calls[0]?.args.slice(-1), ['DROP DATABASE IF EXISTS "oneshot_run_8790_1a2b3c" WITH (FORCE)']);
  assert.ok(calls[0]?.args.includes('-w'));
});

test('baseline refresh: refuses while the seed is in use unless told to end those sessions', () => {
  const answers = (sql: string): string => (/pg_stat_activity WHERE datname = 'hrdb' AND/.test(sql) && /count/.test(sql) ? '1' : '1');
  const a = fakeSpawn(answers);
  assert.throws(() => refreshBaseline(PG, { spawn: a.spawn }), (e: { code?: string }) => e.code === 'E_SEED_BUSY');
  const b = fakeSpawn(answers);
  assert.deepEqual(refreshBaseline(PG, { spawn: b.spawn, terminate: true }), { baseline: 'hrdb_baseline', from: 'hrdb', terminated: 1 });
  const sqls = b.calls.filter((c) => c.cmd === 'psql').map((c) => c.args[c.args.length - 1]);
  assert.ok(sqls.some((q) => /pg_terminate_backend/.test(q ?? '') && /'hrdb'/.test(q ?? '')));
  assert.ok(sqls.includes('DROP DATABASE IF EXISTS "hrdb_baseline" WITH (FORCE)'));
  assert.deepEqual(b.calls.find((c) => c.cmd === 'createdb')?.args.slice(-3), ['-T', 'hrdb', 'hrdb_baseline']);
  assert.throws(() => refreshBaseline({ ...PG, baseline: 'hrdb' }), /refusing to replace/);
});

test('sweep: drops run databases whose run is done, aborted or unknown; keeps running, blocked, parked', () => {
  const dbs = ['oneshot_run_1_aaaaaa', 'oneshot_run_2_bbbbbb', 'oneshot_run_3_cccccc', 'oneshot_run_4_dddddd', 'oneshot_run_5_eeeeee', 'oneshot_run_6_ffffff'];
  const { spawn, calls } = fakeSpawn((sql) => (/left\(datname/.test(sql) ? [...dbs, 'hrdb_baseline'].join('\n') : ''));
  const statuses: Record<number, string | null> = { 1: 'done', 2: 'aborted', 3: null, 4: 'running', 5: 'blocked', 6: 'parked' };
  const r = sweepRunDbs(PG, (iid) => statuses[iid] ?? null, { spawn, drop: true });
  assert.deepEqual(r.dropped, ['oneshot_run_1_aaaaaa', 'oneshot_run_2_bbbbbb', 'oneshot_run_3_cccccc']);
  assert.deepEqual(r.kept.map((k) => k.status), ['running', 'blocked', 'parked']);
  const drops = calls.map((c) => c.args[c.args.length - 1]).filter((q) => /^DROP/.test(q ?? ''));
  assert.equal(drops.length, 3);
  assert.ok(drops.every((q) => /"oneshot_run_\d+_[a-f]+"/.test(q ?? '')));
  const dry = fakeSpawn((sql) => (/left\(datname/.test(sql) ? dbs.join('\n') : ''));
  assert.equal(sweepRunDbs(PG, () => null, { spawn: dry.spawn }).dropped.length, 0, 'dry unless drop');
});

test('mode: forced on or off by ONESHOT_PER_RUN_DB, else on exactly when the baseline exists', () => {
  assert.equal(perRunDbMode({ ONESHOT_PER_RUN_DB: '1' }, () => false).on, true);
  assert.equal(perRunDbMode({ ONESHOT_PER_RUN_DB: '0' }, () => { throw new Error('not consulted'); }).on, false);
  assert.equal(perRunDbMode({}, () => true).on, true);
  assert.equal(perRunDbMode({}, () => false).on, false);
  assert.deepEqual(perRunDbMode({}, () => { throw new Error('psql is not on PATH'); }), { on: false, why: 'could not check for a baseline (psql is not on PATH)' });
  const missing = pgClient(PG, { spawn: () => ({ status: null, error: Object.assign(new Error('x'), { code: 'ENOENT' }) }) });
  assert.throws(() => missing.exists('hrdb_baseline'), /psql is not on PATH/);
});

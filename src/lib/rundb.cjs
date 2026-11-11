'use strict';
/**
 * rundb.cjs — one Postgres database and one Redis DB index per run.
 *
 * Every ticket worktree used to get a verbatim copy of the seed's hrdb/local_settings.py,
 * so every run on a machine migrated and wrote ONE database and queued Celery work on ONE
 * broker. With one run at a time that was tolerable; with ten it means a run's migration
 * lands under another run's verify, and a run's test data is another run's evidence.
 *
 * So a run's worktree gets its own database, `oneshot_run_<iid>_<runhex>`, created with
 * `createdb -T <baseline>`, and its local_settings.py is pointed at it. The baseline is a
 * DEDICATED database that nothing serves: Postgres refuses to copy a template anything is
 * connected to, and the seed DB is the developer's (or the pool app's) live database.
 * `node scripts/app.cjs baseline --refresh` (re)creates it from the seed.
 *
 * The prefix is the whole safety model. Every CREATE and every DROP re-checks the name
 * against `^oneshot_run_<digits>_<alnum>$` at the last moment, and the baseline and the
 * seed are refused by name too, whoever asked.
 *
 * Shared with scripts/localtests.cjs: the DATABASES block parser and writer. That script
 * keeps its own copy names (localTests.dbPrefix) and its own guards.
 *
 * Postgres access is through psql/createdb with `-w` (never prompt): the desk's role must
 * have CREATEDB and authenticate by peer/trust or ~/.pgpass. No password is read from the
 * settings file by this module.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const RUN_DB_PREFIX = 'oneshot_run_';
const PG_IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const RUN_DB_RE = /^oneshot_run_(\d{1,10})_([a-z0-9]{1,12})$/;
/** Redis DB index local tests keep for themselves (scripts/localtests.cjs LT_BROKER). */
const LT_REDIS_INDEX = 15;
const MAX_REDIS_INDEX = 31;
const SECTION_START = '# >>> oneshot per-run database (managed by src/lib/rundb.cjs; rewritten on every bring-up)';
const SECTION_END = '# <<< oneshot per-run database';

class RunDbError extends Error {
  constructor(code, message, hint) { super(message); this.code = code; this.hint = hint || null; }
  toJSON() { return { code: this.code, message: this.message, hint: this.hint }; }
}

/* ------------------------------------------------------------------ names */

/** The short, stable part of a run id: `r-<time36>-<hex6>` -> `<hex6>`. */
function shortRunId(runId) {
  const tail = String(runId || '').split('-').pop().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
  if (!tail) throw new RunDbError('E_DB_NAME', `run id ${JSON.stringify(runId)} has no usable suffix`);
  return tail;
}

function runDbName(iid, runId) {
  if (!Number.isInteger(Number(iid)) || Number(iid) <= 0) throw new RunDbError('E_DB_NAME', `iid ${iid} is not a ticket number`);
  const name = `${RUN_DB_PREFIX}${Number(iid)}_${shortRunId(runId)}`;
  const problem = runDbNameProblem(name);
  if (problem) throw new RunDbError('E_DB_NAME', `refusing ${name}: ${problem}`);
  return name;
}

function parseRunDbName(name) {
  const m = RUN_DB_RE.exec(String(name));
  return m ? { iid: Number(m[1]), shortId: m[2] } : null;
}

/** `<WT_ROOT>/t<iid>-r-<time36>-<hex>` (src/lib/ids.ts worktreeName) -> {iid, runId}. */
function runFromWorktree(wt) {
  const m = /^t(\d+)-(r-[0-9a-z]+-[0-9a-f]+)$/.exec(path.basename(String(wt || '')));
  return m ? { iid: Number(m[1]), runId: m[2] } : null;
}

/** Why `name` must not be created or dropped as a run database, or null when it may. */
function runDbNameProblem(name, guard = {}) {
  if (typeof name !== 'string' || !PG_IDENT_RE.test(name)) return 'it is not a plain lower-case Postgres name';
  if (!name.startsWith(RUN_DB_PREFIX)) return `it does not start with ${RUN_DB_PREFIX}`;
  if (!RUN_DB_RE.test(name)) return `it is not ${RUN_DB_PREFIX}<iid>_<runid>`;
  if (guard.baseline && name === guard.baseline) return 'it is the baseline database';
  if (guard.seed && name === guard.seed) return 'it is the seed database';
  return null;
}

/* ------------------------------------------------------------------ settings */

const DATABASES_RE = /^DATABASES\s*=\s*\{[\s\S]*?^\}[ \t]*$/m;

/** The one DATABASES block of a local_settings.py, or a refusal: a file with 0 or 2 is not guessed at. */
function findDatabasesBlock(src) {
  const hits = String(src).match(new RegExp(DATABASES_RE.source, 'gm')) || [];
  if (hits.length !== 1) {
    throw new RunDbError('E_LOCAL_SETTINGS',
      `the seed's hrdb/local_settings.py has ${hits.length} DATABASES blocks, expected exactly 1`,
      'Its shape changed; the run will not guess which database Django would use.');
  }
  return hits[0];
}

/** A plain string literal for `key` in the block, or null when it is absent or an expression. */
function blockValue(block, key) {
  const m = new RegExp(`['"]${key}['"]\\s*:\\s*(?:'([^'\\n]*)'|"([^"\\n]*)"|(\\d+))\\s*,?`).exec(block);
  if (!m) return null;
  return m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]);
}

function checkValue(v, re, what) {
  if (!re.test(String(v))) {
    throw new RunDbError('E_LOCAL_SETTINGS', `${what} ${JSON.stringify(String(v))} cannot be written into local_settings.py`);
  }
  return String(v);
}

/** A fresh DATABASES block. Every value is checked before it is written into Python source. */
function buildDatabasesBlock({ engine, name, user, host, port, password = '' }) {
  const checked = {
    engine: checkValue(engine || 'django.db.backends.postgresql', /^[A-Za-z0-9_.]+$/, 'engine'),
    name: checkValue(name, PG_IDENT_RE, 'database name'),
    user: checkValue(user || '', /^[A-Za-z0-9_.@-]*$/, 'user'),
    host: checkValue(host, /^[A-Za-z0-9_.:/-]+$/, 'host'),
    port: checkValue(port, /^\d{1,5}$/, 'port'),
    password: checkValue(password, /^[^'\\\n]*$/, 'password'),
  };
  return [
    'DATABASES = {',
    "    'default': {",
    `        'ENGINE': '${checked.engine}',`,
    `        'NAME': '${checked.name}',`,
    `        'USER': '${checked.user}',`,
    `        'PASSWORD': '${checked.password}',`,
    `        'HOST': '${checked.host}',`,
    `        'PORT': '${checked.port}',`,
    '    }',
    '}',
  ].join('\n');
}

/** The seed's own database, as far as plain literals say. */
function readSeedDb(src) {
  const block = findDatabasesBlock(src);
  const literalName = blockValue(block, 'NAME');
  const varName = (/^DATABASE_NAME\s*=\s*['"]([^'"\n]+)['"]/m.exec(String(src)) || [])[1];
  return {
    name: literalName || varName || 'hrdb',
    host: blockValue(block, 'HOST'),
    port: blockValue(block, 'PORT'),
    user: blockValue(block, 'USER'),
  };
}

function stripSection(src) {
  const s = String(src);
  const a = s.indexOf(SECTION_START);
  if (a < 0) return s;
  const b = s.indexOf(SECTION_END, a);
  const end = b < 0 ? s.length : b + SECTION_END.length;
  return (s.slice(0, a).replace(/\s*$/, '\n') + s.slice(end).replace(/^\s*\n/, '')).replace(/\s*$/, '\n');
}

/** 1 + slot, skipping local tests' 15. Redis ships 16 DBs (0-15): past slot 13, set `databases 32`. */
function redisIndexForSlot(slot) {
  if (!Number.isInteger(slot) || slot < 0) throw new RunDbError('E_REDIS_SLOT', `port slot ${slot} is not a pool index`);
  const idx = 1 + slot + (1 + slot >= LT_REDIS_INDEX ? 1 : 0);
  if (idx > MAX_REDIS_INDEX) {
    throw new RunDbError('E_REDIS_SLOT', `port slot ${slot} needs Redis DB ${idx}, past ${MAX_REDIS_INDEX}`,
      'shrink PORT_POOL or give Redis more databases');
  }
  return idx;
}

/** The seed's broker (its last CELERY_BROKER_URL literal) on Redis DB `index`. */
function brokerFor(src, index) {
  const all = [...String(src).matchAll(/^CELERY_BROKER_URL\s*=\s*['"]([^'"\n]*)['"]/gm)].map((m) => m[1].trim());
  const seed = all.length ? all[all.length - 1] : 'redis://127.0.0.1:6379';
  const m = /^(rediss?:\/\/[^/?#]+)(?:\/(\d+))?\/?(\?[^#]*)?$/.exec(seed);
  if (!m) {
    throw new RunDbError('E_LOCAL_SETTINGS', 'the seed\'s CELERY_BROKER_URL is not a redis:// URL this can re-point',
      'set it to a plain redis://host:port literal in the seed\'s local_settings.py');
  }
  if (m[2] !== undefined && Number(m[2]) === index) {
    throw new RunDbError('E_LOCAL_SETTINGS', `the seed's Celery broker is already on Redis DB ${index}, the one this run needs`,
      'point the seed at Redis DB 0; runs take 1..N and local tests 15');
  }
  return `${m[1]}/${index}${m[3] || ''}`;
}

/**
 * The worktree's local_settings.py pointed at its run database and Redis DB.
 *
 * Idempotent: the managed section is stripped and re-appended, and NAME is replaced in
 * place, so a resumed run rewriting its own file gets byte-identical output. Settings
 * that follow DATABASE_NAME in hrdb/settings.py (the memcached KEY_PREFIX) and
 * CELERY_BROKER_URL (CHANNEL_LAYERS) follow automatically. MEDIA_ROOT is overridden only
 * when the seed pins it to an absolute path: the tracked default (`media`) is already
 * relative to each checkout.
 */
function rewriteRunSettings(src, { name, redisIndex, worktree }) {
  const problem = runDbNameProblem(name);
  if (problem) throw new RunDbError('E_DB_NAME', `refusing to point settings at ${name}: ${problem}`);
  const base = stripSection(src);
  const block = findDatabasesBlock(base);
  const nameRe = /(['"]NAME['"]\s*:\s*)([^,\n}]+)/;
  if (!nameRe.test(block)) throw new RunDbError('E_LOCAL_SETTINGS', 'the DATABASES block has no NAME entry to re-point');
  const body = base.replace(block, block.replace(nameRe, `$1'${name}'`));
  const lines = [SECTION_START, `DATABASE_NAME = '${name}'`];
  if (redisIndex !== undefined && redisIndex !== null) lines.push(`CELERY_BROKER_URL = '${brokerFor(base, redisIndex)}'`);
  const media = (/^MEDIA_ROOT\s*=\s*['"]([^'"\n]*)['"]/m.exec(base) || [])[1];
  if (media && path.isAbsolute(media) && worktree) {
    lines.push(`MEDIA_ROOT = '${checkValue(path.join(worktree, 'media'), /^[A-Za-z0-9_./-]+$/, 'media root')}'`);
  }
  lines.push(SECTION_END);
  return `${body.replace(/\s*$/, '\n')}\n${lines.join('\n')}\n`;
}

/* ------------------------------------------------------------------ postgres */

/**
 * Where run databases live. ONESHOT_RUN_DB_PG_HOST/_PORT/_USER win; else the seed's own
 * DATABASES literals; else libpq's defaults (socket, PGUSER). Never a password.
 */
function pgTarget(env, seedSrc) {
  const seed = seedSrc ? readSeedDb(seedSrc) : { name: 'hrdb', host: null, port: null, user: null };
  const pick = (k, v) => (env[k] && String(env[k]).trim()) || v || '';
  const target = {
    host: pick('ONESHOT_RUN_DB_PG_HOST', seed.host),
    port: pick('ONESHOT_RUN_DB_PG_PORT', seed.port),
    user: pick('ONESHOT_RUN_DB_PG_USER', seed.user),
    seed: seed.name,
    baseline: pick('ONESHOT_DB_BASELINE', `${seed.name}_baseline`),
  };
  if (!PG_IDENT_RE.test(target.baseline)) throw new RunDbError('E_DB_NAME', `baseline ${JSON.stringify(target.baseline)} is not a plain Postgres name`);
  if (target.baseline.startsWith(RUN_DB_PREFIX)) throw new RunDbError('E_DB_NAME', `the baseline may not start with ${RUN_DB_PREFIX}`);
  if (target.baseline === target.seed) {
    throw new RunDbError('E_DB_NAME', `ONESHOT_DB_BASELINE is the seed database ${target.seed}`,
      'the baseline must be a dedicated copy nothing serves; Postgres will not copy a database with connections');
  }
  return target;
}

function connArgs(pg) {
  return [
    ...(pg.host ? ['-h', pg.host] : []),
    ...(pg.port ? ['-p', String(pg.port)] : []),
    ...(pg.user ? ['-U', pg.user] : []),
    '-w',
  ];
}

/** Command lines, built in one place so tests can hold them to the guard. */
const commands = {
  psql: (pg, sql) => ['psql', [...connArgs(pg), '-d', 'postgres', '-XAtq', '-v', 'ON_ERROR_STOP=1', '-c', sql]],
  create: (pg, template, name) => ['createdb', [...connArgs(pg), '-T', template, name]],
  drop: (name) => `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`,
};

/**
 * A small Postgres client over psql/createdb. `opts.spawn` is spawnSync-shaped and is the
 * test seam; `opts.env` is the child environment.
 */
function pgClient(pg, opts = {}) {
  const spawn = opts.spawn || spawnSync;
  const env = { ...(opts.env || process.env), PGCONNECT_TIMEOUT: '10' };
  const exec = (cmd, args, extraEnv = {}, timeout = 120000) => {
    const r = spawn(cmd, args, { encoding: 'utf8', timeout, env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.error && r.error.code === 'ENOENT') throw new RunDbError('E_PG', `${cmd} is not on PATH`, 'install the postgresql client');
    return { code: r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() };
  };
  const psql = (sql, timeout) => {
    const [cmd, args] = commands.psql(pg, sql);
    const r = exec(cmd, args, {}, timeout);
    if (r.code !== 0) throw new RunDbError('E_PG', `psql failed: ${r.err.split('\n')[0] || 'no answer'}`);
    return r.out;
  };
  const ident = (n) => {
    if (!PG_IDENT_RE.test(String(n))) throw new RunDbError('E_DB_NAME', `${JSON.stringify(n)} is not a plain Postgres name`);
    return n;
  };
  const client = {
    psql,
    exists: (n) => psql(`SELECT 1 FROM pg_database WHERE datname = '${ident(n)}'`) === '1',
    sessions: (n) => Number(psql(`SELECT count(*) FROM pg_stat_activity WHERE datname = '${ident(n)}' AND pid <> pg_backend_pid()`)),
    terminate: (n) => psql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${ident(n)}' AND pid <> pg_backend_pid()`),
    list: () => {
      const rows = psql(`SELECT datname FROM pg_database WHERE left(datname, ${RUN_DB_PREFIX.length}) = '${RUN_DB_PREFIX}' ORDER BY 1`);
      return (rows ? rows.split('\n') : []).filter((n) => !runDbNameProblem(n, pg));
    },
    createFrom: (template, name) => {
      const [cmd, args] = commands.create(pg, ident(template), ident(name));
      const r = exec(cmd, args, { PGAPPNAME: name }, 60 * 60000);
      if (r.code !== 0) {
        if (/being accessed by other users/i.test(r.err)) {
          throw new RunDbError('E_BASELINE_BUSY', `${template} was in use when the copy started`, r.err.split('\n')[0]);
        }
        throw new RunDbError('E_DB_COPY', `createdb ${name} -T ${template} failed`, r.err.split('\n')[0]);
      }
    },
    dropDb: (name) => psql(commands.drop(ident(name)), 300000),
  };
  return client;
}

/** Create the run database from the baseline unless it exists. {created} says which. */
function ensureRunDb(pg, name, opts = {}) {
  const problem = runDbNameProblem(name, pg);
  if (problem) throw new RunDbError('E_DB_NAME', `refusing to create ${name}: ${problem}`);
  const c = opts.client || pgClient(pg, opts);
  if (c.exists(name)) return { name, created: false };
  if (!c.exists(pg.baseline)) {
    throw new RunDbError('E_NO_BASELINE', `the baseline database ${pg.baseline} does not exist`,
      'create it with `node scripts/app.cjs baseline --refresh`, or set ONESHOT_PER_RUN_DB=0');
  }
  const busy = c.sessions(pg.baseline);
  if (busy) {
    throw new RunDbError('E_BASELINE_BUSY', `${busy} session(s) are connected to the baseline ${pg.baseline}`,
      'nothing may serve the baseline: Postgres will not copy a database with connections. Close them or re-create it with `app.cjs baseline --refresh`.');
  }
  c.createFrom(pg.baseline, name);
  return { name, created: true };
}

/**
 * The Django test database that belongs to a run database.
 *
 * Django's test runner creates `test_<NAME>` beside the database a settings module
 * names, and a worktree's generated hrdb/test_settings_oneshot.py names the run's own
 * database (config/erp/test_settings.template.py) — so each run's tests build and
 * destroy `test_oneshot_run_<iid>_<runid>` and never another run's. A test command
 * that is killed leaves it behind; dropRunDb takes it with the run database.
 */
function testDbName(name) {
  return `test_${name}`;
}

function dropRunDb(pg, name, opts = {}) {
  const problem = runDbNameProblem(name, pg);
  if (problem) throw new RunDbError('E_DB_NAME', `refusing to drop ${name}: ${problem}`);
  const c = opts.client || pgClient(pg, opts);
  // The test database first: once the run database is gone no sweep looks for
  // this run again, so a failure here must leave the pair to be retried together.
  // Its name is built from one the guard has just accepted, never read from Postgres.
  c.dropDb(testDbName(name));
  c.dropDb(name);
  return { name, dropped: true };
}

/**
 * (Re)create the baseline from the seed. The seed's sessions block the copy; they are
 * ended only with `terminate` (it is a live database somebody may be using).
 */
function refreshBaseline(pg, opts = {}) {
  if (!PG_IDENT_RE.test(pg.baseline) || pg.baseline.startsWith(RUN_DB_PREFIX) || pg.baseline === pg.seed) {
    throw new RunDbError('E_DB_NAME', `refusing to replace ${pg.baseline} as a baseline`);
  }
  const c = opts.client || pgClient(pg, opts);
  if (!c.exists(pg.seed)) throw new RunDbError('E_PG', `the seed database ${pg.seed} does not exist`);
  const busy = c.sessions(pg.seed);
  if (busy && !opts.terminate) {
    throw new RunDbError('E_SEED_BUSY', `${busy} session(s) are connected to the seed ${pg.seed}`,
      'stop the app serving it, or pass --terminate to end those sessions');
  }
  if (busy) c.terminate(pg.seed);
  c.dropDb(pg.baseline);
  c.createFrom(pg.seed, pg.baseline);
  return { baseline: pg.baseline, from: pg.seed, terminated: busy };
}

const ORPHAN_STATUSES = new Set(['done', 'aborted']);

/**
 * Run databases whose run is done, aborted or unknown. `statusOf(iid, shortId)` returns
 * the run's status or null when no run matches. Dry unless `drop`.
 */
function sweepRunDbs(pg, statusOf, opts = {}) {
  const c = opts.client || pgClient(pg, opts);
  const orphans = [];
  const kept = [];
  for (const name of c.list()) {
    const parsed = parseRunDbName(name);
    if (!parsed) continue;
    const status = statusOf(parsed.iid, parsed.shortId);
    if (status === null || status === undefined || ORPHAN_STATUSES.has(status)) orphans.push({ name, status: status || 'missing' });
    else kept.push({ name, status });
  }
  const dropped = [];
  const errors = [];
  if (opts.drop) {
    for (const o of orphans) {
      try { dropRunDb(pg, o.name, { client: c }); dropped.push(o.name); } catch (e) { errors.push(`${o.name}: ${e.message}`); }
    }
  }
  return { orphans, kept, dropped, errors };
}

/**
 * Is per-run DB mode on? ONESHOT_PER_RUN_DB=1 forces it (a missing baseline is then an
 * error at bring-up), 0 forces it off; unset means on exactly when the baseline exists.
 */
function perRunDbMode(env, probe) {
  const v = String(env.ONESHOT_PER_RUN_DB || '').trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(v)) return { on: true, why: 'ONESHOT_PER_RUN_DB=1' };
  if (['0', 'false', 'off', 'no'].includes(v)) return { on: false, why: 'ONESHOT_PER_RUN_DB=0' };
  try {
    return probe() ? { on: true, why: 'the baseline exists' } : { on: false, why: 'no baseline database' };
  } catch (e) {
    return { on: false, why: `could not check for a baseline (${e.message})` };
  }
}

module.exports = {
  RUN_DB_PREFIX, PG_IDENT_RE, LT_REDIS_INDEX, RunDbError, SECTION_START, SECTION_END,
  shortRunId, runDbName, parseRunDbName, runFromWorktree, runDbNameProblem,
  DATABASES_RE, findDatabasesBlock, blockValue, checkValue, buildDatabasesBlock, readSeedDb,
  redisIndexForSlot, brokerFor, rewriteRunSettings,
  pgTarget, connArgs, commands, pgClient, ensureRunDb, dropRunDb, testDbName, refreshBaseline, sweepRunDbs, perRunDbMode,
};

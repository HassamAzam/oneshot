#!/usr/bin/env node
'use strict';
/**
 * Provision the seed: the installed ERP clone (WORK_REPO / ONESHOT_SEED_FROM)
 * every leased worktree borrows venv, node_modules, staticfiles and its two
 * gitignored settings files from. Idempotent — every step is check → do →
 * verify, and a step whose check passes does nothing.
 *
 *   node scripts/provision-seed.cjs [--env-file /etc/oneshot/oneshot.env]
 *                                   [--check] [--only a,b] [--skip a,b]
 *
 * Steps, in order: credentials, clone, venv, npm, settings, configjs, logs,
 * database, migrate, collectstatic, testuser. The first FAIL stops the run (each step
 * needs the ones before it) and exits 1 with the fix.
 */
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const appenv = require('../src/lib/appenv.cjs');
const { readEnv } = require('../src/lib/repourl.cjs');

const ROOT = path.join(__dirname, '..');
const TEMPLATE = path.join(ROOT, 'config/erp/local_settings.template.py');
const GENERATED_MARK = '# ONESHOT-GENERATED';
const REQUIREMENTS = 'requirements/base.txt';
const VENV_STAMP = 'venv/.oneshot-requirements.sha256';
const NPM_STAMP = 'node_modules/.oneshot-lock.sha256';
const INSTALL_TIMEOUT_MS = 60 * 60 * 1000;
const MIGRATE_TIMEOUT_MS = 30 * 60 * 1000;
const STEPS = ['credentials', 'clone', 'venv', 'npm', 'settings', 'configjs', 'logs', 'database', 'migrate', 'collectstatic', 'testuser'];

const HELP = `provision-seed — make the seed ERP clone runnable, idempotently.

Usage: node scripts/provision-seed.cjs [options]

  --env-file <path>  read settings from this file too (process env wins; then this; then .env)
  --check            report what each step would do; change nothing; exit 1 if any step is due
  --only a,b         run only these steps
  --skip a,b         skip these steps
  --help             this text

Steps: ${STEPS.join(', ')}

Reads: GITLAB_REPO_URL, WORK_REPO (or ONESHOT_SEED_FROM), ONESHOT_GITLAB_TOKEN/GITLAB_TOKEN
(only to set up git credentials for an https clone), DB_NAME, DB_USER, DB_PASSWORD, DB_HOST,
DB_PORT, REDIS_URL, ONESHOT_APP_ALLOWED_HOSTS, ONESHOT_TEST_LOGIN, ONESHOT_PYTHON.`;

const C = process.stdout.isTTY && !process.env.NO_COLOR
  ? { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', d: '\x1b[2m', x: '\x1b[0m' }
  : { g: '', y: '', r: '', d: '', x: '' };

class StepError extends Error {
  constructor(message, fix) { super(message); this.fix = fix; }
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8', timeout: opts.timeout || 120000, cwd: opts.cwd, env: opts.env || process.env,
    stdio: opts.inherit ? ['ignore', 'inherit', 'inherit'] : [opts.input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    input: opts.input,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    ok: !r.error && r.status === 0,
    out: (r.stdout || '').trim(),
    err: (r.stderr || '').trim() || (r.error ? r.error.message : ''),
  };
}

const tail = (s, n = 3) => String(s || '').trim().split('\n').slice(-n).join(' | ').slice(0, 400);
const sha256 = (...files) => {
  const h = crypto.createHash('sha256');
  for (const f of files) if (fs.existsSync(f)) h.update(fs.readFileSync(f));
  return h.digest('hex');
};
const readStamp = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : '');

function writeAtomic(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode: mode || 0o644 });
  fs.renameSync(tmp, file);
}

/** A Python literal for a JS boolean, string or string array (JSON's grammar is a subset here). */
const pyLiteral = (v) => (typeof v === 'boolean' ? (v ? 'True' : 'False') : JSON.stringify(v));

function renderLocalSettings(s) {
  const values = {
    ALLOWED_HOSTS: s.allowedHosts, DB_NAME: s.db.name, DB_USER: s.db.user || os.userInfo().username,
    DB_PASSWORD: s.db.password, DB_HOST: s.db.host, DB_PORT: String(s.db.port), REDIS_URL: s.redisUrl,
    USE_ODOO: Boolean(s.odoo.url && s.odoo.db && s.odoo.username && s.odoo.password),
    ODOO_URL: s.odoo.url, ODOO_DB: s.odoo.db, ODOO_USERNAME: s.odoo.username, ODOO_PASSWORD: s.odoo.password,
  };
  return fs.readFileSync(TEMPLATE, 'utf8').replace(/\{\{([A-Z_]+)\}\}/g, (m, key) => {
    if (!(key in values)) throw new StepError(`template placeholder ${m} has no value`, `fix ${TEMPLATE}`);
    return pyLiteral(values[key]);
  });
}

const EXPORT_RE = /^export const ([A-Za-z_$][\w$]*)\s*=/;

/** Same composition as the harness: template keys, the existing file's value winning per key. */
function composeConfigJs(seed) {
  const template = path.join(seed, 'config.example.js');
  const target = path.join(seed, 'frontend/src/constants/config.js');
  if (!fs.existsSync(template)) throw new StepError('config.example.js missing from the seed', 'is WORK_REPO the ERP clone?');
  const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  const local = new Map();
  for (const line of before.split('\n')) {
    const m = line.match(EXPORT_RE);
    if (m) local.set(m[1], line);
  }
  const after = `${fs.readFileSync(template, 'utf8').split('\n').map((line) => {
    const key = (line.match(EXPORT_RE) || [])[1];
    return key && local.has(key) ? local.get(key) : line;
  }).join('\n').replace(/\n+$/, '')}\n`;
  return { target, before, after };
}

const ENSURE_TEST_USER = `
from datetime import date
from django.contrib.auth.hashers import check_password
from django.contrib.auth.models import User
from django.db import transaction
from apps.core.models import ClientPerson, Department, Person, Status
email, _, password = os.environ["ONESHOT_TEST_LOGIN"].partition(":")
actions = []
with transaction.atomic():
    user = User.objects.filter(email=email).first()
    if user is None:
        user = User(username=email[:150], email=email, is_staff=True, is_superuser=True)
        user.first_name = "Oneshot"
        user.last_name = "Test"
        actions.append("created user")
    if not user.is_active:
        user.is_active = True
        actions.append("activated")
    if not user.pk or not check_password(password, user.password):
        user.set_password(password)
        actions.append("set password")
    if actions:
        user.save()
    linked = Person.objects.filter(user=user).exists() or ClientPerson.objects.filter(user=user).exists()
    if not linked:
        department = Department.objects.first()
        status = Status.objects.first()
        if department is None or status is None:
            print("ONESHOT_TESTUSER " + json.dumps({"error": "no Department/Status rows to attach a Person to"}))
            raise SystemExit(0)
        Person.objects.create(
            user=user, department=department, status=status, gender="M", full_name="Oneshot Test",
            joining_date=date.today(), person_id=("ONESHOT-" + str(user.pk))[:20], nic=None,
        )
        actions.append("created person")
print("ONESHOT_TESTUSER " + json.dumps({"actions": actions}))
`;

function makeSteps(s, env) {
  const seed = s.seed;
  const py = path.join(seed, 'venv/bin/python');
  const token = readEnv(env, 'ONESHOT_GITLAB_TOKEN') || readEnv(env, 'GITLAB_TOKEN');
  const django = (src, extra = {}, timeout) => appenv.seedPython(seed, src, extra, timeout);
  const logDirs = () => appenv.logDirs(s);

  return {
    credentials: {
      check: () => {
        if (!s.repo || s.repo.scheme !== 'https' || fs.existsSync(path.join(seed, '.git'))) return 'not needed';
        const r = sh('git', ['credential', 'fill'], {
          cwd: os.homedir(),
          input: `protocol=https\nhost=${s.repo.host}\n\n`,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true' },
        });
        return r.ok && /password=./.test(r.out) ? `git already has a credential for ${s.repo.hostname}` : null;
      },
      do: () => {
        if (!token) throw new StepError('no GitLab token to clone with', 'set ONESHOT_GITLAB_TOKEN or GITLAB_TOKEN, or clone WORK_REPO by hand');
        const helper = sh('git', ['config', '--global', `credential.${s.repo.origin}.helper`, 'store'], { cwd: os.homedir() });
        if (!helper.ok) throw new StepError(`git config failed: ${tail(helper.err)}`, 'check ~/.gitconfig is writable');
        const store = path.join(os.homedir(), '.git-credentials');
        const line = `https://oauth2:${encodeURIComponent(token)}@${s.repo.host}`;
        const lines = fs.existsSync(store) ? fs.readFileSync(store, 'utf8').split('\n').filter(Boolean) : [];
        const kept = lines.filter((l) => !l.endsWith(`@${s.repo.host}`));
        writeAtomic(store, `${[...kept, line].join('\n')}\n`, 0o600);
        return `git credential store for ${s.repo.host} (~/.git-credentials, mode 600)`;
      },
      verify: () => true,
    },
    clone: {
      check: () => (fs.existsSync(path.join(seed, '.git')) ? `${seed} is a clone` : null),
      do: () => {
        if (!s.repo) throw new StepError(s.repoError || 'GITLAB_REPO_URL unset', 'set GITLAB_REPO_URL');
        if (fs.existsSync(seed) && fs.readdirSync(seed).length) {
          throw new StepError(`${seed} exists, is not empty, and is not a git clone`, 'move it aside or point WORK_REPO elsewhere');
        }
        fs.mkdirSync(path.dirname(seed), { recursive: true });
        const r = sh('git', ['clone', '--', s.repo.url, seed], {
          cwd: os.homedir(), inherit: true, timeout: INSTALL_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        });
        if (!r.ok) {
          throw new StepError(`git clone ${s.repo.webUrl} failed`,
            `is ${s.repo.hostname} reachable (VPN)? does the token have read_repository? ${tail(r.err)}`);
        }
        return `cloned ${s.repo.webUrl}`;
      },
      verify: () => fs.existsSync(path.join(seed, '.git')),
    },
    venv: {
      check: () => {
        if (!fs.existsSync(py)) return null;
        const v = sh(py, ['--version']);
        if (!`${v.out}${v.err}`.includes(`Python ${appenv.PYTHON_VERSION}`)) return null;
        const want = sha256(path.join(seed, REQUIREMENTS));
        return readStamp(path.join(seed, VENV_STAMP)) === want ? `${v.out}, requirements unchanged` : null;
      },
      do: () => {
        const notes = [];
        const v = fs.existsSync(py) ? sh(py, ['--version']) : { out: '', err: '' };
        if (!`${v.out}${v.err}`.includes(`Python ${appenv.PYTHON_VERSION}`)) {
          if (fs.existsSync(path.join(seed, 'venv'))) {
            fs.rmSync(path.join(seed, 'venv'), { recursive: true, force: true });
            notes.push(`replaced a venv that was not Python ${appenv.PYTHON_VERSION}`);
          }
          const mk = sh(s.python, ['-m', 'venv', path.join(seed, 'venv')], { timeout: 300000 });
          if (!mk.ok) {
            throw new StepError(`${s.python} -m venv failed: ${tail(mk.err)}`,
              'install python3.12 and python3.12-venv (scripts/setup-server.sh does)');
          }
          notes.push('created venv');
        }
        for (const args of [['-m', 'pip', 'install', '--upgrade', 'pip', 'wheel'], ['-m', 'pip', 'install', '-r', REQUIREMENTS]]) {
          const r = sh(py, args, { cwd: seed, inherit: true, timeout: INSTALL_TIMEOUT_MS });
          if (!r.ok) {
            throw new StepError(`pip ${args.slice(3).join(' ')} failed`,
              'native build deps: libpq-dev unixodbc-dev build-essential python3.12-dev (setup-server.sh installs them)');
          }
        }
        writeAtomic(path.join(seed, VENV_STAMP), `${sha256(path.join(seed, REQUIREMENTS))}\n`);
        notes.push(`installed ${REQUIREMENTS}`);
        return notes.join(', ');
      },
      verify: () => sh(py, ['-c', 'import ssl, hashlib, django, psycopg2'], { cwd: seed }).ok,
    },
    npm: {
      check: () => {
        const want = sha256(path.join(seed, 'package-lock.json'));
        return fs.existsSync(path.join(seed, 'node_modules')) && readStamp(path.join(seed, NPM_STAMP)) === want
          ? 'node_modules matches package-lock.json' : null;
      },
      do: () => {
        const r = sh('npm', ['ci', '--no-audit', '--no-fund'], {
          cwd: seed, inherit: true, timeout: INSTALL_TIMEOUT_MS, env: { ...process.env, HUSKY: '0' },
        });
        if (!r.ok) throw new StepError('npm ci failed in the seed', 'npm registry reachable? (it is blocked while some VPNs are up)');
        writeAtomic(path.join(seed, NPM_STAMP), `${sha256(path.join(seed, 'package-lock.json'))}\n`);
        return 'npm ci';
      },
      verify: () => fs.existsSync(path.join(seed, 'node_modules/.bin')),
    },
    settings: {
      check: () => {
        const f = path.join(seed, 'hrdb/local_settings.py');
        if (!fs.existsSync(f)) return null;
        const cur = fs.readFileSync(f, 'utf8');
        if (!cur.startsWith(GENERATED_MARK)) return 'hrdb/local_settings.py is hand-made — left alone';
        return cur === renderLocalSettings(s) ? 'hrdb/local_settings.py current' : null;
      },
      do: () => {
        writeAtomic(path.join(seed, 'hrdb/local_settings.py'), renderLocalSettings(s), 0o600);
        return `wrote hrdb/local_settings.py (db ${s.db.name}@${s.db.host}:${s.db.port}, mode 600)`;
      },
      verify: () => fs.existsSync(path.join(seed, 'hrdb/local_settings.py')),
    },
    configjs: {
      check: () => {
        const c = composeConfigJs(seed);
        return c.before === c.after ? 'frontend/src/constants/config.js has every template key' : null;
      },
      do: () => {
        const c = composeConfigJs(seed);
        writeAtomic(c.target, c.after);
        return `composed frontend/src/constants/config.js from config.example.js`;
      },
      verify: () => fs.existsSync(path.join(seed, 'frontend/src/constants/config.js')),
    },
    logs: {
      check: () => (logDirs().every((d) => fs.existsSync(d)) ? `${logDirs().join(', ')} exist` : null),
      do: () => {
        for (const d of logDirs()) fs.mkdirSync(d, { recursive: true });
        return `created ${logDirs().join(', ')} (hrdb/settings.py logs to <checkout>/../logs)`;
      },
      verify: () => logDirs().every((d) => fs.existsSync(d)),
    },
    database: {
      check: () => {
        const r = appenv.psql(s.db, `SELECT 1 FROM pg_database WHERE datname = '${s.db.name}'`);
        if (!r.ok) throw new StepError(`Postgres not reachable: ${appenv.firstLine(r.err)}`, 'start Postgres; check DB_HOST/DB_PORT/DB_USER/DB_PASSWORD');
        return r.out === '1' ? `database ${s.db.name} exists` : null;
      },
      do: () => {
        if (!/^[a-z_][a-z0-9_]*$/.test(s.db.name)) throw new StepError(`refusing DB_NAME '${s.db.name}'`, 'lower-case letters, digits, _');
        const r = appenv.psql(s.db, `CREATE DATABASE ${s.db.name}`);
        if (!r.ok) throw new StepError(`CREATE DATABASE ${s.db.name} failed: ${appenv.firstLine(r.err)}`, `ALTER ROLE ${s.db.user || 'you'} CREATEDB;`);
        return `created empty database ${s.db.name} (restore a dump with setup-server.sh ONESHOT_DB_DUMP for real data)`;
      },
      verify: () => appenv.psql(s.db, `SELECT 1 FROM pg_database WHERE datname = '${s.db.name}'`).out === '1',
    },
    migrate: {
      check: () => (django(`
from django.core.management import call_command
call_command("migrate", "--check", verbosity=0)
`).ok ? 'no unapplied migrations' : null),
      do: () => {
        const r = django(`
from django.core.management import call_command
call_command("migrate", interactive=False, verbosity=1)
`, {}, MIGRATE_TIMEOUT_MS);
        if (!r.ok) {
          throw new StepError(`migrate failed: ${tail(r.err)}`,
            'ERP\'s migrations do not apply to an EMPTY database (a data migration reads a column a later one adds): '
            + 'restore a dump into it (setup-server.sh with ONESHOT_DB_DUMP) and re-run. A dump newer than the clone '
            + 'needs `git pull` in the seed instead.');
        }
        return 'applied migrations';
      },
      verify: () => django('from django.core.management import call_command\ncall_command("migrate", "--check", verbosity=0)\n').ok,
    },
    collectstatic: {
      check: () => (fs.existsSync(path.join(seed, 'staticfiles/staticfiles.json')) ? 'staticfiles manifest present' : null),
      do: () => {
        const r = django('from django.core.management import call_command\ncall_command("collectstatic", interactive=False, verbosity=0)\n',
          {}, MIGRATE_TIMEOUT_MS);
        if (!r.ok) throw new StepError(`collectstatic failed: ${tail(r.err)}`, 'read the error above');
        return 'collected staticfiles';
      },
      verify: () => fs.existsSync(path.join(seed, 'staticfiles/staticfiles.json')),
    },
    testuser: {
      check: () => {
        if (!s.testLogin) throw new StepError('ONESHOT_TEST_LOGIN unset or not email:password', 'set ONESHOT_TEST_LOGIN in the env file');
        const v = appenv.testLoginVerdict(s);
        if (v.verdict === 'ok') return `${s.testLogin.split(':')[0]} can log in`;
        if (!v.verdict) throw new StepError(`login check could not run: ${v.error}`, 'earlier steps must pass first');
        return null;
      },
      do: () => {
        const r = django(ENSURE_TEST_USER, { ONESHOT_TEST_LOGIN: s.testLogin });
        const line = r.out.split('\n').find((l) => l.startsWith('ONESHOT_TESTUSER '));
        if (!r.ok || !line) throw new StepError(`test user script failed: ${tail(r.err)}`, 'create the user in Django admin');
        const res = JSON.parse(line.slice('ONESHOT_TESTUSER '.length));
        if (res.error) throw new StepError(res.error, 'restore a database dump (ONESHOT_DB_DUMP) that has departments and statuses');
        return `${s.testLogin.split(':')[0]}: ${res.actions.join(', ') || 'nothing to change'}`;
      },
      verify: () => appenv.testLoginVerdict(s).verdict === 'ok',
    },
  };
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(HELP); return 0; }
  const arg = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] || '' : ''; };
  const list = (flag) => arg(flag).split(',').map((x) => x.trim()).filter(Boolean);
  const envFile = arg('--env-file');
  if (envFile && !fs.existsSync(envFile)) { console.error(`--env-file ${envFile} does not exist`); return 2; }
  appenv.loadEnvFiles([envFile, path.join(ROOT, '.env')]);
  const only = list('--only');
  const skip = new Set(list('--skip'));
  const unknown = [...only, ...skip].filter((x) => !STEPS.includes(x));
  if (unknown.length) { console.error(`unknown step(s): ${unknown.join(', ')} — steps: ${STEPS.join(', ')}`); return 2; }
  const dry = argv.includes('--check');

  const s = appenv.appSettings(process.env);
  if (!s.seed) { console.error('no seed path: set WORK_REPO (or ONESHOT_SEED_FROM) — there is no default on a server'); return 2; }
  console.log(`provision-seed ${dry ? '(check only) ' : ''}— seed ${s.seed}`);
  const steps = makeSteps(s, process.env);
  let due = 0;
  for (const name of STEPS.filter((n) => (!only.length || only.includes(n)) && !skip.has(n))) {
    const step = steps[name];
    try {
      const fine = step.check();
      if (fine) { console.log(`  ${C.g}ok${C.x}    ${name} — ${fine}`); continue; }
      due += 1;
      if (dry) { console.log(`  ${C.y}due${C.x}   ${name}`); continue; }
      const did = step.do();
      if (!step.verify()) throw new StepError(`${name} ran but its result does not verify`, 're-run with --only ' + name);
      console.log(`  ${C.g}did${C.x}   ${name} — ${did}`);
    } catch (err) {
      if (dry && !(err instanceof StepError)) throw err;
      if (dry && due > 0) {
        due += 1;
        console.log(`  ${C.y}due${C.x}   ${name} ${C.d}— cannot be judged until the steps above run (${err.message})${C.x}`);
        continue;
      }
      console.log(`  ${C.r}FAIL${C.x}  ${name} — ${err.message}${err.fix ? `\n        fix: ${err.fix}` : ''}`);
      if (dry) { due += 1; continue; }
      return 1;
    }
  }
  if (dry) { console.log(due ? `\n${due} step(s) due` : '\nnothing to do'); return due ? 1 : 0; }
  console.log(`\n${C.g}seed ready${C.x}`);
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`provision-seed crashed: ${err.stack || err.message}`);
    process.exit(1);
  }
}

module.exports = { STEPS, renderLocalSettings, composeConfigJs, main };

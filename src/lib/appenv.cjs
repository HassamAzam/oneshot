'use strict';
/**
 * Host prerequisites for running Oneshot and the app it drives — one list both
 * `npm run doctor` and `scripts/setup-server.sh --check` print.
 *
 * Every check is synchronous, read-only and answers {name, ok, detail, fix,
 * required}. `required: false` is a WARN in doctor, never a FAIL. Nothing here
 * prints a secret: credentials travel to child processes through the
 * environment, never argv, and only their presence is reported.
 *
 * Paths and database settings come from the environment only (no ~/Documents
 * guess on a server): WORK_REPO / ONESHOT_SEED_FROM, DB_NAME, DB_USER,
 * DB_PASSWORD, DB_HOST, DB_PORT, REDIS_URL, ONESHOT_TEST_LOGIN.
 *
 * CLI: node src/lib/appenv.cjs [--env-file <path>] [--json] [--skip a,b]
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readEnv, resolveTarget, resolvePath, expandPath } = require('./repourl.cjs');

const ROOT = path.join(__dirname, '..', '..');
const MIN_NODE_MAJOR = 21;
const PYTHON_VERSION = '3.12';
const RUN_DB_PREFIX = 'oneshot_run_';
const PROBE_TIMEOUT_MS = 15000;
const DJANGO_TIMEOUT_MS = 120000;

/**
 * Parse KEY=value lines the way systemd's EnvironmentFile= does: no expansion,
 * and a `#` after a value is part of the value, so every reader of the server
 * env file agrees on what it says.
 */
function parseEnvText(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2];
    if (/^"(.*)"$/s.test(v)) v = v.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
    else if (/^'(.*)'$/s.test(v)) v = v.slice(1, -1);
    else v = v.trim();
    out[m[1]] = v;
  }
  return out;
}

/**
 * Fill `target` from each file in order, never overwriting a key already set:
 * the process environment (systemd's EnvironmentFile) wins, then the first file.
 * Returns the files that were actually read.
 */
function loadEnvFiles(files, target = process.env) {
  const read = [];
  for (const f of files.filter(Boolean)) {
    if (!fs.existsSync(f)) continue;
    const vals = parseEnvText(fs.readFileSync(f, 'utf8'));
    for (const [k, v] of Object.entries(vals)) if (target[k] === undefined || target[k] === '') target[k] = v;
    read.push(f);
  }
  return read;
}

/** Everything the checks and the provisioner agree on, from `env`. */
function appSettings(env = process.env) {
  const target = resolveTarget(env, ROOT);
  const seedPath = resolvePath(env, { name: target.name, envName: 'ONESHOT_SEED_FROM', fallback: '', root: ROOT });
  const login = readEnv(env, 'ONESHOT_TEST_LOGIN');
  return {
    repo: target.repo,
    repoError: target.error,
    workRepo: target.workRepo.path,
    seed: seedPath.path || target.workRepo.path,
    wtRoot: target.wtRoot.path,
    db: {
      name: readEnv(env, 'DB_NAME', 'hrdb'),
      user: readEnv(env, 'DB_USER', ''),
      password: readEnv(env, 'DB_PASSWORD', ''),
      host: readEnv(env, 'DB_HOST', '127.0.0.1'),
      port: readEnv(env, 'DB_PORT', '5432'),
    },
    perRunDb: readEnv(env, 'ONESHOT_PER_RUN_DB') === '1',
    dbBaseline: readEnv(env, 'ONESHOT_DB_BASELINE', `${readEnv(env, 'DB_NAME', 'hrdb')}_baseline`),
    redisUrl: readEnv(env, 'REDIS_URL', 'redis://127.0.0.1:6379/0'),
    allowedHosts: readEnv(env, 'ONESHOT_APP_ALLOWED_HOSTS', '127.0.0.1,localhost')
      .split(',').map((s) => s.trim()).filter(Boolean),
    testLogin: login && login.includes(':') ? login : '',
    python: readEnv(env, 'ONESHOT_PYTHON', `python${PYTHON_VERSION}`),
  };
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout || PROBE_TIMEOUT_MS, ...opts });
  const missing = r.error && r.error.code === 'ENOENT';
  return {
    ok: !r.error && r.status === 0,
    missing,
    out: (r.stdout || '').trim(),
    err: (r.stderr || '').trim() || (r.error ? r.error.message : ''),
  };
}

function firstLine(s) {
  return String(s || '').split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 200) || '';
}

function onPath(cmd) {
  return run('sh', ['-c', `command -v ${cmd}`]).ok;
}

const isLinux = () => process.platform === 'linux';
const pkgHint = (apt, brew) => (isLinux() ? `sudo apt-get install -y ${apt}` : `brew install ${brew}`);

/** psql against the maintenance database, never prompting, password via PGPASSWORD. */
function psql(db, sql, database = 'postgres') {
  return run('psql', [
    '-h', db.host, '-p', String(db.port), ...(db.user ? ['-U', db.user] : []),
    '-d', database, '-XAtqw', '-c', sql,
  ], { env: { ...process.env, PGPASSWORD: db.password, PGCONNECT_TIMEOUT: '5' } });
}

/** Python run in the seed with the ssl/hashlib shim the venv needs before Django loads. */
const DJANGO_SHIM = 'import ssl, hashlib\nimport sys, os, json\nimport django\ndjango.setup()\n';

function seedPython(seed, src, extraEnv = {}, timeout = DJANGO_TIMEOUT_MS) {
  return run(path.join(seed, 'venv/bin/python'), ['-c', DJANGO_SHIM + src], {
    cwd: seed, timeout,
    env: { ...process.env, DJANGO_SETTINGS_MODULE: 'hrdb.settings', PYTHONUNBUFFERED: '1', ...extraEnv },
  });
}

/** Mirrors src/lib/testlogin.ts: a User with the email, a linked Person/ClientPerson, active, password matches. */
const TEST_LOGIN_VERDICT = `
from django.contrib.auth.hashers import check_password
from django.contrib.auth.models import User
from apps.core.models import ClientPerson, Person
email, _, password = os.environ["ONESHOT_TEST_LOGIN"].partition(":")
user = User.objects.filter(email=email).first()
if user is None:
    verdict = "no-user"
elif not (Person.objects.filter(user=user).exists() or ClientPerson.objects.filter(user=user).exists()):
    verdict = "no-person"
elif not user.is_active:
    verdict = "inactive"
elif not check_password(password, user.password):
    verdict = "bad-password"
else:
    verdict = "ok"
print("ONESHOT_LOGIN_CHECK " + json.dumps({"verdict": verdict}))
`;

function testLoginVerdict(settings) {
  const r = seedPython(settings.seed, TEST_LOGIN_VERDICT, { ONESHOT_TEST_LOGIN: settings.testLogin });
  const line = r.out.split('\n').find((l) => l.startsWith('ONESHOT_LOGIN_CHECK '));
  if (!line) return { verdict: null, error: firstLine(r.err.split('\n').slice(-1)[0]) || 'no verdict printed' };
  return { verdict: JSON.parse(line.slice('ONESHOT_LOGIN_CHECK '.length)).verdict };
}

/** The pieces of the seed every worktree borrows; ordered as provision-seed creates them. */
const SEED_PARTS = [
  ['.git', 'clone'],
  ['venv/bin/python', 'venv'],
  ['node_modules', 'npm'],
  ['hrdb/local_settings.py', 'settings'],
  ['frontend/src/constants/config.js', 'configjs'],
  ['staticfiles/staticfiles.json', 'collectstatic'],
];

/**
 * hrdb/settings.py logs to `<checkout>/../logs` (LOG_ROOT, not overridable from
 * local_settings), and Django refuses to start when that directory is missing:
 * the seed's parent, and WT_ROOT for every worktree directly under it.
 */
function logDirs(s) {
  return [...new Set([s.seed && path.join(path.dirname(s.seed), 'logs'), s.wtRoot && path.join(s.wtRoot, 'logs')]
    .filter(Boolean))];
}

function playwrightCaches(env = process.env) {
  if (env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== '0') return [env.PLAYWRIGHT_BROWSERS_PATH];
  if (process.platform === 'darwin') return [path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')];
  if (process.platform === 'win32') return [path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright')];
  return [path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ms-playwright')];
}

function claudeCredentialSource(env = process.env) {
  if (readEnv(env, 'CLAUDE_CODE_OAUTH_TOKEN')) return 'CLAUDE_CODE_OAUTH_TOKEN';
  const dir = env.CLAUDE_CONFIG_DIR ? expandPath(env.CLAUDE_CONFIG_DIR, ROOT) : path.join(os.homedir(), '.claude');
  const file = path.join(dir, '.credentials.json');
  if (fs.existsSync(file)) return file;
  if (process.platform === 'darwin'
    && run('security', ['find-generic-password', '-s', 'Claude Code-credentials']).ok) return 'macOS keychain';
  return '';
}

function gitlabTokenSource(env = process.env) {
  for (const k of ['ONESHOT_GITLAB_TOKEN', 'GITLAB_TOKEN']) if (readEnv(env, k)) return k;
  const file = path.join(os.homedir(), '.config', 'oneshot', 'gitlab-token');
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim()) return file;
  return '';
}

function check(name, ok, detail, fix, required = true) {
  return { name, ok: Boolean(ok), detail: detail || '', fix: ok ? '' : (fix || ''), required };
}

const CHECKS = {
  node: () => {
    const major = Number(process.versions.node.split('.')[0]);
    return check('node', major >= MIN_NODE_MAJOR, `v${process.versions.node}`,
      `Node >= ${MIN_NODE_MAJOR} is needed (npm test's glob); install Node 22 (NodeSource on Linux, nvm/brew on macOS)`);
  },
  python: (s) => {
    const sys = run(s.python, ['--version']);
    if (sys.ok) return check(`python${PYTHON_VERSION}`, true, sys.out || sys.err);
    const venv = run(path.join(s.seed || '/nonexistent', 'venv/bin/python'), ['--version']);
    const viaVenv = venv.ok && (venv.out || venv.err).includes(`Python ${PYTHON_VERSION}`);
    return check(`python${PYTHON_VERSION}`, viaVenv, viaVenv ? `seed venv ${venv.out}` : `${s.python} not on PATH`,
      isLinux() ? 'sudo apt-get install -y python3.12 python3.12-venv python3.12-dev (deadsnakes PPA on Ubuntu 22.04)'
        : 'brew install python@3.12');
  },
  git: () => {
    const r = run('git', ['--version']);
    return check('git', r.ok, r.out, pkgHint('git', 'git'));
  },
  portProbe: () => {
    const tools = ['lsof', 'ss'].filter(onPath);
    return check('lsof or ss', tools.length > 0, tools.join(', ') || 'neither on PATH',
      `port and pid probing needs one: ${pkgHint('lsof iproute2', 'lsof')}`);
  },
  pgClient: () => {
    const missing = ['psql', 'createdb'].filter((c) => !onPath(c));
    return check('psql + createdb', !missing.length, missing.length ? `missing: ${missing.join(', ')}` : 'on PATH',
      pkgHint('postgresql-client', 'libpq && brew link --force libpq'));
  },
  postgres: (s) => {
    const where = `${s.db.user ? `${s.db.user}@` : ''}${s.db.host}:${s.db.port}`;
    if (!onPath('psql')) return check('Postgres reachable', false, 'psql missing', pkgHint('postgresql-client', 'libpq'));
    const r = psql(s.db, 'SELECT rolcreatedb OR rolsuper FROM pg_roles WHERE rolname = current_user');
    if (!r.ok) {
      return check('Postgres reachable', false, `${where} — ${firstLine(r.err) || 'no answer'}`,
        'start Postgres and set DB_HOST/DB_PORT/DB_USER/DB_PASSWORD (setup-server.sh creates the role)');
    }
    return check('Postgres role can CREATE DATABASE', r.out === 't', `${where}`,
      `per-ticket ${RUN_DB_PREFIX}* databases need it: ALTER ROLE ${s.db.user || 'current_user'} CREATEDB;`);
  },
  appDb: (s) => {
    if (!/^[a-z_][a-z0-9_]*$/.test(s.db.name)) return check('app database', false, `bad DB_NAME '${s.db.name}'`, 'lower-case letters, digits, _');
    const r = psql(s.db, `SELECT 1 FROM pg_database WHERE datname = '${s.db.name}'`);
    return check('app database', r.ok && r.out === '1', s.db.name,
      `createdb ${s.db.name} (or restore ONESHOT_DB_DUMP via setup-server.sh)`);
  },
  baseline: (s) => {
    if (!s.perRunDb) return check('per-run DB baseline', true, 'ONESHOT_PER_RUN_DB off — runs share the app database');
    const r = psql(s.db, `SELECT 1 FROM pg_database WHERE datname = '${s.dbBaseline.replace(/'/g, '')}'`);
    return check('per-run DB baseline', r.ok && r.out === '1', s.dbBaseline,
      'node scripts/app.cjs baseline --refresh --terminate (per-run databases stay off until it exists)');
  },
  redis: (s) => {
    const r = run('redis-cli', ['-u', s.redisUrl, 'ping']);
    if (r.missing) return check('redis', false, 'redis-cli not on PATH', pkgHint('redis-server redis-tools', 'redis && brew services start redis'));
    return check('redis', r.ok && r.out === 'PONG', `${s.redisUrl.replace(/\/\/[^@]*@/, '//***@')} ${r.out || firstLine(r.err)}`,
      isLinux() ? 'sudo systemctl enable --now redis-server' : 'brew services start redis');
  },
  claudeCli: () => {
    const r = run('claude', ['--version']);
    return check('claude CLI', r.ok, r.ok ? r.out : 'not on PATH', 'npm i -g @anthropic-ai/claude-code');
  },
  claudeAuth: () => {
    const src = claudeCredentialSource();
    return check('Claude credentials', Boolean(src), src || 'none found',
      'run `claude setup-token` and put CLAUDE_CODE_OAUTH_TOKEN in the env file (never ANTHROPIC_API_KEY)');
  },
  gitlabToken: () => {
    const src = gitlabTokenSource();
    return check('GitLab token', Boolean(src), src || 'none found',
      'set ONESHOT_GITLAB_TOKEN (or GITLAB_TOKEN) in the env file, or run `npm run token:set`');
  },
  gitlabReachable: (s) => {
    if (!s.repo) return check('GitLab reachable', false, s.repoError || 'GITLAB_REPO_URL unset', 'set GITLAB_REPO_URL');
    const url = `${s.repo.apiUrl}/version`;
    const r = run('curl', ['-sS', '--max-time', '10', '-w', '\n%{http_code}', url]);
    const lines = r.out.split('\n');
    const code = Number(lines.pop());
    const body = lines.join(' ').slice(0, 80);
    const vpnFix = `${s.repo.hostname} is network-gated (FortiClient VPN). On a server: run openfortivpn, `
      + 'or ask DevOps to allow-list this host';
    if (code === 200 || code === 401) return check('GitLab reachable', true, `${url} HTTP ${code}`);
    if (code === 403 && /RBAC/i.test(body)) {
      return check('GitLab reachable', false, `${url} HTTP 403 "${body}" — the gateway refuses this network`, vpnFix);
    }
    return check('GitLab reachable', false, `${url} HTTP ${code || '000'} ${body || firstLine(r.err)}`, vpnFix);
  },
  playwright: () => {
    const caches = playwrightCaches();
    const found = caches.find((c) => {
      try { return fs.readdirSync(c).some((d) => /^chromium(_headless_shell)?-\d+$/.test(d)); } catch { return false; }
    });
    return check('playwright chromium', Boolean(found), found || `none under ${caches.join(', ')}`,
      isLinux() ? 'sudo npx playwright install-deps chromium && npx playwright install chromium'
        : 'npx playwright install chromium (VPN off)');
  },
  seed: (s) => {
    if (!s.seed) return check('seed complete', false, 'no WORK_REPO / ONESHOT_SEED_FROM', 'set WORK_REPO in the env file');
    const missing = [
      ...SEED_PARTS.filter(([rel]) => !fs.existsSync(path.join(s.seed, rel))).map(([rel]) => rel),
      ...logDirs(s).filter((d) => !fs.existsSync(d)),
    ];
    return check('seed complete', !missing.length, missing.length ? `${s.seed} lacks ${missing.join(', ')}` : s.seed,
      'node scripts/provision-seed.cjs');
  },
  testUser: (s) => {
    if (!s.testLogin) return check('test user', false, 'ONESHOT_TEST_LOGIN unset or not email:password', 'set ONESHOT_TEST_LOGIN=email:password');
    const email = s.testLogin.split(':')[0];
    if (!fs.existsSync(path.join(s.seed, 'venv/bin/python'))) return check('test user', false, `${email} — seed has no venv`, 'node scripts/provision-seed.cjs');
    const v = testLoginVerdict(s);
    return check('test user', v.verdict === 'ok', `${email} ${v.verdict || v.error}`,
      'node scripts/provision-seed.cjs --only testuser');
  },
};

const CHECK_ORDER = Object.keys(CHECKS);

/**
 * Run every check (or `only`, minus `skip`) against `env`.
 * @returns {Array<{name: string, ok: boolean, detail: string, fix: string, required: boolean}>}
 */
function checkPrereqs(opts = {}) {
  const settings = appSettings(opts.env || process.env);
  const skip = new Set(opts.skip || []);
  const ids = (opts.only && opts.only.length ? opts.only : CHECK_ORDER).filter((id) => !skip.has(id));
  return ids.map((id) => {
    try {
      return { id, ...CHECKS[id](settings) };
    } catch (err) {
      return { id, ...check(id, false, `check crashed: ${err.message}`, 'report this') };
    }
  });
}

function formatResult(r) {
  const tag = r.ok ? 'PASS' : r.required ? 'FAIL' : 'WARN';
  return `  ${tag}  ${r.name}${r.detail ? ` — ${r.detail}` : ''}${r.ok ? '' : `\n        fix: ${r.fix}`}`;
}

function main(argv) {
  const arg = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
  loadEnvFiles([arg('--env-file'), path.join(ROOT, '.env')]);
  const skip = (arg('--skip') || '').split(',').filter(Boolean);
  const only = (arg('--only') || '').split(',').filter(Boolean);
  const results = checkPrereqs({ skip, only });
  if (argv.includes('--json')) console.log(JSON.stringify(results, null, 2));
  else results.forEach((r) => console.log(formatResult(r)));
  const failed = results.filter((r) => !r.ok && r.required);
  if (!argv.includes('--json')) console.log(`\n${failed.length} failed of ${results.length}`);
  return failed.length ? 1 : 0;
}

module.exports = {
  ROOT, RUN_DB_PREFIX, PYTHON_VERSION, MIN_NODE_MAJOR, SEED_PARTS, CHECK_ORDER,
  parseEnvText, loadEnvFiles, appSettings, logDirs, checkPrereqs, formatResult, playwrightCaches,
  claudeCredentialSource, gitlabTokenSource, psql, seedPython, testLoginVerdict, run, firstLine, onPath,
};

if (require.main === module) process.exit(main(process.argv.slice(2)));

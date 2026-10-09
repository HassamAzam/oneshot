/**
 * `npm run doctor` — everything that must be true before a real ticket runs.
 *
 * Checks are ordered cheapest-first and each is independent, so a failure
 * early does not hide the rest. Exit 1 on any FAIL; WARN never fails the run.
 */
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  CONTEXT_REPO, PROJECT_TARGET, SKILLS_ROOT, WORK_REPO, WT_ROOT, pathSources, seedFrom,
  auditAuth, budgetConfig, bugReproductionEnabled, envOr, expandPath, localTestsConfig, phases,
  phasesOutsideTarget, portPool, projectConfig, repoIdentity, requiredLabels, reviewersConfig, slackConfig,
  type LocalTestsConfig,
} from '../src/lib/config.js';
import { ping, getBranch, listLabels } from '../src/lib/gitlab.js';
import {
  checkoutFindings, identityFindings, relaxRepoChecks, repoCheckOverrideNotice, wtRootFinding, type Finding,
} from '../src/lib/repocheck.js';
import { foreignJournalFinding } from '../src/lib/journalproject.js';
import { slackEnabled, userIdForEmail, userIdForHandle } from '../src/lib/slack.js';
import { checkIdentity } from '../src/lib/identity.js';
import { otelStatus, promptTextExported } from '../src/lib/otel.js';

let fails = 0;
let warns = 0;

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m';

function pass(label: string, detail = ''): void {
  console.log(`  ${G}PASS${X}  ${label}${detail ? ` ${D}${detail}${X}` : ''}`);
}
function warn(label: string, detail = ''): void {
  warns += 1;
  console.log(`  ${Y}WARN${X}  ${label}${detail ? ` ${D}${detail}${X}` : ''}`);
}
function fail(label: string, detail = ''): void {
  fails += 1;
  console.log(`  ${R}FAIL${X}  ${label}${detail ? ` ${D}${detail}${X}` : ''}`);
}
function section(name: string): void { console.log(`\n${name}`); }
function report(f: Finding): void {
  if (f.level === 'fail') fail(f.label, f.detail);
  else if (f.level === 'warn') warn(f.label, f.detail);
  else pass(f.label, f.detail);
}

// ----------------------------------------------------------- local tests

/**
 * `git -C <dir> …`, read-only and never prompting: a probe that waits on an
 * ssh passphrase is a doctor that hangs instead of answering.
 */
function gitIn(dir: string, args: string[], timeout = 20_000): SpawnSyncReturns<string> {
  return spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8', timeout,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes -o ConnectTimeout=10',
    },
  });
}

/** The first line of a failed command, for a FAIL detail. */
function firstLine(out: string | null | undefined): string {
  return (out ?? '').split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 160) ?? '';
}

/**
 * One query against the desk's Postgres, as `psql -XAtqw`: no psqlrc, bare
 * rows, never a password prompt.
 *
 * Always through the `postgres` maintenance database, never the baseline. A
 * connection to the baseline is exactly what makes Postgres refuse to copy it,
 * so a doctor that checked the baseline by connecting to it would cause the
 * failure it exists to warn about.
 */
function psql(pg: LocalTestsConfig['pg'], sql: string): { ok: boolean; out: string; error: string } {
  const res = spawnSync('psql', [
    '-h', pg.host, '-p', String(pg.port), ...(pg.user ? ['-U', pg.user] : []),
    '-d', 'postgres', '-XAtqw', '-c', sql,
  ], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, PGCONNECT_TIMEOUT: '5' } });
  if (res.error) {
    const missing = (res.error as NodeJS.ErrnoException).code === 'ENOENT';
    return { ok: false, out: '', error: missing ? 'psql is not on PATH (brew install libpq)' : res.error.message };
  }
  return { ok: res.status === 0, out: (res.stdout ?? '').trim(), error: firstLine(res.stderr) };
}

/**
 * Does `installed` satisfy package.json's `wanted`? Exact pins, `^` and `~` —
 * the forms a lockfile-pinned repo writes. Anything else answers null and is
 * reported as not compared rather than guessed at.
 */
function satisfies(installed: string, wanted: string): boolean | null {
  const parse = (v: string): [number, number, number] | null => {
    const m = v.trim().replace(/^[=v]+/, '').match(/^(\d+)\.(\d+)\.(\d+)$/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const range = wanted.trim();
  const op = range.startsWith('^') || range.startsWith('~') ? range.slice(0, 1) : '';
  const have = parse(installed);
  const want = parse(range.slice(op.length));
  if (!have || !want) return null;
  const [hMaj, hMin, hPatch] = have;
  const [wMaj, wMin, wPatch] = want;
  const cmp = hMaj - wMaj || hMin - wMin || hPatch - wPatch;
  if (!op) return cmp === 0;
  if (cmp < 0) return false;
  if (op === '~') return hMaj === wMaj && hMin === wMin;
  return wMaj === 0 ? hMaj === 0 && hMin === wMin : hMaj === wMaj;
}

/** Where Cypress keeps its binaries: CYPRESS_CACHE_FOLDER, else the platform default. */
function cypressCaches(): string[] {
  return [
    process.env.CYPRESS_CACHE_FOLDER ?? '',
    join(homedir(), 'Library', 'Caches', 'Cypress'),
    join(homedir(), '.cache', 'Cypress'),
  ].filter(Boolean);
}

/** Every file under `dir` with one of `exts`, skipping dependencies and run output. */
function sourceFiles(dir: string, exts: RegExp, out: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!['node_modules', 'downloads', 'screenshots', 'videos', 'results'].includes(e.name)) {
        sourceFiles(join(dir, e.name), exts, out);
      }
    } else if (exts.test(e.name)) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

/** The keys of a JSON object, or null for anything that is not one. Values are never returned. */
function jsonKeys(text: string): string[] | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : null;
  } catch {
    return null;
  }
}

/** An account the specs log in as, by name: `loginWith('HR_CREDENTIALS')`, `Cypress.env('HR_TOKEN')`. */
const CREDENTIAL_NAME = /['"`]([A-Z][A-Z0-9_]*_(?:CREDENTIALS|TOKEN))['"`]/g;

/**
 * The credentials file, by key NAME. Nothing here prints, logs or compares a
 * value: what drifts is which accounts the file covers, and a missing key is a
 * spec that fails at its login, which reads on the ticket like a regression.
 *
 * The committed cypress.env.json is the baseline, not the requirement. Each
 * run writes the committed copy with the credentials file merged over it into
 * a mode-600 cypress.env.json in its throwaway worktree
 * (state/runs/<iid>/wsa-run), before the app build, and removes it with that
 * worktree at cleanup — and what workstream-automation commits is
 * configuration (tags, emails, endpoints), with the accounts left out on
 * purpose. So what the file has to supply is every account the specs log in
 * as that the committed copy does not carry. Other keys a spec reads
 * (`Cypress.env('tags')`) are not judged: several are set per run on the
 * command line, and a standing warning nobody can clear is one everybody
 * learns to skip.
 *
 * A file others can read is a WARN, not a FAIL: the run uses it all the same
 * (it only logs the same advice), so it stops nothing — but the test
 * accounts' passwords are then readable by every user on this machine.
 */
function checkLocalTestsCreds(lt: LocalTestsConfig): void {
  const file = lt.credsFile;
  if (!existsSync(file)) {
    fail('local tests credentials file missing',
      `${file} — create it with the keys of your ${join(lt.repo, 'cypress.env.json')}, chmod 600, ` +
      'or point ONESHOT_LOCAL_TESTS_CREDS at yours');
    return;
  }
  const mode = statSync(file).mode & 0o777;
  if (mode & 0o077) {
    warn('local tests credentials file is readable by group or others',
      `${file} is mode ${mode.toString(8)} — runs still use it, but anyone on this machine can read the ` +
      `test accounts' passwords; chmod 600 ${file}`);
  }
  const have = jsonKeys(readFileSync(file, 'utf8'));
  if (!have) {
    fail('local tests credentials file is not a JSON object', `${file} — same shape as cypress.env.json`);
    return;
  }

  // As committed at the ref every run checks out: the clone's own copy is
  // usually a person's, with their accounts added to it.
  const shown = gitIn(lt.repo, ['show', `${lt.automationRef}:cypress.env.json`]);
  const committed = new Set(shown.status === 0 ? jsonKeys(shown.stdout) ?? [] : []);
  const accounts = new Set<string>();
  for (const f of sourceFiles(join(lt.repo, 'cypress'), /\.(?:[cm]?[jt]sx?)$/)) {
    for (const [, name] of readFileSync(f, 'utf8').matchAll(CREDENTIAL_NAME)) if (name) accounts.add(name);
  }

  const held = new Set(have);
  const missing = [...accounts].filter((k) => !held.has(k) && !committed.has(k)).sort();
  if (missing.length) {
    fail(`local tests credentials file lacks ${missing.length} account(s) the specs log in as`,
      `${missing.join(', ')} — add them to ${file}`);
  } else {
    pass('local tests credentials', `${file}, ${have.length} keys — has every one of the ${accounts.size} ` +
      'accounts the specs log in as (checked by name only)');
  }
}

/**
 * Has someone added accounts to the clone's own cypress.env.json?
 *
 * Runs never read that copy — each one checks out the committed file at
 * automationRef and merges the credentials file over it — so local changes
 * there buy nothing. What they cost: the passwords then sit in a tracked file,
 * where `git diff`, `git stash show -p` or a `git status` followed by a diff in
 * that clone prints them. Asked with `git status --porcelain`, which names the
 * path and never shows a line of its content, and with --no-optional-locks so
 * not even the index is rewritten.
 */
function checkCloneEnvFile(lt: LocalTestsConfig): void {
  const st = gitIn(lt.repo,
    ['--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=no', '--', 'cypress.env.json']);
  if (st.status !== 0) {
    warn('automation clone cypress.env.json not checked', firstLine(st.stderr) || 'git status failed');
    return;
  }
  if (!st.stdout.trim()) {
    pass('automation clone cypress.env.json', 'same as HEAD');
    return;
  }
  warn('automation clone cypress.env.json differs from HEAD',
    `${join(lt.repo, 'cypress.env.json')} has local changes — runs never read it (they use the committed copy plus ` +
    `${lt.credsFile}), but a git diff in the clone prints whatever was added, often real passwords. ` +
    `Move any accounts you added into ${lt.credsFile}, then git -C ${lt.repo} checkout -- cypress.env.json`);
}

/** The installed Cypress package against package.json, and its binary in the cache. */
function checkCypress(repo: string): void {
  let wanted = '';
  try {
    const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as
      { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    wanted = pkg.devDependencies?.cypress ?? pkg.dependencies?.cypress ?? '';
  } catch { /* reported below */ }
  if (!wanted) {
    fail('Cypress version unknown', `${join(repo, 'package.json')} does not declare cypress`);
    return;
  }

  let installed = '';
  try {
    installed = (JSON.parse(readFileSync(join(repo, 'node_modules', 'cypress', 'package.json'), 'utf8')) as
      { version?: string }).version ?? '';
  } catch { /* reported below */ }
  if (!installed) {
    fail('Cypress is not installed in the automation clone', `package.json wants ${wanted} — run npm ci in ${repo}`);
    return;
  }
  const ok = satisfies(installed, wanted);
  if (ok === false) {
    fail('Cypress in node_modules does not match package.json',
      `installed ${installed}, package.json wants ${wanted} — run npm ci in ${repo}`);
    return;
  }

  // The npm package is a launcher; the browser runner is a separate download
  // per version, and a missing one fails the run before any spec.
  const cache = cypressCaches().find((c) => existsSync(join(c, installed)));
  if (cache) {
    pass('Cypress', `${installed}${ok === null ? ` (package.json says ${wanted}, not compared)` : ''}, ` +
      `binary in ${join(cache, installed)}`);
  } else {
    fail(`Cypress ${installed} binary is not installed`,
      `not under ${cypressCaches().join(' or ')} — run npx cypress install in ${repo}`);
  }
}

/**
 * Is this desk set up for the local automation tests mode (src/localtests)?
 *
 * Read-only, every line of it: nothing here fetches, installs, connects to the
 * baseline or creates a database. What is true only at this instant — sessions
 * on the baseline, leftover copies and worktrees, node_modules behind the base
 * branch — is preflight's.
 */
function checkLocalTests(lt: LocalTestsConfig): void {
  section('Local tests');
  if (!lt.enabled) {
    // Off is the ordinary answer on a desk that never set the clone. A desk
    // that did and is still off has a policy field to fix, and should hear so.
    if (lt.repo) warn('local tests: off', lt.off ?? '');
    else pass('local tests: off', lt.off ?? '');
    return;
  }

  // The mode runs after the merge, on these three labels (whether they exist
  // on the project is checked with every other label, under GitLab).
  pass('local tests labels', `"${lt.labels.trigger}" starts a run once the ticket's MR is merged, `
    + `"${lt.labels.running}" while QA's approved list runs, "${lt.labels.done}" when it finishes`);

  // The clone every run cuts its throwaway worktree from.
  const repo = lt.repo;
  if (!existsSync(repo)) {
    fail('automation clone missing', `${repo} — clone workstream-automation there, or fix ONESHOT_LOCAL_TESTS_REPO`);
  } else if (gitIn(repo, ['rev-parse', '--is-inside-work-tree']).stdout.trim() !== 'true') {
    fail('automation clone is not a git checkout', `${repo} — ONESHOT_LOCAL_TESTS_REPO must name a clone`);
  } else {
    const origin = gitIn(repo, ['remote', 'get-url', 'origin']);
    if (origin.status !== 0) {
      fail('automation clone has no origin', `${repo} — ${lt.automationRef} is fetched from it`);
    } else {
      const remote = gitIn(repo, ['ls-remote', '--exit-code', 'origin', 'HEAD'], 30_000);
      if (remote.status === 0) pass('automation clone', `${repo}, origin reachable`);
      else warn('automation origin unreachable', `${firstLine(remote.stderr) || 'no answer'} — VPN? runs use the last fetch`);
    }
    const ref = gitIn(repo, ['rev-parse', '--verify', '--quiet', `${lt.automationRef}^{commit}`]);
    if (ref.status === 0) pass('automation ref', `${lt.automationRef} at ${ref.stdout.trim().slice(0, 10)}`);
    else fail('automation ref does not resolve', `${lt.automationRef} in ${repo} — git -C ${repo} fetch origin`);

    checkLocalTestsCreds(lt);
    checkCloneEnvFile(lt);
    checkCypress(repo);
  }

  // The node the run step spawns is the one on PATH, not the one running this.
  const node = spawnSync('node', ['--version'], { encoding: 'utf8' });
  const major = Number((node.stdout ?? '').trim().replace(/^v/, '').split('.')[0]);
  if (major === 22) pass('node on PATH', (node.stdout ?? '').trim());
  else if (major > 22) warn('node on PATH is not 22', `${(node.stdout ?? '').trim()} — the step was proven on Node 22`);
  else fail('node on PATH is not 22', `${(node.stdout ?? '').trim() || 'none'} — put Node 22 first on PATH (nvm use 22)`);

  // Postgres: reachable, the baseline there, and a role that may copy it.
  const where = `${lt.pg.user ? `${lt.pg.user}@` : ''}${lt.pg.host}:${lt.pg.port}`;
  const up = psql(lt.pg, 'SELECT 1');
  if (!up.ok) {
    fail('Postgres not reachable with psql', `${where} — ${up.error || 'no answer'}`);
    return;
  }
  pass('Postgres reachable', where);
  // baselineDb is a checked lower-case identifier (localTestsConfig), so it is safe as a literal.
  const base = psql(lt.pg, `SELECT 1 FROM pg_database WHERE datname = '${lt.baselineDb}'`);
  if (base.out === '1') pass('baseline database', lt.baselineDb);
  else fail('baseline database missing', `${lt.baselineDb} on ${where} — restore the automation dump into it (docs/LOCAL-TESTS.md)`);
  const role = psql(lt.pg, 'SELECT rolcreatedb OR rolsuper FROM pg_roles WHERE rolname = current_user');
  if (role.out !== 't') {
    fail('Postgres role cannot create databases', `${where} — every run copies ${lt.baselineDb} with CREATE DATABASE`);
  }
}

async function main(): Promise<void> {
  console.log('\nOneshot doctor');

  // ------------------------------------------------------------------ auth
  section('Claude auth');
  const auth = auditAuth();
  if (auth.clean) {
    pass('no metered-billing credential in the environment', auth.credential);
  } else {
    for (const p of auth.problems) fail('auth', p);
  }
  for (const n of auth.notes) warn('auth', n);
  const claude = spawnSync('which', ['claude'], { encoding: 'utf8' });
  if (claude.status === 0) pass('claude CLI on PATH', claude.stdout.trim());
  else warn('claude CLI not on PATH', 'the Agent SDK spawns it — sessions will fail');

  // --------------------------------------------------------------- config
  section('Config');
  // Which project, first: every check below is about it. GITLAB_REPO_URL is the
  // only thing that says; any legacy selector still in .env is judged against it.
  // ONESHOT_SKIP_REPO_CHECK turns every repo-check FAIL below into a WARN;
  // said on every run, so the override cannot quietly outlive the problem.
  const override = repoCheckOverrideNotice();
  if (override) warn('repo checks overridden', override);
  for (const f of relaxRepoChecks(identityFindings())) report(f);
  const repo = repoIdentity().repo;
  const cfg = projectConfig();
  // Read once, so the label list below and the Local tests section judge the same answer.
  const localTests = localTestsConfig();
  pass('labels', `"${cfg.labels.entry}" -> "${cfg.labels.exit}", blocked "${cfg.labels.blocked}", ` +
    (cfg.labels.review
      ? `optional review gate "${cfg.labels.review}" (off unless a ticket carries it too)`
      : 'review label: off (labels.review empty)'));
  if (cfg.labels.testcaseReview) {
    pass('board label', `"${cfg.labels.testcaseReview}" — on while a ticket sits at the testcases QA gate`);
  }
  if (bugReproductionEnabled()) {
    if (cfg.labels.notABug) {
      pass('bug reproduction', `on — a bug research cannot reproduce parks for QA, and stops as "${cfg.labels.notABug}" once they approve ` +
        '(the label must exist on the project)');
    } else {
      warn('bug reproduction without a label',
        'labels.notABug is unset — a run that cannot reproduce its bug still stops and says so, but the ticket gets no label');
    }
  } else {
    pass('bug reproduction', 'off (bugReproduction: false)');
  }

  // Only ONE run may hold the promotion window at a time, enforced by the
  // in-process mutex rather than by pinning the whole pipeline to a single
  // ticket. A sane upper bound is the port pool — every server-holding phase
  // needs its own port.
  if (cfg.concurrency < 1 || cfg.concurrency > portPool().length) {
    fail('concurrency out of range',
      `must be 1..${portPool().length} (the port pool); the promotion mutex, not this number, ` +
      'keeps concurrent merges off each other');
  } else {
    pass('concurrency', `${cfg.concurrency} — merges serialized by the promotion mutex, ` +
      `capped at the ${portPool().length}-port pool`);
  }

  const ph = phases();
  const codePhases = ph.filter((p) => p.kind === 'code').map((p) => p.name);
  pass(`${ph.length} phases`, `deterministic: ${codePhases.join(', ')}`);
  for (const o of phasesOutsideTarget()) {
    pass(`phase ${o.name} left out for this project`,
      `targets: ${o.targets.join(', ') || '(none)'}; this project is '${PROJECT_TARGET || '(unset)'}'`);
  }
  const missingTier = ph.filter((p) => p.kind === 'session' && !p.tier);
  if (missingTier.length) fail('phases without a tier', missingTier.map((p) => p.name).join(', '));

  const b = budgetConfig();
  const phaseSum = Object.values(b.phases).reduce((a, n) => a + n, 0);
  if (phaseSum > b.ticket_tokens) {
    warn('phase ceilings exceed the per-ticket ceiling',
      `${phaseSum} > ${b.ticket_tokens} — the ticket cap binds first`);
  } else {
    pass('budgets', `${(b.ticket_tokens / 1e6).toFixed(1)}M weighted/ticket, ${(b.window_tokens / 1e6).toFixed(0)}M/window`);
  }

  // ---------------------------------------------------------------- paths
  section('Paths');
  // Each path says which variable put it there. A plain WORK_REPO beats the
  // default derived from GITLAB_REPO_URL, and the scoped ONESHOT_<NAME>_<VAR>
  // beats both, so a surprising directory below is only fixable if the line
  // that chose it is named. The env var is printed with a failure for the same
  // reason: SKILLS_ROOT is moved by ONESHOT_SKILLS_ROOT, not by its own name.
  const sources = pathSources();
  const origin = (name: keyof typeof sources): string => {
    const src = sources[name];
    if (src.source === 'scoped') return `from ${src.key} — the per-project spelling, still honoured`;
    if (src.source === 'plain') return `from ${src.key}`;
    return 'default derived from GITLAB_REPO_URL';
  };
  for (const [label, p, required, envVar, from] of [
    ['WORK_REPO', WORK_REPO, true, 'WORK_REPO', origin('WORK_REPO')],
    ['CONTEXT_REPO', CONTEXT_REPO, false, 'CONTEXT_REPO', ''],
    ['SKILLS_ROOT', SKILLS_ROOT, false, 'ONESHOT_SKILLS_ROOT', ''],
  ] as Array<[string, string, boolean, string, string]>) {
    if (!p) fail(label, `no path — set GITLAB_REPO_URL (default ~/Documents/<name>) or ${envVar}`);
    else if (existsSync(p)) pass(label, from ? `${p} (${from})` : p);
    else if (required) fail(label, `${p} does not exist — clone the project there, or set ${envVar}`);
    else warn(label, `${p} does not exist — set ${envVar}`);
  }

  if (existsSync(SKILLS_ROOT)) {
    const skillsDir = join(SKILLS_ROOT, 'skills');
    if (existsSync(skillsDir)) {
      const n = spawnSync('sh', ['-c', `ls -1 "${skillsDir}" | wc -l`], { encoding: 'utf8' });
      pass('skills discovered', `${n.stdout.trim()} in ${skillsDir}`);
    } else warn('no skills/ under SKILLS_ROOT', skillsDir);
  }

  if (!WT_ROOT) fail('WT_ROOT', 'no path — set GITLAB_REPO_URL (default ~/Documents/<name>-wt) or WT_ROOT');
  else if (existsSync(WT_ROOT)) {
    if (statSync(WT_ROOT).isDirectory()) pass('WT_ROOT', `${WT_ROOT} (${origin('WT_ROOT')})`);
  } else warn('WT_ROOT will be created on first run', `${WT_ROOT} (${origin('WT_ROOT')})`);
  // A plain WT_ROOT beats the derived default, so a line left over from another
  // project wins and nothing else would notice. Judged only against a project:
  // with GITLAB_REPO_URL unusable (Config says so) there is none to compare with.
  const shared = repo ? wtRootFinding(WT_ROOT, sources.WT_ROOT, PROJECT_TARGET) : null;
  if (shared) for (const f of relaxRepoChecks([shared])) report(f);

  // The seed repo is read when a worktree is leased, not at boot, so an absent
  // one is silent until phase 3 and only *hurts* at phase 6, where `verify`
  // needs a runnable app. That is exactly the "confusing failure three phases
  // in" this script exists to pull forward.
  const seed = seedFrom();
  if (!seed) {
    warn('no seed repo configured', 'set ONESHOT_SEED_FROM — without it a leased worktree has '
      + 'no node_modules/venv, so `verify` cannot run the app');
  } else if (!existsSync(seed)) {
    warn('seed repo does not exist', `${seed} — set ONESHOT_SEED_FROM to a repo that is `
      + 'already installed (node_modules, venv)');
  } else {
    const links = envOr('ONESHOT_SEED_LINKS', '').split(',').map((s) => s.trim()).filter(Boolean);
    const copies = envOr('ONESHOT_SEED_COPIES', '').split(',').map((s) => s.trim()).filter(Boolean);
    const missing = [...links, ...copies].filter((rel) => !existsSync(join(seed, rel)));
    if (missing.length) warn('seed entries missing from the seed repo', missing.join(', '));
    else pass('seed repo', `${seed} (${links.length} linked, ${copies.length} copied; ${origin('ONESHOT_SEED_FROM')})`);
  }

  // A clone of some other project would cut every worktree from the wrong code
  // while tickets and MRs went to the right one — and the seed is not only
  // borrowed from: scripts/app.cjs fetches MR refs in it and cuts app worktrees
  // from it. A different project path fails and the same path on another host
  // only warns, so an ssh origin matches an https URL and erp never matches
  // erp-archive. The same call boot and preflight make.
  if (repo) {
    for (const f of relaxRepoChecks(checkoutFindings({ workRepo: WORK_REPO, seed, sources }))) report(f);
    // Journals are keyed by iid alone, so another project's are never resumed;
    // they are still worth knowing about.
    const foreignRuns = foreignJournalFinding();
    if (foreignRuns) report(foreignRuns);
  } else {
    warn('checkouts not checked', 'there is no project to compare WORK_REPO, the seed, WT_ROOT or the run '
      + 'journals with until GITLAB_REPO_URL is fixed (see Config)');
  }

  const ports = portPool();
  if (ports.length) pass('port pool', ports.join(', '));
  else fail('port pool is empty', 'phases needing a dev server cannot run');

  // --------------------------------------------------------------- gitlab
  section('GitLab');
  if (!envOr('GITLAB_TOKEN')) {
    fail('GITLAB_TOKEN unset', 'cp .env.example .env and fill it in');
  } else if (!repo) {
    warn('GitLab not checked', 'there is no project to ask about until GITLAB_REPO_URL is fixed (see Config)');
  } else {
    const p = await ping();
    if (p.ok) {
      pass('reachable + authenticated', `${repo.project}, project id ${p.data?.id}`);

      // Who is this desk? The token answers, and the token also does the work,
      // so there is no second fact that can disagree with it.
      const idc = await checkIdentity();
      if (!idc.token) {
        fail('this desk has no usable GitLab token', 'every ASSIGNED ticket is skipped — run `npm run token:set`');
      } else if (idc.token.source.shared && idc.claudeUsername !== idc.token.username && !idc.token.bot) {
        fail(`acting as ${idc.token.username}, but this desk is signed in as ${idc.claudeUsername ?? 'nobody'}`,
          'that is somebody else\'s credential doing your work — run `npm run token:set`');
      } else if (idc.token.source.shared) {
        pass('acts as itself', `${idc.token.username}, token from .env`);
        warn('token lives in .env', '.env has leaked into a run transcript before — `npm run token:set` moves it outside the repo');
      } else if (idc.token.bot) {
        pass('acts as a bot', `${idc.token.username} — cannot be mistaken for a reviewer`);
      } else {
        pass('acts as itself', `${idc.token.username}, token from ${idc.token.source.source}`);
      }
      if (idc.warning && !idc.token?.source.shared) warn('identity', idc.warning.split('\n')[0] ?? '');
      // Each branch is fetched by name. Listing them returns one page of 100,
      // and a project with more branches than that hides `dev` off the page.
      const wanted = [...new Set([cfg.branches.base, ...cfg.branches.protected])];
      const branch = new Map(await Promise.all(wanted.map(async (n) => [n, await getBranch(n)] as const)));
      const base = branch.get(cfg.branches.base);
      if (base?.ok && base.data) pass('base branch exists', cfg.branches.base);
      else if (base?.status === 404) fail('base branch missing', cfg.branches.base);
      else warn('base branch not checked', base?.error ?? `HTTP ${base?.status ?? '?'}`);

      for (const prot of cfg.branches.protected) {
        const found = branch.get(prot);
        if (found?.status === 404) { warn(`protected branch '${prot}' not found`, 'listed in config but absent'); continue; }
        if (!found?.ok || !found.data) { warn(`protected branch '${prot}' not checked`, found?.error ?? `HTTP ${found?.status ?? '?'}`); continue; }
        if (!found.data.protected) fail(`'${prot}' is NOT protected on GitLab`, 'server-side protection is the real guarantee');
        else pass(`'${prot}' protected`);
      }

      // Every label this harness acts on, checked against the ones that exist.
      //
      // Each of these is matched by NAME and nothing raises when a name does
      // not match: a swap writes a label the board never shows, and a
      // `labelSkills` pair quietly stops routing, so the phase runs without
      // the method it was configured to have. An absent label on a TICKET is
      // an answer; a configured label absent from the PROJECT is a typo that
      // no run will ever report.
      const lb = await listLabels();
      if (!lb.ok || !lb.data) {
        warn('labels not verified', `could not list project labels (${lb.kind} HTTP ${lb.status})`);
      } else {
        const defined = new Set(lb.data.map((l) => l.name));
        const needed = requiredLabels(cfg.labels, phases(), bugReproductionEnabled(), localTests.enabled);
        const absent = needed.filter((l) => !defined.has(l.name));
        if (!absent.length) pass('every configured label exists on the project', `${needed.length} checked`);
        for (const { name, why } of absent) {
          fail(`label '${name}' does not exist on the project`, `${why} — it will never match, and nothing will say so`);
        }
      }
    } else if (p.kind === 'auth') {
      fail('GitLab refused the token', `HTTP ${p.status} — needs scope 'api'`);
    } else if (p.kind === 'network') {
      fail('GitLab unreachable', 'VPN down? that subnet is FortiClient-gated');
    } else {
      fail('GitLab error', `${p.kind} HTTP ${p.status}`);
    }
  }

  // ---------------------------------------------------------------- hooks
  section('Guardrails');
  // Guards are passed to the SDK in-process (src/conductor/hooks.ts), so there
  // is nothing to install and nothing in settings.json to check. What matters
  // is that the .cjs files exist and still enforce what they claim to.
  const guards = ['pause-check', 'write-scope', 'git-guard', 'budget-gate', 'log-event', '_common'];
  const missing = guards.filter((g) => !existsSync(join(process.cwd(), 'hooks', `${g}.cjs`)));
  missing.length
    ? fail('guard scripts missing', missing.join(', '))
    : pass(`${guards.length} guard scripts present`, 'loaded in-process, no install step');

  const verify = spawnSync('bash', ['scripts/verify-hooks.sh'], { encoding: 'utf8' });
  if (verify.status === 0) {
    const last = verify.stdout.trim().split('\n').pop() ?? '';
    pass('guard test suite', last.replace(/\x1b\[[0-9;]*m/g, ''));
  } else {
    fail('guard test suite failed',
      'run: npm run hooks:verify — note an absent SKILLS_ROOT fails its symlink test on its '
      + 'own, so this and the path check above are usually one cause, not two');
  }

  // ------------------------------------------------------------ telemetry
  section('Session tracking (Langfuse)');
  const otel = otelStatus();
  if (!otel.on) {
    warn('telemetry OFF', otel.why);
  } else {
    if (otel.remote) warn('telemetry ON, endpoint is remote', otel.why);
    else pass('telemetry ON', otel.why);

    if (otel.why.includes('+responses')) {
      pass('assistant responses saved', '~0.5-1.5 MB/ticket — output only, never replayed');
    }
    if (promptTextExported()) {
      fail('prompt TEXT export is enabled',
        'prompts replay the whole conversation every turn: ~30-60 MB/ticket, and a full ' +
        'unredacted copy of every ticket body and diff. Set logUserPrompts:false.');
    }
  }

  // ---------------------------------------------------------------- slack
  section('Slack');
  if (!envOr('SLACK_BOT_TOKEN')) warn('SLACK_BOT_TOKEN unset', 'status stays on the console');
  else pass('bot token present');
  if (!slackConfig().channel) warn('no channel configured', 'set ONESHOT_CHANNEL or config/slack.json');
  else pass('channel', slackConfig().channel);
  if (!slackConfig().allowlist.length) warn('command allowlist is empty', 'every Slack command will be refused');
  // Only where the gates could actually run: an install with no Slack, or no
  // Review label configured, cannot hit this and does not need a standing
  // warning telling it so on every doctor run.
  //
  // There is deliberately NO check here for channels:history/groups:history.
  // An earlier version of the gates read their verdict out of the ticket's
  // Slack thread and this block FAILED without that scope; they read GitLab
  // now (src/conductor/reviewgate.ts), so the scope is dead and demanding it
  // sent people to the Slack console to fix a non-problem. See
  // config/slack.json's _comment_history.
  const allRuns = cfg.reviewAllRuns === true;
  if (slackEnabled() && (cfg.labels.review || allRuns)) {
    // The gates @mention the owning group when they arm. Resolve every name
    // for real rather than checking that config looks plausible: an
    // unresolvable reviewer fails silently — the ask posts unaddressed and
    // they never learn they are being waited on.
    const { dev, qa, design, emailDomain, slackIds } = reviewersConfig();
    const names = [...new Set([...dev, ...qa, ...design])];
    if (names.length) {
      // A pinned id is trusted at runtime without a lookup, so this is the
      // only place it is ever checked. Verify it against the live workspace
      // rather than merely that it is present: a stale or mistyped id does
      // not fail loudly, it @mentions somebody else, and the run still waits
      // on a person who was never asked.
      const wrong: string[] = [];
      for (const [u, id] of Object.entries(slackIds)) {
        const live = await userIdForHandle(u);
        if (live && live !== id) wrong.push(`${u} pinned ${id} but @${u} is ${live}`);
      }
      if (wrong.length) {
        fail('a pinned Slack id does not match that person',
          `${wrong.join('; ')} — config/reviewers.json would @mention the wrong person`);
      } else if (Object.keys(slackIds).length) {
        pass('pinned Slack ids agree with the workspace', `${Object.keys(slackIds).length} checked`);
      }

      const resolved = await Promise.all(names.map(async (u) => {
        if (slackIds[u]) return [u, 'pinned'] as const;
        if (await userIdForHandle(u)) return [u, 'handle'] as const;
        if (emailDomain && await userIdForEmail(`${u}@${emailDomain}`)) return [u, 'email'] as const;
        return [u, null] as const;
      }));
      const missing = resolved.filter(([, via]) => !via).map(([u]) => u);
      const viaPinned = resolved.filter(([, via]) => via === 'pinned').length;
      if (!missing.length) {
        pass('reviewer Slack mentions', `${names.length} resolved (${viaPinned} pinned)`);
      } else if (missing.length === names.length) {
        warn('no reviewer resolves to a Slack id',
          'the bot token needs users:read (handle lookup) or users:read.email. Approval '
          + 'requests still post to the channel, unaddressed.');
      } else {
        warn(`reviewers not reachable on Slack: ${missing.join(', ')}`,
          'no workspace account whose handle matches the GitLab username'
          + (emailDomain ? `, and no <name>@${emailDomain}` : '')
          + ' — they will not be @mentioned when a gate waits on them');
      }
    }
  }

  checkLocalTests(localTests);

  // -------------------------------------------------------------- verdict
  console.log(`\n${fails ? R : G}${fails} failed${X}, ${Y}${warns} warnings${X}\n`);
  process.exit(fails ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n${R}doctor crashed${X}: ${(err as Error).message}\n`);
  process.exit(1);
});

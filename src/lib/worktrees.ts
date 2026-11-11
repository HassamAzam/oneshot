/**
 * Per-ticket git worktrees, and the three things that make one actually usable.
 *
 * 1. SEED. A fresh worktree has none of the gitignored pieces a checkout needs
 *    to RUN — venv, node_modules, local_settings.py. A phase that cannot run
 *    the app writes code it cannot verify, so those are borrowed from an
 *    already-working repo: heavy read-mostly things symlinked, settings copied
 *    (so a worktree editing its settings does not edit the seed repo's).
 *
 * 2. SKILLS. `.claude/` is composed by ensureClaudeDir() so phases get the
 *    context repo's real, current skills with no vendoring and no sync step,
 *    plus the pipeline skills that live in the Oneshot repo. Note what the
 *    symlinks inside it imply: writes through one land in the context repo,
 *    which is exactly why hooks/write-scope.cjs realpath-resolves before
 *    comparing.
 *
 * 3. EXCLUDE. Those symlinks are untracked files in a real checkout, so they
 *    are written to .git/info/exclude — otherwise every `git status` a phase
 *    runs is noisy and `git add -A` would try to commit them.
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureClaudeDir } from './claudedir.js';
import {
  CONTEXT_REPO, ROOT, WORK_REPO, WT_ROOT, envOr, expandPath, portPool, projectConfig, seedFrom,
} from './config.js';
import { db } from './db.js';
import { retryRefLockRace } from './gitfetch.js';
import { TEST_SETTINGS_FILE, TEST_SETTINGS_MODULE } from './testsettings.js';
import { log } from './log.js';
import { pidsOnPort, portsListening } from './procprobe.cjs';
import {
  RunDbError, dropRunDb, perRunDbMode, pgClient, pgTarget, rewriteRunSettings, runDbName, runFromWorktree,
  sweepRunDbs, type PgTarget,
} from './rundb.cjs';

function git(args: string[], cwd = WORK_REPO): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', timeout: 120_000,
    // Hygiene, not a load-bearing fix: whatever reads this stderr should read
    // it in one language. "cannot lock ref", the message gitfetch.ts matches
    // on, is NOT translated by git's files backend — run under
    // LC_ALL=fr_FR.UTF-8 it comes back byte-identical English — so nothing
    // today depends on this. It starts mattering the day a conductor runs on a
    // Linux box with the message catalogs installed, or the day these refs move
    // to the reftable backend, where that string IS in the translations.
    env: { ...process.env, LC_ALL: 'C' },
    // stderr is piped, not inherited: `rev-parse --verify` on a branch that
    // does not exist yet is an expected probe, and letting its `fatal:` reach
    // the console makes a normal worktree creation look like a failure.
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export interface Lease {
  worktree: string;
  branch: string;
  /** Present only when the caller asked for one — see leaseWorktree's options. */
  port?: number;
  baseSha: string;
}

/**
 * Reclaim what is dead and take the first port still free — as ONE statement's
 * worth of exclusivity.
 *
 * The reclaim is not housekeeping, it is the pool's only repair path. A lease is
 * released in teardown, so a conductor that died mid-run leaves a row owning a
 * port forever, and the pool is three entries wide. Ownership is decided by the
 * runs table, which boot-time reconciliation has already truthed: a lease whose
 * run is no longer claimed or running cannot be in use by anyone.
 *
 * IMMEDIATE, and not merely a transaction. Read-then-write is exactly the shape
 * SQLite refuses to arbitrate on a deferred handle — the second writer takes its
 * snapshot on the read, discovers the world moved under it on the write, and
 * fails instantly with SQLITE_BUSY_SNAPSHOT without ever consulting
 * busy_timeout. Taking the write lock up front turns that into a wait the loser
 * survives, which is what makes the answer below trustworthy: with two
 * conductors leasing at once, both used to see the same port free and one died
 * on the primary key while two ports sat unused.
 *
 * The body is deliberately tiny for the same reason it is exclusive.
 * better-sqlite3 is synchronous, so everything inside this transaction is time
 * the event loop is not running — no tick, no abort, no Slack card. Two
 * statements and a set membership test is the whole budget.
 */
const takeFreePort = db.transaction((runId: string, pool: number[], unavailable: Set<number>) => {
  const reaped = db.prepare(`DELETE FROM port_leases WHERE run_id NOT IN
    (SELECT run_id FROM runs WHERE status IN ('claimed','running'))`).run().changes;
  const taken = new Set(
    (db.prepare('SELECT port FROM port_leases').all() as Array<{ port: number }>).map((r) => r.port),
  );
  for (const port of pool) {
    if (taken.has(port) || unavailable.has(port)) continue;
    db.prepare('INSERT INTO port_leases (port, run_id, leased_at) VALUES (?, ?, ?)')
      .run(port, runId, Date.now());
    return { port, reaped };
  }
  return { port: null as number | null, reaped };
});

/**
 * PIDs listening on a TCP port — empty when it is free or its owner is invisible.
 *
 * src/lib/procprobe.cjs: lsof, else `ss -ltnp`. This used to swallow every spawn error
 * and answer [] — fail OPEN — so on a server without lsof every port read as free and a
 * run leased one something was already serving on. A probe that cannot run now throws
 * E_NO_PROBE, which leasePortFor() reports instead of handing out a port.
 */
function portListeners(port: number): number[] {
  return pidsOnPort(port);
}

/**
 * Kill whatever is listening on a run's leased port.
 *
 * Called from a run's terminal path: `releasePort` only drops the SQLite row,
 * so without this the dev server a phase started outlives the run, and the port
 * pool fills with orphans from crashed and blocked runs — which is how a later
 * verify came to drive a stale server and report on the wrong code. Best-effort
 * and never throws: a port with nothing on it is the normal case.
 *
 * Only the leased port is reaped, never the shared webpack port — a concurrent
 * run may be serving its own frontend there.
 */
export function reapPortServer(port: number | null | undefined): number {
  if (!port) return 0;
  let killed = 0;
  let pids: number[] = [];
  try { pids = portListeners(port); } catch (err) {
    log.warn(`could not see what listens on port ${port} — its server was not reaped`, { error: (err as Error).message });
  }
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); killed += 1; } catch { /* already gone */ }
  }
  if (killed) log.info(`reaped ${killed} process(es) on port ${port}`);
  return killed;
}

/**
 * Lease a port for this run, or say plainly that there is none.
 *
 * Ports are the real concurrency limit for phases that run a dev server. Leased
 * through SQLite rather than by probing, because a port that is free *right now*
 * can be taken by the next phase two seconds later.
 *
 * null rather than a throw when the pool is exhausted: an empty pool is a
 * capacity answer the caller can act on, and dressing it as an exception put it
 * in the same catch as a genuinely broken database.
 */
export function leasePortFor(runId: string, prefer?: number): number | null {
  db.exec(`CREATE TABLE IF NOT EXISTS port_leases (
    port INTEGER PRIMARY KEY, run_id TEXT NOT NULL, leased_at INTEGER NOT NULL)`);
  // A run asking twice is asking about the lease it has. Taking a second port
  // for it would spend one of a pool three or four wide on nothing.
  const held = portHeldBy(runId);
  if (held !== null) return held;
  // `prefer` is the port a resumed run's worktree was already brought up on.
  // First in line when it is still free; just another taken port when it is not.
  const configured = portPool();
  const pool = prefer !== undefined && configured.includes(prefer)
    ? [prefer, ...configured.filter((p) => p !== prefer)]
    : configured;
  // A port that is free in the lease table but has a process listening on it is
  // either an orphan from a run that never reaped or a foreign dev server
  // sharing these ports. Leasing it anyway is exactly how a verify phase ends up
  // driving somebody else's server and reporting on the wrong code. Probe here —
  // outside the SQLite transaction, which must stay synchronous and tiny — and
  // never hand out a port something is already answering on.
  const busy = portsListening([...pool, ...pool.map((p) => p + 1000)]);
  const occupied = new Set(pool.filter((p) => busy.has(p) || busy.has(p + 1000)));
  const { port, reaped } = takeFreePort.immediate(runId, pool, occupied);
  if (reaped) log.info(`reclaimed ${reaped} port lease(s) from finished runs`);
  if (occupied.size) {
    log.warn(`skipped occupied port(s) ${[...occupied].join(', ')} — a process is already listening there`);
  }
  return port;
}

/**
 * The port this run holds a lease on, or null.
 *
 * A journal remembers the port a run was given; the lease table says whether it
 * still has it. They part company the moment a run parks or stops: `finish()`
 * releases the lease and the journal keeps the number. Reading the journal alone
 * is how a parked run, re-entered every tick, reaped the dev server of whichever
 * run had leased that port since — and how a resumed run went on to use a port
 * it no longer owned.
 */
export function portHeldBy(runId: string): number | null {
  try {
    const row = db.prepare('SELECT port FROM port_leases WHERE run_id = ? ORDER BY leased_at DESC LIMIT 1')
      .get(runId) as { port: number } | undefined;
    return row ? row.port : null;
  } catch {
    return null; // the table does not exist yet, so nobody holds anything
  }
}

export function releasePort(runId: string): void {
  try {
    db.prepare('DELETE FROM port_leases WHERE run_id = ?').run(runId);
  } catch { /* table may not exist yet */ }
}

/**
 * Copy a seed file by CONTENT, never with copyfile(3).
 *
 * cpSync() and copyFileSync() both go through copyfile(3), which replicates the
 * source's extended attributes. On macOS that is not a metadata nicety, it is a
 * failure mode: a file carrying `com.apple.provenance` — the TCC attribute the
 * OS stamps on files a sandboxed app has touched — cannot have that attribute
 * reproduced by a process without the matching entitlement, and the whole copy
 * fails EPERM. Nothing about the file is unreadable; only the xattr is
 * privileged.
 *
 * It is not fixable from the outside. Stripping the attribute works for exactly
 * as long as it takes something to read the file again, at which point macOS
 * puts it straight back, so any "clean the source once" repair is a repair that
 * un-does itself.
 *
 * Observed as four runs blocked at `recall` with
 * `EPERM: operation not permitted, copyfile '<seed>/frontend/src/constants/config.js'`
 * while hrdb/local_settings.py — same source repo, same process, same instant —
 * copied cleanly, because that one carries com.apple.macl instead. A whole
 * conductor stopped claiming tickets over an xattr on one config file.
 *
 * read + write moves the bytes and lets the destination take whatever
 * attributes the OS wants to give a newly created file, which is all a seeded
 * config was ever supposed to have. The mode is carried across because
 * local_settings.py and config.js are read by the app, not executed, but a seed
 * list is free to grow a script one day.
 */
function copyContents(src: string, dst: string): void {
  writeFileSync(dst, readFileSync(src));
  try { chmodSync(dst, statSync(src).mode & 0o777); } catch { /* mode is a nicety, content is not */ }
}

/**
 * Everything a leased or resumed worktree needs before a phase runs in it.
 *
 * `.claude` is composed FIRST and unconditionally, ahead of the seed-repo
 * check. The two have nothing to do with each other: the seed repo supplies an
 * installed `node_modules` and a venv so the APP can be brought up, while
 * `.claude` supplies the skills, rules and agents every phase reasons with.
 * They were in one function with one early return, so a machine with no seed
 * repo configured ran every phase with whatever `.claude` the work repo
 * happened to commit — the failure this composition exists to prevent, reached
 * by way of an unrelated setting.
 */
export function seedWorktree(worktree: string): void {
  const excluded: string[] = [];
  detachTrackedClaude(worktree);
  excluded.push(...ensureClaudeDir(worktree));

  const from = seedFrom();
  if (!from || !existsSync(from)) {
    log.warn('no seed repo — the worktree cannot run the app without npm ci / venv setup', {
      fix: 'set ONESHOT_SEED_FROM to an already-installed clone',
    });
    excluded.push(...seedTestSettings(worktree), ...SCRATCH_DIRS);
    addExcludes(worktree, excluded);
    return;
  }

  const links = envOr('ONESHOT_SEED_LINKS', '').split(',').map((s) => s.trim()).filter(Boolean);
  const copies = envOr('ONESHOT_SEED_COPIES', '').split(',').map((s) => s.trim()).filter(Boolean);

  /**
   * A missing seed SOURCE is announced, not swallowed.
   *
   * This loop used to `continue` on both conditions together, so a seed entry whose
   * source did not exist produced no symlink and no message. That is exactly how
   * `staticfiles` was absent from every worktree for weeks: each fresh checkout then
   * 500'd on every {% static %} template and the bring-up died as E_DJANGO_DEAD, with
   * nothing anywhere naming the cause. An existing DESTINATION is still silent — that
   * one is the ordinary idempotent case.
   */
  for (const rel of [...links, ...copies]) {
    if (!existsSync(join(from, rel))) {
      log.warn(`seed source ${join(from, rel)} does not exist — ${rel} will be missing from ${worktree}`);
    }
  }

  for (const rel of links) {
    const src = join(from, rel);
    const dst = join(worktree, rel);
    if (!existsSync(src) || existsSync(dst)) continue;
    mkdirSync(dirname(dst), { recursive: true });
    symlinkSync(src, dst);
    excluded.push(rel);
  }

  for (const rel of copies) {
    const src = join(from, rel);
    const dst = join(worktree, rel);
    if (!existsSync(src) || existsSync(dst)) continue;
    mkdirSync(dirname(dst), { recursive: true });
    copyContents(src, dst);
    excluded.push(rel);
  }

  // After the copies: it is written only where hrdb/local_settings.py now exists.
  excluded.push(...seedTestSettings(worktree), ...SCRATCH_DIRS);
  addExcludes(worktree, excluded);
  pointAtRunDb(worktree, from);
}

/**
 * Directories a phase makes for itself inside the checkout, kept out of
 * `git status` like everything the seeding step puts there.
 *
 * `verify` is told to keep its server log, login helpers and Playwright drivers
 * under `.verify-scratch/` (src/phases/prompts.ts), and later laps reuse them.
 * Untracked and not ignored, the directory is one `git add -A` away from a
 * commit — and since the review loop pushes whatever its fixer committed, from
 * the merge request. On #9174 it also held the scratch settings files six
 * verify laps wrote, with a database login in them.
 */
const SCRATCH_DIRS = ['.verify-scratch/'];

// --------------------------------------------------------- Django test settings

export { TEST_SETTINGS_FILE, TEST_SETTINGS_MODULE };
const TEST_SETTINGS_TEMPLATE = join(ROOT, 'config', 'erp', 'test_settings.template.py');
const TEST_SETTINGS_MARK = '# ONESHOT-GENERATED hrdb/test_settings_oneshot.py';

/**
 * Give a checkout a Django test-settings module that can reach THIS machine's database.
 *
 * The app repo's own `hrdb/test_settings.py` hardcodes a `postgres` superuser on
 * localhost. A desk or server that provisions its own role has no such login, so
 * `manage.py test --settings=hrdb.test_settings` dies on "password authentication
 * failed for user postgres" before a single test runs. On #9174 that is what every
 * implement lap reported instead of a test result, what each of six verify laps
 * rediscovered and worked around with a scratch settings file of its own, and what
 * self-remediation finally handed back as needing a database admin.
 *
 * So the worktree gets `hrdb/test_settings_oneshot.py`: the repo's test settings with
 * the connection `hrdb/local_settings.py` already carries (see the template for why
 * NAME travels too). Written only into a checkout that has both files — one that is
 * not this app, or that was never given local settings, is left alone — and never
 * over a file somebody else put at that path. Returns the paths to keep out of
 * `git status`, which is the whole list or nothing.
 */
export function seedTestSettings(worktree: string): string[] {
  try {
    if (!existsSync(join(worktree, 'hrdb', 'test_settings.py'))
      || !existsSync(join(worktree, 'hrdb', 'local_settings.py'))
      || !existsSync(TEST_SETTINGS_TEMPLATE)) return [];
    const dst = join(worktree, TEST_SETTINGS_FILE);
    const want = readFileSync(TEST_SETTINGS_TEMPLATE, 'utf8');
    if (existsSync(dst)) {
      const have = readFileSync(dst, 'utf8');
      if (!have.startsWith(TEST_SETTINGS_MARK)) {
        log.warn(`${TEST_SETTINGS_FILE} in ${worktree} is not ours — left alone, so Django tests there use whatever it says`);
        return [];
      }
      if (have === want) return [TEST_SETTINGS_FILE];
    }
    writeFileSync(dst, want);
    return [TEST_SETTINGS_FILE];
  } catch (err) {
    log.warn('could not write the Django test settings — tests in this worktree fall back to hrdb.test_settings', {
      worktree, error: (err as Error).message,
    });
    return [];
  }
}

// ------------------------------------------------------------ per-run database

/** Where run databases live, from the seed's settings; null when there is no seed file. */
function runDbTarget(from = seedFrom()): PgTarget | null {
  const file = from ? join(from, 'hrdb', 'local_settings.py') : '';
  if (!file || !existsSync(file)) return null;
  return pgTarget(process.env, readFileSync(file, 'utf8'));
}

function runDbOn(pg: PgTarget): boolean {
  return perRunDbMode(process.env, () => pgClient(pg).exists(pg.baseline)).on;
}

/**
 * Point a RUN worktree's settings at its own database name the moment it is seeded.
 *
 * scripts/app.cjs creates the database (createdb -T <baseline>), adds the Redis DB for
 * the run's port and migrates it at the first bring-up. This earlier rewrite exists so
 * that nothing run in the worktree before then — a phase's manage.py, a Django shell —
 * can reach the seed's database: until the copy exists it fails loudly with "database
 * does not exist" instead of writing someone's data. Not a run worktree (a replay, the
 * app-<port> pool), or per-run databases off: nothing changes.
 */
function pointAtRunDb(worktree: string, from: string): void {
  const run = runFromWorktree(worktree);
  const file = join(worktree, 'hrdb', 'local_settings.py');
  if (!run || !existsSync(file)) return;
  try {
    const pg = runDbTarget(from);
    if (!pg || !runDbOn(pg)) return;
    const before = readFileSync(file, 'utf8');
    const managed = before.includes("DATABASE_NAME = 'oneshot_run_");
    const after = rewriteRunSettings(before, { name: runDbName(run.iid, run.runId), worktree });
    // A bring-up already added the Redis line; leave its file alone rather than drop it.
    if (!managed && after !== before) writeFileSync(file, after);
  } catch (err) {
    log.warn('could not point the worktree at its run database — app.cjs will retry at bring-up', {
      worktree, error: (err as Error).message,
    });
  }
}

/**
 * Drop a finished run's database. Best-effort and never throws: a database left behind
 * is what sweepRunDatabases() is for. Only a name derived from the run's own worktree
 * and run id, and rundb.cjs re-checks the oneshot_run_ prefix before the DROP.
 */
export function dropRunDatabase(worktree: string | undefined, runId: string, iid: number): void {
  if (!worktree || !runFromWorktree(worktree)) return;
  try {
    const pg = runDbTarget();
    if (!pg || !runDbOn(pg)) return;
    const name = runDbName(iid, runId);
    dropRunDb(pg, name);
    log.ok(`dropped run database ${name}`);
  } catch (err) {
    log.warn('could not drop the run database — `node scripts/app.cjs rundb sweep --drop` will', {
      error: (err as Error).message, code: err instanceof RunDbError ? err.code : undefined,
    });
  }
}

/**
 * Drop every oneshot_run_* database whose run is done, aborted or not in the runs table
 * at all. Blocked and parked runs keep theirs: both can be resumed.
 */
export function sweepRunDatabases(): { dropped: string[]; errors: string[] } {
  try {
    const pg = runDbTarget();
    if (!pg || !runDbOn(pg)) return { dropped: [], errors: [] };
    const q = db.prepare('SELECT status FROM runs WHERE iid = ? AND run_id LIKE ? ORDER BY started_at DESC LIMIT 1');
    const statusOf = (iid: number, shortId: string): string | null => {
      const row = q.get(iid, `%-${shortId}`) as { status: string } | undefined;
      return row ? row.status : null;
    };
    const r = sweepRunDbs(pg, statusOf, { drop: true });
    if (r.dropped.length) log.info(`dropped ${r.dropped.length} orphan run database(s): ${r.dropped.join(', ')}`);
    for (const e of r.errors) log.warn(`run database sweep: ${e}`);
    return { dropped: r.dropped, errors: r.errors };
  } catch (err) {
    log.warn('run database sweep did not run', { error: (err as Error).message });
    return { dropped: [], errors: [(err as Error).message] };
  }
}

/**
 * Clear the work repo's own `.claude` out of the worktree, without deleting it.
 *
 * The work repo COMMITS `.claude/`, so `git worktree add` lays down a real
 * directory for every skill, rule and agent before this process gets a say.
 * ensureClaudeDir() then declines to overwrite any of them — relink() treats a
 * real directory as something a human put there — so the copies this repo
 * maintains under SKILLS_ROOT only ever filled the four GAPS, and every name
 * the work repo also ships resolved the work repo's file. That is invisible
 * from outside: the phase invokes the skill, gets an older file, and reports
 * success. It bit `frontend-accessibility`, where the rule about an open dialog
 * hiding the app-wide live region exists only in this repo's copy, and it
 * silently un-did EXCLUDED_SKILLS too, because a real directory is not a
 * symlink and unlinkExcluded() only removes symlinks.
 *
 * `--skip-worktree` rather than a delete: the files stay in the index and in
 * HEAD, so nothing about the branch changes and no deletion can reach a commit
 * or an MR diff. Git simply stops comparing those paths against the working
 * tree, which is what makes removing them invisible to `git status` — the same
 * job .git/info/exclude does for the seeded symlinks, for tracked paths.
 *
 * The whole directory goes rather than the tracked files alone: an emptied
 * `.claude/skills/<name>/` is still a real directory, and relink() would back
 * off from it exactly as before. A lease is a fresh compose either way.
 */
export function detachTrackedClaude(worktree: string): void {
  try {
    const tracked = git(['ls-files', '-z', '--', '.claude'], worktree);
    if (!tracked) return;
    execFileSync('git', ['update-index', '--skip-worktree', '-z', '--stdin'], {
      cwd: worktree, input: tracked, timeout: 120_000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    rmSync(join(worktree, '.claude'), { recursive: true, force: true });
  } catch (err) {
    // A phase with the work repo's skills still runs; one with no worktree does
    // not. Warn and leave the checkout as git wrote it.
    log.warn('could not detach the work repo\'s .claude — its skills will shadow ours', {
      worktree, error: (err as Error).message,
    });
  }
}

/**
 * Keep seeded paths out of `git status`.
 *
 * .git/info/exclude rather than .gitignore: it is per-checkout and untracked,
 * so it cannot leak into a commit or an MR diff.
 */
function addExcludes(worktree: string, paths: string[]): void {
  if (!paths.length) return;
  try {
    // `--git-path info/exclude`, never `--git-dir` + join. In a LINKED worktree
    // those are different files: --git-dir is .git/worktrees/<name>/, while the
    // exclude git actually consults lives in the common dir. Oneshot wrote a
    // correct exclude file to the per-worktree path for months and git never
    // read a line of it, so every seeded symlink showed as untracked in the very
    // `git status` this function exists to keep quiet — and sat one `git add -A`
    // away from an MR. --git-path resolves whichever is right for the checkout.
    const resolved = git(['rev-parse', '--git-path', 'info/exclude'], worktree);
    const file = resolved.startsWith('/') ? resolved : join(worktree, resolved);
    mkdirSync(dirname(file), { recursive: true });
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const missing = paths.filter((p) => !existing.includes(`\n${p}\n`));
    if (!missing.length) return;
    writeFileSync(file, `${existing}\n# oneshot seeded\n${missing.join('\n')}\n`);
  } catch (err) {
    log.warn('could not write .git/info/exclude', { error: (err as Error).message });
  }
}

/**
 * Where this branch left the base — the diff base every later phase reads
 * against.
 *
 * merge-base rather than the tip of origin/<base>, and computed WITHOUT a
 * fetch. A run lives for hours and the base branch moves under it; taking the
 * tip means the review, the evidence pack and the MR each describe a different
 * diff from the one implement wrote, and a resumed run's diff silently grows to
 * include whatever landed on dev while it was down. The merge-base is fixed by
 * the branch's own history, so it answers the same thing at every phase and on
 * every resumption.
 */
function forkPoint(worktree: string, base: string): string {
  try {
    return git(['merge-base', 'HEAD', `origin/${base}`], worktree);
  } catch (err) {
    log.warn(`no merge-base with origin/${base} — diffing against HEAD`, {
      error: (err as Error).message,
    });
    return git(['rev-parse', 'HEAD'], worktree);
  }
}

/**
 * Give this worktree a committer identity WITHOUT touching the shared config.
 *
 * `git -C <worktree> config user.name` does not write a per-worktree setting —
 * it writes .git/config, the one file every worktree of the repo shares, and
 * concurrent worktree creations serialise on its lock and mostly lose. Two
 * escapes exist and the repository decides which:
 *
 *   extensions.worktreeConfig on  — `config --worktree` writes
 *                                   .git/worktrees/<name>/config, which nobody
 *                                   else has open, so it is safe and it is what
 *                                   the option is for.
 *   otherwise                     — no file is written at all. Identity reaches
 *                                   every commit through GIT_AUTHOR_* /
 *                                   GIT_COMMITTER_* in the phase environment
 *                                   (src/lib/config.ts, BASE_ENV), which git
 *                                   honours ahead of any config and which
 *                                   cannot contend with anything.
 *
 * Enabling the extension from here is deliberately not done: it is a repository
 * -wide change to a repo Oneshot only borrows.
 */
function pinIdentity(worktree: string): void {
  const perWorktree = (() => {
    try { return git(['config', '--bool', 'extensions.worktreeConfig'], worktree) === 'true'; } catch { return false; }
  })();
  if (!perWorktree) return;

  const author = envOr('ONESHOT_GIT_AUTHOR_NAME', 'Oneshot');
  const email = envOr('ONESHOT_GIT_AUTHOR_EMAIL');
  try {
    git(['config', '--worktree', 'user.name', author], worktree);
    if (email) git(['config', '--worktree', 'user.email', email], worktree);
  } catch (err) {
    log.warn('could not write the per-worktree identity — the environment carries it', {
      error: (err as Error).message,
    });
  }
}

/**
 * Create (or re-attach to) the worktree for a ticket.
 *
 * Idempotent: a run resumed after a crash finds its existing worktree and
 * branch and continues in them rather than starting over. The fetch happens
 * only on creation — re-attaching must not move origin/<base> under a run that
 * is already mid-flight.
 *
 * A port is leased only when `withPort` is set. Leasing one with the worktree
 * held a scarce, pool-limited resource from the first worktree phase through
 * every phase that has no use for it; the runner asks for one when it first
 * reaches a phase that actually serves the app.
 */
export function leaseWorktree(
  runId: string, branch: string, name: string, opts: { withPort?: boolean } = {},
): Lease {
  const cfg = projectConfig();
  const base = cfg.branches.base;
  mkdirSync(WT_ROOT, { recursive: true });
  const worktree = join(WT_ROOT, name);

  if (!existsSync(worktree)) {
    // Two runs starting together fetch the same base in the same shared repo;
    // the loser of the ref lock is retried rather than blocked — see gitfetch.ts.
    retryRefLockRace(() => git(['fetch', 'origin', base]));
    const branchExists = (() => {
      try { git(['rev-parse', '--verify', `refs/heads/${branch}`]); return true; } catch { return false; }
    })();
    if (branchExists) git(['worktree', 'add', worktree, branch]);
    // --no-track is not about upstreams, it is about the lock. Creating a
    // branch that tracks origin/<base> writes two keys into the SHARED
    // .git/config, and several worktrees being created at the same moment
    // contend for that one file: most of them fail with "could not lock config
    // file" AFTER the local branch has already been created, leaving an orphan
    // branch and no worktree. Nothing here ever pushes to the base or pulls
    // from it — the MR is what moves work — so the tracking entry buys nothing
    // and costs the only serialising write in the whole operation.
    else git(['worktree', 'add', '--no-track', '-b', branch, worktree, `origin/${base}`]);
    log.ok(`worktree ${worktree}`, { branch, base: `origin/${base}` });
  } else {
    log.info(`re-attached to existing worktree ${worktree}`);
  }

  seedWorktree(worktree);
  pinIdentity(worktree);

  const lease: Lease = { worktree, branch, baseSha: forkPoint(worktree, base) };
  if (opts.withPort) {
    const port = leasePortFor(runId);
    if (port === null) log.warn('no free port in the pool — the worktree is leased without one');
    else lease.port = port;
  }
  return lease;
}

/** Remove the worktree. The BRANCH is deliberately left alone — it is pushed work. */
export function reapWorktree(worktree: string, runId: string): void {
  releasePort(runId);
  if (!existsSync(worktree)) return;
  try {
    git(['worktree', 'remove', '--force', worktree]);
    log.ok(`reaped worktree ${worktree}`);
  } catch (err) {
    log.warn('worktree remove failed — leaving it on disk', { error: (err as Error).message });
  }
}

export function contextRepoPresent(): boolean {
  return existsSync(CONTEXT_REPO);
}

// ------------------------------------------------------- re-running a phase
//
// The three below serve scripts that re-run a finished phase to measure a
// harness change. They are separate from leaseWorktree() rather than options
// on it because a lease is bookkeeping a run owns — a port, a branch, a row
// reaped on completion — and a measurement owns none of that.

/**
 * A detached worktree at a fixed commit.
 *
 * Detached rather than on a branch: this exists to re-read code, and a
 * detached HEAD has nothing to push. The original run's own worktree is not
 * reused because later phases may have committed to it, which would show the
 * re-run the answer.
 */
export function replayWorktree(name: string, sha: string): string {
  mkdirSync(WT_ROOT, { recursive: true });
  const worktree = join(WT_ROOT, name);
  if (!existsSync(worktree)) git(['worktree', 'add', '--detach', worktree, sha]);
  seedWorktree(worktree);
  return worktree;
}

/**
 * The commit a run's branch left the base at — where its phases started reading.
 *
 * Refuses, rather than answering, once the base already contains the branch.
 * `merge-base` returns the best common ancestor, so for a branch that has
 * landed that is the branch's own TIP: the replay would then build its worktree
 * on the finished implementation and re-plan a change that is already sitting
 * in front of it. Runs that finished are exactly the population a replay is
 * for, non-squash merges leave the branch resolvable afterwards, and nothing
 * downstream can tell a poisoned fork point from a good one — so this fails
 * closed and names the way out.
 */
export function runForkPoint(branch: string, cwd = WORK_REPO): string {
  const base = `origin/${projectConfig().branches.base}`;
  try {
    git(['merge-base', '--is-ancestor', branch, base], cwd);
  } catch {
    // Not an ancestor: the ordinary case, and merge-base is the real fork point.
    return git(['merge-base', branch, base], cwd);
  }
  throw new Error(
    `${branch} is contained in ${base} — merge-base would return its tip, not its fork point, `
    + 'and the replay would read the implementation it is meant to plan. Pass --base <sha>.',
  );
}

/**
 * Commits that reference this ticket and are NOT in the replay's base — the
 * answer key, if the phase goes looking for it.
 *
 * `replayWorktree` uses `git worktree add`, which shares the object store and
 * every ref of the work repo. So a detached checkout at a pre-fix base is a
 * blind WORKING TREE inside a repository that still holds the merged fix:
 * `git log --all`, `git show <sha>` and `git log --grep=#<iid>` all reach it.
 *
 * `runForkPoint` fails closed for a landed branch and tells the caller to pass
 * `--base <sha>`. That escape hatch fixes the checkout and does nothing about
 * reachability, which is how a measured replay stopped being blind without
 * anyone noticing. This does not prevent that — it makes the run declare it,
 * so the artifact carries its own caveat instead of somebody's memory.
 *
 * Empty only when no commit naming #<iid> is reachable outside the base, which
 * in practice means the source run never committed. A run that reached
 * implement keeps its branch, and its commits carry `(#<iid>)`: those are an
 * answer key even though they never landed, so the default path (no --base,
 * base = runForkPoint) is flagged just as a landed fix is. Of 35 local runs
 * with a research.json, 20 came back non-empty at their fork point and 18 of
 * those were on branches that never landed.
 *
 * Empty is not proof the run was blind. This greps commit messages, so a fix
 * whose messages never name the ticket — a squash merge titled after the
 * change — is not found.
 *
 * Throws when git cannot list the commits, rather than answering []: an empty
 * list is the one result a caller reads as reassurance, so a check that did
 * not run must not be able to produce it. The caller decides what "not
 * checked" looks like in its artifact.
 */
export function answerKeyCommits(iid: number, base: string, cwd = WORK_REPO): string[] {
  // `([^0-9]|$)` rather than `\b`: git's ERE has no word-boundary escape, and
  // a bare `#18` would otherwise match #189 and report every low-numbered
  // ticket as contaminated until the warning stopped meaning anything.
  //
  // `--not <base>` drops history the phase is entitled to read, in the same
  // walk. It replaced a `merge-base --is-ancestor` spawn per candidate, which
  // gave the same set (32 of 32 on ERP #8783) but read a failed merge-base as
  // "not in the base" and over-reported.
  //
  // No catch. No matching commit exits 0 and gives [] on its own; git fails
  // only when it cannot walk the repo or resolve the base, and one dangling ref
  // anywhere in the work repo is enough (`fatal: bad object`, exit 128). The
  // catch this replaced swallowed that as [], which the caller recorded as the
  // reassuring reading for a check that never ran.
  return git(['log', '--all', '--not', base, '--format=%H %s', '-E', `--grep=#${iid}([^0-9]|$)`], cwd)
    .split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Counterpart to replayWorktree. No branch to preserve, and no port to release. */
export function removeReplayWorktree(worktree: string): void {
  if (!existsSync(worktree)) return;
  try {
    git(['worktree', 'remove', '--force', worktree]);
  } catch (err) {
    log.warn('replay worktree remove failed — leaving it on disk', { error: (err as Error).message });
  }
}

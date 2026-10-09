/**
 * The local automation tests step, on the conductor's side.
 *
 * Two phases share this file. `local-tests-scope` is a session: it picks the
 * workstream-automation specs the diff reaches and may edit specs in a
 * throwaway automation worktree. The conductor checks that worktree out before
 * the session (`prepare-scope`) and, the moment it ends, saves the edits as a
 * patch and removes it (`capture`). `local-tests-run` is plain code: it runs
 * exactly the listed specs against the ticket's code on a copy of the
 * automation database (`run`), and posts what happened.
 *
 * Everything that touches Postgres, the automation clone, the credentials or
 * Cypress lives in scripts/localtests.cjs, which this file only starts. Its
 * contract is small on purpose: one JSON object on stdout, and on a non-zero
 * exit that object is `{code, message, hint}`. Logs go to stderr and are
 * forwarded to the conductor's log. No session may start that script
 * (git-guard), so every call to it goes through here.
 *
 * Three rules shape the run phase, and each is the answer to a way this step
 * could mislead the developer who reads its results:
 *
 *   - It runs on EVERY pass, like every code phase, so it is idempotent by
 *     cache key: the specs, the ticket's commit, the automation commit and the
 *     patch. A resume, or a run re-walking its list after a park, gets the
 *     saved result instead of another forty minutes of Cypress — a setup error
 *     included, unless it only said the desk was busy. And once mr has run,
 *     no NEW run starts unless an MR review round planned one (noNewRunReason):
 *     results that arrived after the MR would reach the ticket with nobody
 *     asked to sign them.
 *   - One Cypress run per desk (src/lib/cypresslease.ts). A busy desk PARKS
 *     the run and the next tick tries again — whether the lease says so or the
 *     script does (deskBusy). Two runs at once fail each other's specs, and a
 *     failure caused by a busy desk reads on the ticket exactly like a
 *     regression.
 *   - The script's whole process group is killed once it overruns its
 *     deadline (runDeadlineMs), or the conductor asks the run to stop. Cypress
 *     is a browser and a dev server under node, and killing only the node at
 *     the top of that tree leaves the browser holding the desk. The script is
 *     told that deadline (`--until`), so it skips a base re-run it has no time
 *     to finish rather than being killed in the middle of it.
 *
 * Every external effect goes through LocalTestsDeps, so the tests drive the
 * whole phase with a fake script, a fake lease and a fake GitLab.
 */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import {
  DRY_RUN, ONESHOT_HOME, ROOT, RUNS, artifactDir, localTestsConfig, localTestsPatchFile, localTestsWorktree,
  projectConfig, type LocalTestsConfig,
} from '../lib/config.js';
import {
  readArtifact, readJournal, updateJournal, writeArtifact, type RunJournal,
} from '../lib/artifacts.js';
import {
  RUN_KILL_GRACE_MS, acquireCypressLease, cypressLeaseHolder, localTestsRunDeadlineMs, releaseCypressLease,
} from '../lib/cypresslease.js';
import { activeRunsFleet } from '../lib/db.js';
import { addIssueNote, editIssueLabels, issueNotes } from '../lib/gitlab.js';
import { localTestsStartNote } from '../lib/publish.js';
import { log } from '../lib/log.js';
import type { LocalTestsRun, LocalTestsScope } from '../phases/types.js';
import type { CodePhaseCtx, CodePhaseResult } from './runner.js';

const execFileP = promisify(execFile);

/** The script every call here starts. */
export const LOCAL_TESTS_SCRIPT = join(ROOT, 'scripts', 'localtests.cjs');

export const SCOPE_ARTIFACT = 'local-tests-scope.json';
export const RUN_ARTIFACT = 'local-tests-run.json';

/** The marker localTestsStartNote() ends with, so a start note is posted once per run of the same code. */
const START_MARKER = '<!-- oneshot:local-tests-start -->';

/**
 * The conductor's kill deadline for a `run` and its grace live beside the
 * Cypress lease's age limit (src/lib/cypresslease.ts), so the two are one sum
 * and cannot drift apart. Re-exported for the callers that know them from here.
 */
export { RUN_GRACE_MIN, runDeadlineMs } from '../lib/cypresslease.js';

/** Wall clock for the short calls. Generous: prepare-scope may fetch. */
const PREPARE_MS = 10 * 60_000;
const CAPTURE_MS = 5 * 60_000;
const GC_MS = 2 * 60_000;

/** How long a killed group gets between SIGTERM and SIGKILL. A `run` gets RUN_KILL_GRACE_MS, for its cleanup. */
const KILL_GRACE_MS = 10_000;

/** Stderr lines forwarded to the log per call, so a chatty Cypress cannot drown the conductor's own lines. */
const MAX_LOG_LINES = 2_000;
const STDERR_TAIL_CHARS = 4_000;

// ------------------------------------------------------------------ the script

/** What a spawned script looks like to runCli: just enough of a ChildProcess to fake. */
export interface CliChild {
  readonly pid?: number;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

export interface CliDeps {
  /** Start `node scripts/localtests.cjs <args>`. */
  spawn(args: string[]): CliChild;
  /** process.kill. A negative pid is the whole process group. */
  kill(pid: number, signal: NodeJS.Signals): void;
}

/**
 * The real script: from ONESHOT_HOME, so it resolves state/ the way the hooks
 * do (a dry run's is state-dry/state), and DETACHED, so it leads its own
 * process group and process.kill(-pid) reaches Cypress and its browser too.
 */
export const realCli: CliDeps = {
  spawn: (args) => spawn(process.execPath, [LOCAL_TESTS_SCRIPT, ...args], {
    cwd: ONESHOT_HOME,
    env: { ...process.env, ONESHOT_HOME },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }),
  kill: (pid, signal) => { process.kill(pid, signal); },
};

/** A failure the script named, or one this file names on its behalf. */
export interface CliError { code: string; message: string; hint?: string }
export type CliResult<T> = { ok: true; data: T } | { ok: false; error: CliError };

const fail = (code: string, message: string, hint?: string): { ok: false; error: CliError } => ({
  ok: false, error: { code, message, ...(hint ? { hint } : {}) },
});

/** One line for a person: the code, the message and the hint. */
export function cliErrorText(e: CliError): string {
  return `${e.code}: ${e.message}${e.hint ? ` (${e.hint})` : ''}`;
}

/**
 * Environment names whose values are credentials — the conductor's GitLab,
 * Slack and Claude tokens among them. PAT only as a whole word, so PATH is not
 * one.
 */
const SECRET_NAME = /TOKEN|SECRET|_KEY|PASSWORD|(?:^|_)PAT(?:$|_)/i;

/**
 * A function that replaces every credential value in this process's
 * environment with '***'. The script redacts what it prints; this covers the
 * words the conductor writes itself from the script's stderr (E_CLI) and
 * anything the script missed, before any of it is written where GitLab will
 * post it. Values under 8 characters are left alone: they are not secrets
 * anyone would issue, and replacing them would garble ordinary words.
 */
export function secretRedactor(env: NodeJS.ProcessEnv = process.env): (text: string) => string {
  const values = Object.entries(env)
    .filter(([name, value]) => typeof value === 'string' && value.length >= 8 && SECRET_NAME.test(name))
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length);
  return (text) => values.reduce((out, v) => (out.includes(v) ? out.split(v).join('***') : out), text);
}

export interface CliOpts {
  /** Killed past this. */
  deadlineMs: number;
  signal?: AbortSignal;
  /** Called once with the script's pid, so the caller can record what it is holding. */
  onSpawn?: (pid: number) => void;
  /** Between SIGTERM and SIGKILL. */
  graceMs?: number;
}

/**
 * The one JSON object the script prints. The whole of stdout first; failing
 * that, the last line that parses as an object, so a stray line printed before
 * it costs nothing.
 */
export function parseCliObject(stdout: string): Record<string, unknown> | null {
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  const text = stdout.trim();
  if (!text) return null;
  try {
    const whole = JSON.parse(text) as unknown;
    if (isObject(whole)) return whole;
  } catch { /* fall through to the last line */ }
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{')).reverse();
  for (const line of lines) {
    try {
      const v = JSON.parse(line) as unknown;
      if (isObject(v)) return v;
    } catch { /* keep looking */ }
  }
  return null;
}

/**
 * The script groups this process has started and not yet seen finish, each
 * with the deps that started it, so a kill goes through the same `kill`.
 */
const liveGroups = new Map<number, CliDeps>();

/**
 * SIGTERM every script group this process started that is still running, and
 * say which. For the conductor's exit: the script is detached so a kill
 * reaches its whole tree, which also means it outlives a conductor that exits
 * without waiting for it (a second Ctrl-C) — and an orphaned run holds the
 * desk's ports for up to two hours while the lease says the desk is free.
 * Synchronous, so it can run from process.on('exit').
 */
export function killLiveLocalTests(signal: NodeJS.Signals = 'SIGTERM'): number[] {
  const killed: number[] = [];
  for (const [pid, cli] of liveGroups) {
    try {
      cli.kill(-pid, signal);
      killed.push(pid);
    } catch { /* already gone */ }
  }
  liveGroups.clear();
  return killed;
}

/**
 * Run the script once and read its answer.
 *
 * Never throws and never hangs: past `deadlineMs`, or on `signal`, the whole
 * process group gets SIGTERM, then SIGKILL after `graceMs`, and the answer is
 * E_DEADLINE or E_ABORTED whether or not the group ever closes its pipes.
 */
export function runCli(args: string[], opts: CliOpts, cli: CliDeps = realCli): Promise<CliResult<Record<string, unknown>>> {
  const what = `scripts/localtests.cjs ${args[0] ?? ''}`.trim();
  const grace = opts.graceMs ?? KILL_GRACE_MS;
  const redact = secretRedactor();
  return new Promise((resolve) => {
    let child: CliChild;
    try {
      child = cli.spawn(args);
    } catch (err) {
      resolve(fail('E_SPAWN', `${what} could not be started: ${(err as Error).message}`));
      return;
    }

    let stdout = '';
    let tail = '';
    let partial = '';
    let logged = 0;
    let stopped: 'deadline' | 'aborted' | null = null;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];

    const onAbort = (): void => stop('aborted');
    const finish = (r: CliResult<Record<string, unknown>>): void => {
      if (settled) return;
      settled = true;
      if (child.pid) liveGroups.delete(child.pid);
      for (const t of timers) clearTimeout(t);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const stoppedError = (): { ok: false; error: CliError } => (stopped === 'aborted'
      ? fail('E_ABORTED', `${what} was stopped because the conductor asked this run to stop`)
      : fail('E_DEADLINE', `${what} did not finish within ${Math.round(opts.deadlineMs / 60_000)} min, `
        + 'so its whole process group was killed',
      'whatever it left behind is cleared by `node scripts/localtests.cjs gc`'));
    const killGroup = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      try {
        cli.kill(-child.pid, signal);
      } catch { /* already gone */ }
    };
    function stop(why: 'deadline' | 'aborted'): void {
      if (stopped || settled) return;
      stopped = why;
      log.warn(`localtests ${what} — ${why === 'deadline' ? 'past its deadline' : 'stop requested'}; killing its process group`,
        { pid: child.pid });
      killGroup('SIGTERM');
      timers.push(setTimeout(() => killGroup('SIGKILL'), grace));
      // A group that keeps a pipe open after SIGKILL (a zombie, a grandchild
      // that escaped the group) must not hold the caller for ever.
      timers.push(setTimeout(() => finish(stoppedError()), grace * 2));
    }

    const forward = (chunk: Buffer | string): void => {
      const text = String(chunk);
      tail = (tail + text).slice(-STDERR_TAIL_CHARS);
      const lines = (partial + text).split('\n');
      partial = lines.pop() ?? '';
      for (const l of lines) {
        if (!l.trim()) continue;
        logged += 1;
        if (logged <= MAX_LOG_LINES) log.info(`localtests ${redact(l)}`);
        else if (logged === MAX_LOG_LINES + 1) log.info(`localtests (further output from ${what} not shown)`);
      }
    };

    if (child.pid) {
      liveGroups.set(child.pid, cli);
      opts.onSpawn?.(child.pid);
    }
    child.stdout?.on('data', (c: Buffer | string) => { stdout += String(c); });
    child.stderr?.on('data', forward);
    child.on('error', (err) => finish(fail('E_SPAWN', `${what} could not be started: ${err.message}`)));
    child.on('close', (code, signal) => {
      if (stopped) {
        finish(stoppedError());
        return;
      }
      finish(readOutcome(what, code, signal, stdout, tail, redact));
    });

    timers.push(setTimeout(() => stop('deadline'), opts.deadlineMs));
    if (opts.signal?.aborted) stop('aborted');
    else opts.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** What an exit means: the object on 0, the script's own {code, message, hint} otherwise. */
function readOutcome(
  what: string, code: number | null, signal: NodeJS.Signals | null, stdout: string, stderrTail: string,
  redact: (text: string) => string = (t) => t,
): CliResult<Record<string, unknown>> {
  const obj = parseCliObject(stdout);
  if (code === 0) {
    return obj ? { ok: true, data: obj } : fail('E_BAD_OUTPUT', `${what} exited 0 but printed no JSON object`);
  }
  if (obj && typeof obj.code === 'string' && typeof obj.message === 'string') {
    return fail(obj.code, redact(obj.message), typeof obj.hint === 'string' && obj.hint ? redact(obj.hint) : undefined);
  }
  const lastLine = redact(stderrTail.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '');
  return fail('E_CLI', `${what} exited ${code ?? signal ?? 'abnormally'} without saying why`
    + `${lastLine ? `; its last line was: ${lastLine.slice(0, 200)}` : ''}`);
}

// --------------------------------------------------------------- the calls

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strList = (v: unknown): string[] =>
  (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []);

export interface PrepareScopeResult { wsa: string; automationSha: string }

/** The answer to `capture`: the patch the scope's edits were saved as, and what they did. */
export interface CaptureResult {
  /** Where the patch is. '' when the scope changed nothing, so there is no patch. */
  patchFile: string;
  /** Null when the scope changed nothing. */
  patchSha: string | null;
  /** The automation commit the patch was cut against, when the script names it. */
  automationSha?: string;
  changedFiles: string[];
  /** Changed files outside localTests.allowedPaths. Counted as weakened tests. */
  outsideAllowed: string[];
  /** Files whose change made an existing test easier to pass. */
  weakened: string[];
  addedSpecs: string[];
  removedSpecs: string[];
}

export interface GcResult {
  dropped: string[];
  removed: string[];
  /** The leftover processes gc stopped, as the script names them (its harnessProcesses). */
  killed: Array<{ iid: number; kind: string; pid: number }>;
}

/**
 * The external effects of this step, injectable so a test can drive the run
 * phase end to end without Postgres, Cypress, GitLab or the desk's lease.
 */
export interface LocalTestsDeps {
  cli: CliDeps;
  /** `git <args>` in `cwd`, trimmed stdout. Throws on a non-zero exit. */
  git(args: string[], cwd: string): Promise<string>;
  lease: {
    acquire(runId: string): Promise<boolean>;
    release(runId: string): void;
    holder(): { runId: string } | null;
  };
  notes: {
    /** The bodies of the ticket's recent notes, or null when GitLab could not say. */
    list(iid: number): Promise<string[] | null>;
    add(iid: number, body: string): Promise<boolean>;
  };
  labels: { add(iid: number, label: string): Promise<boolean> };
  config(): LocalTestsConfig;
  /** The iids of every run in flight on this desk, for gc's --keep. */
  activeIids(): number[];
  dryRun: boolean;
  /** How long the conductor lets a `run` call live, from the minutes it gives the script (localTestsRunDeadlineMs). */
  deadlineMs(deadlineMin: number): number;
}

export function defaultDeps(): LocalTestsDeps {
  return {
    cli: realCli,
    git: async (args, cwd) => {
      const { stdout } = await execFileP('git', ['-C', cwd, ...args], { timeout: 60_000 });
      return stdout.trim();
    },
    lease: {
      acquire: acquireCypressLease,
      release: releaseCypressLease,
      holder: () => cypressLeaseHolder(),
    },
    notes: {
      list: async (iid) => {
        const res = await issueNotes(iid);
        return res.ok && res.data ? res.data.map((n) => n.body ?? '') : null;
      },
      add: async (iid, body) => (await addIssueNote(iid, body)).ok,
    },
    labels: { add: async (iid, label) => (await editIssueLabels(iid, { add: [label] })).ok },
    config: () => localTestsConfig(),
    activeIids: () => activeRunsFleet().map((r) => r.iid),
    dryRun: DRY_RUN,
    deadlineMs: (min) => localTestsRunDeadlineMs(min),
  };
}

function withDefaults(over: Partial<LocalTestsDeps>): LocalTestsDeps {
  return { ...defaultDeps(), ...over };
}

/** `prepare-scope`: a fresh throwaway automation worktree at <runDir>/wsa. */
export async function prepareScope(
  iid: number, cfg: Pick<LocalTestsConfig, 'automationRef'>, over: Partial<LocalTestsDeps> = {},
): Promise<CliResult<PrepareScopeResult>> {
  const deps = withDefaults(over);
  const res = await runCli(
    ['prepare-scope', '--iid', String(iid), ...(cfg.automationRef ? ['--automation-ref', cfg.automationRef] : [])],
    { deadlineMs: PREPARE_MS }, deps.cli,
  );
  if (!res.ok) return res;
  const wsa = str(res.data.wsa);
  const automationSha = str(res.data.automationSha);
  if (!wsa || !automationSha) {
    return fail('E_BAD_OUTPUT', 'scripts/localtests.cjs prepare-scope did not name the worktree and its commit');
  }
  return { ok: true, data: { wsa, automationSha } };
}

/** `capture`: save the throwaway worktree's changes as the patch, check them, and remove the worktree. */
export async function captureScope(iid: number, over: Partial<LocalTestsDeps> = {}): Promise<CliResult<CaptureResult>> {
  const deps = withDefaults(over);
  const res = await runCli(['capture', '--iid', String(iid)], { deadlineMs: CAPTURE_MS }, deps.cli);
  if (!res.ok) return res;
  const d = res.data;
  const patchSha = str(d.patchSha) || null;
  const patchFile = str(d.patchFile);
  // No edits is a patch of nothing, and the script names no file for it.
  if (patchSha && !patchFile) return fail('E_BAD_OUTPUT', 'scripts/localtests.cjs capture saved a patch but did not say where');
  return {
    ok: true,
    data: {
      patchFile: patchSha ? patchFile : '',
      patchSha,
      ...(str(d.automationSha) ? { automationSha: str(d.automationSha) } : {}),
      changedFiles: strList(d.changedFiles),
      outsideAllowed: strList(d.outsideAllowed),
      weakened: strList(d.weakened),
      addedSpecs: strList(d.addedSpecs),
      removedSpecs: strList(d.removedSpecs),
    },
  };
}

export interface RunLocalTestsOpts {
  iid: number;
  /** The ticket's ERP worktree. */
  worktree: string;
  /** The ticket commit the specs run against. */
  ref: string;
  specsFile: string;
  patch?: string;
  /** The sha capture recorded for `patch`; the script refuses a patch file that no longer matches it. */
  patchSha?: string;
  automationSha?: string;
  base?: string;
  /**
   * What the script holds Cypress to. The conductor's own kill comes later
   * (deps.deadlineMs), and the script is told that moment as `--until`.
   */
  deadlineMin: number;
  signal?: AbortSignal;
  onSpawn?: (pid: number) => void;
}

const RUN_STATUSES = new Set<LocalTestsRun['status']>(['passed', 'failed', 'skipped', 'error']);

/**
 * `run`. Exit 0 whenever the specs ran, failing or not; anything else is a
 * setup error the script names. The result is normalised so every reader of
 * local-tests-run.json can rely on its arrays.
 */
export async function runLocalTests(
  o: RunLocalTestsOpts, over: Partial<LocalTestsDeps> = {},
): Promise<CliResult<LocalTestsRun>> {
  const deps = withDefaults(over);
  const deadlineMs = deps.deadlineMs(o.deadlineMin);
  const args = [
    'run', '--iid', String(o.iid), '--worktree', o.worktree, '--ref', o.ref, '--specs-file', o.specsFile,
    ...(o.patch ? ['--patch', o.patch] : []),
    ...(o.patch && o.patchSha ? ['--patch-sha', o.patchSha] : []),
    ...(o.automationSha ? ['--automation-sha', o.automationSha] : []),
    ...(o.base ? ['--base', o.base] : []),
    '--deadline-min', String(o.deadlineMin),
    // The moment the conductor kills the group, as an absolute clock: the
    // script skips a base re-run that cannot finish before it, and says so,
    // rather than being killed mid-way and losing the ticket's own results.
    '--until', String(Date.now() + deadlineMs),
  ];
  const res = await runCli(args, {
    deadlineMs, signal: o.signal, onSpawn: o.onSpawn, graceMs: RUN_KILL_GRACE_MS,
  }, deps.cli);
  if (!res.ok) return res;
  const run = normaliseRun(res.data);
  if (!run) return fail('E_BAD_OUTPUT', 'scripts/localtests.cjs run printed something that is not a local test run');
  return { ok: true, data: run };
}

/**
 * A LocalTestsRun from the script's object, or null when it is not one.
 *
 * Kept beyond the type's required fields, because a reader needs them to judge
 * the run: `notes` (why failingOnDev is unknown, a video that was not kept, a
 * base re-run skipped for time, an incomplete cleanup) and each result's
 * `flaky` (failed once, passed on the retry against the ticket's code). Every
 * free-text field is redacted of this process's credentials on the way in.
 */
export function normaliseRun(
  d: Record<string, unknown>, redact: (text: string) => string = secretRedactor(),
): LocalTestsRun | null {
  const status = d.status as LocalTestsRun['status'];
  if (!RUN_STATUSES.has(status)) return null;
  const list = <T>(v: unknown): T[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') as T[] : []);
  const results = list<Record<string, unknown>>(d.results).map((r) => {
    const { flaky, error, ...rest } = r;
    return {
      ...rest,
      ...(typeof error === 'string' ? { error: redact(error) } : {}),
      ...(flaky === true ? { flaky: true } : {}),
    } as unknown as LocalTestsRun['results'][number];
  });
  const count = (state: string): number => results.filter((r) => r.state === state).length;
  const t = (d.totals && typeof d.totals === 'object' ? d.totals : {}) as Partial<LocalTestsRun['totals']>;
  const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const notes = strList(d.notes).map(redact);
  return {
    status,
    ...(typeof d.reason === 'string' && d.reason ? { reason: redact(d.reason) } : {}),
    ...(notes.length ? { notes } : {}),
    cacheKey: str(d.cacheKey),
    ticketSha: str(d.ticketSha),
    automationSha: str(d.automationSha),
    patchSha: str(d.patchSha) || null,
    db: str(d.db),
    totals: {
      specs: num(t.specs, new Set(results.map((r) => r.spec)).size),
      tests: num(t.tests, results.length),
      passed: num(t.passed, count('passed')),
      failed: num(t.failed, count('failed')),
      skipped: num(t.skipped, count('skipped')),
    },
    results,
    notRunnable: list<LocalTestsRun['notRunnable'][number]>(d.notRunnable),
    newTests: strList(d.newTests),
    startedAt: str(d.startedAt),
    endedAt: str(d.endedAt),
  };
}

/**
 * `gc`: drop every per-run database copy, throwaway worktree and Cypress
 * process that does not belong to a run in `activeIids`. Never throws, and
 * does nothing on a desk where the step is off. Null when it did not run.
 *
 * Never from a dry run. The script drops copies by prefix across the whole
 * Postgres server, sparing only what it is told to keep, and a dry run's
 * `activeIids` come from the dry run's own database, which knows nothing of the
 * real runs on this desk — its gc would drop a real run's copy out from under
 * it. A dry run makes no copy to clean up anyway: local-tests-run starts no
 * Cypress there.
 */
export async function gcLocalTests(
  activeIids: Iterable<number>, over: Partial<LocalTestsDeps> = {},
): Promise<GcResult | null> {
  const deps = withDefaults(over);
  if (!deps.config().enabled || deps.dryRun) return null;
  const keep = [...new Set([...activeIids].filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  const res = await runCli(['gc', ...(keep.length ? ['--keep', keep.join(',')] : [])], { deadlineMs: GC_MS }, deps.cli);
  if (!res.ok) {
    log.warn(`local tests gc did not run — ${cliErrorText(res.error)}`);
    return null;
  }
  const out: GcResult = {
    dropped: strList(res.data.dropped),
    removed: strList(res.data.removed),
    // {iid, kind, pid, port, dir} per process; the first three are what a log line needs.
    killed: (Array.isArray(res.data.killed) ? res.data.killed : [])
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object'
        && Number.isInteger((x as Record<string, unknown>).pid))
      .map((x) => ({ iid: Number(x.iid) || 0, kind: str(x.kind), pid: x.pid as number })),
  };
  if (out.dropped.length || out.removed.length || out.killed.length) {
    log.warn('local tests gc cleared what no live run was holding', { ...out, kept: keep });
  }
  // What it could not clear, said once rather than on every tick it stays true.
  const errors = strList(res.data.errors).join('; ');
  if (errors && errors !== lastGcErrors) log.warn(`local tests gc could not clear everything — ${errors.slice(0, 400)}`);
  lastGcErrors = errors;
  return out;
}

/** The last gc's errors, so a fault that persists (Postgres down) is logged once, not every tick. */
let lastGcErrors = '';

// ------------------------------------------------------------- the plan

/** What the conductor adds to local-tests-scope.json after the session: the saved edits, and what they ran against. */
export interface ScopeCapture extends CaptureResult {
  automationSha: string;
  /** The ERP commits the scope was chosen for. */
  base: string;
  head: string;
}

/** The scope session's inputs that only the conductor can know. Passed into its prompt. */
export interface ScopeInputs {
  /** The throwaway automation worktree, <runDir>/wsa. */
  wsa: string;
  automationSha: string;
  /** merge-base of the ticket's HEAD with origin/<base branch>. */
  base: string;
  head: string;
  /** Where the edits will be saved — and where the previous round's are, on a redo. */
  patchFile: string;
}

/** The scope's spec files, de-duplicated, in the order the scope listed them. */
export function specFiles(scope: Record<string, unknown> | null | undefined): string[] {
  const specs = Array.isArray(scope?.specs) ? scope.specs as Array<{ file?: unknown }> : [];
  return [...new Set(specs.map((s) => (s && typeof s.file === 'string' ? s.file.trim() : '')).filter(Boolean))];
}

/**
 * The specs the scope chose but marked as needing what a local machine does
 * not have (a mailbox, a third-party service), de-duplicated. Handed to the
 * script beside the list, which reports them and does not run them.
 */
export function notRunnableOf(scope: Record<string, unknown> | null | undefined): Array<{ spec: string; why: string }> {
  const raw = Array.isArray(scope?.notRunnable) ? scope.notRunnable as unknown[] : [];
  const out: Array<{ spec: string; why: string }> = [];
  for (const n of raw) {
    if (!n || typeof n !== 'object') continue;
    const spec = str((n as Record<string, unknown>).spec).trim();
    if (!spec || out.some((o) => o.spec === spec)) continue;
    const why = str((n as Record<string, unknown>).why).trim() || 'needs something a local machine does not have';
    out.push({ spec, why });
  }
  return out;
}

/** The capture block the conductor wrote into the scope, or null when there is none. */
export function captureOf(scope: Record<string, unknown> | null | undefined): ScopeCapture | null {
  const c = scope?.capture as Partial<ScopeCapture> | undefined;
  if (!c || typeof c !== 'object' || typeof c.patchFile !== 'string' || typeof c.automationSha !== 'string') return null;
  return {
    patchFile: c.patchFile,
    patchSha: typeof c.patchSha === 'string' && c.patchSha ? c.patchSha : null,
    changedFiles: strList(c.changedFiles),
    outsideAllowed: strList(c.outsideAllowed),
    weakened: strList(c.weakened),
    addedSpecs: strList(c.addedSpecs),
    removedSpecs: strList(c.removedSpecs),
    automationSha: c.automationSha,
    base: str(c.base),
    head: str(c.head),
  };
}

/**
 * Files the localSpecs gate treats as weakened tests: what capture flagged as
 * weakened, and every changed file outside localTests.allowedPaths. A change
 * where no change was allowed is a test nobody can vouch for.
 */
export function weakenedFiles(capture: ScopeCapture | null): string[] {
  return capture ? [...new Set([...capture.weakened, ...capture.outsideAllowed])] : [];
}

/** The last record of a phase in the journal. */
function lastRecord(journal: Pick<RunJournal, 'phases'> | null, phase: string): RunJournal['phases'][number] | undefined {
  return [...(journal?.phases ?? [])].reverse().find((r) => r.phase === phase);
}

/** A record that settles its phase — phaseSettled()'s statuses. */
const SETTLED = new Set<RunJournal['phases'][number]['status']>(['ok', 'warned', 'skipped']);

/** Where in the journal mr last settled, or -1 when it never has. */
function mrSettledAt(journal: Pick<RunJournal, 'phases'> | null): number {
  const phases = journal?.phases ?? [];
  for (let k = phases.length - 1; k >= 0; k -= 1) {
    if (phases[k]!.phase === 'mr' && SETTLED.has(phases[k]!.status)) return k;
  }
  return -1;
}

/** Where in the journal local-tests-scope last ran — a 'skipped' record is not a run — or -1. */
function scopeRanAt(journal: Pick<RunJournal, 'phases'> | null): number {
  const phases = journal?.phases ?? [];
  for (let k = phases.length - 1; k >= 0; k -= 1) {
    if (phases[k]!.phase === 'local-tests-scope' && phases[k]!.status !== 'skipped') return k;
  }
  return -1;
}

/**
 * Why neither local-tests phase applies to this run, or null when they do.
 *
 * A run whose mr has already settled and whose scope never ran is a run the
 * step was switched on under: ONESHOT_LOCAL_TESTS_REPO set on a desk with runs
 * in flight. phases() adds both phases to every run's list, and a run parked
 * at merge walks that list again on its next poll — it would spend a scope
 * session and a run of up to two hours on an MR that is already open, and a
 * localSpecs gate armed there would hold the walk from ever reaching merge, so
 * a merge a person has already made goes unnoticed. The runner records both
 * phases 'skipped' with this reason instead, unless an MR review round has
 * forced the scope: that round re-plans and runs them like any other.
 */
export function lateForLocalTests(journal: Pick<RunJournal, 'phases'> | null): string | null {
  if (mrSettledAt(journal) === -1 || scopeRanAt(journal) !== -1) return null;
  return 'this run\'s MR step had already run when the local automation tests step was switched on, so they are '
    + 'not run for it; an MR review round would plan and run them';
}

/**
 * Why local-tests-run must not start a NEW Cypress run, or null when it may.
 *
 * Once mr has settled, only a plan made since — by an MR review round, which
 * forces the scope, then this phase, then mr, whose localResults gate asks a
 * developer about the new results — may start one. Anything else after mr is
 * a re-walk of a run waiting at merge (every MERGE_POLL_MS on a Review desk),
 * and a run started there would hold the desk's Cypress lease for up to two
 * hours, park the walk short of merge whenever another run held it, and post
 * results nobody is asked to sign, because the localResults gate is passed.
 */
export function noNewRunReason(journal: Pick<RunJournal, 'phases'> | null): string | null {
  const mrAt = mrSettledAt(journal);
  if (mrAt === -1 || scopeRanAt(journal) > mrAt) return null;
  return 'the MR step has already run and no MR review round has re-planned the local tests since, '
    + 'so no new local run is started';
}

/**
 * Why local-tests-run starts no Cypress, judged from the plan alone, or null
 * when it has something to run.
 *
 * `quiet` is set when the scope itself answered "nothing to run": its own note
 * on the ticket already says so in one line, and a second line from the run
 * step saying the same would only be noise.
 */
export function runSkipReason(
  journal: Pick<RunJournal, 'phases'> | null, scope: Record<string, unknown> | null,
): { reason: string; quiet: boolean } | null {
  const rec = lastRecord(journal, 'local-tests-scope');
  if (!rec) return { reason: 'local-tests-scope has not run', quiet: false };
  if (rec.status !== 'ok') {
    return { reason: `local-tests-scope did not finish (${rec.error ?? rec.status})`, quiet: false };
  }
  if (!scope) return { reason: 'local-tests-scope left no plan to run', quiet: false };
  const blocked = typeof scope.blocked === 'string' ? scope.blocked.trim() : '';
  if (blocked) return { reason: `local-tests-scope was blocked: ${blocked}`, quiet: false };
  if (scope.applicable !== true || specFiles(scope).length === 0) {
    const why = typeof scope.reason === 'string' && scope.reason.trim() ? scope.reason.trim() : 'no spec to run';
    return { reason: `not needed for this ticket: ${why}`, quiet: true };
  }
  if (!captureOf(scope)) {
    return { reason: 'the scope\'s temporary spec changes were never saved, so its plan cannot be run as made', quiet: false };
  }
  return null;
}

/**
 * The localSpecs gate for this plan: why it arms and what it asks QA to sign,
 * or null when it does not arm — a plan with nothing to run, or one that
 * changes nothing about the team's test list.
 *
 * The subject is the list, the proposals and the patch, so an approval stops
 * covering the moment any of them is redone.
 */
export function localSpecsGate(
  journal: Pick<RunJournal, 'phases'> | null, scope: Record<string, unknown> | null,
  reason: (scope: Record<string, unknown> | null, weakened: string[]) => string | null,
): { why: string; subject: Record<string, unknown> } | null {
  if (runSkipReason(journal, scope)) return null;
  const capture = captureOf(scope);
  const why = reason(scope, weakenedFiles(capture));
  if (!why) return null;
  const proposals = (Array.isArray(scope?.proposals) ? scope.proposals : [])
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .map((p) => ({ action: str(p.action), title: str(p.title), file: str(p.file) }));
  return { why, subject: { specs: [...specFiles(scope)].sort(), proposals, patchSha: capture?.patchSha ?? null } };
}

/**
 * What the localResults gate asks a developer to sign: the outcome of each
 * test against exactly this code. Null when the run has no results to judge —
 * it was skipped or could not be run.
 */
export function localResultsSubject(run: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  const r = (run ?? {}) as Partial<LocalTestsRun>;
  if (r.status !== 'passed' && r.status !== 'failed') return null;
  const results = Array.isArray(r.results) ? r.results : [];
  return {
    cacheKey: r.cacheKey ?? '',
    status: r.status,
    totals: r.totals ?? null,
    // A pass that needed the retry is a different outcome to sign than a clean
    // one. Only present when true, so a subject approved before the flag
    // existed still matches.
    results: results.map((x) => ({
      spec: x.spec, title: x.title, state: x.state,
      ...((x as { flaky?: unknown }).flaky === true ? { flaky: true } : {}),
    })),
  };
}

/**
 * Identifies one run: the specs (order does not change what runs) and the ones
 * set aside as not runnable locally, the ticket commit, the automation commit,
 * the patch, and the two policy values that change what the same code would
 * report — which baseline it copies, and how long Cypress may take. Two runs
 * with one key would report the same thing. The not-runnable list is keyed only
 * when there is one, so a plan without it keeps the key it always had.
 */
export function cacheKey(
  scope: Record<string, unknown> | null, ticketSha: string, automationSha: string, patchSha: string | null,
  cfg: Pick<LocalTestsConfig, 'baselineDb' | 'maxRunMinutes'>,
): string {
  const notRunnable = notRunnableOf(scope).map((n) => n.spec).sort();
  return createHash('sha256').update(JSON.stringify({
    v: 1,
    specs: [...specFiles(scope)].sort(),
    ...(notRunnable.length ? { notRunnable } : {}),
    ticketSha,
    automationSha,
    patchSha: patchSha ?? null,
    baselineDb: cfg.baselineDb,
    maxRunMinutes: cfg.maxRunMinutes,
  })).digest('hex');
}

// ------------------------------------------------------ the scope session

/**
 * Before the `local-tests-scope` session: read the ticket's commits, then
 * check out the throwaway automation worktree and record it in the journal,
 * so a run killed mid-session can still be cleaned up. The commits first, so a
 * failure there leaves nothing behind.
 */
export async function prepareScopeSession(
  iid: number, worktree: string, over: Partial<LocalTestsDeps> = {},
): Promise<CliResult<ScopeInputs>> {
  const deps = withDefaults(over);
  let head: string;
  let base: string;
  const baseBranch = projectConfig().branches.base || 'dev';
  try {
    head = await deps.git(['rev-parse', 'HEAD'], worktree);
    base = await deps.git(['merge-base', 'HEAD', `origin/${baseBranch}`], worktree);
  } catch (err) {
    return fail('E_GIT', `could not read the ticket's commits in ${worktree}: ${(err as Error).message.slice(0, 200)}`);
  }
  if (!head || !base) return fail('E_GIT', `git named no commit for HEAD or its merge-base with origin/${baseBranch}`);

  const prep = await prepareScope(iid, deps.config(), deps);
  if (!prep.ok) return prep;
  updateJournal(iid, { localTests: { wt: prep.data.wsa, startedAt: Date.now() } });
  return { ok: true, data: { ...prep.data, base, head, patchFile: localTestsPatchFile(iid) } };
}

/** Up to three proposal titles, for a one-line reason that would otherwise hide them. */
function proposalTitles(scope: Record<string, unknown>): string {
  const titles = (Array.isArray(scope.proposals) ? scope.proposals : [])
    .map((p) => (p && typeof p === 'object' ? str((p as Record<string, unknown>).title).trim() : ''))
    .filter(Boolean);
  if (!titles.length) return '';
  const shown = titles.slice(0, 3).map((t) => t.replace(/[.\s]+$/, '')).join('; ');
  return ` Suggested for the suite: ${shown}${titles.length > 3 ? `; and ${titles.length - 3} more` : ''}.`;
}

/**
 * After the `local-tests-scope` session, whatever it concluded.
 *
 * The throwaway worktree is always captured, which saves the edits and removes
 * it: a scope that blocked or failed still leaves nothing on the desk. Then,
 * for a scope that finished:
 *
 *   - nothing to run (not applicable, or applicable with no spec listed): the
 *     second case is written back as not applicable, so the ticket gets the
 *     same one line and no gate or run treats an empty list as a plan;
 *   - something to run: the capture is written into the scope as `capture`,
 *     where the localSpecs gate and local-tests-run read it, and the ticket
 *     gets the local-tests label;
 *   - something to run but the edits could not be saved: a refusal, because
 *     running the specs without the edits the plan depends on would report
 *     failures the plan already explained.
 */
export async function afterScopeSession(
  iid: number,
  out: { ok: boolean; data: Record<string, unknown> | null },
  inputs: ScopeInputs | null | undefined,
  over: Partial<LocalTestsDeps> = {},
): Promise<{ data: Record<string, unknown> | null; refusal: string | null }> {
  if (!inputs) return { data: out.data, refusal: null };
  const deps = withDefaults(over);
  const captured = await captureScope(iid, deps);
  updateJournal(iid, { localTests: undefined });
  if (!captured.ok) log.warn(`local-tests-scope: capture failed — ${cliErrorText(captured.error)}`);
  if (!out.ok || !out.data) return { data: out.data, refusal: null };

  const scope = out.data;
  if (scope.applicable !== true || specFiles(scope).length === 0) {
    if (scope.applicable !== true) return { data: scope, refusal: null };
    const said = typeof scope.reason === 'string' ? scope.reason.trim().replace(/[.\s]+$/, '') : '';
    const data = {
      ...scope,
      applicable: false,
      reason: `${said ? `${said}, but ` : ''}no spec was chosen to run.${proposalTitles(scope)}`,
    };
    writeArtifact(iid, SCOPE_ARTIFACT, data);
    return { data, refusal: null };
  }

  if (!captured.ok) {
    return {
      data: scope,
      refusal: `the temporary spec changes could not be saved (${cliErrorText(captured.error)}), `
        + 'so the planned specs are not run',
    };
  }
  // The commit capture says the patch was cut against wins over the one
  // prepare-scope reported: the patch is only true of that commit.
  const capture: ScopeCapture = {
    ...captured.data,
    automationSha: captured.data.automationSha || inputs.automationSha,
    base: inputs.base,
    head: inputs.head,
  };
  const data = { ...scope, capture };
  writeArtifact(iid, SCOPE_ARTIFACT, data);

  const label = projectConfig().labels.localTests;
  if (label && !await deps.labels.add(iid, label)) {
    log.warn(`local-tests-scope: could not add the '${label}' label to #${iid}`);
  }
  return { data, refusal: null };
}

// --------------------------------------------------------- the run phase

/**
 * Codes the script uses for "the desk is busy — try again later", none of
 * which says anything about the ticket's code: the step's ports held by
 * another run's app or Cypress, another run of this ticket's script still
 * alive (left behind by a conductor that died), or sessions connected to the
 * baseline database. See deskBusy.
 */
export const BUSY_CODES: ReadonlySet<string> = new Set(['E_PORT_BUSY', 'E_RUN_IN_PROGRESS', 'E_BASELINE_BUSY']);

/**
 * Codes whose recorded error is not reused for the same cache key: the busy
 * ones (recorded before they parked), and a script stopped from outside. They
 * describe the desk at one moment, not the run, so the next pass asks again.
 */
const RERUN_CODES: ReadonlySet<string> = new Set([...BUSY_CODES, 'E_ABORTED']);

/** A directory the script runs things in: state/runs/<iid>/<one of its checkouts>. */
const RUN_CHECKOUT = /[\\/]runs[\\/]\d+[\\/](?:erp-lt|erp-base-lt|wsa-run|wsa)(?:[\\/]|\s|$)/;

/**
 * Whether a script error means the desk is busy, so the run PARKS — nothing
 * recorded, nothing posted, and the next tick tries again — the same answer a
 * held Cypress lease gets. Recorded as an error instead, it would read on the
 * ticket as "could not be run" for a ticket that merely came second, and send
 * that ticket on to mr with no local results.
 *
 * E_PORT_BUSY only when the holder is another local-tests run: the script
 * names the holder's directory, and only that step's apps and Cypress stand in
 * a run's checkout. A dev server somebody left on those ports is a person's to
 * stop, and is recorded so the ticket says so.
 */
export function deskBusy(e: CliError, runsRoot: string = RUNS): boolean {
  if (!BUSY_CODES.has(e.code)) return false;
  if (e.code !== 'E_PORT_BUSY') return true;
  return e.message.includes(`${runsRoot}${sep}`) || RUN_CHECKOUT.test(e.message) || /localtests|local-tests run/i.test(e.message);
}

/** The code a recorded error's reason starts with (cliErrorText), or ''. */
function reasonCode(reason: string | undefined): string {
  return /^(E_[A-Z0-9_]+):/.exec(reason ?? '')?.[1] ?? '';
}

/**
 * Whether a saved run answers for `key` without running again: its results,
 * or a setup error that would only repeat — a migration that fails, a spec
 * that is missing, a run past its deadline. Re-running those on every pass
 * meant a run parked at merge restarted up to two hours of work every poll.
 */
function reusable(saved: LocalTestsRun | null, key: string): saved is LocalTestsRun {
  if (!saved || !key || saved.cacheKey !== key) return false;
  if (saved.status === 'passed' || saved.status === 'failed') return true;
  return saved.status === 'error' && !RERUN_CODES.has(reasonCode(saved.reason));
}

/** A run that started no Cypress. */
function notRun(
  status: 'skipped' | 'error', reason: string,
  key: { cacheKey: string; ticketSha: string; automationSha: string; patchSha: string | null },
): LocalTestsRun {
  const now = new Date().toISOString();
  return {
    status, reason, ...key, db: '',
    totals: { specs: 0, tests: 0, passed: 0, failed: 0, skipped: 0 },
    results: [], notRunnable: [], newTests: [], startedAt: now, endedAt: now,
  };
}

/**
 * Write the run's result and decide whether the ticket hears about it again.
 *
 * Unchanged (same key, status and reason as the saved one): nothing is written
 * and nothing re-posted, which is what lets this phase run on every pass. A
 * new result takes `local-tests-run` out of `journal.published` so the report
 * reaches the ticket; a quiet one puts it in, because the scope's own note has
 * already said everything there is to say.
 */
function settle(iid: number, next: LocalTestsRun, saved: LocalTestsRun | null, quiet = false): LocalTestsRun {
  const same = saved !== null && saved.cacheKey === next.cacheKey && saved.status === next.status
    && (saved.reason ?? '') === (next.reason ?? '');
  if (same) return saved;
  writeArtifact(iid, RUN_ARTIFACT, next);
  const published = (readJournal(iid)?.published ?? []).filter((k) => k !== 'local-tests-run');
  updateJournal(iid, { published: quiet ? [...published, 'local-tests-run'] : published });
  return next;
}

/**
 * What a finished run means for the phase. Only failuresBlock turns failing tests into a stop,
 * and only real failures: a run cut off at the deadline with none failed is reported, not blocked.
 */
function verdict(run: LocalTestsRun, cfg: Pick<LocalTestsConfig, 'failuresBlock'>): CodePhaseResult {
  const data = run as unknown as Record<string, unknown>;
  if (run.status === 'failed' && cfg.failuresBlock && run.totals.failed > 0) {
    return {
      ok: false,
      block: true,
      data,
      error: `local-tests-run: ${run.totals.failed} local automation test(s) failed, and localTests.failuresBlock `
        + 'stops the run before mr — the results are on the ticket',
    };
  }
  if (run.status === 'error') {
    return { ok: false, data, error: `local-tests-run: could not run the specs — ${run.reason ?? 'no reason recorded'}` };
  }
  return { ok: true, data };
}

/**
 * Post the start note, once per run of the same code: a note already carrying
 * the marker and both commits means this run was announced before a restart.
 * When GitLab cannot list the notes it is posted anyway — a duplicate line
 * costs less than a forty-minute run nobody was told about.
 */
async function announce(
  iid: number, run: { tests: number; minutes: number; branch: string; ticketSha: string; automationSha: string },
  cfg: Pick<LocalTestsConfig, 'automationRef'>, deps: LocalTestsDeps,
): Promise<void> {
  const shas = [run.ticketSha.slice(0, 7), run.automationSha.slice(0, 7)];
  const bodies = await deps.notes.list(iid);
  if (bodies?.some((b) => b.includes(START_MARKER) && shas.every((s) => b.includes(s)))) return;
  const ok = await deps.notes.add(iid, localTestsStartNote({ ...run, automationRef: cfg.automationRef }));
  if (!ok) log.warn(`local-tests-run: could not post the start note on #${iid}`);
}

/**
 * The `local-tests-run` code phase.
 *
 * In order: a run the step was switched on under skips quietly; the plan
 * decides whether there is anything to run; an identical earlier run is reused
 * (an error that would only repeat included); past mr, nothing new starts
 * unless an MR review round planned it; a dry run starts nothing; a busy desk
 * parks; and only then is anything announced, written or started. A script
 * that finds the desk busy parks too, with nothing recorded. The lease is
 * released, and the journal's record of what the run holds cleared, whatever
 * happens after it was taken. A run that did not finish cleanly is followed by
 * a gc for this ticket, because whatever it left — a database copy, a
 * worktree, a browser — would otherwise wait for the run to end.
 */
export async function localTestsRunPhase(
  ctx: CodePhaseCtx, over: Partial<LocalTestsDeps> = {},
): Promise<CodePhaseResult> {
  const deps = withDefaults(over);
  const cfg = deps.config();
  const { iid } = ctx;
  const journal = readJournal(iid) ?? ctx.journal;
  const scope = readArtifact<Record<string, unknown>>(iid, SCOPE_ARTIFACT);
  const saved = readArtifact<LocalTestsRun>(iid, RUN_ARTIFACT);
  const capture = captureOf(scope);
  const keyed = (ticketSha = '', key = ''): Parameters<typeof notRun>[2] => ({
    cacheKey: key, ticketSha, automationSha: capture?.automationSha ?? '', patchSha: capture?.patchSha ?? null,
  });

  // The runner records this case 'skipped' before dispatching the phase; this
  // is the same answer for any other caller, and quiet: an MR that is already
  // open does not need a line saying a step it never had did not run.
  const late = lateForLocalTests(journal);
  if (late) return verdict(settle(iid, notRun('skipped', late, keyed()), saved, true), cfg);

  const skip = runSkipReason(journal, scope);
  if (skip) return verdict(settle(iid, notRun('skipped', skip.reason, keyed()), saved, skip.quiet), cfg);
  // runSkipReason() returned null, so there is a capture.
  const cap = capture!;
  const specs = specFiles(scope);

  const setupError = (reason: string, ticketSha = '', key = ''): CodePhaseResult =>
    verdict(settle(iid, notRun('error', reason, keyed(ticketSha, key)), saved), cfg);

  const worktree = journal.worktree;
  if (!worktree) return setupError('the run holds no ERP worktree to run the specs against');
  let ticketSha: string;
  try {
    ticketSha = await deps.git(['rev-parse', 'HEAD'], worktree);
  } catch (err) {
    return setupError(`could not read the ticket's commit in ${worktree}: ${(err as Error).message.slice(0, 200)}`);
  }
  const key = cacheKey(scope, ticketSha, cap.automationSha, cap.patchSha, cfg);

  if (reusable(saved, key)) {
    log.info(`local-tests-run — reusing the ${saved.status === 'error' ? 'setup error' : 'results'} of an identical run on #${iid}`, {
      status: saved.status, passed: saved.totals?.passed, failed: saved.totals?.failed,
    });
    return verdict(saved, cfg);
  }

  const frozen = noNewRunReason(journal);
  if (frozen) {
    log.info(`local-tests-run — ${frozen} on #${iid}`);
    // Whatever was last recorded stands, as it was reported; a run that never
    // recorded anything gets one quiet line in the artifact and none on the
    // ticket.
    return saved ? verdict(saved, cfg)
      : verdict(settle(iid, notRun('skipped', frozen, keyed(ticketSha, key)), saved, true), cfg);
  }

  if (deps.dryRun) {
    return verdict(settle(iid, notRun('skipped', 'a dry run starts no Cypress', keyed(ticketSha, key)), saved), cfg);
  }

  if (!await deps.lease.acquire(ctx.runId)) {
    const holder = deps.lease.holder();
    return {
      ok: false,
      park: true,
      error: `local-tests-run: another run${holder ? ` (${holder.runId})` : ''} is using Cypress on this desk — `
        + 'parked, and tried again on a later tick',
    };
  }

  let clean = false;
  try {
    const notRunnable = notRunnableOf(scope);
    const tests = (Array.isArray(scope?.specs) ? scope.specs as Array<{ file?: unknown; cases?: unknown }> : [])
      .filter((s) => !notRunnable.some((n) => n.spec === (typeof s?.file === 'string' ? s.file.trim() : '')))
      .reduce((n, s) => n + (Number(s?.cases) || 0), 0);
    await announce(iid, {
      tests,
      minutes: Number(scope?.estimatedMinutes) || cfg.maxRunMinutes,
      branch: journal.branch ?? '',
      ticketSha,
      automationSha: cap.automationSha,
    }, cfg, deps);

    const dir = join(artifactDir(iid), 'local-tests');
    mkdirSync(dir, { recursive: true });
    const specsFile = join(dir, 'specs.json');
    // The object form: the list, and the specs set aside as needing what a
    // local machine does not have, which the script reports and does not run.
    writeFileSync(specsFile, `${JSON.stringify({ specs, notRunnable }, null, 2)}\n`);

    const startedAt = Date.now();
    updateJournal(iid, { localTests: { wt: localTestsWorktree(iid), startedAt } });
    const res = await runLocalTests({
      iid,
      worktree,
      ref: ticketSha,
      specsFile,
      patch: cap.patchSha ? cap.patchFile : undefined,
      patchSha: cap.patchSha ?? undefined,
      automationSha: cap.automationSha,
      base: `origin/${projectConfig().branches.base || 'dev'}`,
      deadlineMin: cfg.maxRunMinutes,
      signal: ctx.signal,
      onSpawn: (pid) => { updateJournal(iid, { localTests: { wt: localTestsWorktree(iid), pids: [pid], startedAt } }); },
    }, deps);

    if (!res.ok) {
      // A stop the conductor asked for is not a result: nothing is recorded,
      // and the next pass runs it again. A script stopped by anything else is
      // an error like any other.
      if (res.error.code === 'E_ABORTED' && ctx.signal?.aborted) {
        return { ok: false, error: `local-tests-run: ${res.error.message}` };
      }
      // A busy desk is not a result either: parked, like a held lease, and
      // the next tick tries again. The script cleaned up after itself before
      // it said so, so there is nothing for gc to clear.
      if (deskBusy(res.error)) {
        clean = true;
        return {
          ok: false,
          park: true,
          error: `local-tests-run: the desk is busy — ${cliErrorText(res.error)} — parked, and tried again on a later tick`,
        };
      }
      return setupError(cliErrorText(res.error), ticketSha, key);
    }
    clean = true;
    const run: LocalTestsRun = {
      ...res.data, cacheKey: key, ticketSha, automationSha: cap.automationSha, patchSha: cap.patchSha,
    };
    return verdict(settle(iid, run, saved), cfg);
  } catch (err) {
    // Nothing above should throw, but a code phase that does escapes the run
    // loop without finish(), and the ticket is left 'running' with no note.
    clean = false;
    return setupError(`local-tests-run failed unexpectedly: ${(err as Error).message.slice(0, 200)}`, ticketSha, key);
  } finally {
    deps.lease.release(ctx.runId);
    updateJournal(iid, { localTests: undefined });
    if (!clean) await gcLocalTests(deps.activeIids().filter((n) => n !== iid), deps);
  }
}

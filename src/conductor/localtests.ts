/**
 * The local automation tests, on the conductor's side: the plumbing the
 * post-merge local automation tests mode (src/localtests/runner.ts) drives.
 *
 * Two halves share this file. The scope half serves the `local-tests-scope`
 * session, which picks the workstream-automation specs a merged change
 * reaches and may edit specs in a throwaway automation worktree: the
 * conductor checks that worktree out before the session (`prepare-scope`)
 * and, the moment it ends, saves the edits as a patch and removes it
 * (`capture`). The run half is plain code: it runs exactly the list QA
 * approved against the merge commit, on a copy of the automation database
 * (`run`), under the desk's Cypress lease. Neither half knows a journal: the
 * mode records what each call holds in its own, so nothing here reads or
 * writes the Loop's state/runs/<iid>/run.json.
 *
 * Everything that touches Postgres, the automation clone, the credentials or
 * Cypress lives in scripts/localtests.cjs, which this file only starts. Its
 * contract is small on purpose: one JSON object on stdout, and on a non-zero
 * exit that object is `{code, message, hint}`. Logs go to stderr and are
 * forwarded to the conductor's log. No session may start that script
 * (git-guard), so every call to it goes through here.
 *
 * Three rules shape the run, and each is the answer to a way this step could
 * mislead whoever reads its results:
 *
 *   - It is idempotent by cache key — the specs, the merge commit, the
 *     automation commit and the patch — within ONE request (the mode's run
 *     id). A mode that crashed between a finished run and its journal write
 *     gets the saved results instead of another forty minutes of Cypress. A
 *     new request never does: QA putting the trigger back on is asking for the
 *     tests to run again, and an old result posted as new would say Cypress
 *     ran when it did not. A setup error is NOT reused either: the mode puts
 *     the list back to QA after one, and their next `approved` means "try
 *     again".
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
 * whole run with a fake script, a fake lease and a fake GitLab.
 */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import {
  DRY_RUN, ONESHOT_HOME, ROOT, RUNS, artifactDir, localTestsConfig, localTestsPatchFile,
  type LocalTestsConfig,
} from '../lib/config.js';
import { readArtifact, writeArtifact } from '../lib/artifacts.js';
import {
  RUN_KILL_GRACE_MS, acquireCypressLease, cypressLeaseHolder, localTestsRunDeadlineMs, releaseCypressLease,
} from '../lib/cypresslease.js';
import { activeRunsFleet } from '../lib/db.js';
import { addIssueNote, issueNotes } from '../lib/gitlab.js';
import { localTestsStartNote } from '../lib/publish.js';
import { log } from '../lib/log.js';
import { heldLtIids } from '../localtests/journal.js';
import type { LocalTestsRun } from '../phases/types.js';

const execFileP = promisify(execFile);

/** The script every call here starts. */
export const LOCAL_TESTS_SCRIPT = join(ROOT, 'scripts', 'localtests.cjs');

export const SCOPE_ARTIFACT = 'local-tests-scope.json';
export const RUN_ARTIFACT = 'local-tests-run.json';

/** The marker localTestsStartNote() ends with, so a start note is posted once per run of the same code. */
const START_MARKER = '<!-- oneshot:local-tests-start -->';

/**
 * The line announce() adds under the start note: which request it announced.
 * A new request on the same code is a new run, and is announced again.
 */
const startRunMarker = (runId: string): string => `<!-- oneshot:local-tests-start:${runId} -->`;

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
const findingList = (v: unknown): WeakenedFinding[] =>
  (Array.isArray(v) ? v : [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x) => ({ file: str(x.file).trim(), why: str(x.why).trim() }))
    .filter((x) => x.file !== '');

export interface PrepareScopeResult { wsa: string; automationSha: string }

/** The answer to `capture`: the patch the scope's edits were saved as, and what they did. */
/** One reason capture flagged a file: what the change did to it. */
export interface WeakenedFinding { file: string; why: string }

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
  /** Files whose change made an existing test easier to pass, or reaches outside the browser. */
  weakened: string[];
  /** Why each of those was flagged, one entry per finding (`adds cy.exec(`, `removes an expect( assertion`). */
  weakenedDetail: WeakenedFinding[];
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
 * end to end without Postgres, Cypress, GitLab or the desk's lease.
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
  config(): LocalTestsConfig;
  /**
   * The tickets whose local-tests resources are in use on this desk, for gc's
   * --keep: every ticket the mode is advancing (its per-ticket lock is held)
   * and, so nothing of theirs is ever touched, every Loop run in flight.
   */
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
    config: () => localTestsConfig(),
    activeIids: () => [...new Set([...heldLtIids(), ...activeRunsFleet().map((r) => r.iid)])],
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
      weakenedDetail: findingList(d.weakenedDetail),
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
 * it. A dry run usually makes no copy to clean up anyway: it starts no Cypress
 * unless ONESHOT_LOCAL_TESTS_DRY_CYPRESS asks it to, and then the script's own
 * cleanup drops what that run made.
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
  /** The ERP commits the scope was chosen for: the merge commit's first parent, and the merge commit. */
  base: string;
  head: string;
}

/** The scope session's inputs that only the conductor can know. Passed into its prompt. */
export interface ScopeInputs {
  /** The throwaway automation worktree, <runDir>/wsa. */
  wsa: string;
  automationSha: string;
  /** The first parent of the merge commit under test. */
  base: string;
  /** The merge commit. */
  head: string;
  /** Where the edits will be saved — and where the previous round's are, on a redo. */
  patchFile: string;
  /**
   * What QA asked of this round, when it is not the first: `write-temporary`
   * (no existing spec reaches the change, and QA wants one written for this
   * run only) or `feedback` (QA's `disapproved:` text, in `feedback`). Absent,
   * the session writes no test of its own: an uncovered change comes back as
   * an empty list with an `add` proposal, and QA decides.
   */
  request?: 'write-temporary' | 'feedback';
  feedback?: string;
  /** The merge commit and the MR that made it, named in the prompt. */
  mergeSha?: string;
  mrIid?: number;
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
    weakenedDetail: findingList(c.weakenedDetail),
    addedSpecs: strList(c.addedSpecs),
    removedSpecs: strList(c.removedSpecs),
    automationSha: c.automationSha,
    base: str(c.base),
    head: str(c.head),
  };
}

/**
 * Files to put in front of QA as weakened tests: what capture flagged as
 * weakened, and every changed file outside localTests.allowedPaths. A change
 * where no change was allowed is a test nobody can vouch for.
 */
export function weakenedFiles(capture: ScopeCapture | null): string[] {
  return capture ? [...new Set([...capture.weakened, ...capture.outsideAllowed])] : [];
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
 * Before a `local-tests-scope` session: check out the throwaway automation
 * worktree for the scope of `base..head` (the merge commit's first parent and
 * the merge commit). Records nothing: the mode writes the worktree into its own
 * journal, and gc keeps it while the ticket's lock is held, so a mode killed
 * mid-session still has it cleaned up afterwards.
 */
export async function prepareScopeAt(
  iid: number, commits: { base: string; head: string }, over: Partial<LocalTestsDeps> = {},
): Promise<CliResult<ScopeInputs>> {
  const deps = withDefaults(over);
  if (!commits.base || !commits.head) return fail('E_GIT', 'the scope needs both the merge commit and its first parent');
  const prep = await prepareScope(iid, deps.config(), deps);
  if (!prep.ok) return prep;
  return {
    ok: true,
    data: { ...prep.data, base: commits.base, head: commits.head, patchFile: localTestsPatchFile(iid) },
  };
}

/**
 * After a `local-tests-scope` session, whatever it concluded.
 *
 * The throwaway worktree is always captured, which saves the edits and removes
 * it: a scope that blocked or failed still leaves nothing on the desk. Then,
 * for a scope that finished:
 *
 *   - nothing to run: returned as it is. That is the "no automation test
 *     reaches this change" answer, and its `add` proposal is the suggested
 *     test QA reads; there is no patch worth keeping for a list of nothing;
 *   - something to run: the capture is written into the scope as `capture`,
 *     where the run reads the patch and the commit it was cut against;
 *   - something to run but the edits could not be saved: a refusal, because
 *     running the specs without the edits the list depends on would report
 *     failures the list already explained.
 */
export async function captureScopeSession(
  iid: number,
  out: { ok: boolean; data: Record<string, unknown> | null },
  inputs: ScopeInputs,
  over: Partial<LocalTestsDeps> = {},
): Promise<{ data: Record<string, unknown> | null; refusal: string | null }> {
  const deps = withDefaults(over);
  const captured = await captureScope(iid, deps);
  if (!captured.ok) log.warn(`local-tests-scope: capture failed — ${cliErrorText(captured.error)}`);
  if (!out.ok || !out.data) return { data: out.data, refusal: null };

  const scope = out.data;
  if (specFiles(scope).length === 0) return { data: scope, refusal: null };
  if (!captured.ok) {
    return {
      data: scope,
      refusal: `the temporary spec changes could not be saved (${cliErrorText(captured.error)}), `
        + 'so the listed tests cannot be run as chosen',
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
  return { data, refusal: null };
}

// --------------------------------------------------------------- the run

/**
 * Codes the script uses for "the desk is busy — try again later", none of
 * which says anything about the ticket's code: the step's ports held by
 * another run's app or Cypress, another run of this ticket's script still
 * alive (left behind by a conductor that died), or sessions connected to the
 * baseline database. See deskBusy.
 */
export const BUSY_CODES: ReadonlySet<string> = new Set(['E_PORT_BUSY', 'E_RUN_IN_PROGRESS', 'E_BASELINE_BUSY']);

/** A directory the script runs things in: state/runs/<iid>/<one of its checkouts>. */
const RUN_CHECKOUT = /[\\/]runs[\\/]\d+[\\/](?:erp-lt|erp-base-lt|wsa-run|wsa)(?:[\\/]|\s|$)/;

/**
 * Whether a script error means the desk is busy, so the run PARKS — nothing
 * recorded, nothing posted, and the next tick tries again — the same answer a
 * held Cypress lease gets. Recorded as an error instead, it would read on the
 * ticket as "could not be run" for a ticket that merely came second.
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

/** local-tests-run.json: the run, and the request (the mode's run id) it was made for. */
export type RecordedRun = LocalTestsRun & { runId?: string };

/**
 * Whether a saved run answers for `key` without running again: only results,
 * and only the same request's. Within one request (one run id) it is the run
 * a crash interrupted before the journal heard of it, so it is not run twice.
 * A new request — the trigger put back after Done, or a new dry rehearsal —
 * asked for the tests to run again, so its results must come from Cypress,
 * never from the file an earlier request left behind; a run recorded with no
 * run id belongs to no request and is never reused. A setup error is not reused — the mode puts
 * the list back to QA after one, and their next `approved` asks for another
 * try, not for the same error.
 */
function reusable(saved: RecordedRun | null, key: string, runId: string): saved is RecordedRun {
  return !!saved && !!key && !!runId && saved.runId === runId && saved.cacheKey === key
    && (saved.status === 'passed' || saved.status === 'failed');
}

/** A run that started no Cypress. */
function notRun(
  status: 'skipped' | 'error', reason: string,
  key: { cacheKey: string; ticketSha: string; automationSha: string; patchSha: string | null },
  notRunnable: LocalTestsRun['notRunnable'] = [],
): LocalTestsRun {
  const now = new Date().toISOString();
  return {
    status, reason, ...key, db: '',
    totals: { specs: 0, tests: 0, passed: 0, failed: 0, skipped: 0 },
    results: [], notRunnable, newTests: [], startedAt: now, endedAt: now,
  };
}

/**
 * Post the start note, once per request and code: a note already carrying the
 * marker, this request's run id and both commits means this run was announced
 * before a restart. A new request on the same code runs again, so it is
 * announced again. When GitLab cannot list the notes it is posted anyway — a
 * duplicate line costs less than a forty-minute run nobody was told about.
 */
async function announce(
  iid: number, runId: string,
  run: { tests: number; minutes: number; branch: string; ticketSha: string; automationSha: string },
  cfg: Pick<LocalTestsConfig, 'automationRef'>, deps: LocalTestsDeps,
): Promise<void> {
  const shas = [run.ticketSha.slice(0, 7), run.automationSha.slice(0, 7)];
  const mine = startRunMarker(runId);
  const bodies = await deps.notes.list(iid);
  if (bodies?.some((b) => b.includes(START_MARKER) && b.includes(mine) && shas.every((s) => b.includes(s)))) return;
  const ok = await deps.notes.add(iid, `${localTestsStartNote({ ...run, automationRef: cfg.automationRef })}\n${mine}`);
  if (!ok) log.warn(`local tests: could not post the start note on #${iid}`);
}

/** One approved list, ready to run against the merge commit. */
export interface ApprovedRun {
  iid: number;
  /**
   * The mode's run id for this request: who holds the desk's Cypress lease
   * while this runs, and what the recorded run is stamped with, so a saved run
   * is reused only by the request that made it.
   */
  runId: string;
  /** The ERP clone the script cuts its own detached checkout (erp-lt) from: WORK_REPO. */
  erpRepo: string;
  /** The merge commit the specs run against. */
  ref: string;
  /** Its first parent: where a spec that failed twice is re-run, to say whether it fails there too. */
  base: string;
  specs: string[];
  notRunnable: Array<{ spec: string; why: string }>;
  /** The automation commit the list, and its patch, are true of. */
  automationSha: string;
  patchFile: string | null;
  patchSha: string | null;
  /** For the start note: what the code is, how many tests, and about how long. */
  code: string;
  tests: number;
  minutes: number;
  /** DRY_RUN only: run Cypress anyway (ONESHOT_LOCAL_TESTS_DRY_CYPRESS). Every GitLab write stays a log line. */
  dryCypress?: boolean;
  signal?: AbortSignal;
  /** Called once with the script's pid, so the mode can record what it is holding. */
  onSpawn?: (pid: number) => void;
}

/**
 * What one attempt at an approved list came to:
 *   ran      the specs ran (passed or failed) — or a dry run started no Cypress, `skipped`;
 *   error    a setup error: the run could not happen, and the script says why;
 *   park     the desk is busy (the lease, or the script) — nothing recorded, try next tick;
 *   stopped  the conductor asked this run to stop — nothing recorded, try on the next boot.
 */
export type ApprovedRunResult =
  | { kind: 'ran'; run: LocalTestsRun; reused: boolean }
  | { kind: 'error'; run: LocalTestsRun }
  | { kind: 'park'; why: string }
  | { kind: 'stopped'; why: string };

/**
 * Run exactly the list QA approved, against the merge commit.
 *
 * In order: an identical earlier run of this same request is reused; a dry run starts nothing
 * unless asked to (`dryCypress`); a list with nothing runnable records why; a
 * busy desk parks; and only then is anything announced, written or started. A
 * script that finds the desk busy parks too, with nothing recorded. The lease
 * is released whatever happens after it was taken, and a run that did not
 * finish cleanly is followed by a gc for this ticket, because whatever it left
 * — a database copy, a worktree, a browser — would otherwise wait for the next
 * tick's gc. The result is written to state/runs/<iid>/local-tests-run.json,
 * stamped with the request's run id, where the report and the cache read it.
 */
export async function runApprovedTests(
  o: ApprovedRun, over: Partial<LocalTestsDeps> = {},
): Promise<ApprovedRunResult> {
  const deps = withDefaults(over);
  const cfg = deps.config();
  const { iid } = o;
  const key = cacheKey({ specs: o.specs.map((file) => ({ file })), notRunnable: o.notRunnable },
    o.ref, o.automationSha, o.patchSha, cfg);
  const keyed = { cacheKey: key, ticketSha: o.ref, automationSha: o.automationSha, patchSha: o.patchSha };
  const saved = readArtifact<RecordedRun>(iid, RUN_ARTIFACT);
  const record = (run: LocalTestsRun): RecordedRun => {
    const stamped: RecordedRun = { ...run, runId: o.runId };
    writeArtifact(iid, RUN_ARTIFACT, stamped);
    return stamped;
  };
  const setupError = (reason: string): ApprovedRunResult =>
    ({ kind: 'error', run: record(notRun('error', reason, keyed, o.notRunnable)) });

  if (reusable(saved, key, o.runId)) {
    log.info(`local tests — reusing the results of an identical run of this request on #${iid}`, {
      status: saved.status, passed: saved.totals?.passed, failed: saved.totals?.failed,
    });
    return { kind: 'ran', run: saved, reused: true };
  }
  if (deps.dryRun && !o.dryCypress) {
    return { kind: 'ran', run: record(notRun('skipped', 'a dry run starts no Cypress', keyed, o.notRunnable)), reused: false };
  }
  if (!o.specs.length) {
    const why = o.notRunnable.length
      ? 'every approved test needs something a local machine does not have' : 'the approved list has no tests to run';
    return { kind: 'ran', run: record(notRun('skipped', why, keyed, o.notRunnable)), reused: false };
  }
  if (!o.ref || !o.base) return setupError('the merge commit or its first parent is not known, so there is nothing to run against');

  if (!await deps.lease.acquire(o.runId)) {
    const holder = deps.lease.holder();
    return {
      kind: 'park',
      why: `another run${holder ? ` (${holder.runId})` : ''} is using Cypress on this desk — tried again on a later tick`,
    };
  }

  let clean = false;
  try {
    await announce(iid, o.runId, {
      tests: o.tests, minutes: o.minutes || cfg.maxRunMinutes, branch: o.code, ticketSha: o.ref,
      automationSha: o.automationSha,
    }, cfg, deps);

    const dir = join(artifactDir(iid), 'local-tests');
    mkdirSync(dir, { recursive: true });
    const specsFile = join(dir, 'specs.json');
    // The object form: the list, and the specs set aside as needing what a
    // local machine does not have, which the script reports and does not run.
    writeFileSync(specsFile, `${JSON.stringify({ specs: o.specs, notRunnable: o.notRunnable }, null, 2)}\n`);

    const res = await runLocalTests({
      iid,
      worktree: o.erpRepo,
      ref: o.ref,
      specsFile,
      patch: o.patchSha && o.patchFile ? o.patchFile : undefined,
      patchSha: o.patchSha ?? undefined,
      automationSha: o.automationSha,
      base: o.base,
      deadlineMin: cfg.maxRunMinutes,
      signal: o.signal,
      onSpawn: o.onSpawn,
    }, deps);

    if (!res.ok) {
      // A stop the conductor asked for is not a result: nothing is recorded,
      // and the list runs again once the conductor is back.
      if (res.error.code === 'E_ABORTED' && o.signal?.aborted) return { kind: 'stopped', why: res.error.message };
      // A busy desk is not a result either: parked, like a held lease. The
      // script cleaned up after itself before it said so.
      if (deskBusy(res.error)) {
        clean = true;
        return { kind: 'park', why: `the desk is busy — ${cliErrorText(res.error)} — tried again on a later tick` };
      }
      return setupError(cliErrorText(res.error));
    }
    clean = true;
    const run = record({ ...res.data, ...keyed });
    return run.status === 'error' ? { kind: 'error', run } : { kind: 'ran', run, reused: false };
  } catch (err) {
    clean = false;
    return setupError(`the local run failed unexpectedly: ${(err as Error).message.slice(0, 200)}`);
  } finally {
    deps.lease.release(o.runId);
    if (!clean) await gcLocalTests(deps.activeIids().filter((n) => n !== iid), deps);
  }
}

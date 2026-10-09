/**
 * The local-tests step on the conductor's side, driven end to end with a fake
 * scripts/localtests.cjs, a fake Cypress lease and a fake GitLab — no
 * Postgres, no Cypress, no network, and the desk's real lease is never touched.
 *
 * What these pin, in the order a run meets them:
 * - The scope session's throwaway worktree is always captured; a plan with
 *   specs gets the capture and the label, a plan with none is written back as
 *   not applicable, and edits that could not be saved refuse the plan.
 * - The localSpecs gate arms only for a proposal or a weakened test, and never
 *   for a plan with nothing to run.
 * - local-tests-run: an identical earlier run is reused — a setup error that
 *   would only repeat included — a dry run starts nothing, a busy desk parks
 *   before anything is announced (and a script that finds the desk busy parks
 *   with nothing recorded), a script past its deadline has its whole process
 *   group killed, and a setup error is recorded with the script's own words
 *   and warns rather than blocking — unless the team's failuresBlock turns
 *   failing tests into a stop.
 * - Past mr, nothing new starts unless an MR review round re-planned it, and a
 *   run the step was switched on under skips both phases quietly.
 *
 * Journals and artifacts live under state/runs/<iid> with iids in the reserved
 * 990000+ band, removed afterwards.
 */
import '../lib/test-project-env.js';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  afterScopeSession, cacheKey, captureOf, deskBusy, gcLocalTests, killLiveLocalTests, lateForLocalTests,
  localResultsSubject,
  localSpecsGate, localTestsRunPhase, noNewRunReason, normaliseRun, notRunnableOf, parseCliObject,
  prepareScopeSession, runCli, runDeadlineMs, runSkipReason, secretRedactor, specFiles, weakenedFiles,
  type CliDeps, type LocalTestsDeps, type ScopeInputs,
} from './localtests.js';
import { localSpecsGateReason } from './reviewgate.js';
import { codePhaseStatus, type CodePhaseCtx } from './runner.js';
import { RUNS, artifactDir, localTestsPatchFile, runDir, type LocalTestsConfig, type PhaseConfig } from '../lib/config.js';
import { readArtifact, readJournal, writeArtifact, writeJournal, type RunJournal } from '../lib/artifacts.js';
import type { LocalTestsRun } from '../phases/types.js';

const TICKET_SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const AUTO_SHA = 'c'.repeat(40);
const PATCH_SHA = 'd'.repeat(40);

const used = new Set<number>();
let nextIid = 990801;
const freshIid = (): number => {
  const iid = nextIid++;
  used.add(iid);
  rmSync(runDir(iid), { recursive: true, force: true });
  return iid;
};
after(() => { for (const iid of used) rmSync(runDir(iid), { recursive: true, force: true }); });

const CFG: LocalTestsConfig = {
  enabled: true, off: null, repo: '/nowhere/workstream-automation', credsFile: '/nowhere/creds.json',
  baselineDb: 'hrdb_automation_baseline', pg: { host: '127.0.0.1', port: 5432, user: '' },
  dbPrefix: 'oneshot_lt_', automationRef: 'origin/master',
  allowedPaths: ['cypress/Pages/', 'cypress/fixtures/', 'cypress/e2e/'],
  maxSpecs: 40, maxRunMinutes: 45, devApproval: 'any', failuresBlock: false,
};

// ------------------------------------------------------------- the fakes

class FakeChild extends EventEmitter {
  pid = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
}

/** Answer like the script: one JSON object on stdout, then exit. */
function reply(child: FakeChild, obj: unknown, code = 0, stderr = ''): void {
  child.stdout.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
  child.stderr.end(stderr);
  setImmediate(() => child.emit('close', code, null));
}

type Script = (args: string[], child: FakeChild) => void;

/**
 * A fake script. `run` is the test's; `gc`, `capture` and `prepare-scope`
 * answer as a healthy desk would unless the test overrides them. A group sent
 * SIGTERM exits, unless `ignoreTerm` — then only SIGKILL ends it, or nothing.
 */
function fakeCli(scripts: Partial<Record<string, Script>> = {}, o: { ignoreTerm?: boolean } = {}):
  CliDeps & { calls: Array<{ args: string[]; child: FakeChild }>; kills: Array<[number, string]> } {
  const calls: Array<{ args: string[]; child: FakeChild }> = [];
  const kills: Array<[number, string]> = [];
  const defaults: Record<string, Script> = {
    gc: (_a, c) => reply(c, { dropped: [], removed: [], killed: [] }),
    capture: (_a, c) => reply(c, captureAnswer()),
    'prepare-scope': (_a, c) => reply(c, { wsa: '/runs/x/wsa', automationSha: AUTO_SHA }),
    run: () => { /* never answers */ },
  };
  return {
    calls,
    kills,
    spawn(args) {
      const child = new FakeChild();
      calls.push({ args, child });
      const script = scripts[args[0] ?? ''] ?? defaults[args[0] ?? ''];
      setImmediate(() => script?.(args, child));
      return child;
    },
    kill(pid, signal) {
      kills.push([pid, signal]);
      const child = calls[calls.length - 1]?.child;
      if (signal === 'SIGTERM' && !o.ignoreTerm) setImmediate(() => child?.emit('close', null, 'SIGTERM'));
    },
  };
}

const captureAnswer = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  patchFile: '/runs/x/artifacts/local-tests/temporary-changes.patch', patchSha: PATCH_SHA,
  changedFiles: ['cypress/Pages/LeavePage.ts'], outsideAllowed: [], weakened: [], addedSpecs: [], removedSpecs: [],
  ...over,
});

interface World {
  deps: Partial<LocalTestsDeps>;
  cli: ReturnType<typeof fakeCli>;
  posted: string[];
  labels: string[];
  acquired: string[];
  released: string[];
}

function world(over: Partial<LocalTestsDeps> = {}, cli = fakeCli()): World {
  const w: World = { cli, posted: [], labels: [], acquired: [], released: [], deps: {} };
  w.deps = {
    cli,
    git: async (args) => (args[0] === 'rev-parse' ? TICKET_SHA : BASE_SHA),
    lease: {
      acquire: async (runId) => { w.acquired.push(runId); return true; },
      release: (runId) => { w.released.push(runId); },
      holder: () => null,
    },
    notes: { list: async () => w.posted, add: async (_iid, body) => { w.posted.push(body); return true; } },
    labels: { add: async (_iid, label) => { w.labels.push(label); return true; } },
    config: () => CFG,
    activeIids: () => [],
    dryRun: false,
    deadlineMs: runDeadlineMs,
    ...over,
  };
  return w;
}

// ------------------------------------------------------------ the fixtures

const SPECS = [
  { file: 'cypress/e2e/leaves/apply_leave.cy.ts', module: 'Leaves', cases: 6, ciSeconds: 90, why: 'opens the form' },
  { file: 'cypress/e2e/leaves/half_day.cy.ts', module: 'Leaves', cases: 3, ciSeconds: 40, why: 'same form' },
];

function scopeWith(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: '2 specs, 9 cases, about 4 min', blocked: null, applicable: true,
    reason: 'the diff changes the leave form', modules: ['Leaves'], specs: SPECS,
    edits: [], proposals: [], estimatedMinutes: 4,
    capture: { ...captureAnswer(), automationSha: AUTO_SHA, base: BASE_SHA, head: TICKET_SHA },
    ...over,
  };
}

function journalFor(iid: number, scopeStatus: RunJournal['phases'][number]['status'] = 'ok', error?: string): RunJournal {
  const j = {
    runId: `r-${iid}`, iid, title: 'Leave form', url: `https://gitlab.example.com/acme/erp/-/issues/${iid}`,
    createdAt: Date.now(), status: 'running', worktree: '/nowhere/erp-wt', branch: `oneshot/ticket-${iid}-leave`,
    phases: [{ phase: 'local-tests-scope', lap: 0, status: scopeStatus, startedAt: 1, endedAt: 2, ...(error ? { error } : {}) }],
    published: ['local-tests-scope'],
  } as RunJournal;
  writeJournal(j);
  return j;
}

/** A record for the journal, in the order given. */
const rec = (phase: string, status: RunJournal['phases'][number]['status']): RunJournal['phases'][number] =>
  ({ phase, lap: 0, status, startedAt: 1, endedAt: 2 });

/** The run's journal with these records after the scope's, as the runner would have appended them. */
function withRecords(iid: number, ...records: Array<RunJournal['phases'][number]>): RunJournal {
  const j = readJournal(iid)!;
  j.phases.push(...records);
  writeJournal(j);
  return j;
}

/** A run with a scope ready to run, on disk. */
function setup(scope = scopeWith(), scopeStatus: RunJournal['phases'][number]['status'] = 'ok'): { iid: number; ctx: CodePhaseCtx } {
  const iid = freshIid();
  const journal = journalFor(iid, scopeStatus);
  writeArtifact(iid, 'local-tests-scope.json', scope);
  return { iid, ctx: { iid, runId: journal.runId, journal, prior: {} } };
}

function runAnswer(over: Partial<LocalTestsRun> = {}): LocalTestsRun {
  return {
    status: 'failed', cacheKey: 'whatever-the-script-says', ticketSha: TICKET_SHA, automationSha: AUTO_SHA,
    patchSha: PATCH_SHA, db: 'oneshot_lt_1_1',
    totals: { specs: 2, tests: 9, passed: 8, failed: 1, skipped: 0 },
    results: [
      { spec: SPECS[0]!.file, title: 'applies a leave', state: 'passed', durationMs: 1000 },
      { spec: SPECS[1]!.file, title: 'applies a half day', state: 'failed', durationMs: 900, error: 'expected 0.5', failingOnDev: false },
    ],
    notRunnable: [], newTests: [], startedAt: '2026-10-09T10:00:00Z', endedAt: '2026-10-09T10:05:00Z',
    ...over,
  };
}

const keyOf = (scope = scopeWith()): string => cacheKey(scope, TICKET_SHA, AUTO_SHA, PATCH_SHA, CFG);
const published = (iid: number): string[] => readJournal(iid)?.published ?? [];

// ------------------------------------------------------ the run phase

test('an identical earlier run is reused: no lease, no note, no Cypress', async () => {
  const { iid, ctx } = setup();
  writeArtifact(iid, 'local-tests-run.json', runAnswer({ status: 'passed', cacheKey: keyOf() }));
  const w = world();

  const out = await localTestsRunPhase(ctx, w.deps);

  assert.equal(out.ok, true);
  assert.equal((out.data as unknown as LocalTestsRun).cacheKey, keyOf());
  assert.deepEqual(w.cli.calls, [], 'nothing was started');
  assert.deepEqual(w.acquired, [], 'the desk was not even asked for');
  assert.deepEqual(w.posted, []);
});

test('a new commit is a new run, not the saved one', async () => {
  const { iid, ctx } = setup();
  writeArtifact(iid, 'local-tests-run.json', runAnswer({ status: 'passed', cacheKey: keyOf() }));
  const w = world({ git: async () => 'e'.repeat(40) },
    fakeCli({ run: (_a, c) => reply(c, runAnswer({ status: 'passed' })) }));

  await localTestsRunPhase(ctx, w.deps);

  assert.equal(w.cli.calls.filter((c) => c.args[0] === 'run').length, 1);
});

test('a dry run records skipped and starts nothing', async () => {
  const { iid, ctx } = setup();
  const w = world({ dryRun: true });

  const out = await localTestsRunPhase(ctx, w.deps);

  assert.equal(out.ok, true);
  const run = readArtifact<LocalTestsRun>(iid, 'local-tests-run.json');
  assert.equal(run?.status, 'skipped');
  assert.match(run?.reason ?? '', /dry run/);
  assert.equal(run?.cacheKey, keyOf(), 'keyed, so a later real run is not mistaken for this one');
  assert.deepEqual(w.cli.calls, []);
  assert.deepEqual(w.acquired, []);
  assert.ok(!published(iid).includes('local-tests-run'), 'the one-line report still reaches the ticket');
});

test('a busy desk parks before anything is announced, written or started', async () => {
  const { iid, ctx } = setup();
  const w = world({
    lease: { acquire: async () => false, release: () => { throw new Error('nothing to release'); }, holder: () => ({ runId: 'r-other' }) },
  });

  const out = await localTestsRunPhase(ctx, w.deps);

  assert.equal(out.park, true);
  assert.equal(out.ok, false);
  assert.match(out.error ?? '', /r-other/);
  assert.deepEqual(w.cli.calls, []);
  assert.deepEqual(w.posted, [], 'no start note for a run that did not start');
  assert.equal(readArtifact(iid, 'local-tests-run.json'), null, 'no result recorded');
  assert.equal(codePhaseStatus({ name: 'local-tests-run', n: 7.6, kind: 'code', timeoutMin: 120, onFail: 'warn' }, out), 'parked');
});

test('a full run: announced once, the planned specs only, saved under the conductor\'s key', async () => {
  const { iid, ctx } = setup();
  const w = world({}, fakeCli({ run: (_a, c) => reply(c, runAnswer()) }));

  const out = await localTestsRunPhase(ctx, w.deps);

  assert.equal(out.ok, true, 'failing tests are the dev\'s call at the results gate, not a phase failure');
  const run = readArtifact<LocalTestsRun>(iid, 'local-tests-run.json');
  assert.equal(run?.status, 'failed');
  assert.equal(run?.cacheKey, keyOf(), 'the conductor\'s key, never the script\'s');
  assert.equal(run?.ticketSha, TICKET_SHA);
  assert.ok(!published(iid).includes('local-tests-run'), 'a new result is reported');

  const call = w.cli.calls.find((c) => c.args[0] === 'run')!;
  const arg = (flag: string): string | undefined => call.args[call.args.indexOf(flag) + 1];
  assert.equal(arg('--ref'), TICKET_SHA);
  assert.equal(arg('--worktree'), '/nowhere/erp-wt');
  assert.equal(arg('--automation-sha'), AUTO_SHA);
  assert.equal(arg('--patch'), captureAnswer().patchFile);
  assert.equal(arg('--patch-sha'), PATCH_SHA, 'the script refuses a patch file changed since capture');
  assert.equal(arg('--deadline-min'), '45');
  assert.equal(arg('--base'), 'origin/dev');
  const until = Number(arg('--until'));
  assert.ok(Math.abs(until - (Date.now() + runDeadlineMs(45))) < 60_000,
    'the script is told the conductor\'s own kill, as an absolute clock');
  assert.deepEqual(JSON.parse(readFileSync(arg('--specs-file')!, 'utf8')),
    { specs: SPECS.map((s) => s.file), notRunnable: [] });
  assert.equal(arg('--specs-file'), join(artifactDir(iid), 'local-tests', 'specs.json'));

  assert.equal(w.posted.length, 1);
  assert.match(w.posted[0]!, /<!-- oneshot:local-tests-start -->/);
  assert.match(w.posted[0]!, /9 tests/);
  assert.deepEqual(w.released, [ctx.runId], 'the lease goes back');
  assert.equal(readJournal(iid)?.localTests, undefined, 'nothing is recorded as held once it is done');
  assert.equal(w.cli.calls.filter((c) => c.args[0] === 'gc').length, 0, 'a clean run cleaned up after itself');

  // The same code again: the saved result, and no second start note.
  const again = await localTestsRunPhase({ ...ctx, journal: readJournal(iid)! }, w.deps);
  assert.equal(again.ok, true);
  assert.equal(w.cli.calls.filter((c) => c.args[0] === 'run').length, 1);
  assert.equal(w.posted.length, 1);
});

test('a resumed run that was announced before a restart is not announced twice', async () => {
  const { ctx } = setup();
  const w = world({}, fakeCli({ run: (_a, c) => reply(c, runAnswer()) }));
  w.posted.push(`earlier start note @ \`${TICKET_SHA.slice(0, 7)}\` and \`${AUTO_SHA.slice(0, 7)}\`\n\n<!-- oneshot:local-tests-start -->`);

  await localTestsRunPhase(ctx, w.deps);

  assert.equal(w.posted.length, 1, 'the existing note for this code stands');
});

test('a scope that made no edits runs without a patch', async () => {
  const scope = scopeWith({ capture: { ...captureAnswer({ patchSha: null, changedFiles: [] }), automationSha: AUTO_SHA, base: BASE_SHA, head: TICKET_SHA } });
  const { ctx } = setup(scope);
  const w = world({}, fakeCli({ run: (_a, c) => reply(c, runAnswer({ status: 'passed' })) }));

  await localTestsRunPhase(ctx, w.deps);

  const args = w.cli.calls.find((c) => c.args[0] === 'run')!.args;
  assert.ok(!args.includes('--patch') && !args.includes('--patch-sha'));
});

test('a script stopped by anything but this run\'s own signal is recorded as an error', async () => {
  const { iid, ctx } = setup();
  const w = world({}, fakeCli({ run: (_a, c) => reply(c, { code: 'E_ABORTED', message: 'stopped by SIGTERM' }, 143) }));

  const out = await localTestsRunPhase(ctx, w.deps);

  assert.equal(out.ok, false);
  assert.equal(readArtifact<LocalTestsRun>(iid, 'local-tests-run.json')?.status, 'error');
});

test('a run past its deadline has its whole process group killed, and is recorded as not run', async () => {
  const { iid, ctx } = setup();
  const w = world({ deadlineMs: () => 30 });

  const out = await localTestsRunPhase(ctx, w.deps);

  assert.deepEqual(w.cli.kills[0], [-4242, 'SIGTERM'], 'the group, not the node at its top');
  assert.equal(out.ok, false);
  assert.ok(!out.park && !out.block, 'a setup failure warns: it costs the ticket its local run, not its MR');
  const run = readArtifact<LocalTestsRun>(iid, 'local-tests-run.json');
  assert.equal(run?.status, 'error');
  assert.match(run?.reason ?? '', /E_DEADLINE/);
  assert.deepEqual(w.released, [ctx.runId]);
  assert.equal(w.cli.calls.filter((c) => c.args[0] === 'gc').length, 1, 'what it left behind is cleared now');
  assert.equal(codePhaseStatus({ name: 'local-tests-run', n: 7.6, kind: 'code', timeoutMin: 120, onFail: 'warn' }, out), 'warned');
});

test('the conductor\'s own deadline is the script\'s plus a grace, never under the phase\'s timeoutMin', () => {
  assert.equal(runDeadlineMs(45), 60 * 60_000);
  // The script's deadline bounds each Cypress run, not the builds around it.
  assert.equal(runDeadlineMs(45, 120), 120 * 60_000);
  assert.equal(runDeadlineMs(150, 120), 165 * 60_000);
});

test('a group that ignores SIGTERM gets SIGKILL, and the caller is never held for ever', async () => {
  const cli = fakeCli({}, { ignoreTerm: true });
  const res = await runCli(['run'], { deadlineMs: 20, graceMs: 15 }, cli);

  assert.equal(res.ok, false);
  assert.equal(res.ok ? '' : res.error.code, 'E_DEADLINE');
  assert.deepEqual(cli.kills, [[-4242, 'SIGTERM'], [-4242, 'SIGKILL']]);
});

test('a stop the conductor asks for kills the run and records nothing', async () => {
  const { iid, ctx } = setup();
  const aborter = new AbortController();
  const w = world({}, fakeCli({ run: () => { setTimeout(() => aborter.abort(), 5); } }));

  const out = await localTestsRunPhase({ ...ctx, signal: aborter.signal }, w.deps);

  assert.equal(out.ok, false);
  assert.match(out.error ?? '', /asked this run to stop/);
  assert.deepEqual(w.cli.kills[0], [-4242, 'SIGTERM']);
  assert.equal(readArtifact(iid, 'local-tests-run.json'), null, 'the next pass runs it again');
  assert.deepEqual(w.released, [ctx.runId]);
});

test('a setup error is recorded in the script\'s own words, and warns', async () => {
  const { iid, ctx } = setup();
  const w = world({}, fakeCli({
    run: (_a, c) => reply(c, { code: 'E_MIGRATE_FAILED', message: 'leaves.0042 failed', hint: 'see the log' }, 3),
  }));

  const out = await localTestsRunPhase(ctx, w.deps);

  assert.equal(out.ok, false);
  assert.ok(!out.park && !out.block);
  const run = readArtifact<LocalTestsRun>(iid, 'local-tests-run.json');
  assert.equal(run?.status, 'error');
  assert.equal(run?.reason, 'E_MIGRATE_FAILED: leaves.0042 failed (see the log)');
  assert.ok(!published(iid).includes('local-tests-run'), 'the ticket is told why nothing ran');
  assert.match(out.error ?? '', /E_MIGRATE_FAILED/);
});

test('a setup error that would only repeat is reused on the next pass, not run again', async () => {
  const { iid, ctx } = setup();
  const w = world({}, fakeCli({ run: (_a, c) => reply(c, { code: 'E_MIGRATE_FAILED', message: 'leaves.0042 failed' }, 3) }));

  await localTestsRunPhase(ctx, w.deps);
  const before = readFileSync(join(runDir(iid), 'local-tests-run.json'), 'utf8');
  const again = await localTestsRunPhase({ ...ctx, journal: readJournal(iid)! }, w.deps);

  assert.equal(again.ok, false, 'still a warning');
  assert.ok(!again.park);
  assert.match(again.error ?? '', /E_MIGRATE_FAILED/);
  assert.equal(w.cli.calls.filter((c) => c.args[0] === 'run').length, 1, 'one run for one cache key');
  assert.equal(w.acquired.length, 1, 'the desk was not asked for again');
  assert.equal(readFileSync(join(runDir(iid), 'local-tests-run.json'), 'utf8'), before, 'nothing rewritten or re-posted');
});

test('a saved error that only said the desk was busy, or that the script was stopped, is run again', async () => {
  for (const reason of ['E_PORT_BUSY: port 8030 (Django) is held by pid 7', 'E_ABORTED: stopped by SIGTERM']) {
    const { iid, ctx } = setup();
    writeArtifact(iid, 'local-tests-run.json', runAnswer({ status: 'error', reason, cacheKey: keyOf() }));
    const w = world({}, fakeCli({ run: (_a, c) => reply(c, runAnswer({ status: 'passed' })) }));

    const out = await localTestsRunPhase(ctx, w.deps);

    assert.equal(out.ok, true, reason);
    assert.equal(w.cli.calls.filter((c) => c.args[0] === 'run').length, 1, reason);
    assert.equal(readArtifact<LocalTestsRun>(iid, 'local-tests-run.json')?.status, 'passed');
  }
});

test('a script that finds the desk busy parks the run: nothing recorded, the lease back, the next tick tries again', async () => {
  const busy = [
    { code: 'E_BASELINE_BUSY', message: '2 session(s) are connected to hrdb_automation_baseline', hint: 'close them' },
    { code: 'E_RUN_IN_PROGRESS', message: 'a local-tests run for this ticket is already running (pid 99)' },
    { code: 'E_PORT_BUSY', message: `port 8030 (Django) is held by pid 77 running from ${join(RUNS, '990001', 'erp-base-lt')}` },
  ];
  for (const answer of busy) {
    const { iid, ctx } = setup();
    const w = world({}, fakeCli({ run: (_a, c) => reply(c, answer, 3) }));

    const out = await localTestsRunPhase(ctx, w.deps);

    assert.equal(out.park, true, answer.code);
    assert.equal(out.ok, false);
    assert.match(out.error ?? '', new RegExp(answer.code));
    assert.equal(readArtifact(iid, 'local-tests-run.json'), null, `${answer.code}: no result recorded`);
    assert.deepEqual(w.released, [ctx.runId]);
    assert.equal(w.cli.calls.filter((c) => c.args[0] === 'gc').length, 0, 'the script cleaned up before it answered');
    assert.equal(codePhaseStatus({ name: 'local-tests-run', n: 7.6, kind: 'code', timeoutMin: 120, onFail: 'warn' }, out), 'parked');
  }
});

test('the ports held by something that is not a local-tests run are a person\'s to clear, and recorded', async () => {
  const { iid, ctx } = setup();
  const w = world({}, fakeCli({
    run: (_a, c) => reply(c, { code: 'E_PORT_BUSY', message: 'port 8030 (Django) is held by pid 77 running from /Users/dev/erp' }, 3),
  }));

  const out = await localTestsRunPhase(ctx, w.deps);

  assert.ok(!out.park);
  assert.equal(readArtifact<LocalTestsRun>(iid, 'local-tests-run.json')?.status, 'error');
});

test('a busy desk is told apart from a held port by the holder\'s directory', () => {
  const port = (cwd: string): { code: string; message: string } =>
    ({ code: 'E_PORT_BUSY', message: `port 9030 (webpack) is held by pid 5 running from ${cwd}` });
  assert.equal(deskBusy(port(join(RUNS, '1234', 'erp-lt'))), true);
  assert.equal(deskBusy(port('/elsewhere/oneshot/state/runs/1234/wsa-run')), true, 'another Oneshot home\'s run');
  assert.equal(deskBusy(port('/Users/dev/erp')), false);
  assert.equal(deskBusy(port('an unknown directory')), false);
  assert.equal(deskBusy({ code: 'E_RUN_IN_PROGRESS', message: 'x' }), true);
  assert.equal(deskBusy({ code: 'E_BASELINE_BUSY', message: 'x' }), true);
  assert.equal(deskBusy({ code: 'E_MIGRATE_FAILED', message: `in ${join(RUNS, '1', 'erp-lt')}` }), false);
});

test('past mr, nothing new starts: the saved result stands, and the desk is not asked for', async () => {
  const { iid, ctx } = setup();
  // Results for an older commit, then mr opened the MR.
  writeArtifact(iid, 'local-tests-run.json', runAnswer({ status: 'passed', cacheKey: 'an-older-commit' }));
  withRecords(iid, rec('local-tests-run', 'ok'), rec('mr', 'ok'), rec('merge', 'parked'));
  const w = world({}, fakeCli({ run: (_a, c) => reply(c, runAnswer()) }));

  const out = await localTestsRunPhase({ ...ctx, journal: readJournal(iid)! }, w.deps);

  assert.equal(out.ok, true);
  assert.equal((out.data as unknown as LocalTestsRun).cacheKey, 'an-older-commit');
  assert.deepEqual(w.cli.calls, [], 'no Cypress for an MR that is already open');
  assert.deepEqual(w.acquired, []);
  assert.deepEqual(w.posted, []);
});

test('past mr with nothing ever recorded: one quiet line in the artifact, none on the ticket', async () => {
  const { iid, ctx } = setup();
  withRecords(iid, rec('mr', 'ok'));
  const w = world();

  const out = await localTestsRunPhase({ ...ctx, journal: readJournal(iid)! }, w.deps);

  assert.equal(out.ok, true);
  const run = readArtifact<LocalTestsRun>(iid, 'local-tests-run.json');
  assert.equal(run?.status, 'skipped');
  assert.match(run?.reason ?? '', /MR step has already run/);
  assert.ok(published(iid).includes('local-tests-run'), 'quiet');
  assert.deepEqual(w.cli.calls, []);
});

test('an MR review round re-plans after mr, and its plan runs', async () => {
  const { iid, ctx } = setup();
  writeArtifact(iid, 'local-tests-run.json', runAnswer({ status: 'passed', cacheKey: 'an-older-commit' }));
  withRecords(iid, rec('local-tests-run', 'ok'), rec('mr', 'ok'), rec('implement', 'ok'), rec('local-tests-scope', 'ok'));
  const w = world({}, fakeCli({ run: (_a, c) => reply(c, runAnswer()) }));

  await localTestsRunPhase({ ...ctx, journal: readJournal(iid)! }, w.deps);

  assert.equal(w.cli.calls.filter((c) => c.args[0] === 'run').length, 1);
  assert.equal(readArtifact<LocalTestsRun>(iid, 'local-tests-run.json')?.cacheKey, keyOf());
});

test('which runs may start a new local run, judged from the journal alone', () => {
  const j = (...phases: Array<RunJournal['phases'][number]>): Pick<RunJournal, 'phases'> => ({ phases });
  assert.equal(noNewRunReason(j(rec('local-tests-scope', 'ok'))), null, 'before mr');
  assert.match(noNewRunReason(j(rec('local-tests-scope', 'ok'), rec('mr', 'ok'))) ?? '', /no new local run/);
  assert.equal(noNewRunReason(j(rec('local-tests-scope', 'ok'), rec('mr', 'failed'))), null, 'mr never settled');
  assert.equal(noNewRunReason(j(rec('mr', 'ok'), rec('local-tests-scope', 'warned'))), null, 're-planned since');
  assert.match(noNewRunReason(j(rec('mr', 'ok'), rec('local-tests-scope', 'skipped'))) ?? '', /no new local run/,
    'a skip is not a plan');
  assert.match(noNewRunReason(j(rec('mr', 'ok'), rec('local-tests-scope', 'ok'), rec('mr', 'ok'))) ?? '', /no new local run/,
    'the round\'s own mr has run since');
});

test('a run the step was switched on under skips both phases, quietly, unless the scope ever ran', async () => {
  const j = (...phases: Array<RunJournal['phases'][number]>): Pick<RunJournal, 'phases'> => ({ phases });
  assert.equal(lateForLocalTests(j(rec('implement', 'ok'))), null, 'mr has not run: the step applies');
  assert.match(lateForLocalTests(j(rec('mr', 'ok'), rec('merge', 'parked'))) ?? '', /switched on/);
  assert.match(lateForLocalTests(j(rec('mr', 'ok'), rec('local-tests-scope', 'skipped'))) ?? '', /switched on/,
    'the skip the runner recorded is not a run');
  assert.equal(lateForLocalTests(j(rec('local-tests-scope', 'ok'), rec('mr', 'ok'))), null);
  assert.equal(lateForLocalTests(j(rec('mr', 'ok'), rec('local-tests-scope', 'warned'))), null, 'an MR review round ran it');

  const iid = freshIid();
  const journal = { ...journalFor(iid), phases: [rec('mr', 'ok'), rec('merge', 'parked')] } as RunJournal;
  writeJournal(journal);
  const w = world();
  const out = await localTestsRunPhase({ iid, runId: journal.runId, journal, prior: {} }, w.deps);
  assert.equal(out.ok, true);
  assert.equal(readArtifact<LocalTestsRun>(iid, 'local-tests-run.json')?.status, 'skipped');
  assert.ok(published(iid).includes('local-tests-run'), 'no line on a ticket whose MR is already open');
  assert.deepEqual(w.cli.calls, []);
  assert.deepEqual(w.acquired, []);
});

test('the script\'s notes and a flaky pass are kept, so the ticket and the dev gate can show them', async () => {
  const { iid, ctx } = setup();
  const notes = ['the failures were not re-run on origin/dev: E_APP_FAILED: webpack exited 1'];
  const answer = runAnswer({
    results: [
      { spec: SPECS[0]!.file, title: 'applies a leave', state: 'passed', durationMs: 1000, flaky: true },
      { spec: SPECS[1]!.file, title: 'applies a half day', state: 'failed', durationMs: 900, failingOnDev: null },
    ] as LocalTestsRun['results'],
  });
  const w = world({}, fakeCli({ run: (_a, c) => reply(c, { ...answer, notes }) }));

  await localTestsRunPhase(ctx, w.deps);

  const run = readArtifact<LocalTestsRun & { notes?: string[] }>(iid, 'local-tests-run.json');
  assert.deepEqual(run?.notes, notes);
  assert.equal((run?.results[0] as { flaky?: boolean }).flaky, true);
  assert.equal('flaky' in run!.results[1]!, false, 'only a pass on the retry is flaky');
  const subject = localResultsSubject(run as unknown as Record<string, unknown>) as { results: Array<Record<string, unknown>> };
  assert.equal(subject.results[0]!.flaky, true, 'a pass that needed the retry is its own outcome to sign');
  assert.equal('flaky' in subject.results[1]!, false, 'a subject from before the flag still matches');
});

test('normaliseRun drops what is not the contract, and redacts credentials from free text', () => {
  const redact = secretRedactor({ GITLAB_TOKEN: 'glpat-abcdef123456', PATH: '/usr/bin:/bin', SHORT_TOKEN: 'abc' });
  const run = normaliseRun({
    status: 'error', reason: 'E_CLI: curl -H glpat-abcdef123456 failed', notes: ['ok', 7, '', 'used glpat-abcdef123456'],
    results: [{ spec: 'a', title: 't', state: 'failed', durationMs: 1, error: 'token glpat-abcdef123456', flaky: 'yes' }],
  }, redact)!;
  assert.equal(run.reason, 'E_CLI: curl -H *** failed');
  assert.deepEqual((run as { notes?: string[] }).notes, ['ok', 'used ***']);
  assert.equal(run.results[0]!.error, 'token ***');
  assert.equal('flaky' in run.results[0]!, false, 'only a real true is a flaky pass');
  assert.equal(redact('/usr/bin:/bin and abc'), '/usr/bin:/bin and abc', 'PATH and short values are not secrets');
  assert.equal('notes' in normaliseRun({ status: 'passed' })!, false);
});

test('a crash the conductor words itself from stderr never carries a credential', async () => {
  process.env.ONESHOT_TEST_FAKE_TOKEN = 'fake-secret-value-123';
  try {
    const crashed = await runCli(['run'], { deadlineMs: 1000 },
      fakeCli({ run: (_a, c) => reply(c, '', 1, 'Error: 401 for token fake-secret-value-123\n') }));
    assert.equal(crashed.ok ? '' : crashed.error.code, 'E_CLI');
    assert.doesNotMatch(crashed.ok ? '' : crashed.error.message, /fake-secret-value-123/);
    assert.match(crashed.ok ? '' : crashed.error.message, /token \*\*\*/);
  } finally {
    delete process.env.ONESHOT_TEST_FAKE_TOKEN;
  }
});

test('specs a local machine cannot run are handed to the script beside the list, and change the key', async () => {
  const notRunnable = [{ spec: SPECS[1]!.file, why: 'needs the mailbox' }, { spec: SPECS[1]!.file, why: 'dup' }, { why: 'no spec' }];
  const scope = scopeWith({ notRunnable });
  assert.deepEqual(notRunnableOf(scope), [{ spec: SPECS[1]!.file, why: 'needs the mailbox' }]);
  assert.equal(cacheKey(scopeWith({ notRunnable: [] }), TICKET_SHA, AUTO_SHA, PATCH_SHA, CFG), keyOf(),
    'a plan without the list keeps the key it always had');
  assert.notEqual(keyOf(scope), keyOf());

  const { ctx } = setup(scope);
  const w = world({}, fakeCli({ run: (_a, c) => reply(c, runAnswer({ status: 'passed' })) }));
  await localTestsRunPhase(ctx, w.deps);

  const call = w.cli.calls.find((c) => c.args[0] === 'run')!;
  const file = JSON.parse(readFileSync(call.args[call.args.indexOf('--specs-file') + 1]!, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(file, { specs: SPECS.map((s) => s.file), notRunnable: [{ spec: SPECS[1]!.file, why: 'needs the mailbox' }] });
  assert.match(w.posted[0] ?? '', /6 tests/, 'the start note counts only what will run');
});

test('a conductor that exits takes the script groups it started along, and only those still running', async () => {
  const cli = fakeCli();
  const pending = runCli(['run'], { deadlineMs: 60_000 }, cli);
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(killLiveLocalTests(), [4242]);
  assert.deepEqual(cli.kills, [[-4242, 'SIGTERM']], 'through the deps that started it, to the whole group');
  const res = await pending;
  assert.equal(res.ok, false);
  assert.deepEqual(killLiveLocalTests(), [], 'a finished group is not killed again');

  const done = fakeCli({ gc: (_a, c) => reply(c, { dropped: [], removed: [], killed: [] }) });
  await runCli(['gc'], { deadlineMs: 1000 }, done);
  assert.deepEqual(killLiveLocalTests(), []);
  assert.deepEqual(done.kills, []);
});

test('a script that says nothing usable is named as such, not trusted', async () => {
  const silent = await runCli(['run'], { deadlineMs: 1000 }, fakeCli({ run: (_a, c) => reply(c, 'Cypress 13.6\n', 0) }));
  assert.equal(silent.ok ? '' : silent.error.code, 'E_BAD_OUTPUT');

  const crashed = await runCli(['run'], { deadlineMs: 1000 },
    fakeCli({ run: (_a, c) => reply(c, '', 1, 'starting\nError: Cannot find module pg\n') }));
  assert.equal(crashed.ok ? '' : crashed.error.code, 'E_CLI');
  assert.match(crashed.ok ? '' : crashed.error.message, /Cannot find module pg/);

  const { ctx } = setup();
  const w = world({}, fakeCli({ run: (_a, c) => reply(c, { status: 'green' }) }));
  const out = await localTestsRunPhase(ctx, w.deps);
  assert.match(out.error ?? '', /E_BAD_OUTPUT/, 'an unknown status is not a run');
});

test('an unexpected throw inside the run is recorded, never left to escape the run loop', async () => {
  const { iid, ctx } = setup();
  const w = world({ notes: { list: async () => { throw new Error('socket hang up'); }, add: async () => true } });

  const out = await localTestsRunPhase(ctx, w.deps);

  assert.equal(out.ok, false);
  assert.match(readArtifact<LocalTestsRun>(iid, 'local-tests-run.json')?.reason ?? '', /socket hang up/);
  assert.deepEqual(w.released, [ctx.runId], 'the lease still goes back');
});

test('failing tests stop the run only when the team says they must', async () => {
  const { ctx } = setup();
  const strict = { ...CFG, failuresBlock: true };
  const w = world({ config: () => strict }, fakeCli({ run: (_a, c) => reply(c, runAnswer()) }));

  const out = await localTestsRunPhase(ctx, w.deps);

  assert.equal(out.block, true);
  assert.equal(out.ok, false);
  assert.match(out.error ?? '', /1 local automation test\(s\) failed/);
  assert.equal(codePhaseStatus({ name: 'local-tests-run', n: 7.6, kind: 'code', timeoutMin: 120, onFail: 'warn' }, out), 'failed',
    'recorded failed, so finish() names this phase as where the run stopped');

  const passing = setup();
  const w2 = world({ config: () => strict }, fakeCli({ run: (_a, c) => reply(c, runAnswer({ status: 'passed' })) }));
  assert.equal((await localTestsRunPhase(passing.ctx, w2.deps)).ok, true);
});

test('not applicable: skipped quietly, nothing started, and neither gate arms', async () => {
  const scope = scopeWith({ applicable: false, reason: 'only a management command changed', specs: [], capture: undefined });
  const { iid, ctx } = setup(scope);
  const w = world();

  const out = await localTestsRunPhase(ctx, w.deps);

  assert.equal(out.ok, true);
  const run = readArtifact<LocalTestsRun>(iid, 'local-tests-run.json');
  assert.equal(run?.status, 'skipped');
  assert.match(run?.reason ?? '', /only a management command changed/);
  assert.ok(published(iid).includes('local-tests-run'), 'the scope\'s own line already said it — no second line');
  assert.deepEqual(w.cli.calls, []);
  assert.deepEqual(w.acquired, []);
  assert.equal(localSpecsGate(readJournal(iid), scope, localSpecsGateReason), null);
  assert.equal(localResultsSubject(run as unknown as Record<string, unknown>), null);

  // Every later pass is the same answer: nothing rewritten, nothing re-posted.
  const before = readFileSync(join(runDir(iid), 'local-tests-run.json'), 'utf8');
  await localTestsRunPhase({ ...ctx, journal: readJournal(iid)! }, w.deps);
  assert.equal(readFileSync(join(runDir(iid), 'local-tests-run.json'), 'utf8'), before);
});

test('a scope that did not finish skips the run, and the ticket is told why', async () => {
  const iid = freshIid();
  const journal = journalFor(iid, 'warned', 'could not prepare the automation worktree — E_NO_REF: origin/master');
  const w = world();

  const out = await localTestsRunPhase({ iid, runId: journal.runId, journal, prior: {} }, w.deps);

  assert.equal(out.ok, true);
  const run = readArtifact<LocalTestsRun>(iid, 'local-tests-run.json');
  assert.equal(run?.status, 'skipped');
  assert.match(run?.reason ?? '', /E_NO_REF/);
  assert.ok(!published(iid).includes('local-tests-run'), 'unlike "not needed", this is news to the ticket');
});

test('the reasons a plan runs nothing are told apart', () => {
  const ok = journalFor(freshIid());
  assert.equal(runSkipReason(ok, scopeWith()), null);
  assert.match(runSkipReason(ok, scopeWith({ capture: undefined }))?.reason ?? '', /never saved/);
  assert.equal(runSkipReason(ok, scopeWith({ specs: [] }))?.quiet, true);
  assert.equal(runSkipReason(ok, scopeWith({ blocked: 'E_NO_MAP' }))?.quiet, false);
  assert.match(runSkipReason({ phases: [] }, scopeWith())?.reason ?? '', /has not run/);
  assert.equal(runSkipReason(ok, null)?.quiet, false);
});

// --------------------------------------------------- the localSpecs gate

test('the localSpecs gate arms only for a proposal or a weakened test', () => {
  const journal = journalFor(freshIid());
  const capture = (over: Record<string, unknown>): Record<string, unknown> =>
    ({ ...captureAnswer(over), automationSha: AUTO_SHA, base: BASE_SHA, head: TICKET_SHA });

  assert.equal(localSpecsGate(journal, scopeWith(), localSpecsGateReason), null,
    'specs chosen and run as they are need nobody\'s sign-off');

  const proposed = localSpecsGate(journal, scopeWith({
    proposals: [{ action: 'add', title: 'Verify that a half day can be cancelled', why: 'no spec covers it' }],
  }), localSpecsGateReason);
  assert.match(proposed?.why ?? '', /proposes a change/);

  const weakened = localSpecsGate(journal, scopeWith({ capture: capture({ weakened: ['cypress/e2e/leaves/half_day.cy.ts'] }) }),
    localSpecsGateReason);
  assert.match(weakened?.why ?? '', /half_day\.cy\.ts/);

  const outside = localSpecsGate(journal, scopeWith({ capture: capture({ outsideAllowed: ['cypress.config.ts'] }) }),
    localSpecsGateReason);
  assert.match(outside?.why ?? '', /cypress\.config\.ts/, 'a change where none was allowed counts as weakened');

  const notFinished = journalFor(freshIid(), 'warned', 'refused');
  assert.equal(localSpecsGate(notFinished, scopeWith({
    proposals: [{ action: 'remove', title: 'Trim to fit the limits: x', why: 'over' }],
  }), localSpecsGateReason), null, 'a plan that will not run asks nobody anything');
});

test('the localSpecs sign-off covers the list, the proposals and the patch it was given', () => {
  const journal = journalFor(freshIid());
  const proposals = [{ action: 'add', title: 'Verify that a half day can be cancelled', why: 'gap' }];
  const subject = (over: Record<string, unknown>): unknown =>
    localSpecsGate(journal, scopeWith({ proposals, ...over }), localSpecsGateReason)?.subject;

  assert.deepEqual(subject({ specs: [...SPECS].reverse() }), subject({}), 'order is not a change to the list');
  assert.notDeepEqual(subject({ specs: SPECS.slice(0, 1) }), subject({}));
  assert.notDeepEqual(subject({ capture: { ...captureAnswer({ patchSha: 'f'.repeat(40) }), automationSha: AUTO_SHA } }), subject({}));
  assert.notDeepEqual(subject({ proposals: [{ action: 'remove', title: 'x', why: 'y' }] }), subject({}));
});

test('the results gate judges results only, keyed to the code they ran against', () => {
  assert.equal(localResultsSubject(runAnswer({ status: 'skipped' }) as unknown as Record<string, unknown>), null);
  assert.equal(localResultsSubject(runAnswer({ status: 'error' }) as unknown as Record<string, unknown>), null);
  const a = localResultsSubject(runAnswer({ cacheKey: 'k1' }) as unknown as Record<string, unknown>);
  const b = localResultsSubject(runAnswer({ cacheKey: 'k1', startedAt: 'later', endedAt: 'later' }) as unknown as Record<string, unknown>);
  const c = localResultsSubject(runAnswer({ cacheKey: 'k2' }) as unknown as Record<string, unknown>);
  assert.deepEqual(a, b, 'the clock is not part of what was approved');
  assert.notDeepEqual(a, c);
});

// ------------------------------------------------------- the scope session

const INPUTS: ScopeInputs = {
  wsa: '/runs/x/wsa', automationSha: AUTO_SHA, base: BASE_SHA, head: TICKET_SHA, patchFile: '/runs/x/patch',
};

test('a plan with specs keeps its capture and labels the ticket', async () => {
  const iid = freshIid();
  journalFor(iid);
  const w = world();
  const session = scopeWith({ capture: undefined });

  const after = await afterScopeSession(iid, { ok: true, data: session }, INPUTS, w.deps);

  assert.equal(after.refusal, null);
  assert.deepEqual(w.cli.calls.map((c) => c.args), [['capture', '--iid', String(iid)]]);
  const onDisk = readArtifact<Record<string, unknown>>(iid, 'local-tests-scope.json');
  assert.deepEqual(captureOf(onDisk), { ...captureAnswer(), automationSha: AUTO_SHA, base: BASE_SHA, head: TICKET_SHA });
  assert.deepEqual(after.data, onDisk);
  assert.deepEqual(w.labels, ['TestCase Run Locally']);
  assert.equal(readJournal(iid)?.localTests, undefined, 'the worktree is gone, and the journal says so');
});

test('a plan that lists no specs is written back as not applicable, keeping what it suggested', async () => {
  const iid = freshIid();
  journalFor(iid);
  const w = world();
  const session = scopeWith({
    capture: undefined, specs: [], reason: 'the banner has no spec yet.',
    proposals: [{ action: 'add', title: 'Verify that the banner can be dismissed for a week.', why: 'gap' }],
  });

  const after = await afterScopeSession(iid, { ok: true, data: session }, INPUTS, w.deps);

  assert.equal(after.refusal, null);
  assert.equal(after.data?.applicable, false);
  assert.match(String(after.data?.reason), /the banner has no spec yet, but no spec was chosen to run\./);
  assert.match(String(after.data?.reason), /Verify that the banner can be dismissed for a week/);
  assert.equal(readArtifact<Record<string, unknown>>(iid, 'local-tests-scope.json')?.applicable, false);
  assert.deepEqual(w.labels, [], 'no local tests ran, so the ticket is not marked as having had them');
  assert.equal(w.cli.calls.length, 1, 'the throwaway worktree is still captured and removed');
});

test('a scope that made no edits is captured as no patch, and still runs', async () => {
  const iid = freshIid();
  journalFor(iid);
  // What capture prints when the worktree is clean, and the commit it was cut against.
  const w = world({}, fakeCli({
    capture: (_a, c) => reply(c, captureAnswer({ patchFile: null, patchSha: null, changedFiles: [], automationSha: 'f'.repeat(40) })),
  }));

  const after = await afterScopeSession(iid, { ok: true, data: scopeWith({ capture: undefined }) }, INPUTS, w.deps);

  assert.equal(after.refusal, null);
  const capture = captureOf(after.data);
  assert.equal(capture?.patchSha, null);
  assert.equal(capture?.patchFile, '');
  assert.equal(capture?.automationSha, 'f'.repeat(40), 'the commit capture names wins over prepare-scope\'s');
  assert.equal(runSkipReason(readJournal(iid), after.data), null, 'nothing about no edits stops the run');
});

test('edits that could not be saved refuse the plan, rather than run specs without them', async () => {
  const iid = freshIid();
  journalFor(iid);
  const w = world({}, fakeCli({ capture: (_a, c) => reply(c, { code: 'E_PATCH', message: 'git diff failed' }, 2) }));

  const after = await afterScopeSession(iid, { ok: true, data: scopeWith({ capture: undefined }) }, INPUTS, w.deps);

  assert.match(after.refusal ?? '', /E_PATCH: git diff failed/);
  assert.deepEqual(w.labels, []);
});

test('a blocked scope is still captured, and its own block stands', async () => {
  const iid = freshIid();
  journalFor(iid);
  const w = world();

  const after = await afterScopeSession(iid, { ok: false, data: scopeWith({ blocked: 'E_NO_MAP: modules map missing' }) }, INPUTS, w.deps);

  assert.equal(after.refusal, null);
  assert.equal(w.cli.calls.length, 1, 'captured, so nothing is left on the desk');
  assert.deepEqual(w.labels, []);
});

test('nothing prepared, nothing captured', async () => {
  const iid = freshIid();
  const w = world();
  const after = await afterScopeSession(iid, { ok: true, data: scopeWith() }, undefined, w.deps);
  assert.equal(after.refusal, null);
  assert.deepEqual(w.cli.calls, []);
});

test('preparing the scope reads the ticket\'s commits first, then checks out the worktree and records it', async () => {
  const iid = freshIid();
  journalFor(iid);
  const gitCalls: string[][] = [];
  const w = world({ git: async (args) => { gitCalls.push(args); return args[0] === 'rev-parse' ? TICKET_SHA : BASE_SHA; } });

  const prep = await prepareScopeSession(iid, '/nowhere/erp-wt', w.deps);

  assert.ok(prep.ok);
  assert.deepEqual(prep.ok && prep.data, {
    wsa: '/runs/x/wsa', automationSha: AUTO_SHA, base: BASE_SHA, head: TICKET_SHA, patchFile: localTestsPatchFile(iid),
  });
  assert.deepEqual(gitCalls, [['rev-parse', 'HEAD'], ['merge-base', 'HEAD', 'origin/dev']]);
  assert.deepEqual(w.cli.calls[0]?.args, ['prepare-scope', '--iid', String(iid), '--automation-ref', 'origin/master']);
  assert.equal(readJournal(iid)?.localTests?.wt, '/runs/x/wsa');

  const broken = world({ git: async () => { throw new Error('not a git repository'); } });
  const failed = await prepareScopeSession(iid, '/nowhere/erp-wt', broken.deps);
  assert.equal(failed.ok ? '' : failed.error.code, 'E_GIT');
  assert.deepEqual(broken.cli.calls, [], 'nothing checked out that would then need cleaning up');
});

// ------------------------------------------------------------ the rest

test('gc keeps every run in flight, and does nothing on a desk where the step is off', async () => {
  const w = world();
  const out = await gcLocalTests([990003, 990001, 990003], w.deps);
  assert.deepEqual(out, { dropped: [], removed: [], killed: [] });
  assert.deepEqual(w.cli.calls[0]?.args, ['gc', '--keep', '990001,990003']);

  // What the script really prints for a stopped process: its harnessProcesses objects.
  const stray = world({}, fakeCli({
    gc: (_a, c) => reply(c, {
      dryRun: false, dropped: [], removed: [], skipped: [], errors: [],
      killed: [
        { iid: 990002, kind: 'webpack', pid: 7001, port: 9030, dir: 'erp-lt' },
        { iid: 990002, kind: 'cypress', pid: 7002, port: null, dir: null },
        { kind: 'nonsense' }, 7003,
      ],
    }),
  }));
  assert.deepEqual((await gcLocalTests([], stray.deps))?.killed, [
    { iid: 990002, kind: 'webpack', pid: 7001 },
    { iid: 990002, kind: 'cypress', pid: 7002 },
  ], 'the kills are kept, not dropped as not-a-number');

  const none = world();
  await gcLocalTests([], none.deps);
  assert.deepEqual(none.cli.calls[0]?.args, ['gc']);

  const off = world({ config: () => ({ ...CFG, enabled: false, off: 'ONESHOT_LOCAL_TESTS_REPO is not set on this desk' }) });
  assert.equal(await gcLocalTests([1], off.deps), null);
  assert.deepEqual(off.cli.calls, []);

  // A dry run knows only its own runs, and the script drops copies server-wide.
  const dry = world({ dryRun: true });
  assert.equal(await gcLocalTests([], dry.deps), null);
  assert.deepEqual(dry.cli.calls, [], 'a dry run never clears what real runs hold');
});

test('the cache key is what ran, not how the list was written down', () => {
  const k = keyOf();
  assert.equal(cacheKey(scopeWith({ specs: [...SPECS].reverse() }), TICKET_SHA, AUTO_SHA, PATCH_SHA, CFG), k);
  assert.notEqual(cacheKey(scopeWith(), 'e'.repeat(40), AUTO_SHA, PATCH_SHA, CFG), k);
  assert.notEqual(cacheKey(scopeWith(), TICKET_SHA, 'e'.repeat(40), PATCH_SHA, CFG), k);
  assert.notEqual(cacheKey(scopeWith(), TICKET_SHA, AUTO_SHA, null, CFG), k);
  assert.notEqual(cacheKey(scopeWith(), TICKET_SHA, AUTO_SHA, PATCH_SHA, { ...CFG, baselineDb: 'other_baseline' }), k);
  assert.notEqual(cacheKey(scopeWith({ specs: SPECS.slice(1) }), TICKET_SHA, AUTO_SHA, PATCH_SHA, CFG), k);
});

test('the script\'s answer is read past any stray line printed before it', () => {
  assert.deepEqual(parseCliObject('warming up\n{"wsa":"/x"}\n'), { wsa: '/x' });
  assert.deepEqual(parseCliObject('{"a":1}'), { a: 1 });
  assert.equal(parseCliObject('[1,2]'), null);
  assert.equal(parseCliObject(''), null);
});

test('the plan helpers read only what is there', () => {
  assert.deepEqual(specFiles({ specs: [{ file: 'a' }, { file: 'a' }, { file: ' ' }, {}, null] }), ['a']);
  assert.deepEqual(specFiles(null), []);
  assert.equal(captureOf({ capture: { patchFile: 'p' } }), null, 'no automation commit, no capture to run from');
  assert.deepEqual(weakenedFiles(null), []);
});

test('both phases are configured as the pipeline expects', async () => {
  const raw = JSON.parse(readFileSync(new URL('../../config/phases.json', import.meta.url), 'utf8')) as { phases: PhaseConfig[] };
  const byName = (n: string): PhaseConfig => raw.phases.find((p) => p.name === n)!;
  const scope = byName('local-tests-scope');
  const run = byName('local-tests-run');
  assert.ok(byName('ui-evidence').n < scope.n && scope.n < run.n && run.n < byName('mr').n);
  assert.equal(scope.kind, 'session');
  assert.equal(scope.cwd, 'worktree');
  assert.deepEqual(scope.writes, ['run'], 'the throwaway worktree is inside the run directory, so this is enough');
  assert.equal(scope.onFail, 'warn');
  assert.deepEqual(scope.skills, ['local-tests-impact']);
  assert.equal(scope.group, undefined);
  assert.equal(run.kind, 'code');
  assert.equal(run.onFail, 'warn');
  assert.deepEqual(scope.targets, ['erp']);
  assert.deepEqual(run.targets, ['erp']);
  assert.ok(existsSync(new URL('../../skills/local-tests-impact/SKILL.md', import.meta.url)));
  const { CODE_PHASES } = await import('./runner.js');
  assert.ok(CODE_PHASES['local-tests-run'], 'registered, or the run would stop at it');
});

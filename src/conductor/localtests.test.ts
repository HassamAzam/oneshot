/**
 * The local automation tests' conductor plumbing, driven end to end with a
 * fake scripts/localtests.cjs, a fake Cypress lease and a fake GitLab — no
 * Postgres, no Cypress, no network, and the desk's real lease is never touched.
 *
 * What these pin, in the order the post-merge mode meets them:
 * - The scope session's throwaway worktree is always captured; a list with
 *   specs keeps the capture, a list of nothing is returned as it is (the "no
 *   test found" answer), and edits that could not be saved refuse the list.
 * - runApprovedTests: an identical earlier run of the same request is reused —
 *   never another request's, which asked for the tests to run again, and never
 *   a setup error, which QA's next `approved` retries — a dry run starts nothing unless
 *   asked to, a busy desk parks before anything is announced (and a script that
 *   finds the desk busy parks with nothing recorded), a script past its deadline
 *   has its whole process group killed, and a setup error is recorded with the
 *   script's own words. It runs against the merge commit, re-runs failures on
 *   its first parent, and keeps nothing in the Loop's journal.
 *
 * Artifacts live under state/runs/<iid> with iids in the reserved 990000+ band,
 * removed afterwards.
 */
import '../lib/test-project-env.js';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  cacheKey, captureOf, captureScopeSession, deskBusy, gcLocalTests, killLiveLocalTests, normaliseRun, notRunnableOf,
  parseCliObject, prepareScopeAt, runApprovedTests, runCli, runDeadlineMs, secretRedactor, specFiles, weakenedFiles,
  type ApprovedRun, type CliDeps, type LocalTestsDeps, type ScopeInputs,
} from './localtests.js';
import { RUNS, artifactDir, localTestsPatchFile, runDir, type LocalTestsConfig, type PhaseConfig } from '../lib/config.js';
import { readArtifact, readJournal, writeArtifact } from '../lib/artifacts.js';
import type { LocalTestsRun } from '../phases/types.js';

const MERGE_SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const AUTO_SHA = 'c'.repeat(40);
const PATCH_SHA = 'd'.repeat(40);
const WORK_REPO = '/nowhere/erp';

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
  labels: { trigger: 'Ready for Automation Testing', running: 'Running TestCases Locally', done: 'Automation Testing Done' },
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
  changedFiles: ['cypress/Pages/LeavePage.ts'], outsideAllowed: [], weakened: [], weakenedDetail: [], addedSpecs: [],
  removedSpecs: [],
  ...over,
});

interface World {
  deps: Partial<LocalTestsDeps>;
  cli: ReturnType<typeof fakeCli>;
  posted: string[];
  acquired: string[];
  released: string[];
}

function world(over: Partial<LocalTestsDeps> = {}, cli = fakeCli()): World {
  const w: World = { cli, posted: [], acquired: [], released: [], deps: {} };
  w.deps = {
    cli,
    git: async () => { throw new Error('nothing here asks git'); },
    lease: {
      acquire: async (runId) => { w.acquired.push(runId); return true; },
      release: (runId) => { w.released.push(runId); },
      holder: () => null,
    },
    notes: { list: async () => w.posted, add: async (_iid, body) => { w.posted.push(body); return true; } },
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
    reason: 'the merge changes the leave form', modules: ['Leaves'], specs: SPECS,
    edits: [], proposals: [], estimatedMinutes: 4,
    capture: { ...captureAnswer(), automationSha: AUTO_SHA, base: BASE_SHA, head: MERGE_SHA },
    ...over,
  };
}

/** An approved list, as the mode hands it over. */
function approved(iid: number, over: Partial<ApprovedRun> = {}): ApprovedRun {
  return {
    iid, runId: `l-${iid}`, erpRepo: WORK_REPO, ref: MERGE_SHA, base: BASE_SHA,
    specs: SPECS.map((s) => s.file), notRunnable: [], automationSha: AUTO_SHA,
    patchFile: captureAnswer().patchFile as string, patchSha: PATCH_SHA,
    code: 'dev (merge of !321)', tests: 9, minutes: 4,
    ...over,
  };
}

function runAnswer(over: Partial<LocalTestsRun> = {}): LocalTestsRun {
  return {
    status: 'failed', cacheKey: 'whatever-the-script-says', ticketSha: MERGE_SHA, automationSha: AUTO_SHA,
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

/** The key runApprovedTests computes for a list of these specs. */
const keyOf = (specs = SPECS.map((s) => s.file), patchSha: string | null = PATCH_SHA, notRunnable: Array<{ spec: string; why: string }> = []): string =>
  cacheKey({ specs: specs.map((file) => ({ file })), notRunnable }, MERGE_SHA, AUTO_SHA, patchSha, CFG);

const runCalls = (w: World): number => w.cli.calls.filter((c) => c.args[0] === 'run').length;

// ------------------------------------------------------ the approved run

test('an identical earlier run of the same request is reused: no lease, no note, no Cypress', async () => {
  const iid = freshIid();
  writeArtifact(iid, 'local-tests-run.json', { ...runAnswer({ status: 'passed', cacheKey: keyOf() }), runId: `l-${iid}` });
  const w = world();

  const res = await runApprovedTests(approved(iid), w.deps);

  assert.equal(res.kind, 'ran');
  assert.equal(res.kind === 'ran' && res.reused, true);
  assert.deepEqual(w.cli.calls, [], 'nothing was started');
  assert.deepEqual(w.acquired, [], 'the desk was not even asked for');
  assert.deepEqual(w.posted, []);
});

test('a new request on the same code runs Cypress again and announces it, never posting the old results as new', async () => {
  const iid = freshIid();
  // The first request's run, finished and recorded; its start note is on the ticket.
  writeArtifact(iid, 'local-tests-run.json', { ...runAnswer({ status: 'failed', cacheKey: keyOf() }), runId: 'l-first' });
  const w = world({}, fakeCli({ run: (_a, c) => reply(c, runAnswer({ status: 'passed' })) }));
  w.posted.push(`started @ \`${MERGE_SHA.slice(0, 7)}\` and \`${AUTO_SHA.slice(0, 7)}\`\n\n`
    + '<!-- oneshot:local-tests-start -->\n<!-- oneshot:local-tests-start:l-first -->');

  const res = await runApprovedTests(approved(iid, { runId: 'l-second' }), w.deps);

  assert.equal(res.kind === 'ran' && res.reused, false, 'the trigger put back asks for a new run');
  assert.equal(res.kind === 'ran' && res.run.status, 'passed', 'this request\'s own results');
  assert.equal(runCalls(w), 1);
  assert.deepEqual(w.acquired, ['l-second']);
  assert.equal(w.posted.length, 2, 'a new run is announced, though the code is the same');
  assert.match(w.posted[1]!, /<!-- oneshot:local-tests-start:l-second -->/);
  const saved = readArtifact<LocalTestsRun & { runId?: string }>(iid, 'local-tests-run.json');
  assert.equal(saved?.runId, 'l-second', 'stamped with the request that ran it');
  assert.equal(saved?.status, 'passed');

  // A repeat within that request — a crash after the run, before the journal heard — reuses it.
  const again = await runApprovedTests(approved(iid, { runId: 'l-second' }), w.deps);
  assert.equal(again.kind === 'ran' && again.reused, true);
  assert.equal(runCalls(w), 1);
  assert.equal(w.posted.length, 2);
});

test('a run recorded with no request is no request\'s, so it is never reused', async () => {
  const iid = freshIid();
  writeArtifact(iid, 'local-tests-run.json', runAnswer({ status: 'passed', cacheKey: keyOf() }));
  const w = world({}, fakeCli({ run: (_a, c) => reply(c, runAnswer({ status: 'passed' })) }));

  const res = await runApprovedTests(approved(iid), w.deps);

  assert.equal(res.kind === 'ran' && res.reused, false);
  assert.equal(runCalls(w), 1);
});

test('a repeat dry rehearsal records skipped under its own request, and a real run after it is not mistaken for it', async () => {
  const iid = freshIid();
  const dry = world({ dryRun: true });
  await runApprovedTests(approved(iid, { runId: 'l-dry-1' }), dry.deps);
  assert.equal(readArtifact<LocalTestsRun & { runId?: string }>(iid, 'local-tests-run.json')?.runId, 'l-dry-1');

  // A rehearsal that ran Cypress (ONESHOT_LOCAL_TESTS_DRY_CYPRESS), then a new rehearsal of the same code.
  const cy = world({ dryRun: true }, fakeCli({ run: (_a, c) => reply(c, runAnswer({ status: 'failed' })) }));
  await runApprovedTests(approved(iid, { runId: 'l-dry-2', dryCypress: true }), cy.deps);
  const next = await runApprovedTests(approved(iid, { runId: 'l-dry-3', dryCypress: true }), cy.deps);
  assert.equal(next.kind === 'ran' && next.reused, false, 'a new rehearsal runs Cypress again');
  assert.equal(runCalls(cy), 2);
});

test('a setup error is never reused: QA\'s next approval means try again', async () => {
  const iid = freshIid();
  writeArtifact(iid, 'local-tests-run.json', runAnswer({ status: 'error', reason: 'E_MIGRATE_FAILED: x', cacheKey: keyOf() }));
  const w = world({}, fakeCli({ run: (_a, c) => reply(c, runAnswer({ status: 'passed' })) }));

  const res = await runApprovedTests(approved(iid), w.deps);

  assert.equal(res.kind, 'ran');
  assert.equal(runCalls(w), 1);
  assert.equal(readArtifact<LocalTestsRun>(iid, 'local-tests-run.json')?.status, 'passed');
});

test('a dry run records skipped and starts nothing — unless asked to run Cypress', async () => {
  const iid = freshIid();
  const w = world({ dryRun: true });

  const res = await runApprovedTests(approved(iid), w.deps);

  assert.equal(res.kind, 'ran');
  const run = readArtifact<LocalTestsRun>(iid, 'local-tests-run.json');
  assert.equal(run?.status, 'skipped');
  assert.equal(run?.reason, 'a dry run starts no Cypress');
  assert.equal(run?.cacheKey, keyOf(), 'keyed, so a later real run is not mistaken for this one');
  assert.deepEqual(w.cli.calls, []);
  assert.deepEqual(w.acquired, []);

  const asked = world({ dryRun: true }, fakeCli({ run: (_a, c) => reply(c, runAnswer({ status: 'passed' })) }));
  const real = await runApprovedTests(approved(freshIid(), { dryCypress: true }), asked.deps);
  assert.equal(real.kind === 'ran' && real.run.status, 'passed');
  assert.equal(runCalls(asked), 1, 'ONESHOT_LOCAL_TESTS_DRY_CYPRESS runs it for real');
});

test('a list with nothing a desk can run records why, and starts nothing', async () => {
  const iid = freshIid();
  const w = world();
  const res = await runApprovedTests(approved(iid, {
    specs: [], notRunnable: [{ spec: SPECS[1]!.file, why: 'needs the mailbox' }],
  }), w.deps);
  assert.equal(res.kind === 'ran' && res.run.status, 'skipped');
  assert.match(res.kind === 'ran' ? res.run.reason ?? '' : '', /needs something a local machine does not have/);
  assert.deepEqual(res.kind === 'ran' && res.run.notRunnable, [{ spec: SPECS[1]!.file, why: 'needs the mailbox' }]);
  assert.deepEqual(w.acquired, []);
});

test('a busy desk parks before anything is announced, written or started', async () => {
  const iid = freshIid();
  const w = world({
    lease: { acquire: async () => false, release: () => { throw new Error('nothing to release'); }, holder: () => ({ runId: 'l-other' }) },
  });

  const res = await runApprovedTests(approved(iid), w.deps);

  assert.equal(res.kind, 'park');
  assert.match(res.kind === 'park' ? res.why : '', /l-other/);
  assert.deepEqual(w.cli.calls, []);
  assert.deepEqual(w.posted, [], 'no start note for a run that did not start');
  assert.equal(readArtifact(iid, 'local-tests-run.json'), null, 'no result recorded');
});

test('a full run: the merge commit, its first parent as the base, announced once, saved under the conductor\'s key', async () => {
  const iid = freshIid();
  const w = world({}, fakeCli({ run: (_a, c) => reply(c, runAnswer()) }));
  const spawned: number[] = [];

  const res = await runApprovedTests(approved(iid, { onSpawn: (pid) => spawned.push(pid) }), w.deps);

  assert.equal(res.kind, 'ran', 'failing tests are results, not a setup error');
  const run = readArtifact<LocalTestsRun & { runId?: string }>(iid, 'local-tests-run.json');
  assert.equal(run?.status, 'failed');
  assert.equal(run?.cacheKey, keyOf(), 'the conductor\'s key, never the script\'s');
  assert.equal(run?.runId, `l-${iid}`, 'stamped with the request it ran for');
  assert.equal(run?.ticketSha, MERGE_SHA);
  assert.deepEqual(spawned, [4242], 'the mode is told what it holds');

  const call = w.cli.calls.find((c) => c.args[0] === 'run')!;
  const arg = (flag: string): string | undefined => call.args[call.args.indexOf(flag) + 1];
  assert.equal(arg('--ref'), MERGE_SHA, 'the code under test is the merge commit');
  assert.equal(arg('--worktree'), WORK_REPO, 'the script cuts its own erp-lt from the clone');
  assert.equal(arg('--base'), BASE_SHA, 'a failure is re-run on the merge commit\'s first parent');
  assert.equal(arg('--automation-sha'), AUTO_SHA);
  assert.equal(arg('--patch'), captureAnswer().patchFile);
  assert.equal(arg('--patch-sha'), PATCH_SHA, 'the script refuses a patch file changed since capture');
  assert.equal(arg('--deadline-min'), '45');
  const until = Number(arg('--until'));
  assert.ok(Math.abs(until - (Date.now() + runDeadlineMs(45))) < 60_000,
    'the script is told the conductor\'s own kill, as an absolute clock');
  assert.deepEqual(JSON.parse(readFileSync(arg('--specs-file')!, 'utf8')),
    { specs: SPECS.map((s) => s.file), notRunnable: [] });
  assert.equal(arg('--specs-file'), join(artifactDir(iid), 'local-tests', 'specs.json'));

  assert.equal(w.posted.length, 1);
  assert.match(w.posted[0]!, /<!-- oneshot:local-tests-start -->/);
  assert.match(w.posted[0]!, /9 tests/);
  assert.match(w.posted[0]!, /dev \(merge of !321\)/);
  assert.deepEqual(w.released, [`l-${iid}`], 'the lease goes back');
  assert.equal(readJournal(iid), null, 'nothing is written to the Loop\'s journal');
  assert.equal(w.cli.calls.filter((c) => c.args[0] === 'gc').length, 0, 'a clean run cleaned up after itself');

  // The same code again, in the same request: the saved results, and no second start note.
  const again = await runApprovedTests(approved(iid), w.deps);
  assert.equal(again.kind === 'ran' && again.reused, true);
  assert.equal(runCalls(w), 1);
  assert.equal(w.posted.length, 1);
});

test('a run announced before a restart is not announced twice', async () => {
  const iid = freshIid();
  const w = world({}, fakeCli({ run: (_a, c) => reply(c, runAnswer()) }));
  w.posted.push(`earlier start note @ \`${MERGE_SHA.slice(0, 7)}\` and \`${AUTO_SHA.slice(0, 7)}\`\n\n`
    + `<!-- oneshot:local-tests-start -->\n<!-- oneshot:local-tests-start:l-${iid} -->`);

  await runApprovedTests(approved(iid), w.deps);

  assert.equal(w.posted.length, 1, 'the existing note for this request and code stands');
});

test('a list without temporary changes runs without a patch', async () => {
  const w = world({}, fakeCli({ run: (_a, c) => reply(c, runAnswer({ status: 'passed' })) }));

  await runApprovedTests(approved(freshIid(), { patchFile: null, patchSha: null }), w.deps);

  const args = w.cli.calls.find((c) => c.args[0] === 'run')!.args;
  assert.ok(!args.includes('--patch') && !args.includes('--patch-sha'));
});

test('a script stopped by anything but this run\'s own signal is recorded as a setup error', async () => {
  const iid = freshIid();
  const w = world({}, fakeCli({ run: (_a, c) => reply(c, { code: 'E_ABORTED', message: 'stopped by SIGTERM' }, 143) }));

  const res = await runApprovedTests(approved(iid), w.deps);

  assert.equal(res.kind, 'error');
  assert.equal(readArtifact<LocalTestsRun>(iid, 'local-tests-run.json')?.status, 'error');
});

test('a run past its deadline has its whole process group killed, and is recorded as not run', async () => {
  const iid = freshIid();
  const w = world({ deadlineMs: () => 30 });

  const res = await runApprovedTests(approved(iid), w.deps);

  assert.deepEqual(w.cli.kills[0], [-4242, 'SIGTERM'], 'the group, not the node at its top');
  assert.equal(res.kind, 'error');
  const run = readArtifact<LocalTestsRun>(iid, 'local-tests-run.json');
  assert.equal(run?.status, 'error');
  assert.match(run?.reason ?? '', /E_DEADLINE/);
  assert.deepEqual(w.released, [`l-${iid}`]);
  assert.equal(w.cli.calls.filter((c) => c.args[0] === 'gc').length, 1, 'what it left behind is cleared now');
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
  const iid = freshIid();
  const aborter = new AbortController();
  const w = world({}, fakeCli({ run: () => { setTimeout(() => aborter.abort(), 5); } }));

  const res = await runApprovedTests(approved(iid, { signal: aborter.signal }), w.deps);

  assert.equal(res.kind, 'stopped');
  assert.match(res.kind === 'stopped' ? res.why : '', /asked this run to stop/);
  assert.deepEqual(w.cli.kills[0], [-4242, 'SIGTERM']);
  assert.equal(readArtifact(iid, 'local-tests-run.json'), null, 'the next pass runs it again');
  assert.deepEqual(w.released, [`l-${iid}`]);
});

test('a setup error is recorded in the script\'s own words', async () => {
  const iid = freshIid();
  const w = world({}, fakeCli({
    run: (_a, c) => reply(c, { code: 'E_MIGRATE_FAILED', message: 'leaves.0042 failed', hint: 'see the log' }, 3),
  }));

  const res = await runApprovedTests(approved(iid), w.deps);

  assert.equal(res.kind, 'error');
  const run = readArtifact<LocalTestsRun>(iid, 'local-tests-run.json');
  assert.equal(run?.status, 'error');
  assert.equal(run?.reason, 'E_MIGRATE_FAILED: leaves.0042 failed (see the log)');
  assert.equal(run?.cacheKey, keyOf());
});

test('a script that finds the desk busy parks the run: nothing recorded, the lease back, the next tick tries again', async () => {
  const busy = [
    { code: 'E_BASELINE_BUSY', message: '2 session(s) are connected to hrdb_automation_baseline', hint: 'close them' },
    { code: 'E_RUN_IN_PROGRESS', message: 'a local-tests run for this ticket is already running (pid 99)' },
    { code: 'E_PORT_BUSY', message: `port 8030 (Django) is held by pid 77 running from ${join(RUNS, '990001', 'erp-base-lt')}` },
  ];
  for (const answer of busy) {
    const iid = freshIid();
    const w = world({}, fakeCli({ run: (_a, c) => reply(c, answer, 3) }));

    const res = await runApprovedTests(approved(iid), w.deps);

    assert.equal(res.kind, 'park', answer.code);
    assert.match(res.kind === 'park' ? res.why : '', new RegExp(answer.code));
    assert.equal(readArtifact(iid, 'local-tests-run.json'), null, `${answer.code}: no result recorded`);
    assert.deepEqual(w.released, [`l-${iid}`]);
    assert.equal(w.cli.calls.filter((c) => c.args[0] === 'gc').length, 0, 'the script cleaned up before it answered');
  }
});

test('the ports held by something that is not a local-tests run are a person\'s to clear, and recorded', async () => {
  const iid = freshIid();
  const w = world({}, fakeCli({
    run: (_a, c) => reply(c, { code: 'E_PORT_BUSY', message: 'port 8030 (Django) is held by pid 77 running from /Users/dev/erp' }, 3),
  }));

  const res = await runApprovedTests(approved(iid), w.deps);

  assert.equal(res.kind, 'error');
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

test('the script\'s notes and a flaky pass are kept, so the results note can show them', async () => {
  const iid = freshIid();
  const notes = ['the failures were not re-run on bbbbbbb: E_APP_FAILED: webpack exited 1'];
  const answer = runAnswer({
    results: [
      { spec: SPECS[0]!.file, title: 'applies a leave', state: 'passed', durationMs: 1000, flaky: true },
      { spec: SPECS[1]!.file, title: 'applies a half day', state: 'failed', durationMs: 900, failingOnDev: null },
    ] as LocalTestsRun['results'],
  });
  const w = world({}, fakeCli({ run: (_a, c) => reply(c, { ...answer, notes }) }));

  await runApprovedTests(approved(iid), w.deps);

  const run = readArtifact<LocalTestsRun & { notes?: string[] }>(iid, 'local-tests-run.json');
  assert.deepEqual(run?.notes, notes);
  assert.equal((run?.results[0] as { flaky?: boolean }).flaky, true);
  assert.equal('flaky' in run!.results[1]!, false, 'only a pass on the retry is flaky');
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
  assert.deepEqual(notRunnableOf(scopeWith({ notRunnable })), [{ spec: SPECS[1]!.file, why: 'needs the mailbox' }]);
  assert.equal(cacheKey(scopeWith({ notRunnable: [] }), MERGE_SHA, AUTO_SHA, PATCH_SHA, CFG),
    cacheKey(scopeWith(), MERGE_SHA, AUTO_SHA, PATCH_SHA, CFG), 'a list without them keeps the key it always had');

  const iid = freshIid();
  const nr = [{ spec: SPECS[1]!.file, why: 'needs the mailbox' }];
  const w = world({}, fakeCli({ run: (_a, c) => reply(c, runAnswer({ status: 'passed' })) }));
  await runApprovedTests(approved(iid, { specs: [SPECS[0]!.file], notRunnable: nr, tests: 6 }), w.deps);

  const call = w.cli.calls.find((c) => c.args[0] === 'run')!;
  const file = JSON.parse(readFileSync(call.args[call.args.indexOf('--specs-file') + 1]!, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(file, { specs: [SPECS[0]!.file], notRunnable: nr });
  assert.equal(readArtifact<LocalTestsRun>(iid, 'local-tests-run.json')?.cacheKey, keyOf([SPECS[0]!.file], PATCH_SHA, nr));
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

  const w = world({}, fakeCli({ run: (_a, c) => reply(c, { status: 'green' }) }));
  const res = await runApprovedTests(approved(freshIid()), w.deps);
  assert.match(res.kind === 'error' ? res.run.reason ?? '' : '', /E_BAD_OUTPUT/, 'an unknown status is not a run');
});

test('an unexpected throw inside the run is recorded, and the lease still goes back', async () => {
  const iid = freshIid();
  const w = world({ notes: { list: async () => { throw new Error('socket hang up'); }, add: async () => true } });

  const res = await runApprovedTests(approved(iid), w.deps);

  assert.equal(res.kind, 'error');
  assert.match(readArtifact<LocalTestsRun>(iid, 'local-tests-run.json')?.reason ?? '', /socket hang up/);
  assert.deepEqual(w.released, [`l-${iid}`]);
});

test('no merge commit or no first parent is a setup error, before the desk is asked for', async () => {
  const w = world();
  const res = await runApprovedTests(approved(freshIid(), { base: '' }), w.deps);
  assert.equal(res.kind, 'error');
  assert.deepEqual(w.acquired, []);
});

// ------------------------------------------------------- the scope session

const INPUTS: ScopeInputs = {
  wsa: '/runs/x/wsa', automationSha: AUTO_SHA, base: BASE_SHA, head: MERGE_SHA, patchFile: '/runs/x/patch',
};

test('preparing the scope checks out the automation worktree for the merge commit\'s range, and records nothing', async () => {
  const iid = freshIid();
  const w = world();

  const prep = await prepareScopeAt(iid, { base: BASE_SHA, head: MERGE_SHA }, w.deps);

  assert.ok(prep.ok);
  assert.deepEqual(prep.ok && prep.data, {
    wsa: '/runs/x/wsa', automationSha: AUTO_SHA, base: BASE_SHA, head: MERGE_SHA, patchFile: localTestsPatchFile(iid),
  });
  assert.deepEqual(w.cli.calls[0]?.args, ['prepare-scope', '--iid', String(iid), '--automation-ref', 'origin/master']);
  assert.equal(readJournal(iid), null, 'the mode records what it holds in its own journal');

  const none = world();
  const failed = await prepareScopeAt(iid, { base: '', head: MERGE_SHA }, none.deps);
  assert.equal(failed.ok ? '' : failed.error.code, 'E_GIT');
  assert.deepEqual(none.cli.calls, [], 'nothing checked out that would then need cleaning up');
});

test('a list with specs keeps its capture, with why each flagged file was flagged', async () => {
  const iid = freshIid();
  const flagged = { file: 'cypress/e2e/leaves/apply_leave.cy.ts', why: 'adds cy.exec(' };
  const w = world({}, fakeCli({
    capture: (_a, c) => reply(c, captureAnswer({
      weakened: [flagged.file], weakenedDetail: [flagged, { why: 'no file' }, 'junk'],
    })),
  }));

  const after = await captureScopeSession(iid, { ok: true, data: scopeWith({ capture: undefined }) }, INPUTS, w.deps);

  assert.equal(after.refusal, null);
  assert.deepEqual(w.cli.calls.map((c) => c.args), [['capture', '--iid', String(iid)]]);
  const onDisk = readArtifact<Record<string, unknown>>(iid, 'local-tests-scope.json');
  assert.deepEqual(captureOf(onDisk), {
    ...captureAnswer({ weakened: [flagged.file], weakenedDetail: [flagged] }),
    automationSha: AUTO_SHA, base: BASE_SHA, head: MERGE_SHA,
  }, 'the found note reads the reasons from here');
  assert.deepEqual(after.data, onDisk);
  assert.equal(readJournal(iid), null);
});

test('a list of nothing comes back as it is — the "no test found" answer, with its suggestion', async () => {
  const iid = freshIid();
  const w = world();
  const session = scopeWith({
    capture: undefined, specs: [], reason: 'the banner has no spec yet',
    proposals: [{ action: 'add', title: 'Verify that the banner can be dismissed for a week', why: 'gap' }],
  });

  const after = await captureScopeSession(iid, { ok: true, data: session }, INPUTS, w.deps);

  assert.equal(after.refusal, null);
  assert.deepEqual(after.data, session, 'nothing rewritten: the mode posts the not-found note from it');
  assert.equal(w.cli.calls.length, 1, 'the throwaway worktree is still captured and removed');
});

test('a scope that made no edits is captured as no patch, and still runs', async () => {
  const iid = freshIid();
  // What capture prints when the worktree is clean, and the commit it was cut against.
  const w = world({}, fakeCli({
    capture: (_a, c) => reply(c, captureAnswer({ patchFile: null, patchSha: null, changedFiles: [], automationSha: 'f'.repeat(40) })),
  }));

  const after = await captureScopeSession(iid, { ok: true, data: scopeWith({ capture: undefined }) }, INPUTS, w.deps);

  assert.equal(after.refusal, null);
  const capture = captureOf(after.data);
  assert.equal(capture?.patchSha, null);
  assert.equal(capture?.patchFile, '');
  assert.equal(capture?.automationSha, 'f'.repeat(40), 'the commit capture names wins over prepare-scope\'s');
});

test('edits that could not be saved refuse the list, rather than run specs without them', async () => {
  const iid = freshIid();
  const w = world({}, fakeCli({ capture: (_a, c) => reply(c, { code: 'E_PATCH', message: 'git diff failed' }, 2) }));

  const after = await captureScopeSession(iid, { ok: true, data: scopeWith({ capture: undefined }) }, INPUTS, w.deps);

  assert.match(after.refusal ?? '', /E_PATCH: git diff failed/);
});

test('a blocked or failed scope is still captured, and its own failure stands', async () => {
  const iid = freshIid();
  const w = world();

  const after = await captureScopeSession(iid, { ok: false, data: scopeWith({ blocked: 'E_NO_MAP: modules map missing' }) }, INPUTS, w.deps);

  assert.equal(after.refusal, null);
  assert.equal(w.cli.calls.length, 1, 'captured, so nothing is left on the desk');
});

// ------------------------------------------------------------ the rest

test('gc keeps every ticket in use, and does nothing on a desk where the step is off or in a dry run', async () => {
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
  const k = cacheKey(scopeWith(), MERGE_SHA, AUTO_SHA, PATCH_SHA, CFG);
  assert.equal(cacheKey(scopeWith({ specs: [...SPECS].reverse() }), MERGE_SHA, AUTO_SHA, PATCH_SHA, CFG), k);
  assert.notEqual(cacheKey(scopeWith(), 'e'.repeat(40), AUTO_SHA, PATCH_SHA, CFG), k);
  assert.notEqual(cacheKey(scopeWith(), MERGE_SHA, 'e'.repeat(40), PATCH_SHA, CFG), k);
  assert.notEqual(cacheKey(scopeWith(), MERGE_SHA, AUTO_SHA, null, CFG), k);
  assert.notEqual(cacheKey(scopeWith(), MERGE_SHA, AUTO_SHA, PATCH_SHA, { ...CFG, baselineDb: 'other_baseline' }), k);
  assert.notEqual(cacheKey(scopeWith({ specs: SPECS.slice(1) }), MERGE_SHA, AUTO_SHA, PATCH_SHA, CFG), k);
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
  assert.deepEqual(weakenedFiles(captureOf(scopeWith({
    capture: { ...captureAnswer({ weakened: ['a.ts'], outsideAllowed: ['cypress.config.ts', 'a.ts'] }), automationSha: AUTO_SHA },
  }))), ['a.ts', 'cypress.config.ts']);
});

test('both phases are on demand: the Loop never schedules them, the post-merge mode runs the scope', () => {
  const raw = JSON.parse(readFileSync(new URL('../../config/phases.json', import.meta.url), 'utf8')) as { phases: PhaseConfig[] };
  const byName = (n: string): PhaseConfig => raw.phases.find((p) => p.name === n)!;
  const scope = byName('local-tests-scope');
  const run = byName('local-tests-run');
  assert.equal(scope.onDemand, true);
  assert.equal(run.onDemand, true);
  assert.equal(scope.kind, 'session');
  assert.equal(scope.cwd, 'worktree', 'it reads the ERP checkout at the merge commit');
  assert.deepEqual(scope.writes, ['run'], 'the throwaway automation worktree is inside state/runs/<iid>, so this is enough');
  assert.deepEqual(scope.skills, ['local-tests-impact']);
  assert.deepEqual(scope.targets, ['erp']);
  assert.equal(run.kind, 'code');
  assert.ok(existsSync(new URL('../../skills/local-tests-impact/SKILL.md', import.meta.url)));
});

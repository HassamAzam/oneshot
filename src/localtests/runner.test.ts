/**
 * The local automation tests mode: the state machine, QA's replies, and whole
 * tickets driven end to end against fakes — a fake GitLab that records every
 * write, a fake scope session, a fake analysis script and a fake
 * scripts/localtests.cjs. No network, no session, no Postgres, no Cypress, and
 * the desk's real lease is never touched.
 *
 * What these pin:
 * - nextStep, for every step: owed writes first whatever the labels say, the
 *   trigger (or --assume-label) for everything else, a quiet wait for an
 *   unmerged change, then the state's own step.
 * - QA's first decisive reply after the list wins; anyone else's is ignored.
 * - DRY_RUN goes through a whole ticket in one pass with NO GitLab write at
 *   all, approval assumed and Cypress skipped — unless
 *   ONESHOT_LOCAL_TESTS_DRY_CYPRESS asks for a real local run.
 * - A real ticket: list → QA `approved` → Running label → run against the merge
 *   commit → results → Automation Testing Done; with no test found, `approved`
 *   marks it done without a run; check again, added files, a temporary test and
 *   feedback each lead back to a new list; a setup error puts the trigger back
 *   and asks again; a busy desk parks; a crash adopts its own note.
 * - What goes wrong around those: a start label edit whose answer is lost (or
 *   a crash after it) is finished from the ticket's labels; a reply after
 *   another Oneshot request is not a decision; an approval withdrawn before
 *   the start is not acted on; a re-request takes the old Done label off and
 *   runs again; another desk's request is left to it; the approved list keeps
 *   its patch and the run its record when the Loop archives state/runs/<iid>;
 *   QA's `added` files keep the earlier temporary changes; every merged MR of
 *   the ticket's own is scoped and named.
 *
 * Journals live under STATE/localtests/<iid> and run artifacts under
 * state/runs/<iid>, with iids in the reserved 990000+ band, removed afterwards.
 */
import '../lib/test-project-env.js';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { STATE, runDir, type LocalTestsConfig } from '../lib/config.js';
import { readArtifact } from '../lib/artifacts.js';
import type { GitlabResult, Issue, IssueNote } from '../lib/gitlab.js';
import type { PhaseInput, PhaseOutput } from '../conductor/phase.js';
import { runDeadlineMs, type CliDeps, type CliResult } from '../conductor/localtests.js';
import type { LocalTestsRun } from '../phases/types.js';
import {
  OTHER_DESK_STALE_MS, advanceTicket, foreignRequestBetween, foundSpecs, isSpecPath, localTestsGc, localTestsTick, nextStep,
  otherDeskRun, outcomeLine, postMarker, qaDecision, runLocalTestsOnce, sessionCharge, type ModeDeps, type StepOpts,
} from './runner.js';
import {
  acquireLtLock, erpCheckoutDir, localTestsDir, localTestsHome, newLtJournal, readLtJournal, readRunRecord, saveList,
  writeLtJournal, type ListRecord, type LocalTestsJournal,
} from './journal.js';
import type { LocalTestsReadiness, MergedMr } from './readiness.js';

const TRIGGER = 'Ready for Automation Testing';
const RUNNING = 'Running TestCases Locally';
const DONE = 'Automation Testing Done';
const LABELS = { trigger: TRIGGER, running: RUNNING, done: DONE };
const PROJECT = 'gitlab.example.com/acme/erp';
const QA = ['anosha.saeed', 'arsal.tariq'];
const MERGE = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const AUTO = 'c'.repeat(40);
const AUTO2 = 'e'.repeat(40);
const PATCH = 'd'.repeat(40);
/** An earlier MR of the same ticket: its merge commit, and that commit's first parent. */
const EARLY = 'f'.repeat(40);
const EARLY_BASE = '9'.repeat(40);
const NOW = Date.parse('2026-10-09T12:00:00Z');

const CFG: LocalTestsConfig = {
  enabled: true, off: null, repo: '/nowhere/workstream-automation', credsFile: '/nowhere/creds.json',
  baselineDb: 'hrdb_automation_baseline', pg: { host: '127.0.0.1', port: 5432, user: '' },
  dbPrefix: 'oneshot_lt_', automationRef: 'origin/master',
  allowedPaths: ['cypress/Pages/', 'cypress/fixtures/', 'cypress/e2e/'],
  maxSpecs: 40, maxRunMinutes: 45, devApproval: 'any', failuresBlock: false, labels: LABELS,
};

const used = new Set<number>();
let nextIid = 990901;
function freshIid(): number {
  const iid = nextIid++;
  used.add(iid);
  rmSync(localTestsDir(iid), { recursive: true, force: true });
  rmSync(runDir(iid), { recursive: true, force: true });
  return iid;
}
const ARCHIVE = join(STATE, 'localtests-archive');
/** Parents this test run creates, removed again when it leaves them empty. */
const createdParents = [localTestsHome(), ARCHIVE].filter((p) => !existsSync(p));
after(() => {
  for (const iid of used) {
    rmSync(localTestsDir(iid), { recursive: true, force: true });
    rmSync(runDir(iid), { recursive: true, force: true });
  }
  // A finished journal archived by a re-request or a repeated rehearsal.
  for (const name of existsSync(ARCHIVE) ? readdirSync(ARCHIVE) : []) {
    if ([...used].some((iid) => name.startsWith(`${iid}-`))) rmSync(join(ARCHIVE, name), { recursive: true, force: true });
  }
  for (const p of createdParents) {
    if (existsSync(p) && readdirSync(p).length === 0) rmSync(p, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- pure: nextStep

const OPTS: StepOpts = { labels: LABELS, project: PROJECT, now: NOW, recheckMs: 5 * 60_000 };

function journal(over: Partial<LocalTestsJournal> = {}): LocalTestsJournal {
  return {
    v: 1, iid: 101, runId: 'l-test-000000', project: PROJECT, title: 'Leave form', state: 'new',
    createdAt: NOW - 3_600_000, updatedAt: NOW - 3_600_000, lists: [], watermark: 0, attempts: 0, sessions: 0,
    freeRetries: 0,
    merged: { mrIid: 321, title: 'Fix the leave total', mergeSha: MERGE, base: BASE, sourceBranch: 'oneshot/x', targetBranch: 'dev', author: 'hira.ijaz', url: '' },
    ...over,
  };
}

function list(over: Partial<ListRecord> = {}): ListRecord {
  return {
    round: 1, source: 'scope', kind: 'found', specs: ['cypress/e2e/leaves/a.cy.ts'], notRunnable: [], automationSha: AUTO,
    patchFile: null, patchSha: null, noteId: 500, postedAt: NOW - 60_000, ...over,
  };
}

const labelled = { labels: [TRIGGER], updated_at: '2026-10-09T10:00:00Z' };
const bare = { labels: [] as string[], updated_at: '2026-10-09T10:00:00Z' };

test('nextStep: first sight checks; no trigger is a silent skip unless a dry run assumes it', () => {
  assert.deepEqual(nextStep(null, labelled, OPTS), { kind: 'check', reason: 'first' });
  assert.deepEqual(nextStep(journal({ state: 'new' }), labelled, OPTS), { kind: 'check', reason: 'first' });
  assert.deepEqual(nextStep(null, bare, OPTS), { kind: 'skip', why: `no "${TRIGGER}" label` });
  assert.deepEqual(nextStep(null, bare, { ...OPTS, assumeLabel: true }), { kind: 'check', reason: 'first' });
  assert.deepEqual(nextStep(journal({ state: 'awaiting-qa', lists: [list()] }), bare, OPTS).kind, 'skip',
    'a withdrawn trigger stops a ticket waiting on QA too');
});

test('nextStep: a journal from another project is no journal', () => {
  assert.deepEqual(nextStep(journal({ project: 'other/host', state: 'done' }), labelled, OPTS), { kind: 'check', reason: 'first' });
});

test('nextStep: an unmerged change waits quietly, and is checked again on change or cadence', () => {
  const waiting = journal({
    state: 'waiting', merged: undefined,
    readiness: { at: NOW - 60_000, issueUpdatedAt: labelled.updated_at, reason: '!321 is still open' },
  });
  const held = nextStep(waiting, labelled, OPTS);
  assert.equal(held.kind, 'hold');
  assert.match(held.kind === 'hold' ? held.why : '', /waiting for the change to be merged \(!321 is still open\)/);
  assert.deepEqual(nextStep(waiting, { ...labelled, updated_at: '2026-10-09T11:00:00Z' }, OPTS), { kind: 'check', reason: 'changed' });
  assert.deepEqual(nextStep(waiting, labelled, { ...OPTS, now: NOW + 5 * 60_000 }), { kind: 'check', reason: 'cadence' });
  assert.deepEqual(nextStep({ ...waiting, readiness: undefined }, labelled, OPTS), { kind: 'check', reason: 'first' });
});

test('nextStep: scoping, re-checking and adding run their steps; an unposted list is posted first', () => {
  assert.deepEqual(nextStep(journal({ state: 'scoping' }), labelled, OPTS), { kind: 'scope', request: 'first' });
  assert.deepEqual(nextStep(journal({ state: 'scoping', request: { kind: 'write-temporary', noteId: 1, by: 'x' } }), labelled, OPTS),
    { kind: 'scope', request: 'write-temporary' });
  assert.deepEqual(nextStep(journal({ state: 'scoping', request: { kind: 'feedback', feedback: '- remove LV_21', noteId: 1, by: 'x' } }), labelled, OPTS),
    { kind: 'scope', request: 'feedback' });
  assert.deepEqual(nextStep(journal({ state: 'rechecking', lists: [list()] }), labelled, OPTS), { kind: 'recheck' });
  assert.deepEqual(nextStep(journal({ state: 'adding', lists: [list()], addFiles: { files: ['cypress/e2e/a.cy.ts'], noteId: 1, by: 'x' } }), labelled, OPTS),
    { kind: 'add' });
  assert.deepEqual(nextStep(journal({ state: 'adding', lists: [list()] }), labelled, OPTS), { kind: 'review' });
  assert.deepEqual(nextStep(journal({ state: 'awaiting-qa', lists: [list({ round: 2, postedAt: null, noteId: null })] }), labelled, OPTS),
    { kind: 'post', round: 2 });
  assert.deepEqual(nextStep(journal({ state: 'awaiting-qa', lists: [list()] }), labelled, OPTS), { kind: 'review' });
  assert.deepEqual(nextStep(journal({ state: 'awaiting-qa', merged: undefined }), labelled, OPTS), { kind: 'check', reason: 'first' });
});

test('nextStep: an approval goes on to start; the writes it set in motion go on whatever the labels say', () => {
  const lists = [list()];
  assert.deepEqual(nextStep(journal({ state: 'approved', lists }), labelled, OPTS), { kind: 'start' });
  assert.equal(nextStep(journal({ state: 'approved', lists }), bare, OPTS).kind, 'skip',
    'withdrawn before the run began: nothing is started');
  assert.deepEqual(nextStep(journal({ state: 'approved', lists, labelsDone: true }), bare, OPTS), { kind: 'start' },
    'the done labels are on, only the record is owed');
  assert.deepEqual(nextStep(journal({ state: 'running', lists }), { labels: [RUNNING], updated_at: '' }, OPTS), { kind: 'run' });
  assert.deepEqual(nextStep(journal({ state: 'reporting', lists }), bare, OPTS), { kind: 'report' });
  assert.deepEqual(nextStep(journal({ state: 'setup-error', lists }), bare, OPTS), { kind: 'restore' });
  assert.deepEqual(nextStep(journal({ state: 'stuck', lists }), labelled, OPTS), { kind: 'stuck-poll' });
});

test('nextStep: a start label edit sent without an answer is owed, though that edit took the trigger off', () => {
  const lists = [list()];
  assert.deepEqual(nextStep(journal({ state: 'approved', lists, pendingLabels: 'running' }), { labels: [RUNNING], updated_at: '' }, OPTS),
    { kind: 'start' });
  assert.deepEqual(nextStep(journal({ state: 'approved', lists, pendingLabels: 'done' }), bare, OPTS), { kind: 'start' });
});

test('nextStep: done is done', () => {
  assert.deepEqual(nextStep(journal({ state: 'done' }), { labels: [DONE], updated_at: '' }, OPTS),
    { kind: 'skip', why: `already ${DONE} — nothing to do` });
  assert.match(String((nextStep(journal({ state: 'done' }), bare, OPTS) as { why?: string }).why), /put "Ready for Automation Testing" back/);
});

// ------------------------------------------------------- pure: replies and the rest

const note = (id: number, user: string, body: string, over: Partial<IssueNote> = {}): IssueNote =>
  ({ id, body, author: { username: user }, created_at: '2026-10-09T11:00:00Z', ...over });

test('qaDecision: the first decisive reply from QA after the list wins; everyone else is ignored', () => {
  const notes = [
    note(400, 'arsal.tariq', 'approved'),                                  // before the list: an earlier round
    note(500, 'desk', 'list <!-- oneshot:local-tests:found -->'),
    note(501, 'hira.ijaz', 'approved'),                                    // not QA
    note(502, 'anosha.saeed', 'looking at it now'),                        // QA, but no decision
    note(503, 'arsal.tariq', 'Oneshot stopped: something'),                // the Loop's unmarked note on a QA token
    note(504, 'gitlab', 'added ~label', { system: true }),
    note(505, 'anosha.saeed', 'disapproved: please check again'),
    note(506, 'arsal.tariq', 'approved'),
  ];
  const d = qaDecision(notes, { since: 500, qa: QA });
  assert.deepEqual(d?.reply, { kind: 'check-again' });
  assert.equal(d?.id, 505);
  assert.equal(d?.by, 'anosha.saeed');
  assert.deepEqual(qaDecision(notes, { since: 505, qa: QA })?.reply, { kind: 'approved' });
  assert.equal(qaDecision(notes, { since: 506, qa: QA }), null);
});

test('foreignRequestBetween: another Oneshot request between the list and the reply; this mode\'s own notes never count', () => {
  const notes = [
    note(500, 'desk', 'list <!-- oneshot:local-tests:found -->'),
    note(501, 'desk', 'started <!-- oneshot:local-tests-start:l-x -->'),
    note(502, 'gitlab', 'added ~label', { system: true }),
    note(503, 'desk', 'cases <!-- oneshot:automation:cases:v1:abc -->'),
    note(504, 'arsal.tariq', 'approved'),
  ];
  assert.equal(foreignRequestBetween(notes, 500, 504)?.id, 503);
  assert.equal(foreignRequestBetween(notes, 503, 504), null, 'the request came before the list');
  assert.equal(foreignRequestBetween(notes, 500, 503), null, 'this mode\'s own notes and GitLab\'s are not requests');
});

test('otherDeskRun: another request with notes and no results is under way; a finished or long-quiet one is not', () => {
  const at = (ms: number): string => new Date(NOW - ms).toISOString();
  const post = (id: number, key: string, runId: string, ago = 60_000): IssueNote =>
    note(id, 'desk', `x\n\n${postMarker(key, runId)}`, { created_at: at(ago) });
  assert.equal(otherDeskRun([post(1, 'list-r1', 'l-other-aaaaaa')], 'l-mine-bbbbbb', NOW), 'l-other-aaaaaa');
  assert.equal(otherDeskRun([post(1, 'list-r1', 'l-mine-bbbbbb')], 'l-mine-bbbbbb', NOW), null, 'its own posts');
  assert.equal(otherDeskRun([post(1, 'list-r1', 'l-other-aaaaaa'), post(2, 'results-0123456789ab', 'l-other-aaaaaa')],
    'l-mine-bbbbbb', NOW), null, 'finished with results');
  assert.equal(otherDeskRun([post(1, 'list-r1', 'l-other-aaaaaa'), post(2, 'approved-without-tests', 'l-other-aaaaaa')],
    'l-mine-bbbbbb', NOW), null, 'finished without tests');
  assert.equal(otherDeskRun([post(1, 'stuck-abc', 'l-other-aaaaaa')], 'l-mine-bbbbbb', NOW), 'l-other-aaaaaa', 'stuck is not finished');
  assert.equal(otherDeskRun([post(1, 'list-r1', 'l-other-aaaaaa', OTHER_DESK_STALE_MS + 60_000)], 'l-mine-bbbbbb', NOW), null,
    'quiet for longer than a week: nobody is finishing it');
});

test('foundSpecs: only specs reached through the change itself, never through their folder alone', () => {
  const found = foundSpecs({
    specs: [
      { file: 'cypress/e2e/leaves/a.cy.ts', its: 3, ciSeconds: 40, reasons: ['imports cypress/Pages/Leave.ts, which selects \'total\''] },
      { file: 'cypress/e2e/leaves/smoke.cy.ts', its: 9, reasons: ['module leaves (leaves)'] },
      { file: 'cypress/e2e/leaves/b.cy.ts', reasons: ['module leaves (leaves)', 'imports cypress/Pages/Leave.ts, which selects \'x\''] },
      { file: 'cypress/e2e/leaves/a.cy.ts', reasons: ['imports again'] },
      { reasons: ['imports x'] }, null,
    ],
  });
  assert.deepEqual(found.map((s) => s.file), ['cypress/e2e/leaves/a.cy.ts', 'cypress/e2e/leaves/b.cy.ts']);
  assert.equal(found[0]!.its, 3);
  assert.deepEqual(foundSpecs(null), []);
});

test('the small judgements: spec paths, session charges, the outcome line, the post marker', () => {
  assert.equal(isSpecPath('cypress/e2e/leaves/LV_LOCAL_total.ts'), true);
  assert.equal(isSpecPath('cypress/../secrets.ts'), false);
  assert.equal(isSpecPath('src/app.ts'), false);
  const out = (over: Partial<PhaseOutput>): PhaseOutput => ({
    ok: false, data: null, blocked: null, summary: '', turns: 0, weighted: 0, sessionId: '', rateLimited: false, ...over,
  });
  assert.equal(sessionCharge(out({ error: 'cancelled by the conductor' })), 'none');
  assert.equal(sessionCharge(out({ rateLimited: true })), 'none');
  assert.equal(sessionCharge(out({ accountAction: 'x' })), 'account');
  assert.equal(sessionCharge(out({ infra: true })), 'free');
  assert.equal(sessionCharge(out({ infra: true, turns: 0, weighted: 50 })), 'charge');
  assert.equal(outcomeLine({ iid: 7, state: 'done', did: 'done — passed' }), 'local      #7 done — passed');
  assert.equal(outcomeLine({ iid: 7, state: 'awaiting-qa', did: 'round 1 waiting on QA' }), 'local      #7 awaiting-qa — round 1 waiting on QA');
  assert.equal(postMarker('list-r1', 'l-x'), '<!-- oneshot:local-tests:post:list-r1:l-x -->');
});

// ------------------------------------------------------------- the fakes

class FakeChild extends EventEmitter {
  pid = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
}

function reply(child: FakeChild, obj: unknown, code = 0): void {
  child.stdout.end(JSON.stringify(obj));
  child.stderr.end('');
  setImmediate(() => child.emit('close', code, null));
}

const SPECS = [
  { file: 'cypress/e2e/leaves/apply_leave.cy.ts', module: 'leaves', cases: 6, why: 'opens the changed form' },
  { file: 'cypress/e2e/leaves/half_day.cy.ts', module: 'leaves', cases: 3, why: 'Health check: the leaves module' },
];

const scope = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  applicable: true, reason: 'the leave form total changed', modules: ['leaves'], specs: SPECS, edits: [], proposals: [],
  notRunnable: [], estimatedMinutes: 4, summary: '2 specs, 9 cases', ...over,
});

const NOT_FOUND = scope({
  specs: [], reason: 'no spec opens the new banner',
  proposals: [{ action: 'add', title: 'Verify that the banner can be dismissed for a week', why: 'nothing covers it' }],
});

function runAnswer(over: Partial<LocalTestsRun> = {}): LocalTestsRun {
  return {
    status: 'failed', cacheKey: 'the-script-says', ticketSha: MERGE, automationSha: AUTO, patchSha: PATCH, db: 'oneshot_lt_1_1',
    totals: { specs: 2, tests: 9, passed: 8, failed: 1, skipped: 0 },
    results: [
      { spec: SPECS[0]!.file, title: 'applies a leave', state: 'passed', durationMs: 1000 },
      { spec: SPECS[1]!.file, title: 'applies a half day', state: 'failed', durationMs: 900, error: 'expected 0.5', failingOnDev: false },
    ],
    notRunnable: [], newTests: [], startedAt: '2026-10-09T10:00:00Z', endedAt: '2026-10-09T10:05:00Z',
    ...over,
  };
}

type Write = { kind: 'note'; body: string } | { kind: 'labels'; change: { add?: string[]; remove?: string[] } } | { kind: 'upload'; name: string };

interface Fake {
  iid: number;
  issue: Issue;
  notes: IssueNote[];
  writes: Write[];
  readiness: LocalTestsReadiness;
  sessions: PhaseInput[];
  sessionOut: (input: PhaseInput) => PhaseOutput;
  impact: (args: string[]) => CliResult<Record<string, unknown>>;
  impactCalls: string[][];
  onMaster: Set<string>;
  git: string[][];
  cliCalls: string[][];
  runAnswer: () => { obj: unknown; code: number };
  leaseFree: boolean;
  acquired: string[];
  erpAdds: string[];
  erpRemoves: string[];
  nextNote: number;
  /** The capture writes the patch it names, as the real script does. */
  writePatch: boolean;
  /** Commits the ERP clone has, and each one's first parent. */
  parents: Map<string, string>;
  alerts: string[];
}

const ok = <T>(data: T): GitlabResult<T> => ({ ok: true, kind: 'ok', status: 200, data });
const notFound = <T>(): GitlabResult<T> => ({ ok: false, kind: 'notfound', status: 404, data: null });

function ready(iid: number, mr: Partial<MergedMr> = {}): LocalTestsReadiness {
  return {
    v: 1, verdict: 'ready', ready: true, iid, checkedAt: '', issueUpdatedAt: '2026-10-09T10:00:00Z', labelled: true,
    reason: '!321 (oneshot/x → dev) is merged as aaaaaaa', warnings: [],
    mergedMr: {
      iid: 321, title: 'Fix the leave total', mergeSha: MERGE, sourceBranch: 'oneshot/x', targetBranch: 'dev', author: 'hira.ijaz',
      mergedAt: null, url: '', ...mr,
    },
  };
}

function fake(over: Partial<Fake> = {}): Fake {
  const iid = freshIid();
  return {
    iid,
    issue: {
      iid, title: 'Leave form total', description: 'The total is wrong', labels: [TRIGGER, 'Minor'], assignees: [],
      state: 'closed', web_url: `https://gitlab.example.com/acme/erp/-/issues/${iid}`, updated_at: '2026-10-09T10:00:00Z',
    },
    notes: [],
    writes: [],
    readiness: ready(iid),
    sessions: [],
    sessionOut: () => ({ ok: true, data: scope(), blocked: null, summary: '', turns: 12, weighted: 900, sessionId: 's', rateLimited: false }),
    impact: () => ({ ok: true, data: { specs: [] } }),
    impactCalls: [],
    onMaster: new Set(),
    git: [],
    cliCalls: [],
    runAnswer: () => ({ obj: runAnswer(), code: 0 }),
    leaseFree: true,
    acquired: [],
    erpAdds: [],
    erpRemoves: [],
    nextNote: 1000,
    writePatch: false,
    parents: new Map([[MERGE, BASE], [BASE, '']]),
    alerts: [],
    ...over,
  };
}

function fakeCli(f: Fake): CliDeps {
  return {
    spawn(args) {
      const child = new FakeChild();
      f.cliCalls.push(args);
      setImmediate(() => {
        switch (args[0]) {
          case 'prepare-scope': return reply(child, { wsa: join(runDir(f.iid), 'wsa'), automationSha: AUTO });
          case 'capture': {
            const patchFile = join(runDir(f.iid), 'artifacts', 'local-tests', 'temporary-changes.patch');
            if (f.writePatch) {
              mkdirSync(join(runDir(f.iid), 'artifacts', 'local-tests'), { recursive: true });
              writeFileSync(patchFile, 'diff --git a/cypress/Pages/LeavePage.ts b/cypress/Pages/LeavePage.ts\n');
            }
            return reply(child, {
              patchFile, patchSha: PATCH,
              automationSha: AUTO, changedFiles: ['cypress/Pages/LeavePage.ts'], outsideAllowed: [], weakened: [], addedSpecs: [], removedSpecs: [],
            });
          }
          case 'run': { const a = f.runAnswer(); return reply(child, a.obj, a.code); }
          case 'gc': return reply(child, { dropped: [], removed: [], killed: [] });
          default: return reply(child, { code: 'E_ARGS', message: 'unknown' }, 1);
        }
      });
      return child;
    },
    kill() { /* nothing runs long */ },
  };
}

function modeDeps(f: Fake, over: Partial<ModeDeps> = {}): Partial<ModeDeps> {
  return {
    dryRun: false,
    dryCypress: false,
    config: () => CFG,
    qa: () => QA,
    baseBranch: () => 'dev',
    workRepo: '/nowhere/erp',
    gitlab: {
      getIssue: async (iid) => (iid === f.iid ? ok({ ...f.issue, labels: [...f.issue.labels] }) : notFound()),
      notes: async () => ok([...f.notes]),
      addNote: async (_iid, body) => {
        f.writes.push({ kind: 'note', body });
        const id = f.nextNote++;
        f.notes.push(note(id, 'desk', body));
        return ok({ id });
      },
      upload: async (name) => {
        f.writes.push({ kind: 'upload', name });
        return ok({ url: `/uploads/${name}`, markdown: `[${name}](/uploads/${name})` });
      },
      editLabels: async (_iid, change) => {
        f.writes.push({ kind: 'labels', change });
        f.issue.labels = [...f.issue.labels.filter((l) => !(change.remove ?? []).includes(l)),
          ...(change.add ?? []).filter((l) => !f.issue.labels.includes(l))];
        return ok(f.issue);
      },
      scan: async (trigger) => ok(f.issue.labels.includes(trigger) ? [{ ...f.issue, labels: [...f.issue.labels] }] : []),
    },
    readiness: async () => f.readiness,
    ticket: async (iid) => ({ iid, title: f.issue.title, description: f.issue.description, labels: f.issue.labels, notes: [] }),
    git: async (args) => {
      f.git.push(args);
      const commit = /^([0-9a-f]{40})\^\{commit\}$/.exec(args[2] ?? '');
      if (args[0] === 'cat-file' && commit && f.parents.has(commit[1]!)) return '';
      const parent = /^([0-9a-f]{40})\^1$/.exec(args[2] ?? '');
      if (args[0] === 'rev-parse' && parent && f.parents.get(parent[1]!)) return f.parents.get(parent[1]!)!;
      if (args[0] === 'fetch') return '';
      if (args[0] === 'rev-parse' && args[2] === 'origin/master^{commit}') return AUTO2;
      if (args[0] === 'cat-file' && args[2]?.startsWith('origin/master:') && f.onMaster.has(args[2].slice('origin/master:'.length))) return '';
      throw new Error(`fatal: not a valid object: ${args.join(' ')}`);
    },
    session: async (input) => { f.sessions.push(input); return f.sessionOut(input); },
    impact: async (args) => { f.impactCalls.push(args); return f.impact(args); },
    erp: { add: async (dir) => { f.erpAdds.push(dir); }, remove: async (dir) => { f.erpRemoves.push(dir); } },
    lt: {
      cli: fakeCli(f),
      lease: {
        acquire: async (runId) => { if (!f.leaseFree) return false; f.acquired.push(runId); return true; },
        release: () => { /* nothing held */ },
        holder: () => (f.leaseFree ? null : { runId: 'l-other' }),
      },
      config: () => CFG,
      activeIids: () => [],
      deadlineMs: runDeadlineMs,
      git: async () => { throw new Error('the script deps never ask git here'); },
      notes: { list: async () => { throw new Error('the mode posts the start note itself'); }, add: async () => false },
    },
    sessionHold: () => null,
    loopBusy: () => false,
    reachable: () => true,
    event: () => { /* no database rows from a test */ },
    alert: async (text) => { f.alerts.push(text); /* no Slack from a test */ },
    ...over,
  };
}

const opts = (f: Fake, over: Partial<ModeDeps> = {}, assumeLabel = false) => ({
  conductor: 'test', signal: new AbortController().signal, paused: () => false, assumeLabel, deps: modeDeps(f, over),
});

/** One pass, on the scan's copy of the ticket (a snapshot, as a real scan's is). */
const pass = (f: Fake, over: Partial<ModeDeps> = {}, assumeLabel = false) =>
  advanceTicket({ ...f.issue, labels: [...f.issue.labels] }, opts(f, over, assumeLabel));

const notes = (f: Fake): string[] => f.writes.filter((w): w is { kind: 'note'; body: string } => w.kind === 'note').map((w) => w.body);
const labelEdits = (f: Fake) => f.writes.filter((w): w is Extract<Write, { kind: 'labels' }> => w.kind === 'labels').map((w) => w.change);
const runs = (f: Fake): number => f.cliCalls.filter((a) => a[0] === 'run').length;
const qaSays = (f: Fake, user: string, body: string): void => { f.notes.push(note(f.nextNote++, user, body)); };
const dryFiles = (f: Fake): string[] => {
  const dir = join(localTestsDir(f.iid), 'dry-run');
  return existsSync(dir) ? readdirSync(dir).sort() : [];
};

// ------------------------------------------------------------- DRY_RUN

test('DRY_RUN: a whole ticket in one pass — the session runs, nothing reaches GitLab, approval assumed, no Cypress', async () => {
  const f = fake();
  const o = await pass(f, { dryRun: true });

  assert.equal(o.state, 'done', o.did);
  assert.deepEqual(f.writes, [], 'not one GitLab write: no note, no label, no upload');
  assert.equal(runs(f), 0, 'a dry run starts no Cypress');
  const run = readArtifact<LocalTestsRun>(f.iid, 'local-tests-run.json');
  assert.equal(run?.status, 'skipped');
  assert.equal(run?.reason, 'a dry run starts no Cypress');

  const j = readLtJournal(f.iid)!;
  assert.equal(j.decision?.by, 'dry-run');
  assert.equal(j.lists.length, 1);
  assert.equal(j.lists[0]!.kind, 'found');
  assert.deepEqual(j.lists[0]!.specs, SPECS.map((s) => s.file));
  assert.equal(j.merged?.base, BASE, 'the first parent is learned from git');

  assert.equal(f.sessions.length, 1, 'the scope session really runs (without write tools, as every dry-run session)');
  const s = f.sessions[0]!;
  assert.equal(s.cfg.name, 'local-tests-scope');
  assert.equal(s.worktree, erpCheckoutDir(f.iid), 'it reads the ERP checkout at the merge commit');
  assert.equal(s.stateDir, undefined, 'its write scope is state/runs/<iid>, where the automation worktree is');
  assert.equal(s.gitlabMcp, false, 'the ticket is in the prompt; no GitLab server, so no GitLab write');
  assert.match(s.prompt, new RegExp(MERGE), 'the merge commit is the head it scopes');
  assert.match(s.prompt, new RegExp(BASE), 'its first parent is the base');
  assert.deepEqual(f.erpAdds, [erpCheckoutDir(f.iid)]);
  assert.ok(f.erpRemoves.includes(erpCheckoutDir(f.iid)), 'the checkout is gone after the session');
  assert.deepEqual(f.cliCalls.map((a) => a[0]), ['prepare-scope', 'capture'], 'the automation worktree captured away too');

  // What would have been posted is kept in full, in order.
  const kept = dryFiles(f);
  assert.ok(kept.some((n) => /note-list-r1/.test(n)), kept.join(', '));
  assert.ok(kept.some((n) => /note-results/.test(n)));
  assert.equal(kept.filter((n) => /labels\.json$/.test(n)).length, 2, 'Running on, then Done on — both only kept');
  const listNote = readFileSync(join(localTestsDir(f.iid), 'dry-run', kept.find((n) => /note-list-r1/.test(n))!), 'utf8');
  assert.match(listNote, /Oneshot found 2 automation tests for this ticket — waiting for QA approval/);
  assert.match(listNote, /@anosha\.saeed/);
});

test('DRY_RUN with ONESHOT_LOCAL_TESTS_DRY_CYPRESS: the run really happens locally, and still nothing reaches GitLab', async () => {
  const f = fake({ runAnswer: () => ({ obj: runAnswer({ status: 'passed', totals: { specs: 2, tests: 9, passed: 9, failed: 0, skipped: 0 } }), code: 0 }) });
  const o = await pass(f, { dryRun: true, dryCypress: true });

  assert.equal(o.state, 'done', o.did);
  assert.equal(runs(f), 1);
  const call = f.cliCalls.find((a) => a[0] === 'run')!;
  assert.equal(call[call.indexOf('--ref') + 1], MERGE);
  assert.equal(call[call.indexOf('--base') + 1], BASE);
  assert.equal(call[call.indexOf('--worktree') + 1], '/nowhere/erp');
  assert.deepEqual(f.writes, [], 'not even the start note');
  assert.ok(dryFiles(f).some((n) => /note-start-/.test(n)), 'the start note is kept like every other');
  assert.equal(readArtifact<LocalTestsRun>(f.iid, 'local-tests-run.json')?.status, 'passed');
});

test('DRY_RUN, no test found: approval assumed, marked done without a run — all of it only kept', async () => {
  const f = fake({ sessionOut: () => ({ ok: true, data: NOT_FOUND, blocked: null, summary: '', turns: 9, weighted: 500, sessionId: 's', rateLimited: false }) });
  const o = await pass(f, { dryRun: true });

  assert.equal(o.state, 'done');
  assert.match(o.did, /approved without local tests/);
  assert.deepEqual(f.writes, []);
  assert.equal(runs(f), 0);
  const kept = dryFiles(f);
  const nf = readFileSync(join(localTestsDir(f.iid), 'dry-run', kept.find((n) => /note-list-r1/.test(n))!), 'utf8');
  assert.match(nf, /Oneshot found no automation test for this ticket/);
  assert.match(nf, /Verify that the banner can be dismissed for a week/);
  assert.ok(kept.some((n) => /note-approved-without-tests/.test(n)));
});

test('DRY_RUN --assume-label: any merged ticket, labelled or not; --local-tests refuses it outside a dry run', async () => {
  const f = fake();
  f.issue.labels = ['Minor'];
  const plain = await runLocalTestsOnce(f.iid, opts(f, { dryRun: true }));
  assert.match(plain.did, /"Ready for Automation Testing" is not on #\d+ — nothing to do \(a dry run may pass --assume-label\)/);
  assert.equal(f.sessions.length, 0);

  const assumed = await runLocalTestsOnce(f.iid, opts(f, { dryRun: true }, true));
  assert.equal(assumed.state, 'done', assumed.did);
  assert.deepEqual(f.writes, []);

  const again = await runLocalTestsOnce(f.iid, opts(f, { dryRun: true }, true));
  assert.equal(again.state, 'done', 'a finished rehearsal is archived and rehearsed again');
  assert.equal(f.sessions.length, 2);

  const real = await runLocalTestsOnce(f.iid, opts(f, {}, true));
  assert.match(real.did, /--assume-label is only allowed with DRY_RUN=1/);
});

test('DRY_RUN alerts nobody: a stuck rehearsal is logged and kept, never sent to Slack', async () => {
  const failing = (): PhaseOutput => ({ ok: false, data: null, blocked: null, summary: '', turns: 30, weighted: 4000, sessionId: 's', rateLimited: false, error: 'timed out after 30m' });
  const f = fake({ sessionOut: failing });
  const sent: string[] = [];
  await pass(f, { dryRun: true, alert: async (t) => { sent.push(t); } });
  const o = await pass(f, { dryRun: true, alert: async (t) => { sent.push(t); } });
  assert.equal(o.state, 'stuck');
  assert.deepEqual(sent, []);
  assert.deepEqual(f.writes, []);
  assert.ok(dryFiles(f).some((n) => /alert\.txt$/.test(n)));
});

test('DRY_RUN still checks the merge: an unmerged change waits, quietly', async () => {
  const f = fake();
  f.readiness = { ...ready(f.iid), verdict: 'not-ready', ready: false, mergedMr: null, reason: 'no linked merge request is merged into dev yet: !321 is still open' };
  const o = await pass(f, { dryRun: true }, true);
  assert.equal(o.state, 'waiting');
  assert.equal(f.sessions.length, 0);
  assert.deepEqual(dryFiles(f), [], 'nothing posted, not even in a dry run');
});

// ------------------------------------------------------------- a real ticket

test('real: list → QA approved → Running → run on the merge commit → results → Automation Testing Done', async () => {
  const f = fake();

  const first = await pass(f);
  assert.equal(first.state, 'awaiting-qa', first.did);
  assert.match(first.did, /round 1 waiting on QA/);
  assert.equal(notes(f).length, 1);
  const list1 = notes(f)[0]!;
  assert.match(list1, /^\*\*Oneshot found 2 automation tests for this ticket — waiting for QA approval to run them locally\.\*\*/);
  assert.match(list1, /@anosha\.saeed/);
  assert.match(list1, /@arsal\.tariq/);
  assert.ok(list1.includes(postMarker('list-r1', readLtJournal(f.iid)!.runId)));
  assert.deepEqual(labelEdits(f), [], 'nothing labelled while QA decides');

  // Someone outside QA approving changes nothing.
  qaSays(f, 'hira.ijaz', 'approved');
  assert.match((await pass(f)).did, /waiting on QA/);
  assert.equal(runs(f), 0);

  qaSays(f, 'arsal.tariq', 'approved');
  const done = await pass(f);
  assert.equal(done.state, 'done', done.did);
  assert.match(done.did, /failed, results posted, marked "Automation Testing Done"/);

  assert.deepEqual(labelEdits(f), [
    { remove: [TRIGGER, DONE], add: [RUNNING] },
    { remove: [RUNNING], add: [DONE] },
  ]);
  assert.deepEqual(f.issue.labels.sort(), [DONE, 'Minor'].sort(), 'every other label kept');
  assert.equal(runs(f), 1, 'exactly the approved list, once');
  const call = f.cliCalls.find((a) => a[0] === 'run')!;
  const arg = (flag: string): string | undefined => call[call.indexOf(flag) + 1];
  assert.equal(arg('--ref'), MERGE);
  assert.equal(arg('--base'), BASE);
  assert.equal(arg('--patch-sha'), PATCH);
  assert.deepEqual(JSON.parse(readFileSync(arg('--specs-file')!, 'utf8')).specs, SPECS.map((s) => s.file));
  assert.deepEqual(f.acquired, [readLtJournal(f.iid)!.runId], 'under the desk\'s Cypress lease');

  const posted = notes(f);
  assert.equal(posted.length, 3, 'list, start note, results');
  assert.match(posted[1]!, /Local automation run started/);
  assert.match(posted[2]!, /Local automation results/);
  assert.match(posted[2]!, /Marked \*\*Automation Testing Done\*\*\./);
  assert.match(posted[2]!, /FYI @hira\.ijaz/, 'a failure that passes on dev names the MR\'s author');

  // Done is done.
  const again = await pass(f);
  assert.equal(again.state, 'done');
  assert.match(again.did, /already Automation Testing Done/);
  assert.equal(runs(f), 1);
});

test('real: no test found, QA approved — marked done in one edit, a short record, nothing run', async () => {
  const f = fake({ sessionOut: () => ({ ok: true, data: NOT_FOUND, blocked: null, summary: '', turns: 9, weighted: 500, sessionId: 's', rateLimited: false }) });
  await pass(f);
  assert.match(notes(f)[0]!, /^\*\*Oneshot found no automation test for this ticket\.\*\*/);
  assert.match(notes(f)[0]!, /Checked: workstream-automation master \(commit `ccccccc`\)/);

  qaSays(f, 'anosha.saeed', 'approved');
  const o = await pass(f);
  assert.equal(o.state, 'done');
  assert.deepEqual(labelEdits(f), [{ remove: [TRIGGER], add: [DONE] }]);
  assert.match(notes(f)[1]!, /no automation test exists for this change; approved by @anosha\.saeed without local tests/);
  assert.equal(runs(f), 0);
});

test('real: "check again" re-checks master with no session, and the list goes back to QA', async () => {
  const f = fake({ sessionOut: () => ({ ok: true, data: NOT_FOUND, blocked: null, summary: '', turns: 9, weighted: 500, sessionId: 's', rateLimited: false }) });
  await pass(f);

  // Still nothing on master.
  f.impact = (args) => (args[0] === 'estimate' ? { ok: true, data: { totals: { estimatedMinutes: 1 } } }
    : { ok: true, data: { specs: [{ file: 'cypress/e2e/leaves/smoke.cy.ts', reasons: ['module leaves (leaves)'] }] } });
  qaSays(f, 'arsal.tariq', 'disapproved: please check again');
  const still = await pass(f);
  assert.equal(still.state, 'awaiting-qa');
  assert.equal(f.sessions.length, 1, 'no second session');
  assert.match(notes(f)[1]!, /^\*\*Checked workstream-automation master again \(commit `ccccccc`\): still no automation test reaches this change\.\*\*/);
  const analysis = f.impactCalls[0]!;
  assert.deepEqual(analysis.slice(0, 6), ['--erp', '/nowhere/erp', '--base', BASE, '--head', MERGE]);
  assert.equal(analysis[analysis.indexOf('--automation') + 1], join(runDir(f.iid), 'wsa'));
  assert.deepEqual(f.cliCalls.slice(-2).map((a) => a[0]), ['prepare-scope', 'capture'], 'never a worktree left behind');

  // QA has pushed one now.
  f.impact = (args) => (args[0] === 'estimate' ? { ok: true, data: { totals: { estimatedMinutes: 2 } } }
    : { ok: true, data: { specs: [{ file: 'cypress/e2e/leaves/banner.cy.ts', its: 2, reasons: ['imports cypress/Pages/Banner.ts, which selects \'banner\''] }] } });
  qaSays(f, 'arsal.tariq', 'disapproved: check again please');
  await pass(f);
  assert.match(notes(f)[2]!, /Oneshot found 1 automation test for this ticket — waiting for QA approval/);
  assert.match(notes(f)[2]!, /banner\.cy\.ts/);
  const j = readLtJournal(f.iid)!;
  assert.deepEqual(j.lists[2]!.specs, ['cypress/e2e/leaves/banner.cy.ts']);
  assert.equal(j.lists[2]!.patchSha, null);

  qaSays(f, 'arsal.tariq', 'approved');
  assert.equal((await pass(f)).state, 'done');
  const call = f.cliCalls.find((a) => a[0] === 'run')!;
  assert.deepEqual(JSON.parse(readFileSync(call[call.indexOf('--specs-file') + 1]!, 'utf8')).specs, ['cypress/e2e/leaves/banner.cy.ts']);
});

test('real: "added <file>" looks each path up on master; the ones there join the list, the rest are named', async () => {
  const f = fake({ writePatch: true });
  await pass(f);
  f.onMaster.add('cypress/e2e/leaves/LV_23_total.cy.ts');
  qaSays(f, 'anosha.saeed', 'disapproved: added cypress/e2e/leaves/LV_23_total.cy.ts and cypress/e2e/leaves/typo.cy.ts');
  const o = await pass(f);
  assert.equal(o.state, 'awaiting-qa');
  assert.ok(f.git.some((a) => a[0] === 'fetch'), 'the automation clone is fetched first');
  const j = readLtJournal(f.iid)!;
  const r2 = j.lists[1]!;
  assert.equal(r2.source, 'added');
  assert.deepEqual(r2.specs, [...SPECS.map((s) => s.file), 'cypress/e2e/leaves/LV_23_total.cy.ts']);
  assert.deepEqual(r2.unknown, ['cypress/e2e/leaves/typo.cy.ts']);
  assert.equal(r2.automationSha, AUTO2, 'master as it is now');
  assert.equal(r2.patchSha, PATCH, 'round 1\'s temporary changes are kept, though QA\'s push moved master');
  assert.equal(r2.patchFile, j.lists[0]!.patchFile);
  assert.equal(r2.patchFromRound, 1);
  const n2 = notes(f)[1]!;
  assert.match(n2, /Oneshot found 3 automation tests/);
  assert.match(n2, /typo\.cy\.ts/);
  assert.match(n2, /\*\*Temporary changes kept from round 1:\*\* 1 file \(`cypress\/Pages\/LeavePage\.ts`\), never committed — cut against workstream-automation `ccccccc` and applied on top of `eeeeeee`/);
  assert.match(n2, /The patch is attached\./);
  assert.match(n2, /\[patch-r1\.patch\]/, 'the patch itself goes with the note');
  assert.equal(f.sessions.length, 1, 'no session for a lookup');

  qaSays(f, 'anosha.saeed', 'approved');
  assert.equal((await pass(f)).state, 'done');
  const call = f.cliCalls.find((a) => a[0] === 'run')!;
  assert.equal(call[call.indexOf('--patch-sha') + 1], PATCH, 'the run applies the kept patch');
  assert.equal(call[call.indexOf('--automation-sha') + 1], AUTO2, 'on top of master as QA left it');
});

test('real: "write a temporary test" and plain feedback each run the scope session again, with what QA asked', async () => {
  const f = fake({ sessionOut: () => ({ ok: true, data: NOT_FOUND, blocked: null, summary: '', turns: 9, weighted: 500, sessionId: 's', rateLimited: false }) });
  await pass(f);
  assert.doesNotMatch(f.sessions[0]!.prompt, /QA asked for a temporary test/, 'a first round writes no test of its own');

  f.sessionOut = () => ({ ok: true, data: scope({ edits: [{ file: 'cypress/e2e/leaves/LV_LOCAL_banner.ts', kind: 'add', why: 'QA asked', erpEvidence: 'x:1' }] }), blocked: null, summary: '', turns: 20, weighted: 1500, sessionId: 's2', rateLimited: false });
  qaSays(f, 'arsal.tariq', 'disapproved: write a temporary test');
  await pass(f);
  assert.equal(f.sessions.length, 2);
  assert.match(f.sessions[1]!.prompt, /QA asked for a temporary test/);
  assert.match(notes(f)[1]!, /Oneshot found 2 automation tests/);

  qaSays(f, 'anosha.saeed', 'disapproved:\n- also run LV_23\n- remove LV_21');
  await pass(f);
  assert.equal(f.sessions.length, 3);
  assert.match(f.sessions[2]!.prompt, /also run LV_23/);
  assert.match(f.sessions[2]!.prompt, /remove LV_21/);
  assert.equal(readLtJournal(f.iid)!.lists.length, 3);
});

test('real: a setup error puts the trigger back, says why, and asks QA again; their next approval retries', async () => {
  let attempt = 0;
  const f = fake({
    runAnswer: () => (attempt++ === 0
      ? { obj: { code: 'E_MIGRATE_FAILED', message: 'leaves.0042 failed', hint: 'see migrate.log' }, code: 3 }
      : { obj: runAnswer({ status: 'passed' }), code: 0 }),
  });
  await pass(f);
  qaSays(f, 'arsal.tariq', 'approved');
  const o = await pass(f);
  assert.equal(o.state, 'awaiting-qa', o.did);
  assert.deepEqual(labelEdits(f), [{ remove: [TRIGGER, DONE], add: [RUNNING] }, { remove: [RUNNING], add: [TRIGGER] }]);
  const posted = notes(f);
  assert.match(posted[posted.length - 2]!, /Oneshot could not run the local automation tests:\*\* E_MIGRATE_FAILED: leaves\.0042 failed/);
  assert.match(posted[posted.length - 1]!, /waiting for QA approval to run them locally/, 'the same list, put to QA again');
  assert.ok(!f.issue.labels.includes(DONE), 'not marked done');

  qaSays(f, 'arsal.tariq', 'approved');
  const retried = await pass(f);
  assert.equal(retried.state, 'done', retried.did);
  assert.equal(runs(f), 2, 'the retry ran — a setup error is never reused');
});

test('real: a busy desk parks with Running on, and the next tick runs it', async () => {
  const f = fake({ leaseFree: false });
  await pass(f);
  qaSays(f, 'arsal.tariq', 'approved');
  const parked = await pass(f);
  assert.equal(parked.state, 'running');
  assert.match(parked.did, /parked — another run \(l-other\) is using Cypress/);
  assert.equal(runs(f), 0);
  assert.ok(f.issue.labels.includes(RUNNING));

  f.leaseFree = true;
  // The trigger is off now: the scan cannot find it, the tick's sweep does.
  await localTestsTick(opts(f));
  assert.equal(readLtJournal(f.iid)!.state, 'done');
  assert.equal(runs(f), 1);
});

test('real: a note posted before a crash is adopted, never posted twice', async () => {
  const f = fake();
  const j = newLtJournal(f.iid, f.issue.title);
  j.state = 'awaiting-qa';
  j.merged = { mrIid: 321, title: 'Fix the leave total', mergeSha: MERGE, base: BASE, sourceBranch: 'oneshot/x', targetBranch: 'dev', author: 'hira.ijaz', url: '' };
  j.lists = [list({ noteId: null, postedAt: null, specs: SPECS.map((s) => s.file) })];
  writeLtJournal(j);
  saveList(f.iid, 1, scope());
  f.notes.push(note(777, 'desk', `the list\n\n${postMarker('list-r1', j.runId)}`));

  const o = await pass(f);
  assert.match(o.did, /round 1 waiting on QA/);
  assert.deepEqual(f.writes, []);
  assert.equal(readLtJournal(f.iid)!.lists[0]!.noteId, 777);

  // Another request's note (another run id) is never adopted.
  const other = fake();
  other.notes.push(note(778, 'desk', `old\n\n${postMarker('list-r1', 'l-an-earlier-request')}`));
  other.notes.push(note(779, 'desk', `results\n\n${postMarker('results-0123456789ab', 'l-an-earlier-request')}`));
  await pass(other);
  assert.equal(notes(other).length, 1, 'posted fresh');
});

test('real: the trigger taken off mid-flight stops silently, journal kept; back on, it carries on', async () => {
  const f = fake();
  await pass(f);
  f.issue.labels = ['Minor'];
  qaSays(f, 'arsal.tariq', 'approved');
  const o = await pass(f);
  assert.match(o.did, /no "Ready for Automation Testing" label/);
  assert.equal(readLtJournal(f.iid)!.state, 'awaiting-qa');
  assert.equal(f.writes.length, 1, 'only the list from before');

  f.issue.labels = [TRIGGER, 'Minor'];
  assert.equal((await pass(f)).state, 'done');
});

test('real: labelled but not merged waits quietly, then starts once the merge is there', async () => {
  const f = fake();
  f.readiness = { ...ready(f.iid), verdict: 'not-ready', ready: false, mergedMr: null, reason: '!321 is still open' };
  const waiting = await pass(f);
  assert.equal(waiting.state, 'waiting');
  assert.deepEqual(f.writes, []);
  assert.match((await pass(f)).did, /^hold — waiting for the change to be merged/, 'not asked again inside the cadence');

  f.readiness = ready(f.iid);
  f.issue.updated_at = '2026-10-09T11:30:00Z';
  const started = await pass(f);
  assert.equal(started.state, 'awaiting-qa');
  assert.equal(notes(f).length, 1);
});

test('real: two failed scope sessions make the ticket stuck; a QA comment releases it', async () => {
  const failing = (): PhaseOutput => ({ ok: false, data: null, blocked: null, summary: '', turns: 30, weighted: 4000, sessionId: 's', rateLimited: false, error: 'timed out after 30m' });
  const f = fake({ sessionOut: failing });
  assert.match((await pass(f)).did, /scope attempt 1 of 2 failed/);
  const stuck = await pass(f);
  assert.equal(stuck.state, 'stuck');
  const said = notes(f)[0]!;
  assert.match(said, /could not choose the local automation tests for this ticket:\*\* timed out after 30m/);
  assert.match(said, /No label was changed/, 'the stuck note says nothing was swapped');
  assert.doesNotMatch(said, /is back on the ticket/, 'not the setup-error note, which claims a label swap');
  assert.match(said, /@anosha\.saeed @arsal\.tariq — any comment from you on this ticket makes Oneshot try again/);
  assert.deepEqual(labelEdits(f), []);
  assert.equal(f.alerts.length, 1);
  assert.match(f.alerts[0]!, /No label was changed\. Any comment from a QA reviewer on the ticket makes Oneshot try again\./,
    'the alert says how to release it');
  assert.match((await pass(f)).did, /stuck — waiting for a QA reviewer/);

  f.sessionOut = () => ({ ok: true, data: scope(), blocked: null, summary: '', turns: 12, weighted: 900, sessionId: 's', rateLimited: false });
  qaSays(f, 'hira.ijaz', 'retry please');
  assert.match((await pass(f)).did, /stuck/, 'only QA releases it');
  qaSays(f, 'anosha.saeed', 'retry please');
  const released = await pass(f);
  assert.equal(released.state, 'awaiting-qa', released.did);
  assert.equal(f.sessions.length, 3);
});

test('real: a finished ticket with the trigger put back is a new request', async () => {
  const f = fake();
  await pass(f);
  qaSays(f, 'arsal.tariq', 'approved');
  await pass(f);
  const firstRun = readLtJournal(f.iid)!.runId;
  f.issue.labels = [TRIGGER, 'Minor'];
  const o = await pass(f);
  assert.equal(o.state, 'awaiting-qa');
  assert.notEqual(readLtJournal(f.iid)!.runId, firstRun, 'a fresh journal, so no earlier note or approval counts');
  assert.equal(f.sessions.length, 2);
});

/** The fake GitLab with some calls replaced — never the real module's, which the mode would fall back to. */
const withGitlab = (f: Fake, part: Partial<ModeDeps['gitlab']>): Partial<ModeDeps> => ({ gitlab: { ...modeDeps(f).gitlab!, ...part } });

/** A label edit as the fake applies it, then whatever `answer` says GitLab replied. */
const editThen = (f: Fake, answer: () => GitlabResult<Issue>) => async (_iid: number, change: { add?: string[]; remove?: string[] }) => {
  f.writes.push({ kind: 'labels', change });
  return answer();
};
const lostReply = <T>(): GitlabResult<T> => ({ ok: false, kind: 'network', status: 0, data: null });

/** An approved list whose start label edit was sent, as a journal on disk. */
function approvedJournal(f: Fake, over: Partial<LocalTestsJournal> = {}): LocalTestsJournal {
  const j = newLtJournal(f.iid, f.issue.title);
  Object.assign(j, {
    state: 'approved',
    merged: { mrIid: 321, title: 'Fix the leave total', mergeSha: MERGE, base: BASE, sourceBranch: 'oneshot/x', targetBranch: 'dev', author: 'hira.ijaz', url: '' },
    lists: [list({ specs: SPECS.map((x) => x.file) })],
    decision: { round: 1, by: 'arsal.tariq', noteId: 501, at: '2026-10-09T11:00:00Z' },
    ...over,
  });
  writeLtJournal(j);
  saveList(f.iid, 1, scope());
  return j;
}

test('real: a start label edit GitLab applied but never answered is finished from the labels, not lost', async () => {
  const f = fake();
  await pass(f);
  qaSays(f, 'arsal.tariq', 'approved');
  let first = true;
  const o = await pass(f, withGitlab(f, {
    editLabels: async (iid, change) => {
      // GitLab applies it either way; the first answer never arrives.
      await modeDeps(f).gitlab!.editLabels!(iid, change);
      if (first) { first = false; return lostReply(); }
      return ok(f.issue);
    },
  }));
  assert.equal(o.state, 'done', o.did);
  assert.equal(runs(f), 1, 'the run went ahead: the ticket showed the edit made');
  assert.deepEqual(labelEdits(f), [{ remove: [TRIGGER, DONE], add: [RUNNING] }, { remove: [RUNNING], add: [DONE] }],
    'and the edit was not sent twice');
  assert.equal(readLtJournal(f.iid)!.pendingLabels, undefined);
});

test('real: a crash right after the start label edit is picked up by the tick, though the trigger is gone', async () => {
  const f = fake();
  approvedJournal(f, { pendingLabels: 'running' });
  f.issue.labels = [RUNNING, 'Minor'];   // the edit landed; the journal never heard
  await localTestsTick(opts(f));
  const j = readLtJournal(f.iid)!;
  assert.equal(j.state, 'done');
  assert.equal(runs(f), 1);
  assert.deepEqual(labelEdits(f), [{ remove: [RUNNING], add: [DONE] }], 'the start edit is not sent again');
  assert.equal(j.pendingLabels, undefined);

  // `--local-tests` sees it as owed too.
  const g = fake();
  approvedJournal(g, { pendingLabels: 'running' });
  g.issue.labels = [RUNNING, 'Minor'];
  assert.equal((await runLocalTestsOnce(g.iid, opts(g))).state, 'done');
});

test('real: a start label edit that really failed is sent again; one withdrawn meanwhile stops quietly', async () => {
  const refused = (f: Fake) => withGitlab(f, { editLabels: editThen(f, () => ({ ok: false, kind: 'server', status: 500, data: null })) });

  const f = fake();
  await pass(f);
  qaSays(f, 'arsal.tariq', 'approved');
  const held = await pass(f, refused(f));
  assert.match(held.did, /^hold — could not mark #\d+ "Running TestCases Locally"$/);
  assert.equal(readLtJournal(f.iid)!.pendingLabels, 'running');
  assert.ok(f.issue.labels.includes(TRIGGER), 'nothing changed on the ticket');
  const o = await pass(f);
  assert.equal(o.state, 'done', o.did);
  assert.equal(runs(f), 1);

  const g = fake();
  await pass(g);
  qaSays(g, 'arsal.tariq', 'approved');
  await pass(g, refused(g));
  g.issue.labels = ['Minor'];   // QA took the request back before any edit landed
  const stopped = await pass(g);
  assert.match(stopped.did, /"Ready for Automation Testing" is not on the ticket — stopped/);
  const j = readLtJournal(g.iid)!;
  assert.equal(j.pendingLabels, undefined);
  assert.equal(j.state, 'approved');
  assert.equal(runs(g), 0);
  assert.match((await pass(g)).did, /no "Ready for Automation Testing" label/, 'and stays stopped');
});

test('real: an approval withdrawn before the start step is never acted on, though the scan still showed the trigger', async () => {
  const f = fake();
  await pass(f);
  qaSays(f, 'arsal.tariq', 'approved');
  const scanned = { ...f.issue, labels: [...f.issue.labels] };
  f.issue.labels = ['Minor'];   // withdrawn while another ticket held the pass
  const o = await advanceTicket(scanned, opts(f));
  assert.match(o.did, /"Ready for Automation Testing" is not on the ticket — stopped/);
  assert.deepEqual(labelEdits(f), []);
  assert.equal(runs(f), 0);
  assert.equal(readLtJournal(f.iid)!.state, 'approved');
});

test('real: a reply after another Oneshot request is not read as approval; the list is put to QA again', async () => {
  const f = fake();
  await pass(f);
  f.notes.push(note(f.nextNote++, 'desk', '**Automation test cases**\n\n<!-- oneshot:automation:cases:v1:abc -->'));
  qaSays(f, 'arsal.tariq', 'approved');
  const o = await pass(f);
  assert.equal(o.state, 'awaiting-qa', o.did);
  assert.match(o.did, /round 2 waiting on QA/);
  assert.equal(runs(f), 0);
  assert.deepEqual(labelEdits(f), []);
  const j = readLtJournal(f.iid)!;
  assert.equal(j.decision, undefined);
  assert.deepEqual(j.lists[1]!.askedAgain?.by, 'arsal.tariq');
  assert.deepEqual(j.lists[1]!.specs, j.lists[0]!.specs, 'the same list');
  const again = notes(f)[1]!;
  assert.match(again, /^\*\*Oneshot found 2 automation tests for this ticket — waiting for QA approval/, 'the headline stays first');
  assert.match(again, /\*\*Asked again:\*\* the reply from `@arsal\.tariq` came after another Oneshot request on this ticket/);

  qaSays(f, 'arsal.tariq', 'approved');
  assert.equal((await pass(f)).state, 'done');
  assert.equal(runs(f), 1);
});

test('real: a re-requested run takes the old Done label off while it runs, and runs Cypress again', async () => {
  const f = fake();
  await pass(f);
  qaSays(f, 'arsal.tariq', 'approved');
  await pass(f);
  assert.equal(runs(f), 1);
  f.issue.labels = [...f.issue.labels, TRIGGER];   // Done is still on
  assert.equal((await pass(f)).state, 'awaiting-qa');
  qaSays(f, 'anosha.saeed', 'approved');
  const o = await pass(f);
  assert.equal(o.state, 'done', o.did);
  assert.deepEqual(labelEdits(f).slice(2), [{ remove: [TRIGGER, DONE], add: [RUNNING] }, { remove: [RUNNING], add: [DONE] }]);
  assert.equal(runs(f), 2, 'a new request is a new run, never the earlier request\'s results again');
  assert.deepEqual([...f.issue.labels].sort(), [DONE, 'Minor'].sort());
});

test('real: another desk\'s request under way on the ticket is left to it; once it finishes, this desk may go', async () => {
  const f = fake();
  f.notes.push(note(900, 'other.desk', `list\n\n${postMarker('list-r1', 'l-otherdesk-abcdef')}`, { created_at: new Date().toISOString() }));
  const o = await pass(f);
  assert.match(o.did, /^skipped — another desk's request \(l-otherdesk-abcdef\) is under way on the ticket$/);
  assert.equal(f.sessions.length, 0, 'no session, nothing posted');
  assert.deepEqual(f.writes, []);
  assert.equal(readLtJournal(f.iid)!.otherDesk?.runId, 'l-otherdesk-abcdef');

  f.notes.push(note(901, 'other.desk', `results\n\n${postMarker('results-0123456789ab', 'l-otherdesk-abcdef')}`));
  const after = await pass(f);
  assert.equal(after.state, 'awaiting-qa', after.did);
  assert.equal(f.sessions.length, 1);
  assert.equal(readLtJournal(f.iid)!.otherDesk, undefined);

  // A dry run writes nothing, so it is never held.
  const g = fake();
  g.notes.push(note(900, 'other.desk', `list\n\n${postMarker('list-r1', 'l-otherdesk-abcdef')}`, { created_at: new Date().toISOString() }));
  assert.equal((await pass(g, { dryRun: true })).state, 'done');
});

test('real: the approved list keeps its patch, and the run its record, though the Loop archives state/runs/<iid>', async () => {
  const f = fake({ writePatch: true });
  await pass(f);
  const kept = join(localTestsDir(f.iid), 'patch-r1.patch');
  assert.equal(readLtJournal(f.iid)!.lists[0]!.patchFile, kept);
  assert.ok(existsSync(kept));
  assert.ok(f.writes.some((w) => w.kind === 'upload' && w.name === 'patch-r1.patch'), 'the list note attaches the kept copy');

  rmSync(runDir(f.iid), { recursive: true, force: true });   // the Loop claimed the ticket again
  qaSays(f, 'arsal.tariq', 'approved');
  let looked = 0;
  // Free at the run, busy again by the report: the Loop took the ticket in between.
  const o = await pass(f, { loopBusy: () => looked++ > 0 });
  assert.equal(o.state, 'reporting', o.did);
  assert.match(o.did, /^hold — the Loop has a run of this ticket in flight/);
  const call = f.cliCalls.find((a) => a[0] === 'run')!;
  assert.equal(call[call.indexOf('--patch') + 1], kept, 'the run applies the copy beside the journal');
  const j = readLtJournal(f.iid)!;
  assert.equal((readRunRecord(f.iid) as { cacheKey?: string } | null)?.cacheKey, j.run?.cacheKey);

  rmSync(runDir(f.iid), { recursive: true, force: true });   // archived again before the report
  const done = await pass(f);
  assert.equal(done.state, 'done', done.did);
  assert.match(notes(f)[notes(f).length - 1]!, /Local automation results/);
});

test('real: the Loop busy at the run holds it with Running on; the next pass runs it', async () => {
  const f = fake();
  await pass(f);
  qaSays(f, 'arsal.tariq', 'approved');
  const held = await pass(f, { loopBusy: () => true });
  assert.equal(held.state, 'running');
  assert.match(held.did, /^hold — the Loop has a run of this ticket in flight/);
  assert.equal(runs(f), 0);
  assert.equal((await pass(f)).state, 'done');
  assert.equal(runs(f), 1);
});

test('DRY_RUN: after a setup error, running --local-tests again is the retry', async () => {
  let attempt = 0;
  const f = fake({
    runAnswer: () => (attempt++ === 0
      ? { obj: { code: 'E_MIGRATE_FAILED', message: 'leaves.0042 failed' }, code: 3 }
      : { obj: runAnswer({ status: 'passed' }), code: 0 }),
  });
  const dry = { dryRun: true, dryCypress: true };
  const first = await runLocalTestsOnce(f.iid, opts(f, dry));
  assert.match(first.did, /setup error — a dry run does not retry/);
  assert.equal(runs(f), 1);
  assert.match((await pass(f, dry)).did, /setup error — a dry run does not retry/, 'a tick never retries it by itself');
  assert.equal(runs(f), 1);
  const again = await runLocalTestsOnce(f.iid, opts(f, dry));
  assert.equal(again.state, 'done', again.did);
  assert.equal(runs(f), 2);
  assert.deepEqual(f.writes, []);
});

test('readiness: the base it names is used as is; one the clone lacks falls back to the first parent', async () => {
  const f = fake();
  const FF_BASE = '7'.repeat(40);
  f.parents.set(FF_BASE, '');
  f.readiness = ready(f.iid, { base: FF_BASE });
  await pass(f);
  assert.equal(readLtJournal(f.iid)!.merged!.base, FF_BASE);
  assert.ok(!f.git.some((a) => a[0] === 'rev-parse' && a[2] === `${MERGE}^1`), 'no ^1: that is the MR\'s own previous commit');
  assert.match(f.sessions[0]!.prompt, new RegExp(FF_BASE), 'the scope reads base..head from it');

  const g = fake();
  g.readiness = ready(g.iid, { base: '6'.repeat(40) });
  await pass(g);
  assert.equal(readLtJournal(g.iid)!.merged!.base, BASE);

  const h = fake();
  h.readiness = ready(h.iid, { base: '--upload-pack=x' as string });
  await pass(h);
  assert.equal(readLtJournal(h.iid)!.merged!.base, BASE, 'anything but a commit id is never handed to git');
});

/** A ticket with three merged MRs of its own: !305 (whose commits the clone lacks), !310, then !321, the one tested. */
function threeMrs(f: Fake): void {
  f.parents.set(EARLY, EARLY_BASE);
  f.parents.set(EARLY_BASE, '');
  f.readiness = ready(f.iid, {
    ranges: [{ mrIid: 305, base: null, head: '8'.repeat(40) }, { mrIid: 310, base: null, head: EARLY }, { mrIid: 321, base: null, head: MERGE }],
  });
  f.impact = (args) => {
    if (args[0] === 'estimate') return { ok: true, data: { totals: { estimatedMinutes: 3 } } };
    if (args[args.indexOf('--head') + 1] !== EARLY) return { ok: true, data: { specs: [] } };
    return {
      ok: true,
      data: {
        specs: [
          { file: 'cypress/e2e/training/evaluator.cy.ts', module: 'training', its: 4, reasons: ['imports cypress/Pages/Training.ts, which selects \'evaluator\''] },
          { file: SPECS[0]!.file, its: 6, reasons: ['opens the form'] },
        ],
      },
    };
  };
}

test('ranges: the scope covers each of the ticket\'s own merged MRs, and the note names every one', async () => {
  const f = fake();
  threeMrs(f);
  await pass(f);
  const earlier = f.impactCalls.filter((a) => a[0] === '--erp');
  assert.equal(earlier.length, 1, 'the analysis for the earlier MR; the session scopes the tested one');
  assert.deepEqual(earlier[0]!.slice(0, 6), ['--erp', '/nowhere/erp', '--base', EARLY_BASE, '--head', EARLY]);
  assert.deepEqual(f.impactCalls.find((a) => a[0] === 'estimate')!.slice(3), ['cypress/e2e/training/evaluator.cy.ts']);
  const j = readLtJournal(f.iid)!;
  assert.deepEqual(j.merged!.ranges!.map((r) => r.mrIid), [305, 310, 321]);
  const r1 = j.lists[0]!;
  assert.deepEqual(r1.specs, [...SPECS.map((x) => x.file), 'cypress/e2e/training/evaluator.cy.ts'], 'the session\'s list, then the earlier MR\'s');
  assert.deepEqual(r1.scopedMrs, [310, 321]);
  assert.equal(r1.tests, 9 + 4);
  assert.equal(r1.estimatedMinutes, 4 + 3);
  const n = notes(f)[0]!;
  assert.match(n, /Oneshot found 3 automation tests/);
  assert.match(n, /\*\*What changed:\*\* Fix the leave total, together with this ticket's earlier merged MR !310 \(MR !321, merged as `aaaaaaa`\)\./);
  assert.match(n, /\*\*Not checked:\*\* !305, also merged for this ticket — its change could not be read/);
  assert.match(n, /From !310: imports cypress\/Pages\/Training\.ts/);

  // QA's feedback edits the whole list, which already covers !310: no analysis again.
  qaSays(f, 'anosha.saeed', 'disapproved:\n- remove LV_21');
  await pass(f);
  assert.equal(f.impactCalls.filter((a) => a[0] === '--erp').length, 1);
  assert.deepEqual(readLtJournal(f.iid)!.lists[1]!.scopedMrs, [310, 321]);
});

test('ranges: the quick re-check analyses every merged MR of the ticket and lists their specs together', async () => {
  const f = fake({ sessionOut: () => ({ ok: true, data: NOT_FOUND, blocked: null, summary: '', turns: 9, weighted: 500, sessionId: 's', rateLimited: false }) });
  threeMrs(f);
  await pass(f);
  const before = f.impactCalls.length;
  qaSays(f, 'arsal.tariq', 'disapproved: please check again');
  await pass(f);
  const analyses = f.impactCalls.slice(before).filter((a) => a[0] === '--erp');
  assert.deepEqual(analyses.map((a) => a[a.indexOf('--head') + 1]), [MERGE, EARLY], 'the tested MR, then the earlier one');
  const r2 = readLtJournal(f.iid)!.lists[1]!;
  assert.equal(r2.source, 'recheck');
  assert.deepEqual(r2.specs, ['cypress/e2e/training/evaluator.cy.ts', SPECS[0]!.file]);
  assert.deepEqual(r2.scopedMrs, [310, 321]);
  assert.match(notes(f)[1]!, /together with this ticket's earlier merged MR !310/);
});

test('the tick: the scan\'s tickets, the journals that owe writes, never one the Loop is running', async () => {
  const f = fake();
  await localTestsTick(opts(f, { loopBusy: (iid) => iid === f.iid }));
  assert.equal(f.sessions.length, 0, 'the Loop holds its run directory');
  await localTestsTick(opts(f));
  assert.equal(readLtJournal(f.iid)!.state, 'awaiting-qa');
  await localTestsTick(opts(f, { reachable: () => false }));
  assert.equal(f.writes.length, 1, 'an unreachable GitLab holds the whole pass');
});

test('gc: a scope checkout nothing holds is removed and forgotten; a ticket a live advance holds keeps everything', async () => {
  const stale = fake();
  const held = fake();
  mkdirSync(erpCheckoutDir(stale.iid), { recursive: true });
  writeLtJournal({ ...newLtJournal(stale.iid, 'stale'), holding: { erp: erpCheckoutDir(stale.iid), since: 1 } });
  mkdirSync(erpCheckoutDir(held.iid), { recursive: true });
  const release = acquireLtLock(held.iid, 'test')!;
  try {
    // Both fakes share one record of removals and script calls.
    await localTestsGc(modeDeps(stale, {
      erp: { add: async () => {}, remove: async (dir) => { stale.erpRemoves.push(dir); } },
    }));
  } finally {
    release();
  }
  assert.ok(stale.erpRemoves.includes(erpCheckoutDir(stale.iid)));
  assert.ok(!stale.erpRemoves.includes(erpCheckoutDir(held.iid)), 'in use by a live advance');
  assert.equal(readLtJournal(stale.iid)!.holding, undefined);
  const gc = stale.cliCalls.find((a) => a[0] === 'gc')!;
  assert.ok(gc[gc.indexOf('--keep') + 1]!.split(',').includes(String(held.iid)), 'the script keeps the held ticket too');

  const dry = fake();
  await localTestsGc(modeDeps(dry, { dryRun: true }));
  assert.ok(!dry.cliCalls.some((a) => a[0] === 'gc'), 'a dry run never asks the script to clear what real runs hold');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  MAX_UPLOAD_BYTES, baseShotsFor, failingOnDevText, localTestsPlanNote, localTestsReportNote, localTestsScopeReady,
  localTestsStartNote, mimeFor,
} from './publish.js';
import { artifactDir, localTestsPatchFile } from './config.js';
import { writeArtifact, type RunJournal } from './artifacts.js';
import { isMachineNote } from './claims.js';

/**
 * base-check saves `base-<case-id>.png` for every case it scores 'fails', and
 * that image is the proof the MR note asks a reviewer to confirm. It used to be
 * captured and then dropped, so the note claimed "confirmed on <base>" with
 * nothing to look at.
 */
const result = (id: string, r: string) => ({ id, result: r, evidence: 'e', screenshot: `${id}.png` });

test('a confirmed pre-existing case brings its base-branch screenshot to the MR', () => {
  const shots = baseShotsFor(
    [result('TC-01', 'pass'), result('TC-15', 'pre-existing')],
    { results: [{ id: 'TC-15', onBase: 'fails', inTicketScope: false, evidence: 'x', screenshot: 'base-TC-15.png' }] },
  );
  assert.deepEqual(shots.map((s) => [s.id, s.screenshot]), [['TC-15', 'base-TC-15.png']]);
});

test('a label the conductor refused shows no base shot, whatever the check saved', () => {
  const shots = baseShotsFor(
    [result('TC-15', 'fail')],
    { results: [{ id: 'TC-15', onBase: 'fails', inTicketScope: true, evidence: 'x', screenshot: 'base-TC-15.png' }] },
  );
  assert.deepEqual(shots, []);
});

test('only an entry the check scored fails, with a file named, contributes a shot', () => {
  const labelled = [result('TC-15', 'pre-existing'), result('TC-16', 'pre-existing')];
  assert.deepEqual(baseShotsFor(labelled, {
    results: [
      { id: 'TC-15', onBase: 'passes', screenshot: 'base-TC-15.png' },
      { id: 'TC-16', onBase: 'fails', screenshot: '  ' },
    ],
  }), []);
  assert.deepEqual(baseShotsFor(labelled, null), []);
});

// ------------------------------------------------------------- local tests

/*
 * The two local-tests notes are read by people who have not seen the pipeline:
 * a QA deciding whether the test list may change, and a developer deciding
 * whether the failures are theirs. These pin the wording they act on, and that
 * a ticket with nothing to run still gets its one line.
 */

// A throwaway iid no real run will ever claim, removed again after each test
// that writes under it. Not designgate.test.ts's 999999: test files run in
// parallel, and that file removes its run dir wholesale.
const LT_IID = 999997;
const ltCtx = {
  iid: LT_IID,
  runId: 'r-lt',
  journal: { runId: 'r-lt', iid: LT_IID, title: 't', url: '', createdAt: 0, status: 'running', phases: [] } as RunJournal,
};
const clearRun = (): void => rmSync(dirname(artifactDir(LT_IID)), { recursive: true, force: true });

const scope = (over: Record<string, unknown> = {}) => ({
  applicable: true,
  reason: 'The diff changes leave approval',
  modules: ['Leaves', 'Approvals'],
  specs: [
    { file: 'cypress/e2e/leaves/apply_leave.cy.ts', module: 'Leaves', cases: 5, ciSeconds: 300, why: 'Applies a leave' },
    { file: 'cypress/e2e/approvals/approve.cy.ts', module: 'Approvals', cases: 2, why: 'Approves it' },
  ],
  edits: [],
  proposals: [],
  estimatedMinutes: 11.6,
  summary: 'Runs the two leave specs the approval change can break.',
  ...over,
});

test('a scope that applies is posted as a plan: summary, counts, then one row per spec', () => {
  const { body, attachments } = localTestsPlanNote(scope(), ltCtx);
  const parts = body.split('\n\n');
  assert.equal(parts[0], '**Local automation tests — plan**');
  assert.equal(parts[1], 'Runs the two leave specs the approval change can break.');
  assert.equal(parts[2], '**Modules:** Leaves, Approvals · **Tests:** 2 spec files, 7 test cases · **About 12 min**');
  assert.ok(body.includes('| Spec file | Module | Why |'));
  assert.ok(body.includes('| `cypress/e2e/leaves/apply_leave.cy.ts` | Leaves | Applies a leave |'));
  assert.doesNotMatch(body, /Proposed change|temporary, not committed/);
  assert.deepEqual(attachments, [], 'no patch on disk, nothing attached');
});

test('a scope that does not apply is one line saying why', () => {
  const { body, attachments } = localTestsPlanNote(
    scope({ applicable: false, reason: 'Only a Celery task changed.', specs: [], modules: [] }), ltCtx,
  );
  assert.equal(body, '**Local automation tests:** not needed for this ticket — Only a Celery task changed.');
  assert.deepEqual(attachments, []);
});

test('proposals say which way they go; changed and new tests are listed apart, with the patch attached', () => {
  try {
    mkdirSync(dirname(localTestsPatchFile(LT_IID)), { recursive: true });
    writeFileSync(localTestsPatchFile(LT_IID), 'diff --git a/x b/x\n');
    const { body, attachments } = localTestsPlanNote(scope({
      proposals: [
        { action: 'add', title: 'Verify that a manager can reject a leave.', why: 'The ticket adds rejecting' },
        {
          action: 'remove', title: 'Verify that the old approve button shows',
          file: 'cypress/e2e/approvals/old.cy.ts', why: 'The button is gone',
        },
      ],
      edits: [
        { file: 'cypress/Pages/LeavePage.ts', kind: 'update', why: 'The button label changed', erpEvidence: 'a.js:3' },
        { file: 'cypress/e2e/leaves/reject.cy.ts', kind: 'add', why: 'Covers rejecting', erpEvidence: 'b.py:9' },
      ],
    }), ltCtx);
    assert.ok(body.includes('**Proposed change to the test list (QA approval needed):**\n'
      + '- ADD a new test: Verify that a manager can reject a leave. *Why: The ticket adds rejecting*\n'
      + '- REMOVE: `cypress/e2e/approvals/old.cy.ts` — Verify that the old approve button shows. '
      + '*Why: The button is gone*'));
    assert.ok(body.includes('**Existing tests changed for this run (temporary, not committed):**\n'
      + '- `cypress/Pages/LeavePage.ts` — The button label changed'));
    assert.ok(body.includes('**New tests added for this run (temporary, not committed):**\n'
      + '- `cypress/e2e/leaves/reject.cy.ts` — Covers rejecting'));
    assert.deepEqual(attachments.map((a) => [a.name, a.mime]), [['temporary-changes.patch', 'text/x-diff']]);
  } finally {
    clearRun();
  }
});

test('a pipe or newline in model prose cannot break the spec table open', () => {
  const { body } = localTestsPlanNote(scope({
    specs: [{ file: 'cypress/e2e/a.cy.ts', module: 'Leaves', cases: 1, why: 'Save | Cancel\nboth' }],
  }), ltCtx);
  const row = body.split('\n').find((l) => l.includes('a.cy.ts'))!;
  assert.equal(row.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).length, 3);
  assert.ok(row.includes('Save \\| Cancel<br>both'));
});

test('a blocked scope is not published until it finishes', () => {
  assert.equal(localTestsScopeReady(scope({ blocked: 'The automation clone is missing' })), false);
  assert.equal(localTestsScopeReady(scope({ blocked: null })), true);
  assert.equal(localTestsScopeReady(scope()), true);
});

const res = (spec: string, title: string, state: string, over: Record<string, unknown> = {}) =>
  ({ spec, title, state, durationMs: 1000, ...over }) as Record<string, unknown>;

const run = (over: Record<string, unknown> = {}) => ({
  status: 'failed',
  cacheKey: 'k', ticketSha: 'a'.repeat(40), automationSha: 'b'.repeat(40), patchSha: null, db: 'oneshot_lt_1_1',
  totals: { specs: 3, tests: 6, passed: 3, failed: 2, skipped: 1 },
  results: [
    res('cypress/e2e/a.cy.ts', 'applies a leave', 'passed'),
    res('cypress/e2e/a.cy.ts', 'cancels a leave', 'passed'),
    res('cypress/e2e/b.cy.ts', 'approves', 'failed', {
      error: 'AssertionError: expected Approved\n    at Context.<anonymous> (b.cy.ts:12)',
      failingOnDev: false, video: 'local-tests/videos/b.cy.ts.mp4',
    }),
    res('cypress/e2e/b.cy.ts', 'rejects', 'failed', { error: 'Timed out', failingOnDev: true }),
    res('cypress/e2e/c.cy.ts', 'exports', 'failed', { error: 'boom', failingOnDev: null }),
    res('cypress/e2e/c.cy.ts', 'emails', 'skipped'),
    res('cypress/e2e/c.cy.ts', 'lists', 'passed'),
  ],
  notRunnable: [{ spec: 'cypress/e2e/mail.cy.ts', why: 'needs a real mailbox' }],
  newTests: ['Verify that a manager can reject a leave'],
  startedAt: '2026-10-09T10:00:00Z',
  endedAt: '2026-10-09T10:04:10Z',
  ...over,
});

test('the report leads with the counts, then the failures and whether dev fails too', () => {
  const { body } = localTestsReportNote(run(), ltCtx)!;
  assert.equal(body.split('\n\n')[0], '**Local automation results** — 3 passed, 2 failed (6 tests, 4 min)');
  assert.ok(body.includes('| Spec | Result | Failing on dev too? | Reason |'));
  assert.ok(body.includes('| `cypress/e2e/b.cy.ts`<br>approves | :x: failed | no — likely caused by this ticket | '
    + 'AssertionError: expected Approved |'), 'the reason is the assertion, not the stack');
  assert.ok(body.includes('| :x: failed | yes — not caused by this ticket | Timed out |'));
  assert.ok(body.includes('| :x: failed | unknown | boom |'));
  assert.ok(body.includes('| `cypress/e2e/c.cy.ts`<br>emails | :heavy_minus_sign: skipped | — |'));
  assert.ok(body.includes('| `cypress/e2e/a.cy.ts` | :white_check_mark: passed (2 tests) | — |  |'));
  // Failures first: the row a developer has to look at is never under the green ones.
  assert.ok(body.indexOf(':x: failed') < body.indexOf(':white_check_mark:'));
});

test('the report closes with what could not run, what changed and what was added', () => {
  const { body } = localTestsReportNote(run(), ltCtx)!;
  assert.ok(body.includes("**Tests that can't run on a local machine:** `cypress/e2e/mail.cy.ts` (needs a real mailbox)"));
  assert.ok(body.includes('**Existing tests changed for this run:** none'));
  assert.ok(body.includes('**New tests added for this run:** Verify that a manager can reject a leave'));
});

test('the report names the existing tests the scope changed', () => {
  try {
    writeArtifact(LT_IID, 'local-tests-scope.json', scope({
      edits: [{ file: 'cypress/Pages/LeavePage.ts', kind: 'update', why: 'label', erpEvidence: 'a.js:1' }],
    }));
    const { body } = localTestsReportNote(run(), ltCtx)!;
    assert.ok(body.includes('**Existing tests changed for this run:** `cypress/Pages/LeavePage.ts`'));
  } finally {
    clearRun();
  }
});

test('a failed spec brings its video, and one too large to upload is named instead', () => {
  const dir = artifactDir(LT_IID);
  try {
    mkdirSync(join(dir, 'local-tests', 'videos'), { recursive: true });
    writeFileSync(join(dir, 'local-tests/videos/b.cy.ts.mp4'), 'x');
    const big = join(dir, 'local-tests/videos/c.cy.ts.mp4');
    writeFileSync(big, '');
    truncateSync(big, MAX_UPLOAD_BYTES + 1);
    const data = run();
    data.results[4]!.video = 'local-tests/videos/c.cy.ts.mp4';
    // A passing test's recording is evidence of nothing and stays off the ticket.
    data.results[0]!.video = 'local-tests/videos/a.cy.ts.mp4';
    writeFileSync(join(dir, 'local-tests/videos/a.cy.ts.mp4'), 'x');
    const { body, attachments } = localTestsReportNote(data, ltCtx)!;
    assert.deepEqual(attachments.map((a) => [a.name, a.mime]), [['b.cy.ts.mp4', 'video/mp4']]);
    assert.ok(body.includes('**Videos too large to attach (over 25 MB):** `c.cy.ts.mp4`'));
    assert.ok(body.endsWith('**Videos of the failed specs:**'), 'the uploads follow this line');
  } finally {
    clearRun();
  }
});

test('a skipped or errored run is one line with its reason', () => {
  assert.equal(localTestsReportNote(run({ status: 'skipped', reason: 'Nothing to run.', notRunnable: [] }), ltCtx)!.body,
    '**Local automation tests:** skipped — Nothing to run.');
  assert.equal(localTestsReportNote(run({ status: 'error', reason: 'Postgres refused the copy' }), ltCtx)!.body,
    '**Local automation tests:** could not be run — Postgres refused the copy. No results were recorded.');
});

test('a run skipped because every spec needs what a desk lacks names those specs', () => {
  const body = localTestsReportNote(run({
    status: 'skipped', reason: 'every planned spec needs something a local machine does not have',
    notRunnable: [{ spec: 'cypress/e2e/payroll/run.cy.ts', why: 'needs Odoo for the payroll sync' }],
  }), ltCtx)!.body;
  assert.equal(body, '**Local automation tests:** skipped — every planned spec needs something a local machine '
    + "does not have. Tests that can't run on a local machine: `cypress/e2e/payroll/run.cy.ts` "
    + '(needs Odoo for the payroll sync).');
});

test('what cut a run short is in the header, so "0 failed" never reads as "all passed"', () => {
  const body = localTestsReportNote(run({
    totals: { specs: 3, tests: 6, passed: 3, failed: 0, skipped: 3 },
    reason: 'Cypress was stopped at the 45-minute deadline; 2 spec(s) did not finish',
  }), ltCtx)!.body;
  assert.equal(body.split('\n\n')[0], '**Local automation results** — 3 passed, 0 failed (6 tests, 4 min). '
    + 'Cypress was stopped at the 45-minute deadline; 2 spec(s) did not finish.');
});

test('a test that passed only on its retry is its own row, and counted in the header', () => {
  const data = run({
    totals: { specs: 3, tests: 6, passed: 4, failed: 1, skipped: 1 },
  });
  data.results[3] = res('cypress/e2e/b.cy.ts', 'rejects', 'passed', { flaky: true, error: 'Timed out' });
  const { body } = localTestsReportNote(data, ltCtx)!;
  assert.equal(body.split('\n\n')[0], '**Local automation results** — 4 passed (1 only on a retry), 1 failed (6 tests, 4 min)');
  assert.ok(body.includes('| `cypress/e2e/b.cy.ts`<br>rejects | :warning: passed on retry — flaky | — | Timed out |'));
  // Not also in the clean count: b.cy.ts has no other passing test.
  assert.doesNotMatch(body, /`cypress\/e2e\/b\.cy\.ts` \| :white_check_mark:/);
  assert.ok(body.indexOf(':x: failed') < body.indexOf(':warning:'), 'failures still come first');
  assert.ok(body.indexOf(':warning:') < body.indexOf(':heavy_minus_sign:'));
});

test('the script\'s notes close the report — the one place that says why dev-too is unknown', () => {
  const { body } = localTestsReportNote(run({
    notes: [
      'the failures were not re-run on origin/dev: E_APP_FAILED: the base app did not start',
      'the video of cypress/e2e/c.cy.ts is 31 MB, over the 25 MB upload limit, so it was not kept',
      '  ', 42,
    ],
  }), ltCtx)!;
  assert.ok(body.includes('**Notes from the run:**\n'
    + '- the failures were not re-run on origin/dev: E_APP_FAILED: the base app did not start\n'
    + '- the video of cypress/e2e/c.cy.ts is 31 MB, over the 25 MB upload limit, so it was not kept'),
  body);
  assert.doesNotMatch(localTestsReportNote(run(), ltCtx)!.body, /Notes from the run/, 'no notes, no heading');
});

test('the report falls back to the plan\'s not-runnable list when the run carries none', () => {
  try {
    writeArtifact(LT_IID, 'local-tests-scope.json', scope({
      notRunnable: [{ spec: 'cypress/e2e/payroll/run.cy.ts', why: 'needs Odoo' }],
    }));
    const { body } = localTestsReportNote(run({ notRunnable: [] }), ltCtx)!;
    assert.ok(body.includes("**Tests that can't run on a local machine:** `cypress/e2e/payroll/run.cy.ts` (needs Odoo)"));
    const own = localTestsReportNote(run(), ltCtx)!.body;
    assert.ok(own.includes("**Tests that can't run on a local machine:** `cypress/e2e/mail.cy.ts` (needs a real mailbox)"),
      'the run\'s own list wins');
  } finally {
    clearRun();
  }
});

test('the plan names the specs that cannot run locally, on both shapes of the note', () => {
  const notRunnable = [{ spec: 'cypress/e2e/payroll/run.cy.ts', why: 'needs Odoo for the payroll sync' }];
  const plan = localTestsPlanNote(scope({ notRunnable }), ltCtx).body;
  assert.ok(plan.includes("**Tests that can't run on a local machine (not run):**\n"
    + '- `cypress/e2e/payroll/run.cy.ts` (needs Odoo for the payroll sync)'));
  const none = localTestsPlanNote(scope({ applicable: false, reason: 'Only payroll changed.', specs: [], notRunnable }), ltCtx).body;
  assert.equal(none, '**Local automation tests:** not needed for this ticket — Only payroll changed. '
    + "Tests that reach it but can't run on a local machine: `cypress/e2e/payroll/run.cy.ts` (needs Odoo for the payroll sync).");
  assert.doesNotMatch(localTestsPlanNote(scope(), ltCtx).body, /can't run/, 'an empty list adds nothing');
});

test('the start note names both commits and carries its marker', () => {
  const body = localTestsStartNote({
    tests: 7, minutes: 11.6, branch: 'oneshot/ticket-12-leave', ticketSha: 'abcdef1234567',
    automationRef: 'origin/master', automationSha: '1234567abcdef',
  });
  assert.equal(body, '**Local automation run started** — 7 tests, about 12 min. '
    + 'Ticket code: `oneshot/ticket-12-leave` @ `abcdef1`. Automation repo: `origin/master` @ `1234567`. '
    + 'Database: fresh copy of the automation baseline. Results will be posted here.'
    + '\n\n<!-- oneshot:local-tests-start -->');
  assert.ok(isMachineNote(body), 'a gate never reads it as a reviewer speaking');
});

test('a patch uploads as a diff', () => {
  assert.equal(mimeFor('temporary-changes.patch'), 'text/x-diff');
});

test('failing on dev reads the same three ways in the report and the gate', () => {
  assert.equal(failingOnDevText(true), 'yes — not caused by this ticket');
  assert.equal(failingOnDevText(false), 'no — likely caused by this ticket');
  assert.equal(failingOnDevText(null), 'unknown');
  assert.equal(failingOnDevText(undefined), 'unknown');
});

/**
 * The local automation tests mode's ticket notes, pinned as the strings QA
 * read.
 *
 * Each note is read by someone who has not seen the pipeline: a QA deciding
 * whether a list may run, and a developer reading results. These pin the
 * wording they act on — the headline first naming the impacted modules, the
 * table by module, the counts, the three reply options — and the properties
 * that keep a note honest: real mentions, a patch attached when there is one,
 * a flagged temporary change shown before the ask, model text that cannot
 * break a table or forge a marker, no suggested test ever, no "marked done"
 * over a run that never happened, and no "label changed" when none was.
 */
import '../lib/test-project-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  localTestsApprovedWithoutTestsNote, localTestsFoundNote, localTestsMarker, localTestsNotFoundNote,
  localTestsResultsNote, localTestsSetupErrorNote, localTestsStuckNote, moduleName, type LocalTestsNoteInfo,
} from './messages.js';
import { artifactDir, localTestsConfig } from '../lib/config.js';
import { isMachineNote } from '../lib/claims.js';
import type { RunJournal } from '../lib/artifacts.js';

const QA = ['anosha.saeed', 'arsal.tariq'];
const MERGE = 'abcdef1234567890abcdef1234567890abcdef12';
const WSA_SHA = 'c0ffee1234567890c0ffee1234567890c0ffee12';
const REF = localTestsConfig().automationRef.replace(/^origin\//, '');

const info = (over: Partial<LocalTestsNoteInfo> = {}): LocalTestsNoteInfo => ({
  automationSha: WSA_SHA, mergeSha: MERGE, mrIid: 11042, qa: QA, mrTitle: 'Leave form: rename the submit button', ...over,
});

const scope = (over: Record<string, unknown> = {}) => ({
  applicable: true,
  reason: 'The diff renames the leave form submit testid',
  modules: ['leaves', 'payroll'],
  specs: [
    { file: 'cypress/e2e/leaves/LV_13_submit.ts', module: 'leaves', cases: 3, why: 'Main functionality: submits a leave request' },
    { file: 'cypress/e2e/leaves/LV_21_apply.ts', module: 'leaves', cases: 5, why: 'Submits a leave through the renamed button' },
    { file: 'cypress/e2e/payroll/PRL_01_nav.ts', module: 'payroll', cases: 2,
      why: 'Main functionality: one of the first tests of payroll, which tags none as smoke' },
  ],
  edits: [
    { file: 'cypress/Pages/LeavePage.ts', kind: 'update', why: 'Follows the renamed testid', erpEvidence: 'a.js:3' },
  ],
  proposals: [],
  notRunnable: [],
  estimatedMinutes: 11.6,
  summary: 'Runs the spec that reaches the submit button and the main tests of leaves and payroll.',
  ...over,
});

// A throwaway iid no real run will ever claim, and no other test file uses:
// test files run in parallel, and publish.test.ts and designgate.test.ts
// remove their own run dirs wholesale.
const LT_IID = 999993;
const ctx = {
  iid: LT_IID,
  runId: 'r-lt-mode',
  journal: { runId: 'r-lt-mode', iid: LT_IID, title: 't', url: '', createdAt: 0, status: 'running', phases: [] } as RunJournal,
};
const clearRun = (): void => rmSync(dirname(artifactDir(LT_IID)), { recursive: true, force: true });

// ------------------------------------------------------- the impacted-module report

test('the report opens with the impacted modules and what will run, then what changed', () => {
  const { body } = localTestsFoundNote(scope(), info());
  const parts = body.split('\n\n');
  assert.equal(parts[0], '**Impacted modules: Leaves, Payroll — Oneshot will run 3 automation tests (10 test cases) locally once QA approves.**');
  assert.equal(parts[1], '**What changed:** Leave form: rename the submit button (MR !11042, merged as `abcdef1`).');
  const one = localTestsFoundNote(scope({ specs: scope().specs.slice(0, 1) }), info()).body.split('\n\n')[0];
  assert.equal(one, '**Impacted module: Leaves — Oneshot will run 1 automation test (3 test cases) locally once QA approves.**');
});

test('what changed names the branch the MR went into: dev, or stage for a fix merged there', () => {
  const stage = localTestsFoundNote(scope(), info({ targetBranch: 'stage' })).body.split('\n\n')[1];
  assert.equal(stage, '**What changed:** Leave form: rename the submit button (MR !11042, merged into `stage` as `abcdef1`).');
  const none = localTestsNotFoundNote(scope({ specs: [] }), info({ targetBranch: 'dev' })).body;
  assert.ok(none.includes('(MR !11042, merged into `dev` as `abcdef1`).'), none);
});

test('the table is by module: the tests that check the change first, then each module\'s main functionality', () => {
  const { body } = localTestsFoundNote(scope(), info());
  assert.ok(body.includes('| Module | | Test | Why it runs |\n|---|---|---|---|'));
  const rows = body.split('\n').filter((l) => l.startsWith('| ') && l.includes('cypress/'));
  assert.deepEqual(rows, [
    '| Leaves | ✔️ | `cypress/e2e/leaves/LV_21_apply.ts` | Submits a leave through the renamed button |',
    '| Leaves | ⭐ | `cypress/e2e/leaves/LV_13_submit.ts` | Submits a leave request |',
    '| Payroll | ⭐ | `cypress/e2e/payroll/PRL_01_nav.ts` | One of the first tests of payroll, which tags none as smoke |',
  ]);
  assert.ok(body.includes('_✔️ checks the change · ⭐ main functionality of the module_'));
  assert.doesNotMatch(body, /🆕|🩺|temporary test, for this run only|health check/i, 'no new test, no health checks');
});

test('a main-functionality test is recognised by its prefix, the older health-check words included, and only by it', () => {
  const mark = (why: string): string => localTestsFoundNote(scope({
    specs: [{ file: 'cypress/e2e/leaves/a.ts', module: 'leaves', cases: 1, why }], edits: [],
  }), info()).body.split('\n').find((l) => l.includes('cypress/e2e/leaves/a.ts'))!.split(' | ')[1]!;
  assert.equal(mark('Main functionality: opens the dashboard'), '⭐');
  assert.equal(mark('main-functionality — opens the dashboard'), '⭐');
  assert.equal(mark('Health check: opens the dashboard'), '⭐', 'a list from before the main-functionality picks');
  assert.equal(mark('Smoke: opens the dashboard'), '⭐');
  assert.equal(mark('smoke-tagged spec that submits the renamed button'), '✔️');
  assert.equal(mark('Checks the main functionality banner'), '✔️');
  assert.equal(mark('Opens the changed screen: asserts the Current Team(s) cards'), '✔️', 'a changed-screen pick checks the change');
});

test('a file QA added is its own row, after the tests that check the change, and counted', () => {
  const { body } = localTestsFoundNote(scope({
    specs: [...scope().specs, { file: 'cypress/e2e/leaves/LV_99_new.ts', module: 'leaves', cases: 0,
      why: 'Added to workstream-automation by @arsal.tariq', addedBy: 'arsal.tariq' }],
  }), info());
  const rows = body.split('\n').filter((l) => l.startsWith('| ') && l.includes('cypress/'));
  assert.equal(rows[1], '| Leaves | ➕ | `cypress/e2e/leaves/LV_99_new.ts` | Added to workstream-automation by @arsal.tariq |');
  assert.ok(body.includes('_✔️ checks the change · ➕ added by QA · ⭐ main functionality of the module_'));
  assert.ok(body.includes('**Counts:** 1 test that checks the change · 2 main-functionality tests · 1 added by QA · '
    + 'about 12 min (10 test cases)'));
});

test('module folders read as people say them, and a spec without a module takes its folder', () => {
  assert.equal(moduleName('finalSettlement'), 'Final Settlement');
  assert.equal(moduleName('podA'), 'Pod A');
  assert.equal(moduleName('teamReviewB'), 'Team Review B');
  assert.equal(moduleName('leaves'), 'Leaves');
  assert.equal(moduleName(''), 'Other');
  const { body } = localTestsFoundNote(scope({
    specs: [{ file: 'cypress/e2e/jobRequisition/JR_01.ts', cases: 1, why: 'Main functionality: opens requisitions' }],
  }), info());
  assert.ok(body.startsWith('**Impacted module: Job Requisition — '));
  assert.ok(body.includes('| Job Requisition | ⭐ | `cypress/e2e/jobRequisition/JR_01.ts` |'));
});

test('the counts line says what checks the change, the main-functionality tests and the minutes', () => {
  const { body } = localTestsFoundNote(scope(), info());
  assert.ok(body.includes('**Counts:** 1 test that checks the change · 2 main-functionality tests · about 12 min '
    + '(10 test cases)'));
  const none = localTestsFoundNote(scope({ specs: scope().specs.filter((x) => x.why.startsWith('Main')), estimatedMinutes: 0 }), info()).body;
  assert.ok(none.includes('**Counts:** 0 tests that check the change · 2 main-functionality tests · time not estimated (5 test cases)'));
});

test('approval is always asked, and the reason is always the same', () => {
  const { body } = localTestsFoundNote(scope({ edits: [], specs: scope().specs.slice(1, 2) }), info());
  assert.ok(body.includes('**Why approval:** QA approves every local run.'));
  assert.ok(body.includes('**Temporary changes:** none.'));
});

test('QA are mentioned for real, never in a code span, with the three answers', () => {
  const { body } = localTestsFoundNote(scope(), info());
  assert.ok(body.includes('@anosha.saeed @arsal.tariq — reply with one of:\n'
    + '- `approved` — run exactly these tests.\n'
    + '- `disapproved:` with what to change, for example:\n\n'
    + '  ```\n  disapproved:\n  - also run LV_23\n  - remove LV_21\n  ```\n'
    + `- \`added <test file>\` — a test file on workstream-automation ${REF} to run as well, for example `
    + '`added cypress/e2e/leaves/LV_99_my_case.ts` (a file name with a space goes in backticks).'));
  assert.doesNotMatch(body, /`@/, 'a mention in a code span notifies nobody');
  assert.doesNotMatch(body, /check again|temporary test/, 'the retired answers are not offered');
});

test('with nobody configured the note says so instead of mentioning nobody', () => {
  const { body } = localTestsFoundNote(scope(), info({ qa: [] }));
  assert.match(body, /_No QA reviewer is configured \(config\/reviewers\.json `qa`\)\._ A QA reviewer can reply with one of/);
});

test('the temporary changes are counted and the patch is attached', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lt-msg-'));
  try {
    const patch = join(dir, 'temporary-changes.patch');
    writeFileSync(patch, 'diff --git a/x b/x\n');
    const { body, attachments } = localTestsFoundNote(scope(), info({ patchFile: patch }));
    assert.ok(body.includes('**Temporary changes:** 1 file updated, never committed — the patch is attached.'));
    assert.deepEqual(attachments.map((a) => [a.name, a.mime]), [['temporary-changes.patch', 'text/x-diff']]);
    const moved = localTestsFoundNote(scope(), info({ patchFile: patch, patchNote: 'kept from round 1, applied on a newer commit' })).body;
    assert.ok(moved.includes('**Temporary changes:** 1 file updated, never committed (kept from round 1, applied on a newer '
      + 'commit) — the patch is attached.'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('edits with no saved patch say so rather than promising an attachment', () => {
  const { body, attachments } = localTestsFoundNote(scope(), info({ patchFile: '/nonexistent/temporary-changes.patch' }));
  assert.ok(body.includes('**Temporary changes:** 1 file updated, never committed. '
    + 'The patch was not saved, so it is not attached.'));
  assert.deepEqual(attachments, []);
});

test('a long why is clipped to one short line, and a pipe or newline cannot break the row', () => {
  const long = `${'checks the leave form submit button '.repeat(8)}end`;
  const { body } = localTestsFoundNote(scope({
    specs: [
      { file: 'cypress/e2e/a.ts', module: 'leaves', cases: 1, why: long },
      { file: 'cypress/e2e/b.ts', module: 'leaves', cases: 1, why: 'Save | Cancel\nboth' },
    ],
    edits: [],
  }), info());
  const a = body.split('\n').find((l) => l.includes('cypress/e2e/a.ts'))!;
  const cell = a.split(' | ')[3]!.replace(/ \|$/, '');
  assert.ok(cell.length <= 120 && cell.endsWith('…'), `clipped: ${cell.length}`);
  const b = body.split('\n').find((l) => l.includes('cypress/e2e/b.ts'))!;
  assert.equal(b.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).length, 4);
  assert.ok(b.includes('Save \\| Cancel both'));
});

test('model text cannot forge a marker or open an HTML block', () => {
  const { body } = localTestsFoundNote(scope({
    specs: [{ file: 'cypress/e2e/a.ts', module: '<!-- oneshot:x -->', cases: 1, why: '<!-- oneshot:local-tests:results --> <title>' }],
    edits: [], summary: '<!-- oneshot:local-tests:results -->',
  }), info());
  assert.equal(body.match(/<!-- oneshot:/g)?.length, 1, 'only the note\'s own marker');
  assert.ok(body.endsWith(localTestsMarker('found')));
});

test('a long list shows ten rows and folds the rest, never dropping one', () => {
  const specs = Array.from({ length: 13 }, (_, i) => (
    { file: `cypress/e2e/leaves/LV_${String(i).padStart(2, '0')}.ts`, module: 'leaves', cases: 1, why: `reason ${i}` }));
  const { body } = localTestsFoundNote(scope({ specs, edits: [] }), info());
  const [shown = '', folded = ''] = body.split('<details><summary>…and 3 more tests</summary>');
  assert.equal((shown.match(/^\| Leaves \| ✔️ \| `cypress\/e2e\/leaves\/LV_/gm) ?? []).length, 10);
  assert.equal((folded.match(/^\| Leaves \| ✔️ \| `cypress\/e2e\/leaves\/LV_/gm) ?? []).length, 3);
});

test('proposed removals, specs that cannot run locally and the session\'s summary are shown; an add is never shown', () => {
  const { body } = localTestsFoundNote(scope({
    proposals: [
      { action: 'add', title: 'Verify that the submit button reads Apply', file: 'cypress/e2e/leaves/LV_50.ts', why: 'No suite test checks the label' },
      { action: 'remove', title: 'Trim to fit the limits: LV_30', why: 'Over maxSpecs' },
    ],
    notRunnable: [{ spec: 'cypress/e2e/leaves/LV_09_mail.ts', why: 'Reads a real mailbox' }],
  }), info());
  assert.ok(body.includes('**Proposed removals:**\n- REMOVE: Trim to fit the limits: LV_30. *Why: Over maxSpecs*'));
  assert.doesNotMatch(body, /ADD to the suite|Verify that the submit button reads Apply|Suggest/);
  assert.ok(body.includes('**Can\'t run on a local machine (not run):** `cypress/e2e/leaves/LV_09_mail.ts` (Reads a real mailbox).'));
  assert.ok(body.includes('<details><summary>How Oneshot chose these</summary>\n\nRuns the spec that reaches the '
    + 'submit button and the main tests of leaves and payroll.\n\n</details>'));
});

test('without an MR title the scope\'s reason says what changed', () => {
  const { body } = localTestsFoundNote(scope(), info({ mrTitle: undefined }));
  assert.ok(body.includes('**What changed:** The diff renames the leave form submit testid (MR !11042, merged as `abcdef1`).'));
});

test('temporary changes capture flagged are named with why, in a bold line just before the ask', () => {
  const { body } = localTestsFoundNote(scope({
    capture: {
      patchFile: '/p', patchSha: 'd'.repeat(40), automationSha: WSA_SHA,
      changedFiles: ['cypress/e2e/leaves/LV_21_apply.ts', 'cypress.config.ts', 'cypress/Pages/LeavePage.ts'],
      weakened: ['cypress/e2e/leaves/LV_21_apply.ts', 'cypress/Pages/LeavePage.ts'],
      weakenedDetail: [
        { file: 'cypress/e2e/leaves/LV_21_apply.ts', why: 'adds cy.exec(' },
        { file: 'cypress/e2e/leaves/LV_21_apply.ts', why: 'removes an expect( assertion' },
      ],
      outsideAllowed: ['cypress.config.ts'],
    },
  }), info());
  const parts = body.split('\n\n');
  const ask = parts.findIndex((p) => p.startsWith('@anosha.saeed @arsal.tariq — reply with one of'));
  assert.equal(parts[ask - 1],
    '**Temporary changes that weaken a test, reach outside the browser, or touch files outside '
    + '`localTests.allowedPaths` — read the patch before approving:**\n'
    + '- `cypress/e2e/leaves/LV_21_apply.ts`: adds cy.exec(; removes an expect( assertion\n'
    + '- `cypress/Pages/LeavePage.ts`: weakens a test\n'
    + '- `cypress.config.ts`: outside `localTests.allowedPaths`');
  assert.equal(body.match(/read the patch before approving/g)?.length, 1);
});

test('a capture that flagged nothing adds no warning, and a file name cannot forge a marker', () => {
  const clean = localTestsFoundNote(scope({
    capture: { patchFile: '/p', patchSha: null, automationSha: WSA_SHA, weakened: [], weakenedDetail: [], outsideAllowed: [] },
  }), info()).body;
  assert.doesNotMatch(clean, /read the patch before approving/);
  assert.doesNotMatch(localTestsFoundNote(scope(), info()).body, /read the patch before approving/, 'no capture at all');

  const forged = localTestsFoundNote(scope({
    capture: { automationSha: WSA_SHA, outsideAllowed: ['x <!-- oneshot:local-tests:results -->\n- y'], weakened: [] },
  }), info()).body;
  assert.equal(forged.match(/<!-- oneshot:/g)?.length, 1, 'only the note\'s own marker');
  assert.ok(forged.includes('- x &lt;!-- oneshot:local-tests:results --&gt; - y: outside'), 'folded onto one line, escaped');
  assert.ok(forged.endsWith(localTestsMarker('found')));
});

test('several of the ticket\'s merged MRs are all named; the tested one alone reads as before', () => {
  const mrs = [{ iid: 11001, sha: '1234567aaaa' }, { iid: 11010, sha: '89abcdebbbb' }, { iid: 11042, sha: MERGE }];
  const found = localTestsFoundNote(scope(), info({ mrs })).body.split('\n\n')[1];
  assert.equal(found, '**What changed:** Leave form: rename the submit button (MR !11042, merged as `abcdef1`). '
    + 'Also checked: this ticket\'s earlier merged MRs !11001 (merged as `1234567`), !11010 (merged as `89abcde`).');
  const none = localTestsNotFoundNote(scope({ specs: [] }), info({ mrs: mrs.slice(1) })).body.split('\n\n')[1];
  assert.equal(none, '**What changed:** Leave form: rename the submit button (MR !11042, merged as `abcdef1`). '
    + 'Also checked: this ticket\'s earlier merged MR !11010 (merged as `89abcde`).');
  const one = '**What changed:** Leave form: rename the submit button (MR !11042, merged as `abcdef1`).';
  assert.equal(localTestsFoundNote(scope(), info({ mrs: [{ iid: 11042, sha: MERGE }] })).body.split('\n\n')[1], one);
  assert.equal(localTestsFoundNote(scope(), info({ mrs: [] })).body.split('\n\n')[1], one);
});

test('paths QA named that are not on the automation ref are named back', () => {
  const found = localTestsFoundNote(scope(), info({ unknown: ['cypress/e2e/reports/typo.ts', 'cypress/e2e/reports/typo.ts'] })).body;
  assert.ok(found.includes(`**Not on ${REF}:** \`cypress/e2e/reports/typo.ts\` — check the path and reply again.`));
  const none = localTestsNotFoundNote(scope({ specs: [] }), info({ unknown: ['cypress/e2e/a.ts', 'cypress/e2e/b.ts'] })).body;
  assert.ok(none.includes(`**Not on ${REF}:** \`cypress/e2e/a.ts\`, \`cypress/e2e/b.ts\` — check the paths and reply again.`));
});

test('a found note with nothing to run is the not-found note instead', () => {
  const { body } = localTestsFoundNote(scope({ specs: [], edits: [] }), info());
  assert.ok(body.startsWith('**Oneshot found no automation test to run locally for this ticket.**'));
});

// ------------------------------------------------------------- nothing to run

test('the nothing-to-run note says why, names the commit it checked and the three answers, and suggests no test', () => {
  const { body, attachments } = localTestsNotFoundNote(scope({
    applicable: false, reason: 'Only apps/core changed, which no screen with an automation module reaches.',
    specs: [], edits: [],
    // An older scope's suggestion is never shown.
    proposals: [{ action: 'add', title: 'Verify that the evidence banner can be dismissed for a week', why: 'No page object selects it' }],
  }), info());
  const parts = body.split('\n\n');
  assert.equal(parts[0], '**Oneshot found no automation test to run locally for this ticket.**');
  assert.equal(parts[1], '**What changed:** Leave form: rename the submit button (MR !11042, merged as `abcdef1`).');
  assert.equal(parts[2], '**Why:** Only apps/core changed, which no screen with an automation module reaches.');
  assert.equal(parts[3], `Checked: workstream-automation ${REF} (commit \`c0ffee1\`)`);
  assert.ok(body.includes('@anosha.saeed @arsal.tariq — reply with one of:\n'
    + '- `approved` — go on without local tests; the ticket is marked **Automation Testing Done**.\n'
    + `- \`added <test file>\` — Oneshot runs that exact file from workstream-automation ${REF}, for example `
    + '`added cypress/e2e/reports/reports_25_x.ts` (a file name with a space goes in backticks).\n'
    + '- `disapproved:` with what to change — for example a module whose main-functionality tests should run.'));
  assert.doesNotMatch(body, /Suggested|evidence banner|temporary test|check again/);
  assert.ok(body.endsWith(localTestsMarker('not-found')));
  assert.deepEqual(attachments, []);
});

test('an emptied list names what the scope left out, so approving it is never a silent trim', () => {
  const { body } = localTestsNotFoundNote(scope({
    specs: [],
    proposals: [
      { action: 'remove', title: 'The leave smoke test cannot see this change', file: 'cypress/e2e/leaves/LV_13_submit.ts', why: 'it never opens the drawer' },
      { action: 'add', title: 'Verify that', why: 'an older scope' },
    ],
  }), info());
  assert.ok(body.includes('**Left out on purpose — reply `disapproved:` to keep any of them:**\n'
    + '- REMOVE: `cypress/e2e/leaves/LV_13_submit.ts` — The leave smoke test cannot see this change. *Why: it never opens the drawer*'));
  assert.doesNotMatch(body, /Verify that/, 'an add is never shown');
  assert.doesNotMatch(localTestsNotFoundNote(scope({ specs: [] }), info()).body, /Left out on purpose/);
});

test('specs that reach the change but cannot run locally are named, so nothing-to-run is not read as uncovered', () => {
  const { body } = localTestsNotFoundNote(scope({
    specs: [], notRunnable: [{ spec: 'cypress/e2e/payroll/PR_01.ts', why: 'Needs Odoo' }],
  }), info());
  assert.ok(body.includes('**Tests that reach it but can\'t run on a local machine (not run):** `cypress/e2e/payroll/PR_01.ts` (Needs Odoo).'));
});

// ------------------------------------------------------------- the records

test('going on without tests is recorded with who approved it, and the label it closed with', () => {
  assert.equal(localTestsApprovedWithoutTestsNote('anosha.saeed').body,
    '**No local automation run for this ticket:** no automation test exists for this change; approved by '
    + '@anosha.saeed without local tests.\n\nMarked **Automation Testing Done**.\n\n'
    + localTestsMarker('approved-without-tests'));
  assert.match(localTestsApprovedWithoutTestsNote('dry-run').body, /approved automatically \(dry run\) without local tests/);
});

test('a setup error is not marked done and says the trigger label is back', () => {
  const { body } = localTestsSetupErrorNote('the baseline database has open sessions.');
  assert.equal(body, '**Oneshot could not run the local automation tests:** the baseline database has open sessions.\n\n'
    + 'Not marked done: **Running TestCases Locally** is removed and **Ready for Automation Testing** is back on the '
    + `ticket, so Oneshot picks it up again.\n\n${localTestsMarker('setup-error')}`);
  assert.doesNotMatch(body, /Marked \*\*/);
});

test('tests that could not be chosen: no label changed, QA mentioned, any QA comment tries again', () => {
  const { body, attachments } = localTestsStuckNote('the scope session failed 3 times: E_NO_MAP.', QA);
  const parts = body.split('\n\n');
  assert.equal(parts[0], '**Oneshot could not choose the local automation tests for this ticket:** the scope session '
    + 'failed 3 times: E_NO_MAP.');
  assert.equal(parts[1], 'No label was changed and nothing ran: **Ready for Automation Testing** stays on the ticket, '
    + 'and it is not marked **Automation Testing Done**.');
  assert.equal(parts[2], '@anosha.saeed @arsal.tariq — any comment from you on this ticket makes Oneshot try again '
    + '(for example what to look at, or just `please try again`). Until one of you comments, Oneshot waits and posts '
    + 'nothing more.');
  assert.doesNotMatch(body, /`@/, 'a mention in a code span notifies nobody');
  assert.doesNotMatch(body, /is back on the ticket|is removed|Marked \*\*/, 'no label moved, so none is claimed');
  assert.ok(body.endsWith(`\n\n${localTestsMarker('stuck')}`));
  assert.ok(isMachineNote(body));
  assert.deepEqual(attachments, []);
});

test('a stuck note with nobody to mention says how to release it, and a long reason is clipped', () => {
  const { body } = localTestsStuckNote(`${'stack frame '.repeat(200)}end`, []);
  assert.match(body, /_No QA reviewer is configured \(config\/reviewers\.json `qa`\)_, and only a QA reviewer's comment/);
  const head = body.split('\n\n')[0]!;
  assert.ok(head.length < 700 && head.endsWith('….'), `clipped: ${head.length}`);
  assert.equal(localTestsStuckNote('', QA).body.split('\n\n')[0],
    '**Oneshot could not choose the local automation tests for this ticket:** no reason was recorded.');
});

// ------------------------------------------------------------- results

const res = (spec: string, title: string, state: string, over: Record<string, unknown> = {}) =>
  ({ spec, title, state, durationMs: 1000, ...over });

const run = (over: Record<string, unknown> = {}) => ({
  status: 'passed',
  cacheKey: 'k', ticketSha: MERGE, automationSha: WSA_SHA, patchSha: null, db: 'oneshot_lt_1_1',
  totals: { specs: 1, tests: 2, passed: 2, failed: 0, skipped: 0 },
  results: [res('cypress/e2e/a.ts', 'one', 'passed'), res('cypress/e2e/a.ts', 'two', 'passed')],
  notRunnable: [], newTests: [], notes: [],
  startedAt: '2026-10-09T10:00:00Z', endedAt: '2026-10-09T10:04:00Z',
  ...over,
});

test('passed results are the report, closed with the label the ticket is marked', () => {
  const { body } = localTestsResultsNote(run(), ctx);
  assert.ok(body.startsWith('**Local automation results** — 2 passed, 0 failed (2 tests, 4 min)'));
  assert.ok(body.endsWith(`\n\nMarked **Automation Testing Done**.\n\n${localTestsMarker('results')}`));
  assert.doesNotMatch(body, /FYI/);
});

test('failed results are marked done too, and a failure dev does not share mentions the MR author', () => {
  const failed = run({
    status: 'failed',
    totals: { specs: 2, tests: 3, passed: 1, failed: 2, skipped: 0 },
    results: [
      res('cypress/e2e/a.ts', 'one', 'passed'),
      res('cypress/e2e/b.ts', 'two', 'failed', { error: 'expected Apply', failingOnDev: false }),
      res('cypress/e2e/c.ts', 'three', 'failed', { error: 'boom', failingOnDev: true }),
    ],
  });
  const { body } = localTestsResultsNote(failed, ctx, { mrAuthor: 'usman.nasir' });
  assert.ok(body.includes('FYI @usman.nasir: 1 failed test does not fail on dev, so this change likely caused it.'
    + `\n\nMarked **Automation Testing Done**.\n\n${localTestsMarker('results')}`));
  assert.doesNotMatch(localTestsResultsNote(failed, ctx).body, /FYI/, 'no author, nobody to mention');
  const devToo = run({ status: 'failed', results: [res('cypress/e2e/c.ts', 'three', 'failed', { failingOnDev: true })] });
  assert.doesNotMatch(localTestsResultsNote(devToo, ctx, { mrAuthor: 'usman.nasir' }).body, /FYI/,
    'a failure dev shares is not the author\'s');
});

test('a stage merge\'s results ask whether each failure fails on stage too, and tell the author so', () => {
  const failed = run({
    status: 'failed',
    totals: { specs: 1, tests: 1, passed: 0, failed: 1, skipped: 0 },
    results: [res('cypress/e2e/b.ts', 'two', 'failed', { error: 'expected Apply', failingOnDev: false })],
  });
  const { body } = localTestsResultsNote(failed, ctx, { mrAuthor: 'usman.nasir', branch: 'stage' });
  assert.ok(body.includes('| Spec | Result | Failing on stage too? | Reason |'), body);
  assert.ok(body.includes('FYI @usman.nasir: 1 failed test does not fail on stage, so this change likely caused it.'));
  const plain = localTestsResultsNote(failed, ctx, { mrAuthor: 'usman.nasir' }).body;
  assert.ok(plain.includes('Failing on dev too?') && plain.includes('does not fail on dev'), 'no branch named: the base branch');
});

test('the videos stay last, beside their uploads, after the closing line', () => {
  try {
    const dir = artifactDir(LT_IID);
    mkdirSync(join(dir, 'local-tests', 'videos'), { recursive: true });
    writeFileSync(join(dir, 'local-tests/videos/b.ts.mp4'), 'x');
    const { body, attachments } = localTestsResultsNote(run({
      status: 'failed',
      results: [res('cypress/e2e/b.ts', 'two', 'failed', { failingOnDev: null, video: 'local-tests/videos/b.ts.mp4' })],
    }), ctx);
    assert.ok(body.endsWith('Marked **Automation Testing Done**.\n\n**Videos of the failed specs:**\n\n'
      + localTestsMarker('results')));
    assert.deepEqual(attachments.map((a) => [a.name, a.mime]), [['b.ts.mp4', 'video/mp4']]);
  } finally {
    clearRun();
  }
});

test('a dry run that started no Cypress is reported as skipped, with the closing line', () => {
  const { body } = localTestsResultsNote(run({ status: 'skipped', reason: 'a dry run starts no Cypress' }), ctx);
  assert.ok(body.startsWith('**Local automation tests:** skipped — a dry run starts no Cypress.'));
  assert.ok(body.includes('Marked **Automation Testing Done**.'));
});

test('a run that errored is a setup error, never marked done', () => {
  const { body } = localTestsResultsNote(run({ status: 'error', reason: 'the app did not build' }), ctx);
  assert.ok(body.startsWith('**Oneshot could not run the local automation tests:** the app did not build.'));
  assert.doesNotMatch(body, /Marked \*\*/);
  assert.ok(body.endsWith(localTestsMarker('setup-error')));
});

// ------------------------------------------------------------- markers

test('every note ends with its own marker, and every marker is a machine note', () => {
  const bodies: Array<[string, string]> = [
    ['found', localTestsFoundNote(scope(), info()).body],
    ['not-found', localTestsNotFoundNote(scope({ specs: [] }), info()).body],
    ['approved-without-tests', localTestsApprovedWithoutTestsNote('anosha.saeed').body],
    ['results', localTestsResultsNote(run(), ctx).body],
    ['setup-error', localTestsSetupErrorNote('x').body],
    ['stuck', localTestsStuckNote('x', QA).body],
  ];
  const markers = new Set<string>();
  for (const [kind, body] of bodies) {
    const m = localTestsMarker(kind as Parameters<typeof localTestsMarker>[0]);
    assert.ok(body.endsWith(`\n\n${m}`), `${kind} ends with ${m}`);
    assert.ok(isMachineNote(body), `${kind} is a machine note`);
    markers.add(m);
  }
  assert.equal(markers.size, bodies.length, 'no two notes share a marker');
  assert.notEqual(localTestsMarker('found'), '<!-- oneshot:local-tests-start -->');
});

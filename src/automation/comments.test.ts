import '../lib/test-project-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMachineNote } from '../lib/claims.js';
import type { IssueNote } from '../lib/gitlab.js';
import type { MrRef, Readiness } from './readiness.js';
import {
  MAX_CASES, NOTE_BODY_LIMIT, casesBody, casesHash, diffCases, doneBody, findMarker, isEmptyDiff,
  marker, noChangeBody, notReadyBody, renderCasesCsv, sanitizeArtifact, sheetFailedBody, stuckBody,
  validateArtifact, validateCases, type MarkerKind, type VersionView,
} from './comments.js';
import type { AutomationArtifact, AutomationCase } from './types.js';

/*
 * Invented numbers throughout: ticket 101, fix MR !501, abandoned MR !400. They
 * mirror the live shapes this mode was built against without naming them.
 */

const APPROVERS = ['anosha.saeed', 'arsal.tariq'];

const kase = (id: string, over: Partial<AutomationCase> = {}): AutomationCase => ({
  id,
  scenario: `Verify that case ${id} behaves`,
  precondition: 'Logged in as an employee; on Profile > Documents',
  steps: ['Click **Upload document**', 'Click **Save**'],
  expected: 'The document is listed',
  automatable: 'yes',
  reason: 'Form and table are in the page',
  ...over,
});

const mr = (over: Partial<MrRef> = {}): MrRef => ({
  iid: 501, title: 'Fix profile documents', source: 'fix/profile-docs', target: 'dev',
  state: 'merged', mergedAt: '2026-09-08T10:00:00Z', url: 'https://gitlab.example.com/acme/erp/-/merge_requests/501',
  ...over,
});

const V1 = [
  kase('TC-01'),
  kase('TC-02', { automatable: 'partly', reason: 'The export is checkable; the PDF figures need a person' }),
  kase('TC-03', { automatable: 'no', reason: 'The email wording is in an inbox Cypress cannot open' }),
];

function view(over: Partial<VersionView> = {}): VersionView {
  const cases = over.cases ?? V1;
  return {
    iid: 101, v: 1, module: 'Profile', moduleTab: 'TestCases_Profile', moduleTabIsNew: true,
    cases, merged: [mr()], open: [], approvers: APPROVERS,
    csvMarkdown: '[automation-testcases-101-v1.csv](/uploads/abc/automation-testcases-101-v1.csv)',
    hash: casesHash(cases),
    ...over,
  };
}

const lastLine = (s: string): string => s.trimEnd().split('\n').pop() ?? '';

/** Pipes that end a table cell, i.e. not written as `\|`. */
const cellPipes = (row: string): number => (row.match(/(?<!\\)\|/g) ?? []).length;

// ---------------------------------------------------------------- not ready

test('the not-ready note lists each reason with its fix and ends with the fingerprint marker', () => {
  const r: Readiness = {
    v: 1, verdict: 'not-ready', iid: 101, checkedAt: '2026-09-28T12:00:00Z', issueUpdatedAt: null,
    state: 'opened', triggerAddedAt: '2026-09-28T11:00:00Z',
    reasons: [
      {
        code: 'rfd-order', detail: 'after',
        text: '`Ready For Deployment` was added after `Ready For Automation`.',
        fix: 'Add `Ready For Deployment` once the change is deployed, then add `Ready For Automation` again.',
      },
      {
        code: 'mr-not-merged', detail: '!400:opened',
        text: 'No merged merge request: !400 is still open.',
        fix: 'Merge the fix, or link the MR that shipped it.',
      },
    ],
    warnings: ['!400 is still open — it is not what shipped, and is ignored'],
    merged: [], open: [mr({ iid: 400, state: 'opened', mergedAt: null })], fingerprint: 'abc123def456',
  };
  const body = notReadyBody(r, { recheckMinutes: 30, trigger: 'Ready For Automation', deployed: 'Ready For Deployment' });
  assert.match(body, /^\*\*Automation test cases: not started yet\*\*/);
  assert.match(body, /This ticket carries `Ready For Automation`, but oneshot cannot write its automation test cases yet:/);
  assert.match(body, /- ❌ \*\*`Ready For Deployment` was added after `Ready For Automation`\*\*\\\n {2}Fix: Add `Ready For Deployment` once/);
  assert.match(body, /- ❌ \*\*No merged merge request: !400 is still open\*\*\\\n {2}Fix: Merge the fix/);
  assert.ok(body.indexOf('was added after') < body.indexOf('No merged'), 'the reasons keep their order, rule A first');
  assert.match(body, /⚠️ !400 is still open — it is not what shipped, and is ignored/);
  assert.match(body, /at least every 30 minutes\. It never posts the same message twice\./);
  assert.equal(lastLine(body), '<!-- oneshot:automation:not-ready:abc123def456 -->');
});

// ---------------------------------------------------------------- versions

test('the cases note shares only the cases: a title line, the seven-column table, the CSV and one line for the approvers', () => {
  const body = casesBody(view());
  assert.match(body, /^\*\*Automation test cases v1\*\* · #101 · Profile · 3 cases\n/);
  assert.ok(body.includes('| ID | Scenario | Pre-condition | Steps | Expected | Automatable | Reason |'));
  const rows = body.split('\n').filter((l) => l.startsWith('| **TC-'));
  assert.equal(rows.length, 3);
  for (const row of rows) assert.equal(cellPipes(row), 8, 'seven cells');
  assert.match(rows[0]!, /\| 1\. Click \*\*Upload document\*\*<br>2\. Click \*\*Save\*\* \|/);
  assert.match(rows[0]!, /\| ✅ yes \|/);
  assert.match(rows[1]!, /\| 🟡 partly \|/);
  assert.match(rows[2]!, /\| ⛔ no \|/);
  assert.match(body, /📎 \[automation-testcases-101-v1\.csv\]\(\/uploads\/abc\/automation-testcases-101-v1\.csv\)/);
  // The @mentions are what notify the approvers that a version is up.
  assert.match(body, /^@anosha\.saeed @arsal\.tariq — reply `approved`, or reply with the changes you want\.$/m);
  assert.equal(lastLine(body), `<!-- oneshot:automation:cases:v1:${casesHash(V1)} -->`);
  // Nothing else around the table.
  for (const gone of [/Written from/, /Ignored/, /What changed/, /\*\*Approve:\*\*/, /Only comments from/, /^---$/m]) {
    assert.doesNotMatch(body, gone);
  }
  const noCsvOpenMr = casesBody(view({ moduleTabIsNew: false, csvMarkdown: null, open: [mr({ iid: 400, state: 'opened' })] }));
  assert.match(noCsvOpenMr, /📎 _The CSV could not be attached\._/);
  assert.doesNotMatch(noCsvOpenMr, /!400/, 'an ignored open MR is not reported in the comment');
});

test('a later version still shares only the cases: no change list, even with a diff and session notes', () => {
  const v2 = [
    V1[0]!,
    { ...V1[2]!, expected: 'A 403 page is shown' },
    kase('TC-04', { scenario: 'Verify that an expired session is sent to the login page' }),
  ];
  const body = casesBody(view({
    v: 2, cases: v2, hash: casesHash(v2), moduleTabIsNew: false,
    diff: diffCases(V1, v2), notes: ['Changed TC-03: expects a 403 now'], feedbackAuthors: ['anosha.saeed'],
  }));
  assert.match(body, /^\*\*Automation test cases v2\*\* · #101 · Profile · 3 cases\n/);
  assert.doesNotMatch(body, /What changed|Added \*\*TC-04\*\*|Removed \*\*TC-02\*\*|Note: /);
  assert.equal(body.split('\n').filter((l) => l.startsWith('| **TC-')).length, 3);
  assert.equal(lastLine(body), `<!-- oneshot:automation:cases:v2:${casesHash(v2)} -->`);
});

test('an approval ignored because of a change request is said so', () => {
  const body = casesBody(view({ v: 2, diff: { added: [], removed: [], changed: [{ id: 'TC-01', fields: ['steps'] }] }, ignoredApproval: true }));
  assert.match(body, /_An `approved` in the same round was not applied, because change requests came with it\. Approve this version when it looks right\._/);
  assert.doesNotMatch(casesBody(view({ v: 2, diff: { added: [], removed: [], changed: [] } })), /was not applied/);
});

test('the v2 note names comments and approvals that arrived while it was being written', () => {
  const body = casesBody(view({
    v: 2, diff: { added: [], removed: [], changed: [{ id: 'TC-01', fields: ['expected'] }] },
    during: { changeAuthors: ['anosha.saeed'], staleApprovers: ['arsal.tariq'] },
  }));
  assert.match(body, /_Comments from @anosha\.saeed posted while v2 was being written are not in this version\. They will be applied in v3\._/);
  assert.match(body, /_@arsal\.tariq's `approved` came in while v2 was being written, so it applied to v1\. Please approve v2 if it looks right\._/);
  assert.ok(body.indexOf('_Comments from') < body.indexOf('| ID |'), 'the round lines sit under the title, before the table');
});

// ------------------------------------------------------------------ the rest

test('the done note links the block and the tracker row and names the labels', () => {
  const body = doneBody({
    v: 2, count: 12, approvedBy: 'anosha.saeed',
    removed: ['Automation Test Case Review', 'Loop'], added: ['Automation Done'],
    sheet: {
      moduleTab: 'Team Reviews [Latest]', blockRange: 'A730:H743',
      blockLink: 'https://docs.google.com/spreadsheets/d/sheet-id/edit#gid=77&range=A730:H743',
      trackerTab: 'TestCases year 2026', trackerRow: 14,
      trackerLink: 'https://docs.google.com/spreadsheets/d/sheet-id/edit#gid=0&range=A14:E14',
      automationStatus: 'Not started',
    },
  });
  assert.match(body, /^\*\*Automation test cases: done\*\* ✅/);
  assert.match(body, /v2 \(12 cases\) was approved by @anosha\.saeed and written to the test-case sheet:/);
  assert.ok(body.includes('- Cases: [Team Reviews \\[Latest\\], A730:H743](https://docs.google.com/spreadsheets/d/sheet-id/edit#gid=77&range=A730:H743)'));
  assert.ok(body.includes('- Tracker: [TestCases year 2026, row 14](https://docs.google.com/spreadsheets/d/sheet-id/edit#gid=0&range=A14:E14).'));
  assert.match(body, /Test Case Status is \*\*Done\*\*, Automation Status is \*\*Not started\*\*\./);
  assert.match(body, /Labels: removed `Automation Test Case Review` and `Loop`, added `Automation Done`\./);
  assert.equal(lastLine(body), '<!-- oneshot:automation:done -->');
});

test('the sheet-failed note names the failure and what a person should do', () => {
  const body = sheetFailedBody({
    v: 1, kind: 'permission', reason: 'the service account cannot edit the spreadsheet (403).',
    action: 'Share the sheet as Editor with sa@example.iam.gserviceaccount.com.',
  });
  assert.match(body, /^\*\*Automation test cases: approved, but not written to the sheet yet\*\*/);
  assert.match(body, /v1 is approved, but writing it to the test-case sheet failed: the service account cannot edit the spreadsheet \(403\)\.\n/);
  assert.match(body, /Share the sheet as Editor with sa@example\.iam\.gserviceaccount\.com\./);
  assert.match(body, /Oneshot keeps retrying by itself; labels stay as they are until the write succeeds\./);
  assert.equal(lastLine(body), '<!-- oneshot:automation:sheet-failed:permission -->');
});

test('the no-change note for a near-approval explains the single-word rule', () => {
  const near = noChangeBody({ v: 2, authors: ['anosha.saeed'], notes: [], nearApproval: true, maxNoteId: 77 });
  assert.match(near, /^\*\*Automation test cases: no change made\*\* to v2 for @anosha\.saeed's comment\./);
  assert.match(near, /Oneshot approves only on the single word `approved`, with nothing else in the comment/);
  assert.match(near, /To approve v2, comment the single word `approved`\./);
  assert.equal(lastLine(near), '<!-- oneshot:automation:nochange:77 -->');

  const empty = noChangeBody({ v: 3, authors: ['anosha.saeed', 'arsal.tariq'], notes: ['Not applied: drop TC-99 — there is no TC-99'], nearApproval: false });
  assert.match(empty, /to v3 for the comments from @anosha\.saeed and @arsal\.tariq\./);
  assert.match(empty, /^- Not applied: drop TC-99 — there is no TC-99$/m);
  assert.doesNotMatch(empty, /nothing else in the comment/);
});

test('the stuck note gives the reason and who can release it', () => {
  const body = stuckBody('the list had 61 cases, more than the 60 allowed.', 'f00dfeed0001', APPROVERS);
  assert.match(body, /Oneshot tried twice and could not produce the test cases: the list had 61 cases, more than the 60 allowed\.\n/);
  assert.match(body, /@anosha\.saeed or @arsal\.tariq: comment anything on this ticket \(for example "retry"\)/);
  assert.equal(lastLine(body), '<!-- oneshot:automation:failed:f00dfeed0001 -->');
});

test('table cells survive pipes and newlines', () => {
  const tricky = kase('TC-01', {
    scenario: 'Verify that Save | Cancel both work',
    steps: ['Open the <title> editor', 'Type a | b\nthen c'],
    expected: 'line one\nline two',
    precondition: '',
    reason: 'Pipe | in the reason',
  });
  const body = casesBody(view({ cases: [tricky], hash: casesHash([tricky]) }));
  const row = body.split('\n').find((l) => l.startsWith('| **TC-01**'));
  assert.ok(row, 'the row is on one line');
  assert.equal(cellPipes(row), 8, 'still seven cells');
  assert.ok(row.includes('Save \\| Cancel'));
  assert.ok(row.includes('line one<br>line two'));
  assert.ok(row.includes('1. Open the &lt;title&gt; editor<br>2. Type a \\| b<br>then c'));
  assert.ok(row.includes('| — |'), 'an empty pre-condition shows a dash');
});

test('model text cannot forge a marker', () => {
  const sneaky = kase('TC-01', { scenario: 'Verify that <!-- oneshot:automation:done --> is text' });
  const body = casesBody(view({ cases: [sneaky], hash: casesHash([sneaky]), notes: ['<!-- oneshot:automation:done -->'], v: 2, diff: { added: [], removed: [], changed: [] } }));
  const notes: IssueNote[] = [{ id: 5, body }];
  assert.equal(findMarker(notes, 'done'), null);
  assert.equal(findMarker(notes, 'cases', 'v2:')?.id, 5);
});

// ----------------------------------------------------------------------- CSV

test('the CSV has the sheet\'s seven columns with numbered plain-text steps, starts with a BOM, and defuses formula-looking cells', () => {
  const csv = renderCasesCsv([
    kase('TC-01', { precondition: '', steps: ['Open Profile', 'Click "Save"'], expected: '=HYPERLINK("http://x","y")' }),
    kase('TC-02', { scenario: '+1 for the count', precondition: '-5 days', expected: '@SUM(A1)', reason: '\tTabbed', automatable: 'no' }),
  ]);
  assert.ok(csv.startsWith('﻿'), 'a UTF-8 BOM, so Excel reads → and — correctly');
  const [head, ...rest] = csv.slice(1).split('\n');
  assert.equal(head, '"ID","Test Scenario","Pre Condition","Steps","Expected Result","Automatable","Reason"');
  const body = rest.join('\n');
  assert.ok(body.includes('"TC-01","Verify that case TC-01 behaves","","1. Open Profile\n2. Click ""Save""","\'=HYPERLINK(""http://x"",""y"")","yes","Form and table are in the page"'));
  // Plain text, as in the sheet: a spreadsheet shows `**` as asterisks. The note keeps them.
  assert.ok(body.includes('"TC-02","\'+1 for the count","\'-5 days","1. Click Upload document\n2. Click Save","\'@SUM(A1)","no","\'\tTabbed"'));
  assert.ok(!body.includes('**'));
});

test('a very long list is cut in the note and points to the CSV', () => {
  const cases = Array.from({ length: MAX_CASES }, (_, i) =>
    kase(`TC-${String(i + 1).padStart(2, '0')}`, { expected: `${'x'.repeat(20_000)} ${i}` }));
  const body = casesBody(view({ cases, hash: casesHash(cases) }));
  assert.ok(body.length <= NOTE_BODY_LIMIT, `${body.length} fits`);
  const rows = body.split('\n').filter((l) => l.startsWith('| **TC-'));
  assert.ok(rows.length > 0 && rows.length < MAX_CASES, `${rows.length} rows kept`);
  const lastKept = `TC-${String(rows.length).padStart(2, '0')}`;
  assert.match(body, new RegExp(`_The table stops at \\*\\*${lastKept}\\*\\* \\(${rows.length} of 60 cases\\): GitLab cannot take a longer comment\\. The attached CSV has every case\\._`));
  // What is never cut: the line that tags the approvers, and the marker that stops a re-post.
  assert.match(body, /reply `approved`, or reply with the changes you want\./);
  assert.equal(lastLine(body), `<!-- oneshot:automation:cases:v1:${casesHash(cases)} -->`);

  const noCsv = casesBody(view({ cases, hash: casesHash(cases), csvMarkdown: null }));
  assert.match(noCsv, /The CSV could not be attached either/);
});

// ---------------------------------------------------------- diff, hash, checks

test('diffCases finds added, removed and changed cases', () => {
  const prev = [kase('TC-01'), kase('TC-02'), kase('TC-03')];
  const next = [
    kase('TC-01', { expected: '  The document  is listed ' }),   // re-spaced, not changed
    kase('TC-03', { steps: ['Click **Save**'], expected: 'A 403 page is shown' }),
    kase('TC-04'),
  ];
  const d = diffCases(prev, next);
  assert.deepEqual(d, { added: ['TC-04'], removed: ['TC-02'], changed: [{ id: 'TC-03', fields: ['steps', 'expected'] }] });
  assert.equal(isEmptyDiff(d), false);
  assert.equal(isEmptyDiff(diffCases(prev, prev.map((c) => ({ ...c })))), true);
});

test('casesHash does not depend on key order', () => {
  const a = kase('TC-01');
  const shuffled = {
    reason: a.reason, automatable: a.automatable, expected: a.expected, steps: [...a.steps],
    precondition: a.precondition, scenario: a.scenario, id: a.id,
  } as AutomationCase;
  assert.equal(casesHash([a]), casesHash([shuffled]));
  assert.match(casesHash([a]), /^[0-9a-f]{12}$/);
  assert.notEqual(casesHash([a]), casesHash([{ ...a, expected: 'Something else' }]));
  assert.notEqual(casesHash([a, kase('TC-02')]), casesHash([kase('TC-02'), a]), 'order of the cases is content');
});

test('validateCases rejects duplicate ids, empty reasons, a reused removed id and more than 60 cases; validateArtifact rejects a module that normalises to nothing', () => {
  assert.equal(validateCases(V1), null);
  assert.match(validateCases([kase('TC-01'), kase('TC-01')]) ?? '', /TC-01 is used by more than one case/);
  assert.match(validateCases([kase('TC-01', { reason: '  ' })]) ?? '', /TC-01 has an empty reason/);
  assert.match(validateCases([kase('TC-1')]) ?? '', /ids look like TC-01/);
  assert.match(validateCases([kase('TC-01', { steps: [] })]) ?? '', /has no steps/);
  assert.match(validateCases([kase('TC-01', { automatable: 'maybe' as AutomationCase['automatable'] })]) ?? '', /yes, partly or no/);
  assert.match(validateCases([]) ?? '', /no cases/);
  const many = Array.from({ length: MAX_CASES + 1 }, (_, i) => kase(`TC-${String(i + 1).padStart(2, '0')}`));
  assert.match(validateCases(many) ?? '', /61 cases, more than the 60 allowed/);
  assert.equal(validateCases(many.slice(0, MAX_CASES)), null);

  const removed = new Map([['TC-02', 'Verify that case TC-02 behaves']]);
  assert.match(
    validateCases([kase('TC-01'), kase('TC-02', { scenario: 'Verify that something new happens' })], removed) ?? '',
    /TC-02 was removed earlier .* reused for a different case/,
  );
  assert.equal(validateCases([kase('TC-01'), kase('TC-02', { scenario: 'verify that case  TC-02 behaves' })], removed), null,
    'the same case coming back is not a reuse');

  const artifact = (module: string): AutomationArtifact => ({ summary: 's', module, cases: V1, changes: [], sources: ['!501 apps/profile/views.py'] });
  assert.equal(validateArtifact(artifact('Profile')), null);
  assert.match(validateArtifact(artifact('Test Cases')) ?? '', /does not name a module/);
  assert.match(validateArtifact(artifact(' - ')) ?? '', /does not name a module/);
  assert.match(validateArtifact({ ...artifact('Profile'), cases: [kase('TC-01'), kase('TC-01')] }) ?? '', /more than one case/);
});

test('sanitizeArtifact redacts a token and refuses a private key', () => {
  const a: AutomationArtifact = {
    summary: 'Read with GITLAB_TOKEN=glpat-abcdefghijklmnop1234',
    module: 'Profile',
    cases: [kase('TC-01', { steps: ['Call the API with Authorization: Bearer abcdefghijklmnopqrstuvwxyz'] })],
    changes: [],
    sources: ['!501 apps/profile/views.py'],
  };
  const out = sanitizeArtifact(a);
  assert.ok('artifact' in out);
  assert.doesNotMatch(JSON.stringify(out.artifact), /glpat-abcdefghijklmnop1234/);
  assert.doesNotMatch(JSON.stringify(out.artifact), /abcdefghijklmnopqrstuvwxyz/);
  assert.match(out.artifact.summary, /\[redacted/);
  assert.equal(out.artifact.cases[0]!.automatable, 'yes');
  assert.equal(out.artifact.cases[0]!.scenario, a.cases[0]!.scenario, 'plain text is left alone');
  assert.equal(a.summary, 'Read with GITLAB_TOKEN=glpat-abcdefghijklmnop1234', 'the input is not mutated');

  const key = sanitizeArtifact({ ...a, cases: [kase('TC-01', { expected: '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...' })] });
  assert.deepEqual(key, { refused: 'the output contained a private key' });
  assert.ok('refused' in sanitizeArtifact({ ...a, sources: ['"private_key": "-----BEGIN PRIVATE KEY-----\\nMIIE"'] }));
});

// ------------------------------------------------------------------- markers

test('every marker is a machine note', () => {
  const kinds: MarkerKind[] = ['not-ready', 'cases', 'failed', 'nochange', 'done', 'sheet-failed'];
  for (const k of kinds) {
    assert.ok(isMachineNote(marker(k)), `${k} is a machine note`);
    assert.ok(isMachineNote(marker(k, 'abc123')), `${k} with detail is a machine note`);
  }
  assert.equal(marker('cases', 'v3:0123456789ab'), '<!-- oneshot:automation:cases:v3:0123456789ab -->');
  assert.equal(marker('done'), '<!-- oneshot:automation:done -->');
});

test('findMarker finds the newest note of a kind by detail prefix, and ignores quotes and system notes', () => {
  const notes: IssueNote[] = [
    { id: 10, body: `v1\n\n${marker('cases', 'v1:aaaaaaaaaaaa')}` },
    { id: 12, body: `v10\n\n${marker('cases', 'v10:bbbbbbbbbbbb')}` },
    { id: 11, body: `again\n\n${marker('cases', 'v1:cccccccccccc')}` },
    { id: 13, body: `> quoted\n> ${marker('done')}` },
    { id: 14, body: marker('done'), system: true },
  ];
  assert.equal(findMarker(notes, 'cases', 'v1:')?.id, 11, 'the newest v1, and never v10');
  assert.equal(findMarker(notes, 'cases', 'v10:')?.id, 12);
  assert.equal(findMarker(notes, 'cases')?.id, 12);
  assert.equal(findMarker(notes, 'done'), null);
  assert.equal(findMarker(notes, 'not-ready'), null);
});

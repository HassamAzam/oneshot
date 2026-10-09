/**
 * The two local automation test gates, driven through checkApprovalGate
 * against a fixture GitLab on 127.0.0.1 — the real request, the real reply
 * read, the real journal. Nothing leaves the machine: the repo URL points at
 * the fixture before anything imports config, Slack has no token, and DRY_RUN
 * is off so the gate does not approve itself.
 *
 * What these pin:
 * - `localSpecs` is QA's and `localResults` the developers': an `approved`
 *   from the other group is ignored, and any ONE member of the right group
 *   resolves the gate.
 * - A reviewer's `disapproved:` round is feedback: the gate records it and
 *   asks afresh on the next check, rather than approving or waiting.
 * - Ordinary chatter from anyone outside the group moves nothing.
 * - A plan rewritten while the request stands is asked about again, and an
 *   `approved` given on the old request does not carry over to it.
 * - This desk's own notes never count. Its token is a QA approver's, so a
 *   note it posts without a marker would read as that reviewer speaking.
 * - The results ask shows what the counts hide: a run cut off at its deadline,
 *   the tests that passed only on a retry, and the run's notes when a failure's
 *   "failing on dev too?" is unknown. The list ask names specs that cannot run
 *   on a desk.
 *
 * The journal lives under state/runs/<IID> with an invented iid, removed
 * afterwards.
 */
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';

const IID = 990601;
const BASE = `/api/v4/projects/acme%2Ferp/issues/${IID}`;
/** The desk's own account: on config/reviewers.json's QA list, as on the desk this feature was built for. */
const DESK = 'arsal.tariq';

interface Note { id: number; body: string; system: boolean; author: { username: string }; created_at: string }

const world = { notes: [] as Note[], nextNote: 5000 };

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const url = req.url ?? '';
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.startsWith(`${BASE}/notes`)) {
      if (req.method === 'POST') {
        const body = raw ? JSON.parse(raw) as { body?: string } : {};
        return send(201, note(DESK, String(body.body ?? '')));
      }
      // issueNotes() asks for the newest hundred, newest first.
      return send(200, [...world.notes].reverse().slice(0, 100));
    }
    return send(404, { message: `not in the fixture: ${req.method} ${url}` });
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
server.unref();
const port = (server.address() as AddressInfo).port;

// Set before anything imports config, so dotenv (which never overrides a key
// already set) cannot point any of this at the real GitLab, token or Slack.
process.env.GITLAB_REPO_URL = `http://127.0.0.1:${port}/acme/erp`;
process.env.GITLAB_READ_TOKEN = 'test-read-token';
process.env.ONESHOT_GITLAB_TOKEN = 'test-write-token';
process.env.SLACK_BOT_TOKEN = '';
process.env.DRY_RUN = '';

const {
  checkApprovalGate, localResultsApprovalRequestBody, localResultsApprovedRecordBody, localSpecsApprovalRequestBody,
  localSpecsApprovedRecordBody, localSpecsGateReason,
} = await import('./reviewgate.js');
const { gateSubjectDigest, readJournal, writeJournal } = await import('../lib/artifacts.js');
const { runDir } = await import('../lib/config.js');

after(() => {
  rmSync(runDir(IID), { recursive: true, force: true });
  server.close();
});

function note(user: string, body: string): Note {
  const n: Note = { id: world.nextNote++, body, system: false, author: { username: user }, created_at: new Date().toISOString() };
  world.notes.push(n);
  return n;
}

beforeEach(() => {
  world.notes = [];
  rmSync(runDir(IID), { recursive: true, force: true });
  writeJournal({ runId: 'r-lt-gate', iid: IID, title: 'Leave approval', url: '', createdAt: 0, status: 'running', phases: [] });
});

const scope = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  applicable: true,
  reason: 'The diff changes leave approval',
  modules: ['Leaves'],
  specs: [{ file: 'cypress/e2e/leaves/approve.cy.ts', module: 'Leaves', cases: 4, why: 'Approves a leave' }],
  edits: [],
  proposals: [{ action: 'add', title: 'Verify that a manager can reject a leave', why: 'The ticket adds rejecting' }],
  estimatedMinutes: 6,
  summary: 'One spec, one new test.',
  ...over,
});

const run = {
  status: 'failed',
  totals: { specs: 1, tests: 4, passed: 3, failed: 1, skipped: 0 },
  results: [{ spec: 'cypress/e2e/leaves/approve.cy.ts', title: 'approves', state: 'failed', durationMs: 1, failingOnDev: true }],
};

const specsGate = (subject: Record<string, unknown> = scope()) => checkApprovalGate({
  iid: IID, gate: 'localSpecs', subject,
  requestBody: localSpecsApprovalRequestBody(subject, localSpecsGateReason(subject) ?? ''),
});
const resultsGate = () => checkApprovalGate({
  iid: IID, gate: 'localResults', subject: run, requestBody: localResultsApprovalRequestBody(run),
});

/** Requests this desk has posted, oldest first. */
const requests = (gate: string): Note[] => world.notes.filter((n) => n.body.includes(`oneshot:gate:${gate}:request`));

test('localSpecs: the first check asks on the ticket, and one QA approval releases it', async () => {
  assert.equal((await specsGate()).verdict, 'pending');
  assert.equal(requests('localSpecs').length, 1);
  assert.match(requests('localSpecs')[0]!.body,
    /reply `approved` to run with this list, or `disapproved:` with one bullet per change/);

  assert.equal((await specsGate()).verdict, 'pending', 'nobody has answered yet');
  assert.equal(requests('localSpecs').length, 1, 'a pending gate does not ask twice');

  note('anosha.saeed', 'approved');
  assert.equal((await specsGate()).verdict, 'approved');
  const state = readJournal(IID)?.localSpecsApproval;
  assert.equal(state?.approved, true);
  assert.equal(state?.approvedDigest, gateSubjectDigest(scope()), 'the approval names what was approved');
});

test('localSpecs: a disapproved round is feedback, and the next check asks again', async () => {
  await specsGate();
  note('anosha.saeed', 'disapproved:\n- keep the half-day test\n- drop the new reject test');
  const r = await specsGate();
  assert.equal(r.verdict, 'feedback');
  assert.match(r.feedback ?? '', /keep the half-day test/);
  const state = readJournal(IID)?.localSpecsApproval;
  assert.equal(state?.approved, false);
  assert.deepEqual(state?.feedback, ['disapproved:\n- keep the half-day test\n- drop the new reject test']);
  assert.equal(state?.requestNoteId, null, 'the round is over');

  assert.equal((await specsGate(scope({ proposals: [] }))).verdict, 'pending');
  assert.equal(requests('localSpecs').length, 2, 'the revised list gets a fresh request');
});

test('localSpecs: developers, outsiders and this desk\'s own notes do not move it', async () => {
  await specsGate();
  note('hira.ijaz', 'approved'); // a developer, not QA
  note('someone.else', 'please also test the calendar');
  // Posted by this desk's QA-approver token, but it is the pipeline talking.
  note(DESK, `approved\n\n<!-- oneshot:publish:local-tests-run -->`);
  note(DESK, localSpecsApprovedRecordBody(scope()));
  assert.equal((await specsGate()).verdict, 'pending');
  assert.deepEqual(readJournal(IID)?.localSpecsApproval?.feedback, []);
});

test('localSpecs: a plan rewritten under a standing request is asked about again', async () => {
  await specsGate();
  note('arsal.tariq', 'approved');
  // The scope re-ran before this tick read the reply: the approval was for a
  // list that no longer exists.
  const revised = scope({ proposals: [{ action: 'remove', title: 'Verify the old button', why: 'gone' }] });
  assert.equal((await specsGate(revised)).verdict, 'pending');
  assert.equal(requests('localSpecs').length, 2, 're-asked about the new list');
  assert.equal(readJournal(IID)?.localSpecsApproval?.approved, false);

  note('anosha.saeed', 'approved');
  assert.equal((await specsGate(revised)).verdict, 'approved');
  assert.equal(readJournal(IID)?.localSpecsApproval?.approvedDigest, gateSubjectDigest(revised));
});

test('localResults: QA cannot release it, and any one developer can', async () => {
  assert.equal((await resultsGate()).verdict, 'pending');
  assert.match(requests('localResults')[0]!.body, /reply `approved` to continue to the MR step/);
  note('anosha.saeed', 'approved');
  assert.equal((await resultsGate()).verdict, 'pending', 'a QA approval is not a developer\'s');
  note('haider.usman', 'approved');
  assert.equal((await resultsGate()).verdict, 'approved');
  assert.equal(readJournal(IID)?.localResultsApproval?.approved, true);
  assert.equal(readJournal(IID)?.localSpecsApproval, undefined, 'the two gates keep separate state');
});

test('localResults: a developer\'s comment that is not `approved` is feedback', async () => {
  await resultsGate();
  note('hassam.azam', 'the approve failure is mine, re-run after the fix');
  const r = await resultsGate();
  assert.equal(r.verdict, 'feedback');
  assert.equal(r.feedback, 'the approve failure is mine, re-run after the fix');
  note(DESK, localResultsApprovedRecordBody());
  assert.equal((await resultsGate()).verdict, 'pending', 'asks again, and its own record is not a reply');
  assert.equal(requests('localResults').length, 2);
});

test('the localSpecs gate arms only for a change to the test list or a weakened test', () => {
  assert.equal(localSpecsGateReason(scope({ proposals: [] })), null, 'specs simply run as they are');
  assert.equal(localSpecsGateReason(scope({ applicable: false })), null);
  assert.match(localSpecsGateReason(scope()) ?? '', /^The plan proposes a change to the team's test list/);
  assert.match(localSpecsGateReason(scope({ proposals: [] }), ['cypress/e2e/leaves/approve.cy.ts']) ?? '',
    /^A temporary change made an existing test easier to pass \(`cypress\/e2e\/leaves\/approve\.cy\.ts`\)/);
});

test('a shortcut in a file the scope created is named as a new test, not as a weakened existing one', () => {
  const created = 'cypress/Pages/teamReview/team_checklist.ts';
  const s = scope({ proposals: [], edits: [{ file: created, kind: 'add', why: 'new page object', erpEvidence: 'x' }] });
  const why = localSpecsGateReason(s, [created]) ?? '';
  assert.match(why, /^A new test uses a shortcut that can hide a real failure, such as `force: true`/);
  assert.ok(why.includes(`(\`${created}\`)`));
  assert.doesNotMatch(why, /existing test/);
  const both = localSpecsGateReason(s, [created, 'cypress/e2e/leaves/approve.cy.ts']) ?? '';
  assert.match(both, /^A temporary change made an existing test easier to pass \(`cypress\/e2e\/leaves\/approve\.cy\.ts`\), and a new test uses a shortcut/);
});

test('the results ask says when Cypress was cut off, so "0 failed" is not read as "all passed"', () => {
  const body = localResultsApprovalRequestBody({
    status: 'failed',
    reason: 'Cypress was stopped at the 45-minute deadline; 3 spec(s) did not finish',
    totals: { specs: 5, tests: 40, passed: 30, failed: 0, skipped: 10 },
    results: [],
  });
  assert.ok(body.includes('**Results:** 30 passed, 0 failed, of 40 test(s). '
    + 'Cypress was stopped at the 45-minute deadline; 3 spec(s) did not finish.\n\n'), body);
  assert.doesNotMatch(body, /\*\*Failed\*\*/);
});

test('the results ask lists tests that passed only on a retry apart from the clean passes', () => {
  const body = localResultsApprovalRequestBody({
    ...run,
    totals: { specs: 1, tests: 4, passed: 3, failed: 1, skipped: 0 },
    results: [
      ...run.results,
      { spec: 'cypress/e2e/leaves/approve.cy.ts', title: 'cancels', state: 'passed', durationMs: 1, flaky: true },
      { spec: 'cypress/e2e/leaves/approve.cy.ts', title: 'lists', state: 'passed', durationMs: 1 },
    ],
  });
  assert.ok(body.includes('**Failed once, then passed on retry — flaky**\n- `cypress/e2e/leaves/approve.cy.ts` — cancels\n\n'),
    body);
  assert.doesNotMatch(body, /— lists/, 'a clean pass is only counted');
});

test('the results ask carries the run\'s notes when a failure\'s dev-too answer is unknown', () => {
  const notes = ['the failures were not re-run on origin/dev: E_APP_FAILED: the base app did not start'];
  const unknown = localResultsApprovalRequestBody({
    ...run, notes,
    results: [{ spec: 'cypress/e2e/leaves/approve.cy.ts', title: 'approves', state: 'failed', durationMs: 1, failingOnDev: null }],
  });
  assert.ok(unknown.includes('Failing on dev too? unknown'));
  assert.ok(unknown.includes(`**Notes from the run**\n- ${notes[0]}\n\n`), unknown);
  // Every failure answered: the notes add nothing the developer needs here.
  assert.doesNotMatch(localResultsApprovalRequestBody({ ...run, notes }), /Notes from the run/);
});

test('the list QA signs names the specs that cannot run locally', () => {
  const s = scope({ notRunnable: [{ spec: 'cypress/e2e/payroll/run.cy.ts', why: 'Needs Odoo for the payroll sync.' }] });
  const body = localSpecsApprovalRequestBody(s, localSpecsGateReason(s) ?? '');
  assert.ok(body.includes("**Tests that reach this change but can't run on a local machine** (not run)\n"
    + '- `cypress/e2e/payroll/run.cy.ts` — Needs Odoo for the payroll sync\n\n'), body);
  assert.doesNotMatch(localSpecsApprovalRequestBody(scope(), 'why'), /can't run on a local machine/);
});

test('every request and record these gates post carries a marker', () => {
  for (const body of [
    localSpecsApprovalRequestBody(scope(), 'why'), localSpecsApprovedRecordBody(scope()),
    localResultsApprovalRequestBody(run), localResultsApprovedRecordBody(),
  ]) assert.match(body, /<!-- oneshot:gate:local(Specs|Results):(request|approved) -->$/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyBaseCheck, codePhaseStatus, decideClaim, failedCases, mergePollWait, nextIndex,
  salvagedReview, testcaseGateRoute, ticketComments, uiEvidenceRefusal,
} from './runner.js';
import type { IssueNote } from '../lib/gitlab.js';
import { ticketScopeIds, type CaseResult } from '../phases/types.js';
import { MERGE_POLL_MS, type PhaseConfig } from '../lib/config.js';
import type { RunJournal } from '../lib/artifacts.js';
import type { JournalOwner } from '../lib/journalproject.js';

function phase(name: string, n: number, group?: string): PhaseConfig {
  return { name, n, kind: 'session', timeoutMin: 30, onFail: 'abort', ...(group ? { group } : {}) };
}

/** config/phases.json, trimmed to the names the index arithmetic moves between. */
const LIST: PhaseConfig[] = [
  phase('research', 1),
  phase('plan', 2),
  phase('implement', 3),
  phase('testcases', 4, 'check'),
  phase('review', 5, 'check'),
  phase('verify', 6),
];
const at = (name: string): number => LIST.findIndex((p) => p.name === name);

/**
 * runner.ts's shouldSkip(), which is what decides whether a phase the index
 * lands on is actually RUN. Asserting on this rather than on the `forced` set
 * is the point: the defect below was invisible from the set alone.
 *
 * `settled`, not `succeeded`: shouldSkip() consults phaseSettled(), so a phase
 * recorded 'skipped' by its own `onFail: 'skip'` policy counts here too. See
 * lib/phase-settled.test.ts for that distinction on its own.
 */
const skips = (forced: Set<string>, settled: string[], name: string): boolean =>
  !forced.has(name) && settled.includes(name);

test('a retry re-runs a phase that already succeeded on an earlier lap', () => {
  const forced = new Set<string>();
  // The case: plan passed, the run cycled back, and the re-plan against reviewer
  // feedback died of infra. afterFailure() returns a retry at plan's index —
  // which reached a phase with a succeeded record on it.
  const i = nextIndex({ kind: 'retry', at: at('plan') }, at('plan'), at('plan'), LIST, forced);

  assert.equal(i, at('plan'));
  assert.equal(skips(forced, ['research', 'plan'], 'plan'), false,
    'the retried phase was skipped as already-done — this is the defect');
});

test('a retry forces only the retried phase, so a grouped retry runs solo', () => {
  // testcases and review share group "check". The group is rebuilt on the
  // retry pass and breaks on the first member shouldSkip() answers true for,
  // so a still-succeeded testcases collapses the group to review alone.
  const forced = new Set<string>();
  nextIndex({ kind: 'retry', at: at('review') }, at('review'), at('review'), LIST, forced);

  assert.deepEqual([...forced], ['review']);
  assert.equal(skips(forced, ['testcases', 'review'], 'testcases'), true);
});

test('a cycle forces its whole window and leaves the pinned case list alone', () => {
  const forced = new Set<string>();
  const i = nextIndex(
    { kind: 'cycle', jumpTo: at('implement'), windowEnd: at('verify') },
    at('verify'), at('verify'), LIST, forced,
  );

  assert.equal(i, at('implement'));
  assert.deepEqual([...forced].sort(), ['implement', 'review', 'verify']);
  assert.equal(skips(forced, ['implement', 'testcases', 'review'], 'testcases'), true);
});

test('an advance steps past the last member of a group, not past the current index', () => {
  const forced = new Set<string>();
  // testcases+review dispatched together: the loop is at testcases, the group
  // ends at review, and the next phase to run is verify.
  assert.equal(
    nextIndex({ kind: 'advance' }, at('testcases'), at('review'), LIST, forced),
    at('verify'),
  );
  assert.deepEqual([...forced], []);
});

// ------------------------------------------------ whose journal, at the claim

const journal = (o: Partial<RunJournal> = {}): RunJournal => ({
  runId: 'r1', iid: 237, project: 'gitlab.example.com/acme/erp', title: 't',
  url: 'https://gitlab.example.com/acme/erp/-/issues/237', createdAt: 1, status: 'aborted',
  worktree: '/wt/t237-r1', mrIid: 12,
  phases: [{ phase: 'plan', status: 'ok' }, { phase: 'implement', status: 'ok' }] as RunJournal['phases'],
  ...o,
});
const OURS: JournalOwner = { kind: 'ours', adopt: false };
const DROP: JournalOwner = {
  kind: 'ours', adopt: false, dropWorktree: true, why: 'its recorded worktree /wt/t237-r1 is a checkout of x',
};

test('a journal of another project is archived and the ticket starts fresh, whatever its status', () => {
  for (const status of ['running', 'aborted', 'parked', 'blocked'] as const) {
    const j = journal({ status, blockedAt: 0 });
    assert.deepEqual(decideClaim(j, { kind: 'foreign', why: 'x' }), { kind: 'fresh', archive: 'r1' }, status);
  }
});

test('an ours journal whose worktree is dropped still RESUMES — its phases and MR are never thrown away', () => {
  for (const owner of [OURS, DROP, { kind: 'ours', adopt: true } as JournalOwner]) {
    const j = journal();
    const d = decideClaim(j, owner);
    assert.equal(d.kind, 'resume', JSON.stringify(owner));
    assert.equal(d.kind === 'resume' && d.journal, j);
  }
  // Only its own status decides otherwise, exactly as for any journal of ours.
  assert.deepEqual(decideClaim(journal({ status: 'done' }), DROP), { kind: 'fresh', archive: 'r1' });
  assert.equal(decideClaim(journal({ status: 'blocked', blockedAt: Date.now() }), DROP).kind, 'refuse');
  assert.deepEqual(decideClaim(null, null), { kind: 'fresh', archive: null });
});

// ------------------------------------------------ merge parked on a human merge

const MERGE: PhaseConfig = { name: 'merge', n: 9, kind: 'code', timeoutMin: 10, onFail: 'blocked' };

test('a merge waiting on a human is recorded parked, not failed', () => {
  assert.equal(codePhaseStatus(MERGE, { ok: false, park: true }), 'parked');
});

test('a genuine merge refusal is still recorded failed, and a merge ok', () => {
  assert.equal(codePhaseStatus(MERGE, { ok: false }), 'failed');
  assert.equal(codePhaseStatus(MERGE, { ok: true }), 'ok');
  // A success wins over a stray park flag.
  assert.equal(codePhaseStatus(MERGE, { ok: true, park: true }), 'ok');
});

const T0 = 1_800_000_000_000;
const poll = (o: Partial<Parameters<typeof mergePollWait>[0]> = {}): number | null => mergePollWait({
  wasParked: true, reviewMode: true, dryRun: false,
  lastCheckAt: T0, mergeSucceeded: false, now: T0 + 3 * 60_000, ...o,
});

test('a merge-parked run inside its poll window is held until the window is up', () => {
  assert.equal(poll(), MERGE_POLL_MS - 3 * 60_000);
});

test('the hold is keyed on the CLAIMED status, so a resumed parked run is held', () => {
  // The defect: the gate read the journal after the resume had set it to
  // 'running', so wasParked was effectively always false and every tick
  // walked to merge. Only the claimed status can hold the run.
  assert.equal(poll({ wasParked: false }), null);
  assert.notEqual(poll({ wasParked: true }), null);
});

test('the run goes through once the poll window is due', () => {
  assert.equal(poll({ now: T0 + MERGE_POLL_MS }), null);
  assert.equal(poll({ now: T0 + MERGE_POLL_MS + 1 }), null);
});

test('nothing holds a run that is not waiting on a human merge', () => {
  assert.equal(poll({ reviewMode: false }), null, 'Review label removed: release at once');
  assert.equal(poll({ dryRun: true }), null);
  assert.equal(poll({ mergeSucceeded: true }), null, 'a later park must not wait behind a finished merge');
  assert.equal(poll({ lastCheckAt: undefined }), null, 'never asked GitLab yet: ask now');
});

// The case: the reviewer wrote "TC-05 is removed and replaced by the
// three separate cases below". Appending that produced a case reading `Verify
// that TC-05 is removed and replaced by...`, left TC-05 in place, and took the
// list from 20 cases to 44. A revision has to reach a model, and the only way
// to a model on this path is to cycle the phase.
test('a revision request cycles the testcases phase instead of appending', () => {
  assert.equal(testcaseGateRoute('feedback', true), 'revise');
});

test('a sign-off proceeds, and the append it may carry is the approved path', () => {
  // `approved` never routes to 'revise': a comment followed by `approved` is one
  // more case on a list the reviewer accepted, which append expresses exactly.
  assert.equal(testcaseGateRoute('approved', true), 'proceed');
  assert.equal(testcaseGateRoute('approved', false), 'proceed');
});

test('an unanswered gate parks, as it always has', () => {
  assert.equal(testcaseGateRoute('pending', true), 'park');
});

test('an empty reviewer list blocks rather than parking forever', () => {
  assert.equal(testcaseGateRoute('unavailable', true), 'blocked');
});

test('a revision with no testcases phase to cycle parks, never silently proceeds', () => {
  // Treating a revision as an approval because the board is misconfigured would
  // turn a reviewer asking for changes into a sign-off they never gave.
  assert.equal(testcaseGateRoute('feedback', false), 'park');
});

/**
 * `uiEvidenceRefusal` — the two ways a pack can report success and prove nothing.
 *
 * Both are reachable today: the schema requires `screenshots` and `observations`
 * to be PRESENT, and an empty array satisfies that. `publish.ts` then returns
 * null for a pack with nothing in it, so the MR gets no comment and the phase
 * still records ok. The reviewer is told nothing and nobody is told why.
 */
const pack = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  screenshots: [], observations: [], designConformance: [], ...over,
});
const shot = { file: 'a.png', caption: 'the reset page', caseId: 'TC-1' };
const obs = (before: string, after: string) => ({
  what: 'document.title on /accounts/password_reset/',
  before, after, how: 'Playwright page.title()', caseId: 'TC-1',
});

test('a pack with no screenshots and no observations is refused', () => {
  const why = uiEvidenceRefusal(pack());
  assert.ok(why, 'a pack that produced nothing must not record ok');
  assert.match(why, /no screenshots/i);
});

test('either kind of evidence on its own is a complete pack', () => {
  // The prompt explicitly promises this: a non-visual change is allowed to
  // return zero screenshots and a full table, and must not be failed for it.
  assert.equal(uiEvidenceRefusal(pack({ screenshots: [shot] })), null);
  assert.equal(uiEvidenceRefusal(pack({ observations: [obs('', 'Forgot Password')] })), null);
});

test('a design-conformance pack with nothing else is not refused', () => {
  const rows = [{ screenId: 's1', designShot: 'd.png', builtShot: 'b.png', differences: [] }];
  assert.equal(uiEvidenceRefusal(pack({ designConformance: rows })), null);
});

test('an observation table where every value is unchanged is refused', () => {
  const why = uiEvidenceRefusal(pack({ observations: [obs('en', 'en'), obs(' x ', 'x')] }));
  assert.ok(why, 'a table that shows no change is not evidence of a change');
  assert.match(why, /unchanged/i);
});

test('one unchanged row among changed ones is a control, not a refusal', () => {
  // A row proving something did NOT regress is legitimate evidence. Only a
  // table where NOTHING moved proves nothing.
  const rows = [obs('', 'Forgot Password'), obs('en', 'en')];
  assert.equal(uiEvidenceRefusal(pack({ observations: rows })), null);
});

test('an unmeasured base is not counted as unchanged', () => {
  // `before` is allowed to be "not measured" with a reason. That row is honest
  // about proving nothing; it must not be read as before === after.
  const why = uiEvidenceRefusal(pack({ observations: [obs('not measured — no base app', 'en')] }));
  assert.equal(why, null);
});

test('a phase that returned no artifact at all is left to the caller', () => {
  // r.out.ok is false in that case and the runner already fails it; returning a
  // second reason here would double-report one failure.
  assert.equal(uiEvidenceRefusal(null), null);
  assert.equal(uiEvidenceRefusal(undefined), null);
});

const finding = (id: string, severity: string) => ({
  id, severity, file: 'apps/payroll/views.py', line: 10, what: 'w', why: 'y', fix: 'f',
});

test('a dead review with a blocker on record comes back as changes-requested', () => {
  const out = salvagedReview([finding('F-01', 'blocker'), finding('F-02', 'minor')], 'timed out');
  assert.equal(out?.verdict, 'changes-requested');
  // The minor rides along: the verdict is decided by the serious findings, but
  // implement reads the whole list and a written-down minor is still output.
  assert.equal(out?.findings.length, 2);
  assert.match(out!.summary, /PARTIAL/);
  assert.match(out!.summary, /F-01 \[blocker\]/);
});

test('a major is salvageable too — the bar is blocker OR major', () => {
  assert.equal(salvagedReview([finding('F-01', 'major')], null)?.verdict, 'changes-requested');
});

test('minors and suggestions alone are not a verdict, so the infra re-attempt stands', () => {
  assert.equal(salvagedReview([finding('F-01', 'minor'), finding('F-02', 'suggestion')], 'x'), null);
});

test('an empty partial salvages nothing', () => {
  assert.equal(salvagedReview([], 'timed out'), null);
});

test('a partial whose findings is not an array salvages nothing instead of throwing', () => {
  // The file is freehand model output and readArtifact does not validate its
  // shape; a throw here escapes runTicket and strands the claim.
  for (const bad of [{ F1: finding('F-01', 'blocker') }, 'blocker', 3, {}]) {
    assert.equal(salvagedReview(bad, 'timed out'), null);
  }
  // Non-object entries inside an array are dropped, not dereferenced.
  assert.equal(salvagedReview([null, 'x', finding('F-01', 'blocker')], null)?.findings.length, 1);
});

// ------------------------------------------------- the comments a phase reads

/**
 * ticketComments() is the filter chain fetchTicket() runs over a ticket's
 * notes. It is asserted on directly because a replay hands it a cutoff, and
 * the whole claim that a replay driver leaves live runs alone rests on what
 * this returns when there is no cutoff to apply.
 */
const note = (body: string, created_at?: string, system = false): IssueNote =>
  ({ id: 1, body, system, ...(created_at ? { created_at } : {}) });

const RUN_STARTED = Date.parse('2026-09-15T12:00:00Z');

test('with no cutoff every human comment survives, so a live run reads the ticket unchanged', () => {
  const notes = [
    note('the oldest requirement', '2026-09-14T09:00:00Z'),
    note('an amendment', '2026-09-16T09:00:00Z'),
    note('one GitLab never timestamped'),
  ];

  assert.deepEqual(ticketComments(notes), [
    'the oldest requirement', 'an amendment', 'one GitLab never timestamped',
  ]);
});

test('a cutoff keeps only the comments that predate it', () => {
  const notes = [
    note('written before the run started', '2026-09-15T09:00:00Z'),
    note('the plan this run published', '2026-09-15T13:00:00Z'),
    note('the reviewer feedback on that plan', '2026-09-16T09:00:00Z'),
  ];

  assert.deepEqual(ticketComments(notes, RUN_STARTED), ['written before the run started']);
});

test('a comment GitLab did not timestamp is dropped under a cutoff rather than guessed at', () => {
  // Unprovable order is the one case a replay cannot be relaxed about: a note
  // that may be the plan under test is worth less than the one it displaces.
  assert.deepEqual(ticketComments([note('undated')], RUN_STARTED), []);
});

test('the cutoff is layered on the existing filters, not substituted for them', () => {
  const notes = [
    note('a label swap', '2026-09-14T09:00:00Z', true),
    note('Oneshot claimed this ticket — run `r-1`', '2026-09-14T09:00:00Z'),
    note('a claim by marker <!-- oneshot:claim -->', '2026-09-14T09:00:00Z'),
    note('a real requirement', '2026-09-14T09:00:00Z'),
  ];

  assert.deepEqual(ticketComments(notes, RUN_STARTED), ['a real requirement']);
  assert.deepEqual(ticketComments(notes), ['a real requirement']);
});

// ------------------------------------------------ pre-existing verify failures

const verified = (...results: Array<{ id: string; result: string; evidence?: string }>) => ({
  results: results.map((r) => ({ evidence: 'e', screenshot: '', ...r })),
});

// #258 and #259 both failed a TC-15 that verify itself called a pre-existing
// backend bug; #259 failed it again on its second lap and blocked.
test('a pre-existing failure alone does not fail verify, so the run does not cycle', () => {
  const data = verified(
    { id: 'TC-01', result: 'pass' },
    { id: 'TC-15', result: 'pre-existing', evidence: 'fails on dev too: apps/x/views.py:40' },
  );
  assert.equal(failedCases('verify', data), null);
});

test('a real fail beside a pre-existing one still fails verify, and names only the real one', () => {
  const why = failedCases('verify', verified(
    { id: 'TC-02', result: 'fail' },
    { id: 'TC-15', result: 'pre-existing', evidence: 'fails on dev too' },
  ));
  assert.match(why ?? '', /1 failing case\(s\) of 2: TC-02$/);
});

test('a pre-existing label with no evidence is counted as the fail it would hide', () => {
  const why = failedCases('verify', verified({ id: 'TC-15', result: 'pre-existing', evidence: '  ' }));
  assert.match(why ?? '', /TC-15/);
});

// ------------------------------------------------ base-check proves the label

const res = (id: string, result: CaseResult['result'], evidence = 'fails on dev: views.py:40'): CaseResult =>
  ({ id, result, evidence, screenshot: '' });

test('a pre-existing case the base branch also fails, outside the ticket scope, keeps its label', () => {
  const out = applyBaseCheck([res('TC-01', 'pass'), res('TC-15', 'pre-existing')], {
    baseCommit: 'abcdef1234',
    results: [{ id: 'TC-15', onBase: 'fails', inTicketScope: false, evidence: '500 on save' }],
  }, 'dev');
  assert.deepEqual(out.confirmed, ['TC-15']);
  assert.equal(out.results[1]!.result, 'pre-existing');
  assert.match(out.results[1]!.evidence, /confirmed on dev @ abcdef12: 500 on save/);
  assert.equal(failedCases('verify', { results: out.results }), null);
});

test('a case that passes on the base goes back to fail — the change broke it', () => {
  const out = applyBaseCheck([res('TC-15', 'pre-existing')],
    { results: [{ id: 'TC-15', onBase: 'passes', evidence: 'saved fine' }] }, 'dev');
  assert.deepEqual(out.rejected, ['TC-15']);
  assert.equal(out.results[0]!.result, 'fail');
  assert.match(out.results[0]!.evidence, /NOT confirmed — passes on dev/);
  assert.match(failedCases('verify', { results: out.results }) ?? '', /TC-15/);
});

test('unproven is not proven: inconclusive, a missing entry, or no check at all are fails', () => {
  const inconclusive = applyBaseCheck([res('TC-15', 'pre-existing')],
    { results: [{ id: 'TC-15', onBase: 'inconclusive', evidence: 'E_NO_PORTS' }] }, 'dev');
  assert.equal(inconclusive.results[0]!.result, 'fail');
  const missing = applyBaseCheck([res('TC-15', 'pre-existing')], { results: [] }, 'dev');
  assert.equal(missing.results[0]!.result, 'fail');
  const none = applyBaseCheck([res('TC-15', 'pre-existing')], null, 'dev');
  assert.equal(none.results[0]!.result, 'fail');
  assert.match(none.results[0]!.evidence, /no base-branch check ran/);
});

test('a label with no evidence is not rescued by the base check, and says so', () => {
  const out = applyBaseCheck([res('TC-15', 'pre-existing', '')],
    { results: [{ id: 'TC-15', onBase: 'fails', inTicketScope: false, evidence: 'x' }] }, 'dev');
  assert.equal(out.results[0]!.result, 'fail');
  // The base WAS checked and failed; "could not be checked" would tell
  // implement and the reviewer the opposite of what the check found.
  assert.match(out.results[0]!.evidence, /fails on dev.*no evidence/);
  assert.doesNotMatch(out.results[0]!.evidence, /could not be checked/);
});

test('results that are not pre-existing pass through untouched', () => {
  const input = [res('TC-01', 'pass'), res('TC-02', 'fail'), res('TC-03', 'blocked')];
  const out = applyBaseCheck(input, null, 'dev');
  assert.deepEqual(out.results, input);
  assert.deepEqual([out.confirmed, out.rejected], [[], []]);
});

// ------------------------------------- the ticket's own scope is never pre-existing

/**
 * "Fails on the base" is true by definition of the ticket's own bug, so the
 * base check alone confirmed exactly the mislabel it exists to catch: an
 * implement lap that fixed the wrong path left the reported bug standing,
 * verify cited a base line the diff really does not touch, the base failed
 * the same way, and the merge gate opened on a non-fix.
 */
const ownBug = (): CaseResult =>
  res('TC-02', 'pre-existing', 'shows 0, expected 5; same on dev at apps/leaves/utils.py:88, untouched by the diff');

test('a case the check finds in the ticket scope goes back to fail even though the base fails it', () => {
  const out = applyBaseCheck([res('TC-01', 'pass'), ownBug()],
    { results: [{ id: 'TC-02', onBase: 'fails', inTicketScope: true, evidence: 'shows 0 on dev' }] }, 'dev');
  assert.deepEqual(out.rejected, ['TC-02']);
  assert.equal(out.results[1]!.result, 'fail');
  assert.match(out.results[1]!.evidence, /this ticket's own scope — failing on dev is what the change was meant to fix/);
  assert.match(failedCases('verify', { results: out.results }) ?? '', /TC-02/,
    'a refused label must cycle back to implement, not just be renamed');
});

test('a check that never judged scope confirms nothing', () => {
  const out = applyBaseCheck([ownBug()],
    { results: [{ id: 'TC-02', onBase: 'fails', evidence: 'shows 0 on dev' }] }, 'dev');
  assert.equal(out.results[0]!.result, 'fail');
  assert.match(out.results[0]!.evidence, /did not judge whether it is this ticket's scope/);
});

test('a happy-tagged case is refused the label whatever the base check says', () => {
  const ownScope = ticketScopeIds([
    { id: 'TC-01', pass: ['regression'] },
    { id: 'TC-02', pass: ['happy', 'boundary'] },
  ]);
  const out = applyBaseCheck([res('TC-01', 'pass'), ownBug()],
    { results: [{ id: 'TC-02', onBase: 'fails', inTicketScope: false, evidence: 'shows 0 on dev' }] },
    'dev', { ownScope });
  assert.deepEqual(out.confirmed, []);
  assert.equal(out.results[1]!.result, 'fail');
  assert.match(out.results[1]!.evidence, /tagged 'happy'/);
});

test('only the happy pass marks a case as the ticket scope, and a malformed case is skipped', () => {
  const ids = ticketScopeIds([
    { id: 'TC-01', pass: ['happy'] },
    { id: 'TC-02', pass: ['regression', 'cross-module'] },
    { id: 'TC-03' },
    { id: 4, pass: ['happy'] },
    { id: 'TC-05', pass: 'happy' },
  ]);
  assert.deepEqual([...ids], ['TC-01']);
});

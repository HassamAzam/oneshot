/**
 * The stateful half of the verify-case QA gate.
 *
 * Every regression across four review rounds landed here rather than in the
 * parser, and the suite could not see any of it: `grep` for `verifyConfirmedAt`,
 * `lapWindow`, `rearmGate` or `MAX_CONFIRMATIONS` across the tests found
 * nothing, so each round's state change shipped with a green 851 and broke
 * something that only a live run would show.
 *
 * The journal tests must not write into the live `state/runs`, which the board
 * collector reads — a first attempt at this file left seven invented tickets
 * there. `ONESHOT_HOME` is not settable from outside: `config.ts` fixes it to
 * the repo root unless DRY_RUN, in which case it is the gitignored `state-dry/`.
 * So DRY_RUN is set here before the dynamic imports — both are read into module
 * constants at import time, which is why nothing that pulls config may be
 * statically imported above.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.DRY_RUN = '1';

const { lapWindow, settleVerifyCase, verifyGateRoute, verifyRescopeIsScoped } = await import('./runner.js');
const {
  nextConfirmation, MAX_CONFIRMATIONS, rearmGate, requestedCaseIds, settledVerifyCases, verifyCaseFloors,
  verifyCasesRequestBody, verifyDirectivesByCase,
} = await import('./reviewgate.js');
const { writeJournal, readJournal } = await import('../lib/artifacts.js');
const { runDir } = await import('../lib/config.js');
type Journal = Awaited<ReturnType<typeof readJournal>>;

const written: number[] = [];
process.on('exit', () => {
  for (const iid of written) rmSync(runDir(iid), { recursive: true, force: true });
});

/** An MR-feedback ledger holding one round, which is all `activeRound` reads. */
function ledger(status: string, startedAt: number): unknown {
  return {
    rounds: [{
      n: 1, mrIid: 1, startedAt, status, threads: [], items: [], addressed: [],
      replied: [], resolved: [], respondAttempts: 0,
    }],
    handled: {},
  };
}

function journal(iid: number, extra: Record<string, unknown> = {}): NonNullable<Journal> {
  const j = {
    runId: `r-${iid}`, iid, title: 'A ticket', url: `http://example.invalid/${iid}`,
    createdAt: 1_000, status: 'running', phases: [], ...extra,
  } as unknown as NonNullable<Journal>;
  writeJournal(j);
  written.push(iid);
  return j;
}

// ------------------------------------------------------- the lap window

test('a confirmed verdict rebases verify\'s lap window, and only verify\'s', () => {
  const j = journal(9001, { verifyConfirmedAt: 5_000 });
  assert.equal(lapWindow(j, 'verify'), 5_000);
  // Any other phase is unaffected: a confirmation says nothing about how many
  // laps `review` or `implement` have spent.
  assert.equal(lapWindow(j, 'implement'), 0);
  assert.equal(lapWindow(j, 'review'), 0);
});

test('with no confirmation the window is zero, so laps count from the start', () => {
  assert.equal(lapWindow(journal(9002), 'verify'), 0);
});

test('an MR fix round and a confirmation take whichever window is later', () => {
  const fixing = ledger('fixing', 8_000);
  const later = journal(9003, { verifyConfirmedAt: 5_000, mrFeedback: fixing });
  assert.equal(lapWindow(later, 'verify'), 8_000);
  // The fix round still rebases every other phase, which is what it is for.
  assert.equal(lapWindow(later, 'implement'), 8_000);

  const earlier = journal(9004, { verifyConfirmedAt: 9_500, mrFeedback: ledger('fixing', 8_000) });
  assert.equal(lapWindow(earlier, 'verify'), 9_500);
  assert.equal(lapWindow(earlier, 'implement'), 8_000);
});

test('a settled fix round does not rebase anything', () => {
  const j = journal(9005, { mrFeedback: ledger('done', 8_000) });
  assert.equal(lapWindow(j, 'verify'), 0);
  assert.equal(lapWindow(j, 'implement'), 0);
});

// -------------------------------------------- the lastNoteId double-spend

test('the same typed confirmation is never spent twice', () => {
  const ds = [{ verdict: 'confirmed' as const, noteId: 42 }];
  // First read: a round is there to be spent.
  assert.deepEqual(nextConfirmation(ds, { rounds: 0 }), { spend: true, conf: ds[0] });
  // The resolver re-reads every qualified reply on every tick. Once note 42 is
  // recorded as the one spent, re-reading it must find nothing — otherwise the
  // second round goes unattended and the "a human types it each round" bound
  // this verdict relies on is gone.
  assert.equal(nextConfirmation(ds, { rounds: 1, lastNoteId: 42 }), null);
  // A genuinely newer reply is a new round.
  const newer = { verdict: 'confirmed' as const, noteId: 77 };
  assert.deepEqual(
    nextConfirmation([...ds, newer], { rounds: 1, lastNoteId: 42 }),
    { spend: true, conf: newer },
  );
});

test('past the cap a new confirmation is reported but buys no round', () => {
  const ds = [{ verdict: 'confirmed' as const, noteId: 77 }];
  const got = nextConfirmation(ds, { rounds: MAX_CONFIRMATIONS, lastNoteId: 42 });
  assert.deepEqual(got, { spend: false, conf: ds[0] });
});

test('a reply with no confirmation in it spends nothing', () => {
  assert.equal(nextConfirmation([{ verdict: 'skip', noteId: 42 }], { rounds: 0 }), null);
  assert.equal(nextConfirmation([], { rounds: 0 }), null);
});

// ------------------------------------------------------------ re-arming

test('re-arming clears the request note so the next entry asks again', () => {
  journal(9006, {
    verifyCasesApproval: { requestTs: 1_234, requestNoteId: 555, approved: false, feedback: ['earlier note'] },
  });
  const after = rearmGate(9006, 'verifyCases');
  assert.ok(after);
  assert.equal(after.verifyCasesApproval?.requestNoteId, null);
  assert.equal(after.verifyCasesApproval?.requestTs, null);
  assert.equal(after.verifyCasesApproval?.approved, false);
  // Feedback already gathered survives — re-arming asks for the next round, it
  // does not forget the round that was answered.
  assert.deepEqual(after.verifyCasesApproval?.feedback, ['earlier note']);
  // And it is on disk, not just in the returned object.
  assert.equal(readJournal(9006)?.verifyCasesApproval?.requestNoteId, null);
});

test('re-arming a gate that was never armed is harmless', () => {
  journal(9007);
  const after = rearmGate(9007, 'verifyCases');
  assert.ok(after);
  assert.equal(after.verifyCasesApproval?.requestNoteId, null);
});

// -------------------------------------------- a reply that does both things

test('a reply that confirms one case and rescopes another loses neither', () => {
  const gate = {
    confirmed: [{ caseId: 'TC-14' }],
    rescope: [{ caseId: 'TC-15', steps: ['open the page'], by: 'qa' }],
  };
  // The confirmation decides where the run goes, because it is the one that
  // needs code to change. Returning on whichever branch came first is what
  // banked a round and then discarded it.
  assert.equal(verifyGateRoute(gate), 'refix');
  // And the re-run is NOT scoped to the rescoped case: `implement` is about to
  // change the code, so "no code has changed, every other case keeps its
  // verdict" is false, and the corrected steps run with the full list.
  assert.equal(verifyRescopeIsScoped(gate), false);
});

test('corrected steps alone still scope the re-run to those cases', () => {
  const gate = { confirmed: [], rescope: [{ caseId: 'TC-15', steps: ['open'], by: 'qa' }] };
  assert.equal(verifyGateRoute(gate), 'reverify');
  assert.equal(verifyRescopeIsScoped(gate), true);
});

test('a confirmation alone cycles to implement', () => {
  const gate = { confirmed: [{ caseId: 'TC-14' }], rescope: [] };
  assert.equal(verifyGateRoute(gate), 'refix');
  assert.equal(verifyRescopeIsScoped(gate), false);
});

test('neither means the gate settles on the terminal verdicts it applied', () => {
  assert.equal(verifyGateRoute({ confirmed: [], rescope: [] }), 'settle');
});

// ------------------------------------- a case the standing request never named

/** A QA reply as `repliesAfter` hands it over. */
const reply = (id: number, text: string): { id: number; text: string; user: string; at: null } =>
  ({ id, text, user: 'qa', at: null });

test('the request is read back to the cases it listed', () => {
  const body = verifyCasesRequestBody([
    { id: 'TC-21', evidence: 'the dashboard shows **0** rows' }, { id: 'TC-22' },
  ]);
  assert.deepEqual(requestedCaseIds(body), ['TC-21', 'TC-22']);
});

test('a follow-up request says so, and lists only what it asks', () => {
  const body = verifyCasesRequestBody([{ id: 'TC-12' }], true);
  assert.match(body, /follow-up/);
  assert.deepEqual(requestedCaseIds(body), ['TC-12']);
  assert.doesNotMatch(verifyCasesRequestBody([{ id: 'TC-12' }]), /follow-up/);
});

test('a request from before requestedCases is read off its note, so a new failing case is unasked', () => {
  // #9072: note 302703 listed TC-21 and TC-22; TC-12 began failing on a later lap.
  const state = { requestTs: null, requestNoteId: 302703, approved: false, feedback: [] };
  const notes = [{ id: 302703, body: verifyCasesRequestBody([{ id: 'TC-21' }, { id: 'TC-22' }]) }];
  const floors = verifyCaseFloors(state, notes);
  assert.equal(floors['TC-12'], undefined, 'TC-12 was never asked about, so the gate must ask');
  assert.deepEqual(floors, { 'TC-21': 302703, 'TC-22': 302703 });
});

test('a request whose note is gone covers nothing, so every case is asked again', () => {
  const state = { requestTs: null, requestNoteId: 5, approved: false, feedback: [] };
  assert.deepEqual(verifyCaseFloors(state, []), {});
  assert.deepEqual(verifyCaseFloors({ ...state, requestNoteId: null }, []), {});
});

test('recorded asks win over the note body', () => {
  const state = {
    requestTs: null, requestNoteId: 10, approved: false, feedback: [],
    requestedCases: { 'TC-21': 10, 'TC-12': 30 },
  };
  assert.deepEqual(verifyCaseFloors(state, [{ id: 10, body: '- **TC-99**' }]), { 'TC-21': 10, 'TC-12': 30 });
});

test('a case asked in a follow-up takes no verdict from replies written before it', () => {
  const floors = { 'TC-21': 10, 'TC-12': 30 };
  const replies = [
    // Written to the first request, before anyone asked about TC-12.
    reply(20, 'TC-21: pre-existing\nTC-12: skip'),
    reply(40, 'TC-12: expected'),
  ];
  const perCase = verifyDirectivesByCase(replies, ['TC-21', 'TC-12'], floors);
  assert.deepEqual(perCase.get('TC-21')?.map((d) => d.verdict), ['pre-existing']);
  assert.deepEqual(perCase.get('TC-12')?.map((d) => [d.verdict, d.noteId]), [['expected', 40]]);
});

test('a case no request has named takes nothing from any reply', () => {
  const perCase = verifyDirectivesByCase([reply(20, 'TC-12: expected')], ['TC-12'], { 'TC-21': 10 });
  assert.equal(perCase.size, 0);
});

test('re-arming drops the asked cases with the note that asked them', () => {
  journal(9008, {
    verifyCasesApproval: {
      requestTs: null, requestNoteId: 10, approved: false, feedback: [], requestedCases: { 'TC-21': 10 },
    },
  });
  const after = rearmGate(9008, 'verifyCases');
  assert.equal(after?.verifyCasesApproval?.requestedCases, undefined);
});

// ------------------------------------------- a settled case that fails again

test('a case QA settled stays settled, with the bug it already has', () => {
  const settled = settledVerifyCases([
    { caseId: 'TC-21', verdict: 'pre-existing', by: 'qa', issueIid: 9197 },
    { caseId: 'TC-22', verdict: 'pre-existing', by: 'qa', issueIid: 9198 },
    { caseId: 'TC-14', verdict: 'missing-steps', by: 'qa' },
  ]);
  assert.equal(settled.get('TC-21')?.issueIid, 9197);
  assert.equal(settled.get('TC-22')?.issueIid, 9198);
  // `missing-steps` asks for more work; it does not settle the case.
  assert.equal(settled.has('TC-14'), false);
});

test('the last decision on a case decides whether it is settled', () => {
  const settled = settledVerifyCases([
    { caseId: 'TC-14', verdict: 'confirmed', by: 'qa' },
    { caseId: 'TC-14', verdict: 'skip', by: 'qa' },
    { caseId: 'TC-15', verdict: 'expected', by: 'qa' },
    { caseId: 'TC-15', verdict: 'confirmed', by: 'qa' },
  ]);
  assert.equal(settled.get('TC-14')?.verdict, 'skip');
  // QA confirming it a real bug afterwards reopened it.
  assert.equal(settled.has('TC-15'), false);
  assert.equal(settledVerifyCases(undefined).size, 0);
});

test('a reused pre-existing verdict names the bug it already has, and opens none', () => {
  const c = { id: 'TC-21', result: 'fail' as const, evidence: 'no rows', screenshot: '' };
  const out = settleVerifyCase(c, { verdict: 'pre-existing', by: 'qa', issueIid: 9197 });
  assert.equal(out.result, 'skipped');
  assert.match(out.evidence, /tracked as #9197\. no rows$/);
  assert.equal(c.result, 'fail', 'the case handed in is not mutated');
  assert.equal(settleVerifyCase(c, { verdict: 'expected', by: 'qa' }).result, 'pass');
  assert.match(settleVerifyCase(c, { verdict: 'invalid', by: 'qa' }).evidence, /^QA \(qa\) marked invalid\./);
});

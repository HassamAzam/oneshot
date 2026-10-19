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

const { lapWindow, verifyGateRoute, verifyRescopeIsScoped } = await import('./runner.js');
const { nextConfirmation, MAX_CONFIRMATIONS, rearmGate } = await import('./reviewgate.js');
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

/**
 * 'skipped' is a settled decision, not an unpaid debt.
 *
 * runner.ts holds both halves of this rule and they disagreed. KEPT_STATUSES
 * keeps a 'skipped' record on re-entry, calling it "a decision the run already
 * made rather than a failure to retry" — while shouldSkip() asked
 * phaseSucceeded(), which reports only 'ok'/'warned'. The loop believed the
 * second one and ran the phase again.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { RUNS } from './config.js';
import { phaseSucceeded, phaseSettled } from './artifacts.js';

/** An iid no ticket will ever have, so a real run's journal is never touched. */
const IID = 99900001;

/** Write a journal holding one record for `recall` with the given status. */
function journalWith(status: string): void {
  const dir = join(RUNS, String(IID));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify({
    runId: 'r-test', iid: IID, title: 't', url: '', createdAt: 0, status: 'running',
    phases: [{ phase: 'recall', lap: 0, status, turns: 20, weighted: 0 }],
  }));
}

afterEach(() => rmSync(join(RUNS, String(IID)), { recursive: true, force: true }));

test("a phase skipped by its own onFail policy is settled, and is not owed another turn", () => {
  // recall is configured `onFail: 'skip'`, maxTurns 20. On ticket 256 it hit that
  // cap, was recorded 'skipped', and the run carried on correctly — then ran it
  // AGAIN at lap 1, after research and plan, the two phases that consume its
  // artifact. It rewrote recall.json with a summary of this run's own plan.
  journalWith('skipped');
  assert.equal(phaseSettled(IID, 'recall'), true);
});

test('but a skipped phase is still NOT a success', () => {
  // The distinction the two functions exist to keep. The plan gate
  // (`implement && phaseSucceeded('plan')`) and the merge check must never read
  // a skipped phase as having produced its artifact.
  journalWith('skipped');
  assert.equal(phaseSucceeded(IID, 'recall'), false);
});

test('a genuine success is both', () => {
  journalWith('ok');
  assert.equal(phaseSucceeded(IID, 'recall'), true);
  assert.equal(phaseSettled(IID, 'recall'), true);
});

test("'warned' is both, as it always was", () => {
  journalWith('warned');
  assert.equal(phaseSucceeded(IID, 'recall'), true);
  assert.equal(phaseSettled(IID, 'recall'), true);
});

test('a real failure is neither, and is still owed a turn', () => {
  // onFail 'abort'/'retry'/'cycle' phases record 'failed' or 'infra'. Those must
  // keep re-running — widening the rule to every terminal status would silently
  // retire phases that genuinely need another lap.
  for (const status of ['failed', 'infra', 'refused', 'parked']) {
    journalWith(status);
    assert.equal(phaseSucceeded(IID, 'recall'), false, status);
    assert.equal(phaseSettled(IID, 'recall'), false, status);
  }
});

test('a phase with no record at all is not settled', () => {
  journalWith('ok');
  assert.equal(phaseSettled(IID, 'research'), false);
});

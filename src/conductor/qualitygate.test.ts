import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { qualityGate } from './codephases.js';
import { writeArtifact } from '../lib/artifacts.js';
import { runDir } from '../lib/config.js';
import type { CodePhaseCtx } from './runner.js';

/**
 * An iid no real ticket will take, so the files these tests write cannot
 * collide with a live run's directory on the machine running them.
 */
const IID = 999_001;

function ctx(prior: CodePhaseCtx['prior']): CodePhaseCtx {
  return { iid: IID, runId: 'r-test', journal: { iid: IID } as CodePhaseCtx['journal'], prior };
}

const CLEAN_VERIFY = { results: [{ id: 'TC-1', result: 'pass' }] };
const CLEAN_REVIEW = { verdict: 'approved', findings: [] };
const FAILING_VERIFY = { results: [{ id: 'TC-1', result: 'fail' }] };
const BLOCKED_REVIEW = {
  verdict: 'changes-requested',
  findings: [{ id: 'F-1', severity: 'blocker' }],
};

function cleanup() {
  rmSync(runDir(IID), { recursive: true, force: true });
}

/**
 * Registered once rather than called at the end of each test: a failing assert
 * throws before a trailing cleanup() runs, and the directory stays in
 * state/runs, where serve.ts, report.ts and journalproject.ts all list it. Each
 * test still starts with its own cleanup(), for whatever a killed run left.
 */
afterEach(cleanup);

test('a failing case on disk refuses the merge when that is all there is', () => {
  cleanup();
  writeArtifact(IID, 'verify.json', FAILING_VERIFY);
  writeArtifact(IID, 'findings.json', CLEAN_REVIEW);
  const gate = qualityGate(ctx({}));
  assert.ok(gate, 'a failing case must refuse the merge');
  assert.match(gate, /TC-1/);
});

test('a blocker finding on disk refuses the merge', () => {
  cleanup();
  writeArtifact(IID, 'verify.json', CLEAN_VERIFY);
  writeArtifact(IID, 'findings.json', BLOCKED_REVIEW);
  const gate = qualityGate(ctx({}));
  assert.ok(gate, 'an unaddressed blocker must refuse the merge');
  assert.match(gate, /F-1/);
});

test('a clean run merges', () => {
  cleanup();
  writeArtifact(IID, 'verify.json', CLEAN_VERIFY);
  writeArtifact(IID, 'findings.json', CLEAN_REVIEW);
  assert.equal(qualityGate(ctx({})), null);
});

/**
 * The property this gate exists for, stated as a test.
 *
 * Every phase after `review` holds `writes: ['run']`, which is the directory
 * these files live in — so the on-disk copy is editable by exactly the phases
 * whose verdict the gate is refusing to take on trust. Reading it instead of
 * the structured output the SDK validated would let a session clear the
 * findings standing in front of its own merge. `prior` wins, and the tampered
 * file loses.
 */
test('the in-memory artifact beats a tampered file on disk', () => {
  cleanup();
  // What a session could leave behind: every case passing, no findings.
  writeArtifact(IID, 'verify.json', CLEAN_VERIFY);
  writeArtifact(IID, 'findings.json', CLEAN_REVIEW);

  const gate = qualityGate(ctx({ verify: FAILING_VERIFY, review: BLOCKED_REVIEW }));
  assert.ok(gate, 'the merge must be refused on what the phases actually returned');
  assert.match(gate, /TC-1/, 'the failing case is named, not the rewritten pass');
});

test('a tampered file cannot turn a failure into a pass, nor the reverse', () => {
  cleanup();
  // The mirror image: disk says it failed, memory says it passed. Memory is
  // still the answer — the point is that disk is not consulted, not that the
  // gate prefers whichever verdict is harsher.
  writeArtifact(IID, 'verify.json', FAILING_VERIFY);
  writeArtifact(IID, 'findings.json', BLOCKED_REVIEW);
  assert.equal(qualityGate(ctx({ verify: CLEAN_VERIFY, review: CLEAN_REVIEW })), null);
});

test('disk is the fallback when prior is empty — a run resumed in a fresh process', () => {
  cleanup();
  writeArtifact(IID, 'verify.json', FAILING_VERIFY);
  writeArtifact(IID, 'findings.json', CLEAN_REVIEW);
  // `prior` carries the OTHER phase only, so verify has to come from disk.
  const gate = qualityGate(ctx({ review: CLEAN_REVIEW }));
  assert.ok(gate, 'a resumed run still refuses a merge its cases did not pass');
  assert.match(gate, /TC-1/);
});

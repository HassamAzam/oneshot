import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { qualityGate, reviewThreadsRefusal } from './codephases.js';
import { writeArtifact } from '../lib/artifacts.js';
import { runDir } from '../lib/config.js';
import { applyBaseCheck, type CodePhaseCtx } from './runner.js';
import type { CaseResult } from '../phases/types.js';

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

// ------------------------------------- a 'pre-existing' case arriving in prior

const caseResult = (id: string, result: CaseResult['result'], evidence = 'fails on dev: views.py:40'): CaseResult =>
  ({ id, result, evidence, screenshot: '' });

/**
 * What the runner holds in prior.verify after a base check: verify's results
 * rewritten by applyBaseCheck(), the same object it writes to verify.json.
 */
const baseChecked = (onBase: 'fails' | 'passes') => ({
  results: applyBaseCheck([caseResult('TC-1', 'pass'), caseResult('TC-15', 'pre-existing')], {
    baseCommit: 'abcdef1234',
    results: [{ id: 'TC-15', onBase, inTicketScope: false, evidence: '500 on save' }],
  }, 'dev').results,
});

test('a pre-existing case the base confirmed reaches the gate through prior and does not block', () => {
  cleanup();
  // Disk disagrees, so a gate that read the file instead would refuse: the
  // verdict has to come from memory, label and all.
  writeArtifact(IID, 'verify.json', { results: [caseResult('TC-15', 'fail')] });
  assert.equal(qualityGate(ctx({ verify: baseChecked('fails'), review: CLEAN_REVIEW })), null);
});

test('a pre-existing label the base did not confirm reaches the gate through prior as a fail', () => {
  cleanup();
  const gate = qualityGate(ctx({ verify: baseChecked('passes'), review: CLEAN_REVIEW }));
  assert.ok(gate, 'a case that passes on the base was broken by this change');
  assert.match(gate, /1 failing case\(s\) of 2: TC-15/);
});

test('a pre-existing label with no evidence in prior refuses the merge', () => {
  cleanup();
  // The label is the phase's claim; without evidence it is the fail it hides,
  // whichever source the gate read it from.
  const verify = { results: [caseResult('TC-1', 'pass'), caseResult('TC-15', 'pre-existing', '  ')] };
  const gate = qualityGate(ctx({ verify, review: CLEAN_REVIEW }));
  assert.ok(gate, 'an unevidenced label must not open the merge');
  assert.match(gate, /TC-15/);
});

test('a confirmed pre-existing case on disk does not block a resumed run either', () => {
  cleanup();
  writeArtifact(IID, 'verify.json', baseChecked('fails'));
  writeArtifact(IID, 'findings.json', CLEAN_REVIEW);
  assert.equal(qualityGate(ctx({})), null);
});

// ----------------------------------------- the review, read from the merge request
// A run reviewed as threads on the MR is judged from those threads as they stand
// on GitLab. findings.json describes the review as it was when it was written, and
// on #9174 a verdict nobody could act on any more is what refused the merge.

const LEDGER = { version: 1, runId: 'r-test', mrIid: 11307, reviewedSha: 'a1', recheckOwed: false, threads: [], pending: [], dropped: [] };

test('a run reviewed as MR threads is not refused by a stale findings.json', () => {
  cleanup();
  writeArtifact(IID, 'verify.json', CLEAN_VERIFY);
  writeArtifact(IID, 'findings.json', BLOCKED_REVIEW);
  writeArtifact(IID, 'review-threads.json', LEDGER);
  assert.equal(qualityGate(ctx({})), null, 'the live threads decide, in mergePhase');
});

test('with the thread loop switched off, findings.json is the gate again even beside a ledger', () => {
  // ONESHOT_REVIEW_THREADS=0 also switches off the live check in mergePhase. A
  // ledger left by an earlier lap must not then excuse the review altogether.
  cleanup();
  writeArtifact(IID, 'verify.json', CLEAN_VERIFY);
  writeArtifact(IID, 'findings.json', BLOCKED_REVIEW);
  writeArtifact(IID, 'review-threads.json', LEDGER);
  const before = process.env.ONESHOT_REVIEW_THREADS;
  process.env.ONESHOT_REVIEW_THREADS = '0';
  try {
    assert.match(qualityGate(ctx({})) ?? '', /F-1 \[blocker\]/);
  } finally {
    if (before === undefined) delete process.env.ONESHOT_REVIEW_THREADS;
    else process.env.ONESHOT_REVIEW_THREADS = before;
  }
});

test('a run the old loop reviewed, with no ledger, is still held to its last review', () => {
  cleanup();
  writeArtifact(IID, 'verify.json', CLEAN_VERIFY);
  writeArtifact(IID, 'findings.json', BLOCKED_REVIEW);
  assert.match(qualityGate(ctx({})) ?? '', /F-1 \[blocker\]/);
});

test('failing verify cases still refuse a thread-reviewed run: the ledger excuses the review, nothing else', () => {
  cleanup();
  writeArtifact(IID, 'verify.json', FAILING_VERIFY);
  writeArtifact(IID, 'review-threads.json', LEDGER);
  assert.match(qualityGate(ctx({})) ?? '', /TC-1/);
});

const open = (finding: string, severity: 'major' | 'minor', file: string | null = 'apps/teams/tests/admin_test.py') =>
  ({ finding, severity, discussionId: `d-${finding}`, noteId: 1, file, line: file ? 611 : null });

test('no open reviewer thread on the merge request: the review does not hold the merge', () => {
  assert.equal(reviewThreadsRefusal({ kind: 'clear' }, 11307, 'https://x/mr/11307'), null);
});

test('an open reviewer thread holds the merge and is named, whatever its severity', () => {
  const r = reviewThreadsRefusal({ kind: 'open', threads: [open('F-05', 'major'), open('F-06', 'minor', null)] }, 11307, 'https://x/mr/11307');
  assert.ok(r);
  assert.match(r.why, /2 code-review thread\(s\) are open on !11307/);
  assert.match(r.why, /F-05 \[major\] apps\/teams\/tests\/admin_test\.py:611, F-06 \[minor\]/);
  assert.match(r.why, /resolve each on the merge request/);
  assert.match(r.why, /https:\/\/x\/mr\/11307$/);
});

test('threads that could not be read hold the merge too: no answer is not "nothing open"', () => {
  const r = reviewThreadsRefusal({ kind: 'unreadable', why: 'fetch failed' }, 11307, '');
  assert.match(r?.why ?? '', /cannot read the review threads on !11307 \(fetch failed\)/);
});

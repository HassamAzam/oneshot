import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { branchHeadSha, qualityGate, reviewRegrade } from './codephases.js';
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

// ------------------------------------------- a verdict that graded another sha

/**
 * erp#8893, as a test.
 *
 * `review` graded the diff at lap 0 and wrote three blockers. `implement`
 * lap 1 fixed all three and moved the branch. Nothing re-runs review and
 * nothing invalidates `findings.json`, so the gate refused over findings the
 * branch no longer carried — and `unblock` could not clear it, because review
 * SUCCEEDED and a succeeded record is never dropped. The run was stuck with no
 * path out but a forced re-run by hand.
 *
 * These tests pin the discriminator that tells that run apart from erp#8800,
 * where the blocking findings were genuinely still open and the refusal was
 * correct. The branch sha is the whole difference.
 */
const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});

/** A one-commit repo on `branch`, plus a second commit on demand. */
function repoAt(branch: string): { dir: string; sha: () => string; commit: () => string } {
  const dir = mkdtempSync(join(tmpdir(), 'gate-sha-'));
  gitIn(dir, 'init', '--quiet', '-b', branch);
  gitIn(dir, 'config', 'user.email', 't@test');
  gitIn(dir, 'config', 'user.name', 'T');
  const commit = (): string => {
    writeFileSync(join(dir, 'f.txt'), String(Math.random()));
    gitIn(dir, 'add', '-A');
    gitIn(dir, 'commit', '--quiet', '-m', 'c');
    return gitIn(dir, 'rev-parse', 'HEAD').trim();
  };
  commit();
  return { dir, sha: () => gitIn(dir, 'rev-parse', 'HEAD').trim(), commit };
}

const BRANCH = 'oneshot/ticket-999001-x';

function shaCtx(prior: CodePhaseCtx['prior'], worktree: string, branch = BRANCH): CodePhaseCtx {
  return {
    iid: IID,
    runId: 'r-test',
    journal: { iid: IID, branch, worktree } as CodePhaseCtx['journal'],
    prior,
  };
}

test('a refusal stamped with a sha the branch has moved past asks for a re-grade', () => {
  cleanup();
  const repo = repoAt(BRANCH);
  try {
    const graded = repo.sha();
    const moved = repo.commit();
    assert.notEqual(graded, moved);
    const c = shaCtx({ verify: CLEAN_VERIFY, review: { ...BLOCKED_REVIEW, gradedSha: graded } }, repo.dir);

    const regrade = reviewRegrade(c);
    assert.ok(regrade, 'a verdict about an older diff must be re-derived, not enforced');
    assert.match(regrade, new RegExp(graded.slice(0, 10)));
    assert.match(regrade, new RegExp(moved.slice(0, 10)));
    // The gate itself is untouched: it still reports the refusal it always did.
    // Only merge's ORDER of the two decides which one wins.
    assert.ok(qualityGate(c), 'the recorded refusal is still on the record');
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test('a refusal stamped with the sha the branch still carries is enforced', () => {
  cleanup();
  const repo = repoAt(BRANCH);
  try {
    const c = shaCtx({ verify: CLEAN_VERIFY, review: { ...BLOCKED_REVIEW, gradedSha: repo.sha() } }, repo.dir);
    assert.equal(reviewRegrade(c), null, 'review graded THIS diff and said no');
    assert.ok(qualityGate(c), 'so the merge is refused');
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

/**
 * erp#8800: the blocking findings were open, the verdict was about the diff in
 * front of it, and no stamp existed yet. Enforced either way — an absent stamp
 * is the pre-upgrade case and counts as covering, the same allowance
 * `approvalCovers()` makes for sign-offs recorded before digests existed.
 */
test('an unstamped verdict is enforced, so runs already in flight are untouched', () => {
  cleanup();
  const repo = repoAt(BRANCH);
  try {
    const c = shaCtx({ verify: CLEAN_VERIFY, review: BLOCKED_REVIEW }, repo.dir);
    assert.equal(reviewRegrade(c), null);
    assert.ok(qualityGate(c));
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test('a failing case is never re-derivable, however stale the review is', () => {
  cleanup();
  const repo = repoAt(BRANCH);
  try {
    const graded = repo.sha();
    repo.commit();
    const c = shaCtx({ verify: FAILING_VERIFY, review: { ...BLOCKED_REVIEW, gradedSha: graded } }, repo.dir);
    assert.equal(reviewRegrade(c), null, 'a stale review must not excuse a case that failed');
    assert.match(qualityGate(c)!, /TC-1/);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test('an approving verdict is never re-graded, moved branch or not', () => {
  cleanup();
  const repo = repoAt(BRANCH);
  try {
    const graded = repo.sha();
    repo.commit();
    const c = shaCtx({ verify: CLEAN_VERIFY, review: { ...CLEAN_REVIEW, gradedSha: graded } }, repo.dir);
    assert.equal(reviewRegrade(c), null, 'there is no refusal to re-derive');
    assert.equal(qualityGate(c), null);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

/**
 * Fail-closed, and this is the direction that matters: a sha git cannot read
 * must never read as "stale". Unknown means the recorded verdict stands.
 */
test('a branch tip git cannot read leaves the refusal in place', () => {
  cleanup();
  const review = { ...BLOCKED_REVIEW, gradedSha: 'deadbeefdeadbeef' };
  assert.equal(reviewRegrade(shaCtx({ verify: CLEAN_VERIFY, review }, '/nonexistent/repo')), null);
  assert.equal(reviewRegrade(shaCtx({ verify: CLEAN_VERIFY, review }, '')), null);
  const repo = repoAt(BRANCH);
  try {
    assert.equal(
      reviewRegrade(shaCtx({ verify: CLEAN_VERIFY, review }, repo.dir, 'no/such/branch')), null,
      'a branch that does not exist is unknown, not moved',
    );
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test('branchHeadSha reads the tip of the named branch, not of HEAD', () => {
  const repo = repoAt(BRANCH);
  try {
    assert.equal(branchHeadSha(BRANCH, repo.dir), repo.sha());
    gitIn(repo.dir, 'checkout', '--quiet', '-b', 'other');
    const onOther = repo.commit();
    assert.equal(branchHeadSha('other', repo.dir), onOther);
    assert.notEqual(branchHeadSha(BRANCH, repo.dir), onOther);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

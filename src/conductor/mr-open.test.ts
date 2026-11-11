/**
 * The MR existing by the time a human is asked to approve anything.
 *
 * The gap this closes was an ordering one, so the tests are about ordering. The
 * test-case gate asks a person to approve scenarios; before `mr-open` the MR was
 * not opened until phase 8, so that person was asked to approve test cases for a
 * change they had no way to read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODE_PHASES, codePhaseStatus } from './runner.js';
import { pushRunBranch } from './codephases.js';

const VAR = 'GITLAB_REPO_URL';

/**
 * `mr-open` belongs to the erp target, so every ordering assertion below has to
 * select that target first, through GITLAB_REPO_URL — under no target the phase is correctly absent, and
 * asserting its position would be asserting the opposite of what it now means.
 * The empty string, never `delete`: config.js runs dotenv at load, which fills
 * in any key that is missing (see target.test.ts).
 */
async function phaseList(target: string): Promise<Array<{ name: string; n: number;
  kind: string; onFail: string; onDemand?: boolean }>> {
  const had = Object.prototype.hasOwnProperty.call(process.env, VAR);
  const before = process.env[VAR];
  process.env[VAR] = target ? `https://gitlab.example.com/acme/${target}` : '';
  try {
    const m = await import(`../lib/config.js?mropen=${encodeURIComponent(target)}-${Date.now()}`);
    return (m.phases as () => Array<{ name: string; n: number; kind: string; onFail: string; onDemand?: boolean }>)();
  } finally {
    if (had) process.env[VAR] = before;
    else delete process.env[VAR];
  }
}

/** Phase numbers under the erp target, where mr-open exists. */
async function nums(): Promise<(name: string) => number> {
  const list = await phaseList('erp');
  return (name: string): number => {
    const p = list.find((x) => x.name === name);
    assert.ok(p, `phase ${name} is missing`);
    return p.n;
  };
}

test('the MR is opened after the code exists and before the test-case gate', async () => {
  const nOf = await nums();
  // The whole point. Either inequality flipping puts a reviewer back in front of
  // a gate with nothing to read, or asks for an MR before there are commits.
  assert.ok(nOf('implement') < nOf('mr-open'), 'mr-open must follow implement');
  assert.ok(nOf('mr-open') < nOf('testcases'), 'mr-open must precede the testcases gate');
});

test('mr-open still precedes every phase that reads the case list', async () => {
  const nOf = await nums();
  // review, verify and ui-evidence all consume testcases.json, so the case list
  // cannot move after the MR — which is why the MR moved instead.
  for (const consumer of ['review', 'verify', 'ui-evidence']) {
    assert.ok(nOf('mr-open') < nOf(consumer), `mr-open must precede ${consumer}`);
    assert.ok(nOf('testcases') < nOf(consumer), `testcases must precede ${consumer}`);
  }
});

test('mr-open is deterministic and non-fatal', async () => {
  const p = (await phaseList('erp')).find((x) => x.name === 'mr-open');
  assert.ok(p);
  // A model is not needed to push a branch and post an MR, and paying for one
  // would add tokens, latency and a way to get it wrong.
  assert.equal(p.kind, 'code');
  // An early MR is a convenience for the humans reading the gates. `mr` still
  // opens one at phase 8, so a failed courtesy push must not kill the run.
  assert.equal(p.onFail, 'warn');
  assert.ok(CODE_PHASES['mr-open'], 'mr-open must be registered as a code phase');
});

test('mr still runs, and last, so the draft is finished and undrafted', async () => {
  const nOf = await nums();
  // mr-open deliberately does NOT replace mr: it writes a placeholder body and
  // a Draft title, and mr owns the real description and taking the marker off.
  assert.ok(nOf('mr-open') < nOf('mr'));
  assert.ok(nOf('mr') < nOf('merge'), 'merge must not run before the draft is lifted');
});

test('every phase in the ordering is either implemented or a code phase', async () => {
  // A phase present in config but wired to nothing is a silent no-op in the
  // sequence, which is exactly how mr-open could rot. An on-demand code phase
  // is not in the sequence: the mode that owns it runs it by name
  // (local-tests-run, src/localtests), and the Loop steps over it.
  const codes = new Set(Object.keys(CODE_PHASES));
  for (const p of (await phaseList('erp')).filter((x) => x.kind === 'code' && !x.onDemand)) {
    assert.ok(codes.has(p.name), `code phase ${p.name} has no CODE_PHASES entry`);
  }
});

test('the Loop registers no local-tests code phase', async () => {
  // local-tests-run left the pre-merge pipeline: the post-merge mode runs it,
  // so a Loop pass must never reach it through this registry.
  assert.equal(CODE_PHASES['local-tests-run'], undefined);
  assert.deepEqual(Object.keys(CODE_PHASES).sort(), ['merge', 'mr-open']);
  const lt = (await phaseList('erp')).find((x) => x.name === 'local-tests-run');
  assert.equal(lt?.onDemand, true);
});

test('the default pipeline does not carry mr-open at all', async () => {
  // The other half of every assertion above. mr-open changes the shape of the
  // pipeline, and that change was asked for on one target — so under no target
  // it must be absent, not merely harmless.
  const names = (await phaseList('')).map((x) => x.name);
  assert.ok(!names.includes('mr-open'));
});

// ------------------------------------------------- pushing after a rebase

const BRANCH = 'oneshot/ticket-9072-x';

/**
 * A bare origin, the run's worktree on its leased branch (pushed once), and a
 * second clone standing in for anyone else who can push to that branch.
 */
function withBranch(fn: (r: {
  wt: string; other: string; git: (...a: string[]) => string; tip: (ref: string) => string;
}) => void): void {
  const base = mkdtempSync(join(tmpdir(), 'oneshot-push-'));
  const git = (...args: string[]): string => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const origin = join(base, 'origin.git');
  const wt = join(base, 'wt');
  const other = join(base, 'other');
  git('init', '-q', '--bare', origin);
  git('clone', '-q', origin, wt);
  git('-C', wt, 'commit', '-q', '--allow-empty', '-m', 'base');
  git('-C', wt, 'push', '-q', 'origin', 'HEAD:refs/heads/dev');
  git('-C', wt, 'checkout', '-q', '-b', BRANCH);
  git('-C', wt, 'commit', '-q', '--allow-empty', '-m', 'the change');
  git('-C', wt, 'push', '-q', '-u', 'origin', BRANCH);
  git('clone', '-q', '-b', BRANCH, origin, other);
  const tip = (ref: string): string => git('-C', origin, 'rev-parse', ref);
  try { fn({ wt, other, git, tip }); } finally { rmSync(base, { recursive: true, force: true }); }
}

/** What `implement` did on #9072: rewrite the branch's own commits onto a newer dev. */
function rebaseOntoNewerDev(wt: string, git: (...a: string[]) => string): void {
  git('-C', wt, 'checkout', '-q', 'dev');
  git('-C', wt, 'commit', '-q', '--allow-empty', '-m', 'dev moved on');
  git('-C', wt, 'push', '-q', 'origin', 'dev');
  git('-C', wt, 'checkout', '-q', BRANCH);
  git('-C', wt, 'rebase', '-q', '--keep-empty', 'dev');
}

test('an ordinary push is not forced', () => {
  withBranch(({ wt, git, tip }) => {
    git('-C', wt, 'commit', '-q', '--allow-empty', '-m', 'a fix');
    assert.deepEqual(pushRunBranch(wt, BRANCH, { allowForce: true }), { ok: true, forced: false });
    assert.equal(tip(BRANCH), git('-C', wt, 'rev-parse', 'HEAD'));
  });
});

test('a branch rebased over its own history is force-pushed, so the MR shows the new commits', () => {
  withBranch(({ wt, git, tip }) => {
    rebaseOntoNewerDev(wt, git);
    // The plain push alone is refused — the push #9072's mr-open recorded as a mere warning.
    assert.notEqual(spawnSync('git', ['-C', wt, 'push', 'origin', BRANCH]).status, 0);
    assert.deepEqual(pushRunBranch(wt, BRANCH, { allowForce: true }), { ok: true, forced: true });
    assert.equal(tip(BRANCH), git('-C', wt, 'rev-parse', 'HEAD'));
  });
});

test('a commit someone else pushed is never overwritten — the run blocks instead', () => {
  withBranch(({ wt, other, git, tip }) => {
    git('-C', other, 'commit', '-q', '--allow-empty', '-m', 'a reviewer\'s fix');
    git('-C', other, 'push', '-q', 'origin', BRANCH);
    const theirs = tip(BRANCH);
    rebaseOntoNewerDev(wt, git);
    const out = pushRunBranch(wt, BRANCH, { allowForce: true });
    assert.equal(out.ok, false);
    assert.equal(!out.ok && out.block, true, 'a remote the run cannot account for must block, not warn');
    assert.match(!out.ok ? out.error : '', /never pointed at/);
    assert.equal(tip(BRANCH), theirs, 'their commit is still the tip');
  });
});

test('a push that fails for any other reason stays a warning, as before', () => {
  withBranch(({ wt, git }) => {
    git('-C', wt, 'remote', 'set-url', 'origin', join(wt, 'no-such-remote.git'));
    const out = pushRunBranch(wt, BRANCH, { allowForce: true });
    assert.equal(out.ok, false);
    assert.equal(!out.ok && out.block, false);
    // The reason, not just "Command failed: git -C … push …" cut off at 200 characters.
    assert.match(!out.ok ? out.error : '', /no-such-remote/);
  });
});

test('a dry run says what it would force and rewrites nothing', () => {
  withBranch(({ wt, git, tip }) => {
    const before = tip(BRANCH);
    rebaseOntoNewerDev(wt, git);
    const out = pushRunBranch(wt, BRANCH, { allowForce: false });
    assert.equal(out.ok, false);
    assert.equal(!out.ok && out.block, false);
    assert.equal(tip(BRANCH), before);
  });
});

test('a blocked code phase is recorded as failed, not warned, whatever its onFail', () => {
  const mrOpen = { name: 'mr-open', onFail: 'warn' } as Parameters<typeof codePhaseStatus>[0];
  assert.equal(codePhaseStatus(mrOpen, { ok: false }), 'warned');
  assert.equal(codePhaseStatus(mrOpen, { ok: false, block: true }), 'failed');
});

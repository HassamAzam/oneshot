import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '../../lib/test-project-env.js';
import type { PhaseConfig } from '../../lib/config.js';
import type { GitlabResult, Issue, IssueNote } from '../../lib/gitlab.js';
import type { PhaseInput, PhaseOutput } from '../../conductor/phase.js';
import { isMachineNote } from '../../lib/claims.js';
import { readDiagnosisFile, updateDiagnosisFile } from '../record.js';
import { makeRun } from '../test-fixtures.js';
import type { CheckedFinding, DiagnosisFile } from '../types.js';
import { FIX_AUTHOR, FIX_REVIEW, FIX_VERIFY, fixFromDiagnosis, readiness, type ExecResult, type FixDeps } from './pipeline.js';
import { fixPrMarker } from './prbody.js';

const IID = 990174;
const BRANCH = 'fix/diagnosed-990174-k1-d-3';
const PR_URL = 'https://github.com/acme/oneshot/pull/231';
const GITHUB = 'https://github.com/acme/oneshot.git';
const BODY = join('diagnosis', 'fix', 'k1', 'D-3', 'pr-body.md');

const finding = (over: Partial<CheckedFinding> = {}): CheckedFinding => ({
  id: 'D-3', title: 'The CLI exit replaced the recorded outcome', category: 'harness', phases: 'verify laps 0-5',
  recorded: 'Claude Code process exited with code 1', cause: 'the exit text overwrote the settled result',
  evidence: [{ file: 'repo:src/conductor/phase.ts', line: 762, quote: 'out.error = m;', ok: true, note: '' }],
  solution: 'keep the settled result', where: ['src/conductor/phase.ts'], fix: 'pr', confidence: 'confirmed', evidenced: true, ...over,
});

const okOut = (data: Record<string, unknown>): PhaseOutput => ({
  ok: true, data, blocked: null, summary: '', turns: 10, weighted: 1000, sessionId: 's', rateLimited: false,
});
const AUTHOR = {
  summary: 's', outcome: 'fixed', refusal: '', reproduced: true, title: 'fix(phase): keep a settled result when the CLI exits after it',
  prSummary: 'Keeps the settled result.', prWhy: 'The catch branch overwrote it.', prTests: 'One test pins it.',
  testFiles: ['src/conductor/phase-crash.test.ts'], commits: ['abc1234'], addressed: [],
};
const blocker = (what: string) => ({ severity: 'blocker', file: 'src/conductor/phase.ts', line: 762, what, why: 'because', fix: 'do it' });
const REVIEW_CLEAN = { summary: 's', verdict: 'approve', verified: 'ran the suite', findings: [] };
const SHIP = { summary: 's', rulings: [], additional: [], fixesTheCause: true, verdict: 'ship', reason: 'confirmed' };
const TAP = (pass: number, fail: number): ExecResult => ({ code: fail ? 1 : 0, out: `# tests ${pass + fail}\n# pass ${pass}\n# fail ${fail}\n` });

const ok = <T>(data: T): GitlabResult<T> => ({ ok: true, kind: 'ok', status: 200, data });
const issue = (assignees: string[] = []): Issue => ({
  iid: IID, title: 't', description: null, labels: [], assignees: assignees.map((username) => ({ username })), state: 'opened', web_url: '', updated_at: '',
});
/** A pull request this pipeline opened for stop `key`'s finding `id`, as `gh pr list` returns it. */
const listed = (o: { number: number; state: string; key?: string; id?: string; fork?: boolean; body?: string }): string => JSON.stringify([{
  number: o.number, url: `https://github.com/acme/oneshot/pull/${o.number}`, state: o.state, isCrossRepository: o.fork === true,
  body: o.body ?? `text\n\n${fixPrMarker(IID, o.key ?? 'k1', o.id ?? 'D-3')}`,
}]);

interface Script {
  remote: string;
  ghAuth: number;
  prList: ExecResult;
  /** What `git ls-remote --heads <github> <branch>` prints, by how many times it has been asked. */
  lsRemote: (n: number) => string;
  /** Whether the operator's clone already had a branch of the fix's name. */
  hadLocal: boolean;
  files: string[];
  shortstat: string;
  dirty: string;
  /** `git rev-parse HEAD` in the fix checkout, by how many times it has been asked. */
  head: (n: number) => string;
  /** The commits' own text, read back before anything is published. */
  messages: string;
  patch: string;
  tsc: ExecResult;
  suite: (n: number) => ExecResult;
  /** The changed tests on the base without the fix: must FAIL to count as a reproduction. */
  red: (n: number) => ExecResult;
  push: ExecResult;
  prCreate: ExecResult;
  author: (round: number, input: PhaseInput) => PhaseOutput;
  review: (lens: 'A' | 'B') => PhaseOutput;
  verify: (round: number, input: PhaseInput) => PhaseOutput;
  hold: string | null;
  paused: boolean;
  issue: Issue;
  notes: IssueNote[];
  dryRun: boolean;
}

function world(findings: CheckedFinding[] = [finding()], over: Partial<Script> = {}) {
  const run = makeRun({ iid: IID, records: [{ phase: 'verify', status: 'failed', error: 'x' }] });
  const repo = mkdtempSync(join(tmpdir(), 'oneshot-fixrepo-'));
  const wtRoot = mkdtempSync(join(tmpdir(), 'oneshot-fixwt-'));
  mkdirSync(join(repo, '.git'));
  mkdirSync(join(repo, 'node_modules'));
  writeFileSync(join(repo, 'package-lock.json'), 'LOCK');
  const file: DiagnosisFile = {
    version: 1, iid: IID, runId: 'r-test0001-abcdef', latest: 'k1', sessions: 1,
    stops: { k1: { key: 'k1', runId: 'r-test0001-abcdef', iid: IID, status: 'blocked', stoppedPhase: 'merge', reason: 'r', trouble: [], state: 'diagnosed', attempts: 1, lastAttemptAt: 1, diagnosedAt: 2, findings } },
  };
  writeFileSync(join(run.dir, 'diagnosis.json'), JSON.stringify(file));

  const s: Script = {
    remote: GITHUB, ghAuth: 0, prList: { code: 0, out: '[]' }, lsRemote: () => '', hadLocal: false,
    files: ['src/conductor/phase.ts', 'src/conductor/phase-crash.test.ts'], shortstat: ' 2 files changed, 40 insertions(+), 3 deletions(-)', dirty: '',
    head: () => 'c0ffee1', messages: 'fix(phase): keep a settled result\n\nThe catch branch overwrote it.\n', patch: '+++ b/src/conductor/phase.ts\n+  if (settled) return;\n',
    tsc: { code: 0, out: '' }, suite: () => TAP(1421, 0), red: () => TAP(0, 2),
    push: { code: 0, out: '' }, prCreate: { code: 0, out: `${PR_URL}\n` },
    author: () => okOut(AUTHOR), review: () => okOut(REVIEW_CLEAN), verify: () => okOut(SHIP),
    hold: null, paused: false, issue: issue(), notes: [], dryRun: false, ...over,
  };
  const calls: string[] = [];
  const sessions: PhaseInput[] = [];
  const posted: string[] = [];
  const counts = { author: 0, verify: 0, suite: 0, red: 0, lsRemote: 0, head: 0 };
  /** The fix checkout's exclude file, as each session found it. */
  const excludes: string[] = [];

  const exec: FixDeps['exec'] = async (cmd, args, o) => {
    const line = `${cmd} ${args.join(' ')}`;
    calls.push(line);
    const has = (...parts: string[]): boolean => parts.every((p) => line.includes(p));
    if (cmd === 'git' && has('remote get-url')) return { code: 0, out: s.remote };
    if (cmd === 'gh' && has('auth status')) return { code: s.ghAuth, out: '' };
    if (cmd === 'gh' && has('pr list')) return s.prList;
    if (cmd === 'gh' && has('pr create')) return s.prCreate;
    if (cmd === 'git' && has('ls-remote')) { counts.lsRemote += 1; return { code: 0, out: s.lsRemote(counts.lsRemote - 1) }; }
    if (cmd === 'git' && has('rev-parse --verify --quiet refs/heads/')) return { code: s.hadLocal ? 0 : 1, out: '' };
    if (cmd === 'git' && args.includes('init')) {
      const path = args[args.length - 1]!;
      mkdirSync(join(path, '.git', 'info'), { recursive: true });
      return { code: 0, out: '' };
    }
    if (cmd === 'git' && has('rev-parse --verify refs/remotes/origin/main')) return { code: 0, out: 'ba5e000\n' };
    if (cmd === 'git' && has('rev-parse HEAD')) { counts.head += 1; return { code: 0, out: `${s.head(counts.head - 1)}\n` }; }
    if (cmd === 'git' && has('worktree add')) {
      const path = args.find((a) => a.startsWith(wtRoot));
      if (path) mkdirSync(path, { recursive: true });
      return { code: 0, out: '' };
    }
    if (cmd === 'git' && has('show', 'package-lock.json')) return { code: 0, out: 'LOCK' };
    if (cmd === 'git' && has('show HEAD:')) return { code: 0, out: '// a test' };
    if (cmd === 'git' && has('diff', '--name-only')) return { code: 0, out: s.files.join('\n') };
    if (cmd === 'git' && has('diff', '--shortstat')) return { code: 0, out: s.shortstat };
    if (cmd === 'git' && has('diff', '--unified=0')) return { code: 0, out: s.patch };
    if (cmd === 'git' && has('log --format=%B')) return { code: 0, out: s.messages };
    if (cmd === 'git' && has('status --porcelain')) return { code: 0, out: s.dirty };
    if (cmd === 'git' && has('push')) return s.push;
    if (cmd === 'node' && has('typescript/bin/tsc')) return s.tsc;
    if (cmd === 'find') return { code: 0, out: 'src/a.test.ts\nsrc/conductor/phase-crash.test.ts\n' };
    if (cmd === 'node' && has('--test')) {
      if (o.cwd.endsWith('-base')) { counts.red += 1; return s.red(counts.red - 1); }
      counts.suite += 1;
      return s.suite(counts.suite - 1);
    }
    return { code: 0, out: '' };
  };

  const phase = (name: string): PhaseConfig | undefined => ({
    name, n: 16, kind: 'session', tier: 'heavy', cwd: 'worktree', maxTurns: 50, timeoutMin: 20,
    writes: name === FIX_AUTHOR ? ['worktree'] : [], onFail: 'warn', onDemand: true,
  });

  const deps: Partial<FixDeps> = {
    now: () => 1_800_000_000_000,
    get dryRun() { return s.dryRun; },
    me: () => 'oneshot-bot',
    repo, base: 'main', worktreeRoot: wtRoot, project: 'erp',
    exec, phase,
    session: async (input) => {
      sessions.push(input);
      try { excludes.push(readFileSync(join(input.worktree ?? '', '.git', 'info', 'exclude'), 'utf8')); } catch { excludes.push(''); }
      if (input.cfg.name === FIX_AUTHOR) { counts.author += 1; return s.author(counts.author - 1, input); }
      if (input.cfg.name === FIX_REVIEW) return s.review(input.lap % 10 === 0 ? 'A' : 'B');
      counts.verify += 1;
      return s.verify(counts.verify - 1, input);
    },
    sessionHold: () => s.hold,
    paused: () => s.paused,
    privateText: () => [
      { what: 'the work project\'s host', text: 'gitlab.internal.example' },
      { what: 'the ticket\'s title', text: 'Show the total on the invoice list' },
    ],
    attempt: { start: () => 1, end: () => undefined },
    gitlab: {
      getIssue: async () => ok(s.issue),
      notes: async () => ok(s.notes),
      addNote: async (_iid, body) => { posted.push(body); return ok({ id: 900 }); },
    },
    event: () => undefined,
  };

  return {
    deps, calls, sessions, posted, counts, excludes, dir: run.dir, wtRoot, repo, script: s,
    // As the conductor calls it on a desk that posts. By hand, `post` is off unless asked.
    go: (o: { only?: string; force?: boolean; post?: boolean; signal?: AbortSignal } = {}) => fixFromDiagnosis({ iid: IID, dir: run.dir, post: true, ...o }, deps),
    fix: (id = 'D-3') => readDiagnosisFile(run.dir)!.stops.k1!.fixes?.[id],
    names: () => sessions.map((x) => x.cfg.name),
    ran: (needle: string) => calls.filter((c) => c.includes(needle)),
    cleanup: () => { run.cleanup(); rmSync(repo, { recursive: true, force: true }); rmSync(wtRoot, { recursive: true, force: true }); },
  };
}

test('a checkout whose origin is not GitHub, or a machine with no GitHub sign-in, cannot open a fix and no session is paid for', async () => {
  for (const [over, expected] of [
    [{ remote: '/srv/oneshot.bundle' }, /origin of .* is not a GitHub repository.*ONESHOT_FIX_REPO/],
    [{ ghAuth: 1 }, /no GitHub credentials \(`gh auth status` failed\)/],
  ] as const) {
    const w = world([finding()], over);
    try {
      const lines = await w.go();
      assert.equal(w.fix()?.state, 'unavailable');
      assert.match(w.fix()?.why ?? '', expected);
      assert.match(lines[0]!, /no pull request \(unavailable\)/);
      assert.equal(w.sessions.length, 0);
      assert.equal(w.ran(' init ').length, 0);
    } finally { w.cleanup(); }
  }
});

test('readiness names the GitHub repository it would open against, and the address it would push to', async () => {
  const w = world();
  try {
    assert.deepEqual(await readiness(w.deps as FixDeps), { ok: true, slug: 'acme/oneshot', pushUrl: GITHUB });
  } finally { w.cleanup(); }
});

test('the whole path: author, two reviewers, verifier, then code pushes one commit and opens one pull request', async () => {
  const w = world();
  try {
    const lines = await w.go();
    assert.deepEqual(lines, [`D-3 pull request opened: ${PR_URL}`]);
    assert.deepEqual(w.names(), [FIX_AUTHOR, FIX_REVIEW, FIX_REVIEW, FIX_VERIFY], 'four agents');
    assert.ok(w.sessions.every((s) => s.gitlabMcp === false && s.limitFromProse === false && s.branch === BRANCH && s.worktree?.startsWith(w.wtRoot)));
    assert.notEqual(w.sessions[1]!.lap, w.sessions[2]!.lap, 'the two reviewers write separate transcripts');

    const fix = w.fix()!;
    assert.deepEqual({ state: fix.state, prUrl: fix.prUrl, prNumber: fix.prNumber, branch: fix.branch }, { state: 'opened', prUrl: PR_URL, prNumber: 231, branch: BRANCH });
    assert.deepEqual(fix.checks, { typecheck: 'clean', tests: '1421 pass, 0 fail', hooks: '', redGreen: '1 changed test file(s) on origin/main without the fix: 2 failing, 0 passing' });
    assert.deepEqual(fix.review, { raised: 0, upheld: 0, refuted: 0, fixed: 0, rounds: 0 });

    // The commit the checks ran on, by its id, to GitHub by address.
    assert.deepEqual(w.ran('git push'), [`git push ${GITHUB} c0ffee1:refs/heads/${BRANCH}`]);
    const create = w.ran('pr create')[0]!;
    assert.ok(create.includes('--repo acme/oneshot --base main') && create.includes(`--head ${BRANCH}`));
    assert.ok(create.includes('--title Keep a Settled Result When the CLI Exits After It'), 'the title follows the repository\'s rule: plain words, no commit prefix');
    assert.equal(w.ran('pr merge').length, 0, 'nothing here can merge');
    assert.equal(w.ran('auto').length, 0, 'or turn auto-merge on');
    assert.equal(w.ran('--force-with-lease').length + w.ran('push --force').length + w.ran('--delete').length, 0);

    const body = readFileSync(join(w.dir, BODY), 'utf8');
    assert.match(body, /Found by Oneshot's failure diagnosis of erp#990174 \(finding D-3\)/);
    assert.match(body, /2 failing, 0 passing/);
    assert.ok(body.trimEnd().endsWith(fixPrMarker(IID, 'k1', 'D-3')));

    assert.equal(w.posted.length, 1, 'the link is posted on the ticket');
    assert.match(w.posted[0]!, new RegExp(`\\*\\*Fix opened for D-3\\*\\* — ${PR_URL.replace(/[/.]/g, '\\$&')}`));
    assert.equal(isMachineNote(w.posted[0]!), true);
    assert.equal(fix.note?.id, 900);
    assert.deepEqual(readdirSync(w.wtRoot), [], 'both checkouts are gone');
    assert.equal(w.ran(`update-ref -d refs/heads/${BRANCH}`).length, 1, 'and so is anything a session pushed into the operator\'s clone');
  } finally { w.cleanup(); }
});

test('the fix is written in a private repository that holds the base branch and nothing else of the operator\'s', async () => {
  const w = world();
  try {
    await w.go();
    const path = join(w.wtRoot, BRANCH.replace(/\//g, '-'));
    // Not a worktree (it shares the operator's remotes) and not a clone (it brings every branch they have).
    assert.equal(w.ran(' clone ').length, 0);
    assert.equal(w.ran('worktree add').filter((c) => !c.includes('-base')).length, 0);
    assert.ok(w.ran(' init ')[0]!.endsWith(path));
    // `origin` there is a directory on this disk, and one ref is taken from it.
    assert.deepEqual(w.ran('remote add'), [`git remote add origin ${w.repo}`]);
    assert.deepEqual(w.ran('git fetch --quiet --no-tags'), ['git fetch --quiet --no-tags origin +refs/remotes/origin/main:refs/remotes/origin/main']);
    assert.ok(w.ran('checkout').some((c) => c.includes(`--no-track -B ${BRANCH} ba5e000`)), 'on a branch that tracks nothing');
    // The link to node_modules is the pipeline's own, kept out of `git status` and `git add -A`.
    assert.ok(w.excludes.every((e) => /^\/node_modules$/m.test(e)), 'excluded before the first session starts');
    // Everything measured is against the commit GitHub's base was at, by id, and is the commit, not the directory.
    assert.ok(w.ran('diff --no-renames --name-only').every((c) => c.includes('ba5e000...HEAD')));
    assert.equal(w.ran('clean --quiet -fdx -e /node_modules').length, 1, 'ignored files are cleared before the checks run');
  } finally { w.cleanup(); }
});

test('a merge commit in the change is refused: the checkout held the base and the author\'s own commits, nothing else', async () => {
  const w = world();
  const exec = w.deps.exec!;
  w.deps.exec = async (cmd, args, o) => (cmd === 'git' && args.includes('--merges') ? { code: 0, out: 'abc1234\n' } : exec(cmd, args, o));
  try {
    await w.go();
    assert.equal(w.fix()?.state, 'refused');
    assert.match(w.fix()?.why ?? '', /contains a merge commit/);
    assert.equal(w.ran('git push').length, 0);
  } finally { w.cleanup(); }
});

test('the reviewers and the verifier are told what the pipeline measured, and the reviewers are not told what the author said', async () => {
  const w = world();
  try {
    await w.go();
    const [author, reviewA, reviewB, verify] = w.sessions;
    assert.match(author!.prompt, /Reproduce it first/);
    assert.match(author!.prompt, /never push: this checkout is a private clone/);
    for (const r of [reviewA!, reviewB!, verify!]) {
      assert.match(r.prompt, /What the pipeline already measured on these commits/);
      assert.match(r.prompt, /reproduction, the changed tests run on origin\/main WITHOUT the fix: 1 changed test file\(s\).*2 failing/);
    }
    assert.match(reviewA!.prompt, /yours is the \*\*correctness\*\* review/);
    assert.match(reviewB!.prompt, /yours is the \*\*tests and scope\*\* review/);
    assert.doesNotMatch(reviewA!.prompt, /Keeps the settled result\./, "the author's own account is withheld");
  } finally { w.cleanup(); }
});

test('a reviewer\'s blocker the verifier refutes costs the author nothing, and the pull request says so', async () => {
  const w = world([finding()], {
    review: (lens) => okOut(lens === 'A' ? { ...REVIEW_CLEAN, verdict: 'request-changes', findings: [blocker('a timeout is misread as a crash')] } : REVIEW_CLEAN),
    verify: () => okOut({ ...SHIP, rulings: [{ id: 'A-1', holds: false, reason: 'ran the timeout path: the timer branch is taken first' }] }),
  });
  try {
    await w.go();
    assert.equal(w.counts.author, 1, 'no fix round');
    assert.deepEqual(w.fix()?.review, { raised: 1, upheld: 0, refuted: 1, fixed: 0, rounds: 0 });
    assert.match(w.sessions[3]!.prompt, /\*\*A-1\*\*.*a timeout is misread as a crash/);
    const body = readFileSync(join(w.dir, BODY), 'utf8');
    assert.match(body, /\| A-1 \| blocker \| a timeout is misread as a crash .* \| refuted: ran the timeout path/);
  } finally { w.cleanup(); }
});

test('an upheld blocker sends the author back with it, and it is fixed only when a verifier says so', async () => {
  const w = world([finding()], {
    review: (lens) => okOut(lens === 'A' ? { ...REVIEW_CLEAN, findings: [blocker('the infra flag is lost'), blocker('never happens')] } : REVIEW_CLEAN),
    verify: (round) => okOut(round === 0
      ? { ...SHIP, verdict: 'fix-first', rulings: [{ id: 'A-1', holds: true, reason: 'reproduced' }, { id: 'A-2', holds: false, reason: 'cannot occur' }] }
      : { ...SHIP, rulings: [{ id: 'A-1', holds: false, reason: 'ran it again: the flag is kept now' }] }),
  });
  try {
    await w.go();
    assert.deepEqual(w.names(), [FIX_AUTHOR, FIX_REVIEW, FIX_REVIEW, FIX_VERIFY, FIX_AUTHOR, FIX_VERIFY], 'the reviewers are not paid for twice');
    const second = w.sessions[4]!;
    assert.match(second.prompt, /This is fix round 1/);
    assert.match(second.prompt, /\*\*A-1\*\*.*the infra flag is lost/);
    assert.doesNotMatch(second.prompt, /never happens/, 'a refuted point is not sent back');
    assert.match(w.sessions[5]!.prompt, /\*\*A-1\*\*/);
    assert.match(w.sessions[5]!.prompt, /The blockers below STOOD after an earlier round/);
    assert.doesNotMatch(w.sessions[5]!.prompt, /\*\*A-2\*\*/);
    assert.equal(w.fix()?.state, 'opened');
    // Upheld and then fixed: not "refuted", which would say the reviewer was wrong.
    assert.deepEqual(w.fix()?.review, { raised: 2, upheld: 1, refuted: 1, fixed: 1, rounds: 1 });
    assert.match(readFileSync(join(w.dir, BODY), 'utf8'), /\| A-1 \| blocker \| the infra flag is lost .* \| upheld, then fixed in this branch and checked again \|/);
  } finally { w.cleanup(); }
});

test('the reviewers\' blockers reach the verifier whichever round the review first runs on', async () => {
  // Round 0 is lost to a check, so the reviewers first run on round 1. Their
  // blockers used to be filtered against the previous round's (check-only)
  // list: the verifier was told "none were raised" and the pull request opened.
  const w = world([finding()], {
    red: (n) => (n === 0 ? TAP(2, 0) : TAP(0, 2)),
    review: (lens) => okOut(lens === 'A' ? { ...REVIEW_CLEAN, findings: [blocker('the infra flag is lost')] } : { ...REVIEW_CLEAN, findings: [blocker('the commit message names an internal host')] }),
    // A verifier that rules on nothing: silence upholds.
    verify: () => okOut(SHIP),
  });
  try {
    await w.go();
    const firstVerify = w.sessions.find((s) => s.cfg.name === FIX_VERIFY)!;
    assert.match(firstVerify.prompt, /\*\*A-1\*\*.*the infra flag is lost/);
    assert.match(firstVerify.prompt, /\*\*B-1\*\*.*names an internal host/);
    assert.equal(w.fix()?.state, 'refused', 'two blockers nobody refuted do not open a pull request');
    assert.match(w.fix()?.why ?? '', /still blocked after 2 fix round\(s\): the infra flag is lost; the commit message names an internal host/);
    assert.equal(w.ran('git push').length, 0);
  } finally { w.cleanup(); }
});

test('a blocker the verifier raised itself is ruled on again after the author\'s lap, not taken as fixed', async () => {
  const mine = { severity: 'blocker', file: 'src/conductor/phase.ts', line: 700, what: 'the timer branch drops the settled result', why: 'ran it', fix: '' };
  const unfixed = world([finding()], {
    verify: (round, input) => {
      if (round === 0) return okOut({ ...SHIP, verdict: 'fix-first', additional: [mine] });
      // The author returned "fixed" having changed nothing. The verifier is asked about V0-1 and does not clear it.
      assert.match(input.prompt, /\*\*V0-1\*\*.*the timer branch drops the settled result/);
      return okOut(SHIP);
    },
  });
  try {
    await unfixed.go();
    assert.equal(unfixed.fix()?.state, 'refused');
    assert.match(unfixed.fix()?.why ?? '', /still blocked after 2 fix round\(s\): the timer branch drops the settled result/);
  } finally { unfixed.cleanup(); }

  const fixed = world([finding()], {
    verify: (round) => okOut(round === 0 ? { ...SHIP, verdict: 'fix-first', additional: [mine] } : { ...SHIP, rulings: [{ id: 'V0-1', holds: false, reason: 'ran the timer path: kept now' }] }),
  });
  try {
    await fixed.go();
    assert.equal(fixed.fix()?.state, 'opened');
    assert.deepEqual(fixed.fix()?.review, { raised: 1, upheld: 1, refuted: 0, fixed: 1, rounds: 1 });
    assert.match(readFileSync(join(fixed.dir, BODY), 'utf8'), /\| V0-1 \| blocker \| the timer branch drops the settled result .* \| upheld, then fixed in this branch and checked again \|/);
  } finally { fixed.cleanup(); }
});

test('a blocker that stood is still standing after a round whose checks failed, and is put to the verifier again', async () => {
  const w = world([finding()], {
    review: (lens) => okOut(lens === 'A' ? { ...REVIEW_CLEAN, findings: [blocker('the infra flag is lost')] } : REVIEW_CLEAN),
    // Round 1 breaks the suite, so no verifier runs on it.
    suite: (n) => (n === 1 ? TAP(1419, 2) : TAP(1421, 0)),
    verify: (round, input) => {
      if (round === 0) return okOut({ ...SHIP, verdict: 'fix-first', rulings: [{ id: 'A-1', holds: true, reason: 'reproduced' }] });
      assert.match(input.prompt, /\*\*A-1\*\*.*the infra flag is lost/, 'not "none are standing"');
      return okOut({ ...SHIP, rulings: [{ id: 'A-1', holds: false, reason: 'ran it: kept now' }] });
    },
  });
  try {
    await w.go();
    assert.deepEqual(w.names(), [FIX_AUTHOR, FIX_REVIEW, FIX_REVIEW, FIX_VERIFY, FIX_AUTHOR, FIX_AUTHOR, FIX_VERIFY]);
    const third = w.sessions[5]!;
    assert.match(third.prompt, /the test suite fails/);
    assert.match(third.prompt, /\*\*A-1\*\*.*the infra flag is lost/, 'the author is still held to it');
    assert.equal(w.fix()?.state, 'opened');
    assert.deepEqual(w.fix()?.review, { raised: 1, upheld: 1, refuted: 0, fixed: 1, rounds: 2 });
  } finally { w.cleanup(); }
});

test('tests that pass on the base without the fix are not a reproduction: no review is paid for until they fail there', async () => {
  const w = world([finding()], { red: (n) => (n === 0 ? TAP(2, 0) : TAP(0, 2)) });
  try {
    await w.go();
    assert.deepEqual(w.names(), [FIX_AUTHOR, FIX_AUTHOR, FIX_REVIEW, FIX_REVIEW, FIX_VERIFY]);
    assert.match(w.sessions[1]!.prompt, /do not fail on the base branch without the fix, so they do not show the defect/);
    assert.equal(w.fix()?.state, 'opened');
  } finally { w.cleanup(); }
});

test('a run on the base that says nothing, or fails only in what a test printed, is not a reproduction either', async () => {
  // No summary: a timeout and a missing runner both look like this.
  const silent = world([finding()], { red: () => ({ code: 1, out: 'Error: Cannot find module tsx\n' }) });
  try {
    await silent.go();
    assert.match(silent.sessions[1]!.prompt, /the run printed no summary, so it shows nothing \(Error: Cannot find module tsx\)/);
  } finally { silent.cleanup(); }
  // A test that passes and prints "# fail 1": the runner's own summary is the last one, and the run exited 0.
  const printed = world([finding()], { red: () => ({ code: 0, out: '# fail 1\nok 1 - prints it\n# tests 1\n# pass 1\n# fail 0\n' }) });
  try {
    await printed.go();
    assert.match(printed.sessions[1]!.prompt, /they PASS \(1 passing, 0 failing, exit 0\)/);
  } finally { printed.cleanup(); }
});

test('a failing suite or typecheck goes back to the author before anyone reviews', async () => {
  const w = world([finding()], { suite: (n) => (n === 0 ? TAP(1419, 2) : TAP(1421, 0)) });
  try {
    await w.go();
    assert.deepEqual(w.names().slice(0, 2), [FIX_AUTHOR, FIX_AUTHOR]);
    assert.match(w.sessions[1]!.prompt, /the test suite fails[\s\S]*1419 pass, 2 fail/);
    assert.equal(w.fix()?.state, 'opened');
  } finally { w.cleanup(); }
});

test('an author that declines, or never reproduced the defect, ends it there: nothing is pushed and the checkout is removed', async () => {
  for (const [author, expected] of [
    [{ ...AUTHOR, outcome: 'refused', refusal: 'the code it describes is not on this branch' }, /the author declined: the code it describes is not on this branch/],
    [{ ...AUTHOR, reproduced: false }, /did not reproduce the defect with a failing test/],
  ] as const) {
    const w = world([finding()], { author: () => okOut(author) });
    try {
      const lines = await w.go();
      assert.equal(w.fix()?.state, 'refused');
      assert.match(w.fix()?.why ?? '', expected);
      assert.match(lines[0]!, /no pull request \(refused\)/);
      assert.deepEqual(w.names(), [FIX_AUTHOR]);
      assert.equal(w.ran('git push').length, 0);
      assert.equal(w.ran('pr create').length, 0);
      assert.deepEqual(readdirSync(w.wtRoot), []);
      assert.equal(w.posted.length, 0);
    } finally { w.cleanup(); }
  }
});

test('a change that is too large, untested, or touches the lockfile is refused before any check is run', async () => {
  const cases: Array<[Partial<Script>, RegExp]> = [
    [{ shortstat: ' 3 files changed, 900 insertions(+), 20 deletions(-)' }, /920 lines changed/],
    [{ files: ['src/conductor/phase.ts'] }, /no test was added or changed/],
    [{ files: ['package-lock.json', 'src/a.test.ts'] }, /are a person's to change/],
    [{ files: ['node_modules', 'src/a.ts', 'src/a.test.ts'] }, /are a person's to change/],
  ];
  for (const [over, expected] of cases) {
    const w = world([finding()], over);
    try {
      await w.go();
      assert.equal(w.fix()?.state, 'refused');
      assert.match(w.fix()?.why ?? '', expected);
      assert.equal(w.ran('typescript/bin/tsc').length, 0);
      assert.equal(w.ran('git push').length, 0);
    } finally { w.cleanup(); }
  }
});

test('a verifier that will not pass the change stops it, and blockers that outlive two rounds stop it too', async () => {
  // "Fix first" that names nothing to fix is not a yes.
  const vague = world([finding()], { verify: () => okOut({ ...SHIP, verdict: 'fix-first', reason: 'something is off' }) });
  try {
    await vague.go();
    assert.match(vague.fix()?.why ?? '', /the verifier would not pass it: something is off/);
    assert.equal(vague.ran('git push').length, 0);
  } finally { vague.cleanup(); }

  const unconvinced = world([finding()], { verify: () => okOut({ ...SHIP, fixesTheCause: false, reason: 'the diagnosed path is unchanged' }) });
  try {
    await unconvinced.go();
    assert.match(unconvinced.fix()?.why ?? '', /the verifier would not pass it: the diagnosed path is unchanged/);
    assert.equal(unconvinced.ran('git push').length, 0);
  } finally { unconvinced.cleanup(); }

  // do-not-ship ends it on the spot, blocker or no blocker: a later verifier does not get to disagree.
  const no = world([finding()], {
    review: (lens) => okOut(lens === 'A' ? { ...REVIEW_CLEAN, findings: [blocker('still wrong')] } : REVIEW_CLEAN),
    verify: () => okOut({ ...SHIP, fixesTheCause: false, verdict: 'do-not-ship', reason: 'this is a design change', rulings: [{ id: 'A-1', holds: true, reason: 'r' }] }),
  });
  try {
    await no.go();
    assert.match(no.fix()?.why ?? '', /the verifier said it should not be opened: this is a design change/);
    assert.equal(no.counts.author, 1, 'no fix round is spent on it');
  } finally { no.cleanup(); }

  const stuck = world([finding()], {
    review: (lens) => okOut(lens === 'A' ? { ...REVIEW_CLEAN, findings: [blocker('still wrong')] } : REVIEW_CLEAN),
    verify: () => okOut({ ...SHIP, verdict: 'fix-first', rulings: [{ id: 'A-1', holds: true, reason: 'still reproduces' }] }),
  });
  try {
    await stuck.go();
    assert.equal(stuck.counts.author, 3, 'the first lap and two fix rounds');
    assert.match(stuck.fix()?.why ?? '', /still blocked after 2 fix round\(s\): still wrong/);
    assert.equal(stuck.ran('git push').length, 0);
  } finally { stuck.cleanup(); }
});

test('uncommitted work is sent back, never pushed around', async () => {
  let n = 0;
  const w = world([finding()]);
  const exec = w.deps.exec!;
  w.deps.exec = async (cmd, args, o) => {
    if (cmd === 'git' && args.includes('--porcelain')) { n += 1; return { code: 0, out: n === 1 ? ' M src/conductor/phase.ts' : '' }; }
    return exec(cmd, args, o);
  };
  try {
    await w.go();
    assert.match(w.sessions[1]!.prompt, /there are uncommitted changes in the worktree/);
    assert.equal(w.fix()?.state, 'opened');
  } finally { w.cleanup(); }
});

test('what is pushed is the commit that was measured and read, wherever a later session left the branch', async () => {
  // The reviewers and the verifier hold no Write tool, and Bash can still move a ref or leave a file.
  const w = world([finding()], { head: (n) => (n === 0 ? 'c0ffee1' : 'deadbee') });
  try {
    await w.go();
    assert.deepEqual(w.ran('git push'), [`git push ${GITHUB} c0ffee1:refs/heads/${BRANCH}`]);
    // And the checkout is put back at that commit after each of them.
    const restores = w.ran(`checkout --quiet --force --no-track -B ${BRANCH} c0ffee1`);
    assert.equal(restores.length, 2, 'after the two reviewers, and after the verifier');
    assert.equal(w.calls.filter((c) => c === 'git clean --quiet -fd').length, 2);
    assert.ok(w.ran('log --format=%B')[0]!.includes('ba5e000..c0ffee1'), 'what is screened for leaks is that commit too');
  } finally { w.cleanup(); }
});

test('a branch of the fix\'s name that appears on GitHub during the run is somebody else\'s: refused, and never deleted', async () => {
  const w = world([finding()], { lsRemote: (n) => (n === 0 ? '' : `abc\trefs/heads/${BRANCH}\n`) });
  try {
    await w.go();
    assert.equal(w.fix()?.state, 'refused');
    assert.match(w.fix()?.why ?? '', /already on GitHub and is not this pipeline's pull request/);
    assert.equal(w.ran('--delete').length, 0, 'it is not provably this pipeline\'s to take down');
    assert.equal(w.ran('git push').length, 0);
    assert.equal(w.ran('pr create').length, 0);
  } finally { w.cleanup(); }
});

test('commits that would publish something private are refused; the description and the title are rewritten', async () => {
  const inMessage = world([finding()], { messages: 'fix(phase): as seen on https://gitlab.internal.example/acme/erp/-/issues/990174\n' });
  try {
    await inMessage.go();
    assert.equal(inMessage.fix()?.state, 'refused');
    assert.equal(inMessage.fix()?.why, 'it would publish the work project\'s host in a commit message, on a public repository');
    assert.equal(inMessage.ran('git push').length, 0);
  } finally { inMessage.cleanup(); }

  const inDiff = world([finding()], { patch: '+++ b/src/x.test.ts\n+const TITLE = "Show the total on the invoice list";\n-const removed = "gitlab.internal.example";\n' });
  try {
    await inDiff.go();
    assert.equal(inDiff.fix()?.why, 'it would publish the ticket\'s title in the change itself, on a public repository', 'a removed line publishes nothing');
  } finally { inDiff.cleanup(); }

  const inWords = world([finding({ title: 'Runs of "Show the total on the invoice list" lose their result' })], {
    author: () => okOut({ ...AUTHOR, title: '', prWhy: 'Seen on gitlab.internal.example while running that ticket.' }),
  });
  try {
    await inWords.go();
    assert.equal(inWords.fix()?.state, 'opened');
    const create = inWords.ran('pr create')[0]!;
    assert.doesNotMatch(create, /invoice list/i, 'the fallback title is the diagnosis\'s own words about a private run');
    assert.doesNotMatch(readFileSync(join(inWords.dir, BODY), 'utf8'), /gitlab\.internal\.example/);
  } finally { inWords.cleanup(); }
});

test('a defect in code the base branch does not have gets no pull request, and no session is paid to find that out', async () => {
  // The diagnosis is made against the code the run used, which can be branches ahead of main.
  const w = world([finding({ evidence: [{ file: 'repo:src/review/ledger.ts', line: 12, quote: 'WHY IT IS BUILT THIS WAY', ok: true, note: '' }], where: ['src/review/ledger.ts'] })]);
  const exec = w.deps.exec!;
  w.deps.exec = async (cmd, args, o) => (cmd === 'git' && args[0] === 'cat-file' ? { code: 128, out: 'fatal: path does not exist' } : exec(cmd, args, o));
  try {
    await w.go();
    assert.equal(w.fix()?.state, 'refused');
    assert.match(w.fix()?.why ?? '', /the code it shows \(src\/review\/ledger\.ts\) is not on origin\/main/);
    assert.equal(w.sessions.length, 0);
    assert.equal(w.ran(' init ').length, 0);
  } finally { w.cleanup(); }
});

test('a finding another process is already fixing is left to it', async () => {
  const w = world();
  try {
    mkdirSync(join(w.dir, 'diagnosis', 'fix'), { recursive: true });
    writeFileSync(join(w.dir, 'diagnosis', 'fix', '.lock-k1-D-3'), 'held');
    assert.deepEqual(await w.go(), ['D-3 not attempted: another process is fixing it']);
    assert.equal(w.sessions.length, 0);
    assert.equal(w.fix(), undefined);
  } finally { w.cleanup(); }
});

test('what the diagnosis pass wrote to the record while a fix ran is still there afterwards', async () => {
  const w = world();
  try {
    w.deps.session = async (input) => {
      w.sessions.push(input);
      if (input.cfg.name === FIX_AUTHOR) {
        updateDiagnosisFile(w.dir, { iid: IID, runId: 'r-test0001-abcdef' }, (f) => {
          f.stops.k2 = { key: 'k2', runId: 'r-test0001-abcdef', iid: IID, status: 'parked', stoppedPhase: 'verify', reason: '', trouble: [], state: 'diagnosed', attempts: 1, lastAttemptAt: 9 };
          f.latest = 'k2';
        });
        return okOut(AUTHOR);
      }
      return okOut(input.cfg.name === FIX_REVIEW ? REVIEW_CLEAN : SHIP);
    };
    await w.go();
    const f = readDiagnosisFile(w.dir)!;
    assert.equal(f.latest, 'k2', 'the newer stop is still the latest');
    assert.ok(f.stops.k2);
    assert.equal(f.stops.k1!.fixes?.['D-3']?.state, 'opened');
    assert.equal(existsSync(join(w.dir, 'diagnosis', 'fix', '.lock-k1-D-3')), false, 'the lock is released');
  } finally { w.cleanup(); }
});

test('only the pull request this pipeline opened for this finding of this stop is adopted', async () => {
  const had = world([finding()], { prList: { code: 0, out: listed({ number: 99, state: 'OPEN' }) } });
  try {
    await had.go();
    assert.deepEqual({ state: had.fix()?.state, prNumber: had.fix()?.prNumber }, { state: 'opened', prNumber: 99 });
    assert.equal(had.sessions.length, 0);
    assert.equal(had.ran('pr create').length, 0);
  } finally { had.cleanup(); }

  const merged = world([finding()], { prList: { code: 0, out: listed({ number: 98, state: 'MERGED' }) } });
  try {
    await merged.go();
    assert.match(merged.fix()?.why ?? '', /already exists and is merged/);
  } finally { merged.cleanup(); }

  // Finding ids start again at D-1 in every diagnosis. An earlier stop's D-3, a
  // fork that used the same branch name, and a hand-made pull request are none of them this one.
  for (const other of [listed({ number: 97, state: 'OPEN', key: 'k0' }), listed({ number: 96, state: 'OPEN', fork: true }), listed({ number: 95, state: 'OPEN', body: 'opened by hand' })]) {
    const w = world([finding()], { prList: { code: 0, out: other } });
    try {
      await w.go();
      assert.equal(w.fix()?.prNumber, 231, 'its own pull request is opened');
      assert.equal(w.sessions.length, 4);
    } finally { w.cleanup(); }
  }

  const stale = world([finding()], { lsRemote: () => `abc\trefs/heads/${BRANCH}\n` });
  try {
    await stale.go();
    assert.match(stale.fix()?.why ?? '', /already on GitHub and is not this pipeline's pull request/);
    assert.equal(stale.sessions.length, 0);
  } finally { stale.cleanup(); }
});

test('GitHub not answering is a failure, not "no pull request exists": nothing is written twice on a guess', async () => {
  for (const prList of [{ code: 1, out: 'HTTP 502: Bad Gateway\n' }, { code: 0, out: 'not json' }]) {
    const w = world([finding()], { prList });
    try {
      await w.go();
      assert.equal(w.fix()?.state, 'failed');
      assert.match(w.fix()?.why ?? '', /could not ask GitHub whether a pull request already exists|could not be read/);
      assert.equal(w.sessions.length, 0);
    } finally { w.cleanup(); }
  }
});

test('a dry run starts no session: the author would have no tool to write with and nothing could be pushed', async () => {
  const w = world([finding()], { dryRun: true });
  try {
    await w.go();
    assert.equal(w.fix()?.state, 'unavailable');
    assert.match(w.fix()?.why ?? '', /dry run/);
    assert.equal(w.sessions.length, 0);
    assert.equal(w.ran('git push').length + w.ran('pr create').length, 0);
    assert.equal(w.posted.length, 0);
  } finally { w.cleanup(); }
});

test('an interruption is not an attempt: a pause, the usage limit or a shutdown leaves the finding to be tried again', async () => {
  const cut: PhaseOutput = { ok: false, data: null, blocked: null, summary: '', turns: 3, weighted: 100, sessionId: 's', rateLimited: true, error: 'rate_limit: resets 4:30pm' };
  const cases: Array<[Partial<Script>, RegExp]> = [
    [{ hold: 'paused (state/PAUSE)' }, /^paused \(state\/PAUSE\)$/],
    [{ author: () => cut }, /the author session was interrupted: rate_limit/],
    [{ review: (lens) => (lens === 'B' ? cut : okOut(REVIEW_CLEAN)) }, /reviewer B was interrupted/],
    [{ verify: () => cut }, /the verifier was interrupted/],
  ];
  for (const [over, expected] of cases) {
    const w = world([finding(), finding({ id: 'D-4' })], over);
    try {
      const lines = await w.go();
      assert.equal(w.fix()?.state, 'held');
      assert.match(w.fix()?.why ?? '', expected);
      assert.equal(lines.length, 1, 'the next finding would be held the same way, and is not started');
      assert.equal(w.ran('git push').length, 0);
      // Nothing in the record stops the next look from trying again.
      Object.assign(w.script, { hold: null, author: () => okOut(AUTHOR), review: () => okOut(REVIEW_CLEAN), verify: () => okOut(SHIP) });
      assert.match((await w.go())[0]!, /D-3 pull request opened/);
    } finally { w.cleanup(); }
  }
});

test('a desk paused, or told to stop, after the review publishes nothing', async () => {
  const paused = world([finding()], { verify: () => { paused.script.paused = true; return okOut(SHIP); } });
  try {
    await paused.go();
    assert.deepEqual({ state: paused.fix()?.state, why: paused.fix()?.why }, { state: 'held', why: 'stopped before anything was pushed' });
    assert.equal(paused.ran('git push').length + paused.ran('pr create').length, 0);
  } finally { paused.cleanup(); }

  const ac = new AbortController();
  const stopped = world([finding()], { verify: () => { ac.abort(); return okOut(SHIP); } });
  try {
    await stopped.go({ signal: ac.signal });
    assert.equal(stopped.fix()?.state, 'held');
    assert.equal(stopped.ran('git push').length, 0);
  } finally { stopped.cleanup(); }
});

test('a refused push, or a pull request GitHub will not create, is recorded as it happened', async () => {
  const push = world([finding()], { push: { code: 1, out: 'remote: Permission to acme/oneshot.git denied\n' } });
  try {
    await push.go();
    assert.match(push.fix()?.why ?? '', /the push was refused: remote: Permission to acme\/oneshot\.git denied/);
    assert.equal(push.ran('pr create').length, 0);
  } finally { push.cleanup(); }

  const create = world([finding()], { prCreate: { code: 1, out: 'GraphQL: a pull request already exists\n' } });
  try {
    await create.go();
    assert.match(create.fix()?.why ?? '', new RegExp(`the branch ${BRANCH} is pushed, and opening the pull request failed`));
    assert.equal(create.ran('--delete').length, 0, 'the pushed branch is not deleted from under a person');
  } finally { create.cleanup(); }
});

test('a branch of that name the operator already had in their clone is left where it is', async () => {
  const w = world([finding()], { hadLocal: true });
  try {
    await w.go();
    assert.equal(w.ran('update-ref -d').length, 0);
  } finally { w.cleanup(); }
});

test('a finding that is not the harness\'s gets its reason recorded and costs nothing', async () => {
  const w = world([finding({ id: 'D-1', category: 'environment', fix: 'operator' }), finding({ id: 'D-2', category: 'ticket', fix: 'pipeline' })]);
  try {
    const lines = await w.go();
    assert.match(lines[0]!, /D-1 no pull request: not a harness defect \(environment\)/);
    assert.match(lines[1]!, /D-2 no pull request: not a harness defect \(ticket\)/);
    assert.equal(w.fix('D-1')?.state, 'refused');
    assert.equal(w.calls.length, 0, 'no command was run');
    assert.equal(w.sessions.length, 0);
  } finally { w.cleanup(); }
});

test('a stop gets two unattended fixes at most; a person can still ask for the third by name', async () => {
  const three = [finding({ id: 'D-3' }), finding({ id: 'D-4' }), finding({ id: 'D-5' })];
  const w = world(three);
  try {
    const lines = await w.go();
    assert.equal(lines.filter((l) => /pull request opened/.test(l)).length, 2);
    assert.match(lines[2]!, /D-5 not attempted: this stop has had its 2 unattended fixes \(npm run diagnose -- fix 990174 D-5\)/);
    assert.equal(w.fix('D-5'), undefined);
    const again = await w.go({ only: 'D-5' });
    assert.match(again[0]!, /D-5 pull request opened/);
    assert.match((await w.go({ only: 'D-3', force: true }))[0]!, /already has a pull request/, 'an opened fix is never opened twice');
  } finally { w.cleanup(); }
});

test('the ticket is told only where this desk may write, and by hand only when asked', async () => {
  const theirs = world([finding()], { issue: issue(['a.teammate']) });
  try {
    await theirs.go();
    assert.equal(theirs.fix()?.state, 'opened');
    assert.equal(theirs.posted.length, 0);
    assert.equal(theirs.fix()?.note, undefined);
  } finally { theirs.cleanup(); }

  const closed = world([finding()], { issue: { ...issue(), state: 'closed' } });
  try {
    await closed.go();
    assert.equal(closed.posted.length, 0);
  } finally { closed.cleanup(); }

  const claimed = world([finding()], { notes: [{ id: 7, system: false, created_at: new Date(1_800_000_000_000 - 60_000).toISOString(), body: 'Oneshot claimed this ticket — run `r-other000-111111` (another desk).' }] as unknown as IssueNote[] });
  try {
    await claimed.go();
    assert.equal(claimed.posted.length, 0, 'another run holds the ticket now');
  } finally { claimed.cleanup(); }

  // `npm run diagnose -- fix` without --post, whatever the desk's setting is.
  const byHand = world();
  try {
    await byHand.go({ post: false });
    assert.equal(byHand.fix()?.state, 'opened');
    assert.equal(byHand.posted.length, 0);
  } finally { byHand.cleanup(); }
});

test('with no diagnosis there is nothing to fix from', async () => {
  const run = makeRun();
  try {
    assert.deepEqual(await fixFromDiagnosis({ iid: IID, dir: run.dir }, {}), [`#${IID} has no diagnosis to fix from`]);
    assert.equal(existsSync(join(run.dir, 'diagnosis.json')), false);
  } finally { run.cleanup(); }
});

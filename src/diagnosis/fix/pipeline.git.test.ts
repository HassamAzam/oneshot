/**
 * The fix pipeline against a REAL git repository and a local bare `origin`.
 *
 * pipeline.test.ts scripts git, so it proves the orchestration and nothing
 * about the plumbing under it: that the fix checkout really is cut from the
 * base and really is clean with its dependencies linked in, that the
 * reproduction really runs the author's tests on the base without the fix,
 * that a session's own push really cannot leave the machine, that exactly one
 * commit reaches the remote, and that the developer's own checkout is left as
 * it was. Those are the parts a wrong flag breaks silently.
 *
 * Still stubbed: the model sessions (the "author" here makes real commits),
 * `gh`, and the remote's URL, which has to look like GitHub to be accepted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '../../lib/test-project-env.js';
import { ROOT, type PhaseConfig } from '../../lib/config.js';
import type { PhaseInput, PhaseOutput } from '../../conductor/phase.js';
import { readDiagnosisFile } from '../record.js';
import { FIX_AUTHOR, FIX_REVIEW, defaultFixDeps, fixFromDiagnosis, type FixDeps } from './pipeline.js';

const IID = 990174;
const BRANCH = 'fix/diagnosed-990174-k-d-3';
const IDENTITY = { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com' };
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENTITY } }).trim();

const ok = (data: Record<string, unknown>): PhaseOutput => ({
  ok: true, data, blocked: null, summary: '', turns: 3, weighted: 10, sessionId: 's', rateLimited: false,
});

const TEST = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './add.js';\n";

/** A tiny TypeScript project with one defect, pushed to a bare origin, and a diagnosed run that names it. */
function project(): { root: string; repo: string; origin: string; runDir: string; wtRoot: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'oneshot-pipegit-'));
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  const runDir = join(root, 'run');
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(runDir, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', origin]);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'x', type: 'module', private: true }));
  writeFileSync(join(repo, 'package-lock.json'), '{"lockfileVersion":3}');
  writeFileSync(join(repo, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, skipLibCheck: true, types: ['node'] },
    include: ['src/**/*.ts'],
  }));
  // The repository's real line. It matches a directory and NOT a link to one,
  // which is what the fix checkout holds: with `node_modules` here this test
  // could not see a checkout that is never clean.
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(repo, 'src', 'add.ts'), 'export const add = (a: number, b: number): number => a - b;\n');
  writeFileSync(join(repo, 'src', 'other.test.ts'), "import { test } from 'node:test';\ntest('unrelated', () => {});\n");
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  // The repository's own toolchain: what a fix checkout links when its lockfile
  // matches the base's. A directory in a real checkout; a link here, so kept
  // out of this clone's status by hand.
  symlinkSync(join(ROOT, 'node_modules'), join(repo, 'node_modules'));
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '/node_modules\n');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');

  writeFileSync(join(runDir, 'run.json'), JSON.stringify({ runId: 'r-test0001-abcdef', iid: IID, title: 't', url: '', createdAt: 1, status: 'blocked', phases: [] }));
  const finding = {
    id: 'D-3', title: 'add subtracts', category: 'harness', phases: '', recorded: '', cause: 'c', solution: 's', where: ['src/add.ts'],
    fix: 'pr', confidence: 'confirmed', evidenced: true, evidence: [{ file: 'repo:src/add.ts', line: 1, quote: 'a - b', ok: true, note: '' }],
  };
  writeFileSync(join(runDir, 'diagnosis.json'), JSON.stringify({
    version: 1, iid: IID, runId: 'r-test0001-abcdef', latest: 'k', sessions: 1,
    stops: { k: { key: 'k', runId: 'r-test0001-abcdef', iid: IID, status: 'blocked', stoppedPhase: 'merge', reason: '', trouble: [], state: 'diagnosed', attempts: 1, lastAttemptAt: 1, findings: [finding] } },
  }));
  return { root, repo, origin, runDir, wtRoot: join(root, 'wt'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Real git and a real compiler and test runner; only `gh` and the remote's URL are answered here. */
function deps(p: ReturnType<typeof project>, author: (wt: string) => void): { deps: Partial<FixDeps>; calls: string[] } {
  const real = defaultFixDeps();
  const calls: string[] = [];
  return {
    calls,
    deps: {
      repo: p.repo, base: 'main', worktreeRoot: p.wtRoot, project: 'erp', dryRun: false, me: () => 'bot',
      exec: async (cmd, args, o) => {
        calls.push(`${cmd} ${args.join(' ')}`);
        if (cmd === 'gh' && args[0] === 'auth') return { code: 0, out: '' };
        if (cmd === 'gh' && args.includes('list')) return { code: 0, out: '[]' };
        if (cmd === 'gh' && args.includes('create')) return { code: 0, out: 'https://github.com/acme/oneshot/pull/7\n' };
        // It has to look like GitHub to be accepted, and what is pushed to has to be the local bare origin.
        if (cmd === 'git' && args[0] === 'remote' && args[1] === 'get-url') return { code: 0, out: args.includes('--push') ? p.origin : 'https://github.com/acme/oneshot.git' };
        return real.exec(cmd, args, o);
      },
      phase: (name): PhaseConfig => ({
        name, n: 16, kind: 'session', tier: 'heavy', cwd: 'worktree', maxTurns: 10, timeoutMin: 5,
        writes: name === FIX_AUTHOR ? ['worktree'] : [], onFail: 'warn', onDemand: true,
      }),
      session: async (input: PhaseInput) => {
        if (input.cfg.name === FIX_AUTHOR) {
          author(input.worktree!);
          return ok({
            summary: 's', outcome: 'fixed', refusal: '', reproduced: true, title: 'fix(add): add instead of subtracting',
            prSummary: 'Adds.', prWhy: 'It subtracted.', prTests: 'add adds.', testFiles: ['src/add.test.ts'], commits: ['x'], addressed: [],
          });
        }
        if (input.cfg.name === FIX_REVIEW) return ok({ summary: 's', verdict: 'approve', verified: 'ran it', findings: [] });
        return ok({ summary: 's', rulings: [], additional: [], fixesTheCause: true, verdict: 'ship', reason: 'confirmed' });
      },
      sessionHold: () => null,
      paused: () => false,
      privateText: () => [],
      attempt: { start: () => 1, end: () => undefined },
      gitlab: {
        getIssue: async () => ({ ok: false, kind: 'network', status: 0, data: null }),
        notes: async () => ({ ok: false, kind: 'network', status: 0, data: null }),
        addNote: async () => ({ ok: false, kind: 'network', status: 0, data: null }),
      },
      event: () => undefined,
    },
  };
}

const commitFix = (wt: string, testBody: string): void => {
  writeFileSync(join(wt, 'src', 'add.test.ts'), `${TEST}${testBody}\n`);
  writeFileSync(join(wt, 'src', 'add.ts'), 'export const add = (a: number, b: number): number => a + b;\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', 'fix(add): add, not subtract');
};

test('on a real repository: the fix is cut from the base, proven against it, and one branch reaches the remote', async () => {
  const p = project();
  try {
    const w = deps(p, (wt) => commitFix(wt, "test('add adds', () => { assert.equal(add(2, 3), 5); });"));
    const lines = await fixFromDiagnosis({ iid: IID, dir: p.runDir }, w.deps);
    assert.deepEqual(lines, ['D-3 pull request opened: https://github.com/acme/oneshot/pull/7']);

    const fix = readDiagnosisFile(p.runDir)!.stops.k!.fixes!['D-3']!;
    assert.deepEqual(fix.checks, {
      typecheck: 'clean', tests: '2 pass, 0 fail', hooks: '',
      redGreen: '1 changed test file(s) on origin/main without the fix: 1 failing, 0 passing',
    }, 'measured by really compiling and running: the new test fails on main and passes on the branch');

    const heads = git(p.repo, 'ls-remote', '--heads', p.origin).split('\n').map((l) => l.split('\t')[1]).sort();
    assert.deepEqual(heads, [`refs/heads/${BRANCH}`, 'refs/heads/main'], 'one new branch on the remote, and main untouched');
    assert.equal(git(p.repo, 'rev-parse', 'origin/main'), git(p.repo, 'rev-parse', 'main'));
    // Asked of the remote itself: the pipeline pushes by address, so the clone holds no tracking ref for it.
    assert.match(git(p.origin, 'show', `${BRANCH}:src/add.ts`), /a \+ b/);

    assert.match(readFileSync(join(p.repo, 'src', 'add.ts'), 'utf8'), /a - b/, "the developer's own checkout still has what it had");
    assert.equal(git(p.repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(git(p.repo, 'status', '--porcelain'), '');
    assert.equal(git(p.repo, 'worktree', 'list').split('\n').length, 1, 'it never had a worktree made in it');
    assert.equal(git(p.repo, 'branch', '--list', BRANCH), '', 'or a branch');
    assert.deepEqual(existsSync(p.wtRoot) ? readdirSync(p.wtRoot) : [], [], 'both fix checkouts are gone');

    // The link to node_modules made the checkout dirty on every round and was one `git add -A` from being committed.
    assert.deepEqual(git(p.origin, 'ls-tree', '-r', '--name-only', BRANCH).split('\n').sort(), ['.gitignore', 'package-lock.json', 'package.json', 'src/add.test.ts', 'src/add.ts', 'src/other.test.ts', 'tsconfig.json']);

    const create = w.calls.find((c) => c.startsWith('gh pr create'))!;
    assert.ok(create.includes(`--base main --head ${BRANCH} --title Add Instead of Subtracting`));
    const sha = git(p.origin, 'rev-parse', BRANCH);
    assert.deepEqual(w.calls.filter((c) => /^git push/.test(c)), [`git push ${p.origin} ${sha}:refs/heads/${BRANCH}`], 'the only push there is, of one commit by its id');
    assert.equal(w.calls.filter((c) => /\bmerge\b/.test(c)).length, 0);
  } finally { p.cleanup(); }
});

test('on a real repository: a test that passes on the base without the fix is caught, and nothing is pushed', async () => {
  const p = project();
  try {
    // The "test" asserts nothing about the defect, so it is green on main too. Three laps, never a reproduction.
    let lap = 0;
    const w = deps(p, (wt) => {
      lap += 1;
      if (lap === 1) { commitFix(wt, "test('add is a function', () => { assert.equal(typeof add, 'function'); });"); return; }
      writeFileSync(join(wt, 'src', 'add.test.ts'), `${TEST}test('add is still a function, lap ${lap}', () => { assert.equal(typeof add, 'function'); });\n`);
      git(wt, 'add', '-A');
      git(wt, 'commit', '-q', '-m', 'test(add): try again');
    });
    const lines = await fixFromDiagnosis({ iid: IID, dir: p.runDir }, w.deps);
    assert.match(lines[0]!, /no pull request \(refused\): still blocked after 2 fix round\(s\): the changed tests do not fail on the base branch without the fix/);
    assert.equal(lap, 3);
    assert.equal(git(p.repo, 'ls-remote', '--heads', p.origin, BRANCH), '', 'the branch never left the machine');
    assert.equal(git(p.repo, 'branch', '--list', BRANCH), '', 'and is not left behind in the clone');
    assert.equal(w.calls.filter((c) => c.startsWith('git push') || c.startsWith('gh pr create')).length, 0);
    assert.equal(git(p.repo, 'worktree', 'list').split('\n').length, 1);
  } finally { p.cleanup(); }
});

test('on a real repository: a session that pushes its own branch reaches this disk and nothing else', async () => {
  // git-guard lets a session push the branch it was leased, to `origin`. In the
  // fix checkout `origin` is the operator's clone, so that is where it lands.
  const p = project();
  try {
    // Work of the operator's that was never pushed: it must not be in the fix checkout to be merged or copied.
    git(p.repo, 'checkout', '-q', '-b', 'private/unpushed');
    writeFileSync(join(p.repo, 'src', 'secret.ts'), 'export const unpublished = true;\n');
    git(p.repo, 'add', '-A');
    git(p.repo, 'commit', '-q', '-m', 'wip: not for anyone yet');
    const privateSha = git(p.repo, 'rev-parse', 'HEAD');
    git(p.repo, 'checkout', '-q', 'main');
    let early = '';
    let onRemoteThen = 'unset';
    let refsThere = 'unset';
    let privateThere = true;
    const w = deps(p, (wt) => {
      refsThere = git(wt, 'for-each-ref', '--format=%(refname)');
      try { git(wt, 'cat-file', '-e', `${privateSha}^{commit}`); } catch { privateThere = false; }
      writeFileSync(join(wt, 'src', 'add.ts'), 'export const add = (a: number, b: number): number => a * b; // unreviewed first try\n');
      git(wt, 'add', '-A');
      git(wt, 'commit', '-q', '-m', 'wip: first try');
      early = git(wt, 'rev-parse', 'HEAD');
      git(wt, 'push', '-q', 'origin', BRANCH);
      onRemoteThen = git(p.repo, 'ls-remote', '--heads', p.origin, BRANCH);
      assert.equal(git(wt, 'status', '--porcelain'), '', 'the checkout is clean with its dependencies linked in');
      commitFix(wt, "test('add adds', () => { assert.equal(add(2, 3), 5); });");
    });
    const lines = await fixFromDiagnosis({ iid: IID, dir: p.runDir }, w.deps);
    assert.deepEqual(lines, ['D-3 pull request opened: https://github.com/acme/oneshot/pull/7']);
    assert.equal(onRemoteThen, '', 'the session\'s push did not reach the remote');
    assert.deepEqual(refsThere.split('\n').sort(), [`refs/heads/${BRANCH}`, 'refs/remotes/origin/main'], 'the checkout holds the base and its own branch');
    assert.equal(privateThere, false, 'and not even the objects of a branch the operator never pushed');
    assert.equal(git(p.repo, 'rev-parse', 'private/unpushed'), privateSha, 'which is still where they left it');
    const published = git(p.repo, 'ls-remote', '--heads', p.origin, BRANCH).split('\t')[0];
    assert.notEqual(published, early, 'what is published is the commit that was checked');
    assert.match(git(p.origin, 'show', `${published}:src/add.ts`), /a \+ b/);
    assert.equal(git(p.repo, 'branch', '--list', BRANCH), '', 'and what the session pushed into the clone is tidied away');
  } finally { p.cleanup(); }
});

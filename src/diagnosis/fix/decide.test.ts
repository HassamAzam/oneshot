import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../lib/test-project-env.js';
import {
  checkBlockers, checksPass, diffGuard, fixBranch, fixEligibility, githubSlug, isRepoPath, nextMove, parseTap, prTitle,
  repoPathOf, reviewPoints, rulingsOf, tally, upheld, MAX_FIX_ROUNDS, type Checks, type ReviewPoint,
} from './decide.js';
import type { CheckedFinding } from '../types.js';

const finding = (over: Partial<CheckedFinding> = {}): CheckedFinding => ({
  id: 'D-3', title: 'The CLI exit replaced the recorded outcome', category: 'harness', phases: '', recorded: '', cause: '',
  evidence: [
    { file: 'run.json', line: 65, quote: 'x', ok: true, note: '' },
    { file: 'repo:src/conductor/phase.ts', line: 762, quote: 'out.error = m;', ok: true, note: '' },
  ],
  solution: '', where: ['src/conductor/phase.ts'], fix: 'pr', confidence: 'confirmed', evidenced: true, ...over,
});

const why = (r: { ok: boolean; why?: string }): string => (r.ok ? '' : r.why ?? '');
const point = (id: string, severity: ReviewPoint['severity'] = 'blocker'): ReviewPoint => ({ id, severity, file: 'src/x.ts', line: 1, what: `point ${id}`, why: 'because', fix: '' });
const GREEN: Checks = {
  typecheck: { ok: true, text: 'clean' }, tests: { ok: true, pass: 1420, fail: 0, text: '1420 pass, 0 fail' },
  hooks: { ok: true, ran: false, text: '' }, red: { ok: true, text: '2 failing on main' },
};

// --------------------------------------------------------------- eligibility

test('only a confirmed, evidenced harness defect shown in this repository\'s code may have a fix attempted', () => {
  assert.deepEqual(fixEligibility(finding()), { ok: true });
  assert.match(why(fixEligibility(finding({ category: 'environment' }))), /not a harness defect \(environment\): an operator fixes the machine/);
  assert.match(why(fixEligibility(finding({ category: 'ticket' }))), /goes back through the pipeline/);
  assert.match(why(fixEligibility(finding({ category: 'human' }))), /a person decides/);
  assert.match(why(fixEligibility(finding({ fix: 'pipeline' }))), /does not ask for a code change/);
  assert.match(why(fixEligibility(finding({ evidenced: false }))), /a lead, not a finding/);
  assert.match(why(fixEligibility(finding({ confidence: 'probable' }))), /only probable/);
});

test('a cause already fixed in the checkout that was diagnosed gets no pull request, whatever else it says', () => {
  // The author works on the base branch, where that commit may not be: it would write the fix a second time.
  assert.match(why(fixEligibility(finding({ fixedBy: 'f915c43' }))), /already fixed in the checkout that was diagnosed, by f915c43: deploy that/);
  assert.match(why(fixEligibility(finding({ fixedBy: 'f915c43' }), undefined, true)), /already fixed/, 'asking again does not change it');
});

test('a harness finding that never shows the code, or names no file here, is refused', () => {
  const noCode = finding({ evidence: [{ file: 'run.json', line: 1, quote: 'x', ok: true, note: '' }] });
  assert.match(why(fixEligibility(noCode)), /does not show the place in this repository's code/);
  const codeNotFound = finding({ evidence: [{ file: 'repo:src/conductor/phase.ts', line: 1, quote: 'x', ok: false, note: 'not in that file' }, { file: 'run.json', line: 1, quote: 'x', ok: true, note: '' }] });
  assert.match(why(fixEligibility(codeNotFound)), /no `repo:` citation that checked out/);
  assert.match(why(fixEligibility(finding({ where: ['/srv/wt/t9174/app/settings_test.py', 'the server'] }))), /names no file of this repository/);
});

test('a finding with a pull request is never given a second; one refused before is retried only on request', () => {
  const opened = { state: 'opened' as const, prUrl: 'https://github.com/o/r/pull/9', at: 1 };
  assert.match(why(fixEligibility(finding(), opened, true)), /already has a pull request: https:\/\/github\.com\/o\/r\/pull\/9/);
  const refused = { state: 'refused' as const, why: 'the author declined', at: 1 };
  assert.match(why(fixEligibility(finding(), refused)), /already attempted \(refused\): the author declined/);
  assert.deepEqual(fixEligibility(finding(), refused, true), { ok: true });
  // Interrupted is not attempted: a pause or the usage limit said nothing about the fix.
  assert.deepEqual(fixEligibility(finding(), { state: 'held', why: 'paused (state/PAUSE)', at: 1 }), { ok: true });
});

test('isRepoPath accepts a path inside this repository, however a session wrote it, and nothing else', () => {
  for (const p of ['src/conductor/phase.ts', 'repo:hooks/git-guard.cjs', 'scripts/app.cjs', 'config/phases.json', 'skills/x/SKILL.md']) assert.equal(isRepoPath(p), true, p);
  // The schema asks for "files or places", and this is how places get written.
  assert.equal(repoPathOf('src/conductor/phase.ts:762'), 'src/conductor/phase.ts');
  assert.equal(repoPathOf('src/conductor/phase.ts (the catch branch)'), 'src/conductor/phase.ts');
  assert.equal(repoPathOf('`src/conductor/phase.ts`, around throwAfterSettle'), 'src/conductor/phase.ts');
  assert.equal(repoPathOf('./src/lib/quota.ts:194-200.'), 'src/lib/quota.ts');
  assert.equal(repoPathOf('repo:src/lib/quota.ts'), 'src/lib/quota.ts');
  for (const p of ['/srv/oneshot/src/x.ts', 'apps/billing/tests/test_invoice.py', '../src/x.ts', 'the setup script', '']) assert.equal(isRepoPath(p), false, p);
  // What diffGuard would refuse anyway is not somewhere a fix can be made.
  for (const p of ['package.json', 'package-lock.json', 'deploy/systemd/oneshot-conductor.service', 'repo:state/runs/9174/diagnosis/session.json', 'repo:.env', 'node_modules/zod/index.js']) assert.equal(isRepoPath(p), false, p);
});

test('the code a finding points at has to be code: its own session\'s output under the repository root is not', () => {
  const selfCited = finding({ evidence: [{ file: 'repo:state/runs/9174/diagnosis/session.json', line: 1, quote: 'x', ok: true, note: '' }] });
  assert.match(why(fixEligibility(selfCited)), /does not show the place in this repository's code/);
});

// ------------------------------------------------------------------ the diff

test('an unattended fix is small, tested, and touches only code and its docs', () => {
  const d = (files: string[], insertions = 40, deletions = 5) => diffGuard({ files, insertions, deletions });
  assert.deepEqual(d(['src/conductor/phase.ts', 'src/conductor/phase-crash.test.ts']), { ok: true });
  assert.deepEqual(d(['hooks/git-guard.cjs', 'scripts/verify-hooks.sh']), { ok: true }, 'a hook is tested through verify-hooks.sh');
  assert.match(why(d([])), /committed nothing/);
  assert.match(why(d(['src/conductor/phase.ts'])), /no test was added or changed/);
  assert.match(why(d(Array.from({ length: 16 }, (_, i) => `src/a${i}.test.ts`))), /16 files changed, over the 15/);
  assert.match(why(d(['src/a.ts', 'src/a.test.ts'], 700, 200)), /900 lines changed, over the 800/);
  for (const held of ['package-lock.json', 'package.json', 'deploy/systemd/oneshot-conductor.service', '.github/workflows/ci.yml', 'config/reviewers.json']) {
    assert.match(why(d([held, 'src/a.test.ts'])), /are a person's to change/, held);
  }
  assert.deepEqual(d(['config/phases.json', 'src/a.test.ts']), { ok: true }, 'phase policy is code, not team configuration');
  // The link the pipeline makes for the checkout, committed by `git add -A`.
  assert.match(why(d(['node_modules', 'src/a.ts', 'src/a.test.ts'])), /are a person's to change/);
});

test('a change to source needs a test the pipeline can run against the base: the hooks\' script does not cover src/', () => {
  const d = (files: string[]) => diffGuard({ files, insertions: 10, deletions: 1 });
  assert.match(why(d(['src/conductor/phase.ts', 'scripts/verify-hooks.sh'])), /changes source and no test file/);
  assert.match(why(d(['scripts/app.cjs', 'hooks/git-guard.cjs', 'scripts/verify-hooks.sh'])), /changes source and no test file/);
  assert.deepEqual(d(['src/conductor/phase.ts', 'scripts/verify-hooks.sh', 'src/conductor/phase-crash.test.ts']), { ok: true });
  assert.deepEqual(d(['scripts/board/x.mjs', 'scripts/board/x.test.mjs']), { ok: true });
});

// ---------------------------------------------------------------- the review

test('two reviewers\' points are renumbered so they cannot collide, and model output is coerced', () => {
  const a = reviewPoints('A', { findings: [{ severity: 'blocker', what: 'wrong', why: 'w', file: 'src/x.ts', line: '12', fix: '' }, { severity: 'catastrophe', what: 'odd' }, { what: '  ' }, null] });
  // A severity the schema does not know is read as the one that costs a round.
  assert.deepEqual(a.map((p) => [p.id, p.severity, p.line]), [['A-1', 'blocker', 12], ['A-2', 'blocker', 0]]);
  assert.deepEqual(reviewPoints('B', { findings: [{ severity: ' BLOCKER ', what: 'x' }, { severity: 'Nit', what: 'y' }] }).map((p) => p.severity), ['blocker', 'nit']);
  assert.deepEqual(reviewPoints('B', { findings: 'none' }), []);
  assert.deepEqual(reviewPoints('B', null), []);
  assert.deepEqual(rulingsOf({ rulings: [{ id: 'A-1', holds: 'yes', reason: 'r' }, { holds: true }] }), [{ id: 'A-1', holds: false, reason: 'r' }]);
});

test('only a blocker the verifier could not refute goes back to the author', () => {
  const points = [point('A-1'), point('A-2'), point('B-1', 'nit'), point('B-2')];
  const rulings = [{ id: 'A-1', holds: true, reason: 'reproduced' }, { id: 'A-2', holds: false, reason: 'ran it: does not happen' }];
  const more = [point('V0-1'), point('V0-2', 'note')];
  assert.deepEqual(upheld(points, rulings, more).map((p) => p.id), ['A-1', 'B-2', 'V0-1']);
});

test('the tally is what happened: a blocker that stood and was then fixed was upheld, not refuted', () => {
  const points = [point('A-1'), point('A-2'), point('B-1', 'nit'), point('B-2')];
  const additional = [point('V0-1'), point('V0-2', 'note')];
  // A-1, B-2 and the verifier's own stood; A-2 was refuted on sight; later A-1 and V0-1 were fixed.
  const t = tally({ points, additional, stood: new Set(['A-1', 'B-2', 'V0-1']), fixed: new Set(['A-1', 'V0-1']) });
  assert.deepEqual(t, { raised: 6, upheld: 3, refuted: 1, fixed: 2 });
});

test('a blocker the verifier did not rule on is upheld: silence is not a refutation', () => {
  assert.deepEqual(upheld([point('A-1')], [], []).map((p) => p.id), ['A-1']);
  // Nor is a ruling for some other id, or two rulings that disagree.
  assert.deepEqual(upheld([point('A-1')], [{ id: 'A-9', holds: false, reason: 'r' }, { id: 'a-1', holds: false, reason: 'r' }], []).map((p) => p.id), ['A-1']);
  assert.deepEqual(upheld([point('A-1')], [{ id: 'A-1', holds: true, reason: 'reproduced' }, { id: 'A-1', holds: false, reason: 'on second thought' }], []).map((p) => p.id), ['A-1']);
  assert.deepEqual(upheld([point('A-1')], [{ id: 'A-1', holds: false, reason: 'ran it' }], []), []);
});

// ---------------------------------------------------------------- the checks

test('parseTap reads node:test\'s summary and nothing else', () => {
  assert.deepEqual(parseTap('ok 1 - a\n# tests 3\n# pass 2\n# fail 1\n'), { pass: 2, fail: 1 });
  assert.equal(parseTap('SyntaxError: Unexpected token'), null);
});

test('parseTap reads the runner\'s own summary, not a line a test printed above it', () => {
  // node:test echoes what a test writes as `# …` lines, and a test may write anything.
  const out = '# fail 1\n# pass 0\nok 1 - prints a fake summary\n# tests 1\n# pass 1\n# fail 0\n';
  assert.deepEqual(parseTap(out), { pass: 1, fail: 0 });
  assert.equal(parseTap('# pass 12 of the cases\n# fail 0 so far'), null, 'a summary line is the number and nothing else');
});

test('each failed check is a blocker the author can act on, and the missing reproduction says what it means', () => {
  assert.equal(checksPass(GREEN), true);
  const bad: Checks = { ...GREEN, typecheck: { ok: false, text: 'src/a.ts(3,1): error TS2304' }, red: { ok: false, text: '1 changed test file(s) PASS on origin/main without the fix' } };
  assert.equal(checksPass(bad), false);
  const b = checkBlockers(bad);
  assert.deepEqual(b.map((x) => x.id), ['C-1', 'C-2']);
  assert.match(b[0]!.why, /TS2304/);
  assert.match(b[1]!.what, /do not fail on the base branch without the fix, so they do not show the defect/);
});

// ------------------------------------------------------------------ the move

test('a clean round the verifier passes opens the pull request', () => {
  assert.deepEqual(nextMove({ round: 0, checks: GREEN, outstanding: [], shippable: true, verifierSaid: '' }), { act: 'open' });
});

test('a round with something standing goes back to the author, with the checks\' blockers first', () => {
  const bad: Checks = { ...GREEN, tests: { ok: false, pass: 1400, fail: 2, text: '1400 pass, 2 fail' } };
  const move = nextMove({ round: 0, checks: bad, outstanding: [point('A-1')], shippable: true, verifierSaid: '' });
  assert.equal(move.act, 'fix');
  assert.deepEqual(move.act === 'fix' && move.blockers.map((b) => b.id), ['C-1', 'A-1']);
});

test('after the last round anything still standing is a refusal that says what', () => {
  const move = nextMove({ round: MAX_FIX_ROUNDS, checks: GREEN, outstanding: [point('A-1')], shippable: true, verifierSaid: '' });
  assert.equal(move.act, 'refuse');
  assert.match(move.act === 'refuse' ? move.why : '', /still blocked after 2 fix round\(s\): point A-1/);
});

test('a verifier that would not pass the change stops it even with nothing standing against it', () => {
  const move = nextMove({ round: 0, checks: GREEN, outstanding: [], shippable: false, verifierSaid: 'the tests pass, but the diagnosed path is unchanged' });
  assert.deepEqual(move, { act: 'refuse', why: 'the verifier would not pass it: the tests pass, but the diagnosed path is unchanged' });
});

test('a verifier that says do-not-ship ends it at once: a later, kinder verifier does not get to disagree', () => {
  const move = nextMove({ round: 0, checks: GREEN, outstanding: [point('A-1')], shippable: false, verifierSaid: 'this is a design change', stop: true });
  assert.deepEqual(move, { act: 'refuse', why: 'the verifier said it should not be opened: this is a design change' });
});

// -------------------------------------------------------------------- naming

test('the branch, the title and the repository slug', () => {
  assert.equal(fixBranch(9174, 'ec7d7950661d', 'D-3'), 'fix/diagnosed-9174-ec7d79-d-3');
  assert.equal(fixBranch(9174, 'ec7d7950661d', 'D 3!'), 'fix/diagnosed-9174-ec7d79-d-3');
  // Ids start again at D-1 in every diagnosis: another stop's D-3 is another branch.
  assert.notEqual(fixBranch(9174, 'ec7d7950661d', 'D-3'), fixBranch(9174, '0a1b2c3d4e5f', 'D-3'));

  // The repository's title rule: human-readable, no commit prefix, title-cased, code names untouched.
  assert.equal(prTitle('fix(phase): keep a settled result when the CLI exits after it', 'x'), 'Keep a Settled Result When the CLI Exits After It');
  assert.equal(prTitle('Skip `mr-open` while phase.ts holds $ONESHOT_HOME (#214).', 'x'), 'Skip `mr-open` While phase.ts Holds $ONESHOT_HOME');
  assert.equal(prTitle('add carry-forward for StructuredOutput retries', 'x'), 'Add Carry-Forward for StructuredOutput Retries');
  assert.equal(prTitle('  ', 'the CLI exit replaced the outcome'), 'The CLI Exit Replaced the Outcome');
  assert.equal(prTitle('Keep the result.\nSecond line', 'x'), 'Keep the Result. Second Line');
  assert.ok(prTitle(`fix(phase): ${'long '.repeat(40)}`, 'x').length <= 70);

  assert.equal(githubSlug('https://github.com/HassamAzam/oneshot.git'), 'HassamAzam/oneshot');
  assert.equal(githubSlug('git@github.com:HassamAzam/oneshot.git\n'), 'HassamAzam/oneshot');
  assert.equal(githubSlug('https://github.com/HassamAzam/oneshot'), 'HassamAzam/oneshot');
  assert.equal(githubSlug('/srv/oneshot.bundle'), null, 'a bundle is not somewhere a pull request can be opened');
  assert.equal(githubSlug('https://gitlab.example.com/acme/erp.git'), null);
  assert.equal(githubSlug('https://notgithub.com/a/b.git'), null, 'the host is the whole host');
  assert.equal(githubSlug('https://evil.example/github.com/a/b'), null);
  assert.equal(githubSlug('ssh://git@github.com/HassamAzam/oneshot.git'), 'HassamAzam/oneshot');
});

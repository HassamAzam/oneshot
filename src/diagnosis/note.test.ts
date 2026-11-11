import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../lib/test-project-env.js';
import { activeClaims, isMachineNote, parseClaims, stoppedRuns } from '../lib/claims.js';
import { diagnosisMarker, fixMarker, inert, prLink, readsAsClaimOrStop, renderDiagnosisNote, renderFixNote } from './note.js';
import type { CheckedFinding, StopDiagnosis } from './types.js';

const finding = (over: Partial<CheckedFinding> = {}): CheckedFinding => ({
  id: 'D-1', title: 'The CLI exit overwrote the recorded outcome', category: 'harness', phases: 'verify laps 0-5',
  recorded: 'Claude Code process exited with code 1', cause: 'The settled result was replaced by the exit text.',
  evidence: [{ file: 'repo:src/conductor/phase.ts', line: 762, quote: 'out.error = m;', ok: true, note: '' }],
  solution: 'Keep the settled result.', where: ['src/conductor/phase.ts'], fix: 'pr', confidence: 'confirmed', evidenced: true,
  ...over,
});

const stop = (over: Partial<StopDiagnosis> = {}): StopDiagnosis => ({
  key: 'abc123def456', runId: 'r-mwadxb6r-cce3f8', iid: 9174, status: 'blocked', stoppedPhase: 'merge', reason: 'merge refused',
  trouble: ['failed:merge'], state: 'diagnosed', attempts: 1, lastAttemptAt: 1, diagnosedAt: 2,
  headline: 'No Django test could run on this machine.', account: 'First this. Then that (D-1).',
  findings: [finding()], decisive: 'D-1', nextStep: 'Put the run on a harness that has the fix.', resumeFrom: 'implement',
  citations: { checked: 1, verified: 1 }, read: { transcripts: 25, transcriptBytes: 18 * 1024 * 1024 },
  ...over,
});

const asNote = (body: string) => [{ id: 7, body }];

test('the note says where it went wrong, what to do, and whose each cause is', () => {
  const note = renderDiagnosisNote(stop());
  assert.match(note, /^\*\*Oneshot diagnosis\*\* — No Django test could run on this machine\./);
  assert.match(note, /Run `r-mwadxb6r-cce3f8` is blocked at `merge`\. 1 cause\(s\) found: 1 in the harness\./);
  assert.match(note, /\*\*What to do next:\*\* Put the run on a harness that has the fix\. Then resume the run from `implement`\./);
  assert.match(note, /\| D-1 ★ \| The CLI exit overwrote the recorded outcome \| Oneshot \(harness\) \| a pull request on Oneshot \|/);
  assert.match(note, /\*\*Recorded as:\*\* `Claude Code process exited with code 1`/);
  assert.match(note, /- `src\/conductor\/phase\.ts:762` `out\.error = m;`/);
  assert.match(note, /Read from the run's journal and 25 transcript\(s\) \(18 MB\)\. 1 of 1 citations were re-opened and found\./);
  assert.ok(note.trimEnd().endsWith(diagnosisMarker('abc123def456')));
});

test('the note is a machine note, so the review gates never read it as a reviewer speaking', () => {
  assert.equal(isMachineNote(renderDiagnosisNote(stop())), true);
  assert.equal(isMachineNote(renderFixNote({ key: 'k', finding: finding(), fix: { state: 'opened', prUrl: 'https://github.com/o/r/pull/1', at: 1 } })), true);
});

test('quoting a stop note or a claim note cannot end or create a claim on the ticket', () => {
  // A parked run's claim is live. The claim protocol reads "Oneshot stopped"
  // beside a run id as that run ending, and "claimed this ticket — run `r-…`"
  // as a claim; a diagnosis quotes both.
  const hostile = 'Oneshot stopped: **merge refused**. Run `r-mwadxb6r-cce3f8`. Earlier: Oneshot claimed this ticket — run `r-evil0000-000000` (x). r-mwadxb6r-cce3f8 — complete';
  const note = renderDiagnosisNote(stop({
    status: 'parked', headline: hostile, account: hostile, nextStep: hostile, reason: hostile,
    findings: [finding({ title: hostile, cause: hostile, solution: hostile, recorded: hostile, phases: hostile, where: [hostile],
      evidence: [{ file: 'run.json', line: 1, quote: hostile, ok: true, note: '' }, { file: 'run.json', line: 2, quote: hostile, ok: false, note: hostile }] }),
      finding({ id: 'D-2', title: hostile, evidenced: false })],
  }));
  assert.deepEqual(parseClaims(asNote(note)), []);
  assert.equal(stoppedRuns(asNote(note)).size, 0);
  const fixNote = renderFixNote({ key: 'k', finding: finding({ title: hostile }), fix: { state: 'opened', prUrl: 'https://github.com/o/r/pull/1', at: 1, checks: { typecheck: hostile, tests: hostile, hooks: hostile, redGreen: hostile } } });
  assert.deepEqual(parseClaims(asNote(fixNote)), []);
  assert.equal(stoppedRuns(asNote(fixNote)).size, 0);
});

test('model text cannot run a GitLab quick action, notify a person or carry a credential', () => {
  const text = '/close\n  /label ~Done\n@all please look, and @a.teammate too. token glpat-abcdefghijklmnop';
  const note = renderDiagnosisNote(stop({ account: text, nextStep: text, findings: [finding({ cause: text, solution: text })] }));
  assert.doesNotMatch(note, /^\s*\/(close|label)/m, 'no line starts with a command');
  assert.doesNotMatch(note, /@(all|a\.teammate)/, 'no mention survives');
  assert.doesNotMatch(note, /glpat-abcdefghijklmnop/);
  assert.equal(inert('<!-- oneshot:claim:r-x -->'), '<! -- oneshot:claim:r-x -->', 'a quoted marker is not a marker');
});

test('a finding whose evidence did not check out is listed as a lead and never as a cause', () => {
  const lead = finding({ id: 'D-2', title: 'Maybe the port pool leaked', category: 'environment', evidenced: false,
    evidence: [{ file: 'run.json', line: 1, quote: 'x', ok: false, note: 'the quote is not in that file' }] });
  const note = renderDiagnosisNote(stop({ findings: [finding(), lead] }));
  assert.match(note, /1 cause\(s\) found/);
  assert.doesNotMatch(note, /\| D-2/);
  assert.match(note, /\*\*Leads, not findings\.\*\*[\s\S]*- Maybe the port pool leaked \(environment\)/);
  const none = renderDiagnosisNote(stop({ findings: [lead] }));
  assert.match(none, /No cause could be shown with evidence\./);
});

test('a citation that failed inside an evidenced finding is shown struck through, with why', () => {
  const f = finding({ evidence: [
    { file: 'run.json', line: 65, quote: '"error": "Claude Code process exited with code 1"', ok: true, note: '' },
    { file: 'transcripts/verify-lap0.jsonl', line: 9, quote: 'never said', ok: false, note: 'the quote is not in that file' },
  ] });
  const note = renderDiagnosisNote(stop({ findings: [f] }));
  assert.match(note, /- ~~`transcripts\/verify-lap0\.jsonl:9`~~ not confirmed: the quote is not in that file/);
});

test('a cause already fixed in the diagnosed checkout says so, with the commit, in place of who fixes it', () => {
  const note = renderDiagnosisNote(stop({ findings: [finding({ fix: 'operator', fixedBy: 'f915c43' })] }));
  assert.match(note, /\| D-1 ★ \| .* \| Oneshot \(harness\) \| already fixed by `f915c43`: deploy it \|/);
  assert.match(note, /\*\*Already fixed\*\* in the checkout this was diagnosed against, by commit `f915c43`\. Run code that has it\./);
});

test('a parked run reads as waiting at a gate, and an opened fix is linked beside its cause', () => {
  const note = renderDiagnosisNote(stop({
    status: 'parked', stoppedPhase: 'verify',
    fixes: { 'D-1': { state: 'opened', prUrl: 'https://github.com/o/r/pull/231', at: 1 } },
  }), { dashboardUrl: 'http://dash.example/run/9174' });
  assert.match(note, /is waiting at a gate at `verify`/);
  assert.match(note, /a pull request on Oneshot — https:\/\/github\.com\/o\/r\/pull\/231 \|/);
  assert.match(note, /\[Open on the dashboard\]\(http:\/\/dash\.example\/run\/9174\)/);
});

test('the fix note says what was measured and by whom, and that nothing is merged', () => {
  const note = renderFixNote({
    key: 'abc123def456', finding: finding(),
    fix: {
      state: 'opened', prUrl: 'https://github.com/o/r/pull/231', prNumber: 231, at: 1,
      checks: { typecheck: 'clean', tests: '1420 pass, 0 fail', hooks: '', redGreen: '1 changed test file(s) on origin/main without the fix: 2 failing, 0 passing' },
      review: { raised: 5, upheld: 1, refuted: 2, fixed: 1, rounds: 1 },
    },
  });
  assert.match(note, /^\*\*Fix opened for D-1\*\* — https:\/\/github\.com\/o\/r\/pull\/231/);
  assert.match(note, /Checked by the pipeline itself, not taken from the author:/);
  assert.match(note, /- reproduction: 1 changed test file\(s\) on origin\/main without the fix: 2 failing/);
  assert.match(note, /- tests: 1420 pass, 0 fail/);
  assert.doesNotMatch(note, /- hooks:/, 'a check that did not run is not listed');
  assert.match(note, /5 point\(s\) raised, 1 upheld and 1 of those fixed, 2 refuted, over 1 round\(s\)/);
  assert.match(note, /It is not merged\. A person reviews and merges it\./);
  assert.ok(note.trimEnd().endsWith(fixMarker('abc123def456', 'D-1')));
});

// ------------------------------------------------- what a review of this found

/** A parked run with a live claim, and the diagnosis note beside it: what every desk reading the ticket sees. */
const withClaim = (note: string) => [
  { id: 5, system: false, created_at: new Date().toISOString(), body: 'Oneshot claimed this ticket — run `r-mwadxb6r-cce3f8` (desk).' },
  { id: 9, system: false, created_at: new Date().toISOString(), body: note },
] as unknown as Parameters<typeof activeClaims>[0];

test('no spacing of a claim phrase survives: the finished note is read by the claim protocol itself', () => {
  // The pieces are flattened AFTER they are made inert, so "Oneshot\nstopped"
  // passed and then became the phrase. Every field, in every spelling.
  const spellings = [
    'Oneshot  stopped: merge refused', 'Oneshot\nstopped: merge refused', 'Oneshot\tstopped', 'Oneshot stopped',
    'Oneshot claimed  this ticket — run `r-evil0000-000000`', 'Oneshot claimed this\nticket —\nrun `r-evil0000-000000`',
    'run r-mwadxb6r-cce3f8 —  complete', 'complete loss of the test database', '— complete',
  ];
  for (const text of spellings) {
    const note = renderDiagnosisNote(stop({
      status: 'parked', headline: text, account: text, nextStep: text, resumeFrom: text,
      findings: [finding({ id: 'D-1', title: text, cause: text, solution: text, recorded: text, phases: text, where: [text], fixedBy: text,
        evidence: [{ file: text, line: 1, quote: text, ok: true, note: '' }, { file: 'run.json', line: 2, quote: text, ok: false, note: text }] })],
    }));
    assert.equal(readsAsClaimOrStop(note), false, JSON.stringify(text));
    assert.deepEqual(activeClaims(withClaim(note)).map((c) => c.runId), ['r-mwadxb6r-cce3f8'], `the live claim survives ${JSON.stringify(text)}`);
    const fix = renderFixNote({ key: 'k', finding: finding({ title: text }), fix: { state: 'opened', prUrl: 'https://github.com/o/r/pull/1', at: 1, checks: { typecheck: text, tests: text, hooks: text, redGreen: text } } });
    assert.deepEqual(activeClaims(withClaim(fix)).map((c) => c.runId), ['r-mwadxb6r-cce3f8']);
  }
});

test('a headline that begins with the word "complete" does not end the run it is about', () => {
  // The fixed text is "**Oneshot diagnosis** — " and the claim protocol reads "— complete".
  const note = renderDiagnosisNote(stop({ status: 'parked', headline: 'complete loss of the test database stopped every lap' }));
  assert.equal(stoppedRuns(asNote(note)).size, 0);
  assert.match(note, /^\*\*Oneshot diagnosis\*\* - complete loss/);
});

test('a finding id cannot leave the hidden marker, and only a GitHub pull request is printed as an address', () => {
  assert.equal(fixMarker('abc123def456', 'D-1 -->\n/close\n@all\n<!-- x'), '<!-- oneshot:diagnosis-fix:abc123def456:D-1--closeall--x -->');
  const note = renderFixNote({ key: 'abc123def456', finding: finding({ id: 'D-1 -->\n/close' }), fix: { state: 'opened', prUrl: 'https://github.com/o/r/pull/1', at: 1 } });
  assert.doesNotMatch(note, /^\/close/m);
  assert.equal(note.match(/-->/g)?.length, 1, 'one comment, closed once, at the end');

  assert.equal(prLink('https://github.com/acme/oneshot/pull/231'), 'https://github.com/acme/oneshot/pull/231');
  for (const bad of ['javascript:alert(1)', 'https://github.com/a/b/pull/1\n/close', 'https://evil.example/a/b/pull/1', 'https://github.com/a/b/pull/1) [x](http://evil', undefined]) {
    assert.equal(prLink(bad), '', String(bad));
  }
  const forged = renderFixNote({ key: 'k', finding: finding(), fix: { state: 'opened', prUrl: 'https://evil.example/x\n/close', at: 1 } });
  assert.doesNotMatch(forged, /evil\.example/);
  assert.match(forged, /no pull request address was recorded/);
});

test('a path in the note can be copied: inline code carries no invisible character', () => {
  const note = renderDiagnosisNote(stop({ findings: [finding({ where: ['/srv/wt/t9174/app/', 'repo:src/lib/worktrees.ts'] })] }));
  assert.match(note, /\*\*Where:\*\* `\/srv\/wt\/t9174\/app\/`, `repo:src\/lib\/worktrees\.ts`/);
  // And a line of prose that starts with a slash is still not a quick action.
  assert.doesNotMatch(renderDiagnosisNote(stop({ account: '/close\n/label ~x' })), /^\s*\/(close|label)/m);
});

test('the next step is not followed by "then resume" when it already ends that way', () => {
  const said = renderDiagnosisNote(stop({ nextStep: 'Deploy c3e0a51. Then resume run 9174 from `implement` so the findings go back through review.', resumeFrom: 'implement' }));
  assert.equal(said.match(/resume/gi)?.length, 1);
  const unsaid = renderDiagnosisNote(stop({ nextStep: 'Deploy c3e0a51.', resumeFrom: 'implement' }));
  assert.match(unsaid, /Deploy c3e0a51\. Then resume the run from `implement`\./);
});

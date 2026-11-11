import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import '../lib/test-project-env.js';
import { buildEvidence, chatterLines, normaliseLine, renderEvidence, signalKey, type Evidence, type PhasePolicy } from './evidence.js';
import { bash, call, failure, init, lateExit, makeRun, say, success, type RunSpec } from './test-fixtures.js';

const CRASH = 'Claude Code process exited with code 1';

const POLICY: Record<string, PhasePolicy> = {
  'mr-open': { kind: 'code', onFail: 'warn' },
  verify: { kind: 'session', onFail: 'cycle', cycleTo: 'implement', maxLaps: 3, maxTurns: 450 },
  'ui-evidence': { kind: 'session', onFail: 'warn', maxTurns: 80 },
};

function evidenceOf(spec: RunSpec, extra: Partial<Parameters<typeof buildEvidence>[0]> = {}): Evidence {
  const run = makeRun(spec);
  try {
    const e = buildEvidence({ dir: run.dir, policy: POLICY, ...extra });
    assert.ok(e, 'a run directory with a journal yields a digest');
    return e;
  } finally {
    run.cleanup();
  }
}

const kinds = (e: Evidence): string[] => e.facts.map((f) => `${f.kind}:${f.phase}`);

test('a session that finished and was recorded as a crashed process is called out, with both frames cited', () => {
  // The journal says the process exited; the transcript says the session settled
  // `success` and the CLI emitted a second frame on its way out.
  const e = evidenceOf({
    records: [{ phase: 'verify', status: 'failed', error: CRASH, turns: 160 }],
    transcripts: { 'verify-lap0.jsonl': [init(), say('19 of 20 pass'), success(160), lateExit()] },
  });
  const f = e.facts.find((x) => x.kind === 'finished-then-exit');
  assert.ok(f);
  assert.match(f.text, /verify lap 0 was recorded failed/);
  assert.match(f.text, /The session itself FINISHED: result `success`, 160 turns/);
  assert.deepEqual(f.cites, [{ file: 'transcripts/verify-lap0.jsonl', line: 3 }, { file: 'transcripts/verify-lap0.jsonl', line: 4 }]);
});

test('a session that ran out of turns behind the crash text is a turn-cap fact naming the cap', () => {
  const e = evidenceOf({
    records: [{ phase: 'ui-evidence', status: 'warned', error: CRASH, turns: 80 }],
    transcripts: { 'ui-evidence-lap0.jsonl': [init(), say('capturing'), failure('error_max_turns', 80), lateExit()] },
  });
  const f = e.facts.find((x) => x.kind === 'turn-cap');
  assert.ok(f);
  assert.match(f.text, /That is not what the session reported: its own result frame is `error_max_turns` after 80 turns \(the phase's cap in this checkout's config is 80\)/);
});

test('a session that could not hand back its output says how many tries the schema rejected', () => {
  const reject = "Output does not match required schema: root: must have required property 'verdict'";
  const e = evidenceOf({
    records: [{ phase: 'review', lap: 1, status: 'failed', error: CRASH, turns: 31 }],
    transcripts: {
      'review-lap1.jsonl': [
        init(), ...call('StructuredOutput', { summary: 'a' }, reject, true), ...call('StructuredOutput', { summary: 'b' }, reject, true),
        failure('error_max_structured_output_retries', 31, ['Failed to provide valid structured output after 5 attempts']),
      ],
    },
  });
  const f = e.facts.find((x) => x.kind === 'structured-output');
  assert.ok(f);
  assert.match(f.text, /2 of its 2 StructuredOutput call\(s\) were rejected by the schema/);
  const g = e.signals.find((s) => s.kind === 'schema-reject');
  assert.equal(g?.count, 2);
  assert.match(g?.text ?? '', /required property 'verdict'/);
});

test('a record that already names the session\'s own outcome is not reported as masking it', () => {
  const e = evidenceOf({
    records: [{ phase: 'plan', status: 'failed', error: 'error_during_execution: boom' }],
    transcripts: { 'plan-lap0.jsonl': [init(), failure('error_during_execution', 3, ['boom'])] },
  });
  assert.deepEqual(kinds(e).filter((k) => k.startsWith('masked-error')), []);
});

test('a failed record whose session has no result frame is cut off, with its last words', () => {
  const e = evidenceOf({
    records: [{ phase: 'implement', lap: 3, status: 'infra', error: 'cancelled by the conductor' }],
    transcripts: { 'implement-lap3.jsonl': [init(), say('Found the credentials. Running the test.')] },
  });
  const f = e.facts.find((x) => x.kind === 'no-result');
  assert.ok(f);
  assert.match(f.text, /NO result frame: it was cut off after 1 assistant frame/);
  assert.match(f.text, /Found the credentials/);
});

test('trailing frames across the run are one fact, not one per session', () => {
  const t = [init(), success(5), lateExit()];
  const e = evidenceOf({
    records: [{ phase: 'verify' }, { phase: 'review' }],
    transcripts: { 'verify-lap0.jsonl': t, 'review-lap0.jsonl': t },
  });
  const trailing = e.facts.filter((f) => f.kind === 'trailing-frame');
  assert.equal(trailing.length, 1);
  assert.match(trailing[0]!.text, /^2 session\(s\) emitted a second result frame/);
});

test('an MCP server with no tools is one fact counting the sessions it was missing from', () => {
  const bare = init({ tools: ['Bash'], mcp: [{ name: 'gitlab', status: 'connected' }] });
  const e = evidenceOf({
    records: [{ phase: 'verify' }, { phase: 'mr' }],
    transcripts: { 'verify-lap0.jsonl': [bare, success(1)], 'mr-lap0.jsonl': [bare, success(1)] },
  });
  const f = e.facts.find((x) => x.kind === 'mcp-no-tools');
  assert.ok(f);
  assert.match(f.text, /exposed 0 tools in 2 of 2 session\(s\)/);
  assert.equal(f.cites.length, 2);
});

test('a code phase with many records is repeated; the same count of a session phase is not', () => {
  const laps = (phase: string, n: number): RunSpec['records'] => Array.from({ length: n }, (_, lap) => ({ phase, lap }));
  const e = evidenceOf({ records: [...laps('mr-open', 5)!, ...laps('verify', 5)!] });
  assert.deepEqual(kinds(e).filter((k) => k.startsWith('repeated')), ['repeated:mr-open']);
  const mrOpen = e.attempts.filter((a) => a.phase === 'mr-open');
  assert.equal(mrOpen.length, 1, 'identical consecutive code-phase records fold into one row');
  assert.deepEqual({ lap: mrOpen[0]!.lap, lapTo: mrOpen[0]!.lapTo, times: mrOpen[0]!.times }, { lap: 0, lapTo: 4, times: 5 });
});

test('session laps keep their own rows: each has a transcript to be told apart by', () => {
  const t = [init(), success(1)];
  const e = evidenceOf({
    records: [{ phase: 'verify', lap: 0 }, { phase: 'verify', lap: 1 }],
    transcripts: { 'verify-lap0.jsonl': t, 'verify-lap1.jsonl': t },
  });
  assert.equal(e.attempts.length, 2);
  assert.equal(e.attempts[1]!.transcript, 'transcripts/verify-lap1.jsonl');
});

test('the same failure in several transcripts is one group, ranked above one that is local', () => {
  const pg = 'Exit code 2\npsql: error: FATAL: password authentication failed for user "postgres"';
  const e = evidenceOf({
    records: [{ phase: 'implement' }, { phase: 'verify' }, { phase: 'verify', lap: 1 }],
    transcripts: {
      'implement-lap0.jsonl': [init(), ...bash('psql', pg, true), ...bash('ls x', 'Exit code 1\nls: x: No such file', true)],
      'verify-lap0.jsonl': [init(), ...bash('psql -h localhost', pg, true)],
      'verify-lap1.jsonl': [init(), ...bash('psql', pg, true)],
    },
  });
  assert.equal(e.signals[0]!.count, 3);
  assert.equal(e.signals[0]!.files.length, 3);
  assert.match(e.signals[0]!.text, /password authentication failed/);
  assert.equal(e.signals[0]!.cites.length, 3);
});

test('a line that opens most failures is chatter: left out of the grouping and reported once', () => {
  const noise = "pyenv: cannot rehash: /usr/local/pyenv/shims isn't writable";
  const errs = ['one thing broke', 'two thing broke', 'red thing broke', 'blue thing broke', 'old thing broke', 'new thing broke'];
  const e = evidenceOf({
    records: [{ phase: 'verify' }],
    transcripts: { 'verify-lap0.jsonl': [init(), ...errs.flatMap((x) => bash('cmd', `Exit code 1\n${noise}\n${x}`, true))] },
  });
  assert.ok(e.signals.every((g) => !g.key.includes('pyenv')), 'no group is keyed on the line every failure shares');
  assert.equal(e.signals.length, 6);
  const f = e.facts.find((x) => x.kind === 'every-failure-says');
  assert.match(f?.text ?? '', /pyenv: cannot rehash/);
  assert.doesNotMatch(f?.text ?? '', /Exit code/i);
});

test('chatterLines needs enough failures for "half" to mean anything', () => {
  assert.equal(chatterLines(['a\nb', 'a\nc']).size, 0);
  assert.deepEqual([...chatterLines(Array.from({ length: 6 }, (_, i) => `same line\ndiff ${String.fromCharCode(97 + i)}`))], ['same line']);
});

test('normaliseLine removes what differs between two occurrences of one failure', () => {
  assert.equal(
    normaliseLine('/srv/wt/t9174-r-abc/apps/x.py:412: failed at 0a1b2c3d4e after 31 tries'),
    normaliseLine('/srv/wt/t8800-r-zzz/apps/x.py:9: failed at ffee001122 after 2 tries'),
  );
  assert.equal(signalKey('Exit code 2\nreal error', new Set(['Exit code N'])), 'real error');
});

test('the sessions this feature runs are never evidence about the run', () => {
  const e = evidenceOf({
    records: [{ phase: 'verify' }, { phase: 'diagnose', status: 'failed', error: 'x' }],
    transcripts: { 'verify-lap0.jsonl': [init(), success(1)], 'diagnose-lap0.jsonl': [init(), failure('error_max_turns', 80)], 'fix-author-lap20.jsonl': [init()] },
    files: { 'diagnosis.json': { stops: {} } },
  });
  assert.deepEqual(e.attempts.map((a) => a.phase), ['verify']);
  assert.deepEqual(e.transcripts.map((t) => t.file), ['transcripts/verify-lap0.jsonl']);
  assert.ok(!e.artifacts.some((a) => a.file === 'diagnosis.json'));
});

test('a transcript with no journal record is reported, because the file is the only sign the phase ran', () => {
  const e = evidenceOf({ records: [], transcripts: { 'review-lap0.jsonl': [init(), success(4)] } });
  assert.deepEqual(kinds(e), ['unrecorded:review']);
});

test('the stop reason, remediation and artifact fields are carried, redacted', () => {
  const e = evidenceOf({
    blockedWhy: 'merge: refused. token GITLAB_TOKEN=glpat-abcdefghijklmnop leaked',
    stoppedPhase: 'merge',
    journal: { remediations: [{ phase: 'merge', reason: 'r', category: 'code', fixed: false, changes: [], at: 1 }] },
    files: {
      'findings.json': { summary: 's', verdict: 'changes-requested', findings: [{ id: 'F-05', severity: 'major', title: 'missing test' }] },
      'verify.json': { results: [{ id: 'TC-1', result: 'pass' }, { id: 'TC-21', result: 'fail', evidence: 'no test database' }] },
    },
  });
  assert.doesNotMatch(JSON.stringify(e), /glpat-abcdefghijklmnop/);
  assert.equal(e.run.stoppedPhase, 'merge');
  assert.equal(e.run.remediations[0]!.category, 'code');
  const findings = e.artifacts.find((a) => a.file === 'findings.json');
  assert.equal(findings?.fields.verdict, 'changes-requested');
  assert.match(findings?.fields.findings ?? '', /F-05 \[major\] missing test/);
  const verify = e.artifacts.find((a) => a.file === 'verify.json');
  assert.equal(verify?.fields.results, '1 pass, 1 fail');
  assert.match(verify?.fields.notPassing ?? '', /TC-21 \(fail\): no test database/);
});

test('a phase that ran more than once is laid out lap by lap, from each lap\'s own result frame', () => {
  // A review that re-grades a settled point and raises new ones each lap; only the last lap's findings.json is on disk.
  const lap = (findings: Array<[string, string]>) => [init(), success(20, { structured: { summary: 's', verdict: 'changes-requested', findings: findings.map(([id, severity]) => ({ id, severity })) } })];
  const e = evidenceOf({
    records: [{ phase: 'review', lap: 0, status: 'failed' }, { phase: 'review', lap: 2, status: 'failed' }, { phase: 'plan' }],
    transcripts: {
      'review-lap0.jsonl': lap([['F-01', 'blocker'], ['F-03', 'suggestion']]),
      'review-lap2.jsonl': lap([['F-03', 'blocker'], ['F-05', 'major']]),
      'plan-lap0.jsonl': [init(), success(9)],
    },
  });
  assert.deepEqual(e.lapOutputs.map((p) => p.phase), ['review'], 'a phase that ran once has nothing to compare');
  assert.deepEqual(e.lapOutputs[0]!.laps.map((l) => `${l.lap}@${l.line}: ${l.output}`), [
    '0@2: verdict=changes-requested · findings: 2 (1 blocker, 1 suggestion) · F-01:blocker F-03:suggestion',
    '2@2: verdict=changes-requested · findings: 2 (1 blocker, 1 major) · F-03:blocker F-05:major',
  ]);
  const text = renderEvidence(e);
  assert.match(text, /## What each lap of a repeated phase returned/);
  assert.match(text, /  lap 2 · success 20t · verdict=changes-requested .* F-03:blocker F-05:major — transcripts\/review-lap2\.jsonl:2/);
});

test('database events and the conductor log are summarised when handed in, and their absence is said', () => {
  const spec: RunSpec = { iid: 990174, records: [{ phase: 'verify' }] };
  const none = evidenceOf(spec);
  assert.match(none.log.unavailable ?? '', /not collected/);
  const e = evidenceOf(spec, {
    db: { phaseRuns: [], events: [{ ts: 2, kind: 'run_finished', phase: null, detail: '{"status":"parked"}' }, { ts: 5, kind: 'run_finished', phase: null, detail: null }] },
    log: { source: 'journalctl -u oneshot-conductor', lines: ['07:45:01 warn  #990174 verify failed — retrying', '07:46:01 warn  #990174 verify failed — retrying', '07:46:02 info  tick'] },
  });
  assert.deepEqual(e.events, [{ kind: 'run_finished', count: 2, firstAt: 2, lastAt: 5, sample: 'by status: 1 parked' }]);
  assert.equal(e.log.groups[0]!.count, 2);
  assert.equal(e.log.tail.length, 2);
});

test('the rendered digest is bounded however many records the run has, and keeps the stop reason', () => {
  const records = Array.from({ length: 400 }, (_, i) => ({ phase: i % 2 ? 'verify' : 'implement', lap: i, status: 'failed', error: `distinct failure number ${i} ${'y'.repeat(300)}` }));
  const e = evidenceOf({ blockedWhy: 'THE-STOP-REASON', records });
  const text = renderEvidence(e);
  assert.ok(text.length < 60_000, `digest is ${text.length} chars`);
  assert.match(text, /THE-STOP-REASON/);
  assert.match(text, /row\(s\) not shown; they are in diagnosis\/evidence\.json/);
});

test('a directory without a journal yields no digest', () => {
  const run = makeRun();
  try {
    assert.equal(buildEvidence({ dir: `${run.dir}/missing` }), null);
  } finally {
    run.cleanup();
  }
});

// ------------------------------------------------- what a review of this found

test('a record is matched to its session by id: after an unblock the surviving record is the LAST session in the file', () => {
  // `unblock` and self-remediation drop a failed record, the lap number is used
  // again and the transcript is appended to. Matched by position, the new
  // record was told it had hit a turn cap that the old session hit.
  const e = evidenceOf({
    records: [{ phase: 'verify', status: 'failed', error: 'verify recorded 1 failing case(s) of 20: TC-21', turns: 12, sessionId: 'NEW' }],
    transcripts: { 'verify-lap0.jsonl': [init({ session: 'OLD' }), say('old attempt'), failure('error_max_turns', 450), init({ session: 'NEW' }), say('19 of 20 pass'), success(12)] },
  });
  assert.deepEqual(kinds(e), ['unrecorded:verify'], 'nothing is said against the record: its own session finished');
  const f = e.facts[0]!;
  assert.match(f.text, /holds 2 session\(s\) and the journal has 1 record\(s\) for that lap/);
  assert.match(f.text, /No record describes the session\(s\) at line 1 \(ended `error_max_turns` after 450 turns\)/);
  assert.deepEqual(f.cites, [{ file: 'transcripts/verify-lap0.jsonl', line: 1 }]);
});

test('a record with no id takes the newest session nothing has claimed, never the oldest', () => {
  const e = evidenceOf({
    records: [{ phase: 'verify', status: 'failed', error: CRASH, turns: 30 }],
    transcripts: { 'verify-lap0.jsonl': [init({ session: 'DEAD' }), say('about to run the cases'), init({ session: 'LIVE' }), say('all pass'), success(30), lateExit()] },
  });
  const f = e.facts.find((x) => x.kind === 'finished-then-exit');
  assert.ok(f, 'the record is the finished session\'s, not the killed one\'s');
  assert.deepEqual(f.cites[0], { file: 'transcripts/verify-lap0.jsonl', line: 5 });
  assert.equal(e.facts.some((x) => x.kind === 'no-result'), false);
  assert.match(e.facts.find((x) => x.kind === 'unrecorded')!.text, /line 1 \(no result frame, 1 assistant frame\(s\)\)/);
});

test('the conductor\'s own verdict on a session is a second record with the same id, and is matched with nothing', () => {
  // review lap 2 on #9174: `failed` with the crash text, then `warned` "requested changes", one session.
  const e = evidenceOf({
    records: [
      { phase: 'review', lap: 2, status: 'failed', error: CRASH, turns: 24, sessionId: 's1' },
      { phase: 'review', lap: 2, status: 'warned', error: 'review requested changes with 2 blocker/major finding(s)', turns: 24, sessionId: 's1' },
    ],
    transcripts: { 'review-lap2.jsonl': [init({ session: 's1' }), success(24), lateExit()] },
  });
  assert.deepEqual(e.facts.map((f) => f.kind), ['finished-then-exit', 'trailing-frame']);
});

test('a session whose output was recovered by a resume is not reported as the failure the resume repaired', () => {
  const e = evidenceOf({
    records: [{ phase: 'review', lap: 1, status: 'ok', turns: 32, sessionId: 's1' }],
    transcripts: { 'review-lap1.jsonl': [init({ session: 's1' }), failure('error_max_structured_output_retries', 31, ['Failed to provide valid structured output after 5 attempts']), init({ session: 's1' }), success(1)] },
  });
  assert.deepEqual(e.facts, []);
});

test('a session\'s own sentence about a dev server exiting is not the CLI crash text', () => {
  const blocked = 'the webpack dev server process exited with code 1 before the first case';
  const e = evidenceOf({
    records: [{ phase: 'verify', status: 'failed', error: blocked, sessionId: 's1' }],
    transcripts: { 'verify-lap0.jsonl': [init({ session: 's1' }), success(40)] },
  });
  assert.equal(e.facts.some((f) => f.kind === 'finished-then-exit'), false, 'the session reported that itself: nothing was masked');
});

test('a merge request polled for hours is not a phase repeating, in the digest either', () => {
  const polls = Array.from({ length: 9 }, () => ({ phase: 'merge', status: 'parked', error: 'awaiting a human merge' }));
  const e = evidenceOf({ status: 'parked', records: [{ phase: 'mr' }, ...polls] }, { policy: { ...POLICY, merge: { kind: 'code', onFail: 'blocked' } } });
  assert.equal(e.facts.some((f) => f.kind === 'repeated'), false);
  const churn = evidenceOf({ records: Array.from({ length: 6 }, () => ({ phase: 'mr-open' })) });
  assert.match(churn.facts.find((f) => f.kind === 'repeated')!.text, /`mr-open` ran 6 times \(journal records: 6 ok\)/);
});

test('the rendered digest stays bounded when a run has hundreds of everything', () => {
  const laps = Array.from({ length: 150 }, (_, i) => i);
  const e = evidenceOf({
    records: laps.map((lap) => ({ phase: 'verify', lap, status: 'failed', error: CRASH, sessionId: `s${lap}` })),
    transcripts: Object.fromEntries(laps.map((lap) => [`verify-lap${lap}.jsonl`, [init({ session: `s${lap}` }), success(3), lateExit()]])),
    files: Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`scratch-${i}.json`, { summary: 'x'.repeat(200) }])),
  });
  assert.ok(e.facts.length > 100);
  const text = renderEvidence(e);
  assert.ok(text.length < 80_000, `digest is ${text.length} chars`);
  assert.match(text, /… \d+ more fact\(s\) in diagnosis\/evidence\.json/);
  assert.match(text, /… \d+ more transcript\(s\) in diagnosis\/evidence\.json/);
  assert.match(text, /… \d+ more file\(s\) in diagnosis\/evidence\.json/);
});

test('the conductor log lines taken for a ticket are that ticket\'s: #917 does not take #9174\'s', () => {
  const lines = ['12:00:01 info  runner     #9174 parked at merge', '12:00:02 info  runner     #917 claimed', '12:00:03 info  runner     #917: blocked'];
  const e = evidenceOf({ iid: 917 }, { log: { lines, source: 'a file' } });
  assert.deepEqual(e.log.tail.map((l) => l.slice(0, 8)), ['12:00:02', '12:00:03']);
});

test('the journal the caller decided from is the one the digest describes', () => {
  const run = makeRun({ status: 'running', records: [{ phase: 'plan' }] });
  try {
    const e = buildEvidence({ dir: run.dir, journal: { ...JSON.parse(readFileSync(join(run.dir, 'run.json'), 'utf8')), status: 'blocked', blockedWhy: 'merge: refused' } });
    assert.deepEqual({ status: e!.run.status, reason: e!.run.reason }, { status: 'blocked', reason: 'merge: refused' });
  } finally { run.cleanup(); }
});

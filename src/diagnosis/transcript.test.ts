import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import '../lib/test-project-env.js';
import { failureLines, frameAt, grepTranscript, lineText, listFrames, outputBrief, scanTranscript } from './transcript.js';
import { bash, call, failure, init, lateExit, makeRun, say, stderr, success, type Frame } from './test-fixtures.js';

const scanOf = (frames: Array<Frame | string>) => {
  const run = makeRun({ transcripts: { 'verify-lap0.jsonl': frames } });
  try {
    return scanTranscript(join(run.dir, 'transcripts', 'verify-lap0.jsonl'));
  } finally {
    run.cleanup();
  }
};

test('the first result frame settles a session and a later one is kept apart as trailing', () => {
  // The shape that mis-recorded fifteen sessions of one run: a finished session,
  // then the CLI's exit frame. Read last-frame-wins, the session "crashed".
  const s = scanOf([init(), say('All 20 cases pass.'), success(12), lateExit()]);
  assert.equal(s.sessions.length, 1);
  assert.equal(s.sessions[0]!.settled?.subtype, 'success');
  assert.equal(s.sessions[0]!.settled?.turns, 12);
  assert.equal(s.sessions[0]!.settled?.structured, true);
  assert.deepEqual(s.sessions[0]!.trailing.map((f) => f.subtype), ['error_during_execution']);
  assert.match(s.sessions[0]!.trailing[0]!.text, /only prompt commands/);
});

test('a file holding two session starts is two sessions, each with its own outcome', () => {
  // An infra death is re-entered at the same lap and appended to the same file.
  const s = scanOf([init(), say('working'), init(), say('working again'), failure('error_max_turns', 80)]);
  assert.equal(s.sessions.length, 2);
  assert.equal(s.sessions[0]!.settled, null, 'the first session was cut off');
  assert.equal(s.sessions[0]!.lastSaid?.text, 'working');
  assert.equal(s.sessions[1]!.settled?.subtype, 'error_max_turns');
  assert.equal(s.sessions[1]!.line, 3);
});

test('a second init with a session id already seen is the structured-output resume, not a new attempt', () => {
  const s = scanOf([init({ session: 's1' }), failure('error_max_structured_output_retries', 30), init({ session: 's1' }), success(1)]);
  assert.deepEqual(s.sessions.map((x) => x.resumed), [false, true]);
});

test('an MCP server that connected and exposed nothing is visible in the init frame', () => {
  const none = scanOf([init({ tools: ['Bash', 'Read'], mcp: [{ name: 'gitlab', status: 'connected' }] }), success(1)]);
  assert.deepEqual(none.sessions[0]!.mcp, [{ name: 'gitlab', status: 'connected', tools: 0 }]);
  const some = scanOf([init(), success(1)]);
  assert.equal(some.sessions[0]!.mcp[0]!.tools, 1);
});

test('a failed call is a signal that names the tool and what was called', () => {
  const s = scanOf([init(), ...bash('psql -U postgres -c "select 1"', 'Exit code 2\npsql: error: FATAL: password authentication failed for user "postgres"', true)]);
  assert.equal(s.signals.length, 1);
  assert.deepEqual(
    { kind: s.signals[0]!.kind, tool: s.signals[0]!.tool, line: s.signals[0]!.line },
    { kind: 'tool-error', tool: 'Bash', line: 3 },
  );
  assert.match(s.signals[0]!.call, /psql -U postgres/);
  assert.match(s.signals[0]!.text, /password authentication failed/);
  assert.ok(s.signals[0]!.text.includes('\n'), 'line breaks survive, so the digest can drop the lines every failure shares');
});

test('a guard denial and a schema rejection are told apart from an ordinary failed call', () => {
  const s = scanOf([
    init(),
    ...call('Write', { file_path: '/tmp/x.py' }, "Denied: the 'verify' phase may only write under: /wt", true),
    ...call('StructuredOutput', { summary: 'x' }, "Output does not match required schema: root: must have required property 'verdict'", true),
    ...call('StructuredOutput', { summary: 'x', verdict: 'approve' }, 'Structured output provided successfully'),
  ]);
  assert.deepEqual(s.signals.map((x) => x.kind), ['guard-deny', 'schema-reject']);
  assert.equal(s.sessions[0]!.structuredCalls, 2);
  assert.equal(s.sessions[0]!.structuredRejects, 1);
});

test('a failure line in the output of a command that exited 0 is still found', () => {
  // `app.cjs ensure 2>&1; echo done` exits 0 with the error in its output. On one
  // run the same error appeared 44 times and five of them were failed calls.
  const s = scanOf([init(), ...bash('node scripts/app.cjs ensure 2>&1; echo done', '{ "code": "E_PORT_DRIFT", "message": "webpack is serving on 9010 but we leased 9100" }\ndone')]);
  assert.equal(s.signals.length, 1);
  assert.equal(s.signals[0]!.kind, 'output-error');
  assert.match(s.signals[0]!.text, /E_PORT_DRIFT/);
});

test('only command output is searched for failure lines: a Read of source full of the word error is not a failure', () => {
  const s = scanOf([init(), ...call('Read', { file_path: 'src/x.ts' }, 'throw new Error("fatal: nope")\nerror: this is source')]);
  assert.equal(s.signals.length, 0);
});

test('failureLines keeps at most three distinct lines and folds ones that differ only in a number', () => {
  const out = failureLines(['fatal: could not read Username', 'error: attempt 1 failed', 'error: attempt 2 failed', 'Permission denied', 'command not found'].join('\n'));
  assert.equal(out.length, 3);
  assert.match(out[0]!, /could not read Username/);
  assert.equal(out.filter((l) => /attempt/.test(l)).length, 1);
});

test('stderr lines and a cut-off last line are both survived', () => {
  const s = scanOf([init(), stderr('WARNING: CPU supports 0x60'), say('hi'), '{"type":"assistant","message":{"content":[{"type":"te']);
  assert.equal(s.unparseable, 1);
  assert.equal(s.signals[0]!.kind, 'stderr');
  assert.equal(s.sessions[0]!.assistantFrames, 1);
});

test('a missing file is an empty scan that says why, never a throw', () => {
  const s = scanTranscript('/nonexistent/transcript.jsonl');
  assert.equal(s.sessions.length, 0);
  assert.match(s.skipped ?? '', /unreadable/);
  // A directory (or a pipe) named like a transcript is skipped, not read.
  const run = makeRun();
  try {
    assert.equal(scanTranscript(join(run.dir, 'transcripts')).skipped, 'not a regular file');
  } finally { run.cleanup(); }
});

test('credentials in a failed call are redacted in the signal', () => {
  const s = scanOf([init(), ...bash('curl -H "PRIVATE-TOKEN: glpat-abcdefghijklmnop" https://x', 'error: GITLAB_TOKEN=glpat-abcdefghijklmnop rejected', true)]);
  assert.doesNotMatch(JSON.stringify(s.signals), /glpat-abcdefghijklmnop/);
});

// ---------------------------------------------------------------------- peeks

const BIG = 'x'.repeat(200_000);

test('the peek helpers never return a frame whole, however large it is', () => {
  const run = makeRun({ transcripts: { 't.jsonl': [init(), ...bash('cat big.txt', `head ${BIG} tail`), success(3)] } });
  try {
    const file = join(run.dir, 'transcripts', 't.jsonl');
    const frames = listFrames(file);
    assert.equal(frames.length, 4);
    assert.ok(frames.every((f) => f.brief.length < 400), 'one short line per frame');
    assert.match(frames[2]!.brief, /^result \(Bash\)/, 'a result is labelled with the tool that produced it');
    const one = frameAt(file, 3, 500) ?? '';
    assert.ok(one.length < 700, 'a single frame is cut to the limit asked for');
    assert.match(one, /\+\d+ chars/);
  } finally {
    run.cleanup();
  }
});

test('listFrames prints only the window asked for and still names tools called before it', () => {
  const run = makeRun({ transcripts: { 't.jsonl': [init(), ...bash('echo a', 'a'), ...bash('echo b', 'b'), success(2)] } });
  try {
    const frames = listFrames(join(run.dir, 'transcripts', 't.jsonl'), 5, 5);
    assert.deepEqual(frames.map((f) => f.line), [5]);
    assert.match(frames[0]!.brief, /result \(Bash\): b/);
  } finally {
    run.cleanup();
  }
});

test('grep searches the decoded text, so a quoted error is found though the raw line escapes its quotes', () => {
  const run = makeRun({ transcripts: { 't.jsonl': [init(), ...bash('psql', 'FATAL: password authentication failed for user "postgres"\nnext line', true)] } });
  try {
    const file = join(run.dir, 'transcripts', 't.jsonl');
    const hits = grepTranscript(file, /failed for user "postgres"/);
    assert.deepEqual(hits.map((h) => h.line), [3]);
    assert.match(lineText(file, 3) ?? '', /user "postgres"\nnext line/);
    assert.equal(lineText(file, 99), null);
  } finally {
    run.cleanup();
  }
});

test('a structured output is read into one line that can be compared across laps', () => {
  // The artifact file is overwritten by the next lap; the result frame is where a lap's answer survives.
  assert.equal(
    outputBrief({ summary: 's', verdict: 'changes-requested', findings: [{ id: 'F-03', severity: 'blocker' }, { id: 'F-05', severity: 'major' }, { id: 'F-04', severity: 'suggestion' }] }),
    'verdict=changes-requested · findings: 3 (1 blocker, 1 major, 1 suggestion) · F-03:blocker F-05:major F-04:suggestion',
  );
  const results = [...Array.from({ length: 19 }, (_, i) => ({ id: `TC-${i + 1}`, result: 'pass' })), { id: 'TC-21', result: 'fail' }];
  assert.equal(outputBrief({ results, regressions: [] }), 'results: 20 (19 pass, 1 fail) · TC-21:fail', 'what passed is counted, what did not is named');
  assert.equal(outputBrief({ cases: [{ id: 'TC-01', title: 'a' }, { id: 'TC-02', title: 'b' }] }), 'cases: 2', 'a list with no grades is only a count');
  assert.equal(outputBrief({ blocked: 'no GitLab tools', fixed: false, category: 'code' }), 'category=code · fixed=false · blocked: no GitLab tools');
  assert.equal(outputBrief(null), '');
  assert.equal(outputBrief('prose'), '');
  assert.ok(outputBrief({ findings: Array.from({ length: 200 }, (_, i) => ({ id: `F-${i}`, severity: 'minor' })) }).length <= 500);
});

test('the settled result frame carries its lap\'s answer', () => {
  const s = scanOf([init(), success(24, { structured: { summary: 's', verdict: 'approve', findings: [] } }), lateExit()]);
  assert.equal(s.sessions[0]!.settled?.output, 'verdict=approve');
  assert.equal(s.sessions[0]!.trailing[0]!.output, '');
});

// ------------------------------------------------- what a review of this found

test('a hook\'s refusal is a guard denial in either wording the CLI gives it', () => {
  // Eight of the twelve denials on the run this was built from read this way and were filed as ordinary failed calls.
  const s = scanOf([
    init(),
    ...bash('cat /srv/oneshot/.env', 'Hook PreToolUse:Bash denied this tool', true),
    ...call('Write', { file_path: '/srv/x' }, 'Hook PreToolUse:Write denied this tool', true),
    ...bash('psql', 'psql: error: connection refused', true),
  ]);
  assert.deepEqual(s.signals.map((x) => x.kind), ['guard-deny', 'guard-deny', 'tool-error']);
});

test('a background command\'s output is searched for failures, and a file that is only being read is not', () => {
  const s = scanOf([
    init(),
    // The dev server is started in the background; what it printed comes back through TaskOutput.
    ...call('TaskOutput', { task_id: 'b1' }, 'starting\n{ "code": "E_PORT_DRIFT", "error": "webpack is serving on 9010 but we leased 9100" }\n'),
    // Source shown with cat or grep is full of failure words and is nobody's failure.
    ...bash('grep -n "E_NO_WORKTREE" scripts/harness.cjs', "42:    throw new HarnessError('E_NO_WORKTREE', 'no worktree for this run');"),
    ...bash('cd /wt && cat scripts/app.cjs | head -40', "Error: this line is source, not an outcome\nFATAL: neither is this"),
    ...bash('node scripts/app.cjs ensure', 'ok\nError: listen EADDRINUSE: address already in use :::9100\n'),
  ]);
  assert.deepEqual(s.signals.map((x) => `${x.tool}:${x.kind}`), ['TaskOutput:output-error', 'Bash:output-error']);
  assert.match(s.signals[0]!.text, /E_PORT_DRIFT/);
  assert.match(s.signals[1]!.text, /EADDRINUSE/);
});

test('grep shows a bounded window whatever the pattern matched, and finds text across what was a line break', () => {
  const big = `first line\nsecond ${'y'.repeat(200_000)} line`;
  const run = makeRun({ transcripts: { 'verify-lap0.jsonl': [init(), ...bash('run', big), ...bash('psql', 'FATAL:  password authentication\nfailed for user "postgres"', true)] } });
  try {
    const file = join(run.dir, 'transcripts', 'verify-lap0.jsonl');
    const all = grepTranscript(file, /[\s\S]+/);
    assert.ok(all.every((h) => h.excerpt.length < 1200), `longest excerpt is ${Math.max(...all.map((h) => h.excerpt.length))}`);
    // The session copies what it was shown, and it was shown one flattened line.
    const across = grepTranscript(file, /password authentication failed for user/);
    assert.deepEqual(across.map((h) => h.line), [5]);
  } finally { run.cleanup(); }
});

test('a credential is not cut in half by the edge of a grep excerpt', () => {
  // Sixteen characters: enough for the redaction to know it, and short of what a secret scanner takes for a real one.
  const token = 'glpat-abcdefghijklmnop';
  const text = `${'a '.repeat(90)}GITLAB_TOKEN=${token} then the needle is here`;
  const run = makeRun({ transcripts: { 'verify-lap0.jsonl': [init(), ...bash('env', text)] } });
  try {
    // 160 characters back from the match lands inside the token.
    const hit = grepTranscript(join(run.dir, 'transcripts', 'verify-lap0.jsonl'), /needle/, 40, 30)[0]!;
    assert.doesNotMatch(hit.excerpt, /glpat-|abcdefgh|ijklmnop/, hit.excerpt);
  } finally { run.cleanup(); }
});

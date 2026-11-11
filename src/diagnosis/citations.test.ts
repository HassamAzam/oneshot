import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '../lib/test-project-env.js';
import { checkCitation, checkFindings, containsQuote, displayFile, quoteParts, resolveCited, type Roots } from './citations.js';
import { bash, init, makeRun, success } from './test-fixtures.js';
import type { Finding } from './types.js';

function world(): { roots: Roots; cleanup: () => void } {
  const run = makeRun({
    records: [{ phase: 'verify', status: 'failed', error: 'Claude Code process exited with code 1' }],
    transcripts: {
      'verify-lap0.jsonl': [
        init(),
        ...bash('psql -U postgres', 'psql: error: FATAL: password authentication failed for user "postgres"\nsecond line of output', true),
        ...bash('echo $GITLAB_TOKEN', 'GITLAB_TOKEN=glpat-abcdefghijklmnop'),
        success(9, { result: 'Verification complete. 19 of 20 test cases pass.' }),
      ],
    },
    files: { 'findings.json': { verdict: 'changes-requested', findings: [{ id: 'F-05', what: 'the "Person" test\nwas deleted rather than repaired' }] } },
  });
  const repo = mkdtempSync(join(tmpdir(), 'oneshot-repo-'));
  mkdirSync(join(repo, 'src', 'conductor'), { recursive: true });
  writeFileSync(join(repo, 'src', 'conductor', 'phase.ts'), ['// line 1', 'function a() {', '  out.error = m;', '}', '// line 5', '// line 6', '// line 7', '// line 8', 'const settled = false;'].join('\n'));
  return { roots: { run: run.dir, repo }, cleanup: () => { run.cleanup(); rmSync(repo, { recursive: true, force: true }); } };
}

const cite = (file: string, line: number, quote: string) => ({ file, line, quote });

test('a quote on the cited line of a transcript checks out against the frame\'s decoded text', () => {
  const w = world();
  try {
    // The raw line holds \"postgres\" and \n; the session saw quotes and a line break.
    const c = checkCitation(cite('transcripts/verify-lap0.jsonl', 3, 'password authentication failed for user "postgres"'), w.roots);
    assert.deepEqual({ ok: c.ok, line: c.line, note: c.note }, { ok: true, line: 3, note: '' });
  } finally { w.cleanup(); }
});

test('a quote a few lines off, or elsewhere in the file, is found and its line corrected', () => {
  const w = world();
  try {
    const near = checkCitation(cite('transcripts/verify-lap0.jsonl', 2, 'password authentication failed for user "postgres"'), w.roots);
    assert.deepEqual({ ok: near.ok, line: near.line }, { ok: true, line: 3 });
    assert.match(near.note, /found at line 3, not 2/);
    const far = checkCitation(cite('repo:src/conductor/phase.ts', 1, 'const settled = false;'), w.roots);
    assert.deepEqual({ ok: far.ok, line: far.line }, { ok: true, line: 9 });
  } finally { w.cleanup(); }
});

test('a quote that is nowhere in the file does not count, whatever the line', () => {
  const w = world();
  try {
    const c = checkCitation(cite('transcripts/verify-lap0.jsonl', 3, 'the session ran out of memory and was killed'), w.roots);
    assert.equal(c.ok, false);
    assert.match(c.note, /not in that file/);
  } finally { w.cleanup(); }
});

test('a quote too short to mean anything is refused, and so is a file that is not there', () => {
  const w = world();
  try {
    assert.match(checkCitation(cite('run.json', 1, 'failed'), w.roots).note, /too short to check/);
    assert.match(checkCitation(cite('transcripts/nope.jsonl', 1, 'a long enough quotation'), w.roots).note, /no such file/);
  } finally { w.cleanup(); }
});

test('a quote copied from a redacting reader matches though the file holds the credential', () => {
  const w = world();
  try {
    // The peek commands print "[redacted: gitlab token]" where the transcript holds the token.
    const c = checkCitation(cite('transcripts/verify-lap0.jsonl', 5, 'GITLAB_TOKEN=[redacted: gitlab token]'), w.roots);
    assert.equal(c.ok, true);
  } finally { w.cleanup(); }
});

test('a quote with the middle elided matches its parts in order, and not out of order', () => {
  const w = world();
  try {
    assert.equal(checkCitation(cite('transcripts/verify-lap0.jsonl', 6, 'Verification complete. … test cases pass.'), w.roots).ok, true);
    assert.equal(checkCitation(cite('transcripts/verify-lap0.jsonl', 6, 'test cases pass. … Verification complete.'), w.roots).ok, false);
  } finally { w.cleanup(); }
});

test('a quote from pretty-printed JSON matches across its lines and through its escapes', () => {
  const w = world();
  try {
    const c = checkCitation(cite('findings.json', 1, 'the "Person" test was deleted rather than repaired'), w.roots);
    assert.equal(c.ok, true);
    assert.equal(checkCitation(cite('run.json', 1, '"error": "Claude Code process exited with code 1"'), w.roots).ok, true);
  } finally { w.cleanup(); }
});

test('a cited path cannot leave the run directory or the repository', () => {
  const w = world();
  try {
    assert.equal(resolveCited('../../../etc/passwd', w.roots), null);
    assert.equal(resolveCited('repo:../../etc/passwd', w.roots), null);
    assert.equal(resolveCited('/etc/passwd', w.roots), null);
    assert.equal(resolveCited('', w.roots), null);
    assert.equal(resolveCited('run.json', w.roots), join(w.roots.run, 'run.json'));
    assert.equal(resolveCited('repo:src/conductor/phase.ts', w.roots), join(w.roots.repo, 'src', 'conductor', 'phase.ts'));
    assert.equal(resolveCited(join(w.roots.run, 'transcripts', 'verify-lap0.jsonl'), w.roots), join(w.roots.run, 'transcripts', 'verify-lap0.jsonl'), 'an absolute path inside a root is accepted');
    assert.match(checkCitation(cite('/etc/hosts', 1, 'localhost is always here'), w.roots).note, /outside the run directory/);
  } finally { w.cleanup(); }
});

test('a finding is evidenced when one citation holds, and counted either way', () => {
  const w = world();
  try {
    const finding = (evidence: Finding['evidence']): Finding => ({
      id: 'D-1', title: 't', category: 'harness', phases: '', recorded: '', cause: '', evidence, solution: '', where: [], fix: 'pr', confidence: 'confirmed',
    });
    const good = cite('repo:src/conductor/phase.ts', 3, 'out.error = m;');
    const bad = cite('run.json', 1, 'this text is not in the journal');
    const out = checkFindings([finding([good, bad]), finding([bad])], w.roots);
    assert.deepEqual(out.findings.map((f) => f.evidenced), [true, false]);
    assert.deepEqual({ checked: out.checked, verified: out.verified }, { checked: 3, verified: 1 });
  } finally { w.cleanup(); }
});

test('quoteParts strips wrapping quotes and splits on an ellipsis; containsQuote needs every part', () => {
  assert.deepEqual(quoteParts('"first part … second part"'), ['first part', 'second part']);
  assert.deepEqual(quoteParts('a...b'), ['a', 'b']);
  assert.equal(containsQuote('x first part y second part z', ['first part', 'second part']), true);
  assert.equal(containsQuote('anything', []), false);
  assert.equal(displayFile('repo:src/x.ts'), 'src/x.ts');
  assert.equal(displayFile('run.json'), 'run.json');
});

// ------------------------------------------------- what a review of this found

test('an ellipsis does not make a quote of anything: each part kept is long, there are few, and they sit together', () => {
  const w = world();
  try {
    const at = (quote: string) => checkCitation(cite('run.json', 1, quote), w.roots);
    // Every one of these "was found" before, in a journal that says none of them.
    assert.match(at('r…u…n…I…d…s…t…a…t…u…s…e').note, /leaves text out in more than 2 places/);
    assert.match(at('verify … failed … the postgres role').note, /a part of the quote kept around an ellipsis is under 12 characters/);
    // Two real lines of one file, forty lines apart, are not one quotation.
    writeFileSync(join(w.roots.repo, 'src', 'conductor', 'long.ts'), ['const alphaAlphaAlpha = 1;', ...Array.from({ length: 40 }, (_, i) => `// filler ${i}`), 'const omegaOmegaOmega = 2;'].join('\n'));
    assert.match(checkCitation(cite('repo:src/conductor/long.ts', 1, 'const alphaAlphaAlpha = 1; … const omegaOmegaOmega = 2;'), w.roots).note, /not in that file/);
    assert.equal(checkCitation(cite('repo:src/conductor/long.ts', 1, 'const alphaAlphaAlpha = 1;'), w.roots).ok, true);
    // A real elision of one line still checks out.
    const real = checkCitation(cite('transcripts/verify-lap0.jsonl', 3, 'psql: error: FATAL … failed for user "postgres"'), w.roots);
    assert.equal(real.ok, true);
  } finally { w.cleanup(); }
});

test('parts of an elided quote are found only close together, in order, on one line', () => {
  const far = `password authentication ${'x'.repeat(3000)} failed for user`;
  assert.equal(containsQuote(far, ['password authentication', 'failed for user']), false);
  assert.equal(containsQuote('password authentication just failed for user', ['password authentication', 'failed for user']), true);
  assert.equal(containsQuote('failed for user: password authentication', ['password authentication', 'failed for user']), false, 'order');
  // The first place the head occurs is not the only one tried.
  const twice = `password authentication ${'x'.repeat(3000)} password authentication failed for user`;
  assert.equal(containsQuote(twice, ['password authentication', 'failed for user']), true);
});

test('a diagnosis cannot cite its own output, and only the repository\'s source is evidence', () => {
  const w = world();
  try {
    const own = 'a sentence the session wrote about the run, long enough to check';
    for (const [file, text] of [
      ['diagnosis/session.json', JSON.stringify({ findings: [{ cause: own }] })],
      ['diagnosis.json', JSON.stringify({ stops: { k: { headline: own } } })],
      ['transcripts/diagnose-lap0.jsonl', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: own }] } })],
      ['transcripts/fix-author-lap10.jsonl', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: own }] } })],
    ] as const) {
      mkdirSync(join(w.roots.run, file, '..'), { recursive: true });
      writeFileSync(join(w.roots.run, file), `${text}\n`);
      assert.match(checkCitation(cite(file, 1, own), w.roots).note, /cannot cite its own output/, file);
    }
    // The digest is code's reading of the run, and stays citable.
    mkdirSync(join(w.roots.run, 'diagnosis'), { recursive: true });
    writeFileSync(join(w.roots.run, 'diagnosis', 'evidence.json'), JSON.stringify({ facts: [{ text: 'exposed 0 tools in 25 of 25 session(s)' }] }));
    assert.equal(checkCitation(cite('diagnosis/evidence.json', 1, 'exposed 0 tools in 25 of 25 session(s)'), w.roots).ok, true);

    for (const file of ['.env', '.env.local', 'state/oneshot.db', 'state/runs/9174/run.json', 'node_modules/zod/package.json', '.git/config']) {
      mkdirSync(join(w.roots.repo, file, '..'), { recursive: true });
      writeFileSync(join(w.roots.repo, file), 'GITLAB_TOKEN=some-long-secret-value\n');
      assert.match(checkCitation(cite(`repo:${file}`, 1, 'GITLAB_TOKEN=some-long-secret-value'), w.roots).note, /not a file of the repository's source/, file);
    }
  } finally { w.cleanup(); }
});

test('a link out of the repository is not followed on a citation\'s say-so', () => {
  const w = world();
  const outside = mkdtempSync(join(tmpdir(), 'oneshot-outside-'));
  try {
    writeFileSync(join(outside, 'secret.txt'), 'a line that lives outside both roots\n');
    symlinkSync(join(outside, 'secret.txt'), join(w.roots.repo, 'src', 'notes.txt'));
    symlinkSync(outside, join(w.roots.run, 'elsewhere'));
    assert.match(checkCitation(cite('repo:src/notes.txt', 1, 'a line that lives outside both roots'), w.roots).note, /outside the run directory and this repository/);
    assert.match(checkCitation(cite('elsewhere/secret.txt', 1, 'a line that lives outside both roots'), w.roots).note, /outside the run directory and this repository/);
    assert.equal(resolveCited('repo:src/conductor/phase.ts', w.roots), join(w.roots.repo, 'src', 'conductor', 'phase.ts'));
  } finally { w.cleanup(); rmSync(outside, { recursive: true, force: true }); }
});

test('a quote copied from the peek commands checks out with their label and their cut mark still on it', () => {
  const w = world();
  try {
    const t = 'transcripts/verify-lap0.jsonl';
    assert.equal(checkCitation(cite(t, 3, 'ERROR (Bash): psql: error: FATAL: password authentication failed'), w.roots).ok, true);
    assert.equal(checkCitation(cite(t, 3, 'psql: error: FATAL: password authentication failed… (+40 chars)'), w.roots).ok, true);
    assert.equal(checkCitation(cite(t, 6, '[result success turns=9] Verification complete. 19 of 20'), w.roots).ok, true);
    assert.equal(checkCitation(cite(t, 6, '"subtype":"success"'), w.roots).ok, true, 'the outcome as the frame\'s own JSON spells it');
    assert.equal(checkCitation(cite(t, 6, '[result success turns=9]'), w.roots).ok, true);
    assert.equal(checkCitation(cite(t, 6, '[result error_max_turns turns=9]'), w.roots).ok, false);
  } finally { w.cleanup(); }
});

// ----------------------------------------- what the adversarial pass found next

test('the parts of an elided quote are held to one line: two fields of two journal records are not a sentence about one', () => {
  const w = world();
  try {
    writeFileSync(join(w.roots.run, 'run.json'), [
      '{', '  "phases": [', '    {', '      "phase": "implement",', '      "error": "cancelled by the conductor"', '    },',
      '    {', '      "phase": "mr-open",', '      "status": "ok"', '    }', '  ]', '}',
    ].join('\n'));
    // The error is implement's (line 5). mr-open is the next record (line 8).
    const stitched = checkCitation(cite('run.json', 5, '"error": "cancelled by the conductor" … "phase": "mr-open"'), w.roots);
    assert.equal(stitched.ok, false);
    // One line, elided in its middle, is still fine; so is a plain quote that runs over a line break.
    writeFileSync(join(w.roots.repo, 'src', 'conductor', 'one.ts'), 'const settled = readTheResultFrame(frame) ?? fallbackFromTheExitText(error);\n');
    assert.equal(checkCitation(cite('repo:src/conductor/one.ts', 1, 'const settled = readTheResultFrame … fallbackFromTheExitText(error);'), w.roots).ok, true);
    assert.equal(checkCitation(cite('run.json', 4, '"phase": "implement", "error": "cancelled by the conductor"'), w.roots).ok, true);
  } finally { w.cleanup(); }
});

test('a result frame\'s label is checked against the frame, not taken off the quote', () => {
  const w = world();
  try {
    const t = 'transcripts/verify-lap0.jsonl';
    // The frame is `success` after 9 turns. A quote that says otherwise in front of its real text is wrong about the frame.
    assert.equal(checkCitation(cite(t, 6, '[result error_max_turns turns=450] Verification complete. 19 of 20 test cases pass.'), w.roots).ok, false);
    assert.equal(checkCitation(cite(t, 6, '[result success turns=450] Verification complete. 19 of 20 test cases pass.'), w.roots).ok, false);
    assert.equal(checkCitation(cite(t, 6, '[result success turns=9] Verification complete. 19 of 20 test cases pass.'), w.roots).ok, true);
    assert.equal(checkCitation(cite(t, 6, 'Verification complete. 19 of 20 test cases pass.'), w.roots).ok, true);
  } finally { w.cleanup(); }
});

test('three dots that are in the text are text: a verbatim line is tried as written before it is read as elided', () => {
  const w = world();
  try {
    writeFileSync(join(w.roots.repo, 'src', 'conductor', 'dots.ts'), ['additional.push(...more);', '// Ran 4 tests ... FAILED (errors=1)', '// test_x (apps.tests.X) ... ERROR'].join('\n'));
    for (const [line, quote] of [[1, 'additional.push(...more);'], [2, 'Ran 4 tests ... FAILED (errors=1)'], [3, 'test_x (apps.tests.X) ... ERROR']] as const) {
      assert.equal(checkCitation(cite('repo:src/conductor/dots.ts', line, quote), w.roots).ok, true, quote);
    }
  } finally { w.cleanup(); }
});

test('a quote of punctuation is not evidence, and neither is the diagnosis\'s own output under another case or behind a link', () => {
  const w = world();
  try {
    writeFileSync(join(w.roots.repo, 'src', 'conductor', 'rule.ts'), '// ------------------------------------------------------------\nconst x = 1;\n');
    assert.match(checkCitation(cite('repo:src/conductor/rule.ts', 1, '------------'), w.roots).note, /almost no words/);
    assert.match(checkCitation(cite('repo:src/conductor/rule.ts', 1, '// ------------------------'), w.roots).note, /almost no words/);

    const own = 'a sentence the session wrote about the run, long enough to check';
    mkdirSync(join(w.roots.run, 'diagnosis'), { recursive: true });
    writeFileSync(join(w.roots.run, 'diagnosis', 'session.json'), JSON.stringify({ cause: own }));
    symlinkSync(join(w.roots.run, 'diagnosis', 'session.json'), join(w.roots.run, 'notes.json'));
    assert.match(checkCitation(cite('notes.json', 1, own), w.roots).note, /cannot cite its own output/, 'a link to it is it');
    // Only where the disk itself ignores case does the other spelling open anything.
    const other = checkCitation(cite('Diagnosis/SESSION.json', 1, own), w.roots);
    assert.equal(other.ok, false);
    assert.match(other.note, /cannot cite its own output|no such file/);
  } finally { w.cleanup(); }
});

test('one check opens a bounded number of files, however many are cited', () => {
  const w = world();
  try {
    const findings: Finding[] = [{
      id: 'D-1', title: 't', category: 'harness', phases: '', recorded: '', cause: '', solution: '', where: [], fix: 'pr', confidence: 'confirmed',
      evidence: Array.from({ length: 70 }, (_, i) => {
        writeFileSync(join(w.roots.repo, 'src', `f${i}.ts`), `export const value${i} = 'a line long enough';\n`);
        return cite(`repo:src/f${i}.ts`, 1, `export const value${i} = 'a line long enough';`);
      }),
    }];
    const r = checkFindings(findings, w.roots);
    assert.equal(r.verified, 60);
    assert.match(r.findings[0]!.evidence[69]!.note, /more than 60 files were cited/);
  } finally { w.cleanup(); }
});

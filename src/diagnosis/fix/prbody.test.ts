import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../lib/test-project-env.js';
import { fixPrMarker, leaks, publicSafe, renderPrBody, unpublishable, type PrBodyInput, type PrivateText } from './prbody.js';
import type { ReviewPoint } from './decide.js';

const point = (id: string, severity: ReviewPoint['severity'], what: string): ReviewPoint => ({ id, severity, file: 'src/conductor/phase.ts', line: 762, what, why: 'w', fix: 'f' });

const INPUT: PrBodyInput = {
  iid: 9174, project: 'erp', stopKey: 'ec7d7950661d', findingId: 'D-3',
  summary: 'Keep the settled result when the stream throws after a result frame.',
  why: 'The catch branch overwrote `out.error` (`src/conductor/phase.ts:762`).',
  tests: '`a settled session keeps its error when the CLI exits after it`.',
  checks: {
    typecheck: { ok: true, text: 'clean' }, tests: { ok: true, pass: 1421, fail: 0, text: '1421 pass, 0 fail' },
    hooks: { ok: true, ran: false, text: '' }, red: { ok: true, text: '1 changed test file(s) on origin/main without the fix: 2 failing, 0 passing' },
  },
  commands: { typecheck: 'node node_modules/typescript/bin/tsc --noEmit -p .', tests: 'node node_modules/tsx/dist/cli.mjs --test $(find src -name "*.test.ts" | sort)', red: 'the changed tests, on origin/main without the fix' },
  points: [point('A-1', 'blocker', 'the infra flag is lost'), point('A-2', 'blocker', 'a timeout is misread'), point('B-1', 'nit', 'name the constant')],
  rulings: [{ id: 'A-1', holds: true, reason: 'reproduced' }, { id: 'A-2', holds: false, reason: 'ran the timeout path: the timer branch is taken first' }],
  additional: [],
  stood: new Set(['A-1']),
  fixed: new Set(['A-1']),
  tally: { raised: 3, upheld: 1, refuted: 1, fixed: 1 },
  rounds: 1,
};

test('the description carries the pipeline\'s own numbers, with the commands that produced them', () => {
  const body = renderPrBody(INPUT);
  assert.match(body, /^## Summary\n\nKeep the settled result/);
  assert.match(body, /## Why\n\nThe catch branch overwrote/);
  assert.match(body, /Found by Oneshot's failure diagnosis of erp#9174 \(finding D-3\)\./);
  assert.match(body, /no CI here, so these are the pipeline's own runs, not the author's claim/);
  assert.match(body, /the changed tests, on origin\/main without the fix\n  → 1 changed test file\(s\) on origin\/main without the fix: 2 failing, 0 passing/);
  assert.match(body, /tsc --noEmit -p \.\n  → clean/);
  assert.match(body, /\n  → 1421 pass, 0 fail/);
  assert.doesNotMatch(body, /verify-hooks/, 'a check that did not run is not claimed');
});

test('every review point is listed with what became of it', () => {
  const body = renderPrBody(INPUT);
  assert.match(body, /3 point\(s\) raised, 1 blocker\(s\) upheld and 1 of those fixed, 1 refuted, 1 fix round\(s\)/);
  assert.match(body, /\| A-1 \| blocker \| the infra flag is lost \(`src\/conductor\/phase\.ts:762`\) \| upheld, then fixed in this branch and checked again \|/);
  assert.match(body, /\| A-2 \| blocker \| a timeout is misread .* \| refuted: ran the timeout path: the timer branch is taken first \|/);
  assert.match(body, /\| B-1 \| nit \| name the constant .* \| not blocking, left as raised \|/);
  assert.match(renderPrBody({ ...INPUT, points: [], rulings: [], stood: new Set(), fixed: new Set(), tally: { raised: 0, upheld: 0, refuted: 0, fixed: 0 }, rounds: 0 }), /No points were raised\./);
});

test('it says a person merges it, and carries the marker that ties it to the finding', () => {
  const body = renderPrBody(INPUT);
  assert.match(body, /Not merged, and auto-merge is off: a person reviews and merges this\./);
  assert.ok(body.trimEnd().endsWith(fixPrMarker(9174, 'ec7d7950661d', 'D-3')));
  assert.equal(fixPrMarker(9174, 'ec7d7950661d', 'D-3'), '<!-- oneshot:fix 9174 ec7d7950661d D-3 -->');
  assert.notEqual(fixPrMarker(9174, 'ec7d7950661d', 'D-3'), fixPrMarker(9174, '0a1b2c3d4e5f', 'D-3'), 'another stop\'s D-3 is another pull request');
  assert.equal(fixPrMarker(9174, 'k -->', 'D-1 -->\n/close'), '<!-- oneshot:fix 9174 k-- D-1--close -->');
  assert.match(body, /a person has not read it yet/);
});

test('nothing private reaches a public description: credentials, private addresses, e-mail, mentions', () => {
  const leaky = 'ssh deploy@172.16.0.9 with GITLAB_TOKEN=glpat-abcdefghijklmnop, mail jane.doe@example.org, cc @some-reviewer; clone https://bot:hunter2secret@gitlab.example.com/x.git on 10.0.0.5:8787';
  const safe = publicSafe(leaky);
  for (const secret of ['172.16.0.9', 'glpat-abcdefghijklmnop', 'jane.doe@example.org', 'hunter2secret', '10.0.0.5']) {
    assert.ok(!safe.includes(secret), `${secret} is gone`);
  }
  assert.doesNotMatch(safe, /@some-reviewer/, 'a mention notifies nobody');
  assert.match(safe, /<internal address>/);
  const body = renderPrBody({ ...INPUT, summary: leaky, why: leaky, tests: leaky, rulings: [{ id: 'A-2', holds: false, reason: leaky }] });
  for (const secret of ['172.16.0.9', 'glpat-abcdefghijklmnop', 'jane.doe@example.org', 'hunter2secret']) assert.ok(!body.includes(secret), secret);
});

test('ordinary text and public addresses are left alone', () => {
  const text = 'See src/lib/x.ts:12 and https://github.com/HassamAzam/oneshot/pull/197; version 1.2.3.4 of 8.8.8.8, `@types/node`.';
  assert.equal(publicSafe(text), text);
});

// ------------------------------------------------- what a review of this found

const KNOWN: PrivateText[] = [
  { what: 'the work project\'s host', text: 'gitlab.internal.example' },
  { what: 'the ticket\'s title', text: 'Show the total on the invoice list' },
  { what: 'a home directory', text: '/Users/someone' },
  { what: 'this machine\'s name', text: 'build-box-07' },
];

test('what the pipeline knows is private is replaced wherever it appears, whoever wrote it', () => {
  const text = 'See https://gitlab.internal.example/acme/erp/-/issues/9174 ("Show the Total on the Invoice List"), reproduced on build-box-07 in /Users/someone/work/oneshot/src/x.ts and /home/deploy/oneshot.';
  const safe = publicSafe(text, KNOWN);
  for (const secret of ['gitlab.internal.example', 'invoice list', 'Invoice List', 'build-box-07', '/Users/someone', '/home/deploy']) {
    assert.ok(!safe.includes(secret), `${secret} is gone: ${safe}`);
  }
  // A reviewer quoting the leak it flagged is model text too: the whole description is made safe, table included.
  const body = renderPrBody({
    ...INPUT, known: KNOWN,
    points: [point('B-1', 'blocker', 'the commit message names gitlab.internal.example')],
    rulings: [{ id: 'B-1', holds: false, reason: 'it says build-box-07, which is fine' }], stood: new Set(), fixed: new Set(),
  });
  assert.doesNotMatch(body, /gitlab\.internal\.example|build-box-07/);
  assert.match(body, /<the work project's host>/);
});

test('leaks names the kind of private text and never the text', () => {
  assert.deepEqual(leaks('fix(phase): as seen on https://GitLab.Internal.Example/x and build-box-07', KNOWN), ['the work project\'s host', 'this machine\'s name']);
  assert.deepEqual(leaks('fix(phase): keep the settled result', KNOWN), []);
  assert.deepEqual(leaks('anything', [{ what: 'x', text: '' }, { what: 'y', text: 'ab' }]), [], 'nothing short enough to match by accident');
});

test('a description cannot close an issue of this repository, and a credential is not cut in half before it is recognised', () => {
  assert.doesNotMatch(publicSafe('Fixes #12 and closes: #7; resolved #3.'), /(Fixes|closes:?|resolved) #\d/i);
  assert.match(publicSafe('See erp#9174 and PR #197.'), /erp#9174 and PR #197/, 'a plain reference is left alone');
  // The red-check line is cut to 400 characters: a token straddling the cut used to lose its head and pass.
  const text = `${'x'.repeat(385)} GITLAB_TOKEN=glpat-abcdefghijklmnop tail`;
  const body = renderPrBody({ ...INPUT, checks: { ...INPUT.checks, red: { ok: true, text } } });
  assert.doesNotMatch(body, /glpat-/);
});

// ----------------------------------------- what the adversarial pass found next

test('a line break in the middle of something private does not hide it', () => {
  const wrapped = 'fix(phase): keep the result\n\nSeen while running "Show the total on the\ninvoice list" on that desk.\n';
  assert.deepEqual(leaks(wrapped, KNOWN), ['the ticket\'s title']);
  assert.doesNotMatch(publicSafe(wrapped, KNOWN), /invoice\s+list/);
  // A table cell is made safe before it is cut, with the known text: half a host is not one anything recognises.
  const body = renderPrBody({ ...INPUT, known: KNOWN, points: [point('B-1', 'nit', `${'x'.repeat(182)} gitlab.internal.example is named`)] });
  assert.doesNotMatch(body, /gitlab\.in/);
});

test('what a commit would publish is refused by kind: an address, a private network, a keyword GitHub acts on', () => {
  const kinds = (text: string, where: 'message' | 'added' = 'message') => unpublishable(text, KNOWN, where);
  assert.deepEqual(kinds('fix(x): y\n\nReported-by: jane.doe@corp.example\n'), ['an e-mail address']);
  assert.deepEqual(kinds('fix(x): y\n\ncc @octocat\n'), ['a mention']);
  assert.deepEqual(kinds('fix(x): y, fixes #12\n'), ['a closing keyword, which would close an issue of this repository']);
  assert.deepEqual(kinds('+const HOST = "10.20.30.40";', 'added'), ['a private network address']);
  // What every commit here carries, and what code is full of, is not any of those.
  assert.deepEqual(kinds('fix(x): y\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n'), []);
  assert.deepEqual(kinds('fix(x): see erp#9174 and PR #197; uses `@types/node`\n'), []);
  assert.deepEqual(kinds("+import x from '@anthropic-ai/claude-agent-sdk';\n+ * @param cfg the phase\n+const a = 'a@example.com';\n+// git@github.com:acme/oneshot.git", 'added'), []);
});

test('a remote\'s address is not an e-mail address', () => {
  assert.equal(publicSafe('clone git@github.com:acme/oneshot.git and mail jane.doe@corp.example'), 'clone git@github.com:acme/oneshot.git and mail <email>');
});

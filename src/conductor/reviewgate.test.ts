import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCorrectedSteps, parseVerifyDirectives, planApprovalRequestBody, repliesAfter,
  testcasesApprovalRequestBody, testcasesApprovedRecordBody, verifyCasesRequestBody, verifyOurStepsBody,
} from './reviewgate.js';
import { renderPlanMd } from '../lib/publish.js';

const oldPlan = {
  approach: 'Darken the bar colour',
  reuse: [],
  steps: [{ n: 1, what: 'Add token', files: ['frontend/src/jss/Theme.js'], layer: 'frontend' }],
  migrations: false,
  risks: ['Snapshot drift'],
};

const newPlan = {
  ...oldPlan,
  openQuestions: ['Is Project Logs V2 in scope? Default: no, V1 only.'],
  outOfScope: ['checkIcon contrast — shared by 13 files, separate ticket'],
  acceptanceCoverage: [
    { criterion: 'Indicators reach 3:1', coveredBy: 'steps 1-3; step 5 test', status: 'covered', note: '' },
    { criterion: 'VoiceOver confirms fix', coveredBy: '—', status: 'not-satisfiable', note: '1.4.11 is visual' },
  ],
};

test('gate comment for a plan written before the new fields renders as before', () => {
  const body = planApprovalRequestBody(oldPlan, 'why');
  assert.match(body, /\*\*Approach\*\*\nDarken the bar colour/);
  assert.match(body, /\*\*Risks\*\*\n- Snapshot drift/);
  assert.doesNotMatch(body, /Open questions|Acceptance coverage|Out of scope/);
});

test('gate comment puts open questions before the steps', () => {
  const body = planApprovalRequestBody(newPlan, 'why');
  const q = body.indexOf('**Open questions**');
  assert.ok(q > 0 && q < body.indexOf('**Steps**'));
  assert.match(body, /- Is Project Logs V2 in scope\? Default: no, V1 only\./);
});

test('gate comment renders acceptance coverage and out of scope', () => {
  const body = planApprovalRequestBody(newPlan, 'why');
  assert.match(body, /\*\*Acceptance coverage\*\*\n- ✅ Indicators reach 3:1 — steps 1-3; step 5 test\n- ❌ VoiceOver confirms fix — — _\(1\.4\.11 is visual\)_/);
  assert.match(body, /\*\*Out of scope\*\*\n- checkIcon contrast/);
});

test('gate comment escapes HTML in the new sections', () => {
  const body = planApprovalRequestBody({ ...oldPlan, openQuestions: ['Add a <main> landmark?'] }, 'why');
  assert.match(body, /Add a &lt;main&gt; landmark\?/);
});

test('plan markdown omits the new sections for an old plan and renders them for a new one', () => {
  const old = renderPlanMd(1, 't', oldPlan);
  assert.doesNotMatch(old, /## Open questions|## Acceptance coverage|## Out of scope/);
  const md = renderPlanMd(1, 't', newPlan);
  assert.ok(md.indexOf('## Open questions') < md.indexOf('## Steps'));
  assert.match(md, /\| VoiceOver confirms fix \| not-satisfiable \| — \| 1\.4\.11 is visual \|/);
  assert.match(md, /## Out of scope\n- checkIcon contrast/);
});

const revisedPlan = {
  ...newPlan,
  feedbackResponse: [
    { point: 'opacity:1 cannot undo the parent', response: 'changed', where: 'step 6', note: 'dot moved out of the faded label' },
    { point: 'V2 scope', response: 'answered', where: 'open question 1', note: '' },
    { point: 'rename the token', response: 'declined', where: '', note: 'matches the existing naming' },
  ],
};

test('gate comment answers reviewer feedback first, point by point', () => {
  const body = planApprovalRequestBody(revisedPlan, 'why');
  assert.ok(body.indexOf('**Your feedback, point by point**') < body.indexOf('**Approach**'));
  assert.match(body, /- \*\*changed\*\* — opacity:1 cannot undo the parent → step 6: dot moved out of the faded label/);
  assert.match(body, /- \*\*answered\*\* — V2 scope → open question 1\n/);
  assert.match(body, /- \*\*declined\*\* — rename the token: matches the existing naming/);
});

test('no feedback section on a first plan or an old artifact', () => {
  assert.doesNotMatch(planApprovalRequestBody(newPlan, 'why'), /point by point/);
  assert.doesNotMatch(planApprovalRequestBody({ ...newPlan, feedbackResponse: [] }, 'why'), /point by point/);
  assert.doesNotMatch(renderPlanMd(1, 't', newPlan), /point by point/);
  assert.match(renderPlanMd(1, 't', revisedPlan), /## Reviewer feedback, point by point\n\| Point \| Response \| Where \| Note \|/);
});

/** The artifact shape, so a deliberately malformed fixture can be cast back to it. */
type Plan = Parameters<typeof renderPlanMd>[2];

/** One row's cells, split the way GFM splits them: on pipes that are not backslash-escaped. */
function cells(md: string, marker: string): string[] {
  const rows = md.split('\n').filter((l) => l.startsWith('|') && l.includes(marker));
  assert.equal(rows.length, 1, `expected one row holding ${marker}, got ${rows.length}`);
  return rows[0]!.replace(/^\||\|$/g, '').split(/(?<!\\)\|/);
}

// A pipe or a newline in model prose does not render wrong, it renders as a
// different number of columns — every later cell shifts left, and a newline
// ends the table and spills the remaining rows into the surrounding prose.
test('plan markdown keeps four columns when a cell carries a pipe', () => {
  const md = renderPlanMd(1, 't', {
    ...newPlan,
    steps: [{ n: 1, what: 'Split the Save | Cancel row', files: ['a.js'], layer: 'frontend' }],
    acceptanceCoverage: [
      { criterion: 'Save | Cancel reach 3:1', coveredBy: 'step 1', status: 'covered', note: '' },
    ],
    feedbackResponse: [
      { point: 'the | in the label', response: 'changed', where: 'step 1 | test', note: 'a | b' },
    ],
  });
  assert.equal(cells(md, 'Save \\| Cancel reach').length, 4);
  assert.equal(cells(md, 'the \\| in the label').length, 4);
  assert.equal(cells(md, 'Split the Save').length, 4);
});

test('plan markdown keeps a multi-line note inside its own row', () => {
  const md = renderPlanMd(1, 't', {
    ...newPlan,
    acceptanceCoverage: [
      { criterion: 'Contrast', coveredBy: 'step 1', status: 'partial', note: 'first line\nsecond line' },
    ],
  });
  assert.equal(cells(md, 'first line').length, 4);
  assert.match(md, /\| first line<br>second line \|/);
  assert.ok(md.includes('## Prior art and verdicts'), 'the sections after the table survive');
});

test('plan markdown escapes HTML in table cells as well as in prose', () => {
  const md = renderPlanMd(1, 't', {
    ...newPlan,
    acceptanceCoverage: [
      { criterion: 'Add a <main> landmark', coveredBy: 'step 1', status: 'covered', note: '' },
    ],
  });
  assert.match(md, /\| Add a &lt;main&gt; landmark \|/);
});

// `point` present, `response` absent: the shape a plan.json written halfway
// through a revision has, and the one field the renderers interpolate with no
// truthiness guard in front of it.
test('a feedback entry missing its response renders instead of throwing', () => {
  const partial = { ...newPlan, feedbackResponse: [{ point: 'V2 scope' }] };
  const body = planApprovalRequestBody(partial, 'why');
  assert.match(body, /\*\*Your feedback, point by point\*\*\n- \*\*\*\* — V2 scope/);
  assert.equal(cells(renderPlanMd(1, 't', partial as unknown as Plan), 'V2 scope').length, 4);
});

test('non-string coverage fields render instead of throwing', () => {
  const odd = { ...newPlan, acceptanceCoverage: [{ criterion: 'Contrast', coveredBy: 2, note: 3 }] };
  assert.match(planApprovalRequestBody(odd, 'why'), /- • Contrast — 2 _\(3\)_/);
});

const tcase = (over: Record<string, unknown> = {}) => ({
  id: 'TC-01',
  scenario: 'The filter menu closes on Escape',
  precondition: '',
  steps: ['Open the menu', 'Press Escape'],
  expected: 'The menu closes and focus returns to the trigger',
  pass: ['happy'],
  blast: 'medium' as const,
  ...over,
});

test('the gate posts the case list as a table a reviewer can scan', () => {
  const md = testcasesApprovalRequestBody([tcase()], 'gates are on for every run');
  assert.ok(md.includes('| Case | Blast | Scenario | Expects |'), 'has a header row');
  assert.ok(md.includes('| --- | --- | --- | --- |'), 'has the delimiter row');
  assert.ok(md.includes('| **TC-01** |'), 'the id is its own column');
});

test('a pipe in model-authored prose cannot break the table open', () => {
  // scenario/expected are model prose and routinely carry shell snippets and
  // union types. One unescaped pipe ends the row and spills every case after
  // it into the surrounding text — the whole list becomes unreadable at the
  // one moment a reviewer needs to read it.
  const md = testcasesApprovalRequestBody(
    [tcase({ scenario: 'a | b', expected: 'status is 401 | 403' })], 'why',
  );
  assert.ok(md.includes('a \\| b'), 'the scenario pipe is escaped');
  assert.ok(md.includes('401 \\| 403'), 'the expected pipe is escaped');
});

test('the reviewer is told a reply revises the list, not that it appends', () => {
  // The old text said replies "are appended to testcases.json", which is what
  // taught reviewers to write append-shaped comments — and is no longer true.
  const md = testcasesApprovalRequestBody([tcase()], 'why');
  assert.ok(/REVISION request/.test(md), 'says a reply revises');
  assert.ok(/\*\*Remove\*\*/.test(md), 'offers remove as an action');
  assert.ok(/\*\*Change\*\*/.test(md), 'offers change as an action');
  assert.ok(!/They are appended to/.test(md), 'the append-only instruction is gone');
});

test('the approved record uses the same table, so both comments read alike', () => {
  const md = testcasesApprovedRecordBody([tcase()]);
  assert.ok(md.includes('| Case | Blast | Scenario | Expects |'));
  assert.ok(md.includes('**Approved test cases** (1)'));
});

test('repliesAfter drops system notes, machine notes and anything at or before the request, and carries created_at', () => {
  const at = '2026-09-28T10:15:00Z';
  const replies = repliesAfter([
    { id: 300, body: 'before the request', author: { username: 'anosha.saeed' } },
    { id: 310, body: 'the request itself', author: { username: 'arsal.tariq' } },
    { id: 311, body: 'added ~12 label', system: true, author: { username: 'arsal.tariq' } },
    { id: 312, body: 'Oneshot claimed this ticket <!-- oneshot:claim:r-x -->', author: { username: 'arsal.tariq' } },
    { id: 313, body: 'approved', author: { username: 'anosha.saeed' }, created_at: at },
    { id: 314, body: 'no author, no time' },
  ], 310);
  assert.deepEqual(replies, [
    { id: 313, text: 'approved', user: 'anosha.saeed', at },
    { id: 314, text: 'no author, no time', user: null, at: null },
  ]);
});

// ---------------------------------------------------- verify-case gate parser

const FAILING = ['TC-14', 'TC-09', 'TC-2', 'TC-20'];

test('parses "skip test case no. N" despite the period after "no"', () => {
  const d = parseVerifyDirectives('skip test case no. 14', FAILING);
  assert.deepEqual(d.map((x) => [x.caseId, x.verdict]), [['TC-14', 'skip']]);
});

test('parses each classification keyword against the case number', () => {
  const text = 'TC-14: invalid\nTC-09: expected\nTC-2: pre-existing\nskip TC-20';
  const got = Object.fromEntries(parseVerifyDirectives(text, FAILING).map((x) => [x.caseId, x.verdict]));
  assert.deepEqual(got, { 'TC-14': 'invalid', 'TC-09': 'expected', 'TC-2': 'pre-existing', 'TC-20': 'skip' });
});

test('matches a bare or TC- or padded number to the failing case id', () => {
  // "9" and "09" and "TC-9" all mean TC-09; "2" means TC-2, not TC-20.
  assert.equal(parseVerifyDirectives('skip 9', FAILING)[0]?.caseId, 'TC-09');
  assert.equal(parseVerifyDirectives('invalid TC-09', FAILING)[0]?.caseId, 'TC-09');
  assert.equal(parseVerifyDirectives('expected 2', FAILING)[0]?.caseId, 'TC-2');
});

test('applies one verdict to every case a fragment names', () => {
  const got = parseVerifyDirectives('skip 14 and 20', FAILING);
  assert.deepEqual(got.map((x) => x.caseId).sort(), ['TC-14', 'TC-20']);
  assert.ok(got.every((x) => x.verdict === 'skip'));
});

test('ignores numbers that are not failing cases, and verdict-less prose', () => {
  assert.deepEqual(parseVerifyDirectives('that is the 2024 figure', FAILING), []);
  assert.deepEqual(parseVerifyDirectives('TC-99: skip', FAILING), []);
  assert.deepEqual(parseVerifyDirectives('TC-14 looks odd', FAILING), []);
});

test('pre-existing is recognised from "existing issue" phrasing too', () => {
  assert.equal(parseVerifyDirectives('TC-14 is an existing issue', FAILING)[0]?.verdict, 'pre-existing');
});

test('confirms a real bug from the phrases a reviewer actually types', () => {
  for (const text of [
    'TC-14: actual bug',
    'TC-14 is a real bug',
    'TC-14 — genuine issue',
    'TC-14: confirmed',
    'TC-14 is a legitimate failure',
    'TC-14: fix it in this ticket',
  ]) {
    assert.equal(parseVerifyDirectives(text, FAILING)[0]?.verdict, 'confirmed', text);
  }
});

test('"not pre-existing, it is an actual bug" confirms rather than reading as its opposite', () => {
  // The natural way to say this contains `pre-existing`, whose pattern would
  // otherwise claim the fragment and record the exact inverse of the verdict.
  // This is why `confirmed` is tested first.
  assert.equal(
    parseVerifyDirectives('TC-14 is not pre-existing, it is an actual bug', FAILING)[0]?.verdict,
    'confirmed',
  );
});

test('a negated terminal verdict is not read as that verdict', () => {
  // `/pre[\s-]?exist/` matched "not pre-existing", so this sentence recorded the
  // exact inverse of what the reviewer said — and `pre-existing` is the verdict
  // with a side effect, opening a bug on another ticket.
  assert.notEqual(
    parseVerifyDirectives('TC-09 is not pre-existing', FAILING)[0]?.verdict,
    'pre-existing',
  );
  assert.notEqual(parseVerifyDirectives('TC-09 is not invalid', FAILING)[0]?.verdict, 'invalid');
  assert.notEqual(parseVerifyDirectives('TC-09 is not expected', FAILING)[0]?.verdict, 'expected');
  assert.notEqual(parseVerifyDirectives("TC-09 don't skip", FAILING)[0]?.verdict, 'skip');
  // A negation far from the keyword leaves the verdict alone.
  assert.equal(
    parseVerifyDirectives('TC-09 is not something I have seen before and it is pre-existing', FAILING)[0]?.verdict,
    'pre-existing',
  );
});

test('confirming does not collide with invalid, which contains "valid"', () => {
  assert.equal(parseVerifyDirectives('TC-14: invalid', FAILING)[0]?.verdict, 'invalid');
  assert.equal(parseVerifyDirectives('TC-09 is a real bug', FAILING)[0]?.verdict, 'confirmed');
});

test('a confirmation respects negation, like every other verdict', () => {
  // The guard went on the other four and not on this one — the verdict that
  // costs the most to invert, since a misread "no" starts a fix cycle.
  assert.deepEqual(parseVerifyDirectives('TC-14 is not a real bug', FAILING), []);
  assert.deepEqual(parseVerifyDirectives('TC-14: not confirmed', FAILING), []);
});

test('a terminal word wins inside one fragment, not just on its own line', () => {
  // `confirmed` was tested ahead of the terminal verdicts to make the "not
  // pre-existing, it's an actual bug" sentence work, which broke the documented
  // rule the other way round. The negation guard is what makes the order
  // unnecessary.
  assert.equal(parseVerifyDirectives("TC-14: invalid — don't fix it", FAILING)[0]?.verdict, 'invalid');
  assert.equal(
    parseVerifyDirectives('TC-09 pre-existing — fix it in the other ticket', FAILING)[0]?.verdict,
    'pre-existing',
  );
});

test('a line naming two cases does not confirm the one it defers', () => {
  const got = parseVerifyDirectives(
    "TC-09 — I'll come back to this one, TC-14 is a real bug", FAILING,
  );
  assert.deepEqual(got.map((x) => [x.caseId, x.verdict]), [['TC-14', 'confirmed']]);
});

test('a negation qualifying something other than the verdict leaves it alone', () => {
  // A character window let an unrelated clause disarm the verdict, and the case
  // then parked with nothing in the output naming the sentence thrown away.
  assert.equal(
    parseVerifyDirectives('TC-14 is not worth chasing — skip', FAILING)[0]?.verdict, 'skip',
  );
  // Still adjacent-negated, which is the case the guard is for.
  assert.deepEqual(parseVerifyDirectives('TC-14 is not invalid', FAILING), []);
});

test('an adverb between the negation and the keyword does not restore the inverse read', () => {
  // Pure adjacency let these through, which is the inverse read again on the
  // verdict that opens a bug on another ticket.
  for (const s of [
    'TC-14 is not really pre-existing',
    'TC-14 is not actually pre-existing',
    'TC-14 is not necessarily invalid',
    "TC-14 isn't really expected",
  ]) {
    assert.deepEqual(parseVerifyDirectives(s, FAILING), [], s);
  }
});

test('a reviewer declining a fix is not read as confirming one', () => {
  // `fix it` on its own matched every one of these, and each would have spent a
  // confirmation round and cycled the run for work nobody asked for.
  for (const s of [
    'TC-14 — no need to fix it',
    'TC-14: leave it, we will fix it in a follow-up ticket',
    'TC-14: QA will fix it offline',
    "TC-14 — I'll fix this myself, no need to cycle",
  ]) {
    assert.deepEqual(parseVerifyDirectives(s, FAILING), [], s);
  }
  // The explicit form still confirms.
  assert.equal(
    parseVerifyDirectives('TC-14: fix it in this ticket', FAILING)[0]?.verdict, 'confirmed',
  );
});

test('the plural is the form a reviewer writes, since the gate presents several cases', () => {
  assert.equal(parseVerifyDirectives('TC-14: real bugs here', FAILING)[0]?.verdict, 'confirmed');
  assert.equal(
    parseVerifyDirectives('TC-14: these are genuine issues', FAILING)[0]?.verdict, 'confirmed',
  );
  assert.deepEqual(
    parseVerifyDirectives('TC-14 and TC-09 are not pre-existing, they are actual bugs', FAILING)
      .map((x) => x.caseId).sort(),
    ['TC-09', 'TC-14'],
  );
});

test('a bare case reference takes the verdict of the list it belongs to, either direction', () => {
  // Splitting on `,` put the cases and the verdict in different fragments, so
  // every verdict lost all but one case of a plain comma-separated reply. This
  // was true before the confirm route existed.
  for (const [text, want] of [
    ['skip 14, 9', 'skip'],
    ['TC-14, TC-09: skip', 'skip'],
    ['TC-14, TC-09: invalid', 'invalid'],
    ['TC-14, TC-09: actual bug', 'confirmed'],
  ] as const) {
    const got = parseVerifyDirectives(text, FAILING);
    assert.deepEqual(got.map((x) => x.caseId).sort(), ['TC-09', 'TC-14'], text);
    assert.ok(got.every((x) => x.verdict === want), text);
  }
});

test('a clause between two cases still stops one verdict spreading across both', () => {
  // The protection the single-case guard gave, kept while comma lists work: a
  // fragment carrying prose inherits nothing, and a line whose cases are not a
  // plain list is left alone.
  const got = parseVerifyDirectives(
    "TC-09 — I'll come back to this one, TC-14 is a real bug", FAILING,
  );
  assert.deepEqual(got.map((x) => [x.caseId, x.verdict]), [['TC-14', 'confirmed']]);
});

test('a terminal verdict still wins over a confirmation in the same breath', () => {
  // The resolver prefers a terminal verdict when both are present; the parser's
  // job is only to not swallow the terminal one. First verdict wins per case,
  // so a reviewer who classifies a case has settled it.
  const got = parseVerifyDirectives('TC-14: skip\nTC-14 is a real bug', FAILING);
  assert.deepEqual(got.map((x) => x.verdict), ['skip']);
});

test('the request comment offers the confirm route alongside the four that settle a case', () => {
  const body = verifyCasesRequestBody([{ id: 'TC-14', evidence: 'expected 3 rows, got 4' }]);
  assert.match(body, /actual bug/);
  assert.match(body, /stays a FAIL/);
  assert.match(body, /back to `implement`/);
  // And it still offers every verdict that ends the case.
  for (const v of ['skip', 'invalid', 'expected', 'pre-existing', 'missing steps']) {
    assert.ok(body.includes(v), v);
  }
});

test('first verdict wins when a case is named twice', () => {
  const got = parseVerifyDirectives('skip 14\nTC-14: invalid', FAILING);
  assert.equal(got.length, 1);
  assert.equal(got[0]?.verdict, 'skip');
});

test('the request body lists each failing case and all four verdicts', () => {
  const body = verifyCasesRequestBody([{ id: 'TC-14', evidence: 'filter reset on reload' }, { id: 'TC-09' }]);
  assert.match(body, /TC-14/);
  assert.match(body, /filter reset on reload/);
  assert.match(body, /TC-09/);
  for (const w of ['skip', 'invalid', 'expected', 'pre-existing']) assert.match(body, new RegExp(w));
});

// ---------------------------------------------- verify-case gate: missing-steps

test('parses a missing-steps directive and maps it to the case', () => {
  for (const phrase of ['TC-14: missing steps', 'TC-14 steps are incomplete', '14: steps missing']) {
    const d = parseVerifyDirectives(phrase, FAILING);
    assert.deepEqual(d.map((x) => [x.caseId, x.verdict]), [['TC-14', 'missing-steps']], phrase);
  }
});

test('a terminal verdict in the same fragment beats missing-steps', () => {
  // "skip, the steps are missing anyway" is a reviewer settling the case.
  assert.equal(parseVerifyDirectives('TC-14: skip, steps missing', FAILING)[0]?.verdict, 'skip');
});

test('parseCorrectedSteps extracts a numbered list that names the case', () => {
  const reply = 'TC-14 steps:\n1. Open /pod/people\n2. Apply the 2-4 band\n3. Reload and read the footer';
  assert.deepEqual(parseCorrectedSteps(reply, 'TC-14'), [
    'Open /pod/people', 'Apply the 2-4 band', 'Reload and read the footer',
  ]);
});

test('parseCorrectedSteps accepts bullets and bare numbers for the case', () => {
  assert.deepEqual(parseCorrectedSteps('for 9:\n- first\n- second', 'TC-09'), ['first', 'second']);
});

test('parseCorrectedSteps returns null without a case reference or without steps', () => {
  assert.equal(parseCorrectedSteps('1. do a thing\n2. do another', 'TC-14'), null); // no case ref
  assert.equal(parseCorrectedSteps('TC-14 looks wrong to me', 'TC-14'), null);       // no enumerated steps
  assert.equal(parseCorrectedSteps('TC-14: skip', 'TC-14'), null);                   // a directive, not steps
});

test('the our-steps comment shows the steps followed and asks for a numbered reply', () => {
  const body = verifyOurStepsBody('TC-14', 'Filter survives reload', ['Open', 'Apply', 'Reload'], 'footer reset to 566');
  assert.match(body, /TC-14/);
  assert.match(body, /1\. Open/);
  assert.match(body, /footer reset to 566/);
  assert.match(body, /\*\*only TC-14\*\*/);
});

test('the request body lists the missing-steps option', () => {
  assert.match(verifyCasesRequestBody([{ id: 'TC-14' }]), /missing steps/i);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerifyDirectives } from './reviewgate.js';

/**
 * The verify-case reply corpus.
 *
 * Every string here is one a reviewer actually wrote, or one a review round
 * reported as mis-parsed. Four rounds of review were spent tightening regexes
 * against whichever strings the last round had named, which moved defects
 * instead of removing them: the fix for "not really pre-existing" left "not at
 * all pre-existing" inverting, and the hedge guard introduced to park a case
 * instead handed it to its neighbour's verdict.
 *
 * So the contract lives here rather than in the comments of the parser. A
 * change to `parseVerifyDirectives` is measured against this table, not against
 * the examples in the latest review. Add a row when a reviewer writes something
 * new; never delete one to make a change pass.
 */

const FAILING = ['TC-09', 'TC-14', 'TC-15'];

function parse(reply: string): string[] {
  return parseVerifyDirectives(reply, FAILING)
    .map((d) => `${d.caseId}=${d.verdict}`)
    .sort();
}

/** A reviewer settling cases. Each must bind exactly the cases named. */
const BINDS: ReadonlyArray<readonly [string, string[]]> = [
  ['TC-14: actual bug', ['TC-14=confirmed']],
  ['TC-14, TC-15: actual bug', ['TC-14=confirmed', 'TC-15=confirmed']],
  ['TC-09, TC-14 and TC-15 are all real bugs',
    ['TC-09=confirmed', 'TC-14=confirmed', 'TC-15=confirmed']],
  ['TC-14: skip. TC-09 is a real bug', ['TC-09=confirmed', 'TC-14=skip']],
  ['skip test case no. 14', ['TC-14=skip']],
  ['skip no. 14 and no. 9', ['TC-09=skip', 'TC-14=skip']],
  ['TC-14 is pre-existing', ['TC-14=pre-existing']],
  ['TC-14: fix it in this ticket', ['TC-14=confirmed']],
  ['No doubt TC-14 is a real bug', ['TC-14=confirmed']],
  ['TC-14: real bugs here', ['TC-14=confirmed']],
];

/**
 * A reviewer thinking aloud, or declining a fix. None of these is a decision,
 * and a parse that reads one as a verdict either settles a case the reviewer
 * left open or starts a fix cycle nobody asked for.
 */
const YIELDS_NOTHING: readonly string[] = [
  'TC-14 is not really pre-existing',
  'TC-14 maybe a real bug, let me check',
  'TC-14 might be pre-existing',
  'TC-14 — no need to fix it',
  'TC-14: QA will fix it offline',
  'TC-14 is not at all pre-existing',
  'TC-14 is not obviously pre-existing',
  'TC-14 is not clearly pre-existing',
  'TC-14 is not totally pre-existing',
  'TC-14 is not in any way pre-existing',
];

/**
 * A verdict reaches the case the reviewer attached it to and no other. These
 * are the rows where a verdict used to spread across a whole reply — to a
 * hedged case, backwards over a list, across a line break, or onto a build or
 * page number that was never a case at all.
 */
const BINDS_ONLY_WHAT_IS_NAMED: ReadonlyArray<readonly [string, string[]]> = [
  ['TC-14 may well be a real bug but I am sure TC-09 is pre-existing',
    ['TC-09=pre-existing']],
  ['TC-14 is pre-existing, TC-15, TC-09 I still need to look at',
    ['TC-14=pre-existing']],
  ['Cases still failing: TC-09, TC-14\nTC-15: pre-existing',
    ['TC-15=pre-existing']],
  ['Looking at TC-09, TC-14 and TC-15\n\nTC-15: skip', ['TC-15=skip']],
  ['TC-14: skip, TC-15, TC-09: actual bug',
    ['TC-09=confirmed', 'TC-14=skip', 'TC-15=confirmed']],
  ['TC-14 is a real bug in build 15', ['TC-14=confirmed']],
  ['TC-14 is a real bug on page 9', ['TC-14=confirmed']],
  ['TC-14: skip. 9 is a real bug', ['TC-09=confirmed', 'TC-14=skip']],
  ['TC-14: skip.TC-09 is a real bug', ['TC-09=confirmed', 'TC-14=skip']],
  ['TC-14: skip! TC-09 is a real bug', ['TC-09=confirmed', 'TC-14=skip']],
  ['TC-14: skip? TC-09 is a real bug', ['TC-09=confirmed', 'TC-14=skip']],
];

/**
 * A suppressed verdict leaves its case genuinely undecided — no verdict about a
 * DIFFERENT case can reach it.
 *
 * This is the property a hedge guard is for, and the previous one did not have
 * it: suppressing the keyword left the fragment verdict-less and the
 * nearest-neighbour walk then filled it in from whatever was next to it, so a
 * hedged case came out `pre-existing` and the runner opened a bug on another
 * ticket. It holds structurally now rather than by bookkeeping — a clause
 * carrying a suppressed keyword holds prose, so it is not bare, and inheritance
 * only ever flows into bare clauses.
 */
const SUPPRESSION_IS_STICKY: ReadonlyArray<readonly [string, string[]]> = [
  ['TC-14 might be pre-existing, TC-09: skip', ['TC-09=skip']],
  ['TC-14 might be pre-existing\nTC-09: skip', ['TC-09=skip']],
  ['TC-09: skip, TC-14 might be pre-existing', ['TC-09=skip']],
  ['TC-14 is not pre-existing, TC-09 is pre-existing', ['TC-09=pre-existing']],
  ['TC-14, TC-15 might be pre-existing, TC-09: skip', ['TC-09=skip']],
  ['TC-14 maybe pre-existing but TC-09 is pre-existing', ['TC-09=pre-existing']],
  ['TC-15 is not invalid; TC-09 invalid', ['TC-09=invalid']],
  ['TC-14 may be a real bug. TC-09: skip', ['TC-09=skip']],
  ['TC-09: skip. TC-14 may be pre-existing', ['TC-09=skip']],
  // Nor may a bare run take a suppressed clause's keyword, in either position.
  ['TC-15, TC-14 might be pre-existing', []],
  ['TC-14 might be pre-existing, TC-15', []],
];

/**
 * Shapes no review round named, swept before this change was pushed rather than
 * after. The first two were live defects: an ordinary numbered list bound
 * nothing, because the "1)" counted as a second case and made the clause
 * ambiguous; and `\bskip\b` matched none of the forms a reviewer conjugates.
 */
const OFF_CORPUS: ReadonlyArray<readonly [string, string[]]> = [
  ['TC-09: skip\nTC-14: pre-existing\nTC-15: actual bug',
    ['TC-09=skip', 'TC-14=pre-existing', 'TC-15=confirmed']],
  ['- TC-09: skip\n- TC-14: invalid', ['TC-09=skip', 'TC-14=invalid']],
  ['1) TC-09 skip\n2) TC-14 expected', ['TC-09=skip', 'TC-14=expected']],
  ['Skipping these: TC-09, TC-14', ['TC-09=skip', 'TC-14=skip']],
  ['These are pre-existing: TC-09 and TC-14', ['TC-09=pre-existing', 'TC-14=pre-existing']],
  ['TC-09 and TC-14 — both pre-existing', ['TC-09=pre-existing', 'TC-14=pre-existing']],
  ['TC-14: skip. I will look at the others tomorrow', ['TC-14=skip']],
  ['TC-14 is invalid but TC-09 is a real bug', ['TC-09=confirmed', 'TC-14=invalid']],
  ['TC-14 is pre-existing, however TC-09 is expected',
    ['TC-09=expected', 'TC-14=pre-existing']],
  ['TC-14 is a real bug, see comment 9', ['TC-14=confirmed']],
  ['TC-14 is a real bug per MR 15', ['TC-14=confirmed']],
  ['TC-14: expected, the 2024 figure is right', ['TC-14=expected']],
  ['TC-14 is not a real bug', []],
  ['TC-14 is definitely not pre-existing', []],
  ['I do not think TC-14 is pre-existing', []],
  ['TC-14 cannot be pre-existing', []],
  ['TC-14: missing steps', ['TC-14=missing-steps']],
  ['TC-14 — the steps are incomplete', ['TC-14=missing-steps']],
  // A case that is not in the failing list is never a directive, whatever is
  // said about it — the reviewer may be discussing a case that passed.
  ['TC-22: skip', []],
  ['tc-14: SKIP', ['TC-14=skip']],
  ['TC 14: actual bug', ['TC-14=confirmed']],
  ['#14 is pre-existing', ['TC-14=pre-existing']],
  ['case 14: invalid', ['TC-14=invalid']],
];

/**
 * Definite statements that were being dropped. `think` reads as politeness in
 * reviewer idiom rather than uncertainty, and a negated or hedged phrase can
 * still be followed by the decision itself.
 */
const READ_AS_DECISIONS: ReadonlyArray<readonly [string, string[]]> = [
  ['I think TC-14 is a real bug', ['TC-14=confirmed']],
  ['We think TC-14 is invalid', ['TC-14=invalid']],
  ['TC-14 is not worth chasing, skip it', ['TC-14=skip']],
  ['TC-14: this is not a real bug, skip', ['TC-14=skip']],
  ['TC-14 seems to be the only real bug here, the rest are pre-existing',
    ['TC-14=confirmed']],
];

for (const [reply, expected] of BINDS) {
  test(`corpus/binds: ${JSON.stringify(reply)}`, () => {
    assert.deepEqual(parse(reply), [...expected].sort());
  });
}

for (const reply of YIELDS_NOTHING) {
  test(`corpus/undecided: ${JSON.stringify(reply)}`, () => {
    assert.deepEqual(parse(reply), []);
  });
}

for (const [reply, expected] of BINDS_ONLY_WHAT_IS_NAMED) {
  test(`corpus/scoped: ${JSON.stringify(reply)}`, () => {
    assert.deepEqual(parse(reply), [...expected].sort());
  });
}

for (const [reply, expected] of READ_AS_DECISIONS) {
  test(`corpus/decisions: ${JSON.stringify(reply)}`, () => {
    assert.deepEqual(parse(reply), [...expected].sort());
  });
}

for (const [reply, expected] of SUPPRESSION_IS_STICKY) {
  test(`corpus/sticky: ${JSON.stringify(reply)}`, () => {
    assert.deepEqual(parse(reply), [...expected].sort());
  });
}

for (const [reply, expected] of OFF_CORPUS) {
  test(`corpus/sweep: ${JSON.stringify(reply)}`, () => {
    assert.deepEqual(parse(reply), [...expected].sort());
  });
}

test('corpus: a case is never settled twice by one reply', () => {
  for (const [reply] of [...BINDS, ...BINDS_ONLY_WHAT_IS_NAMED, ...READ_AS_DECISIONS, ...OFF_CORPUS, ...SUPPRESSION_IS_STICKY]) {
    const ids = parseVerifyDirectives(reply, FAILING).map((d) => d.caseId);
    assert.equal(new Set(ids).size, ids.length, reply);
  }
});

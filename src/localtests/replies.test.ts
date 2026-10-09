/**
 * QA's reply to the local-tests list, read the way QA actually write it.
 *
 * Every phrasing here is one a reviewer could type under the note. The cases
 * pin both halves of "lenient but unambiguous": the wording QA use for each
 * answer is recognised, and a reply that could mean two things goes to the
 * scope session as feedback rather than down a path that can do only one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLocalTestsReply, specPathsIn } from './replies.js';

const kind = (body: string): string | null => classifyLocalTestsReply(body)?.kind ?? null;

test('the bare word approved, in any case and with any surrounding space, approves', () => {
  assert.deepEqual(classifyLocalTestsReply('approved'), { kind: 'approved' });
  assert.deepEqual(classifyLocalTestsReply('Approved'), { kind: 'approved' });
  assert.deepEqual(classifyLocalTestsReply(' approved '), { kind: 'approved' });
  assert.deepEqual(classifyLocalTestsReply('\nAPPROVED\n'), { kind: 'approved' });
});

test('a near-approval is not a decision, so it can never approve a list by accident', () => {
  for (const body of ['Approved.', 'approved ✅', 'approved, thanks', 'approved but drop LV_21', 'looks approved to me']) {
    assert.equal(classifyLocalTestsReply(body), null, body);
  }
});

test('chatter, questions and an empty comment are not decisions', () => {
  for (const body of ['', '   ', 'Looking into this now', '@arsal.tariq can you check?', 'please check again',
    'write a temporary test', 'not approved yet']) {
    assert.equal(classifyLocalTestsReply(body), null, JSON.stringify(body));
  }
});

test('a bare disapproved: with nothing after it waits for the follow-up instead of re-running anything', () => {
  assert.equal(classifyLocalTestsReply('disapproved:'), null);
  assert.equal(classifyLocalTestsReply('disapproved:   \n  '), null);
});

test('check again, in the wordings QA use', () => {
  for (const body of [
    'disapproved: please check again',
    'disapproved: check again',
    'Disapproved: Please check again.',
    'disapproved: recheck',
    'disapproved: re-check please',
    'disapproved: test added to master, please check again',
    'disapproved: I pushed a test for this to master, look again',
    'disapproved: can you check it again?',
    "disapproved: don't write a temporary test, just check again",
  ]) {
    assert.equal(kind(body), 'check-again', body);
  }
});

test('added files are listed exactly, in the order given', () => {
  assert.deepEqual(
    classifyLocalTestsReply('disapproved: added cypress/e2e/reports/reports_25_x.ts and cypress/e2e/reports/reports_26_y.ts'),
    { kind: 'added', files: ['cypress/e2e/reports/reports_25_x.ts', 'cypress/e2e/reports/reports_26_y.ts'] },
  );
  assert.deepEqual(
    classifyLocalTestsReply('disapproved: added `cypress/e2e/leaves/LV_40_half_day.cy.ts`, please check again'),
    { kind: 'added', files: ['cypress/e2e/leaves/LV_40_half_day.cy.ts'] },
    'a path beside "check again" is the explicit form of it',
  );
  assert.deepEqual(
    classifyLocalTestsReply('disapproved:\n- added cypress/e2e/a.ts\n- added cypress/e2e/a.ts\n- added ./cypress/e2e/b.js'),
    { kind: 'added', files: ['cypress/e2e/a.ts', 'cypress/e2e/b.js'] },
    'repeated paths are named once',
  );
});

test('an added file is found behind a repo prefix, in a blob URL, or in angle brackets', () => {
  assert.deepEqual(classifyLocalTestsReply(
    'disapproved: merged https://gitlab.example.com/qa/workstream-automation/-/blob/master/cypress/e2e/reports/r_1.ts',
  ), { kind: 'added', files: ['cypress/e2e/reports/r_1.ts'] });
  assert.deepEqual(classifyLocalTestsReply('disapproved: added workstream-automation/cypress/e2e/x.cy.ts'),
    { kind: 'added', files: ['cypress/e2e/x.cy.ts'] });
  assert.deepEqual(classifyLocalTestsReply('disapproved: added <cypress/e2e/x.ts>'),
    { kind: 'added', files: ['cypress/e2e/x.ts'] });
});

test('only spec-shaped paths under cypress/ count, and never one that climbs out of it', () => {
  assert.deepEqual(specPathsIn('cypress/e2e/a.ts, cypress/e2e/b.tsx, mycypress/e2e/c.ts, cypress/../etc/d.ts'),
    ['cypress/e2e/a.ts']);
  assert.deepEqual(specPathsIn('see cypress/e2e/a.cy.ts.'), ['cypress/e2e/a.cy.ts'], 'a full stop after it is not part of it');
  assert.equal(kind('disapproved: added reports_25_x.ts'), 'feedback', 'a bare file name goes to the session to find');
});

test('write a temporary test, in the wordings QA use', () => {
  for (const body of [
    'disapproved: write a temporary test',
    'disapproved: write temporary test',
    'disapproved: Please write a temporary test for the banner.',
    'disapproved: add a temporary spec',
    'disapproved: check again, and if nothing is there write a temporary test',
  ]) {
    assert.equal(kind(body), 'write-temporary', body);
  }
});

test('a change to the list itself is feedback, carried without the prefix', () => {
  assert.deepEqual(
    classifyLocalTestsReply('disapproved:\n- remove LV_21\n- also run LV_23'),
    { kind: 'feedback', text: '- remove LV_21\n- also run LV_23' },
  );
  assert.deepEqual(classifyLocalTestsReply('disapproved: the half-day leave test still applies, keep it'),
    { kind: 'feedback', text: 'the half-day leave test still applies, keep it' });
});

test('a reply that asks for two things only the session can do together is feedback', () => {
  assert.equal(kind('disapproved: added cypress/e2e/a.ts, and remove LV_21'), 'feedback');
  assert.equal(kind('disapproved: added cypress/e2e/a.ts; also write a temporary test for the dialog'), 'feedback');
  assert.equal(kind('disapproved: please check again and drop the health checks'), 'feedback');
  assert.equal(kind('disapproved: please run cypress/e2e/leaves/LV_23.ts'), 'feedback', 'a path not said to be added');
});

test('the prefix is read leniently: copied backticks or bold, a dash, or a line break', () => {
  assert.equal(kind('`disapproved:` please check again'), 'check-again');
  assert.equal(kind('**disapproved:** please check again'), 'check-again');
  assert.equal(kind('**Disapproved**: write a temporary test'), 'write-temporary');
  assert.equal(kind('disapproved - please check again'), 'check-again');
  assert.deepEqual(classifyLocalTestsReply('Disapproved\n- remove LV_21'), { kind: 'feedback', text: '- remove LV_21' });
  assert.equal(classifyLocalTestsReply('disapproved because LV_21 is flaky'), null, 'no separator, not the reply form');
});

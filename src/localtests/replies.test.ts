/**
 * QA's reply to the local-tests list, read the way QA actually write it.
 *
 * Every phrasing here is one a reviewer could type under the note. The cases
 * pin both halves of "lenient but unambiguous": the wording QA use for each of
 * the three answers (approved, added <file>, disapproved: …) is recognised, and
 * a reply that could mean two things goes to the scope session as feedback
 * rather than down a path that can do only one.
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
    'write a temporary test', 'not approved yet', 'I added a test yesterday', 'added it, thanks']) {
    assert.equal(classifyLocalTestsReply(body), null, JSON.stringify(body));
  }
});

test('a bare disapproved: with nothing after it waits for the follow-up instead of re-running anything', () => {
  assert.equal(classifyLocalTestsReply('disapproved:'), null);
  assert.equal(classifyLocalTestsReply('disapproved:   \n  '), null);
});

test('added <file>, without disapproved:, adds exactly those files', () => {
  assert.deepEqual(classifyLocalTestsReply('added cypress/e2e/reports/reports_25_x.ts'),
    { kind: 'added', files: ['cypress/e2e/reports/reports_25_x.ts'] });
  assert.deepEqual(classifyLocalTestsReply('Added `cypress/e2e/leaves/LV_40_half_day.ts` and cypress/e2e/leaves/LV_41.ts'),
    { kind: 'added', files: ['cypress/e2e/leaves/LV_40_half_day.ts', 'cypress/e2e/leaves/LV_41.ts'] });
  assert.deepEqual(classifyLocalTestsReply('**added** cypress/e2e/a.ts'), { kind: 'added', files: ['cypress/e2e/a.ts'] });
  assert.deepEqual(classifyLocalTestsReply('pushed cypress/e2e/a.ts to master'), { kind: 'added', files: ['cypress/e2e/a.ts'] });
});

test('without disapproved:, only a reply that OPENS with added decides; one asking for more goes to the session whole', () => {
  assert.equal(classifyLocalTestsReply('I think cypress/e2e/a.ts was added last week'), null, 'mentions, not the reply form');
  assert.deepEqual(classifyLocalTestsReply('added cypress/e2e/a.ts, and remove LV_21'),
    { kind: 'feedback', text: 'added cypress/e2e/a.ts, and remove LV_21' },
    'the lookup can only add files, so the session reads it whole — never ignored, never half-done');
  assert.deepEqual(classifyLocalTestsReply('added reports_25_x.ts'), { kind: 'feedback', text: 'added reports_25_x.ts' },
    'a bare file name: the session finds it in the suite');
  assert.deepEqual(classifyLocalTestsReply('added cypress/e2e/costing/costing_15_verify_total_non billable_cost.ts'),
    { kind: 'feedback', text: 'added cypress/e2e/costing/costing_15_verify_total_non billable_cost.ts' },
    'a name with a space, not in backticks, cannot be read as one path: the session finds it');
});

test('the suite\'s real file names are read whole: & ( ) % $ < > in a bare path, a space or a comma in backticks', () => {
  for (const file of [
    'cypress/e2e/leaves/LV_19_user_can_submit_half_day_leave_Causal&Sick_only.ts',
    'cypress/e2e/teamManagement/TM_22_&_23_Verify_that_system_display_the_records_according_to_filter_and_verify_no_resignation_msg.ts',
    'cypress/e2e/competency/competency_47_erify_that_an_audit_pop-up_should_be_displayed_when_first_time_entering_SC_or_high_score_progression_grater_than_20%.ts',
    'cypress/e2e/podA/PD_73_Verify_that_current_salary_must_be_shown_in_$_dollar.ts',
    'cypress/e2e/teamReviewB/TR_94_Verify_that_team_lead_should_be_able_to_move_next_month_by_clicking_on_>_sign_on_the_calendar.ts',
    'cypress/e2e/home/HOME_12_(s)_widgets.ts',
  ]) {
    assert.deepEqual(classifyLocalTestsReply(`added ${file}`), { kind: 'added', files: [file] }, file);
  }
  const spaced = 'cypress/e2e/costing/costing_15_verify_total_non billable_cost_on_detail_page.ts';
  const comma = 'cypress/e2e/teamReviewA/TR_87_Verify_that_the_team_name,sub_team_name_and_their_presentation_date.ts';
  assert.deepEqual(classifyLocalTestsReply(`added \`${spaced}\` and \`${comma}\``), { kind: 'added', files: [spaced, comma] });
  assert.deepEqual(classifyLocalTestsReply(`disapproved: added \`./${spaced}\``), { kind: 'added', files: [spaced] });
  assert.deepEqual(specPathsIn('added cypress/e2e/a.ts,cypress/e2e/b.ts and (cypress/e2e/c.ts)'),
    ['cypress/e2e/a.ts', 'cypress/e2e/b.ts', 'cypress/e2e/c.ts'], 'a comma or a closing bracket ends a bare path');
});

test('disapproved: added files are listed exactly, in the order given', () => {
  assert.deepEqual(
    classifyLocalTestsReply('disapproved: added cypress/e2e/reports/reports_25_x.ts and cypress/e2e/reports/reports_26_y.ts'),
    { kind: 'added', files: ['cypress/e2e/reports/reports_25_x.ts', 'cypress/e2e/reports/reports_26_y.ts'] },
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

test('a change to the list itself is feedback, carried without the prefix', () => {
  assert.deepEqual(
    classifyLocalTestsReply('disapproved:\n- remove LV_21\n- also run LV_23'),
    { kind: 'feedback', text: '- remove LV_21\n- also run LV_23' },
  );
  assert.deepEqual(classifyLocalTestsReply('disapproved: the half-day leave test still applies, keep it'),
    { kind: 'feedback', text: 'the half-day leave test still applies, keep it' });
});

test('the retired answers are feedback now: the session works on a fresh checkout of master and writes no test', () => {
  // "check again" was a cheap re-check of master; a fresh scope checks master
  // too. "write a temporary test" is not offered any more: QA add the file to
  // workstream-automation and reply `added <file>`.
  assert.deepEqual(classifyLocalTestsReply('disapproved: please check again'),
    { kind: 'feedback', text: 'please check again' });
  assert.equal(kind('disapproved: write a temporary test'), 'feedback');
});

test('a reply that asks for two things only the session can do together is feedback', () => {
  assert.equal(kind('disapproved: added cypress/e2e/a.ts, and remove LV_21'), 'feedback');
  assert.equal(kind('disapproved: please check again and drop the main-functionality tests of payroll'), 'feedback');
  assert.equal(kind('disapproved: please run cypress/e2e/leaves/LV_23.ts'), 'feedback', 'a path not said to be added');
});

test('the prefix is read leniently: copied backticks or bold, a dash, or a line break', () => {
  assert.equal(kind('`disapproved:` remove LV_21'), 'feedback');
  assert.equal(kind('**disapproved:** added cypress/e2e/a.ts'), 'added');
  assert.equal(kind('**Disapproved**: also run LV_23'), 'feedback');
  assert.equal(kind('disapproved - added cypress/e2e/a.ts'), 'added');
  assert.deepEqual(classifyLocalTestsReply('Disapproved\n- remove LV_21'), { kind: 'feedback', text: '- remove LV_21' });
  assert.equal(classifyLocalTestsReply('disapproved because LV_21 is flaky'), null, 'no separator, not the reply form');
});

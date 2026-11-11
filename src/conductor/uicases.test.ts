/**
 * A case posted for QA is a UI case. #9174's TC-21 — "run the MR's Django test
 * class, expect four tests OK" — failed six verify laps that nineteen UI cases
 * passed, and was skipped by hand in the end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeLevelTool, leftOutLine, splitUiCases } from './uicases.js';

const ui = (over: Record<string, unknown> = {}) => ({
  id: 'TC-01', scenario: 'Verify that clicking Delete on a team change page asks for confirmation',
  precondition: 'A team named Ops exists', steps: ['Open /admin/teams/team/1/change/', 'Click Delete'],
  expected: 'A dialog reads "Are you sure you want to delete the team "Ops"?"', ...over,
});

test('a case made of the project\'s own test run is code-level, however it is worded', () => {
  // #9174's TC-21, as it was approved.
  assert.equal(codeLevelTool(ui({
    scenario: "Verify that this MR's own Django test class passes",
    steps: ['Run `python manage.py test apps.teams.tests.admin_test.AdminDeleteConfirmPopupTest -v 2 --settings=hrdb.test_settings`'],
    expected: "The command reports 'Ran 4 tests' and 'OK'",
  })), 'manage.py test');
  assert.equal(codeLevelTool(ui({ steps: ['Run pytest apps/teams -k delete'], expected: '3 passed' })), 'pytest');
  assert.equal(codeLevelTool(ui({ steps: ['CI=true npx jest --watchAll=false src/x.test.js'], expected: 'Tests: 2 passed' })), 'jest');
  assert.equal(codeLevelTool(ui({ steps: ['npm test'], expected: 'green' })), 'npm test');
});

test('a linter, a type check or a build as the check is code-level too', () => {
  assert.equal(codeLevelTool(ui({ steps: ['Check that flake8 reports nothing on the changed files'] })), 'flake8');
  assert.equal(codeLevelTool(ui({ expected: 'pylint exits 0' })), 'pylint');
  assert.equal(codeLevelTool(ui({ steps: ['npx eslint frontend/src/teams'] })), 'a lint or type check');
  assert.equal(codeLevelTool(ui({ steps: ['Run tsc --noEmit'] })), 'tsc');
  assert.equal(codeLevelTool(ui({ steps: ['npm run build'] })), 'a build or lint script');
  // A command line is the check wherever the case writes it, its title included.
  assert.equal(codeLevelTool(ui({ scenario: 'npm run lint passes on the new component' })), 'a build or lint script');
});

test('a UI case whose title only mentions a tool stays in the list', () => {
  // The case is browser steps; the title says where the bug was first seen.
  assert.equal(codeLevelTool(ui({ scenario: 'Regression for the bug the Jest snapshot missed: adding a team' })), null);
  assert.equal(codeLevelTool(ui({ scenario: 'Team name that pytest fixtures never covered (unicode)' })), null);
});

test('a UI case is a UI case', () => {
  assert.equal(codeLevelTool(ui()), null);
});

test('seeding data from the shell in a precondition does not make a UI case code-level', () => {
  // Thirteen of #9174's nineteen passing UI cases seeded their team this way.
  assert.equal(codeLevelTool(ui({
    precondition: 'In `python manage.py shell`: import ssl, hashlib; Team.add_root(name="Ops\' <Team>")',
  })), null);
  // Nor does a step that seeds through the shell: it is not a test run.
  assert.equal(codeLevelTool(ui({ steps: ['In python manage.py shell, create a team named Ops', 'Open its change page', 'Click Delete'] })), null);
});

test('ordinary words that merely resemble a tool name are left alone', () => {
  assert.equal(codeLevelTool(ui({ expected: 'The page lists the test teams, etc., in order' })), null);
  assert.equal(codeLevelTool(ui({ scenario: 'Verify that the Jesting team can be deleted' })), null);
  assert.equal(codeLevelTool(ui({ steps: ['Open the Test Cases tab and click Run'] })), null);
});

test('a list is split into what QA is shown and what is left out, in order', () => {
  const cases = [
    ui({ id: 'TC-01' }),
    ui({ id: 'TC-21', scenario: 'Verify that the Django tests   pass', steps: ['python manage.py test apps.teams'], expected: 'OK' }),
    ui({ id: 'TC-02' }),
  ];
  const r = splitUiCases(cases);
  assert.deepEqual(r.ui.map((c) => c.id), ['TC-01', 'TC-02']);
  assert.deepEqual(r.leftOut, [{ id: 'TC-21', scenario: 'Verify that the Django tests   pass', tool: 'manage.py test' }]);
  assert.equal(leftOutLine(r.leftOut[0]!), 'TC-21: Verify that the Django tests pass (manage.py test)');
});

test('a list with nothing code-level in it comes back whole', () => {
  const cases = [ui({ id: 'TC-01' }), ui({ id: 'TC-02' })];
  assert.deepEqual(splitUiCases(cases), { ui: cases, leftOut: [] });
});

test('a malformed case is judged on what it has, not thrown on', () => {
  assert.equal(codeLevelTool({ scenario: 'x', steps: undefined as unknown as string[], expected: undefined as unknown as string }), null);
});

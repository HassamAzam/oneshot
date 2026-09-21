import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROMPTS, touchesRenderedUi, type PromptCtx } from './prompts.js';

function reviewPrompt(filesChanged: string[]): string {
  const ctx = {
    ticket: { iid: 1, title: 't', description: '', labels: [] },
    runId: 'r', lap: 0, journal: {} as PromptCtx['journal'],
    prior: { implement: { filesChanged } },
  } as PromptCtx;
  return PROMPTS.review!(ctx);
}

test('rendered UI — components, containers and style sheets — reaches the a11y reviewer', () => {
  assert.equal(touchesRenderedUi(['frontend/src/components/header/Header.js']), true);
  assert.equal(touchesRenderedUi(['frontend/src/jss/components/commonStyles.js']), true);
  assert.equal(touchesRenderedUi(['frontend/src/components/site_map/styles/siteMapStyles.js']), true);
});

test('pure logic, tests and backend do not', () => {
  assert.equal(touchesRenderedUi(['frontend/src/common/utils/misc.js']), false);
  assert.equal(touchesRenderedUi(['frontend/src/reducers/header.js']), false);
  assert.equal(touchesRenderedUi(['frontend/src/components/header/__tests__/Header.test.js']), false);
  assert.equal(touchesRenderedUi(['frontend/src/components/header/__tests__/__snapshots__/Header.test.js.snap']), false);
  assert.equal(touchesRenderedUi(['apps/payroll/views.py']), false);
});

test('the review prompt names accessibility-reviewer-agent exactly when UI changed', () => {
  assert.match(reviewPrompt(['frontend/src/components/header/Header.js']), /`accessibility-reviewer-agent`/);
  assert.doesNotMatch(reviewPrompt(['frontend/src/common/utils/misc.js']), /accessibility-reviewer-agent/);
  assert.doesNotMatch(reviewPrompt(['apps/payroll/views.py']), /accessibility-reviewer-agent/);
});

test('agents are dispatched in the background and collected on a bounded wait', () => {
  const p = reviewPrompt(['apps/payroll/views.py']);
  assert.match(p, /run_in_background: true/);
  assert.match(p, /`TaskOutput`/);
  // The point of the bound: an agent still running at the mark is dropped from
  // the review, not waited for until the phase dies with it.
  assert.match(p, /NOT REVIEWED/);
});

test('dead-code-sweep is run in-session, never dispatched as another child', () => {
  const p = reviewPrompt(['apps/payroll/views.py']);
  assert.match(p, /`dead-code-sweep` is a skill, not an agent/);
  assert.match(p, /Do not\ndispatch it as another child/);
});

test('the phase quotes its own configured budget and names the partial file', () => {
  const p = reviewPrompt(['apps/payroll/views.py']);
  assert.match(p, /LAND THE PLANE/);
  assert.match(p, /review-partial\.json/);
  // Quoted from config/phases.json, never typed into the prose.
  assert.match(p, /Your budget is \d+ minutes and \d+ turns/);
});

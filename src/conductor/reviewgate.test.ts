import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planApprovalRequestBody } from './reviewgate.js';
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

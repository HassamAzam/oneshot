import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  declaredFiles, planApprovalRequestBody, testcasesApprovalRequestBody, testcasesApprovedRecordBody,
} from './reviewgate.js';
import { planNoteBody, renderPlanMd } from '../lib/publish.js';

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
  assert.ok(md.includes('## Reuse before writing'), 'the sections after the table survive');
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

/** A plan carrying the overview fields: one changed view on the path from a page to a model. */
const overviewPlan = {
  ...newPlan,
  steps: [
    { n: 1, what: 'Add the key', files: ['apps/leaves/views.py'], layer: 'backend' },
    { n: 2, what: 'Show the row', files: ['frontend/src/leaves/Row.js'], layer: 'frontend' },
  ],
  fileChanges: [
    { path: 'apps/leaves/views.py', action: 'modify', area: 'backend', what: 'Add `maternity_cycle` to the payload' },
    { path: 'frontend/src/leaves/Row.js', action: 'create', area: 'frontend', what: 'New maternity row' },
  ],
  flow: {
    nodes: [
      { id: 'row', label: 'MaternityRow', kind: 'component', change: 'new', detail: [] },
      { id: 'view', label: 'LeaveSummaryView', kind: 'endpoint', change: 'modified', detail: ['+ maternity_cycle key'] },
      { id: 'limit', label: 'LeaveLimit', kind: 'model', change: 'unchanged', detail: [] },
    ],
    edges: [
      { from: 'row', to: 'view', label: 'GET leave_summary/get/' },
      { from: 'view', to: 'limit', label: 'reads count' },
    ],
  },
};

test('gate comment draws the flow first, then the prose, then the file tables over the folded steps', () => {
  const body = planApprovalRequestBody(overviewPlan, 'why');
  const flow = body.indexOf('**Flow** — the runtime path this plan touches\n\n```mermaid\n');
  const approach = body.indexOf('**Approach**');
  const questions = body.indexOf('**Open questions**');
  const files = body.indexOf('**What changes** — 2 files · 🆕 1 new · ✏️ 1 modified');
  const steps = body.indexOf('<details>\n<summary><b>Implementation steps</b> (2)');
  assert.ok(flow > 0, 'the diagram is drawn');
  assert.ok(flow < approach && approach < questions && questions < files && files < steps, body);
  assert.match(body, /\n\n1\. \*\*\[backend\]\*\* Add the key — `apps\/leaves\/views\.py`\n2\. /, 'the steps are all still there');
  assert.match(body, /\n\n<\/details>\n\n\*\*Acceptance coverage\*\*/, 'the fold closes before the next section');
  assert.doesNotMatch(body, /\*\*Steps\*\*/);
});

test('gate comment keeps the steps open and draws nothing extra for a plan without the overview fields', () => {
  for (const plan of [oldPlan, newPlan]) {
    const body = planApprovalRequestBody(plan, 'why');
    assert.match(body, /\*\*Steps\*\*\n1\. /);
    assert.doesNotMatch(body, /```mermaid|<details>|What changes/);
  }
});

test('a flow the renderer cannot draw leaves the rest of the gate comment intact', () => {
  const broken = { ...overviewPlan, flow: { nodes: [{ id: 'x', label: 'X', kind: 'viewset', change: 'new' }], edges: 'no' } };
  const body = planApprovalRequestBody(broken, 'why');
  assert.doesNotMatch(body, /```mermaid/);
  assert.match(body, /\*\*What changes\*\* — 2 files/);
});

test('plan markdown gains Flow and What changes sections and keeps its full steps table', () => {
  const md = renderPlanMd(1, 't', overviewPlan);
  const flow = md.indexOf('## Flow — the runtime path this plan touches\n```mermaid\n');
  const approach = md.indexOf('## Approach');
  const files = md.indexOf('## What changes\n2 files · 🆕 1 new · ✏️ 1 modified');
  const steps = md.indexOf('## Steps\n| # | Layer | Change | Files |');
  assert.ok(flow > 0 && flow < approach && approach < files && files < steps, md);
  assert.doesNotMatch(renderPlanMd(1, 't', newPlan), /## Flow|## What changes/);
});

test('the plan note carries the diagram and the file tables inline, where GitLab draws them', () => {
  const note = planNoteBody(overviewPlan);
  assert.deepEqual(note.warnings, []);
  assert.match(note.body, /^\*\*Plan\*\* — how Oneshot intends to implement this\.\n\n> Darken the bar colour\n\n\*\*Flow\*\*/);
  assert.match(note.body, /```mermaid\n[\s\S]+\n```\n\n<sub>/);
  assert.match(note.body, /\*\*What changes\*\* — 2 files[\s\S]+\n\n2 step\(s\)\. Full plan attached/);
  const old = planNoteBody(oldPlan);
  assert.equal(old.body, '**Plan** — how Oneshot intends to implement this.\n\n> Darken the bar colour\n\n'
    + '1 step(s). Full plan attached; implementation follows it unless a step proves wrong.');
});

test('the plan note hands back what the renderers dropped, so the publisher can log it', () => {
  const note = planNoteBody({
    ...overviewPlan,
    fileChanges: [...overviewPlan.fileChanges, { path: 'x.py', action: 'rename', area: 'backend', what: '' }],
    flow: { ...overviewPlan.flow, edges: [...overviewPlan.flow.edges, { from: 'row', to: 'ghost', label: '' }] },
  });
  assert.equal(note.warnings.length, 2);
  assert.match(note.warnings.join('\n'), /ghost/);
  assert.match(note.warnings.join('\n'), /rename/);
});

test('a file named only in fileChanges still counts toward the guarded-path gate', () => {
  const plan = {
    steps: [{ n: 1, what: 'x', files: ['apps/leaves/views.py'], layer: 'backend' }],
    fileChanges: [{ path: 'apps/payroll/utils.py', action: 'modify', area: 'backend', what: 'x' }],
  };
  assert.deepEqual(declaredFiles(plan, { filesChanged: ['apps/leaves/tests.py'] }),
    ['apps/leaves/views.py', 'apps/payroll/utils.py', 'apps/leaves/tests.py']);
  assert.deepEqual(declaredFiles(null, null), []);
  // A row the table cannot draw (area off the enum) is still a file the planner
  // named: the gate reads the raw path, not the renderer's validated rows.
  assert.deepEqual(declaredFiles({
    steps: [],
    fileChanges: [{ path: 'apps/payroll/views.py', action: 'modify', area: 'Backend', what: 'x' }],
  }, null), ['apps/payroll/views.py']);
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

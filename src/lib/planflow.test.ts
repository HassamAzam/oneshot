import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  flowBlock, flowSection, GITLAB_MERMAID_MAX_CHARS, mmText, renderFlowMermaid,
} from './planflow.js';

const node = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, label: id, kind: 'backend-logic', change: 'modified', detail: [], ...over });

const N = (id: string, label: string, kind: string, change: string, ...detail: string[]) =>
  ({ id, label, kind, change, detail });
const E = (from: string, to: string, label = '') => ({ from, to, label });

/** #8765's flow as hand-traced from its plan and research: 18 nodes, 20 edges — the largest real plan so far. */
const T8765 = {
  nodes: [
    N('summary', 'LeaveSummary', 'component', 'modified', '+ maternity row branch'),
    N('row', 'MaternityLeaveRow', 'component', 'new', 'row, cycle caption, exhausted notice'),
    N('request', 'LeaveRequest', 'component', 'modified', 'setFieldError + disable Submit on violation'),
    N('form', 'LeaveForm', 'component', 'modified', '+ panel under Leave Type'),
    N('panel', 'MaternityPolicyPanel', 'component', 'new'),
    N('msg', 'MaternityPolicyMessage', 'component', 'new', 'inline error + remedy button'),
    N('bar', 'MaternityQuotaBar', 'component', 'new'),
    N('cycleutil', 'maternityCycle.js', 'frontend-logic', 'new', 'getMaternityPolicyViolation', 'buildQuotaSegments'),
    N('halfday', 'LeaveTypesWithHalfDayDisabled', 'frontend-logic', 'removed', 'dead constant, imported nowhere'),
    N('summaryview', 'LeaveSummaryView', 'endpoint', 'modified', '+ maternity_cycle key'),
    N('choicesview', 'LeaveChoicesView', 'endpoint', 'modified', '+ maternity_cycle key'),
    N('applyview', 'LeaveRequestView', 'endpoint', 'unchanged'),
    N('personinfo', 'get_person_leave_info()', 'backend-logic', 'unchanged', 'count == 0 means not allowed'),
    N('cyclesummary', 'get_maternity_cycle_summary()', 'backend-logic', 'new', 'window, availed, pending, remaining'),
    N('validate', 'validate_leave()', 'backend-logic', 'modified', 'uses shared helper, same rules'),
    N('incycle', 'maternity_records_in_cycle()', 'backend-logic', 'new', 'extracted from validate_leave'),
    N('leavelimit', 'LeaveLimit', 'model', 'unchanged'),
    N('mig', '0020_add_employee_maternity_leave_limit', 'migration', 'new', '+ row: Maternity, EMPLOYEE, count 90'),
  ],
  edges: [
    E('summary', 'summaryview', 'GET leave_summary/get/'), E('request', 'choicesview', 'GET choices/get/'),
    E('request', 'applyview', 'POST request/apply/'), E('summary', 'row', 'renders'), E('row', 'bar'),
    E('request', 'form'), E('form', 'panel', 'if Maternity'), E('panel', 'bar'),
    E('request', 'msg', 'on violation'), E('request', 'cycleutil', 'checks dates'), E('bar', 'cycleutil'),
    E('summaryview', 'personinfo'), E('choicesview', 'personinfo'), E('summaryview', 'cyclesummary'),
    E('choicesview', 'cyclesummary'), E('cyclesummary', 'incycle'), E('applyview', 'validate'),
    E('validate', 'incycle'), E('personinfo', 'leavelimit', 'reads count'), E('mig', 'leavelimit', 'seeds row'),
  ],
};

test('model text that could end a label, open a tag or start a directive is entity-encoded, # first', () => {
  assert.equal(mmText('a"b', 99), 'a#quot;b');
  assert.equal(mmText('C#_x;', 99), 'C#35;_x;');
  assert.equal(mmText('<img src=x>', 99), '#lt;img src=x#gt;');
  assert.equal(mmText('a & b | c `d` 50%', 99), 'a #amp; b #124; c #96;d#96; 50#37;');
  assert.equal(mmText('%%{init: {}}%%', 99), '#37;#37;{init: {}}#37;#37;');
});

test('the words style and classDef are neutralised so Mermaid\'s pre-pass cannot eat an entity\'s semicolon', () => {
  assert.equal(mmText('style:"x"', 99), '#115;tyle:#quot;x#quot;');
  assert.equal(mmText('classDef', 99), '#99;lassDef');
});

test('a label is flattened to one line and loses bidi and zero-width characters', () => {
  assert.equal(mmText('a\n\tb\r\nc', 99), 'a b c');
  assert.equal(mmText('ab‮cd​', 99), 'ab cd');
});

test('a long label is cut on code points with an ellipsis, so an emoji is never split', () => {
  assert.equal(mmText('abcdefgh', 5), 'abcd…');
  assert.equal(mmText('🧪🧪🧪🧪🧪🧪', 3), '🧪🧪…');
});

test('node ids are generated, so a node the model called "end" cannot break the parse', () => {
  const r = renderFlowMermaid({
    nodes: [node('end'), node('subgraph'), node('graph')],
    edges: [E('end', 'subgraph'), E('subgraph', 'graph')],
  })!;
  assert.match(r.mermaid, /^n1\[\["~\u00a0end"\]\]:::M$/m);
  assert.match(r.mermaid, /^n1 --> n2$/m);
  assert.doesNotMatch(r.mermaid, /^end\[/m);
});

test('an edge to a missing node, a self edge or a repeated edge is dropped with a warning, never repaired', () => {
  const r = renderFlowMermaid({
    nodes: [node('a'), node('b')],
    edges: [E('a', 'missing'), E('a', 'a'), E('a', 'b'), E('a', 'b', 'again')],
  })!;
  assert.equal(r.flow.edges.length, 1);
  assert.equal(r.warnings.length, 3);
  assert.doesNotMatch(r.mermaid, /missing/);
});

test('a node with an unknown kind or change is dropped, and a flow with nothing left draws nothing', () => {
  assert.equal(renderFlowMermaid({ nodes: [node('a', { kind: 'viewset' })], edges: [] }), null);
  assert.equal(renderFlowMermaid({ nodes: [node('a', { change: 'tweaked' })], edges: [] }), null);
  assert.equal(renderFlowMermaid(undefined), null);
  assert.equal(renderFlowMermaid({}), null);
  assert.equal(renderFlowMermaid('not a flow'), null);
  assert.equal(flowSection(undefined), '');
  assert.equal(flowBlock(null), '');
});

test('each status gets its glyph and colour class, and a removed node is struck through', () => {
  const r = renderFlowMermaid({
    nodes: [
      node('a', { change: 'new', label: '+ Foo' }),
      node('b', { change: 'removed' }),
      node('c', { change: 'unchanged', kind: 'model' }),
    ],
    edges: [],
  })!;
  assert.match(r.mermaid, /n1\[\["\+\u00a0Foo"\]\]:::N/);
  assert.match(r.mermaid, /n2\[\["−\u00a0<s>b<\/s>"\]\]:::R/);
  assert.match(r.mermaid, /n3\[\("c"\)\]:::U/);
});

test('only the classes a node uses are defined, and no classDef line ends in a semicolon', () => {
  const r = renderFlowMermaid({ nodes: [node('a', { change: 'new' })], edges: [] })!;
  const defs = r.mermaid.split('\n').filter((l) => l.startsWith('classDef'));
  assert.deepEqual(defs.map((l) => l.split(' ')[1]), ['N']);
  assert.ok(defs.every((l) => !l.endsWith(';')));
});

// Ids follow the planner's node order; the boxes follow the layer order. Both matter:
// the ids keep edges stable across a re-render, the boxes keep Frontend on top.
test('each kind lands in its layer box: components in Frontend, endpoints in Backend, models in Data', () => {
  const r = renderFlowMermaid({
    nodes: [node('m', { kind: 'model' }), node('c', { kind: 'component' }), node('v', { kind: 'endpoint' })],
    edges: [E('c', 'v'), E('v', 'm')],
  })!;
  const src = r.mermaid;
  const fe = src.indexOf('subgraph FE[Frontend]');
  const be = src.indexOf('subgraph BE[Backend]');
  const db = src.indexOf('subgraph DB[Data]');
  assert.ok(fe > 0 && fe < be && be < db, 'layers are emitted top to bottom');
  assert.match(src, /subgraph FE\[Frontend\]\nn2\(\["~\u00a0c"\]\):::M\nend/);
  assert.match(src, /subgraph DB\[Data\]\nn1\[\("~\u00a0m"\)\]:::M\nend/);
  assert.doesNotMatch(src, /subgraph EX/, 'an empty layer draws no box');
});

test('a migration reaches its model through a dotted edge', () => {
  const r = renderFlowMermaid({
    nodes: [node('mig', { kind: 'migration', change: 'new' }), node('m', { kind: 'model', change: 'unchanged' })],
    edges: [E('mig', 'm', 'seeds row')],
  })!;
  assert.match(r.mermaid, /^n1 -\.->\|"seeds row"\| n2$/m);
});

test('model field changes keep their diff marker, and overflow collapses to "… N more"', () => {
  const r = renderFlowMermaid({
    nodes: [node('m', {
      kind: 'model', change: 'new',
      detail: ['+ a: DateField', '- b', '~ c: 1 → 2', '+ d', '+ e', '+ f'],
    })],
    edges: [],
  })!;
  assert.match(r.mermaid, /<br>\+\u00a0a: DateField<br>−\u00a0b<br>~\u00a0c: 1 → 2<br>… 3 more/);
});

test('hostile text cannot put an ampersand, a fence closer or an unbalanced quote into the source', () => {
  const hostile = '&"`<>|%#;```~~~\n```';
  const r = renderFlowMermaid({
    nodes: [node('a', { label: hostile, detail: [hostile] }), node('b', { label: hostile })],
    edges: [E('a', 'b', hostile)],
  })!;
  assert.doesNotMatch(r.mermaid, /&/);
  assert.ok(r.mermaid.split('\n').every((l) => !/^ {0,3}(`{3,}|~{3,})/.test(l)));
  for (const line of r.mermaid.split('\n').filter((l) => /^n\d/.test(l))) {
    assert.equal((line.match(/"/g) ?? []).length % 2, 0, line);
  }
});

test('the largest real plan so far, #8765, fits under GitLab\'s 2000 characters without a Display click', () => {
  const r = renderFlowMermaid(T8765)!;
  assert.equal(r.warnings.length, 0, r.warnings.join('; '));
  assert.equal(r.flow.nodes.length, 18);
  assert.ok(r.fits);
  assert.ok(r.chars <= GITLAB_MERMAID_MAX_CHARS - 10, String(r.chars));
  assert.match(r.mermaid, /-->\|"GET leave_summary\/get\/"\|/, 'the HTTP call survives the budget');
  assert.match(r.mermaid, /0020_add_employee_maternity_leave_limit/);
});

test('a flow too big for the budget sheds detail, rung by rung, until it fits', () => {
  const nodes = Array.from({ length: 18 }, (_, i) => node(`x${i}`, {
    label: `a_rather_long_function_name_number_${i}()`,
    change: i % 4 === 0 ? 'unchanged' : 'modified',
    detail: ['+ first detail line that is fairly long', '+ second detail line, also long'],
  }));
  const edges = nodes.slice(1).map((n, i) => E(nodes[i]!.id, n.id, 'GET /api/v1/some/long/path/'));
  const r = renderFlowMermaid({ nodes, edges })!;
  assert.ok(r.fits);
  assert.ok(r.rung > 0);
  assert.ok(r.chars <= GITLAB_MERMAID_MAX_CHARS - 10, String(r.chars));
});

test('over 18 nodes, every changed node is kept before any context node', () => {
  const nodes = [
    ...Array.from({ length: 5 }, (_, i) => node(`u${i}`, { change: 'unchanged' })),
    ...Array.from({ length: 16 }, (_, i) => node(`c${i}`)),
  ];
  const r = renderFlowMermaid({ nodes, edges: [] })!;
  assert.equal(r.flow.nodes.length, 18);
  assert.equal(r.flow.nodes.filter((n) => n.change === 'unchanged').length, 2);
  assert.match(r.warnings.join('\n'), /3 node\(s\) over the 18-node cap dropped/);
});

test('the block is a mermaid fence plus a key naming only the statuses and shapes drawn', () => {
  const s = flowSection({ nodes: [node('a', { kind: 'model', change: 'new' })], edges: [] });
  assert.match(s, /^```mermaid\n---\nconfig:\n {2}layout: elk\n/);
  assert.match(s, /\n```\n\n<sub>🟩 `\+` new — cylinder = model<\/sub>$/);
  assert.doesNotMatch(s, /modified|hexagon/);
});

/**
 * The design-eval verdict is graded on hand-built attachment lists, so the
 * rule "every before, screenshot and mockup HTML the design named is carried
 * by the comment about to be posted" cannot drift.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DesignArtifact, DesignScreen, UiSurface } from '../phases/types.js';
import {
  MAX_HTML_REPAIRS, appendRound, checkBeforePosting, expectedFiles, formatDesignEval, gradeSurfaces,
  missingItems, nextRepair, repairDue, roundPasses, routeEvidenceHolds, summariseDesignEval,
  type BeforePostingCheck, type HtmlCheck,
} from './designeval.js';

const screen = (id: string, over: Partial<DesignScreen> = {}): DesignScreen => ({
  id, name: id, purpose: 'p', states: [], note: '',
  mockupHtml: `design/${id}.html`, screenshot: `design/${id}.png`, before: `design/${id}-before.png`, ...over,
});
const design = (screens: DesignScreen[], prototype: DesignArtifact['prototype'] = null): Partial<DesignArtifact> => ({
  applicable: true, screens, prototype,
});
const always = (): boolean => true;

/** What the gate attaches for whole screens: `designAttachments` names each file by its basename. */
const attachedFor = (...ids: string[]): string[] =>
  ids.flatMap((id) => [`${id}-before.png`, `${id}.png`, `${id}.html`]);

const check = (over: Partial<BeforePostingCheck>): HtmlCheck[] => checkBeforePosting({
  design: null, attached: [], onDisk: always, surfaces: [], evidenceHolds: () => false, ...over,
});

test('each screen expects its before, screenshot and html, and the prototype entry comes last', () => {
  const d = design([screen('a'), screen('b', { before: '' })], { entry: 'design/prototype/index.html', video: 'design/walk.webm' });
  assert.deepEqual(expectedFiles(d), [
    { file: 'design/a-before.png', owner: 'a', kind: 'before' },
    { file: 'design/a.png', owner: 'a', kind: 'screenshot' },
    { file: 'design/a.html', owner: 'a', kind: 'html' },
    { file: 'design/b.png', owner: 'b', kind: 'screenshot' },
    { file: 'design/b.html', owner: 'b', kind: 'html' },
    { file: 'design/prototype/index.html', owner: 'prototype', kind: 'html' },
  ]);
  assert.deepEqual(expectedFiles(null), []);
});

test('a prepared comment carrying every file of every screen passes', () => {
  const files = check({ design: design([screen('a'), screen('b')]), attached: attachedFor('a', 'b') });
  assert.ok(files.every((f) => f.status === 'attached'));
  assert.equal(roundPasses(files), true);
});

test('a prepared comment carrying only the images fails on every html', () => {
  const files = check({
    design: design([screen('a'), screen('b')]),
    attached: ['a-before.png', 'a.png', 'b-before.png', 'b.png'],
  });
  assert.deepEqual(files.filter((f) => f.status !== 'attached').map((f) => [f.file, f.kind, f.status]),
    [['design/a.html', 'html', 'not-attached'], ['design/b.html', 'html', 'not-attached']]);
  assert.equal(roundPasses(files), false);
});

test('a screenshot on disk the comment dropped fails the round and is named', () => {
  const files = check({
    design: design([screen('login'), screen('wrong-password')]),
    attached: [...attachedFor('login'), 'wrong-password-before.png', 'wrong-password.html'],
  });
  assert.deepEqual(files.filter((f) => f.status !== 'attached').map((f) => [f.file, f.kind, f.status]),
    [['design/wrong-password.png', 'screenshot', 'not-attached']]);
  assert.equal(roundPasses(files), false);
  assert.deepEqual(missingItems(files), ['design/wrong-password.png']);
});

test('an empty before is not expected, so a new screen passes without one', () => {
  const files = check({ design: design([screen('a', { before: '' })]), attached: ['a.png', 'a.html'] });
  assert.equal(roundPasses(files), true);
});

test('a file the design named but never wrote is reported as missing on disk, not as dropped', () => {
  const files = check({
    design: design([screen('a'), screen('b')]),
    attached: attachedFor('a', 'b'),
    onDisk: (f) => f !== 'design/b.png',
  });
  assert.deepEqual(files.filter((f) => f.status !== 'attached').map((f) => [f.file, f.status]),
    [['design/b.png', 'missing-on-disk']]);
  assert.equal(roundPasses(files), false);
});

test('a missing prototype entry fails a flow change even when every screen is carried', () => {
  const d = design([screen('a')], { entry: 'design/prototype/index.html', video: '' });
  const files = check({ design: d, attached: attachedFor('a') });
  assert.deepEqual(files.filter((f) => f.status !== 'attached').map((f) => [f.owner, f.kind]), [['prototype', 'html']]);
});

test('a file renamed to its dashed path for a basename clash still counts', () => {
  const d = design([
    screen('a', { mockupHtml: 'design/x/index.html', before: '' }),
    screen('b', { mockupHtml: 'design/y/index.html', before: '' }),
  ]);
  const files = check({ design: d, attached: ['a.png', 'b.png', 'index.html', 'design-y-index.html'] });
  assert.equal(roundPasses(files), true);
});

test('a design with no files cannot pass', () => {
  assert.equal(roundPasses([]), false);
});

test('rounds accumulate and the report totals them', () => {
  const pass = { at: 't', attempt: 0, pass: true,
    files: [{ file: 'design/a.html', owner: 'a', kind: 'html' as const, status: 'attached' as const }] };
  const fail = { at: 't', attempt: 1, pass: false,
    files: [{ file: 'design/a.html', owner: 'a', kind: 'html' as const, status: 'not-attached' as const }] };
  const rec = appendRound(appendRound(null, 5, pass), 5, fail);
  assert.equal(rec.rounds.length, 2);
  assert.deepEqual(summariseDesignEval([rec]), {
    tickets: 1, rounds: 2, passed: 1, files: 2, attached: 1, notAttached: 1, missingOnDisk: 0,
    screensMissing: 0, beforesMissing: 0,
  });
  const lines = formatDesignEval([rec]);
  assert.match(lines[0] ?? '', /#5 attempt 0 {2}PASS {2}1\/1 checks ok/);
  assert.match(lines[1] ?? '', /#5 attempt 1 {2}FAIL {2}0\/1 checks ok {2}— design\/a\.html \(not-attached\)/);
});

const missingOnDisk = (files = ['design/a.html']): HtmlCheck[] =>
  files.map((file) => ({ file, owner: 'a', kind: 'html' as const, status: 'missing-on-disk' as const }));

test('a failed check before posting sends the run back to design once per request', () => {
  assert.equal(repairDue(undefined, missingOnDisk()), true);
  const first = nextRepair(undefined, missingOnDisk(['design/a.html', 'design/b.html']));
  assert.deepEqual(first, { attempts: 1, missing: ['design/a.html', 'design/b.html'], pending: true });
  assert.equal(repairDue(first, missingOnDisk()), MAX_HTML_REPAIRS > 1);
  assert.equal(nextRepair(first, missingOnDisk()).attempts, 2);
});

test('a passing or empty check never re-routes', () => {
  const ok: HtmlCheck[] = [{ file: 'design/a.html', owner: 'a', kind: 'html', status: 'attached' }];
  assert.equal(repairDue(undefined, ok), false);
  assert.equal(repairDue(undefined, []), false);
});

test('before posting, a file the design named but never wrote fails and the rest pass', () => {
  const d = design([screen('a')]);
  const files = check({ design: d, attached: attachedFor('a'), onDisk: (f) => f !== 'design/a.html' });
  assert.deepEqual(files.map((f) => [f.file, f.status]), [
    ['design/a-before.png', 'attached'], ['design/a.png', 'attached'], ['design/a.html', 'missing-on-disk'],
  ]);
  assert.equal(roundPasses(files), false);
  assert.deepEqual(missingItems(files), ['design/a.html']);
  assert.equal(roundPasses(check({ design: d, attached: attachedFor('a') })), true);
});

test('before posting, every research screen must be drawn and every proven one needs a before', () => {
  const files = check({
    design: design([screen('login', { route: '/login', before: '' })]),
    attached: ['login.png', 'login.html'],
    surfaces: [surface('/login', true, 'frontend/src/routes.js:3'), surface('/login/locked', false)],
    evidenceHolds: (e, r) => routeEvidenceHolds(e, r, repo),
  });
  assert.deepEqual(missingItems(files), ['a before capture for route /login', 'a screen for route /login/locked']);
});

test('before posting, the screen checks are skipped when research listed no surfaces', () => {
  const d = design([screen('login', { route: '/login', before: '', screenshot: '', mockupHtml: '' })]);
  assert.deepEqual(check({ design: d, attached: [] }), []);
});

const routes = `const ROUTES = [
  { path: '/home', component: Home },
  { path: '/login', component: Login },
  { path: '/project-logs/v2/person/:id', component: PersonLogs },
];
`;
const repo = (rel: string): string | null => (rel === 'frontend/src/routes.js' ? routes : null);

const erpRoutes = `const Routes = () => (
      <Switch>
        <Route exact path={ROUTE_URLS.LOGIN} component={Login}/>
        <Route exact path={ROUTE_URLS.PROJECT_LOGS_V2_PERSON} component={PersonLogs}/>
      </Switch>
);
`;
const erpConstants = `export const ROUTE_URLS = {
    HOME: \`\${BASE_ROUTE}home/\`,
    LOGIN: \`\${BASE_ROUTE}login/\`,
};
`;
const erp = (rel: string): string | null =>
  ({ 'frontend/src/routes.js': erpRoutes, 'frontend/src/common/constants/routes.js': erpConstants })[rel] ?? null;

test('a route declared through a constant is proven, whatever its case or separators', () => {
  assert.equal(routeEvidenceHolds('frontend/src/routes.js:3', '/login', erp), true);
  assert.equal(routeEvidenceHolds('frontend/src/routes.js:4', '/project-logs/v2/person/:id', erp), true);
  assert.equal(routeEvidenceHolds('frontend/src/common/constants/routes.js:3', '/login/', erp), true);
  assert.equal(routeEvidenceHolds('frontend/src/routes.js:3', '/announcements', erp), false);
});

test('route evidence holds only when the cited line names the route', () => {
  assert.equal(routeEvidenceHolds('frontend/src/routes.js:3', '/login', repo), true);
  assert.equal(routeEvidenceHolds('frontend/src/routes.js:4', '/project-logs/v2/person/:id', repo), true);
  assert.equal(routeEvidenceHolds('frontend/src/routes.js:3', '/settings', repo), false, 'route not near the line');
  assert.equal(routeEvidenceHolds('frontend/src/routes.js:99', '/login', repo), false, 'line past the end');
  assert.equal(routeEvidenceHolds('frontend/src/missing.js:3', '/login', repo), false, 'no such file');
  assert.equal(routeEvidenceHolds('frontend/src/routes.js', '/login', repo), false, 'no line number');
  assert.equal(routeEvidenceHolds('', '/login', repo), false);
});

const surface = (route: string, exists: boolean, evidence = ''): UiSurface => ({ route, exists, evidence, change: 'c' });
const proven = (): boolean => true;

test('every research screen must be drawn on its route', () => {
  const d = design([screen('login', { route: '/login' })]);
  const checks = gradeSurfaces([surface('/login', true, 'r:1'), surface('/login/locked', false)], d, proven);
  assert.deepEqual(checks.map((c) => [c.file, c.kind, c.status]), [
    ['/login', 'screen', 'covered'],
    ['/login/locked', 'screen', 'screen-missing'],
  ]);
  assert.equal(roundPasses(checks), false);
});

test('an existing screen proven in code must carry a before', () => {
  const d = design([screen('login', { route: '/login/', before: '' })]);
  const checks = gradeSurfaces([surface('/login', true, 'frontend/src/routes.js:3')], d,
    (e, r) => routeEvidenceHolds(e, r, repo));
  assert.deepEqual(checks.map((c) => [c.kind, c.status]), [['screen', 'covered'], ['before', 'before-missing']]);
});

test('a new screen, or an existence claim the code does not back, needs no before', () => {
  const d = design([screen('locked', { route: '/login/locked', before: '' }), screen('x', { route: '/x', before: '' })]);
  const checks = gradeSurfaces([surface('/login/locked', false), surface('/x', true, 'frontend/src/routes.js:3')], d,
    (e, r) => routeEvidenceHolds(e, r, repo));
  assert.deepEqual(checks.map((c) => c.status), ['covered', 'covered']);
  assert.equal(roundPasses(checks), true);
});

test('one before among several screens on the same route is enough', () => {
  const d = design([
    screen('login', { route: '/login' }),
    screen('login-error', { route: '/login', before: '' }),
  ]);
  assert.deepEqual(gradeSurfaces([surface('/login', true, 'r:1')], d, proven).map((c) => c.status), ['covered']);
});

test('the repair prompt is told which screens and befores are missing', () => {
  const files: HtmlCheck[] = [
      { file: 'design/a.png', owner: 'a', kind: 'screenshot', status: 'not-attached' },
      { file: '/login/locked', owner: '/login/locked', kind: 'screen', status: 'screen-missing' },
      { file: '/login', owner: 'login', kind: 'before', status: 'before-missing' },
      { file: '/login', owner: 'login', kind: 'screen', status: 'covered' },
  ];
  assert.deepEqual(missingItems(files), [
    'design/a.png', 'a screen for route /login/locked', 'a before capture for route /login',
  ]);
});

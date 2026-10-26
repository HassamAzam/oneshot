/**
 * The design-eval verdict is graded on hand-built notes, so the rule
 * "every mockup HTML the design named is linked on the request" cannot drift.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DesignArtifact, DesignScreen, UiSurface } from '../phases/types.js';
import {
  MAX_HTML_REPAIRS, appendRound, expectedFiles, formatDesignEval, gradeDesignNote, gradeRequest, needsGrading,
  gradeSurfaces, nextRepair, repairDue, repairTarget, roundPasses, routeEvidenceHolds, summariseDesignEval,
  unlinkedFiles, uploadedNames, type DesignEvalRecord, type DesignEvalRound,
} from './designeval.js';

const screen = (id: string, over: Partial<DesignScreen> = {}): DesignScreen => ({
  id, name: id, purpose: 'p', states: [], note: '',
  mockupHtml: `design/${id}.html`, screenshot: `design/${id}.png`, before: `design/${id}-before.png`, ...over,
});
const design = (screens: DesignScreen[], prototype: DesignArtifact['prototype'] = null): Partial<DesignArtifact> => ({
  applicable: true, screens, prototype,
});
const upload = (name: string, secret = 'abc123'): string => `[${name}](/uploads/${secret}/${name})`;
const image = (name: string): string => `![${name}](/uploads/def456/${name})`;
const always = (): boolean => true;

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

test('upload links are read from both file and image markdown, decoded', () => {
  const names = uploadedNames(`${image('a.png')}\n\n${upload('a.html')}\n[x](/uploads/z/my%20file.html)\n[y](https://e.com/a.html)`);
  assert.deepEqual([...names].sort(), ['a.html', 'a.png', 'my file.html']);
});

const everything = (...ids: string[]): string => ids
  .map((id) => `${image(`${id}-before.png`)}\n\n${image(`${id}.png`)}\n\n${upload(`${id}.html`)}`).join('\n\n');

test('a note linking every file of every screen passes', () => {
  const d = design([screen('a'), screen('b')]);
  const body = `request\n\n${everything('a', 'b')}`;
  const files = gradeDesignNote(d, body, always);
  assert.ok(files.every((f) => f.status === 'linked'));
  assert.equal(roundPasses(files), true);
});

test('a note carrying only the images fails on every html', () => {
  const d = design([screen('a'), screen('b')]);
  const body = [image('a-before.png'), image('a.png'), image('b-before.png'), image('b.png')].join('\n\n');
  const files = gradeDesignNote(d, body, always);
  assert.deepEqual(files.filter((f) => f.status !== 'linked').map((f) => [f.file, f.kind]),
    [['design/a.html', 'html'], ['design/b.html', 'html']]);
  assert.equal(roundPasses(files), false);
});

test('a screenshot whose upload failed fails the round and is named', () => {
  const d = design([screen('login'), screen('wrong-password')]);
  const body = [everything('login'), image('wrong-password-before.png'), upload('wrong-password.html')].join('\n\n');
  const files = gradeDesignNote(d, body, always);
  assert.deepEqual(files.filter((f) => f.status !== 'linked').map((f) => [f.file, f.kind, f.status]),
    [['design/wrong-password.png', 'screenshot', 'not-linked']]);
  assert.equal(roundPasses(files), false);
});

test('an empty before is not expected, so a new screen passes without one', () => {
  const d = design([screen('a', { before: '' })]);
  assert.equal(roundPasses(gradeDesignNote(d, `${image('a.png')}\n\n${upload('a.html')}`, always)), true);
});

test('a file the design named but never wrote is reported as missing on disk', () => {
  const d = design([screen('a'), screen('b')]);
  const files = gradeDesignNote(d, everything('a', 'b'), (f) => f !== 'design/b.png');
  assert.deepEqual(files.filter((f) => f.status !== 'linked').map((f) => [f.file, f.status]),
    [['design/b.png', 'missing-on-disk']]);
  assert.equal(roundPasses(files), false);
});

test('a missing prototype entry fails a flow change even when every screen is linked', () => {
  const d = design([screen('a')], { entry: 'design/prototype/index.html', video: '' });
  const files = gradeDesignNote(d, everything('a'), always);
  assert.deepEqual(files.filter((f) => f.status !== 'linked').map((f) => [f.owner, f.kind]), [['prototype', 'html']]);
});

test('a file renamed to its dashed path for a basename clash still counts', () => {
  const d = design([
    screen('a', { mockupHtml: 'design/x/index.html', before: '' }),
    screen('b', { mockupHtml: 'design/y/index.html', before: '' }),
  ]);
  const body = [image('a.png'), image('b.png'), upload('index.html'), upload('design-y-index.html')].join('\n');
  assert.equal(roundPasses(gradeDesignNote(d, body, always)), true);
});

test('a design with no html cannot pass', () => {
  assert.equal(roundPasses([]), false);
});

test('each request comment is graded exactly once', () => {
  assert.equal(needsGrading(null, null), false);
  assert.equal(needsGrading(null, 7), true);
  const rec: DesignEvalRecord = { iid: 1, rounds: [{ noteId: 7, at: 't', readBack: true, files: [], pass: false }] };
  assert.equal(needsGrading(rec, 7), false);
  assert.equal(needsGrading(rec, 8), true);
});

test('gradeRequest reads the posted note back and checks files on disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'design-eval-'));
  mkdirSync(join(dir, 'design'));
  writeFileSync(join(dir, 'design', 'a.html'), '<html></html>');
  const d = design([screen('a', { before: '', screenshot: '' }), screen('b', { before: '', screenshot: '' })]);
  const round = await gradeRequest({
    iid: 1, noteId: 9, design: d, artifactDir: dir, now: () => 'T',
    readNote: async () => upload('a.html'),
  });
  assert.deepEqual(round, {
    noteId: 9, at: 'T', readBack: true, pass: false,
    files: [
      { file: 'design/a.html', owner: 'a', kind: 'html', status: 'linked' },
      { file: 'design/b.html', owner: 'b', kind: 'html', status: 'missing-on-disk' },
    ],
  });
});

test('an unreadable note is recorded as unread, not as a pass', async () => {
  const round = await gradeRequest({
    iid: 1, noteId: 9, design: design([screen('a')]), artifactDir: '/nowhere', now: () => 'T',
    readNote: async () => null,
  });
  assert.deepEqual(round, { noteId: 9, at: 'T', readBack: false, files: [], pass: false });
});

test('rounds accumulate and the report totals them', () => {
  const pass = { noteId: 1, at: 't', readBack: true, pass: true,
    files: [{ file: 'design/a.html', owner: 'a', kind: 'html' as const, status: 'linked' as const }] };
  const fail = { noteId: 2, at: 't', readBack: true, pass: false,
    files: [{ file: 'design/a.html', owner: 'a', kind: 'html' as const, status: 'not-linked' as const }] };
  const rec = appendRound(appendRound(null, 5, pass), 5, fail);
  assert.equal(rec.rounds.length, 2);
  assert.deepEqual(summariseDesignEval([rec]), {
    tickets: 1, rounds: 2, passed: 1, unread: 0, files: 2, linked: 1, notLinked: 1, missingOnDisk: 0,
    screensMissing: 0, beforesMissing: 0,
  });
  const lines = formatDesignEval([rec]);
  assert.match(lines[0] ?? '', /#5 note 1 {2}PASS {2}1\/1 checks ok/);
  assert.match(lines[1] ?? '', /#5 note 2 {2}FAIL {2}0\/1 checks ok {2}— design\/a\.html \(not-linked\)/);
});

const failing = (noteId: number, files = ['design/a.html']): DesignEvalRound => ({
  noteId, at: 't', readBack: true, pass: false,
  files: files.map((file) => ({ file, owner: 'a', kind: 'html' as const, status: 'not-linked' as const })),
});

test('a failing round sends the run back to design once per comment', () => {
  assert.equal(repairDue(undefined, failing(7)), true);
  const first = nextRepair(undefined, failing(7, ['design/a.html', 'design/b.html']));
  assert.deepEqual(first, { noteId: 7, attempts: 1, missing: ['design/a.html', 'design/b.html'], pending: true });
  assert.equal(repairDue(first, failing(7)), MAX_HTML_REPAIRS > 1);
  assert.equal(repairDue(first, failing(8)), true, 'a new comment gets its own repair');
  assert.equal(nextRepair(first, failing(8)).attempts, 1);
});

test('a passing, unread or html-less round never re-routes', () => {
  assert.equal(repairDue(undefined, { ...failing(7), pass: true }), false);
  assert.equal(repairDue(undefined, { noteId: 7, at: 't', readBack: false, files: [], pass: false }), false);
  assert.equal(repairDue(undefined, { noteId: 7, at: 't', readBack: true, files: [], pass: false }), false);
});

test('a pending repair edits only the standing request', () => {
  const repair = { noteId: 7, attempts: 1, missing: ['design/a.html'], pending: true };
  assert.equal(repairTarget(undefined, 7), 'none');
  assert.equal(repairTarget({ ...repair, pending: false }, 7), 'none');
  assert.equal(repairTarget(repair, 7), 'edit');
  assert.equal(repairTarget(repair, null), 'drop', 'feedback cleared the request, so the repair is moot');
  assert.equal(repairTarget(repair, 9), 'drop');
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
  const round: DesignEvalRound = {
    noteId: 1, at: 't', readBack: true, pass: false,
    files: [
      { file: 'design/a.png', owner: 'a', kind: 'screenshot', status: 'not-linked' },
      { file: '/login/locked', owner: '/login/locked', kind: 'screen', status: 'screen-missing' },
      { file: '/login', owner: 'login', kind: 'before', status: 'before-missing' },
      { file: '/login', owner: 'login', kind: 'screen', status: 'covered' },
    ],
  };
  assert.deepEqual(unlinkedFiles(round), [
    'design/a.png', 'a screen for route /login/locked', 'a before capture for route /login',
  ]);
});

test('gradeRequest adds the screen checks when research listed surfaces', async () => {
  const d = design([screen('login', { route: '/login', before: '', screenshot: '', mockupHtml: '' })]);
  const round = await gradeRequest({
    iid: 1, noteId: 3, design: d, artifactDir: '/nowhere', now: () => 'T',
    surfaces: [surface('/login', true, 'frontend/src/routes.js:3'), surface('/login/locked', false)],
    evidenceHolds: (e, r) => routeEvidenceHolds(e, r, repo),
    readNote: async () => 'request',
  });
  assert.deepEqual(round.files.map((f) => [f.file, f.status]), [
    ['/login', 'covered'], ['/login', 'before-missing'], ['/login/locked', 'screen-missing'],
  ]);
  assert.equal(round.pass, false);
});

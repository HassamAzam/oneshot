/**
 * The local-tests-impact analysis: which automation specs an ERP diff reaches, and
 * what running them costs.
 *
 * Lives under src/ because that is the only tree `npm test` globs, while the script
 * itself ships inside the skill that runs it. Each test builds a tiny ERP git repo and
 * an automation tree in a temp dir and runs index.cjs the way the phase does: as a
 * command, read-only, with --json.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ROOT } from './config.js';

const SCRIPT = join(ROOT, 'skills/local-tests-impact/scripts/index.cjs');
const require = createRequire(import.meta.url);
const impact = require(SCRIPT) as {
  stripComments: (src: string) => string;
  countIts: (src: string) => number;
  isDestructive: (src: string) => boolean;
  parseTestIds: (src: string) => Record<string, Record<string, string>>;
  selectorTestids: (src: string) => Set<string>;
};

interface Spec { file: string; module: string; its: number; ciSeconds: number | null; destructive: boolean; reasons: string[] }
interface Dropped { value: string; source: string; renamedTo: string | null; pageObjects: string[]; specs: string[] }
interface Impact {
  changedFiles: { frontend: string[]; backend: string[]; migrations: string[] };
  areas: Array<{ area: string; kind: string }>;
  modules: string[];
  testids: {
    added: Array<{ value: string }>;
    removed: Array<{ value: string }>;
    changed: Array<{ key: string; from: string; to: string }>;
    referenced: Array<{ value: string; files: string[] }>;
    generic: string[];
  };
  specs: Spec[];
  removedTestidStillUsed: Dropped[];
  addedTestidUnused: Array<{ value: string; usedBy: string[] }>;
  totals: { specs: number; its: number; ciSeconds: number; untimed: number; estimatedMinutes: number };
  warnings: string[];
}

function write(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});

const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

/* ------------------------------------------------------------------ fixture */

/**
 * The ERP side. `dev` is the base; `ticket` adds a banner testid, drops one, renames
 * another, touches a backend app and its tests, and adds a Home component that imports
 * the bare `testIds` name two folders both export.
 */
function erpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lti-erp-'));
  git(dir, 'init', '-q', '-b', 'dev');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  write(dir, {
    'frontend/src/components/rewards/testIds.js': [
      'export const rewardsTestIds = {',
      "    teamReviewTab: 'team-review-tab',",
      "    submitButton: 'submit-button',",
      "    oldBanner: 'old-banner',",
      "    personRow: 'person-row-old',",
      '};',
    ].join('\r\n'),
    'frontend/src/components/rewards/Dashboard.js': [
      "import { rewardsTestIds } from './testIds';",
      'export const Dashboard = () => (<div data-testid={rewardsTestIds.teamReviewTab}>',
      '    <span data-testid={rewardsTestIds.oldBanner} />',
      '</div>);',
    ].join('\n'),
    'frontend/src/components/leaves/testIds.js': "export const leaveTestIds = {\n    submitButton: 'submit-button',\n};\n",
    'frontend/src/components/home/testIds.js': "export const testIds = {\n    homePage: 'home-page',\n};\n",
    'frontend/src/components/home_page/testIds.js': "export const testIds = {\n    homePage: 'landing-home-page',\n};\n",
    'apps/expenses/utils.py': 'def divide(a, b):\n    return a / b\n',
  });
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');
  git(dir, 'checkout', '-qb', 'ticket');
  write(dir, {
    'frontend/src/components/rewards/testIds.js': [
      'export const rewardsTestIds = {',
      "    teamReviewTab: 'team-review-tab',",
      "    submitButton: 'submit-button',",
      "    personRow: 'person-row-new',",
      "    evidenceNoticeBanner: 'evidence-notice-banner',",
      '};',
    ].join('\r\n'),
    'frontend/src/components/rewards/Dashboard.js': [
      "import { rewardsTestIds } from './testIds';",
      'export const Dashboard = () => (<div data-testid={rewardsTestIds.teamReviewTab}>',
      '</div>);',
    ].join('\n'),
    'frontend/src/components/rewards/components/Notice.js': [
      "import { rewardsTestIds } from '../testIds';",
      '// data-testid={rewardsTestIds.teamReviewTab} is the tab, not this banner',
      'export const Notice = () => (<div data-testid={rewardsTestIds.evidenceNoticeBanner}>',
      '    <button data-testid={rewardsTestIds.submitButton} />',
      '</div>);',
    ].join('\n'),
    'frontend/src/components/home/Home.js': [
      "import { testIds } from './testIds';",
      'export const Home = () => <main data-testid={testIds.homePage} />;',
    ].join('\n'),
    'apps/expenses/utils.py': 'def divide(a, b):\n    return a / b if b else 0\n',
    'apps/expenses/tests/utils_test.py': 'def test_divide():\n    assert True\n',
  });
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'ticket');
  return dir;
}

const spec = (imports: string[], body: string) => [
  ...imports.map((p, i) => `import P${i} from '${p}';`),
  "import TestFilters from '../../support/filter_tests';",
  "TestFilters(['regression'], () => {",
  "    describe('fixture', () => {",
  "        before(() => { loginWith('HR_CREDENTIALS'); });",
  body,
  '    });',
  '});',
].join('\n');

const pageObject = (...testids: string[]) => [
  "import PageElementReadiness from '../page_element_readiness';",
  'class Fixture extends PageElementReadiness {',
  ...testids.map((t, i) => `    private get e${i}() { return getElement({ selector: '[data-testid="${t}"] ' }); }`),
  '}',
  'export default Fixture;',
].join('\n');

/** The automation side: the modules the default map names for rewards, expenses and home, plus neighbours. */
function automationTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lti-wsa-'));
  write(dir, {
    'cypress/Pages/teamReview/dashboard.ts': pageObject('team-review-tab', 'old-banner', 'submit-button'),
    'cypress/Pages/leave/apply.ts': pageObject('submit-button'),
    'cypress/Pages/forms/form.ts': pageObject('submit-button'),
    'cypress/Pages/organogram/people.ts': pageObject('person-row-old'),
    'cypress/Pages/home/home_dashboard.ts': pageObject('home-page'),
    'cypress/Pages/expenseClaims/dashboard.ts': pageObject('expense-claim-dashboard'),
    'cypress/Pages/sidePanel/side_panel.ts': pageObject('side-nav-container'),
    'cypress/support/filter_tests.ts': 'export default (tags, fn) => fn();\n',
    'cypress/e2e/teamReviewA/TR_01.ts': spec(['../../Pages/teamReview/dashboard', '../../Pages/sidePanel/side_panel'], [
      "        it('opens the dashboard', () => {});",
      "        // it('was retired', () => {});",
      "        /* it('so was this', () => {}); */",
      "        const url = 'http://localhost/it(';",
    ].join('\n')),
    'cypress/e2e/teamReviewB/TR_50.ts': spec(['cypress/Pages/teamReview/dashboard'], [
      "        it('first', () => { TeamReviewApi.deletePresentation('x'); });",
      "        it('second', () => {});",
    ].join('\n')),
    'cypress/e2e/expenses/EXP_01.ts': spec(['../../Pages/expenseClaims/dashboard'], "        it('claims', () => {});"),
    'cypress/e2e/home/HOME_01.ts': spec(['../../Pages/home/home_dashboard'], "        it('greets', () => {});"),
    'cypress/e2e/leaves/LV_01.ts': spec(['../../Pages/leave/apply', '../../Pages/sidePanel/side_panel'], "        it('applies', () => {});"),
    'cypress/e2e/organogram/ORG_01.ts': spec(['../../Pages/organogram/people'], "        it('lists people', () => {});"),
    'cypress/spec-timings.json': JSON.stringify({
      'cypress/e2e/teamReviewA/TR_01.ts': 30,
      'cypress/e2e/teamReviewB/TR_50.ts': 60,
      'cypress/e2e/expenses/EXP_01.ts': 20,
      'cypress/e2e/organogram/ORG_01.ts': 40,
      'cypress/e2e/leaves/LV_01.ts': 10,
    }),
  });
  return dir;
}

function analyze(): Impact {
  const erp = erpRepo();
  const wsa = automationTree();
  try {
    const r = run('--erp', erp, '--base', 'dev', '--head', 'ticket', '--automation', wsa, '--json');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return JSON.parse(r.stdout) as Impact;
  } finally {
    rmSync(erp, { recursive: true, force: true });
    rmSync(wsa, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ analysis */

const result = analyze();
const files = (r: Impact) => r.specs.map((s) => s.file.split('/').pop());

test('changed folders map to their cypress/e2e modules through modules-map.json', () => {
  assert.deepEqual(result.modules, ['expenses', 'home', 'teamReviewA', 'teamReviewB']);
  assert.deepEqual(result.warnings, []);
});

test('a test file changes no screen, but the code beside it still maps', () => {
  // ticket 8781's shape: apps/expenses/tests/* beside a real fix in apps/expenses.
  assert.ok(result.changedFiles.backend.includes('apps/expenses/tests/utils_test.py'));
  assert.ok(result.areas.some((a) => a.area === 'ignored' && a.kind === 'ignored'));
  assert.ok(result.areas.some((a) => a.area === 'backend:expenses' && a.kind === 'mapped'));
});

test('testIds.js diffs split into added, removed and changed values, CRLF and all', () => {
  assert.deepEqual(result.testids.added.map((t) => t.value), ['evidence-notice-banner']);
  assert.deepEqual(result.testids.removed.map((t) => t.value), ['old-banner']);
  assert.deepEqual(result.testids.changed, [{
    key: 'personRow', file: 'frontend/src/components/rewards/testIds.js', from: 'person-row-old', to: 'person-row-new',
  }]);
});

test('component references resolve through the import, not just the name', () => {
  // home and home_page both export `testIds`; Home.js imports ./testIds, so its
  // homePage is 'home-page'. Resolving by name alone would have to guess.
  const values = result.testids.referenced.map((t) => t.value);
  assert.ok(values.includes('home-page'));
  assert.ok(!values.includes('landing-home-page'));
  // A removed line is resolved at the base: the dropped banner is still a reference.
  assert.ok(values.includes('old-banner'));
});

test('candidate specs are the mapped modules plus direct-import testid matches', () => {
  assert.deepEqual(files(result), ['EXP_01.ts', 'HOME_01.ts', 'ORG_01.ts', 'TR_01.ts', 'TR_50.ts']);
  const org = result.specs.find((s) => s.file.endsWith('ORG_01.ts'));
  assert.ok(org?.reasons.some((r) => r.includes("'person-row-old'")), JSON.stringify(org));
});

test('a generic testid does not pull in specs from modules the change never renders', () => {
  // submit-button is selected under three Pages folders and defined by two ERP folders.
  // Notice.js renders one, and that is no reason to run the leaves suite.
  assert.ok(result.testids.generic.includes('submit-button'));
  assert.ok(!files(result).includes('LV_01.ts'));
});

test('it() blocks are counted outside comments only, and API helpers mark a spec destructive', () => {
  const tr01 = result.specs.find((s) => s.file.endsWith('TR_01.ts'));
  const tr50 = result.specs.find((s) => s.file.endsWith('TR_50.ts'));
  assert.equal(tr01?.its, 1);
  assert.equal(tr50?.its, 2);
  assert.equal(tr01?.destructive, false);
  assert.equal(tr50?.destructive, true);
});

test('a removed or renamed value that page objects still select names the specs that will break', () => {
  const byValue = Object.fromEntries(result.removedTestidStillUsed.map((d) => [d.value, d]));
  assert.deepEqual(byValue['old-banner']?.pageObjects, ['cypress/Pages/teamReview/dashboard.ts']);
  assert.deepEqual(byValue['old-banner']?.specs, ['cypress/e2e/teamReviewA/TR_01.ts', 'cypress/e2e/teamReviewB/TR_50.ts']);
  assert.equal(byValue['person-row-old']?.renamedTo, 'person-row-new');
  assert.deepEqual(byValue['person-row-old']?.specs, ['cypress/e2e/organogram/ORG_01.ts']);
  // Listed once, though both the testIds.js removal and Dashboard.js's dropped line name it.
  assert.equal(result.removedTestidStillUsed.filter((d) => d.value === 'old-banner').length, 1);
});

test('a new value no page object selects is reported as a coverage gap, with where it renders', () => {
  assert.deepEqual(result.addedTestidUnused.map((a) => a.value), ['evidence-notice-banner', 'person-row-new']);
  assert.deepEqual(result.addedTestidUnused[0]?.usedBy, ['frontend/src/components/rewards/components/Notice.js']);
});

test('totals price an untimed spec at the median and follow the stated formula', () => {
  // HOME_01 has no timing; the median of [10, 20, 30, 40, 60] is 30.
  // ceil(((30 + 60 + 20 + 40 + 30) * 1.15 + 5 * 8) / 60) = ceil(247 / 60) = 5
  assert.deepEqual(result.totals, { specs: 5, its: 6, ciSeconds: 180, untimed: 1, estimatedMinutes: 5 });
});

/* ------------------------------------------------------------------ failures */

test('a ref that does not resolve is a named error, not a stack trace', () => {
  const erp = erpRepo();
  const wsa = automationTree();
  try {
    const r = run('--erp', erp, '--base', 'dev', '--head', 'nope', '--automation', wsa, '--json');
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stdout).code, 'E_REF_UNRESOLVED');
  } finally {
    rmSync(erp, { recursive: true, force: true });
    rmSync(wsa, { recursive: true, force: true });
  }
});

test('a folder the map has never heard of is a warning, and check-map names it', () => {
  // A new ERP module mapped to nothing would otherwise read as "no specs reach this",
  // which is the same answer as a change no test can see.
  const erp = erpRepo();
  const wsa = automationTree();
  try {
    write(erp, { 'frontend/src/components/brand_new/Thing.js': 'export const Thing = 1;\n' });
    git(erp, 'add', '.');
    git(erp, 'commit', '-qm', 'a module nobody mapped');
    const r = run('--erp', erp, '--base', 'dev', '--head', 'ticket', '--automation', wsa, '--json');
    const out = JSON.parse(r.stdout) as Impact;
    assert.ok(out.areas.some((a) => a.area === 'frontend:brand_new' && a.kind === 'unmapped'));
    assert.ok(out.warnings.some((w) => w.startsWith('frontend:brand_new is in no list')), out.warnings.join('\n'));
    const check = run('check-map', '--automation', wsa, '--erp', erp, '--ref', 'ticket');
    assert.equal(check.status, 1);
    assert.ok(JSON.parse(check.stdout).missing.includes('unlisted frontend/src/components/brand_new'));
  } finally {
    rmSync(erp, { recursive: true, force: true });
    rmSync(wsa, { recursive: true, force: true });
  }
});

test('the session prices its own final list with the same code', () => {
  const wsa = automationTree();
  try {
    const r = run('estimate', '--automation', wsa, 'cypress/e2e/teamReviewB/TR_50.ts', 'cypress/e2e/home/HOME_01.ts');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    // ceil(((60 + 30) * 1.15 + 2 * 8) / 60) = ceil(119.5 / 60) = 2
    assert.deepEqual(JSON.parse(r.stdout).totals, { specs: 2, its: 3, ciSeconds: 90, untimed: 1, estimatedMinutes: 2 });
  } finally {
    rmSync(wsa, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ parsing */

test('a commented-out it() is not a test case, and a // inside a string is not a comment', () => {
  const src = "it('a', () => {});\n// it('b')\n/* it('c') */\nconst u = 'http://x/'; it('d', () => {});";
  assert.equal(impact.countIts(src), 2);
  assert.ok(impact.stripComments(src).includes("'http://x/'"));
});

test('a per-row testid function and a template selector meet on the same prefix', () => {
  const ids = impact.parseTestIds([
    'export const cvTestIds = {',
    "    applyButton: 'cv-apply-button',",
    '    suggestionRow: id => `cv-suggestion-row-${id}`,',
    '};',
  ].join('\n'));
  assert.deepEqual(ids, { cvTestIds: { applyButton: 'cv-apply-button', suggestionRow: 'cv-suggestion-row-*' } });
  const selected = impact.selectorTestids('getElement({ selector: `[data-testid="cv-suggestion-row-${id}"]` });');
  assert.deepEqual([...selected], ['cv-suggestion-row-*']);
});

test('reading a spec is not running it: a raw delete request is destructive, a GET is not', () => {
  assert.equal(impact.isDestructive("cy.request({ method: 'DELETE', url: '/api/x' });"), true);
  assert.equal(impact.isDestructive("cy.request({ method: 'GET', url: '/api/x' });"), false);
});

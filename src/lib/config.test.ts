import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ROOT, localTestsConfig, projectConfig, requiredLabels } from './config.js';

const risk = JSON.parse(readFileSync(join(ROOT, 'config', 'risk-modules.json'), 'utf8')) as {
  modules: Array<{ name: string; paths?: string[] }>;
};

test('every module path in risk-modules.json arms the gates', () => {
  const derived = projectConfig().highScrutinyPaths;
  for (const m of risk.modules) {
    for (const p of m.paths ?? []) assert.ok(derived.includes(p), `${m.name}: ${p} is not gated`);
  }
});

test('a module with no paths of its own puts nothing in highScrutinyPaths', () => {
  const derived = projectConfig().highScrutinyPaths;
  for (const p of derived) assert.equal(typeof p, 'string', `${String(p)} is not a path`);
  assert.ok(!derived.includes(''));
  assert.equal(new Set(derived).size, derived.length);
});

type Labels = Parameters<typeof requiredLabels>[0];
type Phase = Parameters<typeof requiredLabels>[1][number];

const labels = (over: Partial<Labels> = {}): Labels => ({
  entry: 'Loop', entryId: 1, exit: 'merged', exitId: null,
  blocked: 'Needs Human', blockedId: 2, review: 'Review',
  testcaseReview: 'TestCase Review', designReview: '', notABug: 'Not a Bug',
  inReview: 'In Review', ...over,
} as Labels);

const phase = (name: string, labelSkills?: Record<string, string>, labelGated?: string): Phase =>
  ({ name, labelSkills, labelGated });

const names = (l: ReturnType<typeof requiredLabels>): string[] => l.map((x) => x.name);

test('a label a phase routes a skill on is required', () => {
  // The one that fails silently: an unmatched key just never routes, so the
  // phase runs without the method it was configured to have.
  const got = requiredLabels(labels(), [phase('plan', { Accessibility: 'frontend-accessibility' })], true);
  assert.ok(names(got).includes('Accessibility'));
  assert.equal(got.find((l) => l.name === 'Accessibility')?.why,
    "routes 'frontend-accessibility' to plan");
});

test('an unset optional gate is not a label', () => {
  // designReview is '' in the shipped config: the gate is off, and requiring a
  // label named '' would fail every project forever.
  assert.ok(!names(requiredLabels(labels(), [], true)).includes(''));
});

test('notABug is required only while reproduction is on', () => {
  assert.ok(names(requiredLabels(labels(), [], true)).includes('Not a Bug'));
  assert.ok(!names(requiredLabels(labels(), [], false)).includes('Not a Bug'));
});

test('the pipeline labels are always required', () => {
  const got = names(requiredLabels(labels(), [], false));
  for (const l of ['Loop', 'merged', 'Needs Human', 'Review', 'TestCase Review', 'In Review']) {
    assert.ok(got.includes(l), `${l} is checked`);
  }
});

test('one label used twice is reported once, by its first reason', () => {
  const got = requiredLabels(labels({ review: 'Loop' }), [], false);
  assert.equal(got.filter((l) => l.name === 'Loop').length, 1);
  assert.match(got.find((l) => l.name === 'Loop')!.why, /^entry/);
});

test('a label a phase is gated on is required', () => {
  // The one that fails worse than a routing key: an unmatched labelGated does
  // not lose a skill, it drops the phase from every run and disarms the human
  // gate that goes with it, while doctor still prints PASS.
  const got = requiredLabels(labels(), [phase('design', undefined, 'Design')], false);
  assert.ok(names(got).includes('Design'));
  assert.match(got.find((l) => l.name === 'Design')!.why, /gates the 'design' phase/);
});

test('a label that both gates and routes is reported under the gating reason', () => {
  // Dedupe keeps the first reason, so the order inside the loop decides which
  // consequence the operator is told about. It should be the worse one.
  const got = requiredLabels(labels(), [phase('design', { Design: 'frontend-design' }, 'Design')], false);
  assert.equal(got.filter((l) => l.name === 'Design').length, 1);
  assert.match(got.find((l) => l.name === 'Design')!.why, /gates the 'design' phase/);
});

test('a phase with no labelSkills contributes nothing', () => {
  assert.deepEqual(
    names(requiredLabels(labels(), [phase('implement')], false)),
    names(requiredLabels(labels(), [], false)),
  );
});

test('the local-tests label is required only where the step is on', () => {
  // Conductor code adds it on a desk running local tests; on any other desk it
  // is never written, and a missing label there is nobody's problem.
  const l = labels({ localTests: 'TestCase Run Locally' });
  assert.ok(names(requiredLabels(l, [], false, true)).includes('TestCase Run Locally'));
  assert.ok(!names(requiredLabels(l, [], false, false)).includes('TestCase Run Locally'));
  assert.ok(!names(requiredLabels(labels(), [], false, true)).includes(''), 'an unset label is not required');
});

// ------------------------------------------------------------- localTestsConfig

type Policy = NonNullable<Parameters<typeof localTestsConfig>[0]>['localTests'];

const policy = (over: Record<string, unknown> = {}): { localTests: Policy } => ({
  localTests: {
    enabled: true, baselineDb: 'hrdb_automation_baseline_20261002', pgHost: '127.0.0.1', pgPort: 5432, pgUser: '',
    dbPrefix: 'oneshot_lt_', automationRef: 'origin/master',
    allowedPaths: ['cypress/Pages/', 'cypress/fixtures/', 'cypress/e2e/'],
    maxSpecs: 40, maxRunMinutes: 45, devApproval: 'any', failuresBlock: false, ...over,
  } as Policy,
});

const DESK = { ONESHOT_LOCAL_TESTS_REPO: '~/wsa' };

test('the shipped policy is usable as it stands', () => {
  // The first desk to set ONESHOT_LOCAL_TESTS_REPO must not discover a typo in
  // config/project.json by having the step silently stay off.
  const c = localTestsConfig(projectConfig(), DESK);
  assert.equal(c.off, null);
  assert.equal(c.enabled, true);
  assert.deepEqual(
    { db: c.baselineDb, pg: c.pg, prefix: c.dbPrefix, ref: c.automationRef, paths: c.allowedPaths },
    {
      db: 'hrdb_automation_baseline_20261002', pg: { host: '127.0.0.1', port: 5432, user: '' }, prefix: 'oneshot_lt_',
      ref: 'origin/master', paths: ['cypress/Pages/', 'cypress/fixtures/', 'cypress/e2e/'],
    },
  );
  assert.deepEqual([c.maxSpecs, c.maxRunMinutes, c.devApproval, c.failuresBlock], [40, 45, 'any', false]);
});

test('a desk without ONESHOT_LOCAL_TESTS_REPO has the step off, and is told why', () => {
  const c = localTestsConfig(policy(), {});
  assert.equal(c.enabled, false);
  assert.match(c.off ?? '', /ONESHOT_LOCAL_TESTS_REPO is not set/);
  assert.equal(c.repo, '');
});

test('paths in .env are expanded, and the credentials file has a default outside both repos', () => {
  const c = localTestsConfig(policy(), DESK);
  assert.equal(c.repo, join(homedir(), 'wsa'));
  assert.equal(c.credsFile, join(homedir(), '.config/oneshot/cypress-env.json'));
  assert.equal(localTestsConfig(policy(), { ...DESK, ONESHOT_LOCAL_TESTS_CREDS: '~/creds.json' }).credsFile,
    join(homedir(), 'creds.json'));
});

test('.env overrides the baseline and the Postgres it lives on, for this desk only', () => {
  const c = localTestsConfig(policy(), {
    ...DESK,
    ONESHOT_LOCAL_TESTS_BASELINE_DB: 'hrdb_mine',
    ONESHOT_LOCAL_TESTS_PG_HOST: 'localhost',
    ONESHOT_LOCAL_TESTS_PG_PORT: '5433',
    ONESHOT_LOCAL_TESTS_PG_USER: 'qa',
  });
  assert.equal(c.enabled, true);
  assert.equal(c.baselineDb, 'hrdb_mine');
  assert.deepEqual(c.pg, { host: 'localhost', port: 5433, user: 'qa' });
});

test('the policy switch and a missing block both turn the step off, whatever the desk says', () => {
  assert.match(localTestsConfig(policy({ enabled: false }), DESK).off ?? '', /localTests\.enabled/);
  const none = localTestsConfig({}, DESK);
  assert.equal(none.enabled, false);
  assert.match(none.off ?? '', /no `localTests` block/);
});

test('a database name that would need quoting in SQL turns the step off, naming where it came from', () => {
  const fromPolicy = localTestsConfig(policy({ baselineDb: 'hrdb"; DROP DATABASE hrdb; --' }), DESK);
  assert.equal(fromPolicy.enabled, false);
  assert.match(fromPolicy.off ?? '', /localTests\.baselineDb must be a lower-case Postgres name/);
  const fromEnv = localTestsConfig(policy(), { ...DESK, ONESHOT_LOCAL_TESTS_BASELINE_DB: 'Hrdb-Baseline' });
  assert.match(fromEnv.off ?? '', /ONESHOT_LOCAL_TESTS_BASELINE_DB must be a lower-case Postgres name/);
});

test('a prefix that matches the baseline is refused, so cleanup can never drop it', () => {
  const c = localTestsConfig(policy({ dbPrefix: 'hrdb_' }), DESK);
  assert.equal(c.enabled, false);
  assert.match(c.off ?? '', /cleanup would match the baseline/);
});

test('caps, ports and switches of the wrong shape turn the step off and are each named', () => {
  const c = localTestsConfig(policy({ maxRunMinutes: 0, devApproval: 'most', failuresBlock: 'no', allowedPaths: [] }), {
    ...DESK, ONESHOT_LOCAL_TESTS_PG_PORT: '70000',
  });
  assert.equal(c.enabled, false);
  for (const field of ['localTests.maxRunMinutes', 'localTests.devApproval', 'localTests.failuresBlock',
    'localTests.allowedPaths', 'ONESHOT_LOCAL_TESTS_PG_PORT']) {
    assert.ok((c.off ?? '').includes(field), `${field} is named`);
  }
});

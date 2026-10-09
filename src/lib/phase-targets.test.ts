/**
 * A phase that belongs to one target must not land on everyone else.
 *
 * `mr-open` changes the SHAPE of the pipeline: it opens the MR before the
 * gates instead of after them, and a run that aborts between it and `mr` now
 * leaves a draft MR behind where it previously left none. That was asked for
 * while moving to the erp target — so an unscoped version of it would have
 * changed the pipeline for every conductor on every project the moment it
 * pulled, which is a cost nobody else agreed to pay.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const VAR = 'GITLAB_REPO_URL';
/** The desk switch for the local-tests phases, which phases() also filters on. */
const LT_VAR = 'ONESHOT_LOCAL_TESTS_REPO';

/**
 * The target is the last path segment of GITLAB_REPO_URL. The empty string for
 * no target, never `delete` — dotenv fills a missing key (see target.test.ts).
 * The local-tests step is OFF unless `localTestsRepo` is given, whatever this
 * desk's .env says, so these assertions mean the same on every desk.
 */
async function phasesWith(
  value: string, localTestsRepo = '',
): Promise<Array<{ name: string; targets?: string[] }>> {
  const saved = [VAR, LT_VAR].map((k) => [k, Object.prototype.hasOwnProperty.call(process.env, k), process.env[k]] as const);
  process.env[VAR] = value ? `https://gitlab.example.com/acme/${value}` : '';
  process.env[LT_VAR] = localTestsRepo;
  try {
    const m = await import(`./config.js?phases=${encodeURIComponent(value)}-${localTestsRepo ? 'lt' : ''}-${Date.now()}`);
    return (m.phases as () => Array<{ name: string; targets?: string[] }>)();
  } finally {
    for (const [k, had, before] of saved) {
      if (had) process.env[k] = before;
      else delete process.env[k];
    }
  }
}

test('no target selected runs the pipeline without mr-open', async () => {
  const names = (await phasesWith('')).map((p) => p.name);
  assert.ok(!names.includes('mr-open'), `mr-open leaked into the default pipeline: ${names.join(', ')}`);
  // The phases either side of it are untouched, so the sequence everyone else
  // runs is the one they ran before mr-open existed.
  assert.equal(names[names.indexOf('implement') + 1], 'testcases');
});

test('the erp target runs mr-open between implement and testcases', async () => {
  const names = (await phasesWith('erp')).map((p) => p.name);
  assert.equal(names[names.indexOf('implement') + 1], 'mr-open');
  assert.equal(names[names.indexOf('mr-open') + 1], 'testcases');
});

test('adding the target gate adds exactly one phase and removes none', async () => {
  const off = (await phasesWith('')).map((p) => p.name);
  const on = (await phasesWith('erp')).map((p) => p.name);
  assert.deepEqual(on.filter((n) => !off.includes(n)), ['mr-open']);
  assert.deepEqual(off.filter((n) => !on.includes(n)), []);
});

test('a desk without the automation clone runs neither local-tests phase, and ui-evidence still pairs with mr', async () => {
  const names = (await phasesWith('erp')).map((p) => p.name);
  assert.ok(!names.includes('local-tests-scope'), names.join(', '));
  assert.ok(!names.includes('local-tests-run'), names.join(', '));
  assert.equal(names[names.indexOf('ui-evidence') + 1], 'mr', 'the two batch together exactly as before');
});

test('a desk with the clone runs both local-tests phases between ui-evidence and mr, on erp only', async () => {
  const on = (await phasesWith('erp', '/nowhere/workstream-automation')).map((p) => p.name);
  assert.deepEqual(on.slice(on.indexOf('ui-evidence'), on.indexOf('mr') + 1),
    ['ui-evidence', 'local-tests-scope', 'local-tests-run', 'mr']);
  const off = (await phasesWith('erp')).map((p) => p.name);
  assert.deepEqual(on.filter((n) => !off.includes(n)), ['local-tests-scope', 'local-tests-run']);
  // The automation suite is the erp target's; another project never gets them.
  const elsewhere = (await phasesWith('', '/nowhere/workstream-automation')).map((p) => p.name);
  assert.ok(!elsewhere.includes('local-tests-scope') && !elsewhere.includes('local-tests-run'));
});

test('an untargeted phase runs under every target', async () => {
  // The guarantee that makes the field safe to add: absent `targets` is not
  // "belongs to no one", it is "belongs to everyone".
  for (const value of ['', 'erp']) {
    const list = await phasesWith(value);
    const untargeted = list.filter((p) => !p.targets).map((p) => p.name);
    for (const core of ['research', 'plan', 'implement', 'testcases', 'mr', 'merge']) {
      assert.ok(untargeted.includes(core), `${core} missing with target '${value}'`);
    }
  }
});

test('a target in phases.json matches whatever its case', async () => {
  const { runsForTarget } = await import('./config.js');
  assert.ok(runsForTarget({ targets: ['ERP'] }, 'erp'));
  assert.ok(runsForTarget({ targets: [' Erp '] }, 'erp'));
  assert.ok(!runsForTarget({ targets: ['erpp'] }, 'erp'));
  assert.ok(!runsForTarget({ targets: [] }, 'erp'), 'an empty list is a switched-off phase');
  assert.ok(runsForTarget({}, ''), 'no targets runs everywhere, including with no project');
});

test('a target name no project could match is refused, not silently dropped', async () => {
  const { assertTargets } = await import('./config.js');
  for (const targets of [[''], ['  '], ['arbisoft/erp'], ['erp x']]) {
    assert.throws(() => assertTargets({ name: 'p', targets }), /phase 'p' names target\(s\) no project can match/);
  }
  assert.throws(() => assertTargets({ name: 'p', targets: 'erp' as unknown as string[] }), /must be an array/);
  for (const targets of [undefined, [], ['erp'], ['ERP', 'workstreamai']]) {
    assert.doesNotThrow(() => assertTargets({ name: 'p', targets }));
  }
});

test('erp.git, .erp, erp. and erp? are refused by name: no project URL selects them', async () => {
  // The URL parser strips a clone URL's .git before naming the target, and
  // refuses the other three as a path segment. A valid sibling is not named.
  const { assertTargets } = await import('./config.js');
  for (const entry of ['erp.git', '.erp', 'erp.', 'erp?']) {
    assert.throws(() => assertTargets({ name: 'p', targets: ['erp', entry] }), (err: Error) => {
      assert.match(err.message, /phase 'p' names target\(s\) no project can match/, entry);
      assert.ok(err.message.includes(`no project can match: ${JSON.stringify(entry)}. `), err.message);
      return true;
    });
  }
});

test('erp-v2, my_app, my.app and ERP are accepted: a project URL can select each', async () => {
  const { assertTargets } = await import('./config.js');
  for (const entry of ['erp-v2', 'my_app', 'my.app', 'ERP']) {
    assert.doesNotThrow(() => assertTargets({ name: 'p', targets: [entry] }));
  }
});

test('every targets list shipped in phases.json is well formed', async () => {
  const { assertTargets } = await import('./config.js');
  const { readFileSync } = await import('node:fs');
  const raw = JSON.parse(readFileSync(new URL('../../config/phases.json', import.meta.url), 'utf8')) as {
    phases: Array<{ name: string; targets?: string[] }> };
  raw.phases.forEach((p) => assertTargets(p));
});

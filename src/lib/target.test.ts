/**
 * The project switch: one line in .env moving the conductor to another project.
 *
 * Two properties matter more than the mechanism. An UNSET variable must leave
 * every path, label and project id exactly as it was, because that is what every
 * machine already running on the default depends on. And an UNKNOWN value must
 * throw, because the alternative — quietly working on the default project — would
 * claim tickets, cut branches and open MRs against a project nobody meant to
 * touch, with nothing in the logs looking wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const VAR = 'ONESHOT_PROJECT';

/**
 * Each case re-imports config.js under a fresh module registry: PROJECT_TARGET
 * and WORK_REPO are module-level constants read at load, so a cache-busting
 * query string is the only way to observe a different environment.
 */
async function loadWith(value: string | undefined): Promise<Record<string, unknown>> {
  const had = Object.prototype.hasOwnProperty.call(process.env, VAR);
  const before = process.env[VAR];
  if (value === undefined) delete process.env[VAR];
  else process.env[VAR] = value;
  try {
    return await import(`./config.js?target=${encodeURIComponent(String(value))}-${Date.now()}`);
  } finally {
    if (had) process.env[VAR] = before;
    else delete process.env[VAR];
  }
}

test('unset selects no target and leaves the default project in place', async () => {
  const m = await loadWith(undefined);
  assert.equal(m.PROJECT_TARGET, '');
  assert.equal((m.activeTarget as () => unknown)(), null);
  const cfg = (m.projectConfig as () => { gitlab: { project: string; projectId: number } })();
  assert.equal(cfg.gitlab.project, 'arbisoft/workstreamai');
  assert.equal(cfg.gitlab.projectId, 1491);
  assert.match(m.WORK_REPO as string, /workstreamai$/);
});

test('erp moves the project, the id, the base branch and every path', async () => {
  const m = await loadWith('erp');
  assert.equal(m.PROJECT_TARGET, 'erp');
  const cfg = (m.projectConfig as () => {
    gitlab: { project: string; projectId: number }; branches: { base: string };
  })();
  assert.equal(cfg.gitlab.project, 'arbisoft/erp');
  assert.equal(cfg.gitlab.projectId, 304);
  assert.equal(cfg.branches.base, 'dev');
  assert.match(m.WORK_REPO as string, /\/erp$/);
  assert.match((m.seedFrom as () => string)(), /\/erp$/);
  // Worktrees are named by ticket iid, so two projects sharing one root would
  // collide issue 100 with issue 100.
  assert.match(m.WT_ROOT as string, /erp-wt$/);
});

test('the target name is case-insensitive', async () => {
  const m = await loadWith('ERP');
  assert.equal(m.PROJECT_TARGET, 'erp');
  assert.equal((m.projectConfig as () => { gitlab: { project: string } })().gitlab.project,
    'arbisoft/erp');
});

test('a target maps labels onto ones that exist on that project', async () => {
  // arbisoft/erp has 'Merged' and 'In Review'; it has no lowercase 'merged'.
  // Every label check is a case-sensitive Array.includes, so the wrong case is
  // a label that silently never matches.
  const m = await loadWith('erp');
  const { labels } = (m.projectConfig as () => { labels: Record<string, string> })();
  assert.equal(labels.exit, 'Merged');
  assert.equal(labels.inReview, 'In Review');
  // Optional labels ERP does not have are switched off, not left pointing at a
  // name that does not exist there.
  assert.equal(labels.review, '');
  assert.equal(labels.notABug, '');
  // Untouched by the overlay, so it still comes from the base config.
  assert.equal(labels.entry, 'Loop');
});

test('an unknown target throws instead of falling back to the default project', async () => {
  await assert.rejects(
    () => loadWith('erpp').then((m) => (m.activeTarget as () => unknown)()),
    /is not a target in config\/project\.json/,
  );
});

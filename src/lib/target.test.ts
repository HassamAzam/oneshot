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

let seq = 0;

/**
 * Each case re-imports config.js under a fresh module registry: PROJECT_TARGET
 * and WORK_REPO are module-level constants read at load, so a cache-busting
 * query string is the only way to observe a different environment.
 *
 * The empty string, never `delete`, is how "absent" is expressed — for the
 * target and for anything in `extra`. config.js calls dotenv at module load,
 * and dotenv fills in any key NOT already present in process.env, so deleting
 * a variable does not produce an unconfigured run: it hands the decision to
 * whatever `.env` the developer happens to have. This suite went red the moment
 * a real ONESHOT_PROJECT=erp was added to one. An empty value is present, so
 * dotenv leaves it alone, and it is what envOr and the selector already treat
 * as unset.
 *
 * `extra` sets further variables for the duration of the load, restoring each
 * afterwards — the scoped-override cases need one alongside ONESHOT_PROJECT.
 *
 * `within` runs against the loaded module while those variables are STILL set.
 * Exported constants are frozen at import, but targetOverrides() re-reads the
 * environment on every call, so asserting on it after the restore would test
 * this machine's .env rather than the case.
 */
async function loadWith(
  value: string,
  extra: Record<string, string> = {},
  within?: (m: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const vars = { [VAR]: value, ...extra };
  const before = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  try {
    seq += 1;
    const m = await import(`./config.js?target=${encodeURIComponent(value)}-${seq}`);
    within?.(m);
    return m;
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('no target selected leaves the default project in place', async () => {
  const m = await loadWith('');
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

test('a plain env var still cannot defeat the switch', async () => {
  // The property the target overlay exists to protect: a machine that has been
  // working on the default has WORK_REPO spelled out already, and that stale
  // line must not quietly keep the conductor pointed at workstreamai.
  const m = await loadWith('erp', { WORK_REPO: '~/Documents/workstreamai' });
  assert.match(m.WORK_REPO as string, /\/erp$/);
});

test('a target-scoped env var moves a path the target pins', async () => {
  // config/project.json pins ~/Documents/erp, which is one machine's layout.
  // A checkout anywhere else has to be able to say so without editing a tracked
  // file.
  await loadWith('erp', {
    ONESHOT_ERP_WORK_REPO: '/tmp/elsewhere/erp',
    ONESHOT_ERP_SEED_FROM: '/tmp/elsewhere/erp',
    ONESHOT_ERP_WT_ROOT: '/tmp/elsewhere/erp-wt',
  }, (m) => {
    assert.equal(m.WORK_REPO, '/tmp/elsewhere/erp');
    assert.equal((m.seedFrom as () => string)(), '/tmp/elsewhere/erp');
    assert.equal(m.WT_ROOT, '/tmp/elsewhere/erp-wt');
  });
});

test('the scoped name beats a plain one set alongside it', async () => {
  await loadWith('erp', {
    WORK_REPO: '~/Documents/workstreamai',
    ONESHOT_ERP_WORK_REPO: '/tmp/elsewhere/erp',
  }, (m) => {
    assert.equal(m.WORK_REPO, '/tmp/elsewhere/erp');
    // And doctor reports what is in force, not the path the target pins —
    // naming ~/Documents/erp there would point at a directory nobody is using.
    const overrides = (m.targetOverrides as () => Array<
      { name: string; ignored: string; using: string }
    >)();
    const workRepo = overrides.find((o) => o.name === 'WORK_REPO');
    assert.equal(workRepo?.using, '/tmp/elsewhere/erp');
    assert.match(workRepo?.ignored ?? '', /workstreamai$/);
  });
});

test('the scoped name is ignored when no target is selected', async () => {
  // No target must leave everything exactly as it was, scoped variables included.
  const m = await loadWith('', { ONESHOT_ERP_WORK_REPO: '/tmp/elsewhere/erp' });
  assert.match(m.WORK_REPO as string, /workstreamai$/);
});

test('scopedEnvName strips a leading ONESHOT_ rather than doubling it', async () => {
  const m = await loadWith('erp');
  const scoped = m.scopedEnvName as (n: string) => string;
  assert.equal(scoped('WORK_REPO'), 'ONESHOT_ERP_WORK_REPO');
  assert.equal(scoped('ONESHOT_SEED_FROM'), 'ONESHOT_ERP_SEED_FROM');
});

test('an unknown target throws instead of falling back to the default project', async () => {
  await assert.rejects(
    () => loadWith('erpp').then((m) => (m.activeTarget as () => unknown)()),
    /is not a target in config\/project\.json/,
  );
});

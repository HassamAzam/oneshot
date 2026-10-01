import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  branchFiles, loadZoneMap, matches, refusedTicket, validateZoneMap, zoneBlockReason, zoneCheckDue, zoneGuardApplies,
  zoneOf, zoneVerdict, type ZoneMap, type ZoneMapRead, type ZonesConfig,
} from './zoneguard.js';
import { declaredFiles } from './reviewgate.js';
import type { PhaseConfig } from '../lib/config.js';

/**
 * The `zones` block as it reads when the guard is switched on. Passed to every
 * call rather than read from config/project.json, which ships without the block.
 */
const ZONES: ZonesConfig = {
  file: '.claude/zones.json', guardLabel: 'AI', yellowLabel: 'Zone: Yellow', testsLabel: 'Characterization Tests',
};

const map: ZoneMap = {
  severity: ['green', 'yellow', 'red'],
  default_zone: 'yellow',
  areas: [
    { name: 'training', zone: 'green', paths: ['apps/training/', 'frontend/src/components/training/'] },
    { name: 'teams', zone: 'yellow', paths: ['apps/teams/'] },
    { name: 'shared_frontend', zone: 'yellow', paths: ['frontend/src/common/'] },
    { name: 'payroll', zone: 'red', paths: ['apps/payroll/', 'frontend/src/components/payroll/'] },
    { name: 'permissions', zone: 'red', paths: ['common/permissions.py', '**/permissions.py'] },
  ],
};
const read: ZoneMapRead = { map };

test('path rules: prefix, anywhere, exact', () => {
  assert.ok(matches('apps/training/', 'apps/training/views.py'));
  assert.ok(!matches('apps/training/', 'apps/training_old/views.py'));
  assert.ok(matches('**/permissions.py', 'apps/training/permissions.py'));
  assert.ok(matches('common/permissions.py', 'common/permissions.py'));
  assert.ok(!matches('common/permissions.py', 'common/permissions.pyc'));
});

test('the most severe matching area wins', () => {
  const hit = zoneOf(map, 'apps/training/permissions.py');
  assert.equal(hit.zone, 'red');
  assert.deepEqual(hit.areas, ['training', 'permissions']);
});

test('an unmapped file takes the default zone', () => {
  assert.deepEqual(zoneOf(map, 'README.md'), { file: 'README.md', zone: 'yellow', areas: [] });
});

test('a ticket without the AI label is never stopped', () => {
  const v = zoneVerdict(['Loop'], ['apps/payroll/models.py'], read, ZONES);
  assert.equal(v.applies, false);
  assert.deepEqual(v.violations, []);
});

test('a green AI ticket that stays green passes', () => {
  const v = zoneVerdict(['AI', 'Loop'], ['apps/training/views.py', 'frontend/src/components/training/A.js'], read, ZONES);
  assert.deepEqual(v.violations, []);
});

test('a green AI ticket reaching into shared code is stopped', () => {
  const v = zoneVerdict(['AI', 'Loop'], ['apps/training/views.py', 'frontend/src/common/utils/misc.js'], read, ZONES);
  assert.deepEqual(v.violations.map((h) => h.file), ['frontend/src/common/utils/misc.js']);
});

test('yellow is allowed only once released by the yellow label', () => {
  assert.equal(zoneVerdict(['AI', 'Loop'], ['apps/teams/views.py'], read, ZONES).violations.length, 1);
  assert.equal(zoneVerdict(['AI', 'Loop', 'Zone: Yellow'], ['apps/teams/views.py'], read, ZONES).violations.length, 0);
});

test('red is never allowed, whatever the labels', () => {
  const v = zoneVerdict(['AI', 'Loop', 'Zone: Yellow', 'Review'], ['apps/payroll/models.py'], read, ZONES);
  assert.equal(v.violations[0]?.zone, 'red');
});

test('a map the guard cannot read stops an AI ticket, with the reason it was given', () => {
  const missing = { error: 'zone map X is not on origin/dev — merge it there' };
  const v = zoneVerdict(['AI', 'Loop'], ['apps/training/views.py'], missing, ZONES);
  assert.equal(v.unreadable, 'zone map X is not on origin/dev — merge it there');
  assert.equal(zoneBlockReason(v, ZONES),
    'zone map X is not on origin/dev — merge it there, or remove AI to run under the review gates');
});

test('files are reported once each, with zone and area', () => {
  const v = zoneVerdict(['AI'], ['apps/payroll/a.py', 'apps/payroll/a.py', 'README.md'], read, ZONES);
  assert.equal(v.violations.length, 2);
  const reason = zoneBlockReason(v, ZONES);
  assert.match(reason, /apps\/payroll\/a\.py \(red: payroll\)/);
  assert.match(reason, /README\.md \(yellow\)/);
});

test('a characterization-test ticket is always refused, whatever else it carries', () => {
  assert.match(refusedTicket(['Characterization Tests', 'Loop', 'AI'], ZONES) ?? '', /written by a person/);
  assert.match(refusedTicket(['Characterization Tests', 'Loop'], ZONES) ?? '', /never Oneshot/);
});

test('an ordinary ticket is not refused', () => {
  assert.equal(refusedTicket(['AI', 'Loop', 'Zone: Green'], ZONES), null);
});

test('with no zones block nothing is guarded and nothing is refused', () => {
  // How config/project.json ships until the map is on the base branch: an AI
  // ticket runs under the review gates exactly as it did before the guard.
  assert.equal(zoneGuardApplies(['AI', 'Loop'], null), false);
  assert.equal(zoneVerdict(['AI', 'Loop'], ['apps/payroll/models.py'], read, null).applies, false);
  assert.equal(refusedTicket(['Characterization Tests', 'Loop'], null), null);
});

// ------------------------------------------------------- the map's own shape

/**
 * The shape erp!11060's draft map takes (three zones, default yellow, a
 * '**\/name' pattern), plus the '**\/dir/' form the path rules also allow.
 */
const REAL_SHAPE = {
  severity: ['green', 'yellow', 'red'],
  default_zone: 'yellow',
  areas: [
    { name: 'training', zone: 'green', paths: ['apps/training/', 'frontend/src/components/training/'] },
    { name: 'migrations', zone: 'red', paths: ['**/migrations/'] },
    { name: 'permissions', zone: 'red', paths: ['common/permissions.py', '**/permissions.py'] },
  ],
};
const withArea = (area: Record<string, unknown>): unknown => ({ ...REAL_SHAPE, areas: [...REAL_SHAPE.areas, area] });
const errorOf = (r: ZoneMapRead): string => ('error' in r ? r.error : '');

test('a map of the real shape is accepted as it is', () => {
  assert.deepEqual(validateZoneMap(REAL_SHAPE), { map: REAL_SHAPE });
});

test('a misspelt zone is refused rather than outranked by an overlapping green area', () => {
  // Before: "Red" ranked -1 in severity, so apps/training/permissions.py
  // (training green + this area) came out green and passed.
  const typo = withArea({ name: 'perms', zone: 'Red', paths: ['**/permissions.py'] });
  assert.match(errorOf(validateZoneMap(typo)), /area "perms" has zone "Red", which is not one of `severity`/);
});

test('an area without paths is refused rather than thrown on mid-run', () => {
  assert.match(errorOf(validateZoneMap(withArea({ name: 'teams', zone: 'yellow' }))), /area "teams" has no paths/);
  assert.match(errorOf(validateZoneMap(withArea({ zone: 'yellow', paths: ['apps/teams/'] }))), /area #4 has no name/);
});

test('a missing or unknown default zone is refused', () => {
  assert.match(errorOf(validateZoneMap({ ...REAL_SHAPE, default_zone: undefined })), /`default_zone` undefined/);
  assert.match(errorOf(validateZoneMap({ ...REAL_SHAPE, default_zone: 'amber' })), /`default_zone` "amber"/);
  assert.match(errorOf(validateZoneMap({ ...REAL_SHAPE, severity: ['yellow', 'red'] })), /no "green"/);
});

test('a pattern the guard would never match is refused, not left to fall to the default zone', () => {
  for (const pattern of ['apps/*/permissions.py', '*.sql', '**/foo*', 'apps/*/', '']) {
    const r = validateZoneMap(withArea({ name: 'x', zone: 'red', paths: [pattern] }));
    assert.match(errorOf(r), /which the guard cannot match/, `${JSON.stringify(pattern)} was accepted`);
  }
});

// ----------------------------------------------- reading it from the base branch

const git = (dir: string, ...args: string[]): string => execFileSync('git',
  ['-C', dir, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Write `files` and commit them, in a scratch repo under the OS temp dir. */
function commit(dir: string, files: Record<string, string>, message: string): void {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  git(dir, 'add', '--', ...Object.keys(files));
  git(dir, 'commit', '-qm', message);
}

/**
 * A stand-in for WORK_REPO: a scratch repo whose `origin/dev` is a plain ref.
 * It has no remote, so the guard's fetch fails at once and touches no network,
 * which is also what proves a failed fetch is not taken for a verdict.
 */
function workRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oneshot-zones-'));
  git(dir, 'init', '-q', '-b', 'main');
  commit(dir, { 'README.md': 'erp\n' }, 'base');
  git(dir, 'update-ref', 'refs/remotes/origin/dev', 'HEAD');
  return dir;
}

test('a map that is not on the base branch says so, and does not send anyone to fetch', () => {
  const dir = workRepo();
  try {
    const r = loadZoneMap('.claude/zones.json', { repo: dir, base: 'dev' });
    assert.equal(errorOf(r), 'zone map .claude/zones.json is not on origin/dev — merge it there');
    const reason = zoneBlockReason(zoneVerdict(['AI', 'Loop'], [], r, ZONES), ZONES);
    assert.doesNotMatch(reason, /fetch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a map on the base branch is read from there, and judged before it is trusted', () => {
  const dir = workRepo();
  try {
    commit(dir, { '.claude/zones.json': JSON.stringify(REAL_SHAPE) }, 'map');
    git(dir, 'update-ref', 'refs/remotes/origin/dev', 'HEAD');
    assert.deepEqual(loadZoneMap('.claude/zones.json', { repo: dir, base: 'dev' }), { map: REAL_SHAPE });

    commit(dir, { '.claude/zones.json': '{ "severity": [' }, 'broken map');
    git(dir, 'update-ref', 'refs/remotes/origin/dev', 'HEAD');
    assert.match(errorOf(loadZoneMap('.claude/zones.json', { repo: dir, base: 'dev' })),
      /is not valid JSON — fix it by MR$/);

    commit(dir, { '.claude/zones.json': JSON.stringify(withArea({ name: 'teams', zone: 'yellow' })) }, 'bad map');
    git(dir, 'update-ref', 'refs/remotes/origin/dev', 'HEAD');
    assert.equal(errorOf(loadZoneMap('.claude/zones.json', { repo: dir, base: 'dev' })),
      'zone map .claude/zones.json on origin/dev is invalid: area "teams" has no paths — fix it by MR');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------- where the runner checks

const VAR = 'GITLAB_REPO_URL';

/**
 * config/phases.json as phases() returns it for `target`, the list runTicket
 * walks. Selected through GITLAB_REPO_URL and a fresh import, the way
 * mr-open.test.ts does it, because mr-open exists only for the erp target and
 * that phase is the first the diff check has to land on. The empty string,
 * never `delete`: config.js runs dotenv at load and would fill a missing key.
 */
async function phaseList(target: string): Promise<PhaseConfig[]> {
  const had = Object.prototype.hasOwnProperty.call(process.env, VAR);
  const before = process.env[VAR];
  process.env[VAR] = target ? `https://gitlab.example.com/acme/${target}` : '';
  try {
    const m = await import(`../lib/config.js?zones=${encodeURIComponent(target)}-${Date.now()}`);
    return (m.phases as () => PhaseConfig[])();
  } finally {
    if (had) process.env[VAR] = before;
    else delete process.env[VAR];
  }
}

const dueAt = (list: PhaseConfig[], name: string, succeeded: string[]): string | null => {
  const i = list.findIndex((p) => p.name === name);
  assert.ok(i !== -1, `phase ${name} is missing`);
  return zoneCheckDue(list, i, (phase) => succeeded.includes(phase));
};

test('the diff is checked at mr-open, before it pushes, and at every phase after implement', async () => {
  const list = await phaseList('erp');
  const done = ['recall', 'research', 'plan', 'implement'];
  for (const name of ['mr-open', 'testcases', 'review', 'verify', 'ui-evidence', 'mr', 'merge']) {
    assert.equal(dueAt(list, name, done), 'diff', `no zone check at ${name}`);
  }
});

test('without mr-open the diff is checked where testcases and review run together', async () => {
  // The hole: review batched into the testcases group never heads the loop, so
  // a check keyed on standing at review never ran on a clean first lap.
  const list = await phaseList('');
  assert.ok(!list.some((p) => p.name === 'mr-open'));
  const testcases = list.find((p) => p.name === 'testcases');
  assert.equal(testcases?.group, list.find((p) => p.name === 'review')?.group, 'the two still share a group');
  assert.equal(dueAt(list, 'testcases', ['plan', 'implement']), 'diff');
});

test('the plan is checked at implement, and nothing is checked before there is a plan to check', async () => {
  const list = await phaseList('erp');
  assert.equal(dueAt(list, 'implement', ['plan']), 'plan');
  assert.equal(dueAt(list, 'implement', []), null);
  assert.equal(dueAt(list, 'plan', ['research']), null);
  assert.equal(dueAt(list, 'mr-open', ['plan']), null, 'no diff check until implement has succeeded');
});

/** A plan that keeps to green, and the newest lap's report, which does too. */
const GREEN_PLAN = { steps: [{ files: ['apps/training/views.py'] }] };
const LAP_2_REPORT = { filesChanged: ['apps/training/views.py'] };

test('a red file committed on an earlier lap is caught though the newest report leaves it out', () => {
  const dir = workRepo();
  try {
    git(dir, 'checkout', '-qb', 'oneshot/ticket-1');
    commit(dir, { 'apps/payroll/utils.py': 'lap 1\n' }, 'lap 1');
    commit(dir, { 'apps/training/views.py': 'lap 2\n' }, 'lap 2');

    const declared = declaredFiles(GREEN_PLAN, LAP_2_REPORT);
    assert.equal(zoneVerdict(['AI', 'Loop'], declared, read, ZONES).violations.length, 0,
      'the self-report alone passes it — this is the miss');

    const changed = branchFiles('oneshot/ticket-1', { repo: dir, base: 'dev' });
    assert.deepEqual(changed, ['apps/payroll/utils.py', 'apps/training/views.py']);
    const v = zoneVerdict(['AI', 'Loop'], [...declared, ...changed!], read, ZONES);
    assert.deepEqual(v.violations.map((h) => `${h.file} ${h.zone}`), ['apps/payroll/utils.py red']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file moved out of a red area counts at the path it left', () => {
  const dir = workRepo();
  try {
    commit(dir, { 'apps/payroll/rates.py': 'rates\n' }, 'payroll');
    git(dir, 'update-ref', 'refs/remotes/origin/dev', 'HEAD');
    git(dir, 'checkout', '-qb', 'oneshot/ticket-2');
    mkdirSync(join(dir, 'apps/training'), { recursive: true });
    git(dir, 'mv', 'apps/payroll/rates.py', 'apps/training/rates.py');
    git(dir, 'commit', '-qm', 'move');
    assert.deepEqual(branchFiles('oneshot/ticket-2', { repo: dir, base: 'dev' }),
      ['apps/payroll/rates.py', 'apps/training/rates.py']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a branch git cannot diff stops the run rather than passing it', () => {
  const dir = workRepo();
  try {
    const changed = branchFiles('oneshot/no-such-branch', { repo: dir, base: 'dev' });
    assert.equal(changed, null);
    const v = zoneVerdict(['AI', 'Loop'], changed, read, ZONES);
    assert.match(v.unreadable ?? '', /diff cannot be read/);
    assert.match(zoneBlockReason(v, ZONES), /or remove AI to run under the review gates$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import { labelledLayers } from '../phases/prompts.js';

test('layer labels from grooming are read case-insensitively', () => {
  assert.deepEqual(labelledLayers({ labels: ['backend', 'AI'] } as never), { backend: true, frontend: false });
  assert.deepEqual(labelledLayers({ labels: ['Frontend', 'Backend'] } as never), { backend: true, frontend: true });
  assert.deepEqual(labelledLayers({ labels: ['Bug'] } as never), { backend: false, frontend: false });
});

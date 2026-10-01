import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  loadZoneMap, matches, refusedTicket, validateZoneMap, zoneBlockReason, zoneGuardApplies, zoneOf, zoneVerdict,
  type ZoneMap, type ZoneMapRead, type ZonesConfig,
} from './zoneguard.js';

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

import { labelledLayers } from '../phases/prompts.js';

test('layer labels from grooming are read case-insensitively', () => {
  assert.deepEqual(labelledLayers({ labels: ['backend', 'AI'] } as never), { backend: true, frontend: false });
  assert.deepEqual(labelledLayers({ labels: ['Frontend', 'Backend'] } as never), { backend: true, frontend: true });
  assert.deepEqual(labelledLayers({ labels: ['Bug'] } as never), { backend: false, frontend: false });
});

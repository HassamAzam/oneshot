import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matches, refusedTicket, zoneBlockReason, zoneGuardApplies, zoneOf, zoneVerdict, type ZoneMap, type ZonesConfig,
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
  const v = zoneVerdict(['Loop'], ['apps/payroll/models.py'], map, ZONES);
  assert.equal(v.applies, false);
  assert.deepEqual(v.violations, []);
});

test('a green AI ticket that stays green passes', () => {
  const v = zoneVerdict(['AI', 'Loop'], ['apps/training/views.py', 'frontend/src/components/training/A.js'], map, ZONES);
  assert.deepEqual(v.violations, []);
});

test('a green AI ticket reaching into shared code is stopped', () => {
  const v = zoneVerdict(['AI', 'Loop'], ['apps/training/views.py', 'frontend/src/common/utils/misc.js'], map, ZONES);
  assert.deepEqual(v.violations.map((h) => h.file), ['frontend/src/common/utils/misc.js']);
});

test('yellow is allowed only once released by the yellow label', () => {
  assert.equal(zoneVerdict(['AI', 'Loop'], ['apps/teams/views.py'], map, ZONES).violations.length, 1);
  assert.equal(zoneVerdict(['AI', 'Loop', 'Zone: Yellow'], ['apps/teams/views.py'], map, ZONES).violations.length, 0);
});

test('red is never allowed, whatever the labels', () => {
  const v = zoneVerdict(['AI', 'Loop', 'Zone: Yellow', 'Review'], ['apps/payroll/models.py'], map, ZONES);
  assert.equal(v.violations[0]?.zone, 'red');
});

test('an unreadable map stops an AI ticket', () => {
  const v = zoneVerdict(['AI', 'Loop'], ['apps/training/views.py'], null, ZONES);
  assert.equal(v.unreadable, true);
  assert.match(zoneBlockReason(v), /unreadable/);
});

test('files are reported once each, with zone and area', () => {
  const v = zoneVerdict(['AI'], ['apps/payroll/a.py', 'apps/payroll/a.py', 'README.md'], map, ZONES);
  assert.equal(v.violations.length, 2);
  const reason = zoneBlockReason(v);
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
  assert.equal(zoneVerdict(['AI', 'Loop'], ['apps/payroll/models.py'], null, null).applies, false);
  assert.equal(refusedTicket(['Characterization Tests', 'Loop'], null), null);
});

import { labelledLayers } from '../phases/prompts.js';

test('layer labels from grooming are read case-insensitively', () => {
  assert.deepEqual(labelledLayers({ labels: ['backend', 'AI'] } as never), { backend: true, frontend: false });
  assert.deepEqual(labelledLayers({ labels: ['Frontend', 'Backend'] } as never), { backend: true, frontend: true });
  assert.deepEqual(labelledLayers({ labels: ['Bug'] } as never), { backend: false, frontend: false });
});

/**
 * `npm run env:check` has to see a .env the way boot does, and has to name the
 * keys GITLAB_REPO_URL retired — a leftover ONESHOT_PROJECT that disagrees with
 * the URL refuses boot, so the check reporting "none retired" beside it would
 * be worse than no check.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driftCount, envDrift } from './envdrift.js';

const TEMPLATE = [
  '# comment',
  'GITLAB_REPO_URL=https://gitlab.example.com/acme/REPLACE_ME',
  'GITLAB_TOKEN=glpat-REPLACE_ME',
  'ONESHOT_SEED_FROM=~/Documents/erp',
  'ONESHOT_SEED_LINKS=node_modules,staticfiles',
  '# ONESHOT_FE_PORT=13002',
].join('\n');

const FILLED = [
  'GITLAB_REPO_URL=https://gitlab.example.com/acme/erp',
  'GITLAB_TOKEN=glpat-abc',
  'ONESHOT_SEED_FROM=~/Documents/erp',
  'ONESHOT_SEED_LINKS=node_modules,staticfiles',
].join('\n');

test('a .env that matches the template reports nothing', () => {
  const d = envDrift(FILLED, TEMPLATE);
  assert.deepEqual(d, { missing: [], stale: [], placeholders: [], unknown: [] });
  assert.equal(driftCount(d), 0);
});

test('a key the template gained is missing, with the template value to copy', () => {
  const d = envDrift(FILLED.replace(/^ONESHOT_SEED_LINKS=.*$/m, ''), TEMPLATE);
  assert.deepEqual(d.missing, [{ key: 'ONESHOT_SEED_LINKS', suggested: 'node_modules,staticfiles' }]);
  assert.equal(driftCount(d), 1);
});

test('every selector GITLAB_REPO_URL retired is stale, in either spelling, as is the old username', () => {
  const extra = ['ONESHOT_PROJECT=erp', 'ONESHOT_GITLAB_PROJECT=acme/erp', 'ONESHOT_GITLAB_API=https://x/api/v4',
    'ONESHOT_PROJECT_ID=42', 'ONELOOP_PROJECT=erp', 'ONESHOT_GITLAB_USERNAME=someone'];
  const d = envDrift(`${FILLED}\n${extra.join('\n')}`, TEMPLATE);
  assert.deepEqual(d.stale.sort(), ['ONELOOP_PROJECT', 'ONESHOT_GITLAB_API', 'ONESHOT_GITLAB_PROJECT',
    'ONESHOT_GITLAB_USERNAME', 'ONESHOT_PROJECT', 'ONESHOT_PROJECT_ID']);
  assert.deepEqual(d.unknown, []);
  assert.equal(driftCount(d), 6);
});

test('a legacy ONELOOP_ spelling satisfies the ONESHOT_ key and is not an extra', () => {
  const d = envDrift(FILLED.replace('ONESHOT_SEED_LINKS=', 'ONELOOP_SEED_LINKS='), TEMPLATE);
  assert.deepEqual(d.missing, []);
  assert.deepEqual(d.unknown, []);
});

test('an export prefix is not part of the key, so an exported .env is neither missing keys nor carrying extras', () => {
  const d = envDrift(FILLED.split('\n').map((line) => `export ${line}`).join('\n'), TEMPLATE);
  assert.deepEqual(d, { missing: [], stale: [], placeholders: [], unknown: [] });
});

test('an inline comment is not part of the value, so a stand-in path quoted in one is not unfilled', () => {
  const d = envDrift(FILLED.replace('ONESHOT_SEED_FROM=~/Documents/erp', 'ONESHOT_SEED_FROM=~/Documents/erp # was ~/their/path/erp'), TEMPLATE);
  assert.deepEqual(d, { missing: [], stale: [], placeholders: [], unknown: [] });
});

test('a placeholder or stand-in path still in a value is unfilled', () => {
  const d = envDrift(`${FILLED.replace('glpat-abc', 'glpat-REPLACE_ME')}\nONESHOT_ERP_WORK_REPO=~/their/path/erp`, TEMPLATE);
  assert.deepEqual(d.placeholders.map((p) => p.key).sort(), ['GITLAB_TOKEN', 'ONESHOT_ERP_WORK_REPO']);
});

test('only the scoped path names are exempt from being extras', () => {
  const d = envDrift(`${FILLED}\nONESHOT_ERP_WORK_REPO=~/x/erp\nONESHOT_ERP_WT_ROOT=~/x/erp-wt\nONESHOT_FOO_BAR=1`, TEMPLATE);
  assert.deepEqual(d.unknown, ['ONESHOT_FOO_BAR']);
  assert.equal(driftCount(d), 0);
});

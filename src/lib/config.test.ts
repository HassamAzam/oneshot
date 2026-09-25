import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, projectConfig } from './config.js';

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

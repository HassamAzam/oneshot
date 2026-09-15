import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEdgeCases } from './edgecases.js';
import { trailingInfraDeaths } from '../lib/artifacts.js';

test('the #179 reply: conversation lines are not cases, bullets are, and the bullet is stripped', () => {
  const reply = [
    'Disapproved',
    '',
    '- Verify that when a live refresh changes the list, the focused row keeps the same reminder.',
    '- Verify the defect REPRODUCES on dev before the fix.',
  ].join('\n');
  const cases = parseEdgeCases(reply);
  assert.equal(cases.length, 2);
  assert.equal(cases[0]!.scenario, 'Verify that when a live refresh changes the list, the focused row keeps the same reminder.');
  assert.equal(cases[1]!.scenario, 'Verify the defect REPRODUCES on dev before the fix.');
  assert.ok(cases.every((c) => !c.scenario.includes('Verify that -')));
});

test('a follow-up explanation comment adds no cases', () => {
  const reply = [
    '@usman.nasir',
    '',
    'I reviewed the 20-case list and added 4 edge cases via the gate.',
    '1. TC-21 is junk — please delete it.',
    '   TC-22: After the refresh, the focused row renders the same title.',
    'Two parser bugs worth fixing upstream, separately from this run:',
    "Once TC-21 is gone and the expectations are in, I'm happy to approve.",
  ].join('\n');
  assert.deepEqual(parseEdgeCases(reply), []);
});

test('an expects: part becomes the expected result', () => {
  const [c] = parseEdgeCases('- Verify the POD dropdown in dark mode — expects: the focus ring is visible');
  assert.equal(c!.scenario, 'Verify the POD dropdown in dark mode');
  assert.equal(c!.expected, 'the focus ring is visible');
});

test('unbulleted lines that start with a test verb are cases', () => {
  const cases = parseEdgeCases('Check that the header stays on top\nEnsure focus returns to the list');
  assert.deepEqual(cases.map((c) => c.scenario), [
    'Verify that the header stays on top',
    'Verify that focus returns to the list',
  ]);
  assert.equal(cases[0]!.expected, null);
});

test('infra deaths count only the unbroken streak at the end of a phase', () => {
  const p = (phase: string, status: string) => ({ phase, status });
  const hist = [p('verify', 'infra'), p('verify', 'infra'), p('verify', 'ok'), p('implement', 'ok'), p('verify', 'infra')];
  assert.equal(trailingInfraDeaths(hist, 'verify'), 1);
  assert.equal(trailingInfraDeaths([p('verify', 'infra'), p('implement', 'ok'), p('verify', 'infra')], 'verify'), 2);
  assert.equal(trailingInfraDeaths([p('verify', 'failed')], 'verify'), 0);
  assert.equal(trailingInfraDeaths([], 'verify'), 0);
});

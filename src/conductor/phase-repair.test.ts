import { test } from 'node:test';
import assert from 'node:assert/strict';
import { structuredRepairPrompt } from './phase.js';
import { schemaFor } from './schemas.js';

test('the repair prompt names every required field of the phase schema', () => {
  const prompt = structuredRepairPrompt(schemaFor('review')!);
  for (const field of ['summary', 'verdict', 'findings']) assert.match(prompt, new RegExp(`\\b${field}\\b`));
});

test('the repair prompt tells the session its work is done and not to shrink the output', () => {
  const prompt = structuredRepairPrompt({ type: 'object', required: ['summary'] });
  assert.match(prompt, /work is already done/);
  assert.match(prompt, /do not drop a field/);
});

test('a schema without required fields still yields a usable prompt', () => {
  assert.match(structuredRepairPrompt({ type: 'object' }), /Call StructuredOutput exactly once/);
});

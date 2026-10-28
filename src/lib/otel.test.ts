import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deskEnvironment } from './otel.js';

const LANGFUSE_ENVIRONMENT = /^(?!langfuse)[a-z0-9-_]+$/;

test('a desk name becomes a Langfuse environment: lowercased, with dots and spaces as hyphens', () => {
  assert.equal(deskEnvironment('Hassam.Azam'), 'hassam-azam');
  assert.equal(deskEnvironment('usman nasir'), 'usman-nasir');
  assert.equal(deskEnvironment('ci_desk-2'), 'ci_desk-2');
});

test('an environment never starts with "langfuse", which Langfuse reserves', () => {
  const env = deskEnvironment('langfuse-bot');
  assert.match(env, LANGFUSE_ENVIRONMENT);
  assert.ok(env.includes('langfuse-bot'));
});

test('an environment is at most 40 characters and never ends on a hyphen', () => {
  const env = deskEnvironment(`${'a'.repeat(39)}.long.desk.name`);
  assert.ok(env.length <= 40, `${env.length} characters`);
  assert.match(env, LANGFUSE_ENVIRONMENT);
  assert.ok(!env.endsWith('-'));
});

test('a desk name with nothing usable falls back to oneshot', () => {
  assert.equal(deskEnvironment(''), 'oneshot');
  assert.equal(deskEnvironment('...'), 'oneshot');
});

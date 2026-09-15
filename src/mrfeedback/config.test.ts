import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMrFeedbackConfig } from './config.js';

const reviewers = { dev: ['hira.ijaz', 'usman.nasir'], qa: ['arsal.tariq'] };

test('an empty config is off, resolves fixed threads, allows 3 rounds, trusts dev and qa', () => {
  assert.deepEqual(parseMrFeedbackConfig({}, reviewers), {
    enabled: false,
    resolve: 'fixed',
    maxRounds: 3,
    authors: ['hira.ijaz', 'usman.nasir', 'arsal.tariq'],
  });
});

test('every resolve policy is accepted', () => {
  for (const resolve of ['never', 'fixed', 'all'] as const) {
    assert.equal(parseMrFeedbackConfig({ resolve }, reviewers).resolve, resolve);
  }
});

test('an unknown resolve policy is a loud config error', () => {
  assert.throws(() => parseMrFeedbackConfig({ resolve: 'sometimes' }, reviewers), /resolve must be one of/);
});

test('authorRoles narrows the roster and extraAuthors adds to it without duplicates', () => {
  const c = parseMrFeedbackConfig(
    { enabled: true, authorRoles: ['qa'], extraAuthors: ['arsal.tariq', 'lead.dev'] }, reviewers,
  );
  assert.equal(c.enabled, true);
  assert.deepEqual(c.authors, ['arsal.tariq', 'lead.dev']);
});

test('an unknown author role is a loud config error', () => {
  assert.throws(() => parseMrFeedbackConfig({ authorRoles: ['pm'] }, reviewers), /unknown author role/);
});

test('maxRounds must be a positive integer', () => {
  for (const maxRounds of [0, -1, 1.5, '3']) {
    assert.throws(() => parseMrFeedbackConfig({ maxRounds }, reviewers), /maxRounds/);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import './test-project-env.js';
import { redact } from './report.js';

test('redact leaves the words "Basic Information" alone', () => {
  const step = 'Open Profile › **Basic Information** and click **Edit**';
  assert.equal(redact(step), step);
  assert.equal(redact('Basic Informationen, Basic Authentication'), 'Basic Informationen, Basic Authentication');
});

test('redact still hides a real HTTP Basic credential', () => {
  // base64 of "user:pass" and "user:password"
  assert.equal(redact('curl -H "X: Basic dXNlcjpwYXNz"'), 'curl -H "X: Basic [redacted: basic credentials]"');
  assert.equal(redact('Basic dXNlcjpwYXNzd29yZA== sent'), 'Basic [redacted: basic credentials] sent');
});

test('redact hides a Basic credential whose password is not ASCII', () => {
  for (const pair of ['user:pässwörd', 'svc:p@ss€']) {
    assert.equal(redact(`Basic ${Buffer.from(pair).toString('base64')}`), 'Basic [redacted: basic credentials]', pair);
  }
});

test('redact still hides an Authorization header whatever its scheme', () => {
  assert.equal(redact('Authorization: Basic dXNlcjpwYXNz'), 'Authorization: [redacted: credential header]');
});

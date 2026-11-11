import { test } from 'node:test';
import assert from 'node:assert/strict';
import './test-project-env.js';
import { redact, renderHtml, type ReportModel } from './report.js';

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

const model = (over: Partial<ReportModel> = {}): ReportModel => ({
  iid: 9174, title: 'A ticket', url: '', runId: 'r-1', status: 'blocked', createdAt: 0, mrIid: null, mrUrl: '', mergedSha: '',
  blockedWhy: 'merge refused', diagnosis: null, remediations: [], phases: [], agentCount: 0, generatedAt: 0, ...over,
});

test('a diagnosed stop heads the report: where it went wrong, what to do, and the causes, escaped', () => {
  const html = renderHtml(model({ diagnosis: { headline: 'No <b>test</b> could run', nextStep: 'Seed the settings', causes: ['D-1 [harness] no test settings'] } }));
  assert.match(html, /<div class="diagnosis"><b>Diagnosis<\/b> No &lt;b&gt;test&lt;\/b&gt; could run/);
  assert.match(html, /<div><b>What to do next<\/b> Seed the settings<\/div>/);
  assert.match(html, /<ul><li>D-1 \[harness\] no test settings<\/li><\/ul>/);
});

test('a run nobody diagnosed has no diagnosis block in its report', () => {
  assert.doesNotMatch(renderHtml(model()), /class="diagnosis"/);
});

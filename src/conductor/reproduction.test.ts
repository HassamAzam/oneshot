import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notABugComment, notABugDecision, notABugSlackText, reproductionOf } from './reproduction.js';

const complete = {
  kind: 'bug',
  verdict: 'not-reproduced',
  testedCommit: '7a21bb0c1d2e',
  account: 'qa.tester@arbisoft.com (Team Lead)',
  steps: ['Open /home/', 'Tab into the Reminders card', 'Tab through 12 rows'],
  expected: 'No row focus ring is hidden behind the header',
  observed: 'Every focused row cleared the header; overlap 0px on all 12 rows',
  evidence: ['repro-1.png', 'overlap 0px on 12/12 rows'],
  reason: 'Ran the reported steps on dev; the focus ring was fully visible at every stop.',
};

test('a complete not-reproduced verdict on a bug stops the run', () => {
  const d = notABugDecision({ reproduction: complete });
  assert.equal(d.stop, true);
});

test('reproduced, inconclusive and not-applicable never stop the run', () => {
  for (const verdict of ['reproduced', 'inconclusive', 'not-applicable']) {
    assert.deepEqual(notABugDecision({ reproduction: { ...complete, verdict } }), { stop: false });
  }
});

test('research with no reproduction block does not stop the run', () => {
  assert.deepEqual(notABugDecision({ understanding: 'x' }), { stop: false });
  assert.deepEqual(notABugDecision(null), { stop: false });
});

test('not-reproduced without executed steps, an observation or a commit is downgraded, not a stop', () => {
  for (const gap of [{ steps: [] }, { observed: '' }, { testedCommit: '' }, { kind: 'feature' }]) {
    const d = notABugDecision({ reproduction: { ...complete, ...gap } });
    assert.equal(d.stop, false);
    assert.match((d as { note?: string }).note ?? '', /treated as inconclusive/);
  }
});

test('an unknown verdict string is read as inconclusive', () => {
  assert.equal(reproductionOf({ reproduction: { ...complete, verdict: 'maybe' } })!.verdict, 'inconclusive');
});

test('the ticket comment carries the evidence and how to overrule', () => {
  const repro = reproductionOf({ reproduction: complete })!;
  const body = notABugComment(repro, {
    runId: 'r-abc', label: 'Not a Bug', entryLabel: 'Loop',
    screenshots: [{ url: '/uploads/x/repro-1.png', markdown: '![repro-1](/uploads/x/repro-1.png)' }],
  });
  assert.match(body, /could not reproduce this bug/);
  assert.match(body, /labelled the ticket \*\*Not a Bug\*\*/);
  assert.match(body, /`7a21bb0c1d2e`/);
  assert.match(body, /1\. Open \/home\//);
  assert.match(body, /overlap 0px on 12\/12 rows/);
  assert.match(body, /!\[repro-1\]/);
  assert.match(body, /remove \*\*Not a Bug\*\* and add \*\*Loop\*\* back/);
  assert.match(body, /r-abc/);
  assert.doesNotMatch(body, /- repro-1\.png/);
});

test('the Slack post names the ticket, the commit and the label', () => {
  const repro = reproductionOf({ reproduction: complete })!;
  const text = notABugSlackText(123, 'Keyboard focus obscured', repro, 'Not a Bug');
  assert.match(text, /#123 Keyboard focus obscured/);
  assert.match(text, /`7a21bb0c`/);
  assert.match(text, /labelled \*Not a Bug\*/);
  assert.match(text, /issues\/123/);
});

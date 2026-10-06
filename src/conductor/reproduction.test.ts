import '../lib/test-project-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  declareReproduced, incompleteness, notABugApprovalRequestBody, notABugDecision, notABugSlackText,
  reproductionComment, reproductionOf, shotName, shotsIn,
} from './reproduction.js';
import { gateApprovedText, gateAskText } from './reviewgate.js';
import type { RunJournal } from '../lib/artifacts.js';

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

test('not-reproduced without executed steps, an observation, a commit or a screenshot is downgraded, not a stop', () => {
  for (const gap of [{ steps: [] }, { observed: '' }, { testedCommit: '' }, { kind: 'feature' }, { evidence: [] },
    { evidence: ['overlap 0px on 12/12 rows'] }]) {
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
  const body = reproductionComment(repro, {
    runId: 'r-abc', label: 'Not a Bug', entryLabel: 'Loop',
    screenshots: [{ url: '/uploads/x/repro-1.png', markdown: '![repro-1](/uploads/x/repro-1.png)' }],
  });
  assert.match(body, /could not reproduce this bug, and QA confirmed it/);
  assert.match(body, /labelled the ticket \*\*Not a Bug\*\*/);
  assert.match(body, /`7a21bb0c1d2e`/);
  assert.match(body, /1\. Open \/home\//);
  assert.match(body, /overlap 0px on 12\/12 rows/);
  assert.match(body, /!\[repro-1\]/);
  assert.match(body, /remove \*\*Not a Bug\*\* and add \*\*Loop\*\* back/);
  assert.match(body, /r-abc/);
  assert.doesNotMatch(body, /- repro-1\.png/);
  assert.doesNotMatch(body, /\{\{/);
});

const reproduced = {
  ...complete,
  verdict: 'reproduced',
  observed: '1 of 18 rows rendered with filter: blur(2px)',
  evidence: ['repro-1.png', 'repro-2.png', 'filter blur(2px) on 1/18 rows'],
  reason: 'The processed row is blurred on the unfixed base commit, as the ticket reports.',
};

test('a reproduced verdict gets its own comment with the screenshots and no overrule footer', () => {
  const repro = reproductionOf({ reproduction: reproduced })!;
  const body = reproductionComment(repro, {
    screenshots: [
      { url: '/uploads/x/repro-1.png', markdown: '![repro-1](/uploads/x/repro-1.png)' },
      { url: '/uploads/y/repro-2.png', markdown: '![repro-2](/uploads/y/repro-2.png)' },
    ],
  });
  assert.match(body, /reproduced this bug/);
  assert.doesNotMatch(body, /could not reproduce/);
  assert.match(body, /`7a21bb0c1d2e`/);
  assert.match(body, /1\. Open \/home\//);
  assert.match(body, /blur\(2px\) on 1\/18 rows/);
  assert.match(body, /!\[repro-1\][\s\S]*!\[repro-2\]/);
  assert.doesNotMatch(body, /add \*\*/);
  assert.doesNotMatch(body, /\{\{/);
  assert.doesNotMatch(body, /\n{3,}/);
});

test('a comment whose screenshot did not upload says so rather than going quiet', () => {
  for (const verdict of ['reproduced', 'not-reproduced']) {
    const repro = reproductionOf({ reproduction: { ...complete, verdict, evidence: ['repro-1.png'] } })!;
    const body = reproductionComment(repro, { screenshots: [], label: 'Not a Bug', entryLabel: 'Loop', runId: 'r' });
    assert.match(body, /No screenshot was attached/);
    assert.doesNotMatch(body, /Measurements/);
  }
});

test('inconclusive and not-applicable have no comment: rendering one throws', () => {
  for (const verdict of ['inconclusive', 'not-applicable']) {
    const repro = reproductionOf({ reproduction: { ...complete, verdict } })!;
    assert.throws(() => reproductionComment(repro, { screenshots: [] }), new RegExp(`${verdict} does not post`));
  }
});

test('a reproduced verdict is incomplete without a screenshot, or on a feature ticket', () => {
  assert.deepEqual(incompleteness(reproductionOf({ reproduction: reproduced })!), []);
  assert.deepEqual(
    incompleteness(reproductionOf({ reproduction: { ...reproduced, evidence: ['filter blur(2px) on 1/18 rows'] } })!),
    ['no screenshot was recorded'],
  );
  assert.deepEqual(
    incompleteness(reproductionOf({ reproduction: { ...reproduced, kind: 'feature' } })!),
    ['the ticket was classed a feature, not a bug'],
  );
});

test('an incomplete reproduced verdict posts nothing on the ticket', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error('no network in tests'); }) as typeof fetch;
  try {
    for (const gap of [{ evidence: [] }, { kind: 'feature' }, { steps: [], observed: '', testedCommit: '' }]) {
      await declareReproduced(123, reproductionOf({ reproduction: { ...reproduced, ...gap } })!);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls, 0);
});

test('the Slack post names the ticket, the commit and the label', () => {
  const repro = reproductionOf({ reproduction: complete })!;
  const text = notABugSlackText(123, 'Keyboard focus obscured', repro, 'Not a Bug');
  assert.match(text, /#123 Keyboard focus obscured/);
  assert.match(text, /`7a21bb0c`/);
  assert.match(text, /labelled \*Not a Bug\*/);
  assert.match(text, /issues\/123/);
});

test('the Not a Bug gate asks QA before anything is labelled, and says feedback reproduces again', () => {
  const repro = reproductionOf({ reproduction: complete })!;
  const body = notABugApprovalRequestBody(repro, 'Not a Bug');
  assert.match(body, /Oneshot pauses here/);
  assert.match(body, /Nothing has been labelled yet/);
  assert.match(body, /`7a21bb0c1d2e`/);
  assert.match(body, /1\. Open \/home\//);
  assert.match(body, /Only QA may sign this off/);
  assert.match(body, /\*\*`approved`\*\* to confirm — the ticket is labelled \*\*Not a Bug\*\*/);
  assert.match(body, /treated as FEEDBACK and research reproduces the bug again/);
  assert.doesNotMatch(body, /labelled the ticket/);
});

test('the Not a Bug gate still asks when the project has no label configured', () => {
  const body = notABugApprovalRequestBody(reproductionOf({ reproduction: complete })!);
  assert.match(body, /closed as not a bug/);
  assert.match(body, /to confirm and the run stops/);
});

test('the Not a Bug gate\'s Slack ask and resolution read as a stop, not a continue', () => {
  const j = { iid: 123, title: 'Keyboard focus obscured' } as RunJournal;
  const ask = gateAskText(j, 'notABug', 99, '<@U1>');
  assert.match(ask, /QA approval needed/);
  assert.match(ask, /Not a Bug/);
  assert.match(ask, /reproduced again/);
  assert.equal(gateApprovedText(j, 'notABug', '<@U1>').includes('the run stops'), true);
});

test('blocker is derived from the verdict, never trusted beside it', () => {
  const at = (verdict: string, blocker?: unknown) =>
    reproductionOf({ reproduction: { kind: 'bug', verdict, blocker } })!.blocker;

  // Only inconclusive carries one.
  assert.equal(at('inconclusive', 'env'), 'env');
  assert.equal(at('inconclusive', 'data'), 'data');

  // The three combinations the skill forbids, which used to survive.
  assert.equal(at('reproduced', 'env'), 'none');
  assert.equal(at('not-reproduced', 'access'), 'none');
  assert.equal(at('not-applicable', 'steps'), 'none');

  // Unknown verdict coerces to inconclusive; an unknown or missing blocker is none.
  assert.equal(at('nonsense', 'env'), 'env');
  assert.equal(at('inconclusive', 'wat'), 'none');
  assert.equal(at('inconclusive'), 'none');
});

test('screenshots are counted by the filename that opens the line, not by mentioning .png', () => {
  // Verbatim from a real reproduced lap: the filename LEADS and prose follows.
  // `endsWith('.png')` counted 0 of these four, which is the bug this pins.
  const reproduced = [
    'repro-1-podpeople.png \u2014 /pod/people/ unfiltered, 566 people, Total Experience column visible',
    'repro-2-filterpanel.png \u2014 Filter popover open showing the Experience select',
    'repro-3-exp-2-4-years.png \u2014 THE DEFECT. Experience=\'2-4 Years\' applied; rows 1 and 2 are outside',
    'repro-4-exp-1-2-years.png \u2014 Experience=\'1-2 Years\' applied; 15 rows, all inside [0,2) years',
    'Measurement (SQL, dev hrdb): 609 active people compared; 60 values differ',
  ];
  assert.equal(shotsIn(reproduced), 4);

  // Verbatim from the same ticket's BLOCKED lap. It names the extension precisely
  // to say there are none, so `includes('.png')` would report a screenshot for a
  // run that captured nothing — a false positive, the expensive direction.
  const blocked = [
    'No repro-*.png \u2014 the app never came up, so no screenshot of the POD > People screen could be captured.',
    'app.cjs ensure stderr: E_SEED_MISSING, /Users/x/Documents/erp/venv does not exist',
  ];
  assert.equal(shotsIn(blocked), 0);

  // A bare filename is still a filename; other image types count; empty is zero.
  assert.equal(shotsIn(['repro-1.png']), 1);
  assert.equal(shotsIn(['  repro-1.png  ']), 1);
  assert.equal(shotsIn(['shot.jpeg x', 'shot.webp y', 'shot.JPG z']), 3);
  assert.equal(shotsIn([]), 0);
  assert.equal(shotsIn(['']), 0);

  // Punctuation the same model plausibly emits straight after the filename.
  assert.equal(shotName('repro-1.png, 566 people'), 'repro-1.png');
  assert.equal(shotName('artifacts/repro-1.png: shows the row'), 'artifacts/repro-1.png');
  assert.equal(shotName('repro-1.png; and then'), 'repro-1.png');
  // But prose that merely names the extension still cites nothing.
  assert.equal(shotName('No repro-*.png was captured'), null);
  assert.equal(shotName('Measurement: 609 people compared'), null);
});

test('a reproduction whose evidence leads with filenames is not judged screenshot-less', () => {
  // The regression this pins cost a real run: `incompleteness` used an
  // end-anchored /\.png$/i, so a confirmed reproduction carrying four
  // screenshots reported 'no screenshot was recorded' and `declareReproduced`
  // posted NOTHING on the ticket. Every reader of `evidence` shared the bug;
  // fixing only the telemetry counter left the suppression in place.
  const repro = reproductionOf({
    reproduction: {
      ...complete,
      verdict: 'reproduced',
      evidence: [
        'repro-1-podpeople.png \u2014 /pod/people/ unfiltered, 566 people, column visible',
        'repro-3-exp-2-4.png \u2014 THE DEFECT. Two rows outside the selected range',
        'Measurement (SQL): 609 active people compared; 60 values differ',
      ],
    },
  })!;
  assert.deepEqual(incompleteness(repro), []);
  assert.equal(shotsIn(repro.evidence), 2);

  // And the blocked shape still reports honestly rather than inventing evidence.
  const blocked = reproductionOf({
    reproduction: {
      ...complete,
      verdict: 'reproduced',
      evidence: ['No repro-*.png \u2014 the app never came up, so nothing was captured'],
    },
  })!;
  assert.deepEqual(incompleteness(blocked), ['no screenshot was recorded']);
});

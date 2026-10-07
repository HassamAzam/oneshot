import '../lib/test-project-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  declareReproduced, incompleteness, notABugApprovalRequestBody, notABugDecision, notABugSlackText,
  mimeOf, reproductionComment, reproductionOf, shotCaption, shotName, shotsIn,
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

test('a screenshot is recognised wherever the filename sits in the line', () => {
  // Two anchored attempts failed here before. `/\.png$/i` missed every line that
  // continued into prose; the leading-token fix then missed six ordinary shapes AND
  // was narrower than what it replaced, so a run parked at the gate could resume and
  // walk past it. Each of these is a regression guard, not a hypothetical.
  const cases: [string, string | null][] = [
    // filename first, prose after — the shape the model actually writes
    ['repro-1-podpeople.png \u2014 /pod/people/ unfiltered, 566 people', 'repro-1-podpeople.png'],
    ['repro-1.png, 566 people', 'repro-1.png'],
    ['repro-1.png; and then', 'repro-1.png'],
    ['repro-1.png. Shows the row', 'repro-1.png'],
    ['repro-1.png\u2014caption', 'repro-1.png'],
    ['  repro-1.png  ', 'repro-1.png'],
    // wrapped in the punctuation markdown invites
    ['`repro-1.png` \u2014 caption', 'repro-1.png'],
    ['**repro-1.png**', 'repro-1.png'],
    ['"repro-1.png"', 'repro-1.png'],
    ['(repro-1.png)', 'repro-1.png'],
    // filename LAST — both of these matched before the leading-token fix broke them
    ['Screenshot: repro-1.png', 'repro-1.png'],
    ['see repro-1.png', 'repro-1.png'],
    // a path resolves to its basename, which every caller already applies
    ['artifacts/repro-1.png: shows the row', 'repro-1.png'],
    // other image types
    ['shot.jpeg x', 'shot.jpeg'], ['shot.webp y', 'shot.webp'], ['shot.JPG z', 'shot.JPG'],
    // a caption may describe a defect in negative terms and is still a screenshot
    ['repro-3.png \u2014 the aria-label is missing', 'repro-3.png'],
    ['repro-3.png \u2014 no second email was sent', 'repro-3.png'],
    ['repro-3.png \u2014 the row is not blurred', 'repro-3.png'],
    ['Screenshot no. 3: repro-3.png', 'repro-3.png'],
    // but a line that SAYS the shot is absent is not evidence that it exists.
    // Three of these were a regression: the end-anchored test read them as none.
    ['No repro-1.png was captured \u2014 the app never came up', null],
    ['Could not capture repro-1.png; bring-up failed', null],
    ['No screenshot: repro-1.png was never written', null],
    ['Failed to write repro-1.png', null],
    ['Unable to save repro-2.png', null],
    ['No repro-*.png \u2014 the app never came up, so nothing was captured', null],
    ['Measurement (SQL): 609 active people compared; 60 values differ', null],
    ['Measurement: band 1 returns 15 people', null],
    ['', null],
  ];
  for (const [line, want] of cases) {
    assert.equal(shotName(line), want, `shotName(${JSON.stringify(line)})`);
  }
  assert.equal(shotsIn(cases.map(([l]) => l)), 20);
});

test('the note on a screenshot line is kept, not swallowed by the filename', () => {
  assert.equal(
    shotCaption('repro-1-podpeople.png \u2014 /pod/people/ unfiltered, 566 people', 'repro-1-podpeople.png'),
    '/pod/people/ unfiltered, 566 people',
  );
  assert.equal(shotCaption('`repro-1.png` \u2014 caption', 'repro-1.png'), 'caption');
  // A bare introducing label is not a caption — rendering it under the image is noise.
  assert.equal(shotCaption('Screenshot: repro-1.png', 'repro-1.png'), '');
  assert.equal(shotCaption('see repro-1.png', 'repro-1.png'), '');
  assert.equal(shotCaption('Screenshot: repro-1.png shows the row', 'repro-1.png'), 'Screenshot: shows the row');
  assert.equal(shotCaption('repro-1.png', 'repro-1.png'), '');
  assert.equal(shotCaption('**repro-1.png**', 'repro-1.png'), '');
});

test('a reproduction whose evidence names screenshots is not judged screenshot-less', () => {
  // The regression this pins cost a real run: every reader of `evidence` used an
  // end-anchored test, so a confirmed reproduction carrying four screenshots
  // reported 'no screenshot was recorded' and posted NOTHING on the ticket.
  const repro = reproductionOf({
    reproduction: {
      ...complete,
      verdict: 'reproduced',
      evidence: [
        'repro-1-podpeople.png \u2014 /pod/people/ unfiltered, 566 people, column visible',
        'Screenshot: repro-3-exp.png',
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

test('a screenshot note rides with its image, and survives when the image does not', () => {
  const repro = reproductionOf({
    reproduction: {
      ...complete,
      verdict: 'reproduced',
      evidence: [
        'repro-1.png \u2014 566 people, column visible',
        'repro-9.png \u2014 the fourth shot, past the attachment cap',
      ],
    },
  })!;

  // Attached: the note becomes the image's caption rather than vanishing.
  const withShot = reproductionComment(repro, {
    screenshots: [{
      url: '/uploads/x/repro-1.png',
      markdown: '![repro-1](/uploads/x/repro-1.png)',
      name: 'repro-1.png',
      caption: '566 people, column visible',
    }],
  });
  assert.match(withShot, /!\[repro-1\][\s\S]*566 people, column visible/);
  // Not attached: its note falls back to a measurement instead of being dropped twice.
  assert.match(withShot, /repro-9\.png \(not attached\): the fourth shot/);

  // A bare filename has no note, so it adds no Measurements section either way.
  const bare = reproductionOf({
    reproduction: { ...complete, verdict: 'reproduced', evidence: ['repro-1.png'] },
  })!;
  const bareBody = reproductionComment(bare, { screenshots: [] });
  assert.match(bareBody, /No screenshot was attached/);
  assert.doesNotMatch(bareBody, /Measurements/);
});

test('the upload media type follows the extension, since more than png is detected', () => {
  assert.equal(mimeOf('repro-1.png'), 'image/png');
  assert.equal(mimeOf('repro-1.PNG'), 'image/png');
  assert.equal(mimeOf('repro-1.webp'), 'image/webp');
  assert.equal(mimeOf('repro-1.jpg'), 'image/jpeg');
  assert.equal(mimeOf('repro-1.jpeg'), 'image/jpeg');
  assert.equal(mimeOf('repro-1.JPG'), 'image/jpeg');
});
